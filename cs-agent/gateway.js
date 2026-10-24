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
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { zstdDecompressSync } from 'node:zlib'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import { defaultPaths } from './paths.js'
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
  const lockPath = `${dataFile}.lock`
  mkdirSync(path.dirname(lockPath), { recursive: true })
  const take = () => {
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }))
    return () => rmSync(lockPath, { force: true })
  }
  try {
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), { flag: 'wx' })
    return () => rmSync(lockPath, { force: true })
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
  }
  let holder = {}
  try {
    holder = JSON.parse(readFileSync(lockPath, 'utf8'))
  } catch {
    holder = {}
  }
  if (Number.isSafeInteger(holder.pid) && isAlive(holder.pid)) {
    throw new Error(
      `channel-gateway: data dir already in use by pid ${holder.pid} (${lockPath}); `
      + 'use a separate dataFile for each dsh instance',
    )
  }
  // 上一个进程崩了，接管它的锁。
  return take()
}

/** 进程是否还活着。 */
function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Register the gateway on the host's HTTP server.
 * @param ctx - host context carrying the web server and agent services.
 * @param config - deployment configuration for routing and reply delivery.
 */
export function apply(ctx, config) {
  // 两个 dsh 进程共用同一个数据目录会互相覆盖会话映射，启动即拦下。
  const release = acquireDataLock(requireText(config?.dataFile, 'dataFile'))
  let gateway
  try {
    gateway = createGateway(ctx, config)
  } catch (error) {
    release()
    throw error
  }
  const disposer = ctx.webServer.register({
    kind: 'prefix',
    path: gateway.route,
    handler: (req, res) => gateway.handleHttp(req, res),
  })
  ctx.effect(() => disposer, 'channel-gateway: route')
  ctx.effect(() => () => release(), 'channel-gateway: data lock')
  ctx.effect(() => {
    const off = ctx.on('session/event', (session, event) => gateway.observe(session, event))
    return typeof off === 'function' ? off : undefined
  }, 'channel-gateway: observe')
}

/**
 * Build the gateway core. Exported so tests can drive it without a Host.
 * @param ctx - context exposing agents, presets, the web server, and events.
 * @param config - validated deployment configuration.
 */
export function createGateway(ctx, config) {
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
  const dataFile = requireAbsolute(config?.dataFile ?? path.join(paths.data, 'sessions.json'), 'dataFile')
  const seenFile = `${dataFile.replace(/\.json$/, '')}-seen.json`
  const outboxFile = config?.outbox === undefined
    ? path.join(paths.data, 'outbox.jsonl')
    : requireAbsolute(config.outbox, 'outbox')
  const replyWebhook = config?.replyWebhook === undefined ? undefined : requireUrl(config.replyWebhook)
  const forward = config?.forward === 'all' ? 'all' : 'final'
  const token = typeof config?.token === 'string' && config.token !== '' ? config.token : undefined
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

  /** key -> one session record; loaded lazily and rewritten on change. */
  const sessions = new Map()
  /** platform message id -> received-at ISO string, bounded FIFO. */
  const seen = new Map()
  /** key -> in-flight creation, so two simultaneous messages share one session. */
  const creating = new Map()
  /** sessionId -> key, for routing assistant messages back out. */
  const bySession = new Map()
  /** sessionId -> assistant text buffered for the current turn. */
  const pending = new Map()
  /** sessionId -> 本轮触发者，用于群聊自动 @。 */
  const turnSender = new Map()
  /** key -> recent message timestamps, in-memory only. */
  const rate = new Map()
  let loaded = false

  async function load() {
    if (loaded) return
    loaded = true
    const records = await readJsonFile(dataFile)
    for (const [key, record] of Object.entries(records ?? {})) {
      if (typeof record?.sessionId === 'string') {
        sessions.set(key, record)
        bySession.set(record.sessionId, key)
      }
    }
    const ids = await readJsonFile(seenFile)
    if (Array.isArray(ids)) {
      for (const entry of ids) {
        if (Array.isArray(entry) && typeof entry[0] === 'string') seen.set(entry[0], String(entry[1] ?? ''))
      }
    }
  }

  async function persist() {
    await writeJsonFile(dataFile, Object.fromEntries(sessions))
  }

  /** Persist the dedupe window, dropping the oldest ids past the configured bound. */
  async function persistSeen() {
    while (seen.size > dedupeLimit) {
      const oldest = seen.keys().next().value
      seen.delete(oldest)
    }
    await writeJsonFile(seenFile, [...seen.entries()])
  }

  /** 从所有工作区摘掉一个会话。 */
  async function detachWorkspace(sessionId) {
    // 无条件调用：工作区的 sessionIds 会按 cwd 过滤，失效会话可能不在里面，
    // 但登记里仍然残留着这个 id。
    for (const workspace of ctx.workspaceRegistry?.list?.() ?? []) {
      try {
        await workspace.detachSession(sessionId)
      } catch (error) {
        ctx.logger?.warn?.(`channel-gateway: detach failed: ${error.message}`)
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
    await persist()
    return { key, archived: record.archivedAt !== undefined }
  }

  /** 彻底删除：会话文件、映射、工作区引用。 */
  async function deleteConversation(key) {
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
    await persist()
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
    await persist()
    const agent = ctx.agents.get(record.sessionId)
    if (agent !== undefined) {
      try {
        ctx.sessionTitle?.rename?.(agent.session, title)
      } catch (error) {
        ctx.logger?.warn?.(`channel-gateway: title rename failed: ${error.message}`)
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
      ctx.logger?.warn?.(`channel-gateway: workspace attach failed: ${error.message}`)
    }
  }

  /** Resolve or create the session for one conversation key. */
  async function ensureSession(key, payload, title) {
    const existing = sessions.get(key)
    if (existing !== undefined) {
      if (existing.archivedAt !== undefined) {
        delete existing.archivedAt
        await persist()
        await attachWorkspace(existing.sessionId, payload)
      }
      const live = ctx.agents.get(existing.sessionId)
      if (live !== undefined) return live
      try {
        const resumed = await ctx.agents.resume({ resumeSessionId: existing.sessionId })
        return resumed.agent
      } catch (error) {
        // 会话文件可能已经被清理掉：丢掉坏映射，重建一个，而不是让整个会话报错。
        ctx.logger?.warn?.(
          `channel-gateway: cannot resume ${existing.sessionId}, starting fresh: ${error.message}`,
        )
        sessions.delete(key)
        bySession.delete(existing.sessionId)
        pending.delete(existing.sessionId)
        await persist()
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
      await persist()
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

  /** Deliver one inbound message. */
  async function inbound(payload) {
    await load()
    const message = normalizeInbound(payload, maxAttachments)
    const key = message.groupId === undefined
      ? `${message.channel}:${message.senderId}`
      : groupScope === 'sender'
        ? `${message.channel}:${message.groupId}:${message.senderId}`
        : `${message.channel}:group:${message.groupId}`

    if (message.messageId !== undefined && seen.has(message.messageId)) {
      return { key, duplicate: true, sessionId: sessions.get(key)?.sessionId ?? null }
    }
    checkRate(key)

    const { blocks: imageBlocks, notes: imageNotes } = await admitImages(message.attachments)
    const agent = await ensureSession(key, message, titleFor(message, key))
    const record = sessions.get(key)
    if (record !== undefined) {
      record.lastSeenAt = new Date().toISOString()
      record.lastSenderId = message.senderId
      if (message.groupName !== undefined) record.groupName = message.groupName
      if (message.senderName !== undefined) record.senderName = message.senderName
      await persist()
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
        form: 'notice',
        summary: `${message.channel} message from ${message.senderId}`,
      },
    }
    // 人工接管中：只把客户消息写进会话给管理员看，不唤醒模型。
    if (record?.mode === 'human') {
      agent.inject?.(userMessage)
      if (message.messageId !== undefined) {
        seen.set(message.messageId, new Date().toISOString())
        await persistSeen()
      }
      return { key, duplicate: false, held: true, sessionId: agent.id }
    }
    agent.followup(userMessage)
    if (message.messageId !== undefined) {
      seen.set(message.messageId, new Date().toISOString())
      await persistSeen()
    }
    return { key, duplicate: false, sessionId: agent.id }
  }

  /** Forward one assistant message to the platform adapter. */
  async function emit(key, text, mention, route) {
    if (text.trim() === '') return
    const record = route ?? sessions.get(key)
    const envelope = {
      key,
      channel: record?.channel ?? 'unknown',
      groupId: record?.groupId ?? null,
      senderId: record?.senderId ?? null,
      text,
      ...(typeof mention === 'string' && mention !== '' ? { mention } : {}),
      at: new Date().toISOString(),
    }
    // The outbox is written even when a webhook is configured: it is the audit
    // trail, and a dead adapter must not silently swallow customer replies.
    if (outboxFile !== undefined) {
      await fs.mkdir(path.dirname(outboxFile), { recursive: true })
      await fs.appendFile(outboxFile, `${JSON.stringify(envelope)}\n`, 'utf8')
    }
    if (replyWebhook !== undefined) {
      try {
        const response = await fetch(replyWebhook, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(envelope),
        })
        if (!response.ok) {
          const detail = await response.json().catch(() => ({}))
          ctx.logger?.warn?.(`channel-gateway: reply webhook returned ${response.status}`)
          return { delivered: false, error: detail.error ?? `HTTP ${response.status}` }
        }
        return { delivered: true }
      } catch (error) {
        ctx.logger?.warn?.(`channel-gateway: reply webhook failed: ${error.message}`)
        return { delivered: false, error: error.message }
      }
    }
    // 没有 webhook 时只写 outbox，视为已投递到本地。
    return { delivered: true }
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
      return
    }

    if (event.type === 'assistant/message') {
      const text = textOf(event.data?.message?.content)
      if (text === '') return
      if (forward === 'all') {
        void emit(key, text)
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
      const sender = turnSender.get(sessionId)
      turnSender.delete(sessionId)
      const record = sessions.get(key)
      const mention = record?.groupId !== undefined && groupMention ? sender : undefined
      if (buffer !== undefined && buffer.length > 0) {
        void emit(key, buffer.join('\n\n'), mention)
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
          ctx.logger?.warn?.(`channel-gateway: preset drift on ${key}, resetting the conversation`)
          sessions.delete(key)
          bySession.delete(sessionId)
          void persist()
        }
        void emit(key, FALLBACK_REPLY, mention, fallback)
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
    await persist()
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
    await persist()
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
      ctx.logger?.warn?.(`channel-gateway: could not record admin reply: ${error.message}`)
    }
    const delivery = await emit(key, text, mention)
    return { key, sent: true, ...delivery }
  }

  /** Minimal HTTP surface; the platform adapter is the only intended caller. */
  async function handleHttp(req, res) {
    try {
      if (token !== undefined) {
        const header = req.headers?.authorization ?? ''
        if (header !== `Bearer ${token}`) return sendJson(res, 401, { error: 'unauthorized' })
      }
      // 读接口也要先把映射从磁盘载入：否则重启后第一条消息之前面板是空的。
      await load()
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (req.method === 'POST' && url.pathname === route) {
        const body = await readJson(req)
        const result = await inbound(body)
        return sendJson(res, result.duplicate === true ? 200 : 202, result)
      }
      if (req.method === 'GET' && url.pathname === `${route}/sessions`) {
        const includeArchived = url.searchParams.get('all') === '1'
        return sendJson(res, 200, {
          sessions: [...sessions.values()].filter(record => includeArchived || record.archivedAt === undefined),
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
      if (req.method === 'GET' && url.pathname === `${route}/status`) {
        const list = [...sessions.values()].filter(record => record.archivedAt === undefined)
        return sendJson(res, 200, {
          ok: true,
          conversations: list.filter(item => item.channel !== 'eval').length,
          ai: list.filter(item => item.channel !== 'eval' && item.mode !== 'human').length,
          human: list.filter(item => item.channel !== 'eval' && item.mode === 'human').length,
          eval: list.filter(item => item.channel === 'eval').length,
          preset: agentPreset,
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
        if (removed.length > 0) await persist()
        return sendJson(res, 200, { removed })
      }
      if (req.method === 'GET' && url.pathname === `${route}/outbox` && outboxFile !== undefined) {
        const lines = await readTail(outboxFile, Number(url.searchParams.get('limit') ?? 50))
        return sendJson(res, 200, { messages: lines.map(line => JSON.parse(line)) })
      }
      return sendJson(res, 404, { error: 'not found' })
    } catch (error) {
      if (error.code === 'RATE_LIMITED') {
        res.setHeader?.('retry-after', String(error.retryAfter ?? 60))
        return sendJson(res, 429, { error: error.message, retryAfter: error.retryAfter })
      }
      ctx.logger?.warn?.(`channel-gateway: ${error.message}`)
      return sendJson(res, 400, { error: error.message })
    }
  }

  return { route, inbound, observe, handleHttp, setMode, adminReply, setLabel, adapterStatus, listOrphans, restoreWorkspace, readHistory, setArchived, deleteConversation, sessions }
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
function panelHtml(route) {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>客服工作台</title>
<style>
  :root {
    color-scheme: light dark;
    --bg:#fff; --panel:#fafafa; --line:#e6e6e6; --text:#1a1a1a; --muted:#8a8a8a;
    --accent:#2563eb; --sel:#eef2ff; --in:#f2f2f2; --ai:#e8f0fe; --admin:#e6f7ec; --danger:#c33;
  }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#101010; --panel:#171717; --line:#2a2a2a; --text:#e9e9e9; --muted:#8f8f8f;
      --accent:#60a5fa; --sel:#1e293b; --in:#1f1f1f; --ai:#1c2b45; --admin:#15301f; }
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body { margin:0; height:100vh; overflow:hidden; background:var(--bg); color:var(--text);
    font: 14px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  .app { display:flex; height:100vh; }
  .side { width:320px; min-width:240px; border-right:1px solid var(--line); display:flex; flex-direction:column; background:var(--panel); }
  .side-top { padding:14px 16px 10px; border-bottom:1px solid var(--line); }
  .title { font-size:15px; font-weight:600; display:flex; align-items:center; gap:8px; }
  .dot { width:8px; height:8px; border-radius:50%; background:var(--muted); }
  .dot.on { background:#22c55e; }
  .side-actions { display:flex; gap:6px; margin-top:10px; }
  .filters { display:flex; gap:6px; padding:10px 16px; border-bottom:1px solid var(--line); align-items:center; }
  .search { flex:1; font:inherit; font-size:12.5px; padding:5px 9px; border-radius:7px;
    border:1px solid var(--line); background:var(--bg); color:inherit; outline:none; }
  .search:focus { border-color:var(--accent); }
  .bulk[hidden] { display:none; }
  .bulk { display:flex; gap:6px; align-items:center; padding:8px 16px; border-bottom:1px solid var(--line);
    font-size:12px; color:var(--muted); background:var(--sel); }
  .pick { margin:2px 0 0; accent-color:var(--accent); }
  .item.archived { opacity:.55; }
  .chip { font:inherit; font-size:12px; padding:3px 10px; border-radius:999px; border:1px solid var(--line);
    background:transparent; color:inherit; cursor:pointer; opacity:.75; }
  .chip.active { background:var(--sel); border-color:transparent; opacity:1; }
  .list { flex:1; overflow:auto; }
  .item { display:flex; gap:10px; padding:11px 16px; cursor:pointer; border-bottom:1px solid var(--line); }
  .item:hover { background:var(--sel); }
  .item.active { background:var(--sel); }
  .avatar { width:34px; height:34px; border-radius:50%; flex:none; display:flex; align-items:center; justify-content:center;
    font-size:13px; font-weight:600; color:#fff; }
  .item-body { min-width:0; flex:1; }
  .item-name { display:flex; justify-content:space-between; gap:8px; align-items:baseline; }
  .item-name b { font-weight:600; font-size:13.5px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .item-name time { font-size:11px; color:var(--muted); flex:none; }
  .item-sub { font-size:12px; color:var(--muted); display:flex; gap:6px; align-items:center; margin-top:2px; }
  .tag { font-size:11px; padding:0 7px; border-radius:999px; border:1px solid var(--line); }
  .tag.human { color:#b45309; border-color:#f59e0b55; background:#f59e0b14; }
  .side-foot { padding:10px 16px; border-top:1px solid var(--line); font-size:12px; color:var(--muted);
    display:flex; justify-content:space-between; align-items:center; gap:8px; }
  main { flex:1; display:flex; flex-direction:column; min-width:0; min-height:0; }
  /* 嵌在设置面板里时列宽会变窄：会话列表收成上半屏，对话留出空间。 */
  @media (max-width: 700px) {
    .app { flex-direction:column; }
    .side { width:auto; min-width:0; max-height:42vh; border-right:0; border-bottom:1px solid var(--line); }
  }
  #pane { flex:1; display:flex; flex-direction:column; min-height:0; }
  .thread-top { padding:12px 20px; border-bottom:1px solid var(--line); display:flex; align-items:center; gap:10px;
    position:sticky; top:0; z-index:3; background:var(--bg); }
  .thread-top .who { font-weight:600; }
  .thread-top .sub { font-size:12px; color:var(--muted); }
  .spacer { flex:1; }
  .btn { font:inherit; font-size:12px; padding:4px 12px; border-radius:7px; border:1px solid var(--line);
    background:transparent; color:inherit; cursor:pointer; }
  .btn:hover { background:var(--sel); }
  .btn.primary { background:var(--accent); border-color:transparent; color:#fff; }
  .btn:disabled { opacity:.45; cursor:default; }
  .messages { flex:1; min-height:0; overflow:auto; padding:22px 24px; display:flex; flex-direction:column; gap:10px; }
  .bubble { max-width:72%; padding:9px 13px; border-radius:14px; white-space:pre-wrap; word-break:break-word; }
  .bubble.customer { align-self:flex-start; background:var(--in); border-bottom-left-radius:4px; }
  .bubble.ai { align-self:flex-end; background:var(--ai); border-bottom-right-radius:4px; }
  .bubble.admin { align-self:flex-end; background:var(--admin); border-bottom-right-radius:4px; }
  .bubble .meta { font-size:10.5px; color:var(--muted); margin-top:4px; }
  .bubble .shot { display:block; max-width:320px; max-height:240px; border-radius:8px; margin-top:6px; cursor:zoom-in; }
  .composer { display:flex; gap:8px; padding:14px 20px; border-top:1px solid var(--line); }
  .composer input { flex:1; font:inherit; padding:9px 13px; border-radius:9px; border:1px solid var(--line);
    background:var(--bg); color:inherit; outline:none; }
  .composer input:focus { border-color:var(--accent); }
  .empty { margin:auto; text-align:center; color:var(--muted); font-size:13px; line-height:1.9; }
  .empty b { display:block; color:var(--text); font-size:14px; margin-bottom:4px; }
  .hint { font-size:12px; color:var(--muted); padding:0 20px 12px; }
  .btn.mini { font-size:10.5px; padding:0 6px; margin-left:6px; border-radius:5px; }
  .mention { align-self:center; font-size:12px; color:var(--muted); display:flex; align-items:center; gap:6px; }
  .card { margin:24px auto; width:min(520px, 100%); display:flex; flex-direction:column; gap:14px; }
  .field { display:flex; flex-direction:column; gap:6px; font-size:12px; color:var(--muted); }
  .field input { font:inherit; font-size:13px; padding:8px 11px; border-radius:8px; border:1px solid var(--line);
    background:var(--bg); color:var(--text); outline:none; }
  .field input:focus { border-color:var(--accent); }
  .card .row { display:flex; gap:8px; align-items:center; }
  .kv { font-size:12px; color:var(--muted); display:grid; grid-template-columns: 92px 1fr; gap:4px 10px; }
  .kv code { font-size:11.5px; word-break:break-all; }
  a { color:var(--accent); }
</style></head>
<body>
<div class="app">
  <aside class="side">
    <div class="side-top">
      <div class="title"><span class="dot" id="bot-dot"></span>客服工作台</div>
      <div class="side-actions">
        <button class="btn" id="bot-toggle">启动</button>
        <button class="btn" id="refresh">刷新</button>
        <button class="btn" id="config-open" title="QQ 凭证">配置</button>
      </div>
    </div>
    <div class="filters">
      <input id="search" class="search" placeholder="搜索群名 / 客户 id / 备注">
    </div>
    <div class="filters">
      <button class="chip active" data-filter="all">全部</button>
      <button class="chip" data-filter="human">人工</button>
      <button class="chip" data-filter="ai">自动</button>
      <span class="spacer"></span>
      <label class="chip"><input type="checkbox" id="show-archived"> 归档</label>
    </div>
    <div class="bulk" id="bulk" hidden></div>
    <div class="list" id="list"></div>
    <div class="side-foot">
      <span id="summary">—</span>
      <a href="#" id="orphan-link">孤儿 0</a>
    </div>
  </aside>
  <main>
    <div id="pane"></div>
  </main>
</div>
<script>
const BASE = ${JSON.stringify(route)}
const state = { records: [], selected: null, messages: [], filter: 'all', bot: null, status: null, orphans: [], view: 'thread',
  query: '', showArchived: false, picked: new Set(), config: null }
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]))
const el = id => document.getElementById(id)

async function api(path, body) {
  const res = await fetch(BASE + path, body === undefined ? {} : {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? res.status)
  return res.json().catch(() => ({}))
}

function ago(iso) {
  if (!iso) return ''
  const diff = Date.now() - new Date(iso).getTime()
  const m = Math.floor(diff / 60000)
  if (m < 1) return '刚刚'
  if (m < 60) return m + ' 分钟前'
  const h = Math.floor(m / 60)
  if (h < 24) return h + ' 小时前'
  return Math.floor(h / 24) + ' 天前'
}

function color(name) {
  let hash = 0
  for (const ch of String(name)) hash = (hash * 31 + ch.codePointAt(0)) % 360
  return 'hsl(' + hash + ', 52%, 48%)'
}

function displayName(record) {
  if (record.label) return record.label
  if (record.groupId) return record.groupName || '群 ' + record.groupId.slice(0, 6)
  if (record.senderName) return record.senderName
  return '客户 ' + String(record.key).split(':').pop().slice(0, 6)
}

function visible() {
  const query = state.query.trim().toLowerCase()
  return state.records.filter(r => {
    if (!state.showArchived && r.archivedAt) return false
    if (state.filter === 'human' && r.mode !== 'human') return false
    if (state.filter === 'ai' && r.mode === 'human') return false
    if (query === '') return true
    const haystack = [displayName(r), r.key, r.senderId, r.groupId, r.groupName, r.label]
      .filter(Boolean).join(' ').toLowerCase()
    return haystack.includes(query)
  })
}

function renderList() {
  const rows = visible()
  el('list').innerHTML = rows.length === 0
    ? '<div class="empty" style="padding:32px 16px">还没有客户会话</div>'
    : rows.map(r => {
        const name = displayName(r)
        const human = r.mode === 'human'
        return '<div class="item' + (r.key === state.selected ? ' active' : '') + (r.archivedAt ? ' archived' : '')
          + '" data-key="' + esc(r.key) + '">'
          + '<input type="checkbox" class="pick" data-pick="' + esc(r.key) + '"' + (state.picked.has(r.key) ? ' checked' : '') + '>'
          + '<div class="avatar" style="background:' + color(name) + '">' + esc(name.slice(0, 1)) + '</div>'
          + '<div class="item-body"><div class="item-name"><b>' + esc(name) + '</b><time>' + ago(r.lastSeenAt) + '</time></div>'
          + '<div class="item-sub">' + (r.groupId ? '群聊' : '私聊')
          + ' <span class="tag ' + (human ? 'human' : '') + '">' + (human ? '人工' : '自动') + '</span>'
          + (r.token ? ' <span class="tag" title="点击复制完整标题，DSH 里搜它" data-copy="'
              + esc(r.title ?? '') + '">#' + esc(r.token) + '</span>' : '')
          + '</div>'
          + '</div></div>'
      }).join('')
}

function renderThread() {
  const pane = el('pane')
  const previous = el('reply')
  const draft = previous?.value ?? ''
  const focused = previous !== null && document.activeElement === previous
  const caret = previous?.selectionStart ?? draft.length
  if (state.view === 'orphans') {
    pane.innerHTML = '<div class="thread-top"><span class="who">孤儿会话</span><span class="spacer"></span>'
      + '<button class="btn" id="back">返回</button></div>'
      + '<div class="messages">' + (state.orphans.length === 0
        ? '<div class="empty"><b>没有孤儿会话</b>磁盘上的会话都挂在某个工作区里</div>'
        : state.orphans.map(o => '<div class="bubble customer">' + esc(o.path) + '<div class="meta">' + o.sessions.length
            + ' 个会话 <button class="btn" data-restore="' + esc(o.path) + '">恢复工作区</button></div></div>').join(''))
      + '</div>'
    return
  }
  if (state.view === 'config') {
    const cfg = state.config
    pane.innerHTML = '<div class="thread-top"><span class="who">配置</span><span class="spacer"></span>'
      + '<button class="btn" id="back">返回</button></div>'
      + '<div class="messages"><div class="card">'
      + '<div class="field">QQ AppID<input id="cfg-appid" value="' + esc(cfg?.appId ?? '') + '" placeholder="填你的 AppID"></div>'
      + '<div class="field">QQ AppSecret<input id="cfg-secret" type="password" placeholder="'
      + (cfg?.hasSecret ? '已配置，留空不修改' : '首次配置必填') + '"></div>'
      + '<div class="row"><button class="btn primary" id="cfg-save">保存</button>'
      + '<button class="btn" id="cfg-test">测试连接</button>'
      + '<span class="meta">保存后需要重启机器人</span></div>'
      + '<div class="kv"><span>凭证文件</span><code>' + esc(cfg?.envFile ?? '') + '</code>'
      + '<span>数据目录</span><code>' + esc(cfg?.paths?.data ?? '') + '</code>'
      + '<span>知识库</span><code>' + esc(cfg?.paths?.kb ?? '') + '</code>'
      + '<span>适配器</span><code>' + esc(cfg?.paths?.adapter ?? '') + '</code></div>'
      + '</div></div>'
    return
  }
  const record = state.records.find(r => r.key === state.selected)
  if (record === undefined) {
    pane.innerHTML = '<div class="empty"><b>选择左侧会话</b>接管后可以直接回复客户</div>'
    return
  }
  const name = displayName(record)
  const human = record.mode === 'human'
  const bubbles = state.messages.length === 0
    ? '<div class="empty">还没有消息</div>'
    : state.messages.map(m => {
        const who = m.kind === 'customer' && record.groupId
          ? (m.senderName ? '客户 ' + m.senderName : '客户 ' + String(m.senderId ?? '').slice(0, 6))
          : ''
        const replyTo = m.kind === 'customer' && record.groupId && m.senderId
          ? '<button class="btn mini" data-reply-to="' + esc(m.senderId) + '">回复</button>'
          : ''
        const shots = (m.images ?? []).map(file =>
          '<img class="shot" loading="lazy" src="' + BASE + '/image?path=' + encodeURIComponent(file) + '">').join('')
        return '<div class="bubble ' + m.kind + '">' + (m.text === '' ? '' : esc(m.text)) + shots
          + (who === '' && replyTo === '' ? '' : '<div class="meta">' + esc(who) + replyTo + '</div>') + '</div>'
      }).join('')
  pane.innerHTML = '<div class="thread-top">'
    + '<div class="avatar" style="background:' + color(name) + '">' + esc(name.slice(0, 1)) + '</div>'
    + '<div><div class="who">' + esc(name) + '</div><div class="sub">'
    + '<span class="tag ' + (human ? 'human' : '') + '">' + (human ? '人工接管中' : 'AI 自动回复') + '</span></div></div>'
    + '<span class="spacer"></span>'
    + '<button class="btn" data-act="label">备注</button>'
    + '<button class="btn primary" data-act="mode">' + (human ? '交还 AI' : '接管') + '</button>'
    + '</div>'
    + '<div class="messages" id="messages">' + bubbles + '</div>'
    + (human
      ? '<div class="composer">'
        + (state.mention ? '<span class="mention">@' + esc(String(state.mention).slice(0, 6))
            + '<button class="btn mini" data-clear-mention>×</button></span>' : '')
        + '<input id="reply" placeholder="回复客户…"><button class="btn primary" id="send">发送</button></div>'
      : '<div class="hint">接管后才能直接回复。AI 自动回复期间，你的消息会被忽略。</div>')
  const next = el('reply')
  if (next !== null) {
    next.value = draft
    if (focused) {
      next.focus()
      try { next.setSelectionRange(caret, caret) } catch { /* 忽略 */ }
    }
  }
  const messages = el('messages')
  if (messages) messages.scrollTop = messages.scrollHeight
}

function renderBulk() {
  const bulk = el('bulk')
  if (state.picked.size === 0) {
    bulk.hidden = true
    bulk.innerHTML = ''
    return
  }
  bulk.hidden = false
  bulk.innerHTML = '<span>已选 ' + state.picked.size + '</span><span class="spacer"></span>'
    + '<button class="btn mini" data-bulk="archive">归档</button>'
    + '<button class="btn mini" data-bulk="restore">取消归档</button>'
    + '<button class="btn mini" data-bulk="delete">删除</button>'
}

async function loadList() {
  const [list, status, bot] = await Promise.all([
    api('/sessions' + (state.showArchived ? '?all=1' : '')), api('/status'), api('/adapter'),
  ])
  state.records = list.sessions ?? []
  state.status = status
  state.bot = bot
  el('bot-dot').className = 'dot' + (bot.running ? ' on' : '')
  el('bot-toggle').textContent = bot.running ? '停止' : '启动'
  el('summary').textContent = (status.conversations ?? 0) + ' 个会话 · 人工 ' + (status.human ?? 0)
  renderList()
  renderBulk()
}

async function loadHistory() {
  if (state.selected === null) return
  const body = await api('/history?key=' + encodeURIComponent(state.selected))
  state.messages = body.messages ?? []
}

let lastSignature = ''
function signature() {
  const last = state.messages[state.messages.length - 1]
  const record = state.records.find(r => r.key === state.selected)
  return [state.selected, state.view, state.messages.length, last?.at ?? '',
    record?.mode ?? '', record?.label ?? '', record?.archivedAt ?? ''].join('|')
}

async function refresh() {
  try {
    await loadList()
    if (state.selected !== null) await loadHistory()
    const next = signature()
    if (next !== lastSignature) {
      lastSignature = next
      renderThread()
    }
  } catch (error) {
    console.warn('refresh failed:', error.message)
  }
}

document.addEventListener('click', async event => {
  const copy = event.target.closest('[data-copy]')
  if (copy !== null) {
    const text = copy.dataset.copy
    if (text) {
      try { await navigator.clipboard.writeText(text); copy.textContent = '已复制' } catch { /* 忽略 */ }
      setTimeout(() => { copy.textContent = '#' + (text.match(/#(\w+)$/)?.[1] ?? '') }, 1200)
    }
    return
  }
  const pick = event.target.closest('[data-pick]')
  if (pick !== null) {
    const key = pick.dataset.pick
    if (state.picked.has(key)) state.picked.delete(key)
    else state.picked.add(key)
    renderList()
    renderBulk()
    return
  }
  const bulk = event.target.closest('[data-bulk]')
  if (bulk !== null) {
    const keys = [...state.picked]
    const action = bulk.dataset.bulk
    if (action === 'delete' && !confirm('删除 ' + keys.length + ' 个会话？会话记录会被永久删除。')) return
    const failedToDetach = []
    for (const key of keys) {
      try {
        if (action === 'delete') {
          const result = await api('/delete', { key })
          if (result.detached === false) failedToDetach.push(key)
        } else {
          await api('/archive', { key, archived: action === 'archive' })
        }
      } catch (error) { alert(error.message) }
    }
    if (failedToDetach.length > 0) {
      alert('已删除 ' + keys.length + ' 条，但 ' + failedToDetach.length + ' 条没能从侧边栏摘掉，刷新页面后再看。')
    }
    state.picked.clear()
    if (keys.includes(state.selected) && action === 'delete') state.selected = null
    await refresh()
    renderThread()
    return
  }
  const item = event.target.closest('.item')
  if (item !== null) {
    state.selected = item.dataset.key
    state.view = 'thread'
    state.messages = []
    state.mention = null
    renderList()
    renderThread()
    try { await loadHistory(); renderThread() } catch (error) { alert(error.message) }
    return
  }
  const replyTo = event.target.closest('[data-reply-to]')
  if (replyTo !== null) {
    state.mention = replyTo.dataset.replyTo
    renderThread()
    el('reply')?.focus()
    return
  }
  if (event.target.closest('[data-clear-mention]') !== null) {
    state.mention = null
    renderThread()
    return
  }
  const chip = event.target.closest('.chip')
  if (chip !== null) {
    state.filter = chip.dataset.filter
    for (const node of document.querySelectorAll('.chip')) node.classList.toggle('active', node === chip)
    renderList()
    return
  }
  const restore = event.target.closest('[data-restore]')
  if (restore !== null) {
    try { await api('/orphans/restore', { path: restore.dataset.restore }); alert('已登记为工作区，重启 dsh 后生效') }
    catch (error) { alert(error.message) }
    return
  }
  const act = event.target.closest('[data-act]')
  if (act !== null) {
    const record = state.records.find(r => r.key === state.selected)
    if (record === undefined) return
    const human = record.mode === 'human'
    try {
      if (act.dataset.act === 'mode') await api('/mode', { key: record.key, mode: human ? 'ai' : 'human' })
      if (act.dataset.act === 'label') {
        const text = prompt('备注名（留空清除）：')
        if (text === null) return
        await api('/label', { key: record.key, label: text })
      }
      await refresh()
    } catch (error) { alert(error.message) }
    return
  }
  if (event.target.id === 'back') { state.view = 'thread'; renderThread(); return }
  if (event.target.id === 'orphan-link') {
    event.preventDefault()
    try { const body = await api('/orphans'); state.orphans = body.orphans ?? []; state.view = 'orphans'; renderThread() }
    catch (error) { alert(error.message) }
    return
  }
  if (event.target.id === 'bot-toggle') {
    try { await api('/adapter/' + (state.bot.running ? 'stop' : 'start'), {}); await refresh() }
    catch (error) { alert(error.message) }
    return
  }
  if (event.target.id === 'refresh') { await refresh(); return }
  if (event.target.id === 'config-open') {
    try { state.config = await api('/config'); state.view = 'config'; renderThread() }
    catch (error) { alert(error.message) }
    return
  }
  if (event.target.id === 'cfg-save') {
    const appId = el('cfg-appid').value.trim()
    const appSecret = el('cfg-secret').value.trim()
    try {
      await api('/config', { appId, appSecret })
      alert('已保存。重启机器人后生效。')
      state.config = await api('/config')
      renderThread()
    } catch (error) { alert(error.message) }
    return
  }
  if (event.target.id === 'cfg-test') {
    try { const result = await api('/config/test', {}); alert('连接成功，token 有效期 ' + (result.expiresIn ?? '?') + ' 秒') }
    catch (error) { alert('连接失败：' + error.message) }
    return
  }
  if (event.target.id === 'send') {
    const input = el('reply')
    const text = input.value.trim()
    if (text === '') return
    const body = { key: state.selected, text }
    if (state.mention) body.mention = state.mention
    try {
      const result = await api('/reply', body)
      input.value = ''
      state.mention = null
      if (result.delivered === false) {
        alert('消息没送到客户：' + (result.error ?? '未知原因') + ' — QQ 只允许在客户最后一条消息后 5 分钟内被动回复。')
      }
      await refresh()
    } catch (error) { alert(error.message) }
  }
})

document.addEventListener('click', event => {
  if (event.target.classList?.contains('shot')) window.open(event.target.src, '_blank', 'noopener')
})
document.getElementById('search').addEventListener('input', event => {
  state.query = event.target.value
  renderList()
})
document.getElementById('show-archived').addEventListener('change', async event => {
  state.showArchived = event.target.checked
  await loadList()
  renderThread()
})
document.addEventListener('keydown', event => {
  if (event.key === 'Enter' && event.target.id === 'reply') {
    event.preventDefault()
    el('send')?.click()
  }
})

const preselect = new URLSearchParams(location.search).get('key')
if (preselect) { state.selected = preselect; state.view = 'thread' }
refresh().then(async () => {
  if (preselect) {
    try { await loadHistory(); renderThread() } catch (error) { console.warn(error.message) }
  }
})
setInterval(() => { void refresh() }, 5000)
</script>
</body></html>`
}

/** Map a file extension to a response content type. */
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

/** Read one JSON file, treating a missing file as empty. */
async function readJsonFile(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
}

/** Write one JSON file atomically. */
async function writeJsonFile(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const temp = `${file}.${randomUUID()}.tmp`
  await fs.writeFile(temp, `${JSON.stringify(value, undefined, 2)}\n`, 'utf8')
  await fs.rename(temp, file)
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

/** Write one JSON response. */
function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(body)
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
