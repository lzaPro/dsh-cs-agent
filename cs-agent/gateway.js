/**
 * Channel gateway: the seam between an external chat platform and DSH sessions.
 *
 * Inbound HTTP carries `{ channel, groupId?, senderId, text, attachments? }`.
 * Each distinct conversation key maps to exactly one durable DSH session, so a
 * customer keeps their context across messages while two customers never share
 * one. Replies leave through a configurable webhook (or a local outbox file for
 * testing).
 *
 * The gateway knows nothing about QQ, WeChat, or Appia: a platform adapter only
 * has to POST inbound messages and receive the reply webhook.
 *
 * @module @local/dsh-cs-agent/gateway
 */

import { promises as fs } from 'node:fs'
import { existsSync, readFileSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { zstdDecompressSync } from 'node:zlib'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import { defaultPaths } from './paths.js'
import { createStore, storeKind } from './store.js'
import { DEFAULT_RETRY, createOutbox } from './outbox.js'
import { createInbox, inboxKey } from './inbox.js'
import { auditFileFor, createAudit } from './audit.js'
import { describePlan, planPurgeByOwner, planRetention, resolveRetentionAuto, retentionLimits } from './retention.js'
import { panelHtml } from './panel.js'
import { createAuth } from './auth.js'
import { createAlerter, parseAlertConfig } from './alerts.js'
import { costMicros, formatCost, parsePricing, priceFor, pricingReady } from './pricing.js'
import { newTraceId, tracePrefix, withTrace } from './trace.js'
import { acquireLease, createFileLease, leaseKind } from './lease.js'
import { dbHealth } from './db/pool.mjs'
import path from 'node:path'

const runCommand = promisify(execFile)

/** Cordis function-plugin name. */
export const name = 'channel-gateway'

/** Host services the gateway needs before it can serve a message. */
export const inject = [
  'webServer',
  'agents',
  'agentPresets',
  'agentDefaultModel',
  'sessionTitle',
  'workspaceRegistry',
]

/** Largest accepted request body, in bytes. */
const MAX_BODY_BYTES = 1024 * 1024

/** How many assistant messages to keep per session before flushing a turn. */
const MAX_BUFFERED = 20

/** Attachment download ceiling when the deployment sets none. */
const DEFAULT_MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024

/** Per-key message ceiling per minute when the deployment sets none. */
const DEFAULT_MAX_PER_MINUTE = 20

/** Remembered platform message ids, enough to cover a platform retry window. */
const DEFAULT_DEDUPE_LIMIT = 2000

/** Sent when a turn closes without any customer-facing text. */
const FALLBACK_REPLY = '抱歉，我这边刚才没处理成功，能再说一次吗？'

/**
 * 独占数据目录：同名 `.lock` 文件里记录 pid，活着就拒绝启动，死了就接管。
 * @param dataFile - 会话映射文件路径。
 * @returns 释放锁的函数。
 */
export function acquireDataLock(dataFile) {
  return createFileLease(dataFile).release
}

/** 解析会话映射文件：apply() 抢锁与 createGateway() 必须用同一个值。 */
function resolveDataFile(config) {
  return requireAbsolute(config?.dataFile ?? path.join(defaultPaths().data, 'sessions.json'), 'dataFile')
}

/**
 * Register the gateway on the host's HTTP server.
 *
 * 写入域租约按存储类型选：JSON 用 `<dataFile>.lock`（同步、单机、与重构前一致），
 * 数据库用 `gateway_leases` 租约（异步、多机有效、崩溃后自动接管）。JSON 分支
 * 保持同步返回，所以既有测试里"直接调用 apply 然后立刻断言"的写法不受影响。
 *
 * @param ctx - host context carrying the web server and agent services.
 * @param config - deployment configuration for routing and reply delivery.
 */
export function apply(ctx, config) {
  const kind = storeKind({ store: config?.store })
  if (leaseKind(kind) === 'postgres') return applyWithLease(ctx, config)
  // 两个 dsh 进程共用同一个数据目录会互相覆盖会话映射，启动即拦下。
  const lease = createFileLease(resolveDataFile(config))
  return install(ctx, config, lease)
}

/** 数据库模式：租约是异步的，所以整个 apply 返回 Promise（Cordis 会 await）。 */
async function applyWithLease(ctx, config) {
  const lease = await acquireLease({
    storeKind: 'postgres',
    dataFile: resolveDataFile(config),
    scope: config?.leaseScope,
    ttlMs: config?.leaseTtlMs,
    heartbeatMs: config?.leaseHeartbeatMs,
    logger: ctx.logger,
  })
  return install(ctx, config, lease)
}

/** 握有租约之后装配网关：注册路由、事件观察者和投递重试。 */
function install(ctx, config, lease) {
  let gateway
  try {
    gateway = createGateway(ctx, config, { lease })
  } catch (error) {
    void lease.release()
    throw error
  }
  const disposer = ctx.webServer.register({
    kind: 'prefix',
    path: gateway.route,
    handler: (req, res) => gateway.handleHttp(req, res),
  })
  ctx.effect(() => disposer, 'channel-gateway: route')
  ctx.effect(() => () => lease.release(), 'channel-gateway: write lease')
  ctx.effect(() => {
    const off = ctx.on('session/event', (session, event) => gateway.observe(session, event))
    return typeof off === 'function' ? off : undefined
  }, 'channel-gateway: observe')
  // 回复重试的后台扫描：适配器抖动时按退避重发，进程退出时停表。
  ctx.effect(() => {
    gateway.startOutboxWorker()
    return () => gateway.stopOutboxWorker()
  }, 'channel-gateway: outbox worker')
  // 保留期自动跑：卸载时一定要停掉，否则插件重载会叠出第二个定时器。
  ctx.effect(() => {
    gateway.startRetentionWorker()
    return () => gateway.stopRetentionWorker()
  }, 'channel-gateway: retention worker')
  // 告警自检：没人配 webhook 也照样跑（状态留在 /alerts），配了就会推出去。
  ctx.effect(() => {
    gateway.startAlertWorker()
    return () => gateway.stopAlertWorker()
  }, 'channel-gateway: alert worker')
  return gateway
}

/**
 * Build the gateway core. Exported so tests can drive it without a Host.
 * @param ctx - context exposing agents, presets, the web server, and events.
 * @param config - validated deployment configuration.
 */
export function createGateway(ctx, config, options = {}) {
  const lease = options.lease
  const startedAt = Date.now()
  const route = requirePath(config?.route)
  // 私聊和群聊各用一个独立目录，避免会话混进用户的工作区。
  const paths = defaultPaths()
  const privateWorkspace = requireAbsolute(config?.privateWorkspace ?? config?.workspace ?? paths.customer, 'privateWorkspace')
  const groupWorkspace = requireAbsolute(config?.groupWorkspace ?? config?.workspace ?? paths.customer, 'groupWorkspace')
  // 评测流量单独放一个目录，避免测试会话混进真实客服记录。
  const evalWorkspace = config?.evalWorkspace === undefined
    ? paths.eval
    : requireAbsolute(config.evalWorkspace, 'evalWorkspace')
  const agentPreset = requireText(config?.agentPreset, 'agentPreset')
  const dataFile = resolveDataFile(config)
  const seenFile = `${dataFile.replace(/\.json$/, '')}-seen.json`
  const outboxFile = config?.outbox === undefined
    ? path.join(paths.data, 'outbox.jsonl')
    : requireAbsolute(config.outbox, 'outbox')
  /**
   * 写入门禁。
   *
   * 租约被别的实例接管后（本机卡住、被运维重启、或者只是网络抖动让对方抢到了），
   * 继续写就是两个实例同时改一份状态 —— 这种损坏比"停一会儿"严重得多。
   * 所以一旦丢锁就拒绝所有写入，并且用明确的错误而不是静默丢。
   */
  function assertWritable() {
    if (lease?.lost === true) {
      const error = new Error(
        `channel-gateway: write refused, the write lease was taken over (${lease.kind ?? 'unknown'}); this instance must stop and restart`,
      )
      error.code = 'LEASE_LOST'
      throw error
    }
  }

  /**
   * 带追踪前缀的告警输出。
   * traceId 挂在 AsyncLocalStorage 上，所以处理链里的日志自动能按 traceId 串起来，
   * 不需要把 id 一路当参数传。
   */
  const warn = text => ctx.logger?.warn?.(`${tracePrefix()}${text}`)

  const replyWebhook = config?.replyWebhook === undefined ? undefined : requireUrl(config.replyWebhook)
  const forward = config?.forward === 'all' ? 'all' : 'final'
  // 访问控制：public（/health）/ inbound（POST {route}）/ viewer（读）/ admin（写）。
  // 没配令牌时保持重构前的全开行为，但会警告一次——见 cs-agent/auth.js 的注释。
  const auth = createAuth({
    token: config?.token,
    tokenFile: config?.tokenFile,
    inboundToken: config?.inboundToken,
    inboundTokenFile: config?.inboundTokenFile,
    viewerToken: config?.viewerToken,
    viewerTokenFile: config?.viewerTokenFile,
    healthPublic: config?.healthPublic,
    cookieName: config?.cookieName,
    viewerCookieName: config?.viewerCookieName,
    cookieSeconds: config?.cookieSeconds,
    logger: ctx.logger,
  })
  const maxPerMinute = positiveInteger(config?.maxPerMinute, DEFAULT_MAX_PER_MINUTE)
  const maxAttachments = positiveInteger(config?.maxAttachments, 4)
  const maxAttachmentBytes = positiveInteger(config?.maxAttachmentBytes, DEFAULT_MAX_ATTACHMENT_BYTES)
  // path: 图片落盘并给模型一个路径（纯文本模型）；native: 直接把图片块交给模型。
  const imageMode = config?.imageMode === 'path' ? 'path' : 'native'
  const imageDir = config?.imageDir === undefined
    ? path.join(paths.data, 'images')
    : requireAbsolute(config.imageDir, 'imageDir')
  if (imageMode === 'path' && imageDir === undefined) {
    throw new Error('channel-gateway: imageMode=path requires config.imageDir')
  }
  const dedupeLimit = positiveInteger(config?.dedupeLimit, DEFAULT_DEDUPE_LIMIT)
  const adapterCandidate = config?.adapterCommand === undefined
    ? path.join(paths.adapter, 'qq.sh')
    : requireAbsolute(config.adapterCommand, 'adapterCommand')
  const adapterCommand = existsSync(adapterCandidate) ? adapterCandidate : undefined
  const adapterHealth = typeof config?.adapterHealth === 'string' && config.adapterHealth !== ''
    ? config.adapterHealth
    : 'http://127.0.0.1:8080/health'
  // DSH 的会话仓库；孤儿检测只读它，不写。
  // 群聊会话的粒度：group = 一个群一个会话（默认），sender = 群内每人一个。
  const groupScope = config?.groupScope === 'sender' ? 'sender' : 'group'
  // 群聊里自动 @ 本轮提问的人，避免"不知道在回谁"。
  const groupMention = config?.groupMention !== 'off'
  const sessionsRoot = config?.sessionsRoot === undefined
    ? paths.sessions
    : requireAbsolute(config.sessionsRoot, 'sessionsRoot')

  // 会话状态和去重窗口交给 store：默认还是原来那个 JSON 文件，设
  // DSH_CS_STORE=postgres 才换成数据库。网关仍然直接拿这两个 Map 的引用就地
  // 改记录，store 只负责"变化怎么落地"。
  const store = createStore({
    kind: storeKind({ store: config?.store }),
    dataFile,
    seenFile,
    dedupeLimit,
    logger: ctx.logger,
  })
  // 投递队列：只有配了回复 webhook 才需要"重发"这回事。没有 webhook 时
  // （本地评测、只写审计的场景）emit 的行为与重构前完全一致，不引入任何状态。
  const retry = { ...DEFAULT_RETRY, ...(config?.outboxRetry ?? {}) }
  const outbox = replyWebhook === undefined
    ? undefined
    : createOutbox({
        kind: store.kind === 'postgres' ? 'postgres' : 'json',
        file: outboxFile,
        retry,
        logger: ctx.logger,
      })
  // 入站队列：客户消息先落这里再处理。附件下载、建会话都可能失败，失败后消息
  // 不能丢——平台不一定会重投。入站不受 replyWebhook 影响，永远启用。
  const inbox = createInbox({
    kind: store.kind === 'postgres' ? 'postgres' : 'json',
    file: `${dataFile.replace(/\.json$/, '')}-inbox.json`,
    retry: { ...DEFAULT_RETRY, ...(config?.inboxRetry ?? {}) },
    logger: ctx.logger,
  })
  // 审计：人工重放、数据清理这类"谁干的"要能回答的操作。
  const audit = createAudit({
    kind: store.kind === 'postgres' ? 'postgres' : 'json',
    file: auditFileFor(dataFile),
    logger: ctx.logger,
  })
  // 价格表：只在"要算钱"的时候需要。没配就是全 0，报表里会明说没配，
  // 而不是显示一堆 $0.00 让人以为算过了。
  const pricing = parsePricing(config?.pricing)
  // 保留期自动跑：默认关着，删数据这件事要人明确同意一次。
  const retentionAuto = resolveRetentionAuto(config?.retentionAuto)
  // 告警：/health 能查不等于有人会看。配了 webhook 和收件人才会推出去；
  // 缺一个就整条链关闭（发错人比不发危险），但状态照样留在 /alerts 里。
  const alerts = createAlerter({
    config: parseAlertConfig(config),
    logger: ctx.logger,
    route,
  })
  /** key -> one session record; 内容是 store.records 的引用。 */
  const sessions = store.records
  /** platform message id -> received-at ISO string, bounded FIFO. */
  const seen = store.seen
  /** key -> in-flight creation, so two simultaneous messages share one session. */
  const creating = new Map()
  /** sessionId -> key, for routing assistant messages back out. */
  const bySession = new Map()
  /** sessionId -> assistant text buffered for the current turn. */
  const pending = new Map()
  // 一轮之内累计的 token 用量：assistant/message 事件逐条带 usage，turn/end 时一次性记账。
  const pendingUsage = new Map()
  // 在飞的归档写入。归档是旁路（不 await），但测试和优雅关闭需要能等它们落完。
  const pendingArchives = new Set()
  // 在飞的回复投递。observe 是事件回调，不能阻塞模型回合，但关停时要能等它们落定。
  const pendingReplies = new Set()
  /** sessionId -> 本轮触发者，用于群聊自动 @。 */
  const turnSender = new Map()
  /** key -> recent message timestamps, in-memory only. */
  const rate = new Map()
  // key -> 最近一条入站消息的 traceId。只在内存里：进程重启后旧的会话没有追踪 id，
  // 这不影响功能，只是重启前那条消息的回复会缺 traceId。
  const traceByKey = new Map()
  let loaded = false

  async function load() {
    if (loaded) return
    // 必须先 await 再置标志：原来先置 loaded = true，两条消息同时进来时
    // 后一条会看到空表，于是给同一个客户建出两个会话。
    await store.load()
    for (const [key, record] of sessions) bySession.set(record.sessionId, key)
    loaded = true
  }

  /**
   * 持久化。带参只写这一条，不带参写全部（兼容旧调用点）。
   */
  async function persist(record) {
    assertWritable()
    if (record === undefined) {
      for (const value of sessions.values()) await store.save(value)
      return
    }
    await store.save(record)
  }

  /** 记一条入站去重并把窗口裁到上限。 */
  async function persistSeen(messageId, at) {
    await store.rememberSeen(messageId, at ?? new Date().toISOString())
  }

  /** 从所有工作区摘掉一个会话。 */
  async function detachWorkspace(sessionId) {
    // 无条件调用：工作区的 sessionIds 会按 cwd 过滤，失效会话可能不在里面，
    // 但登记里仍然残留着这个 id。
    for (const workspace of ctx.workspaceRegistry?.list?.() ?? []) {
      try {
        await workspace.detachSession(sessionId)
      } catch (error) {
        warn(`channel-gateway: detach failed: ${error.message}`)
      }
    }
  }

  /** 归档 / 取消归档。归档保留日志，只是从列表里隐藏。 */
  async function setArchived(key, archived) {
    await load()
    const record = sessions.get(key)
    if (record === undefined) throw new Error(`unknown conversation key: ${key}`)
    if (archived) {
      record.archivedAt = new Date().toISOString()
      await detachWorkspace(record.sessionId)
    } else {
      delete record.archivedAt
      await attachWorkspace(record.sessionId, { channel: record.channel, groupId: record.groupId ?? undefined })
    }
    await persist(record)
    return { key, archived: record.archivedAt !== undefined }
  }

  /** 彻底删除：会话文件、映射、工作区引用。 */
  async function deleteConversation(key) {
    assertWritable()
    await load()
    const record = sessions.get(key)
    if (record === undefined) throw new Error(`unknown conversation key: ${key}`)
    sessions.delete(key)
    bySession.delete(record.sessionId)
    pending.delete(record.sessionId)
    turnSender.delete(record.sessionId)
    await detachWorkspace(record.sessionId)
    // 工作区可能因为并发写入没摘干净：再确认一次。
    let detached = !(ctx.workspaceRegistry?.list?.() ?? [])
      .some(workspace => workspace.sessionIds.includes(record.sessionId))
    if (!detached) {
      await detachWorkspace(record.sessionId)
      detached = !(ctx.workspaceRegistry?.list?.() ?? [])
        .some(workspace => workspace.sessionIds.includes(record.sessionId))
    }
    // 文件不在这里删：DSH 可能还持有这个会话的引用，删文件会让它显示 ENOENT。
    // 真正的清除交给 scripts/retention.mjs（那时映射已经不存在了）。
    await store.remove(key)
    return { key, deleted: true, detached }
  }

  /** 适配器凭证文件；没有就用默认路径。 */
  function envFile() {
    return path.join(paths.adapter, '.env.local')
  }

  /** 读环境文件里的键值（不解析引号，够用）。 */
  function readEnv() {
    const file = envFile()
    const values = {}
    let text = ''
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      return values
    }
    for (const line of text.split('\n')) {
      const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line.trim())
      if (match !== null) values[match[1]] = match[2]
    }
    return values
  }

  /** 当前配置（永远不回传 secret）。 */
  async function getConfig() {
    const env = readEnv()
    return {
      appId: env.QQ_APP_ID ?? '',
      hasSecret: typeof env.QQ_APP_SECRET === 'string' && env.QQ_APP_SECRET !== '',
      envFile: envFile(),
      paths: {
        root: paths.root,
        data: paths.data,
        kb: paths.kb,
        adapter: paths.adapter,
      },
    }
  }

  /** 保存凭证；只改这两个键，其它行原样保留。 */
  async function saveConfig(input) {
    const appId = typeof input?.appId === 'string' ? input.appId.trim() : ''
    const appSecret = typeof input?.appSecret === 'string' ? input.appSecret.trim() : ''
    if (appId === '') throw new Error('AppID 不能为空')
    const env = readEnv()
    env.QQ_APP_ID = appId
    if (appSecret !== '') env.QQ_APP_SECRET = appSecret
    if (typeof env.QQ_APP_SECRET !== 'string' || env.QQ_APP_SECRET === '') {
      throw new Error('AppSecret 不能为空（第一次配置必须填写）')
    }
    if (env.QQ_GATEWAY === undefined) env.QQ_GATEWAY = 'http://127.0.0.1:3080'
    if (env.QQ_HEALTH_PORT === undefined) env.QQ_HEALTH_PORT = '8080'
    await fs.mkdir(paths.adapter, { recursive: true })
    const text = Object.entries(env).map(([key, value]) => `${key}=${value}`).join('\n') + '\n'
    await fs.writeFile(envFile(), text, { mode: 0o600 })
    return { saved: true, restartRequired: true }
  }

  /** 用当前凭证向 QQ 要一次 token，验证能不能用。 */
  async function testCredentials() {
    const env = readEnv()
    if (env.QQ_APP_ID === undefined || env.QQ_APP_SECRET === undefined) {
      throw new Error('还没有配置 AppID / AppSecret')
    }
    const response = await fetch('https://api.bot.qq.com/app/getAppAccessToken', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ appId: env.QQ_APP_ID, clientSecret: env.QQ_APP_SECRET }),
      signal: AbortSignal.timeout(8000),
    })
    const body = await response.json().catch(() => ({}))
    if (!response.ok || typeof body.access_token !== 'string') {
      throw new Error(body.message ?? body.error_description ?? `QQ 返回 ${response.status}`)
    }
    return { ok: true, expiresIn: body.expires_in ?? null }
  }

  /** 改会话标题，失败不影响消息处理。 */
  async function renameSession(key, title) {
    const record = sessions.get(key)
    if (record === undefined || title === undefined || record.title === title) return
    record.title = title
    await persist(record)
    const agent = ctx.agents.get(record.sessionId)
    if (agent !== undefined) {
      try {
        ctx.sessionTitle?.rename?.(agent.session, title)
      } catch (error) {
        warn(`channel-gateway: title rename failed: ${error.message}`)
      }
    }
  }

  /** 把会话挂到工作区；评测流量不挂。 */
  async function attachWorkspace(sessionId, payload) {
    const isEval = payload.channel === 'eval' && evalWorkspace !== undefined
    if (isEval) return
    const target = payload.groupId === undefined ? privateWorkspace : groupWorkspace
    try {
      const attached = await ctx.workspaceRegistry.create(target)
      await attached.setTitle('客服')
      await attached.attachSession(sessionId)
    } catch (error) {
      warn(`channel-gateway: workspace attach failed: ${error.message}`)
    }
  }

  /** Resolve or create the session for one conversation key. */
  async function ensureSession(key, payload, title) {
    const existing = sessions.get(key)
    if (existing !== undefined) {
      if (existing.archivedAt !== undefined) {
        delete existing.archivedAt
        await persist(existing)
        await attachWorkspace(existing.sessionId, payload)
      }
      const live = ctx.agents.get(existing.sessionId)
      if (live !== undefined) return live
      try {
        const resumed = await ctx.agents.resume({ resumeSessionId: existing.sessionId })
        return resumed.agent
      } catch (error) {
        // 会话文件可能已经被清理掉：丢掉坏映射，重建一个，而不是让整个会话报错。
        warn(
          `channel-gateway: cannot resume ${existing.sessionId}, starting fresh: ${error.message}`,
        )
        sessions.delete(key)
        bySession.delete(existing.sessionId)
        pending.delete(existing.sessionId)
        await store.remove(key)
      }
    }
    const inFlight = creating.get(key)
    if (inFlight !== undefined) return inFlight

    const task = (async () => {
      const sessionId = `chan-${randomUUID()}`
      const selection = ctx.agentDefaultModel.currentSelection()
      const isEval = payload.channel === 'eval' && evalWorkspace !== undefined
      const target = isEval ? evalWorkspace : payload.groupId === undefined ? privateWorkspace : groupWorkspace
      const workspaceTitle = '客服'
      await fs.mkdir(target, { recursive: true })
      const handle = await ctx.agents.create({
        sessionId,
        meta: { cwd: target, agentPreset },
        agentOptions: { provider: selection.provider, model: selection.model },
        setup: async (agentCtx) => {
          await ctx.agentPresets.mount(agentCtx, agentPreset)
        },
      })
      ctx.sessionTitle.rename(handle.agent.session, title)
      // Without this the Session never appears in the GUI's workspace list.
      await attachWorkspace(sessionId, payload)
      const now = new Date().toISOString()
      const record = {
        sessionId,
        key,
        channel: payload.channel,
        groupId: payload.groupId ?? null,
        groupName: payload.groupName ?? null,
        senderName: payload.senderName ?? null,
        label: null,
        title: title ?? null,
        token: tokenOf(key),
        senderId: payload.senderId,
        createdAt: now,
        lastSeenAt: now,
        mode: 'ai',
        modeChangedAt: now,
      }
      sessions.set(key, record)
      bySession.set(sessionId, key)
      await persist(record)
      return handle.agent
    })()

    creating.set(key, task)
    try {
      return await task
    } finally {
      creating.delete(key)
    }
  }

  /** Refuse a key that exceeds its per-minute budget. */
  function checkRate(key) {
    const now = Date.now()
    const window = (rate.get(key) ?? []).filter(at => now - at < 60_000)
    if (window.length >= maxPerMinute) {
      const retryAfter = Math.max(1, Math.ceil((60_000 - (now - window[0])) / 1000))
      const error = new Error(`rate limited: retry after ${retryAfter}s`)
      error.code = 'RATE_LIMITED'
      error.retryAfter = retryAfter
      throw error
    }
    window.push(now)
    rate.set(key, window)
  }

  /**
   * Download platform images. `path` mode writes files and returns text notes so
   * a text-only model can call ocr_image; `native` mode returns image blocks.
   */
  async function admitImages(list) {
    if (list.length === 0) return { blocks: [], notes: [] }
    if (list.length > maxAttachments) {
      throw new Error(`too many attachments (max ${maxAttachments})`)
    }
    const store = imageMode === 'native' ? ctx.get?.('attachments') : undefined
    if (imageMode === 'native' && store === undefined) throw new Error('attachment service is not mounted')
    const images = []
    for (const item of list) {
      const response = await fetch(item.url, { signal: AbortSignal.timeout(15_000) })
      if (!response.ok) throw new Error(`attachment fetch failed (${response.status}): ${item.url}`)
      const declared = item.mediaType ?? (response.headers.get('content-type') ?? '').split(';')[0].trim()
      if (!declared.startsWith('image/')) throw new Error(`unsupported attachment type: ${declared || 'unknown'}`)
      const bytes = new Uint8Array(await response.arrayBuffer())
      if (bytes.byteLength > maxAttachmentBytes) throw new Error('attachment exceeds the size limit')
      images.push({ data: bytes, mediaType: declared, ...(item.name === undefined ? {} : { name: item.name }) })
    }
    if (imageMode === 'native') {
      const refs = await store.saveImages(images)
      return { blocks: refs.map(ref => ({ type: 'image', attachment: ref })), notes: [] }
    }
    await fs.mkdir(imageDir, { recursive: true })
    const notes = []
    for (const [index, image] of images.entries()) {
      const file = path.join(imageDir, `${randomUUID()}${extensionOf(image.mediaType)}`)
      await fs.writeFile(file, image.data, { mode: 0o600 })
      notes.push({ type: 'text', text: `[图片 ${index + 1}] 已保存：${file}\n需要读其中的文字时调用 ocr_image。` })
    }
    return { blocks: [], notes }
  }

  /** 会话 key：私聊按人，群聊按群（或群内按人）。 */
  function keyFor(message) {
    if (message.groupId === undefined) return `${message.channel}:${message.senderId}`
    return groupScope === 'sender'
      ? `${message.channel}:${message.groupId}:${message.senderId}`
      : `${message.channel}:group:${message.groupId}`
  }

  /**
   * 受理一条入站消息。
   *
   * 顺序是"先收下，再处理"：校验/去重/限流之后立刻把消息落进队列，落进去就算
   * 受理成功；然后在这个请求里试一次处理，成功就照旧同步返回，失败则留给后台
   * 按退避重试。这样附件下载失败、建会话超时都不会让客户消息凭空消失。
   */
  async function inbound(payload) {
    await load()
    const message = normalizeInbound(payload, maxAttachments)
    const key = keyFor(message)
    // 每条入站消息一个追踪 id：日志、审计行、模型消息、回复信封里都是同一个，
    // 客户说"刚才那条没回"时能一路查下去。
    const traceId = newTraceId()
    return withTrace(traceId, () => acceptInbound(message, key, traceId))
  }

  async function acceptInbound(message, key, traceId) {
    // 先登记：即使这条消息因为重复被短路掉，之后这条会话的回复也该带上它的 traceId。
    traceByKey.set(key, traceId)

    if (message.messageId !== undefined && seen.has(message.messageId)) {
      return { key, duplicate: true, traceId, sessionId: sessions.get(key)?.sessionId ?? null }
    }
    checkRate(key)

    assertWritable()
    // 入队即受理。幂等键让平台重投不会排两次。
    const envelope = {
      key,
      channel: message.channel,
      at: new Date().toISOString(),
      messageId: message.messageId,
      // 幂等键只由消息身份决定：错在这里会让平台重投变成两条队列记录。
      idempotencyKey: inboxKey(message, { dedupeByContent: config?.dedupeByContent !== false }),
      traceId,
      message,
    }
    const { record: queued, duplicate } = await inbox.enqueue(envelope, { notBefore: inbox.retry.graceMs })
    if (duplicate && queued.state === 'sent') {
      return { key, duplicate: true, traceId, sessionId: sessions.get(key)?.sessionId ?? null }
    }
    // 去重窗口在受理时就记下：之后平台重投会被上面那道判断挡掉，而队列里的那份
    // 仍会被后台重试，不会两边都处理。
    if (message.messageId !== undefined) await persistSeen(message.messageId)

    const outcome = await processInbound(queued)
    if (outcome.ok) {
      return { key, duplicate: false, traceId, ...outcome.value }
    }
    warn(`channel-gateway: inbound accepted but not handled yet: ${outcome.error.message}`)
    return {
      key,
      duplicate: false,
      traceId,
      accepted: true,
      queued: outcome.state !== 'dead',
      error: outcome.error.message,
      attempts: outcome.attempts,
    }
  }

  /**
   * 把队列里的一条真正投给模型。成功标 sent，失败标 failed（或 dead）。
   * 幂等性说明：`agent.followup` 之后、`markSent` 之前崩溃会导致重试时再喂一遍，
   * 属于 at-least-once；这个窗口只有一次函数返回的时间，比"整条消息丢掉"划算。
   */
  async function processInbound(item) {
    const message = item.payload.message
    const key = item.payload.key
    // 首投在 inbound 的 trace 上下文里；后台重试走 drainInbox，那里没有上下文，
    // 所以以信封里的 traceId 为准重建，日志才能接着上一次的 id。
    const traceId = item.payload.traceId
    if (traceId !== undefined) traceByKey.set(key, traceId)
    return traceId === undefined ? runProcessInbound(item, message, key) : withTrace(traceId, () => runProcessInbound(item, message, key))
  }

  async function runProcessInbound(item, message, key) {
    try {
      const { blocks: imageBlocks, notes: imageNotes } = await admitImages(message.attachments)
    const agent = await ensureSession(key, message, titleFor(message, key))
    const record = sessions.get(key)
    if (record !== undefined) {
      record.lastSeenAt = new Date().toISOString()
      record.lastSenderId = message.senderId
      if (message.groupName !== undefined) record.groupName = message.groupName
      if (message.senderName !== undefined) record.senderName = message.senderName
      await persist(record)
      if (record.label === null && message.groupName !== undefined) {
        await renameSession(key, titleFor({
          channel: record.channel,
          groupId: record.groupId ?? undefined,
          groupName: record.groupName ?? undefined,
          senderId: record.senderId,
          senderName: record.senderName ?? undefined,
        }, key))
      }
    }
    // 群聊里把发送者写进内容，模型才知道这张图/这句话是谁说的。
    const speaker = message.groupId !== undefined
      ? `[群成员 ${message.senderName ?? message.senderId.slice(0, 6)}] `
      : ''
    const userMessage = {
      id: randomUUID(),
      role: 'user',
      content: [
        ...(message.text === '' && speaker === '' ? [] : [{ type: 'text', text: `${speaker}${message.text}` }]),
        ...imageBlocks,
        ...imageNotes,
      ],
      source: {
        kind: 'channel',
        channel: message.channel,
        senderId: message.senderId,
        ...(message.senderName === undefined ? {} : { senderName: message.senderName }),
        ...(message.groupId === undefined ? {} : { groupId: message.groupId }),
        ...(message.messageId === undefined ? {} : { messageId: message.messageId }),
        ...(traceByKey.get(key) === undefined ? {} : { traceId: traceByKey.get(key) }),
        form: 'notice',
        summary: `${message.channel} message from ${message.senderId}`,
      },
    }
    // 人工接管中：只把客户消息写进会话给管理员看，不唤醒模型。
    if (record?.mode === 'human') {
      agent.inject?.(userMessage)
      // 归档放在交付之后：先保证消息到了 agent 那里，再记历史。
      await archiveMessage(key, {
        role: 'user',
        content: `${speaker}${message.text}`,
        ...(message.messageId === undefined ? {} : { platformMsgId: message.messageId }),
        ...(traceByKey.get(key) === undefined ? {} : { traceId: traceByKey.get(key) }),
      })
      await inbox.markSent(item.idempotencyKey)
      return { ok: true, value: { held: true, sessionId: agent.id } }
    }
    agent.followup(userMessage)
    await archiveMessage(key, {
      role: 'user',
      content: `${speaker}${message.text}`,
      ...(message.messageId === undefined ? {} : { platformMsgId: message.messageId }),
      ...(traceByKey.get(key) === undefined ? {} : { traceId: traceByKey.get(key) }),
    })
    await inbox.markSent(item.idempotencyKey)
    return { ok: true, value: { sessionId: agent.id } }
    } catch (error) {
      const failed = await inbox.markFailed(item.idempotencyKey, error.message)
      return { ok: false, error, state: failed?.state, attempts: failed?.attempts }
    }
  }

  /**
   * 处理队列里到期的一批。首投失败的消息靠这里重试，退避用与投递队列同一套参数。
   */
  async function drainInbox(limit = 20) {
    await inbox.load()
    const batch = await inbox.claim(limit)
    let processed = 0
    let failed = 0
    for (const item of batch) {
      const outcome = await processInbound(item)
      if (outcome.ok) {
        processed += 1
      } else {
        warn(`channel-gateway: inbound retry failed: ${outcome.error.message}`)
        failed += 1
      }
    }
    return { claimed: batch.length, processed, failed }
  }

  /**
   * 记一笔在飞的回复投递。
   *
   * emit 出错只告警（客户那条消息的处理不该因为回复发不出去而失败），
   * 但 promise 要留着，关停和测试可以等它落定，避免"明明该发出去却还没发"。
   */
  function trackReply(promise) {
    const tracked = promise
      .catch(error => warn(`channel-gateway: reply not sent: ${error.message}`))
      .finally(() => pendingReplies.delete(tracked))
    pendingReplies.add(tracked)
    return tracked
  }

  /** 按名字取队列。名字对不上返回 undefined，让调用方报 400 而不是 500。 */
  function queueByName(name) {
    if (name === 'inbox') return inbox
    if (name === 'outbox') return outbox
    return undefined
  }

  /**
   * 人工重放死信。
   *
   * 只放回 dead/failed 的条目；sent 的不动（客户会看到两条一样的回复），
   * sending 的也不动（那是别的进程手里的租约）。每一次重放都记审计 ——
   * 这是"谁把发不出去的回复又推了一遍"，事后必须能查。
   */
  async function replayDead(queueName, idempotencyKeys, actor = 'panel') {
    const queue = queueByName(queueName)
    if (queue === undefined) {
      const error = new Error(`unknown queue: ${queueName}`)
      error.code = 'BAD_QUEUE'
      throw error
    }
    assertWritable()
    const keys = Array.isArray(idempotencyKeys) && idempotencyKeys.length > 0
      ? idempotencyKeys
      : (await queue.listDead(100)).map(record => record.idempotencyKey)
    const replayed = []
    const skipped = []
    for (const key of keys) {
      const record = await queue.replay(key)
      if (record === undefined) {
        skipped.push({ idempotencyKey: key, reason: 'not found' })
        continue
      }
      if (record.replayed !== true) {
        skipped.push({ idempotencyKey: key, reason: `state is ${record.state}` })
        continue
      }
      replayed.push(key)
      await audit.record({
        actor,
        role: 'operator',
        action: 'replay',
        targetType: queueName,
        targetId: key,
        detail: { attempts: record.attempts, externalKey: record.payload?.key ?? null },
      })
    }
    return { queue: queueName, replayed, skipped }
  }

  /**
   * 保留期检查。
   *
   * 默认只算不删（`dryRun: true`）—— 会删数据的东西不该在 curl 一发下去就生效，
   * 必须先看一眼计划。真删要显式传 `dryRun: false`。
   *
   * 三个入口：
   *   - 不给参数：按保留期算该归档/该清除的；
   *   - `limits`：这一轮用临时保留期（不改配置）；
   *   - `owner`（key / senderId / groupId）：按客户清除，用于"注销账号"这类要求。
   */
  async function runRetention(body = {}) {
    await load()
    const dryRun = body?.dryRun !== false
    const limits = retentionLimits({ ...(config?.retention ?? {}), ...(body?.limits ?? {}) })
    const records = [...sessions.values()]
    if (body?.owner !== undefined && body.owner !== null) {
      const targets = planPurgeByOwner(records, body.owner)
      if (dryRun) return { dryRun, mode: 'owner', owner: body.owner, purge: targets, archive: [], limits }
      assertWritable()
      const purged = []
      for (const item of targets) {
        const record = sessions.get(item.key)
        await store.purgeConversation(item.key)
        if (record !== undefined) bySession.delete(record.sessionId)
        purged.push(item.key)
        await audit.record({
          actor: body?.actor ?? 'panel',
          role: 'operator',
          action: 'purge',
          targetType: 'conversation',
          targetId: item.key,
          detail: { reason: 'owner-request', owner: body.owner, scope: item.scope },
        })
      }
      return { dryRun, mode: 'owner', owner: body.owner, purged, limits }
    }

    const plan = planRetention(records, { limits })
    if (dryRun) return { dryRun, mode: 'retention', ...plan }
    assertWritable()
    const archived = []
    for (const item of plan.archive) {
      // 归档走现有入口：它同时负责把会话从工作区摘下来。
      await setArchived(item.key, true)
      archived.push(item.key)
      await audit.record({
        actor: body?.actor ?? 'panel',
        role: 'system',
        action: 'archive',
        targetType: 'conversation',
        targetId: item.key,
        detail: { reason: 'retention', scope: item.scope, ageDays: item.ageDays },
      })
    }
    const purged = []
    for (const item of plan.purge) {
      const record = sessions.get(item.key)
      await store.purgeConversation(item.key)
      if (record !== undefined) bySession.delete(record.sessionId)
      purged.push(item.key)
      await audit.record({
        actor: body?.actor ?? 'panel',
        role: 'system',
        action: 'purge',
        targetType: 'conversation',
        targetId: item.key,
        detail: { reason: 'retention', scope: item.scope, ageDays: item.ageDays, archivedAt: item.archivedAt ?? null },
      })
    }
    // 归档和清除都动过会话表，落一次盘让内存和存储一致。
    await store.flush()
    return { dryRun, mode: 'retention', archived, purged, limits, summary: describePlan(plan) }
  }

  /**
   * 归档一条消息。
   *
   * 存消息是旁路，不是主流程：磁盘满、库挂了都不该让客户的消息处理失败，
   * 所以这里吞掉异常只记 warn。没归档成功会在日志里留下痕迹，但消息照发。
   */
  async function archiveMessage(key, message) {
    try {
      const saved = await store.saveMessage(key, message)
      if (saved === false) warn(`channel-gateway: message archive skipped, no conversation row for ${key}`)
    } catch (error) {
      warn(`channel-gateway: message archive failed: ${error.message}`)
    }
  }

  /** 记一轮的用量。同样是旁路，失败只告警。 */
  async function archiveUsage(key, usage) {
    try {
      await store.bumpUsage(key, usage)
    } catch (error) {
      warn(`channel-gateway: usage archive failed: ${error.message}`)
    }
  }

  /** 记下在飞的归档写入，好让 flushArchives() 等到它们落完。 */
  function trackArchive(promise) {
    pendingArchives.add(promise)
    // archiveMessage/archiveUsage 自己吞了异常，这里只负责从集合里摘掉。
    promise.then(() => pendingArchives.delete(promise), () => pendingArchives.delete(promise))
    return promise
  }

  /** 等所有在飞的归档写完。优雅关闭与测试用；正常路径不等。 */
  async function flushArchives() {
    // 循环而非只等一次：等待期间事件回调可能又排进新的归档或回复。
    while (pendingArchives.size > 0 || pendingReplies.size > 0) {
      await Promise.all([...pendingArchives, ...pendingReplies])
    }
    await store.flush()
  }

  /** 读队列统计，库/文件有问题时不要让看病接口挂掉。 */
  async function statSafely(queue) {
    try {
      return await queue.stats()
    } catch (error) {
      return { error: error.message }
    }
  }

  /**
   * 健康检查：给探针和运维看"这个网关现在能不能干活"。
   *
   * 只回答四件事：租约还在不在、队列读不读得出来、数据库通不通、有没有死信。
   * 任何一项探测自己抛错都不能让端点挂掉 —— 探针拿到 500 只会让编排系统误判整机故障，
   * 而真实原因往往只是数据库暂时连不上。
   */
  async function health() {
    const checks = []
    const leaseLost = lease?.lost === true
    checks.push({
      name: 'lease',
      ok: !leaseLost,
      detail: lease === undefined ? 'not attached' : `${lease.kind}${leaseLost ? ' (taken over)' : ''}`,
    })

    const inboxStats = await statSafely(inbox)
    checks.push({
      name: 'inbox',
      ok: inboxStats.error === undefined,
      detail: inboxStats.error ?? `${inboxStats.pending ?? 0} pending, ${inboxStats.dead ?? 0} dead`,
    })

    let outboxStats
    if (outbox !== undefined) {
      outboxStats = await statSafely(outbox)
      checks.push({
        name: 'outbox',
        ok: outboxStats.error === undefined,
        detail: outboxStats.error ?? `${outboxStats.pending ?? 0} pending, ${outboxStats.dead ?? 0} dead`,
      })
    }

    let database
    if (store.kind === 'postgres') {
      try {
        database = await dbHealth()
      } catch (error) {
        database = { enabled: true, ok: false, error: error.message }
      }
      checks.push({
        name: 'database',
        ok: database.ok === true,
        detail: database.error ?? database.version ?? 'ok',
      })
    }

    // 死信不算"不健康"：它们是处理过又放弃的，需要人看，但不代表网关挂了。
    return {
      ok: checks.every(item => item.ok),
      uptimeMs: Date.now() - startedAt,
      route,
      store: { kind: store.kind },
      lease: { kind: lease?.kind ?? null, lost: leaseLost },
      retention: { ...retentionState },
      alerts: alerts.status(),
      queues: { inbox: inboxStats, outbox: outboxStats ?? null },
      database: database ?? null,
      checks,
    }
  }

  /** POST one envelope to the adapter; throws on any failure so callers can retry. */
  async function postReply(envelope) {
    // fetch 的网络错误和 HTTP 错误都统一成 throw：上层只关心"这次没送达"，
    // 重发还是标死由队列决定。
    const response = await fetch(replyWebhook, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(envelope),
    })
    if (!response.ok) {
      const detail = await response.json().catch(() => ({}))
      throw new Error(detail.error ?? `HTTP ${response.status}`)
    }
  }

  /**
   * Send the due replies once. Called inline by emit (first attempt) and by the
   * background worker (retries). Each entry is claimed first, so two callers
   * never send the same reply at the same time.
   */
  async function drainOutbox(limit = 20) {
    if (outbox === undefined) return { claimed: 0, delivered: 0, failed: 0 }
    await outbox.load()
    const batch = await outbox.claim(limit)
    let delivered = 0
    let failed = 0
    for (const item of batch) {
      try {
        await postReply(item.payload)
        await outbox.markSent(item.idempotencyKey)
        delivered += 1
      } catch (error) {
        warn(`channel-gateway: reply webhook failed: ${error.message}`)
        await outbox.markFailed(item.idempotencyKey, error.message)
        failed += 1
      }
    }
    return { claimed: batch.length, delivered, failed }
  }

  let workerTimer
  /** Start the background sweep for both queues. Timers are unref'd so a CLI run can still exit. */
  function startWorker() {
    if (workerTimer !== undefined) return false
    const sweep = Math.min(retry.sweepMs, inbox.retry.sweepMs)
    const tick = () => {
      // 租约丢了就别再动了：继续重试只会往不属于自己的库里写。
      if (lease?.lost === true) {
        warn('channel-gateway: write lease lost; stopping the retry worker')
        stopWorker()
        return
      }
      // 两个队列各跑各的：一个挂了不能让另一个停摆。
      if (outbox !== undefined) {
        drainOutbox().catch(error => warn(`channel-gateway: outbox drain failed: ${error.message}`))
      }
      drainInbox().catch(error => warn(`channel-gateway: inbox drain failed: ${error.message}`))
    }
    workerTimer = setInterval(tick, sweep)
    // unref: 否则只要进程里还有待重试的条目，测试和 CLI 就跑不完。
    workerTimer.unref?.()
    tick()
    return true
  }

  function stopWorker() {
    if (workerTimer === undefined) return false
    clearInterval(workerTimer)
    workerTimer = undefined
    return true
  }

  // 保留期自动跑。状态放在闭包里，`/health` 直接读它 —— 判断"数据真的删了吗"
  // 只需要看 `lastRunAt`，不用去翻日志。
  const retentionState = {
    enabled: retentionAuto.enabled,
    everyMs: retentionAuto.everyMs,
    dryRun: retentionAuto.dryRun,
    running: false,
    lastRunAt: undefined,
    lastResult: undefined,
    lastError: undefined,
  }
  let retentionTimer
  let retentionStartTimer

  /**
   * 跑一次自动保留期清理。
   *
   * @param {string} [reason] - 触发原因，写进审计的 actor（`schedule:startup` / `schedule:tick`）。
   * @returns {Promise<object>} 清理结果；失败时返回 `{ error }` 而不是抛。
   */
  async function runRetentionSweep(reason = 'tick') {
    // 上一轮还没跑完（库慢、会话多）就跳过这一轮：两轮同时删同一批会话没有意义。
    if (retentionState.running) return { skipped: 'busy' }
    retentionState.running = true
    try {
      const result = await runRetention({ dryRun: retentionAuto.dryRun, actor: `schedule:${reason}` })
      const archived = result.dryRun === true ? (result.archive ?? []).length : (result.archived ?? []).length
      const purged = result.dryRun === true ? (result.purge ?? []).length : (result.purged ?? []).length
      retentionState.lastRunAt = new Date().toISOString()
      retentionState.lastResult = { dryRun: result.dryRun === true, archived, purged }
      retentionState.lastError = undefined
      if (archived + purged > 0) {
        warn(
          `channel-gateway: scheduled retention ${result.dryRun === true ? '(dry run) ' : ''}archived ${archived}, purged ${purged}`,
        )
      }
      return result
    } catch (error) {
      // 租约被接管、库连不上都会走到这里。清理失败不该让网关挂掉，但要留下痕迹。
      retentionState.lastRunAt = new Date().toISOString()
      retentionState.lastError = error.message
      warn(`channel-gateway: scheduled retention failed: ${error.message}`)
      return { error: error.message }
    } finally {
      retentionState.running = false
    }
  }

  /** 启动自动清理。默认配置下由 `install()` 自动调用。 */
  function startRetentionWorker() {
    if (retentionAuto.enabled !== true) return false
    if (retentionTimer !== undefined || retentionStartTimer !== undefined) return false
    const tick = () => {
      // 租约丢了就别删：删的是别人的数据。
      if (lease?.lost === true) {
        warn('channel-gateway: write lease lost; stopping the retention worker')
        stopRetentionWorker()
        return
      }
      void runRetentionSweep()
    }
    retentionStartTimer = setTimeout(() => {
      retentionStartTimer = undefined
      tick()
      retentionTimer = setInterval(tick, retentionAuto.everyMs)
      // unref: 否则只要还有这个定时器，测试与 CLI 就跑不完。
      retentionTimer.unref?.()
    }, retentionAuto.initialDelayMs)
    retentionStartTimer.unref?.()
    return true
  }

  function stopRetentionWorker() {
    const running = retentionTimer !== undefined || retentionStartTimer !== undefined
    if (retentionTimer !== undefined) clearInterval(retentionTimer)
    if (retentionStartTimer !== undefined) clearTimeout(retentionStartTimer)
    retentionTimer = undefined
    retentionStartTimer = undefined
    return running
  }

  // 告警定时自检。跟队列 worker 分开：那个只在有待重试条目时才有意义，而这个
  // 要回答"现在有没有问题"，跟有没有活儿无关。
  let alertTimer
  let alertStartedAt

  /**
   * 跑一轮告警自检：读一次 health，交给发送器判断该报什么。
   *
   * @param {object} [at] - 测试用：指定 `now`。
   * @returns {Promise<object>} `{fired, recovered, active, text, sent}`。
   */
  async function checkAlerts(at = {}) {
    const report = await health()
    // 刚起来的那十几秒数据库/队列可能还在握手，先不报，避免重启即刷屏。
    if (alertStartedAt !== undefined && Date.now() - alertStartedAt < alerts.config.graceMs) {
      return { fired: 0, recovered: 0, active: alerts.active, text: '', sent: false, skipped: 'grace' }
    }
    return alerts.check(report, at)
  }

  /** 启动告警自检。`install()` 会调用；也可以在测试里手动 start/stop。 */
  function startAlertWorker() {
    if (alertTimer !== undefined) return false
    alertStartedAt = Date.now()
    alertTimer = setInterval(() => {
      checkAlerts().catch(error => warn(`channel-gateway: alert check failed: ${error.message}`))
    }, alerts.config.intervalMs)
    // unref: 否则测试与 CLI 进程退不出去。
    alertTimer.unref?.()
    return true
  }

  function stopAlertWorker() {
    if (alertTimer === undefined) return false
    clearInterval(alertTimer)
    alertTimer = undefined
    return true
  }

  /** Forward one assistant message to the platform adapter. */
  async function emit(key, text, mention, route) {
    if (text.trim() === '') return
    assertWritable()
    const record = route ?? sessions.get(key)
    const envelope = {
      key,
      channel: record?.channel ?? 'unknown',
      groupId: record?.groupId ?? null,
      senderId: record?.senderId ?? null,
      text,
      ...(typeof mention === 'string' && mention !== '' ? { mention } : {}),
      at: new Date().toISOString(),
      // 回复带上触发它的那条客户消息的 traceId，适配器侧日志能对上。
      ...(traceByKey.get(key) === undefined ? {} : { traceId: traceByKey.get(key) }),
    }
    // The outbox is written even when a webhook is configured: it is the audit
    // trail, and a dead adapter must not silently swallow customer replies.
    if (outboxFile !== undefined) {
      // 记账失败不能让回复发不出去：审计文件写不进去（磁盘满、目录不可写）
      // 时降级成告警，投递路径照常走。丢的是可查性，不是客户的消息。
      try {
        await fs.mkdir(path.dirname(outboxFile), { recursive: true })
        await fs.appendFile(outboxFile, `${JSON.stringify(envelope)}\n`, 'utf8')
      } catch (error) {
        warn(`channel-gateway: reply audit write failed: ${error.message}`)
      }
    }
    if (outbox === undefined) {
      // 没有 webhook 时只写 outbox，视为已投递到本地。
      return { delivered: true }
    }
    // 先入队再首发：即使这一轮进程立刻被杀，重启后也能把这条补发出去。
    const { record: queued, duplicate } = await outbox.enqueue(envelope, { notBefore: retry.graceMs })
    // 同一个幂等键已经发成功过：直接算送达，不再发第二遍。
    if (duplicate && queued.state === 'sent') return { delivered: true, duplicate: true }
    try {
      await postReply(envelope)
      await outbox.markSent(queued.idempotencyKey)
      return { delivered: true }
    } catch (error) {
      warn(`channel-gateway: reply webhook failed: ${error.message}`)
      const failed = await outbox.markFailed(queued.idempotencyKey, error.message)
      // 首发送失败不等于丢：消息已在队列里，后台会按退避重发。
      return {
        delivered: false,
        error: error.message,
        queued: failed?.state !== 'dead',
        attempts: failed?.attempts,
      }
    }
  }

  /**
   * Observe assistant output. `final` buffers per turn and emits once on
   * `turn/end`; `all` emits every completed assistant message immediately.
   */
  function observe(session, event) {
    const sessionId = session?.id
    if (typeof sessionId !== 'string') return
    const key = bySession.get(sessionId)
    if (key === undefined) return
    // 管理员在接管：模型的输出一律不外发，避免和人对抢。
    if (sessions.get(key)?.mode === 'human') {
      pending.delete(sessionId)
      pendingUsage.delete(sessionId)
      return
    }

    if (event.type === 'assistant/message') {
      const text = textOf(event.data?.message?.content)
      const usage = event.data?.usage
      // 这一条是哪个模型答的。成本必须按片段算：一轮里可能换了模型
      // （重试、降级都会换），用整轮总量乘一个单价是错的。
      const source = event.data?.message?.source
      const model = typeof source?.model === 'string' ? source.model : undefined
      const provider = typeof source?.provider === 'string' ? source.provider : undefined
      const fragmentCost = usage === undefined ? 0 : costMicros(usage, priceFor(pricing, model))
      // 逐条合并这一轮的用量，等 turn/end 一次性记账。
      if (usage !== undefined) {
        const acc = pendingUsage.get(sessionId) ?? {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 0,
          costMicros: 0,
        }
        acc.inputTokens += usage.inputTokens ?? 0
        acc.outputTokens += usage.outputTokens ?? 0
        acc.cacheReadTokens += usage.cacheReadTokens ?? 0
        acc.cacheWriteTokens += usage.cacheWriteTokens ?? 0
        acc.totalTokens += usage.totalTokens ?? 0
        acc.costMicros += fragmentCost
        pendingUsage.set(sessionId, acc)
      }
      if (text === '') return
      if (forward === 'all') {
        // 逐条外发模式下，每条回复就是一条独立消息，用量直接挂在它身上。
        trackArchive(archiveMessage(key, {
          role: 'assistant',
          content: text,
          ...(traceByKey.get(key) === undefined ? {} : { traceId: traceByKey.get(key) }),
          ...(model === undefined ? {} : { model }),
          ...(provider === undefined ? {} : { provider }),
          ...(usage === undefined
            ? {}
            : {
                inputTokens: usage.inputTokens ?? undefined,
                outputTokens: usage.outputTokens ?? undefined,
                cacheReadTokens: usage.cacheReadTokens ?? undefined,
                cacheWriteTokens: usage.cacheWriteTokens ?? undefined,
                totalTokens: usage.totalTokens ?? undefined,
                ...(fragmentCost === 0 ? {} : { costMicros: fragmentCost }),
              }),
        }))
        trackReply(emit(key, text))
        return
      }
      const buffer = pending.get(sessionId) ?? []
      buffer.push(text)
      pending.set(sessionId, buffer.slice(-MAX_BUFFERED))
      return
    }

    if (event.type === 'turn/start') {
      turnSender.set(sessionId, sessions.get(key)?.lastSenderId)
      return
    }
    if (event.type === 'turn/end') {
      const buffer = pending.get(sessionId)
      pending.delete(sessionId)
      const accumulated = pendingUsage.get(sessionId)
      pendingUsage.delete(sessionId)
      const sender = turnSender.get(sessionId)
      turnSender.delete(sessionId)
      const record = sessions.get(key)
      const mention = record?.groupId !== undefined && groupMention ? sender : undefined
      // 一轮结束记一次用量。逐条外发模式下 token 已经挂在各条消息上，这里只计轮数，
      // 否则同一批 token 会被算两遍。
      trackArchive(archiveUsage(key, {
        turns: 1,
        ...(forward === 'all'
          ? {}
          : {
              inputTokens: accumulated?.inputTokens ?? 0,
              outputTokens: accumulated?.outputTokens ?? 0,
              cacheReadTokens: accumulated?.cacheReadTokens ?? 0,
              cacheWriteTokens: accumulated?.cacheWriteTokens ?? 0,
              costMicros: accumulated?.costMicros ?? 0,
            }),
      }))
      if (buffer !== undefined && buffer.length > 0) {
        trackArchive(archiveMessage(key, {
          role: 'assistant',
          content: buffer.join('\n\n'),
          ...(traceByKey.get(key) === undefined ? {} : { traceId: traceByKey.get(key) }),
        }))
        trackReply(emit(key, buffer.join('\n\n'), mention))
        return
      }
      // A failed or interrupted turn can close without any assistant text. The
      // customer must not be left waiting on a dead conversation.
      if (forward === 'final' && event.data?.reason?.kind !== 'completed') {
        // 预设版本漂移（旧会话恢复后装配失败）：丢掉映射，下一条消息重建。
        const reason = event.data?.reason?.error?.message ?? ''
        // 自愈会删掉映射，先把路由信息留一份，否则回退回复不知道该发哪儿。
        const route = sessions.get(key)
        const fallback = { ...(route ?? {}) }
        if (reason.includes('prompt variable')) {
          warn(`channel-gateway: preset drift on ${key}, resetting the conversation`)
          sessions.delete(key)
          bySession.delete(sessionId)
          void store.remove(key).catch(error => {
            warn(`channel-gateway: drop drifted conversation failed: ${error.message}`)
          })
        }
        trackArchive(archiveMessage(key, {
          role: 'assistant',
          content: FALLBACK_REPLY,
          ...(traceByKey.get(key) === undefined ? {} : { traceId: traceByKey.get(key) }),
        }))
        trackReply(emit(key, FALLBACK_REPLY, mention, fallback))
      }
    }
  }

  /** 切换接管模式：ai 自动回复，human 由管理员回复。 */
  async function setMode(key, mode) {
    await load()
    if (mode !== 'ai' && mode !== 'human') throw new Error('mode must be ai or human')
    const record = sessions.get(key)
    if (record === undefined) throw new Error(`unknown conversation key: ${key}`)
    record.mode = mode
    record.modeChangedAt = new Date().toISOString()
    await persist(record)
    return { key, mode }
  }

  /** 把所有 zstd 帧解成一段 JSONL 文本。 */
  function decodeFrames(buffer) {
    const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
    const offsets = []
    for (let i = 0; i + 4 <= buffer.length; i += 1) {
      if (buffer.compare(magic, 0, 4, i, i + 4) === 0) offsets.push(i)
    }
    let text = ''
    for (let i = 0; i < offsets.length; i += 1) {
      const frame = buffer.subarray(offsets[i], i + 1 < offsets.length ? offsets[i + 1] : buffer.length)
      text += zstdDecompressSync(frame).toString('utf8')
    }
    return text
  }

  /** 会话所属的存储目录（由工作区路径派生）。 */
  function sessionDirectory(record) {
    const workspacePath = record.channel === 'eval'
      ? evalWorkspace
      : record.groupId !== null
        ? groupWorkspace
        : privateWorkspace
    if (workspacePath === undefined) return undefined
    return path.join(sessionsRoot, `--${workspacePath.replace(/^\//, '').replaceAll('/', '-')}--`)
  }

  /** 一段对话的最近消息，供工作台渲染。 */
  async function readHistory(key, limit = 60) {
    const record = sessions.get(key)
    if (record === undefined) throw new Error(`unknown conversation key: ${key}`)
    const directory = sessionDirectory(record)
    if (directory === undefined) return { messages: [] }
    const file = path.join(directory, record.sessionId, 'session.v4.jsonl.zstd')
    const exists = await fs.access(file).then(() => true, () => false)
    if (!exists) return { messages: [] }

    const text = decodeFrames(await fs.readFile(file))
    const messages = []
    for (const line of text.split('\n')) {
      if (line === '') continue
      let event
      try {
        event = JSON.parse(line)
      } catch {
        continue
      }
      if (event.type === 'user/message') {
        const message = event.data?.message ?? event.data
        // 只显示真人说的话：客户（channel）和管理员（admin）。
        // time-context 之类的运行时快照虽然也是 user/message，但不是对话内容。
        const origin = message?.source?.kind
        if (origin !== 'channel' && origin !== 'admin') continue
        const content = Array.isArray(message?.content) ? message.content : []
        const body = content.filter(block => block?.type === 'text').map(block => block.text).join('\n')
        const images = [...body.matchAll(/\[图片 \d+\] 已保存：(\S+)/g)].map(match => match[1])
        const clean = body
          .replace(/^\[群成员 [^\]]+\] /, '')
          .replace(/\[图片 \d+\][^\n]*/g, '')
          .replace(/需要读其中的文字时调用 ocr_image。/g, '')
          .trim()
        if (clean === '' && images.length === 0) continue
        const kind = origin === 'admin' ? 'admin' : 'customer'
        messages.push({
          role: 'user',
          kind,
          text: clean,
          at: event.time ?? null,
          senderId: message?.source?.senderId ?? null,
          senderName: message?.source?.senderName ?? null,
          ...(images.length === 0 ? {} : { images }),
        })
      } else if (event.type === 'assistant/message') {
        const content = event.data?.message?.content
        if (!Array.isArray(content)) continue
        const body = content.filter(block => block?.type === 'text').map(block => block.text).join('\n')
        if (body === '') continue
        messages.push({ role: 'assistant', kind: 'ai', text: body, at: event.time ?? null })
      }
    }
    return { messages: messages.slice(-limit) }
  }

  /** 读取会话文件头里的 cwd；读不到返回 undefined。 */
  async function readSessionCwd(file) {
    try {
      const handle = await fs.open(file, 'r')
      try {
        const buffer = Buffer.alloc(256 * 1024)
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
        const head = buffer.subarray(0, bytesRead)
        const text = zstdDecompressSync(head).toString('utf8')
        const line = text.split('\n')[0]
        const header = JSON.parse(line)
        return typeof header.cwd === 'string' ? header.cwd : undefined
      } finally {
        await handle.close()
      }
    } catch {
      return undefined
    }
  }

  /** 磁盘上有、但没挂到任何工作区的会话，按 cwd 分组。 */
  async function listOrphans() {
    const workspaces = ctx.workspaceRegistry?.list?.() ?? []
    const attached = new Set(workspaces.flatMap(workspace => [...workspace.sessionIds]))
    const groups = new Map()
    let scanned = 0
    let dirs = []
    try {
      dirs = await fs.readdir(sessionsRoot)
    } catch {
      return { orphans: [], scanned: 0 }
    }
    for (const dir of dirs) {
      const full = path.join(sessionsRoot, dir)
      let entries = []
      try {
        entries = await fs.readdir(full)
      } catch {
        continue
      }
      for (const sessionId of entries) {
        if (!/^(chan|ops)-/.test(sessionId) || attached.has(sessionId)) continue
        scanned += 1
        const cwd = await readSessionCwd(path.join(full, sessionId, 'session.v4.jsonl.zstd'))
        const key = cwd ?? '(无法读取 cwd)'
        const group = groups.get(key) ?? { path: key, sessions: [] }
        group.sessions.push(sessionId)
        groups.set(key, group)
      }
    }
    return { orphans: [...groups.values()], scanned }
  }

  /** 把一个已存在的目录重新登记为工作区，孤儿会话就能回到侧边栏。 */
  async function restoreWorkspace(target) {
    const resolved = requireAbsolute(target, 'path')
    const exists = await fs.stat(resolved).then(item => item.isDirectory(), () => false)
    if (!exists) {
      throw new Error(`目录不存在：${resolved}。先在新位置重建该目录，或运行迁移工具。`)
    }
    const workspace = await ctx.workspaceRegistry.create(resolved)
    await workspace.setTitle(path.basename(resolved))
    return { path: resolved, id: workspace.id, sessions: workspace.sessionIds.length }
  }

  /** 给一个会话起个人能看懂的备注名。 */
  async function setLabel(key, label) {
    await load()
    const record = sessions.get(key)
    if (record === undefined) throw new Error(`unknown conversation key: ${key}`)
    record.label = typeof label === 'string' && label.trim() !== '' ? label.trim() : null
    await persist(record)
    // 会话标题跟着备注走，侧边栏和面板显示一致。
    if (record.label !== null) await renameSession(key, `${record.label} · #${record.token}`)
    return { key, label: record.label, title: record.title }
  }

  /** 机器人进程状态：优先问适配器的 /health。 */
  async function adapterStatus() {
    let running = false
    let detail
    try {
      const response = await fetch(adapterHealth, { signal: AbortSignal.timeout(2000) })
      running = response.ok
      detail = await response.json().catch(() => undefined)
    } catch (error) {
      detail = { error: error.cause?.code ?? error.name }
    }
    return { configured: adapterCommand !== undefined, running, health: detail }
  }

  /** 启停机器人：只允许固定命令的 start/stop。 */
  async function adapterAction(action) {
    if (adapterCommand === undefined) throw new Error('adapter control is not configured (adapterCommand)')
    if (action !== 'start' && action !== 'stop') throw new Error('action must be start or stop')
    const { stdout, stderr } = await runCommand(adapterCommand, [action], { timeout: 30_000 })
    return { action, stdout: stdout.trim(), stderr: stderr.trim(), ...(await adapterStatus()) }
  }

  /** 管理员直接把话发给客户，不经过模型。 */
  async function adminReply(key, text, mention) {
    await load()
    const record = sessions.get(key)
    if (record === undefined) throw new Error(`unknown conversation key: ${key}`)
    if (typeof text !== 'string' || text.trim() === '') throw new Error('reply text must be non-empty')
    // 写进会话日志：工作台能看到，交还 AI 后模型也知道人说过什么。
    // inject 不唤醒模型，所以不会触发自动回复。
    try {
      const agent = ctx.agents.get(record.sessionId)
        ?? (await ctx.agents.resume({ resumeSessionId: record.sessionId })).agent
      agent.inject?.({
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text }],
        source: { kind: 'admin', channel: record.channel, summary: 'admin reply' },
      })
    } catch (error) {
      warn(`channel-gateway: could not record admin reply: ${error.message}`)
    }
    const delivery = await emit(key, text, mention)
    return { key, sent: true, ...delivery }
  }

  /** Minimal HTTP surface; the platform adapter is the only intended caller. */
  async function handleHttp(req, res) {
    try {
      // 读接口也要先把映射从磁盘载入：否则重启后第一条消息之前面板是空的。
      const url = new URL(req.url ?? '/', 'http://localhost')
      const access = auth.classify(req, url, route)
      if (!access.allowed) {
        // 面板是给人用浏览器打开的：返回一个能输入令牌的页面，而不是 401 JSON。
        // 401 与 403 要分开：前者是"没凭证/凭证错"，后者是"凭证对但权限不够"。
        // 都返回 401 会让只读用户以为自己的令牌写错了，一遍遍重试。
        const status = access.status ?? 401
        if (req.method === 'GET' && url.pathname === `${route}/panel`) return sendPanelLogin(res, route)
        if (status === 403) {
          return sendJson(res, 403, { error: 'forbidden', code: 'FORBIDDEN', reason: access.reason ?? 'read-only token' })
        }
        return sendJson(res, 401, { error: 'unauthorized', code: 'UNAUTHORIZED' })
      }
      await load()
      if (access.setCookie === true && url.pathname === `${route}/panel`) {
        // 首次带 ?token= 打开面板：换成 cookie 再跳转，令牌就不会留在地址栏和历史里。
        res.writeHead?.(302, { location: `${route}/panel`, 'set-cookie': auth.cookieHeader(route, access.role === 'viewer' ? 'viewer' : 'admin') })
        res.end?.('')
        return
      }
      if (req.method === 'POST' && url.pathname === route) {
        const body = await readJson(req)
        const result = await inbound(body)
        return sendJson(res, result.duplicate === true ? 200 : 202, result)
      }
      // 面板靠它决定"要不要显示删除/重放这些按钮"。服务端已经拦了，但这个接口
      // 让界面不用猜：拿着只读令牌却看到满屏可点的删除按钮，是最糟的体验。
      if (req.method === 'GET' && url.pathname === `${route}/whoami`) {
        const readonly = access.role !== 'admin'
        return sendJson(res, 200, {
          mode: auth.mode,
          role: access.role,
          via: access.via ?? null,
          readonly,
          // 全开模式下"只读"没有意义，如实告诉界面：这里谁都能写。
          reason: access.reason ?? null,
        })
      }
      if (req.method === 'GET' && url.pathname === `${route}/sessions`) {
        const includeArchived = url.searchParams.get('all') === '1'
        return sendJson(res, 200, {
          sessions: [...sessions.values()]
            .filter(record => includeArchived || record.archivedAt === undefined)
            .sort(byRecentActivity),
        })
      }
      if (req.method === 'POST' && url.pathname === `${route}/archive`) {
        const body = await readJson(req)
        return sendJson(res, 200, await setArchived(body?.key, body?.archived === true))
      }
      if (req.method === 'POST' && url.pathname === `${route}/delete`) {
        const body = await readJson(req)
        return sendJson(res, 200, await deleteConversation(body?.key))
      }
      if (req.method === 'GET' && url.pathname === `${route}/config`) {
        return sendJson(res, 200, await getConfig())
      }
      if (req.method === 'POST' && url.pathname === `${route}/config`) {
        const body = await readJson(req)
        return sendJson(res, 200, await saveConfig(body))
      }
      if (req.method === 'POST' && url.pathname === `${route}/config/test`) {
        return sendJson(res, 200, await testCredentials())
      }
      if (req.method === 'GET' && url.pathname === `${route}/image`) {
        const requested = url.searchParams.get('path')
        if (typeof requested !== 'string' || requested === '' || imageDir === undefined) {
          return sendJson(res, 404, { error: 'image not found' })
        }
        const root = path.resolve(imageDir)
        const resolved = path.resolve(requested)
        if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
          return sendJson(res, 403, { error: 'path is outside the image directory' })
        }
        const bytes = await fs.readFile(resolved).catch(() => undefined)
        if (bytes === undefined) return sendJson(res, 404, { error: 'image not found' })
        res.writeHead(200, {
          'content-type': mimeOf(resolved),
          'cache-control': 'private, max-age=300',
        })
        res.end(bytes)
        return
      }
      if (req.method === 'GET' && url.pathname === `${route}/history`) {
        const key = url.searchParams.get('key')
        const limit = Number(url.searchParams.get('limit') ?? 60)
        if (typeof key !== 'string' || key === '') {
          return sendJson(res, 400, { error: 'key is required' })
        }
        return sendJson(res, 200, await readHistory(key, Number.isFinite(limit) ? limit : 60))
      }
      if (req.method === 'GET' && url.pathname === `${route}/orphans`) {
        return sendJson(res, 200, await listOrphans())
      }
      if (req.method === 'POST' && url.pathname === `${route}/orphans/restore`) {
        const body = await readJson(req)
        return sendJson(res, 200, await restoreWorkspace(body?.path))
      }
      if (req.method === 'GET' && url.pathname === `${route}/adapter`) {
        return sendJson(res, 200, await adapterStatus())
      }
      if (req.method === 'POST' && url.pathname === `${route}/adapter/start`) {
        return sendJson(res, 200, await adapterAction('start'))
      }
      if (req.method === 'POST' && url.pathname === `${route}/adapter/stop`) {
        return sendJson(res, 200, await adapterAction('stop'))
      }
      if (req.method === 'POST' && url.pathname === `${route}/label`) {
        const body = await readJson(req)
        return sendJson(res, 200, await setLabel(body?.key, body?.label))
      }
      if (req.method === 'GET' && url.pathname === `${route}/health`) {
        const report = await health()
        return sendJson(res, report.ok ? 200 : 503, report)
      }
      if (req.method === 'GET' && url.pathname === `${route}/alerts`) {
        // 告警状态与最近记录。读接口，只读令牌也能看得到——值班的人需要它。
        const size = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 20), 1), 100)
        return sendJson(res, 200, { status: alerts.status(), entries: alerts.list(size) })
      }
      if (req.method === 'GET' && url.pathname === `${route}/status`) {
        const list = [...sessions.values()].filter(record => record.archivedAt === undefined)
        return sendJson(res, 200, {
          ok: true,
          conversations: list.filter(item => item.channel !== 'eval').length,
          ai: list.filter(item => item.channel !== 'eval' && item.mode !== 'human').length,
          human: list.filter(item => item.channel !== 'eval' && item.mode === 'human').length,
          eval: list.filter(item => item.channel === 'eval').length,
          preset: agentPreset,
          // 队列积压直接反映"收下了但还没处理完"，值得和会话数放一起看。
          inbox: await statSafely(inbox),
          ...(outbox === undefined ? {} : { outbox: await statSafely(outbox) }),
          paths: {
            privateWorkspace,
            groupWorkspace,
            evalWorkspace: evalWorkspace ?? null,
            dataFile,
            imageDir: imageDir ?? null,
            imageMode,
          },
        })
      }
      if (req.method === 'GET' && url.pathname === `${route}/panel`) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(panelHtml(route))
        return
      }
      // Drop one conversation's mapping (or all) so the next message starts a
      // fresh session. Needed because a session keeps the preset revision it
      // was created with, so a preset fix never reaches an existing session.
      if (req.method === 'POST' && url.pathname === `${route}/mode`) {
        const body = await readJson(req)
        return sendJson(res, 200, await setMode(body?.key, body?.mode))
      }
      if (req.method === 'POST' && url.pathname === `${route}/reply`) {
        const body = await readJson(req)
        return sendJson(res, 200, await adminReply(body?.key, body?.text, body?.mention))
      }
      if (req.method === 'POST' && url.pathname === `${route}/reset`) {
        const body = await readJson(req)
        const removed = []
        const drop = (key) => {
          const record = sessions.get(key)
          if (record === undefined) return
          sessions.delete(key)
          bySession.delete(record.sessionId)
          pending.delete(record.sessionId)
          removed.push(key)
        }
        if (body?.all === true) {
          for (const key of [...sessions.keys()]) drop(key)
        } else if (typeof body?.key === 'string' && body.key !== '') {
          drop(body.key)
        } else {
          return sendJson(res, 400, { error: 'reset needs { key } or { all: true }' })
        }
        if (removed.length > 0) {
          for (const key of removed) await store.remove(key)
        }
        return sendJson(res, 200, { removed })
      }
      if (req.method === 'GET' && url.pathname === `${route}/messages`) {
        // 会话历史：面板和工单排障都从这儿看，不再去翻 DSH 的会话目录。
        const key = url.searchParams.get('key')
        if (key === null || key === '') return sendJson(res, 400, { error: 'key is required' })
        const limit = Number(url.searchParams.get('limit') ?? 50)
        const messages = await store.listMessages(key, Number.isFinite(limit) && limit > 0 ? Math.min(limit, 500) : 50)
        return sendJson(res, 200, { key, messages })
      }
      if (req.method === 'GET' && url.pathname === `${route}/usage`) {
        // 用量与成本：老板问"这个月花了多少"，这里要能答。
        // 成本是**写入时**按当时的价格算好存下来的，不是读的时候乘出来的 ——
        // 否则一调价，历史报表全变，对不上账。
        const days = Number(url.searchParams.get('days') ?? 30)
        const window = Number.isFinite(days) && days > 0 ? Math.min(days, 365) : 30
        const key = url.searchParams.get('key')
        const limit = Number(url.searchParams.get('limit') ?? 500)
        const rows = await store.listUsage({
          days: window,
          ...(key === null || key === '' ? {} : { key }),
          limit: Number.isFinite(limit) && limit > 0 ? Math.min(limit, 2000) : 500,
        })
        const totals = rows.reduce(
          (acc, row) => ({
            turns: acc.turns + row.turns,
            inputTokens: acc.inputTokens + row.inputTokens,
            outputTokens: acc.outputTokens + row.outputTokens,
            cacheReadTokens: acc.cacheReadTokens + row.cacheReadTokens,
            cacheWriteTokens: acc.cacheWriteTokens + row.cacheWriteTokens,
            costMicros: acc.costMicros + row.costMicros,
          }),
          { turns: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costMicros: 0 },
        )
        return sendJson(res, 200, {
          days: window,
          ...(key === null || key === '' ? {} : { key }),
          pricing: { configured: pricingReady(pricing), currency: pricing.currency },
          // 每行也给一份格式化好的 `cost`：面板不该自己再实现一遍换算。
          totals: { ...totals, cost: formatCost(totals.costMicros) },
          rows: rows.map(row => ({ ...row, cost: formatCost(row.costMicros) })),
        })
      }
      if (req.method === 'GET' && url.pathname === `${route}/retention`) {
        // 只读：永远算一遍计划，不写。
        return sendJson(res, 200, await runRetention({ dryRun: true }))
      }
      if (req.method === 'POST' && url.pathname === `${route}/retention`) {
        const body = await readJson(req)
        return sendJson(res, 200, await runRetention(body ?? {}))
      }
      if (req.method === 'GET' && url.pathname === `${route}/dead`) {
        // 死信：重试用尽、需要人看一眼的条目。两个队列都列，运维不用记参数。
        const limit = Number(url.searchParams.get('limit') ?? 50)
        const size = Number.isFinite(limit) && limit > 0 ? Math.min(limit, 200) : 50
        return sendJson(res, 200, {
          inbox: await inbox.listDead(size),
          ...(outbox === undefined ? {} : { outbox: await outbox.listDead(size) }),
        })
      }
      if (req.method === 'POST' && url.pathname === `${route}/replay`) {
        // 人工重放：把死信放回队列。不给 ids 就重放当前全部死信。
        const body = await readJson(req)
        const queueName = body?.queue ?? 'outbox'
        return sendJson(res, 200, await replayDead(queueName, body?.ids, body?.actor))
      }
      if (req.method === 'GET' && url.pathname === `${route}/audit`) {
        const limit = Number(url.searchParams.get('limit') ?? 50)
        return sendJson(res, 200, {
          entries: await audit.list(Number.isFinite(limit) && limit > 0 ? Math.min(limit, 500) : 50),
        })
      }
      if (req.method === 'GET' && url.pathname === `${route}/inbox`) {
        // 运维排查用：看还有哪些消息收下了没处理完。
        const limit = Number(url.searchParams.get('limit') ?? 50)
        return sendJson(res, 200, {
          items: await inbox.list(Number.isFinite(limit) ? limit : 50),
          delivery: await statSafely(inbox),
        })
      }
      if (req.method === 'GET' && url.pathname === `${route}/outbox` && outboxFile !== undefined) {
        const lines = await readTail(outboxFile, Number(url.searchParams.get('limit') ?? 50))
        // delivery 是"还欠什么"：pending/failed/dead 的条数与最早该重发的时间。
        // 只读审计日志看不出来有没有回复没发出去，面板和排障需要这个。
        const delivery = outbox === undefined ? undefined : await outbox.stats()
        return sendJson(res, 200, {
          messages: lines.map(line => JSON.parse(line)),
          ...(delivery === undefined ? {} : { delivery }),
        })
      }
      return sendJson(res, 404, { error: 'not found' })
    } catch (error) {
      if (error.code === 'BAD_QUEUE') {
        return sendJson(res, 400, { error: error.message, code: error.code })
      }
      if (error.code === 'LEASE_LOST') {
        return sendJson(res, 503, { error: error.message, code: error.code })
      }
      if (error.code === 'RATE_LIMITED') {
        res.setHeader?.('retry-after', String(error.retryAfter ?? 60))
        return sendJson(res, 429, { error: error.message, retryAfter: error.retryAfter })
      }
      warn(`channel-gateway: ${error.message}`)
      return sendJson(res, 400, { error: error.message })
    }
  }

  return {
    route,
    inbound,
    observe,
    handleHttp,
    auth,
    setMode,
    adminReply,
    setLabel,
    adapterStatus,
    listOrphans,
    restoreWorkspace,
    readHistory,
    setArchived,
    deleteConversation,
    sessions,
    store,
    health,
    outbox,
    pricing,
    listMessages: (key, limit) => store.listMessages(key, limit),
    listUsage: query => store.listUsage(query),
    flushArchives,
    archiveMessage,
    replayDead,
    runRetention,
    runRetentionSweep,
    startRetentionWorker,
    stopRetentionWorker,
    retention: retentionState,
    audit,
    drainOutbox,
    inbox,
    drainInbox,
    processInbound,
    startOutboxWorker: startWorker,
    stopOutboxWorker: stopWorker,
    startWorker,
    stopWorker,
    alerts,
    checkAlerts,
    startAlertWorker,
    stopAlertWorker,
  }
}

/** Validate and shape one platform message. */
function normalizeInbound(payload, maxAttachments) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('inbound payload must be an object')
  }
  const channel = requireText(payload.channel, 'channel')
  const senderId = requireText(payload.senderId, 'senderId')
  const attachments = normalizeAttachments(payload.attachments, maxAttachments)
  const text = typeof payload.text === 'string' ? payload.text.trim() : ''
  if (text === '' && attachments.length === 0) {
    throw new Error('inbound message needs text or at least one attachment')
  }
  const groupId = payload.groupId === undefined || payload.groupId === null || payload.groupId === ''
    ? undefined
    : requireText(payload.groupId, 'groupId')
  const groupName = typeof payload.groupName === 'string' && payload.groupName.trim() !== ''
    ? payload.groupName.trim()
    : undefined
  const senderName = typeof payload.senderName === 'string' && payload.senderName.trim() !== ''
    ? payload.senderName.trim()
    : undefined
  const messageId = payload.messageId === undefined || payload.messageId === null || payload.messageId === ''
    ? undefined
    : requireText(payload.messageId, 'messageId')
  return {
    channel,
    senderId,
    text,
    attachments,
    ...(groupId === undefined ? {} : { groupId }),
    ...(groupName === undefined ? {} : { groupName }),
    ...(senderName === undefined ? {} : { senderName }),
    ...(messageId === undefined ? {} : { messageId }),
  }
}

/** Accept either URLs or `{ url, mediaType?, name? }` objects. */
function normalizeAttachments(value, maxAttachments) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new Error('attachments must be an array')
  if (value.length > maxAttachments) throw new Error(`too many attachments (max ${maxAttachments})`)
  return value.map((item, index) => {
    if (typeof item === 'string') return { url: requireUrl(item, `attachments[${index}]`) }
    if (item === null || typeof item !== 'object') throw new Error(`attachments[${index}] must be a URL or object`)
    const url = requireUrl(item.url, `attachments[${index}].url`)
    const mediaType = typeof item.mediaType === 'string' ? item.mediaType.trim() : undefined
    const attachmentName = typeof item.name === 'string' ? item.name.trim() : undefined
    return {
      url,
      ...(mediaType === undefined || mediaType === '' ? {} : { mediaType }),
      ...(attachmentName === undefined || attachmentName === '' ? {} : { name: attachmentName }),
    }
  })
}

/** Short session title from the first message. */
/** key → 稳定的 6 位短码，写进会话标题，方便在 DSH 里搜到。 */
function tokenOf(key) {
  let hash = 0
  for (const ch of String(key)) hash = (hash * 31 + ch.codePointAt(0)) >>> 0
  return hash.toString(36).slice(0, 6).padStart(6, '0')
}

function titleFor(message, key) {
  const token = tokenOf(key)
  if (message.channel === 'eval') return `评测 · #${token}`
  if (message.groupId !== undefined) {
    return `群聊 · ${message.groupName ?? `群 ${message.groupId.slice(0, 6)}`} · #${token}`
  }
  return `私聊 · 客户 ${message.senderName ?? message.senderId.slice(0, 6)} · #${token}`
}

/** 客服工作台：两栏收件箱，左列表右对话。 */
function mimeOf(file) {
  const extension = file.slice(file.lastIndexOf('.')).toLowerCase()
  return { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' }[extension]
    ?? 'application/octet-stream'
}

/** Map a media type to a file extension. */
function extensionOf(mediaType) {
  if (mediaType === 'image/jpeg') return '.jpg'
  if (mediaType === 'image/webp') return '.webp'
  if (mediaType === 'image/gif') return '.gif'
  return '.png'
}

/** Join the text blocks of one assistant message. */
function textOf(content) {
  if (!Array.isArray(content)) return ''
  return content
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n')
    .trim()
}

/** Read a JSON request body with a hard size ceiling. */
async function readJson(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('request body too large')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') throw new Error('request body is empty')
  try {
    return JSON.parse(text)
  } catch {
    throw new Error('request body is not valid JSON')
  }
}

/** Return the last `limit` non-empty lines of a file. */
async function readTail(file, limit) {
  try {
    const raw = await fs.readFile(file, 'utf8')
    return raw.split('\n').filter(line => line.trim() !== '').slice(-Math.max(1, limit))
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
}

/**
 * Order conversations the way a person working the queue expects: whoever spoke
 * most recently is at the top. `lastSeenAt` moves on every inbound message, so a
 * customer who just wrote jumps to the front instead of sitting wherever the
 * conversation happened to be created. Timestamps that fail to parse sink to the
 * bottom rather than jumping the queue, and `key` keeps the order stable between
 * two records that share a timestamp.
 */
function byRecentActivity(left, right) {
  const leftAt = Date.parse(left?.lastSeenAt ?? left?.createdAt ?? '') || 0
  const rightAt = Date.parse(right?.lastSeenAt ?? right?.createdAt ?? '') || 0
  if (leftAt !== rightAt) return rightAt - leftAt
  return String(left?.key ?? '').localeCompare(String(right?.key ?? ''))
}

/** Write one JSON response. */
function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(body)
}

/**
 * 面板的登录页：一个纯 HTML 表单，GET 回 `{route}/panel?token=…`。
 *
 * 不用 JS：面板本身就是内联脚本，登录页再塞一段脚本就变成"两段脚本都要能跑"，
 * 而这段脚本平时根本不会被测试覆盖。表单是最笨也最不会坏的做法。
 */
function sendPanelLogin(res, route) {
  const body = `<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<title>需要访问令牌</title>
<style>body{font:14px/1.6 system-ui,sans-serif;margin:0;display:grid;place-items:center;height:100vh;background:#f6f7f9;color:#222}
form{background:#fff;padding:24px;border-radius:10px;box-shadow:0 2px 12px rgba(0,0,0,.08);width:280px}
h1{font-size:15px;margin:0 0 12px}input{width:100%;box-sizing:border-box;padding:8px;border:1px solid #ccd;border-radius:6px}
button{margin-top:12px;width:100%;padding:8px;border:0;border-radius:6px;background:#2b6cb0;color:#fff;cursor:pointer}
p{margin:12px 0 0;font-size:12px;color:#666}</style>
<form method="get" action="${route}/panel">
<h1>这个面板需要访问令牌</h1>
<input name="token" type="password" autofocus placeholder="token">
<button type="submit">进入</button>
<p>令牌配置在网关的 token / tokenFile 里，向运维索取。</p>
</form></html>`
  res.writeHead?.(401, { 'content-type': 'text/html; charset=utf-8' })
  res.end?.(body)
}

/** Require a non-empty string. */
function requireText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`channel-gateway: ${field} must be a non-empty string`)
  }
  return value.trim()
}

/** Require an absolute path. */
function requireAbsolute(value, field) {
  const text = requireText(value, field)
  if (!path.isAbsolute(text)) throw new Error(`channel-gateway: config.${field} must be absolute`)
  return text
}

/** Require an absolute route pathname. */
function requirePath(value) {
  const text = requireText(value, 'route')
  if (!text.startsWith('/') || text.endsWith('/')) {
    throw new Error('channel-gateway: config.route must be an absolute path without a trailing slash')
  }
  return text
}

/** Require an http(s) URL. */
function requireUrl(value, field = 'replyWebhook') {
  const text = requireText(value, field)
  if (!/^https?:\/\//i.test(text)) throw new Error(`channel-gateway: ${field} must be an http(s) URL`)
  return text
}

/** Positive integer config value or its default. */
function positiveInteger(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback
}
