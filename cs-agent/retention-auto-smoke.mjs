// 保留期自动清理的冒烟测试。
//
//   node cs-agent/retention-auto-smoke.mjs
//
// 这一层要回答四个问题：
//   1. 定时器真的会自己跑吗（不是只有端点，得有人记得点）；
//   2. 跑的时候删的是"该删的"吗（过期归档、过期清除，别的一律不动）；
//   3. 出事了会不会把进程带崩（租约丢了、库连不上）；
//   4. "数据真删了吗"这个问题，能不能只看一个字段就回答（`lastRunAt`）。
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createGateway } from './gateway.js'
import { resolveRetentionAuto } from './retention.js'

let failed = 0
const check = (ok, label, detail = '') => {
  if (!ok) failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail === '' ? '' : `: ${detail}`}`)
}
const tick = (ms = 60) => new Promise(resolve => setTimeout(resolve, ms))
const DAY = 86_400_000
const daysAgo = days => new Date(Date.now() - days * DAY).toISOString()

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-retention-auto-'))
const FAST_RETRY = { baseMs: 20, factor: 1, maxMs: 20, maxAttempts: 3, graceMs: 0, sweepMs: 60_000, leaseMs: 5000, jitter: false }

function fakeCtx(options = {}) {
  const live = new Map()
  const state = { followups: 0, injected: 0 }
  const makeAgent = id => ({ id, followup: () => { state.followups += 1 }, inject: () => { state.injected += 1 } })
  return {
    state,
    logger: { warn: options.warn ?? (() => {}) },
    workspaceRegistry: {
      list: () => [],
      create: async () => ({
        id: 'ws-1',
        sessionIds: [],
        attachSession: async () => {},
        detachSession: async () => {},
        setTitle: async () => {},
      }),
    },
    agentDefaultModel: { currentSelection: () => ({ provider: 'test', model: 'test-model' }) },
    agents: {
      async create(opts) {
        const agent = makeAgent(opts.sessionId)
        live.set(opts.sessionId, agent)
        return { agent }
      },
      get: id => live.get(id),
      async resume({ resumeSessionId }) {
        const agent = makeAgent(resumeSessionId)
        live.set(resumeSessionId, agent)
        return { agent }
      },
    },
    agentPresets: { async mount() {} },
    sessionTitle: { rename: async () => {} },
    on: () => () => {},
    effect: () => {},
  }
}

const resOf = () => ({ code: 0, body: '', writeHead(code) { this.code = code }, end(payload) { this.body = payload } })
const message = (extra = {}) => ({
  channel: 'qq',
  senderId: 'u-1',
  text: '这条会话很久没来了',
  messageId: `m-${Math.random().toString(36).slice(2, 10)}`,
  ...extra,
})

// --- 配置解析（纯函数）------------------------------------------------------
{
  const defaults = resolveRetentionAuto(undefined)
  check(defaults.enabled === false, 'config: the sweep is off by default (deleting needs a yes)')
  check(defaults.everyMs === 6 * 60 * 60 * 1000, 'config: once switched on it runs every six hours', String(defaults.everyMs))
  check(defaults.initialDelayMs === 60_000, 'config: once switched on it waits a minute before the first sweep', String(defaults.initialDelayMs))
  check(defaults.dryRun === false, 'config: once switched on it really deletes')

  check(resolveRetentionAuto({ enabled: true }).enabled === true, 'config: it can be switched on')
  check(resolveRetentionAuto({ enabled: false }).enabled === false, 'config: an explicit off stays off')
  check(resolveRetentionAuto({ everyMs: 1000 }).everyMs === 1000, 'config: the interval can be set')
  check(resolveRetentionAuto({ everyMs: -5 }).everyMs === 6 * 60 * 60 * 1000, 'config: a bad interval falls back to the default')
  check(resolveRetentionAuto({ initialDelayMs: 0 }).initialDelayMs === 0, 'config: the first sweep can start immediately')
  check(resolveRetentionAuto({ dryRun: true }).dryRun === true, 'config: a dry run is possible')
  check(resolveRetentionAuto('nonsense').enabled === false, 'config: a malformed block is treated as the default (off)')
}

// 造一个"很久没来过"的会话：入站建好之后把时间戳改老。
async function makeStale(gateway, { senderId, days, archivedDays }) {
  const result = await gateway.inbound(message({ senderId, messageId: `m-${senderId}` }))
  const record = gateway.sessions.get(result.key)
  record.lastSeenAt = daysAgo(days)
  if (archivedDays !== undefined) record.archivedAt = daysAgo(archivedDays)
  await gateway.store.save(record)
  return result.key
}

// --- 定时器自己会跑 ---------------------------------------------------------
{
  const workspace = path.join(temp, 'ws-timer')
  await fs.mkdir(workspace, { recursive: true })
  const ctx = fakeCtx()
  const gateway = createGateway(ctx, {
    route: '/timer',
    workspace,
    agentPreset: 'service-desk',
    dataFile: path.join(temp, 'timer-sessions.json'),
    inboxRetry: FAST_RETRY,
    retention: { privateArchiveDays: 30, privatePurgeDays: 90, groupArchiveDays: 3, groupPurgeDays: 30 },
    retentionAuto: { enabled: true, everyMs: 20, initialDelayMs: 0 },
  })

  check(gateway.retention.enabled === true, 'timer: the state reports it is enabled')
  check(gateway.retention.lastRunAt === undefined, 'timer: nothing has run yet')
  check(gateway.startRetentionWorker() === true, 'timer: the worker starts')
  check(gateway.startRetentionWorker() === false, 'timer: starting twice is a no-op')

  const key = await makeStale(gateway, { senderId: 'u-timer', days: 40 })
  await tick(120)
  const archived = gateway.sessions.get(key)?.archivedAt
  check(typeof archived === 'string', 'timer: an old conversation is archived without anyone clicking', String(archived))
  check(typeof gateway.retention.lastRunAt === 'string', 'timer: the last run time is recorded', String(gateway.retention.lastRunAt))
  // 定时器每 20ms 跑一轮，后面那些空转的轮次会把 lastResult 覆盖成 0，
  // 所以这里只验它跑过、字段齐；"数得对"由下面手动触发的那段断言。
  check(gateway.retention.lastResult?.dryRun === false, 'timer: the result records what kind of run it was', JSON.stringify(gateway.retention.lastResult))
  check(gateway.stopRetentionWorker() === true, 'timer: the worker stops')
  check(gateway.stopRetentionWorker() === false, 'timer: stopping twice is a no-op')

  const audit = await gateway.audit.list(20)
  const entry = audit.find(item => item.action === 'archive' && item.targetId === key)
  check(entry !== undefined, 'timer: the archive is written to the audit log')
  check(entry?.actor === 'schedule:tick', 'timer: the audit says a schedule did it, not a person', String(entry?.actor))
  check(entry?.role === 'system', 'timer: scheduled actions are recorded as system')

  // 健康检查里能看到"上次跑过"，这是运维唯一要看的一个字段。
  const res = resOf()
  await gateway.handleHttp({ method: 'GET', url: '/timer/health', headers: {} }, res)
  const health = JSON.parse(res.body)
  check(health.retention?.enabled === true && typeof health.retention?.lastRunAt === 'string', 'timer: health reports the sweep', JSON.stringify(health.retention))
}

// --- 清除：已归档且超过清除期 -----------------------------------------------
{
  const workspace = path.join(temp, 'ws-purge')
  await fs.mkdir(workspace, { recursive: true })
  const gateway = createGateway(fakeCtx(), {
    route: '/purge',
    workspace,
    agentPreset: 'service-desk',
    dataFile: path.join(temp, 'purge-sessions.json'),
    inboxRetry: FAST_RETRY,
    retention: { privateArchiveDays: 30, privatePurgeDays: 90, groupArchiveDays: 3, groupPurgeDays: 30 },
    retentionAuto: { enabled: true, everyMs: 60_000, initialDelayMs: 60_000 },
  })

  const key = await makeStale(gateway, { senderId: 'u-purge', days: 200, archivedDays: 150 })
  await gateway.store.saveMessage(key, { role: 'user', content: '这条会被删掉' })
  const result = await gateway.runRetentionSweep('test')
  check((result.purged ?? []).includes(key), 'purge: the expired archived conversation is purged', JSON.stringify(result.purged))
  check(gateway.sessions.get(key) === undefined, 'purge: the conversation is gone from memory')
  check((await gateway.store.listMessages(key, 10)).length === 0, 'purge: the messages are gone too')
  check(gateway.retention.lastResult?.purged >= 1, 'purge: the sweep records what it deleted', JSON.stringify(gateway.retention.lastResult))

  const audit = await gateway.audit.list(20)
  check(audit.some(item => item.action === 'purge' && item.targetId === key), 'purge: the deletion is written to the audit log')

  // 刚来过的不许动。这条断言防的是"把保留期算错、把活客户删了"。
  const fresh = await gateway.inbound(message({ senderId: 'u-fresh', messageId: 'm-fresh' }))
  await gateway.runRetentionSweep('test')
  check(gateway.sessions.get(fresh.key) !== undefined, 'purge: a conversation that is still in use is untouched')
}

// --- dry run：只说不做 ------------------------------------------------------
{
  const workspace = path.join(temp, 'ws-dry')
  await fs.mkdir(workspace, { recursive: true })
  const gateway = createGateway(fakeCtx(), {
    route: '/dry',
    workspace,
    agentPreset: 'service-desk',
    dataFile: path.join(temp, 'dry-sessions.json'),
    inboxRetry: FAST_RETRY,
    retention: { privateArchiveDays: 30, privatePurgeDays: 90, groupArchiveDays: 3, groupPurgeDays: 30 },
    retentionAuto: { enabled: true, everyMs: 60_000, initialDelayMs: 60_000, dryRun: true },
  })
  const key = await makeStale(gateway, { senderId: 'u-dry', days: 200, archivedDays: 150 })
  const result = await gateway.runRetentionSweep('test')
  check(result.dryRun === true, 'dry run: the result says it was a dry run')
  check(gateway.sessions.get(key) !== undefined, 'dry run: nothing is actually deleted')
  check(gateway.retention.lastResult?.dryRun === true, 'dry run: the state records it')
}

// --- 租约丢了就停手 ---------------------------------------------------------
{
  const workspace = path.join(temp, 'ws-lease')
  await fs.mkdir(workspace, { recursive: true })
  const warnings = []
  const dataFile = path.join(temp, 'lease-sessions.json')
  const retention = { privateArchiveDays: 30, privatePurgeDays: 90, groupArchiveDays: 3, groupPurgeDays: 30 }
  const retentionAuto = { enabled: true, everyMs: 60_000, initialDelayMs: 60_000 }

  // 先把"该被删的会话"造好：这一步需要能写，所以用正常网关。
  const healthy = createGateway(fakeCtx(), { route: '/lease', workspace, agentPreset: 'service-desk', dataFile, inboxRetry: FAST_RETRY, retention, retentionAuto })
  const key = await makeStale(healthy, { senderId: 'u-lease', days: 200, archivedDays: 150 })

  // 再让一个"租约已被别人接管"的网关读同一份数据：这时删数据就是删别人的。
  const lease = { kind: 'postgres', lost: true }
  const guarded = createGateway(fakeCtx({ warn: text => warnings.push(text) }), { route: '/lease2', workspace, agentPreset: 'service-desk', dataFile, inboxRetry: FAST_RETRY, retention, retentionAuto }, { lease })

  const result = await guarded.runRetentionSweep('test')
  check(typeof result.error === 'string' && result.error.includes('write lease was taken over'), 'lease lost: the sweep refuses to write', String(result.error))
  check(guarded.sessions.get(key) !== undefined, 'lease lost: no data is deleted')
  check(guarded.retention.lastError !== undefined, 'lease lost: the failure is recorded in the state')
  check(warnings.some(text => text.includes('scheduled retention failed')), 'lease lost: the failure is logged')

  const started = guarded.startRetentionWorker()
  check(started === true, 'lease lost: the worker can still be started (it checks at tick time)')
  guarded.stopRetentionWorker()
}

// --- 一次只跑一轮 -----------------------------------------------------------
{
  const workspace = path.join(temp, 'ws-busy')
  await fs.mkdir(workspace, { recursive: true })
  const gateway = createGateway(fakeCtx(), {
    route: '/busy',
    workspace,
    agentPreset: 'service-desk',
    dataFile: path.join(temp, 'busy-sessions.json'),
    inboxRetry: FAST_RETRY,
    retention: { privateArchiveDays: 30, privatePurgeDays: 90, groupArchiveDays: 3, groupPurgeDays: 30 },
    retentionAuto: { enabled: true, everyMs: 60_000, initialDelayMs: 60_000 },
  })
  await makeStale(gateway, { senderId: 'u-busy', days: 40 })
  // 让落盘变慢，制造"上一轮还没跑完"。
  const original = gateway.store.flush.bind(gateway.store)
  gateway.store.flush = async () => {
    await tick(80)
    return original()
  }
  const first = gateway.runRetentionSweep('test')
  await tick(10)
  const second = await gateway.runRetentionSweep('test')
  check(second.skipped === 'busy', 'busy: a second sweep while one is running is skipped', JSON.stringify(second))
  await first
  gateway.store.flush = original
}

// --- 关掉就真的不跑 ---------------------------------------------------------
{
  const workspace = path.join(temp, 'ws-off')
  await fs.mkdir(workspace, { recursive: true })
  const gateway = createGateway(fakeCtx(), {
    route: '/off',
    workspace,
    agentPreset: 'service-desk',
    dataFile: path.join(temp, 'off-sessions.json'),
    inboxRetry: FAST_RETRY,
    retention: { privateArchiveDays: 30, privatePurgeDays: 90, groupArchiveDays: 3, groupPurgeDays: 30 },
    retentionAuto: { enabled: false, everyMs: 20, initialDelayMs: 0 },
  })
  const key = await makeStale(gateway, { senderId: 'u-off', days: 40 })
  check(gateway.startRetentionWorker() === false, 'off: the worker refuses to start when disabled')
  // 默认配置（连 retentionAuto 都不写）必须也是关的：升级部署不该自己开始删数据。
  const byDefault = createGateway(fakeCtx(), {
    route: '/default',
    workspace,
    agentPreset: 'service-desk',
    dataFile: path.join(temp, 'default-sessions.json'),
    inboxRetry: FAST_RETRY,
  })
  check(byDefault.retention.enabled === false, 'off: a gateway that never mentions retentionAuto stays off')
  check(byDefault.startRetentionWorker() === false, 'off: and its worker will not start either')
  await tick(120)
  check(gateway.sessions.get(key)?.archivedAt === undefined, 'off: nothing is archived when disabled')
  check(gateway.retention.lastRunAt === undefined, 'off: no run is recorded')
}

if (failed > 0) {
  console.error(`\n${failed} retention auto check(s) failed`)
  process.exit(1)
}
console.log('\nall retention auto checks passed')
