// 投递队列的冒烟测试：json 与 postgres 两套实现跑同一份契约，再验网关的重发链路。
//
//   node cs-agent/outbox-smoke.mjs            # 只跑 json 实现 + 网关集成
//   DSH_DB=1 node cs-agent/outbox-smoke.mjs   # 额外跑数据库实现（需要 ./scripts/db-up.sh）
//
// 核心断言是"回复不能丢"：首发失败后必须在退避节点重发，重试用尽标 dead，
// 同一封回复不能被发两遍。
import { promises as fs } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { createOutbox, retryDelay, outboxKey } from './outbox.js'
import { createGateway } from './gateway.js'

let failed = 0
const check = (ok, label, detail = '') => {
  if (!ok) failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail === '' ? '' : `: ${detail}`}`)
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-outbox-'))
const dbEnabled = ['1', 'on', 'true', 'yes'].includes(String(process.env.DSH_DB ?? '').toLowerCase())

/** 一个 Host 替身，够 inbound/observe 用即可。 */
function fakeCtx() {
  const live = new Map()
  const makeAgent = id => ({
    id,
    followup: () => {},
    inject: () => {},
    followupAsync: async () => {},
  })
  return {
    logger: { warn: () => {} },
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
      async create(options) {
        const agent = makeAgent(options.sessionId)
        live.set(options.sessionId, agent)
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
    sessionTitle: { async rename() {} },
    on: () => () => {},
    effect: () => {},
  }
}

/** envelope 的 at 决定幂等键，所以每次造一个新的 at 就是一条新回复。 */
const envelopeAt = (at, extra = {}) => ({
  key: 'qq:box',
  channel: 'qq',
  groupId: null,
  senderId: 'u1',
  text: '你的订单已发货',
  at,
  ...extra,
})

/** 两套实现共用的契约。makeOutbox 每次调用应返回一个"新进程视角"的实例。 */
async function contract(makeOutbox, label, prefix) {
  const at = new Date().toISOString()
  const envelope = envelopeAt(at, { key: `${prefix}:box` })
  const key = outboxKey(envelope)

  let outbox = makeOutbox()
  const first = await outbox.enqueue(envelope)
  check(first.duplicate === false && first.record.state === 'pending', `${label}: enqueue creates a pending entry`)
  check(first.record.idempotencyKey === key, `${label}: idempotency key is content-derived`)
  check(first.record.attempts === 0, `${label}: a fresh entry has no attempts`)

  const again = await outbox.enqueue(envelope)
  check(again.duplicate === true && again.record.idempotencyKey === key, `${label}: re-enqueue is a duplicate`)
  check((await outbox.stats()).total === 1, `${label}: duplicate does not create a second row`)

  // 领一次：状态变 sending，租约期内不会被再领走。
  await sleep(5)
  const claimed = await outbox.claim(10)
  check(claimed.length === 1 && claimed[0].state === 'sending', `${label}: claim leases the due entry`)
  check((await outbox.claim(10)).length === 0, `${label}: a leased entry is not claimed twice`)

  const sent = await outbox.markSent(key)
  check(sent.state === 'sent' && sent.sentAt !== null, `${label}: markSent records delivery`)
  check((await outbox.stats()).sent === 1, `${label}: stats counts the delivered entry`)
  check((await outbox.claim(10)).length === 0, `${label}: a delivered entry is never retried`)

  // 失败路径：attempts 递增、退避时间推后、到上限变 dead。
  const failing = envelopeAt(new Date(Date.now() + 1000).toISOString(), { key: `${prefix}:fail` })
  const failKey = outboxKey(failing)
  await outbox.enqueue(failing)
  await sleep(5)
  await outbox.claim(10)
  const once = await outbox.markFailed(failKey, 'HTTP 502')
  check(once.state === 'failed' && once.attempts === 1, `${label}: markFailed counts the attempt`)
  check(once.lastError === 'HTTP 502', `${label}: markFailed keeps the reason`)
  check(new Date(once.nextAttemptAt).getTime() >= Date.now(), `${label}: markFailed schedules a retry in the future`)
  check((await outbox.claim(10)).length === 0, `${label}: a failed entry waits for its backoff`)

  // 退避序列本身：1 → base，2 → base*factor，并受 maxMs 封顶。
  const noJitter = { baseMs: 100, factor: 4, maxMs: 1000, jitter: false }
  const delays = [1, 2, 3, 4].map(n => retryDelay(n, noJitter))
  check(JSON.stringify(delays) === JSON.stringify([100, 400, 1000, 1000]), `${label}: backoff grows then caps`, delays.join(','))

  await outbox.flush?.()
  // 重启：新实例读同一份状态，未发出的那条还在。
  outbox = makeOutbox()
  const reloaded = await outbox.get(failKey)
  check(reloaded?.state === 'failed' && reloaded.attempts === 1, `${label}: pending state survives a restart`)

  const listed = await outbox.list(10)
  check(Array.isArray(listed) && listed.length === 2, `${label}: list returns both entries`)
}

await contract(() => createOutbox({ file: path.join(temp, 'contract.jsonl'), retry: { jitter: false } }), 'json', 'json')
check(true, 'json: contract complete')

if (!dbEnabled) {
  console.log('SKIP database outbox checks (set DSH_DB=1 to run them)')
} else {
  const prefix = `smoke-${process.pid}-${Date.now()}`
  const { query, closePool } = await import('./db/pool.mjs')
  try {
    await contract(() => createOutbox({ kind: 'postgres', retry: { jitter: false } }), 'postgres', prefix)
    check(true, 'postgres: contract complete')
  } finally {
    // 只清这套用例自己的行，别碰真实队列。
    await query('delete from outbox where external_key like $1', [`${prefix}:%`])
    const left = await query('select count(*)::int as count from outbox where external_key like $1', [`${prefix}:%`])
    check(left.rows[0].count === 0, 'postgres: test rows are cleaned up', String(left.rows[0].count))
    await closePool()
  }
}

// --- 网关集成：首发失败 → 后台按退避重发 → 最终只送达一次 -------------------
{
  let hits = 0
  const received = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      hits += 1
      received.push(body)
      // 前两次故意失败，模拟适配器重启。
      const code = hits <= 2 ? 503 : 200
      res.writeHead(code, { 'content-type': 'application/json' })
      res.end(JSON.stringify(code === 200 ? { ok: true } : { error: 'adapter restarting' }))
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port

  const outboxFile = path.join(temp, 'gateway-outbox.jsonl')
  const gateway = createGateway(fakeCtx(), {
    route: '/channel',
    workspace: temp,
    agentPreset: 'service-desk',
    dataFile: path.join(temp, 'gateway-sessions.json'),
    outbox: outboxFile,
    replyWebhook: `http://127.0.0.1:${port}/reply`,
    forward: 'final',
    // 把退避压到毫秒级，测试才能在几百毫秒内看到完整链路。
    outboxRetry: { baseMs: 20, factor: 1, maxMs: 20, maxAttempts: 5, graceMs: 0, sweepMs: 20, leaseMs: 50, jitter: false },
  })
  check(gateway.outbox !== undefined, 'gateway exposes the delivery queue')

  const inbound = await gateway.inbound({ channel: 'qq', senderId: 'u1', text: '在吗' })
  gateway.observe({ id: inbound.sessionId }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '在的，请讲' }] } } })
  gateway.observe({ id: inbound.sessionId }, { type: 'turn/end', data: { reason: 'done' } })
  await sleep(60)

  const afterFirst = await gateway.outbox.stats()
  check(afterFirst.total === 1, 'a reply that cannot be delivered is queued', JSON.stringify(afterFirst))
  check(afterFirst.sent === 0 && (afterFirst.failed + afterFirst.pending + afterFirst.sending) === 1, 'the failed reply is still owed')

  // 后台 worker 把它发出去。
  gateway.startOutboxWorker()
  for (let attempt = 0; attempt < 60 && (await gateway.outbox.stats()).sent === 0; attempt += 1) await sleep(25)
  const afterRetry = await gateway.outbox.stats()
  check(afterRetry.sent === 1, 'the worker delivers the queued reply', JSON.stringify(afterRetry))
  check(afterRetry.dead === 0, 'a recoverable failure never becomes dead')

  gateway.stopOutboxWorker()
  check(hits === 3, 'one initial attempt plus two retries', String(hits))
  check(received.length === 3 && new Set(received).size === 1, 'every attempt carries the same envelope')

  // /outbox 端点要能看到"还欠什么"，只读审计日志是看不出来的。
  const res = { code: 0, body: '', writeHead(code) { this.code = code }, end(body) { this.body = body } }
  await gateway.handleHttp({ method: 'GET', url: '/channel/outbox?limit=5', headers: {} }, res)
  const payload = JSON.parse(res.body)
  check(res.code === 200 && payload.messages.length === 1, 'outbox endpoint still returns the audit trail')
  check(payload.delivery?.sent === 1 && payload.delivery?.kind === 'json', 'outbox endpoint reports delivery stats')

  // 同一封回复（相同 at）重复入队不能发第二遍。
  const before = hits
  await gateway.drainOutbox()
  check(hits === before, 'a delivered reply is never sent twice')

  server.close()
}

// 没有 webhook 时不得引入任何队列状态：行为与重构前完全一致。
{
  const outboxFile = path.join(temp, 'plain-outbox.jsonl')
  const gateway = createGateway(fakeCtx(), {
    route: '/channel',
    workspace: temp,
    agentPreset: 'service-desk',
    dataFile: path.join(temp, 'plain-sessions.json'),
    outbox: outboxFile,
  })
  check(gateway.outbox === undefined, 'no webhook means no delivery queue')
  const inbound = await gateway.inbound({ channel: 'qq', senderId: 'u1', text: '在吗' })
  gateway.observe({ id: inbound.sessionId }, { type: 'turn/end', data: { reason: 'done' } })
  await sleep(40)
  const lines = (await fs.readFile(outboxFile, 'utf8')).trim().split('\n').filter(Boolean)
  check(lines.length === 1, 'audit log is still written without a webhook', String(lines.length))
  const stateFiles = (await fs.readdir(temp)).filter(name => name.startsWith('plain-outbox-state'))
  check(stateFiles.length === 0, 'no queue state file is created without a webhook')
}

await fs.rm(temp, { recursive: true, force: true })

console.log(failed === 0 ? '\nall outbox checks passed' : `\n${failed} outbox check(s) failed`)
process.exit(failed === 0 ? 0 : 1)
