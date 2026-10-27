// 消息与用量落库的冒烟测试。
//
//   node cs-agent/message-smoke.mjs            # json 存储 + 网关集成
//   DSH_DB=1 node cs-agent/message-smoke.mjs   # 额外跑数据库实现（需要 ./scripts/db-up.sh）
//
// 这一层要回答三个问题：
//   1. 客户说过的话、模型回过的话，事后还能查出来（不是只活在 DSH 的会话目录里）；
//   2. 每一轮的 token 用量能按天累计（不然没法算成本）；
//   3. 归档失败不能影响消息处理 —— 存历史是旁路，不是主流程。
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createStore } from './store.js'
import { createGateway } from './gateway.js'

let failed = 0
const check = (ok, label, detail = '') => {
  if (!ok) failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail === '' ? '' : `: ${detail}`}`)
}

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-message-'))
const dbEnabled = ['1', 'on', 'true', 'yes'].includes(String(process.env.DSH_DB ?? '').toLowerCase())
const FAST_RETRY = { baseMs: 20, factor: 1, maxMs: 20, maxAttempts: 3, graceMs: 0, sweepMs: 10, leaseMs: 50, jitter: false }

function fakeCtx(options = {}) {
  const live = new Map()
  const state = { followups: 0, injected: 0 }
  const makeAgent = id => ({
    id,
    followup: () => { state.followups += 1 },
    inject: () => { state.injected += 1 },
  })
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

const message = (extra = {}) => ({
  channel: 'qq',
  senderId: 'u-1',
  text: '我的容器起不来',
  messageId: `m-${Math.random().toString(36).slice(2, 10)}`,
  ...extra,
})

const resOf = () => ({ code: 0, body: '', writeHead(code) { this.code = code }, end(payload) { this.body = payload } })

// --- 存储层契约：两套实现跑同一份 -------------------------------------------
let prefix = 'local'

async function contract(store, label) {
  const key = `${prefix}:contract`
  await store.save({ key, sessionId: 's-1', channel: 'qq', senderId: 'u-1', mode: 'ai', createdAt: new Date().toISOString() })

  const saved = await store.saveMessage(key, {
    role: 'user',
    content: '第一条',
    platformMsgId: `${prefix}-1`,
    traceId: 'trace-1',
  })
  check(saved !== false, `${label}: a message is stored`)
  await store.saveMessage(key, { role: 'assistant', content: '第二条', outputTokens: 12 })
  await store.saveMessage(key, { role: 'user', content: '第三条' })

  const messages = await store.listMessages(key, 50)
  check(messages.length === 3, `${label}: all messages are readable`, String(messages.length))
  check(messages[0].content === '第一条' && messages[2].content === '第三条', `${label}: messages come back oldest first`)
  check(messages[0].role === 'user' && messages[1].role === 'assistant', `${label}: the role is kept`)
  check(messages[1].outputTokens === 12, `${label}: token counts are kept`, String(messages[1].outputTokens))

  const limited = await store.listMessages(key, 2)
  check(limited.length === 2 && limited[1].content === '第三条', `${label}: the limit keeps the newest messages`)

  // 别的会话的消息不能串进来。
  const other = `${prefix}:other`
  await store.save({ key: other, sessionId: 's-2', channel: 'qq', senderId: 'u-2', mode: 'ai', createdAt: new Date().toISOString() })
  await store.saveMessage(other, { role: 'user', content: '别人的消息' })
  const mine = await store.listMessages(key, 50)
  check(mine.every(entry => entry.content !== '别人的消息'), `${label}: messages are scoped to one conversation`)

  const usage = await store.bumpUsage(key, { inputTokens: 100, outputTokens: 20, cacheReadTokens: 50, cacheWriteTokens: 5 })
  check(usage.turns === 1 && Number(usage.inputTokens) === 100, `${label}: usage is recorded`, JSON.stringify(usage))
  const again = await store.bumpUsage(key, { inputTokens: 100, outputTokens: 20 })
  check(Number(again.turns) === 2 && Number(again.inputTokens) === 200, `${label}: usage accumulates on the same day`, JSON.stringify(again))

  // 会话还没有对应行时存消息，不能炸；只是没存上。
  const orphan = await store.saveMessage(`${prefix}:missing`, { role: 'user', content: '无主' })
  check(orphan !== true, `${label}: a message for an unknown conversation is not stored`)
}

{
  const store = createStore({ kind: 'json', dataFile: path.join(temp, 'json-sessions.json'), seenFile: path.join(temp, 'json-seen.json') })
  await store.load()
  await contract(store, 'json')
  // 半行 JSON（进程写到一半崩了）不该让整份历史读不出来。
  const messagesFile = path.join(temp, 'json-sessions-messages.jsonl')
  await fs.appendFile(messagesFile, '{"key":"broken"', 'utf8')
  await fs.appendFile(messagesFile, '\n', 'utf8')
  const afterBroken = await store.listMessages(`${prefix}:contract`, 50)
  check(afterBroken.length === 3, 'json: a half-written line does not break history', String(afterBroken.length))
  await store.close()
}

if (!dbEnabled) {
  console.log('SKIP database message checks (set DSH_DB=1 to run them)')
} else {
  const { query, closePool } = await import('./db/pool.mjs')
  prefix = `msg-smoke-${process.pid}-${Date.now()}`
  try {
    const store = createStore({ kind: 'postgres' })
    await store.load()
    await contract(store, 'postgres')

    // 数据库里真的落成了行，而且列对得上。
    const rows = await query(
      `select m.role, m.content, m.platform_msg_id, m.trace_id
         from messages m join conversations c on c.id = m.conversation_id
        where c.external_key = $1 order by m.id`,
      [`${prefix}:contract`],
    )
    check(rows.rows.length === 3, 'postgres: rows land in the messages table', String(rows.rows.length))
    check(rows.rows[0].platform_msg_id === `${prefix}-1` && rows.rows[0].trace_id === 'trace-1', 'postgres: platform id and trace id are stored')

    const daily = await query(
      `select u.day::text as day, u.turns, u.input_tokens, u.output_tokens, u.cache_read_tokens
         from usage_daily u join conversations c on c.id = u.conversation_id
        where c.external_key = $1`,
      [`${prefix}:contract`],
    )
    check(daily.rows.length === 1, 'postgres: one usage row per day and conversation', String(daily.rows.length))
    check(Number(daily.rows[0].turns) === 2 && Number(daily.rows[0].input_tokens) === 200, 'postgres: usage counters add up', JSON.stringify(daily.rows[0]))
  } finally {
    const cleaned = await query(
      'delete from conversations where external_key like $1',
      [`${prefix}:%`],
    )
    const left = await query('select count(*)::int as count from messages m join conversations c on c.id = m.conversation_id where c.external_key like $1', [`${prefix}:%`])
    check(left.rows[0].count === 0, 'postgres: test rows are cleaned up', `${cleaned.rowCount} conversations removed`)
    await closePool()
  }
}

// --- 网关集成：消息真的从入站/回复路径流进存档 ------------------------------
{
  const workspace = path.join(temp, 'ws')
  await fs.mkdir(workspace, { recursive: true })
  const ctx = fakeCtx()
  const dataFile = path.join(temp, 'gw-sessions.json')
  const gateway = createGateway(ctx, {
    route: '/channel',
    workspace,
    agentPreset: 'service-desk',
    dataFile,
    inboxRetry: FAST_RETRY,
  })

  // 1) 客户消息进档。
  const first = await gateway.inbound(message({ text: '你好，扣了两次钱', messageId: 'm-user-1' }))
  const afterUser = await gateway.listMessages(first.key, 50)
  check(afterUser.length === 1 && afterUser[0].role === 'user', 'gateway: the customer message is archived', JSON.stringify(afterUser.map(m => m.role)))
  check(afterUser[0].content.includes('扣了两次钱'), 'gateway: the archived text is the one that was sent')
  check(afterUser[0].platformMsgId === 'm-user-1', 'gateway: the platform message id is archived')
  check(typeof afterUser[0].traceId === 'string' && afterUser[0].traceId.length === 12, 'gateway: the trace id is archived', String(afterUser[0].traceId))

  // 2) 模型回复进档，用量按天累计。
  gateway.observe({ id: first.sessionId }, {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text: '我看下订单' }] }, usage: { inputTokens: 300, outputTokens: 40, cacheReadTokens: 200 } },
  })
  gateway.observe({ id: first.sessionId }, {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text: '已经帮你退款了' }] }, usage: { inputTokens: 100, outputTokens: 10 } },
  })
  gateway.observe({ id: first.sessionId }, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  await gateway.flushArchives()
  const afterReply = await gateway.listMessages(first.key, 50)
  const assistant = afterReply.filter(entry => entry.role === 'assistant')
  check(assistant.length === 1, 'gateway: one reply is archived per turn, not per message fragment', String(assistant.length))
  check(assistant[0].content === '我看下订单\n\n已经帮你退款了', 'gateway: the archived reply is what the customer saw', JSON.stringify(assistant[0].content))

  const usageFile = path.join(temp, 'gw-sessions-usage.json')
  const usage = JSON.parse(await fs.readFile(usageFile, 'utf8'))
  const now = new Date()
  const pad = value => String(value).padStart(2, '0')
  const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
  const row = usage[`${today}|${first.key}`]
  check(row !== undefined, 'gateway: usage is recorded for the day')
  check(row.turns === 1 && row.inputTokens === 400 && row.outputTokens === 50 && row.cacheReadTokens === 200, 'gateway: usage adds up across fragments', JSON.stringify(row))

  // 3) `/messages` 端点把历史吐出来。
  const res = resOf()
  await gateway.handleHttp({ method: 'GET', url: `/channel/messages?key=${encodeURIComponent(first.key)}`, headers: {} }, res)
  check(res.code === 200, 'gateway: the messages endpoint answers', String(res.code))
  const body = JSON.parse(res.body)
  check(body.key === first.key && body.messages.length === 2, 'gateway: the endpoint returns the whole history', String(body.messages?.length))
  const missing = resOf()
  await gateway.handleHttp({ method: 'GET', url: '/channel/messages', headers: {} }, missing)
  check(missing.code === 400, 'gateway: the messages endpoint needs a key', String(missing.code))

  // 4) 人工接管时客户消息也要进档（管理员能看到他接手前的对话）。
  const humanKey = await (async () => {
    const held = await gateway.inbound(message({ senderId: 'u-human', text: '转人工', messageId: 'm-human-1' }))
    await gateway.setMode(held.key, 'human')
    await gateway.inbound(message({ senderId: 'u-human', text: '有人在吗', messageId: 'm-human-2' }))
    return held.key
  })()
  check(ctx.state.injected >= 1, 'gateway: the held message goes to the admin, not the model')
  const held = await gateway.listMessages(humanKey, 50)
  check(held.filter(entry => entry.role === 'user').length === 2, 'gateway: held messages are archived too', String(held.length))

  // 5) 归档失败不影响消息处理：存储层炸了，消息照常交给模型。
  const brokenStore = {
    ...gateway.store,
    saveMessage: async () => { throw new Error('archive is down') },
  }
  let brokeGateway
  const warnings = []
  brokeGateway = createGateway(fakeCtx({ warn: text => warnings.push(text) }), {
    route: '/channel2',
    workspace,
    agentPreset: 'service-desk',
    dataFile: path.join(temp, 'gw-broken-sessions.json'),
    inboxRetry: FAST_RETRY,
  })
  // 直接替换底层存储，模拟"归档写不进去"。
  Object.assign(brokeGateway.store, { saveMessage: brokenStore.saveMessage })
  const ok = await brokeGateway.inbound(message({ senderId: 'u-broken', text: '归档坏了也要回我', messageId: 'm-broken-1' }))
  check(ok.duplicate === false && ok.error === undefined, 'gateway: a failing archive does not fail the message', JSON.stringify(ok).slice(0, 60))
  check(warnings.some(text => text.includes('message archive failed')), 'gateway: the archive failure is logged')
}

await fs.rm(temp, { recursive: true, force: true })
console.log(failed === 0 ? '\nall message checks passed' : `\n${failed} message check(s) failed`)
process.exit(failed === 0 ? 0 : 1)
