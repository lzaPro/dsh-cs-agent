// 入站队列的冒烟测试：json 与 postgres 两套实现跑同一份契约，再验网关的"先收下再处理"。
//
//   node cs-agent/inbox-smoke.mjs            # 只跑 json 实现 + 网关集成
//   DSH_DB=1 node cs-agent/inbox-smoke.mjs   # 额外跑数据库实现（需要 ./scripts/db-up.sh）
//
// 核心断言是"客户消息不能丢"：附件下载失败、建会话超时都不能让消息消失，
// 而要留在队列里按退避重试，重试用尽才标 dead。
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createInbox, inboxKey } from './inbox.js'
import { createGateway } from './gateway.js'

let failed = 0
const check = (ok, label, detail = '') => {
  if (!ok) failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail === '' ? '' : `: ${detail}`}`)
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-inbox-'))
const dbEnabled = ['1', 'on', 'true', 'yes'].includes(String(process.env.DSH_DB ?? '').toLowerCase())
// leaseMs 要明显长于两条断言之间的间隔：机器负载高时事件循环可能卡上百毫秒，
// 租约一过期，"不能被领两次"的断言就会真的领到第二次（那是租约正常工作，不是 bug）。
const FAST_RETRY = { baseMs: 20, factor: 1, maxMs: 20, maxAttempts: 3, graceMs: 0, sweepMs: 10, leaseMs: 5000, jitter: false }

/**
 * Host 替身。比 outbox-smoke 的多两件事：能数 followup 次数，能故意让建会话失败。
 */
function fakeCtx(options = {}) {
  const live = new Map()
  const state = { followups: 0, injected: 0, failTimes: options.failTimes ?? 0, createAttempts: 0 }
  const makeAgent = id => ({
    id,
    followup: () => { state.followups += 1 },
    inject: () => { state.injected += 1 },
  })
  return {
    state,
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
      async create(opts) {
        state.createAttempts += 1
        if (state.createAttempts <= state.failTimes) {
          throw new Error('session store is unavailable')
        }
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
    sessionTitle: { async rename() {} },
    on: () => () => {},
    effect: () => {},
  }
}

const message = (extra = {}) => ({
  channel: 'qq',
  senderId: 'u-1',
  text: '我的容器起不来',
  messageId: `m-${Math.random().toString(36).slice(2, 10)}`,
  ...extra,
})

/** envelope 的形状与网关入队时一致。key 里带前缀，方便测试收尾时只清自己的行。 */
let prefix = 'local'
const envelopeOf = (msg, key = `${prefix}:${msg.senderId}`) => ({
  key,
  channel: msg.channel,
  at: new Date().toISOString(),
  messageId: msg.messageId,
  // 与网关保持一致：幂等键由消息身份决定，不含时间戳。
  idempotencyKey: inboxKey(msg),
  message: msg,
})

/** 两套实现共用的契约。makeInbox 每次调用返回一个"新进程视角"的实例。 */
async function contract(makeInbox, label) {
  const msg = message()
  const envelope = envelopeOf(msg)
  const expectedKey = `${msg.channel}:msg:${msg.messageId}`

  let inbox = makeInbox()
  const first = await inbox.enqueue(envelope)
  check(first.duplicate === false && first.record.state === 'pending', `${label}: accept creates a pending item`)
  check(inboxKey(msg) === expectedKey, `${label}: idempotency key follows the platform message id`)

  // 平台重投同一条消息：不能再排一次。
  const again = await inbox.enqueue(envelope)
  check(again.duplicate === true, `${label}: a redelivered message is not queued twice`)
  // 用 get 而不是 stats：表里可能有别的步骤留下的行，全局计数不能拿来判"只排了一条"。
  check(again.record.idempotencyKey === expectedKey, `${label}: the duplicate points at the same item`)

  // 领取加租约：同一批不会被领两次。
  const claimed = await inbox.claim(10)
  check(claimed.length === 1 && claimed[0].state === 'sending', `${label}: claim takes the item and leases it`)
  const second = await inbox.claim(10)
  check(second.length === 0, `${label}: a leased item is not claimed twice`)

  await inbox.markSent(claimed[0].idempotencyKey)
  const handled = await inbox.get(claimed[0].idempotencyKey)
  check(handled.state === 'sent' && handled.sentAt !== null, `${label}: a handled item is marked sent`)

  // 已处理的不会被重领，所以重投也不会把客户已经看过的话再说一遍。
  check((await inbox.claim(10)).length === 0, `${label}: a handled item is never re-claimed`)

  // 失败 → 退避重排，attempts 累加。
  const failMsg = message()
  const failEnvelope = envelopeOf(failMsg)
  await inbox.enqueue(failEnvelope)
  const [claimedFail] = await inbox.claim(10)
  const failedRecord = await inbox.markFailed(claimedFail.idempotencyKey, 'boom')
  check(failedRecord.state === 'failed' && failedRecord.attempts === 1, `${label}: a failure is counted and rescheduled`)
  check(failedRecord.lastError === 'boom', `${label}: the failure reason is kept`)

  // 新实例（模拟重启）必须还能看见没处理完的。
  const reopened = makeInbox()
  const afterRestart = await reopened.stats()
  check(afterRestart.pending + afterRestart.failed + afterRestart.sending >= 1, `${label}: unfinished items survive a restart`)
}

await contract(() => createInbox({ file: path.join(temp, 'json-inbox.json'), retry: FAST_RETRY }), 'json')

if (!dbEnabled) {
  console.log('SKIP database inbox checks (set DSH_DB=1 to run them)')
} else {
  const { query, closePool } = await import('./db/pool.mjs')
  prefix = `inbox-smoke-${process.pid}-${Date.now()}`
  try {
    await contract(
      () => createInbox({ kind: 'postgres', retry: FAST_RETRY, logger: { warn: () => {} } }),
      'postgres',
    )
  } finally {
    // 只删这个进程自己排进去的：external_key 带着 prefix。
    const cleaned = await query('delete from inbox where external_key like $1', [`${prefix}:%`])
    const left = await query('select count(*)::int as count from inbox where external_key like $1', [`${prefix}:%`])
    check(left.rows[0].count === 0, 'postgres: test rows are cleaned up', `${cleaned.rowCount} removed`)
    await closePool()
  }
}

// --- 网关集成：收下了就必须处理，处理不了就必须还在队列里 ----------------------
{
  // 1) 正常路径：一次成功，队列清空，模型被唤醒一次。
  const workspace = path.join(temp, 'ws-ok')
  await fs.mkdir(workspace, { recursive: true })
  const ctx = fakeCtx()
  const gateway = createGateway(ctx, {
    route: '/channel',
    workspace,
    agentPreset: 'service-desk',
    dataFile: path.join(temp, 'ok-sessions.json'),
    inboxRetry: FAST_RETRY,
  })
  const ok = await gateway.inbound(message({ groupId: undefined }))
  check(ok.duplicate === false && ok.queued === undefined, 'gateway: a healthy message is handled inline', JSON.stringify(ok).slice(0, 80))
  check(ctx.state.followups === 1, 'gateway: the model is woken exactly once')
  const afterOk = await gateway.inbox.stats()
  check(afterOk.sent === 1 && afterOk.pending === 0, 'gateway: a handled message leaves nothing pending')

  // 2) 平台重投同一条 messageId：第二次必须是 duplicate，不能二次唤醒。
  const dup = await gateway.inbound(message({ messageId: 'dup-1' }))
  const dupAgain = await gateway.inbound(message({ messageId: 'dup-1' }))
  check(dup.duplicate === false && dupAgain.duplicate === true, 'gateway: a redelivered message is a duplicate')
  check(ctx.state.followups === 2, 'gateway: a duplicate does not wake the model again')
  await gateway.inbox.flush?.()

  // 3) 建会话失败：消息必须被受理（不抛错），并且留在队列里等重试。
  const badWorkspace = path.join(temp, 'ws-bad')
  await fs.mkdir(badWorkspace, { recursive: true })
  const badCtx = fakeCtx({ failTimes: 99 })
  const badGateway = createGateway(badCtx, {
    route: '/channel',
    workspace: badWorkspace,
    agentPreset: 'service-desk',
    dataFile: path.join(temp, 'bad-sessions.json'),
    inboxRetry: FAST_RETRY,
  })
  const accepted = await badGateway.inbound(message({ messageId: 'retry-me' }))
  check(accepted.duplicate === false && accepted.accepted === true, 'gateway: a message that cannot be handled is still accepted')
  check(typeof accepted.error === 'string' && accepted.error.includes('unavailable'), 'gateway: the reason is reported back', accepted.error)
  const pending = await badGateway.inbox.stats()
  check(pending.total === 1 && pending.sent === 0, 'gateway: the unhandled message stays in the queue', JSON.stringify(pending))
  check(badCtx.state.followups === 0, 'gateway: the model is not woken when the session could not be created')

  // 4) 环境恢复后，后台扫描把它补上 —— 不需要平台重投。
  badCtx.state.failTimes = 0
  await badGateway.drainInbox()
  const recovered = await badGateway.inbox.stats()
  check(recovered.sent === 1, 'gateway: the retry sweep delivers the accepted message', JSON.stringify(recovered))
  check(badCtx.state.followups === 1, 'gateway: the model is woken by the retry')

  // 5) 重试用尽：标 dead，且不会无限重试。
  const deadWorkspace = path.join(temp, 'ws-dead')
  await fs.mkdir(deadWorkspace, { recursive: true })
  const deadCtx = fakeCtx({ failTimes: 99 })
  const deadGateway = createGateway(deadCtx, {
    route: '/channel',
    workspace: deadWorkspace,
    agentPreset: 'service-desk',
    dataFile: path.join(temp, 'dead-sessions.json'),
    inboxRetry: { ...FAST_RETRY, maxAttempts: 2 },
  })
  await deadGateway.inbound(message({ messageId: 'doom' }))
  await deadGateway.drainInbox()
  await deadGateway.drainInbox()
  const dead = await deadGateway.inbox.stats()
  check(dead.dead === 1, 'gateway: an item that keeps failing becomes dead', JSON.stringify(dead))
  check(deadCtx.state.followups === 0, 'gateway: a dead item never wakes the model')

  // 6) 限流仍在受理前生效：超限要直接拒绝，不能进队列。
  const limitedCtx = fakeCtx()
  const limited = createGateway(limitedCtx, {
    route: '/channel',
    workspace,
    agentPreset: 'service-desk',
    dataFile: path.join(temp, 'limited-sessions.json'),
    maxPerMinute: 1,
    inboxRetry: FAST_RETRY,
  })
  await limited.inbound(message({ messageId: 'rate-1' }))
  let rateError
  try {
    await limited.inbound(message({ messageId: 'rate-2' }))
  } catch (error) {
    rateError = error
  }
  check(rateError?.code === 'RATE_LIMITED', 'gateway: the rate limit rejects before accepting')
  check((await limited.inbox.stats()).total === 1, 'gateway: a rejected message never enters the queue')
}

await fs.rm(temp, { recursive: true, force: true })
console.log(failed === 0 ? '\nall inbox checks passed' : `\n${failed} inbox check(s) failed`)
process.exit(failed === 0 ? 0 : 1)
