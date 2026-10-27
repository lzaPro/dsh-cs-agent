// 告警冒烟测试：/health 能查 ≠ 有人会看。
//
//   node cs-agent/alerts-smoke.mjs
//
// 四组：
//   1. 纯函数：什么时候算"有问题"、什么时候该报、什么时候不重复报、什么时候说恢复；
//   2. 发送器：配了 webhook 真的发出去、发失败只记不炸、没配也留记录；
//   3. 网关集成：不健康时推一条、持续不健康不刷屏、恢复时推一条；
//   4. 端点：`/alerts` 能读到状态与历史，`/health` 带上告警摘要。
import { promises as fs } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { createAlerter, collectIssues, evaluateAlerts, formatAlert, parseAlertConfig, DEFAULT_ALERTS } from './alerts.js'
import { createGateway } from './gateway.js'

let failed = 0
const check = (ok, label, detail = '') => {
  if (!ok) failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail === '' ? '' : `: ${detail}`}`)
}

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-alerts-'))
const FAST_RETRY = { baseMs: 10, factor: 1, maxMs: 10, maxAttempts: 2, graceMs: 0, sweepMs: 60_000, leaseMs: 0, jitter: false }

function fakeCtx(options = {}) {
  const live = new Map()
  const state = { followups: 0, injected: 0, warnings: [] }
  const makeAgent = id => ({ id, followup: () => { state.followups += 1 }, inject: () => { state.injected += 1 } })
  return {
    state,
    logger: { warn: text => state.warnings.push(text) },
    workspaceRegistry: {
      list: () => [],
      create: async () => ({ sessionIds: [], attachSession: async () => {}, detachSession: async () => {}, setTitle: async () => {} }),
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

const resOf = () => ({ code: 0, body: '', headers: {}, writeHead(code, headers) { this.code = code; this.headers = headers ?? {} }, end(payload) { this.body = payload } })

/** 起一个假适配器：记下收到的每条告警，可以指定前几次失败。 */
async function alertServer(failTimes = 0) {
  const received = []
  let remaining = failTimes
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      if (remaining > 0) {
        remaining -= 1
        res.writeHead(503)
        res.end('nope')
        return
      }
      received.push(JSON.parse(body))
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"ok":true}')
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return { server, received, url: `http://127.0.0.1:${server.address().port}/reply`, control: { get failTimes() { return remaining }, set failTimes(value) { remaining = value } } }
}

const unhealthy = {
  ok: false,
  checks: [
    { name: 'lease', ok: false, detail: 'postgres (taken over)' },
    { name: 'inbox', ok: true, detail: '0 pending, 0 dead' },
  ],
  queues: { inbox: { pending: 0, dead: 0 }, outbox: null },
  retention: { lastError: null },
}

const healthy = {
  ok: true,
  checks: [{ name: 'lease', ok: true, detail: 'postgres' }],
  queues: { inbox: { pending: 1, dead: 0 }, outbox: { pending: 0, dead: 0 } },
  retention: {},
}

// ---------------------------------------------------------------- 配置解析
{
  const off = parseAlertConfig(undefined)
  check(off.enabled === false && off.missing === 'alertWebhook', 'alerts are off without any config', JSON.stringify(off.missing))

  const half = parseAlertConfig({ alertWebhook: 'http://x' })
  check(half.enabled === false && half.missing === 'alertTo', 'a webhook without a recipient stays off (do not guess who to page)', JSON.stringify(half.missing))

  const noWebhook = parseAlertConfig({ alertTo: 'admin' })
  check(noWebhook.enabled === false && noWebhook.missing === 'alertWebhook', 'a recipient without a webhook stays off', JSON.stringify(noWebhook.missing))

  const full = parseAlertConfig({ alertWebhook: 'http://x', alertTo: 'admin' })
  check(full.enabled === true && full.missing === undefined, 'both fields together enable alerts')
  check(full.intervalMs === DEFAULT_ALERTS.intervalMs && full.repeatMs === DEFAULT_ALERTS.repeatMs, 'defaults are used for the timers', JSON.stringify({ intervalMs: full.intervalMs, repeatMs: full.repeatMs }))

  const custom = parseAlertConfig({ alertWebhook: 'http://x', alertTo: 'admin', alertIntervalMs: 5000, alertRepeatMs: 60_000, alertGraceMs: 0 })
  check(custom.intervalMs === 5000 && custom.repeatMs === 60_000 && custom.graceMs === 0, 'timers can be overridden')

  // repeatMs = 0 是合法值：每一轮自检都重报（值班盯屏时想要的效果）。
  const everyRound = parseAlertConfig({ alertWebhook: 'http://x', alertTo: 'admin', alertRepeatMs: 0 })
  check(everyRound.repeatMs === 0, 'a zero repeat interval means every round', String(everyRound.repeatMs))

  const broken = parseAlertConfig({ alertWebhook: 'http://x', alertTo: 'admin', alertIntervalMs: -5, alertRepeatMs: 'soon', alertGraceMs: -1 })
  check(broken.intervalMs === DEFAULT_ALERTS.intervalMs && broken.repeatMs === DEFAULT_ALERTS.repeatMs && broken.graceMs === DEFAULT_ALERTS.graceMs, 'bad timer values fall back to defaults', JSON.stringify(broken))
}

// ---------------------------------------------------------------- 问题收集
{
  check(collectIssues(healthy).length === 0, 'a healthy report has no issues')

  const lease = collectIssues(unhealthy)
  check(lease.length === 1 && lease[0].key === 'check:lease', 'a failed check becomes one issue', JSON.stringify(lease.map(item => item.key)))
  check(lease[0].severity === 'critical', 'a lost lease is critical', lease[0].severity)
  check(lease[0].action.includes('重启'), 'the issue says what to do', lease[0].action)

  const db = collectIssues({ ok: false, checks: [{ name: 'database', ok: false, detail: 'ECONNREFUSED' }], queues: { inbox: {} }, retention: {} })
  check(db[0].severity === 'critical' && db[0].detail === 'ECONNREFUSED', 'a dead database is critical and keeps the detail', JSON.stringify(db[0]))

  const queueError = collectIssues({ ok: false, checks: [{ name: 'inbox', ok: false, detail: 'disk full' }], queues: {}, retention: {} })
  check(queueError[0].severity === 'warning', 'a broken queue is a warning, not critical', queueError[0].severity)

  // 死信不是"网关挂了"（health.ok 可能仍为 true），但必须有人处理。
  const dead = collectIssues({ ok: true, checks: [], queues: { inbox: { dead: 2 }, outbox: { dead: 1 } }, retention: {} })
  check(dead.length === 2, 'dead letters are reported per queue', String(dead.length))
  check(dead.some(item => item.key === 'dead:inbox' && item.title.includes('2')), 'the dead letter count is in the title', JSON.stringify(dead.map(item => item.title)))
  check(dead.every(item => item.severity === 'warning'), 'dead letters are a warning')

  const retention = collectIssues({ ok: true, checks: [], queues: { inbox: {} }, retention: { lastError: 'permission denied', lastRunAt: '2026-01-02T00:00:00.000Z' } })
  check(retention.length === 1 && retention[0].key === 'retention', 'a failed retention sweep is reported', JSON.stringify(retention[0]))
  check(retention[0].action.includes('2026-01-02'), 'the retention issue says when it failed', retention[0].action)

  // 同一份报告里既有检查失败又有死信：都要报，且 key 不冲突。
  const mixed = collectIssues({ ok: false, checks: [{ name: 'lease', ok: false, detail: 'x' }], queues: { inbox: { dead: 1 } }, retention: { lastError: 'y' } })
  check(mixed.length === 3 && new Set(mixed.map(item => item.key)).size === 3, 'issues from different sources do not collide', JSON.stringify(mixed.map(item => item.key)))
}

// ---------------------------------------------------------------- 去重与恢复
{
  const issues = collectIssues(unhealthy)
  const now = 1_000_000
  const first = evaluateAlerts({ issues, state: new Map(), now, repeatMs: 60_000 })
  check(first.fire.length === 1 && first.fire[0].reason === 'new', 'a new issue fires', JSON.stringify(first.fire[0]?.reason))
  check(first.active.length === 1, 'the issue is remembered as active')

  // 同一个问题，隔了 10 秒（小于 repeatMs）：不报。否则每分钟一条，手机一直响。
  const second = evaluateAlerts({ issues, state: first.state, now: now + 10_000, repeatMs: 60_000 })
  check(second.fire.length === 0 && second.recover.length === 0, 'a still-broken issue does not fire again before repeatMs', `${second.fire.length}/${second.recover.length}`)

  // 过了 repeatMs：再提醒一次，但仍然算同一个问题（since 不变）。
  const third = evaluateAlerts({ issues, state: second.state, now: now + 70_000, repeatMs: 60_000 })
  check(third.fire.length === 1 && third.fire[0].reason === 'repeat', 'a long-running issue is repeated after repeatMs', JSON.stringify(third.fire[0]?.reason))
  check(third.fire[0].since === now, 'the repeat keeps the original start time', String(third.fire[0]?.since))

  // 恢复了：报恢复，并从活跃列表里摘掉。
  const recovered = evaluateAlerts({ issues: [], state: third.state, now: now + 80_000, repeatMs: 60_000 })
  check(recovered.fire.length === 0 && recovered.recover.length === 1, 'a fixed issue produces a recovery notice', JSON.stringify(recovered.recover))
  check(recovered.active.length === 0, 'a fixed issue leaves the active list')
  check(recovered.recover[0].lastedMs === 80_000, 'the recovery says how long it lasted', String(recovered.recover[0].lastedMs))

  // 恢复之后再坏：算新问题（不是"持续中"），值班的人能看出是新的一轮。
  const again = evaluateAlerts({ issues, state: recovered.state, now: now + 90_000, repeatMs: 60_000 })
  check(again.fire.length === 1 && again.fire[0].reason === 'new', 'the same problem returning later counts as new', JSON.stringify(again.fire[0]?.reason))

  // 两个问题同时出现、修好一个：只报恢复那一个。
  const two = collectIssues({ ok: false, checks: [{ name: 'lease', ok: false, detail: 'x' }, { name: 'database', ok: false, detail: 'y' }], queues: {}, retention: {} })
  const both = evaluateAlerts({ issues: two, state: new Map(), now, repeatMs: 60_000 })
  check(both.fire.length === 2, 'two issues fire together', String(both.fire.length))
  const oneLeft = evaluateAlerts({ issues: two.slice(0, 1), state: both.state, now: now + 1000, repeatMs: 60_000 })
  check(oneLeft.fire.length === 0 && oneLeft.recover.length === 1, 'only the fixed one reports recovery', `${oneLeft.fire.length}/${oneLeft.recover.length}`)
  check(oneLeft.recover[0].key === 'check:database', 'the recovery names the right issue', oneLeft.recover[0].key)
}

// ---------------------------------------------------------------- 消息格式
{
  const issues = collectIssues(unhealthy)
  const result = evaluateAlerts({ issues, state: new Map(), now: 1_700_000_000_000, repeatMs: 60_000 })
  const text = formatAlert(result.fire, result.recover, { route: '/channel', now: 1_700_000_000_000 })
  check(text.includes('【严重】'), 'a critical issue is labelled critical', text.split('\n')[0])
  check(text.includes('lease 不健康'), 'the issue title is in the message')
  check(text.includes('新出现'), 'a first occurrence is labelled as new')
  check(text.includes('/channel'), 'the message says which gateway it is')
  check(text.includes('时间：'), 'the message carries a timestamp')

  const warnText = formatAlert(evaluateAlerts({ issues: collectIssues({ ok: true, checks: [], queues: { inbox: { dead: 1 } }, retention: {} }), state: new Map(), now: 1, repeatMs: 60_000 }).fire, [], { route: '/channel', now: 1 })
  check(warnText.includes('【注意】'), 'a warning issue is labelled warning', warnText.split('\n')[0])

  const recoverText = formatAlert([], [{ key: 'check:lease', title: 'lease 不健康', severity: 'critical', since: 0, lastedMs: 42_000 }], { route: '/channel', now: 1 })
  check(recoverText.includes('【恢复】'), 'a pure recovery is labelled recovered', recoverText.split('\n')[0])
  check(recoverText.includes('持续 42 秒'), 'the recovery says how long it lasted', recoverText.split('\n').find(line => line.includes('持续')))

  check(formatAlert([], [], { route: '/channel', now: 1 }) === '', 'no change produces no message')
}

// ---------------------------------------------------------------- 发送器
{
  // 配好了：真的发出去，载荷形状与运维派单器的通知一致。
  const fake = await alertServer()
  const alerter = createAlerter({
    config: parseAlertConfig({ alertWebhook: fake.url, alertTo: 'admin-1', alertIntervalMs: 1000, alertRepeatMs: 60_000, alertGraceMs: 0 }),
    route: '/channel',
  })
  const summary = await alerter.check(unhealthy)
  check(summary.sent === true && summary.fired === 1, 'the alerter posts when something is wrong', JSON.stringify({ fired: summary.fired, sent: summary.sent }))
  check(fake.received.length === 1, 'the adapter receives one message', String(fake.received.length))
  check(fake.received[0].senderId === 'admin-1' && fake.received[0].groupId === null, 'the payload targets the admin privately', JSON.stringify(fake.received[0]))
  check(fake.received[0].text.includes('lease'), 'the payload carries the diagnosis')
  check(fake.received[0].source === 'cs-agent-alerts', 'the payload is identifiable as a gateway alert', String(fake.received[0].source))

  // 同一个问题再查一次：不发。
  const quiet = await alerter.check(unhealthy)
  check(quiet.sent === false && fake.received.length === 1, 'a still-broken gateway is not re-paged immediately', String(fake.received.length))

  // 恢复：发一条恢复通知。
  const recovery = await alerter.check(healthy)
  check(recovery.sent === true && recovery.recovered === 1, 'a recovery is sent', JSON.stringify({ sent: recovery.sent, recovered: recovery.recovered }))
  check(fake.received.length === 2 && fake.received[1].text.includes('已恢复'), 'the recovery message is the second one', fake.received[1].text.split('\n')[0])

  // 状态与历史。
  const status = alerter.status()
  check(status.enabled === true && status.active.length === 0, 'the status reports nothing active after recovery', JSON.stringify(status.active))
  check(typeof status.lastSentAt === 'string', 'the status records when it last sent', String(status.lastSentAt))
  check(alerter.list().length === 2, 'the history keeps both messages', String(alerter.list().length))

  fake.server.close()
}

{
  // 发送失败：只记错、不抛、不影响下一轮。
  const fake = await alertServer(1)
  const alerter = createAlerter({
    config: parseAlertConfig({ alertWebhook: fake.url, alertTo: 'admin-1', alertRepeatMs: 0, alertGraceMs: 0 }),
    route: '/channel',
    logger: { warn: () => {} },
  })
  const failedSend = await alerter.check(unhealthy)
  check(failedSend.sent === false, 'a refused delivery is reported as not sent')
  check(alerter.status().lastError !== null, 'the failure is kept in the status', String(alerter.status().lastError))
  check(alerter.list()[0].sent === false && alerter.list()[0].reason.includes('503'), 'the history records the failure', JSON.stringify(alerter.list()[0].reason))

  // 下一轮（repeatMs = 0 所以会重报）投递成功：恢复正常。
  const retried = await alerter.check(unhealthy)
  check(retried.sent === true && alerter.status().lastError === null, 'the next round can deliver', JSON.stringify({ sent: retried.sent }))
  fake.server.close()
}

{
  // 没配发送通道：不抛，也留记录——面板能看到"本来要报什么"。
  const alerter = createAlerter({ config: parseAlertConfig({ alertTo: 'admin-1' }), route: '/channel' })
  const summary = await alerter.check(unhealthy)
  check(summary.sent === false && summary.fired === 1, 'an unconfigured alerter still evaluates', JSON.stringify({ fired: summary.fired }))
  check(alerter.list().length === 1 && alerter.list()[0].reason.includes('not configured'), 'the history explains why nothing was sent', String(alerter.list()[0].reason))
  check(alerter.status().missing === 'alertWebhook', 'the status says what is missing', String(alerter.status().missing))
}

// ---------------------------------------------------------------- 网关集成
{
  const fake = await alertServer()
  const workspace = path.join(temp, 'ws-1')
  await fs.mkdir(workspace, { recursive: true })
  const ctx = fakeCtx()
  const gateway = createGateway(ctx, {
    route: '/channel',
    workspace,
    agentPreset: 'service-desk',
    dataFile: path.join(temp, 'gw1-sessions.json'),
    outbox: path.join(temp, 'gw1-outbox.jsonl'),
    // 回复也走同一个假适配器：投递失败才能造出死信，告警才有东西可报。
    replyWebhook: fake.url,
    inboxRetry: FAST_RETRY,
    outboxRetry: FAST_RETRY,
    alertWebhook: fake.url,
    alertTo: 'admin-1',
    alertGraceMs: 0,
    alertRepeatMs: 60_000,
  })

  check(gateway.alerts.enabled === true, 'the gateway enables alerts when both fields are set')

  // 健康时：不报。
  const quiet = await gateway.checkAlerts()
  check(quiet.fired === 0 && fake.received.length === 0, 'a healthy gateway sends nothing', String(fake.received.length))

  // 造一条死信：回复投递一直失败，重试用尽。
  fake.control.failTimes = 99
  const first = await gateway.inbound({ channel: 'qq', senderId: 'u-1', text: '在吗', messageId: 'a-1' })
  gateway.observe({ id: first.sessionId }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '在的' }] } } })
  gateway.observe({ id: first.sessionId }, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  await gateway.flushArchives()
  await new Promise(resolve => setTimeout(resolve, 20))
  await gateway.drainOutbox()
  await new Promise(resolve => setTimeout(resolve, 20))
  await gateway.drainOutbox()
  const dead = await gateway.outbox.listDead(10)
  check(dead.length === 1, 'the failed reply became a dead letter', String(dead.length))

  // 告警本身要能发出去，否则测的是"发送失败"而不是"该不该报"。
  fake.control.failTimes = 0
  const alerted = await gateway.checkAlerts()
  check(alerted.fired === 1 && alerted.sent === true, 'the dead letter is paged out', JSON.stringify({ fired: alerted.fired, sent: alerted.sent }))
  check(fake.received.length >= 1 && fake.received.at(-1).text.includes('死信'), 'the page mentions dead letters', String(fake.received.at(-1)?.text.split('\n')[1]))
  const before = fake.received.length
  const repeat = await gateway.checkAlerts()
  check(repeat.fired === 0 && fake.received.length === before, 'the same dead letter does not page twice in a row', String(fake.received.length))

  // 重放后死信清零：下一轮报恢复。
  await gateway.replayDead('outbox', [dead[0].idempotencyKey], 'ops-alice')
  await gateway.drainOutbox()
  const recovered = await gateway.checkAlerts()
  check(recovered.recovered === 1 && recovered.sent === true, 'replaying the dead letter produces a recovery', JSON.stringify({ recovered: recovered.recovered }))
  check(fake.received.at(-1).text.includes('已恢复'), 'the recovery text says so', fake.received.at(-1).text.split('\n')[1])

  // /health 带上告警摘要，/alerts 读出状态与历史。
  const healthRes = resOf()
  await gateway.handleHttp({ method: 'GET', url: '/channel/health', headers: {} }, healthRes)
  const report = JSON.parse(healthRes.body)
  check(report.alerts !== undefined && report.alerts.enabled === true, '/health carries an alerts summary', JSON.stringify(report.alerts?.enabled))
  check(report.alerts.active.length === 0, '/health shows nothing active after recovery', JSON.stringify(report.alerts.active))

  const alertsRes = resOf()
  await gateway.handleHttp({ method: 'GET', url: '/channel/alerts?limit=5', headers: {} }, alertsRes)
  const feed = JSON.parse(alertsRes.body)
  check(alertsRes.code === 200 && feed.status.enabled === true, '/alerts is readable', String(alertsRes.code))
  check(Array.isArray(feed.entries) && feed.entries.length >= 2, '/alerts returns the send history', String(feed.entries.length))
  check(feed.entries[0].text.includes('恢复'), '/alerts returns newest first', feed.entries[0].text.split('\n')[0])

  fake.server.close()
}

{
  // 租约被接管：这是最该报警的一种，因为写入已经不安全了。
  const fake = await alertServer()
  const workspace = path.join(temp, 'ws-2')
  await fs.mkdir(workspace, { recursive: true })
  const gateway = createGateway(fakeCtx(), {
    route: '/channel',
    workspace,
    agentPreset: 'service-desk',
    dataFile: path.join(temp, 'gw2-sessions.json'),
    alertWebhook: fake.url,
    alertTo: 'admin-1',
    alertGraceMs: 0,
  }, { lease: { kind: 'postgres', lost: true } })
  const result = await gateway.checkAlerts()
  check(result.fired === 1 && result.sent === true, 'a lost lease is paged out', JSON.stringify({ fired: result.fired }))
  check(fake.received[0].text.includes('【严重】'), 'a lost lease is critical', fake.received[0].text.split('\n')[0])
  check(gateway.alerts.status().active.includes('check:lease'), 'the active list names the lease', JSON.stringify(gateway.alerts.status().active))

  const healthRes = resOf()
  await gateway.handleHttp({ method: 'GET', url: '/channel/health', headers: {} }, healthRes)
  check(healthRes.code === 503, '/health still reports 503 when the lease is lost', String(healthRes.code))
  fake.server.close()
}

{
  // 启动宽限期：刚起来的那十几秒不报，避免重启刷屏。
  const fake = await alertServer()
  const workspace = path.join(temp, 'ws-3')
  await fs.mkdir(workspace, { recursive: true })
  const gateway = createGateway(fakeCtx(), {
    route: '/channel',
    workspace,
    agentPreset: 'service-desk',
    dataFile: path.join(temp, 'gw3-sessions.json'),
    alertWebhook: fake.url,
    alertTo: 'admin-1',
    alertGraceMs: 60_000,
  }, { lease: { kind: 'postgres', lost: true } })

  check(gateway.startAlertWorker() === true, 'the alert worker starts')
  const inGrace = await gateway.checkAlerts()
  check(inGrace.skipped === 'grace' && fake.received.length === 0, 'nothing is sent inside the grace window', JSON.stringify(inGrace.skipped))
  check(gateway.stopAlertWorker() === true, 'the alert worker stops')
  check(gateway.stopAlertWorker() === false, 'stopping twice is harmless')
  fake.server.close()
}

await fs.rm(temp, { recursive: true, force: true })
console.log('')
console.log(failed === 0 ? 'all alert checks passed' : `${failed} check(s) failed`)
process.exit(failed === 0 ? 0 : 1)
