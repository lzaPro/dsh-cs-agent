// 死信与人工重放的冒烟测试。
//
//   node cs-agent/dead-smoke.mjs            # json 存储 + 网关集成
//   DSH_DB=1 node cs-agent/dead-smoke.mjs   # 额外跑数据库实现（需要 ./scripts/db-up.sh）
//
// 要回答的问题：回复重试用尽变 dead 之后，运维能不能看见它、能不能把它推回去，
// 以及"谁推的"有没有留痕。已经发出去的绝不能被重放 —— 那会让客户看到两条一样的回复。
import { promises as fs } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { createOutbox } from './outbox.js'
import { createGateway } from './gateway.js'

let failed = 0
const check = (ok, label, detail = '') => {
  if (!ok) failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail === '' ? '' : `: ${detail}`}`)
}

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-dead-'))
// 领取会给条目加一个租约，等它过期才能再被领。测试里必须真的等过 leaseMs。
const tick = (ms = 60) => new Promise(resolve => setTimeout(resolve, ms))
const dbEnabled = ['1', 'on', 'true', 'yes'].includes(String(process.env.DSH_DB ?? '').toLowerCase())
// baseMs 0：重试不排队等，测试里连调几次 drain 就能把重试次数耗尽。
const FAST_RETRY = { baseMs: 0, factor: 1, maxMs: 0, maxAttempts: 2, graceMs: 0, sweepMs: 10, leaseMs: 30, jitter: false }

function fakeCtx() {
  const live = new Map()
  const state = { followups: 0 }
  const makeAgent = id => ({ id, followup: () => { state.followups += 1 }, inject: () => {} })
  return {
    state,
    logger: { warn: () => {} },
    workspaceRegistry: {
      list: () => [],
      create: async () => ({ id: 'ws-1', sessionIds: [], attachSession: async () => {}, detachSession: async () => {}, setTitle: async () => {} }),
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
const envelopeOf = key => ({ key, channel: 'qq', text: '回复内容', at: new Date().toISOString(), idempotencyKey: `${key}#${Date.now()}` })

/** 一个会失败若干次、之后成功的回复端点。control.failTimes 可以在测试中途改写。 */
function replyServer(failTimes) {
  const control = { failTimes }
  const seen = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      seen.push(body)
      if (seen.length <= control.failTimes) {
        res.writeHead(503, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'temporarily unavailable' }))
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"ok":true}')
    })
  })
  return { server, seen, control }
}

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))

// --- 队列契约 ---------------------------------------------------------------
async function contract(makeQueue, label, prefix) {
  const queue = makeQueue()
  await queue.load()

  // 造三条死信：各自失败到上限。
  const keys = [`${prefix}:a`, `${prefix}:b`, `${prefix}:c`]
  for (const key of keys) {
    await queue.enqueue(envelopeOf(key))
  }
  // enqueue 的幂等键由调用方给，故按 key 重新取。
  const queued = await queue.list(50)
  const mine = queued.filter(record => String(record.payload?.key ?? '').includes(prefix))
  check(mine.length === 3, `${label}: three items are queued`, String(mine.length))
  for (const record of mine) {
    await queue.markFailed(record.idempotencyKey, 'boom')
    await queue.markFailed(record.idempotencyKey, 'boom')
  }
  const dead = await queue.listDead(50)
  const myDead = dead.filter(record => String(record.payload?.key ?? '').includes(prefix))
  check(myDead.length === 3, `${label}: exhausted items become dead`, String(myDead.length))

  // 重放一条：回到 pending、计数清零。
  const one = myDead[0]
  const replayed = await queue.replay(one.idempotencyKey)
  check(replayed.replayed === true && replayed.state === 'pending', `${label}: replay puts the item back in the queue`, JSON.stringify(replayed.state))
  check(replayed.attempts === 0 && replayed.lastError === null, `${label}: replay resets the attempt counter`)

  // 已经发出去的不能再重放。
  const claimed = await queue.claim(10)
  const target = claimed.find(record => String(record.payload?.key ?? '').includes(prefix))
  check(target !== undefined, `${label}: a replayed item is claimable again`)
  await queue.markSent(target.idempotencyKey)
  const sentReplay = await queue.replay(target.idempotencyKey)
  check(sentReplay.replayed === false, `${label}: a delivered reply is never replayed`, JSON.stringify(sentReplay.state))

  // 不存在的键不该炸。
  check((await queue.replay(`${prefix}:nope`)) === undefined, `${label}: replaying an unknown id is a no-op`)

  // 收尾：把剩下的死信清掉，免得脏数据留在共享表里。
  for (const record of (await queue.listDead(200)).filter(item => String(item.payload?.key ?? '').includes(prefix))) {
    await queue.replay(record.idempotencyKey)
    const [claimedAgain] = await queue.claim(10)
    if (claimedAgain !== undefined) await queue.markSent(claimedAgain.idempotencyKey)
  }
}

let prefix = 'dead-local'
await contract(
  () => createOutbox({ kind: 'json', stateFile: path.join(temp, 'dead-queue.json'), retry: FAST_RETRY }),
  'json',
  prefix,
)

if (!dbEnabled) {
  console.log('SKIP database dead-letter checks (set DSH_DB=1 to run them)')
} else {
  const { query, closePool, withTransaction } = await import('./db/pool.mjs')
  prefix = `dead-smoke-${process.pid}-${Date.now()}`
  try {
    await contract(
      () => createOutbox({ kind: 'postgres', retry: FAST_RETRY, logger: { warn: () => {} } }),
      'postgres',
      prefix,
    )
    // 数据库模式下顺带验审计表能写（重放审计走的是同一张表）。
    const { createAudit } = await import('./audit.js')
    const audit = createAudit({ kind: 'postgres', file: path.join(temp, 'pg-audit.jsonl') })
    const landed = await audit.record({
      actor: 'smoke',
      role: 'operator',
      action: 'replay',
      targetType: 'outbox',
      targetId: `${prefix}:audit`,
      detail: { reason: 'smoke' },
    })
    check(landed === true, 'postgres: an audit row is written to audit_log')
    const rows = await query(
      "select count(*)::int as count from audit_log where target_id = $1 and action = 'replay'",
      [`${prefix}:audit`],
    )
    check(rows.rows[0].count === 1, 'postgres: the audit row is findable', String(rows.rows[0].count))
    // append-only 保护：审计写进去就改不了。
    let immutable = false
    try {
      await query("update audit_log set action = 'tampered' where target_id = $1", [`${prefix}:audit`])
    } catch {
      immutable = true
    }
    check(immutable, 'postgres: audit rows cannot be modified')
    // 按自己的 target_id 找，不假设表里只有本测试的行（共享库跑并行测试时会有别的行）。
    const listed = await audit.list(50)
    const mineRow = listed.find(item => item.targetId === `${prefix}:audit`)
    check(mineRow !== undefined && mineRow.action === 'replay', 'postgres: the audit trail is readable')
    // audit_log 是 append-only：连测试清理都要显式开 purge 开关，这正是想要的行为。
    await withTransaction(async client => {
      await client.query("set local app.allow_purge = 'on'")
      await client.query('delete from audit_log where target_id like $1', [`${prefix}%`])
    })
  } finally {
    const cleaned = await query('delete from outbox where external_key like $1', [`${prefix}%`])
    const left = await query('select count(*)::int as count from outbox where external_key like $1', [`${prefix}%`])
    check(left.rows[0].count === 0, 'postgres: test rows are cleaned up', `${cleaned.rowCount} removed`)
    await closePool()
  }
}

// --- 网关：回复投递失败 → 死信 → 人工重放 → 真的发出去了 ---------------------
{
  const workspace = path.join(temp, 'ws')
  await fs.mkdir(workspace, { recursive: true })
  // 前 3 次 503，之后成功：重试用尽变 dead，重放后一次就通。
  const { server, seen, control } = replyServer(2)
  const port = await listen(server)
  const gateway = createGateway(fakeCtx(), {
    route: '/channel',
    workspace,
    agentPreset: 'service-desk',
    dataFile: path.join(temp, 'gw-sessions.json'),
    outbox: path.join(temp, 'gw-outbox.jsonl'),
    replyWebhook: `http://127.0.0.1:${port}/reply`,
    outboxRetry: FAST_RETRY,
    inboxRetry: FAST_RETRY,
  })

  const first = await gateway.inbound({ channel: 'qq', senderId: 'u1', text: '在吗', messageId: 'dead-m1' })
  check(first.duplicate === false, 'gateway: the message is accepted')

  // 一轮回复：首发失败 + 定时器再试一次 → 用尽 maxAttempts 变 dead。
  gateway.observe({ id: first.sessionId }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '马上处理' }] } } })
  gateway.observe({ id: first.sessionId }, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  await gateway.flushArchives()
  // 这里**故意不启动 worker**：graceMs 设成 0 时，定时器可能在"首发还在飞"的同一瞬间
  // 就把这条领走，于是同一条回复被发两次——那是配置问题（生产默认 graceMs 2000），
  // 但在测试里会让断言摇摆。改成手动推进，每次 drain 之间等过租约。
  await tick()
  await gateway.drainOutbox()
  await tick()
  await gateway.drainOutbox()

  const deadRes = resOf()
  await gateway.handleHttp({ method: 'GET', url: '/channel/dead', headers: {} }, deadRes)
  check(deadRes.code === 200, 'gateway: the dead-letter endpoint answers', String(deadRes.code))
  const deadBody = JSON.parse(deadRes.body)
  check(deadBody.outbox.length === 1, 'gateway: the undelivered reply shows up as dead', String(deadBody.outbox?.length))
  const deadKey = deadBody.outbox[0].idempotencyKey
  check(JSON.stringify(deadBody.outbox[0].payload).includes('马上处理'), 'gateway: the dead item keeps its payload')

  // 服务器这时恢复：重放应该立刻发出去。
  const replayRes = resOf()
  await gateway.handleHttp({
    method: 'POST', url: '/channel/replay', headers: {},
    async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({ queue: 'outbox', ids: [deadKey], actor: 'ops-alice' })) },
  }, replayRes)
  check(replayRes.code === 200, 'gateway: replay answers', String(replayRes.code))
  const replayBody = JSON.parse(replayRes.body)
  check(replayBody.replayed.includes(deadKey), 'gateway: the dead item is replayed', JSON.stringify(replayBody.replayed))

  await gateway.drainOutbox()
  const sentStats = await gateway.outbox.stats()
  check(sentStats.sent === 1 && sentStats.dead === 0, 'gateway: the replayed reply is delivered', JSON.stringify(sentStats))
  // 两次失败（首发 + 第一次重试）之后变 dead，重放那一次是第三次请求，成功。
  check(seen.length === 3, 'gateway: the reply endpoint saw the original attempts plus the replay', String(seen.length))

  // 重复重放同一条：已经发出去了，必须是 no-op 而不是再发一遍。
  const againRes = resOf()
  await gateway.handleHttp({
    method: 'POST', url: '/channel/replay', headers: {},
    async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({ queue: 'outbox', ids: [deadKey] })) },
  }, againRes)
  const again = JSON.parse(againRes.body)
  check(again.replayed.length === 0 && again.skipped.length === 1, 'gateway: replaying a delivered reply is skipped', JSON.stringify(again.skipped))
  await gateway.drainOutbox()
  check(seen.length === 3, 'gateway: a skipped replay does not send anything again', String(seen.length))

  // 审计留痕：谁重放的、重放了哪条。
  const auditRes = resOf()
  await gateway.handleHttp({ method: 'GET', url: '/channel/audit?limit=10', headers: {} }, auditRes)
  const auditBody = JSON.parse(auditRes.body)
  const entry = auditBody.entries.find(item => item.action === 'replay')
  check(entry !== undefined, 'gateway: the replay is audited')
  check(entry.actor === 'ops-alice' && entry.targetId === deadKey, 'gateway: the audit says who replayed what', JSON.stringify({ actor: entry.actor }))
  check(entry.detail?.externalKey === 'qq:u1', 'gateway: the audit keeps the conversation key')

  // 未知队列名要报 400，而不是 500。
  const badRes = resOf()
  await gateway.handleHttp({
    method: 'POST', url: '/channel/replay', headers: {},
    async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({ queue: 'nowhere' })) },
  }, badRes)
  check(badRes.code === 400, 'gateway: an unknown queue is a client error', String(badRes.code))

  // 不带 ids 就是"重放当前全部死信"：先让端点重新开始失败，造一条新的死信再试。
  control.failTimes = seen.length + 2
  const human = await gateway.inbound({ channel: 'qq', senderId: 'u2', text: '还在吗', messageId: 'dead-m2' })
  gateway.observe({ id: human.sessionId }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '第二条' }] } } })
  gateway.observe({ id: human.sessionId }, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  await gateway.flushArchives()
  await tick()
  await gateway.drainOutbox()
  await tick()
  await gateway.drainOutbox()
  const allRes = resOf()
  await gateway.handleHttp({
    method: 'POST', url: '/channel/replay', headers: {},
    async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({ queue: 'outbox' })) },
  }, allRes)
  const all = JSON.parse(allRes.body)
  check(all.replayed.length >= 1, 'gateway: replaying without ids picks up every dead item', JSON.stringify(all))
  // 让端点重新开始失败：重放出去又发不出去时，它必须重新变回死信，而不是消失。
  control.failTimes = seen.length + 5
  await tick()
  await gateway.drainOutbox()
  await tick()
  await gateway.drainOutbox()
  const afterAll = await gateway.outbox.stats()
  check(afterAll.dead === 1, 'gateway: a replay that fails again goes back to dead', JSON.stringify(afterAll))

  await gateway.flushArchives()
  await gateway.stopWorker()
  await new Promise(resolve => server.close(resolve))
}

await fs.rm(temp, { recursive: true, force: true })
console.log(failed === 0 ? '\nall dead-letter checks passed' : `\n${failed} dead-letter check(s) failed`)
process.exit(failed === 0 ? 0 : 1)
