// 用量与成本的冒烟测试。
//
//   node cs-agent/usage-smoke.mjs            # 价格函数 + json 存储 + 网关集成
//   DSH_DB=1 node cs-agent/usage-smoke.mjs   # 额外跑数据库实现（需要 ./scripts/db-up.sh）
//
// 这一层要回答三个问题：
//   1. 价格配置能算对钱吗（含缓存价缺省、前缀匹配、小数不要漂）；
//   2. 一轮里换了模型，成本是不是按各自单价分别算的（乘一个平均价是错的）；
//   3. 报表里"没配价格"和"配了但用量是 0"能不能区分（都显示 $0.00 等于什么都没说）。
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createStore } from './store.js'
import { createGateway } from './gateway.js'
import { EMPTY_PRICING, costMicros, formatCost, parsePricing, priceFor, pricingReady } from './pricing.js'

let failed = 0
const check = (ok, label, detail = '') => {
  if (!ok) failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail === '' ? '' : `: ${detail}`}`)
}
const throws = (run, matcher, label) => {
  try {
    run()
    check(false, label, 'no error thrown')
  } catch (error) {
    check(matcher.test(error.message), label, error.message)
  }
}

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-usage-'))
const dbEnabled = ['1', 'on', 'true', 'yes'].includes(String(process.env.DSH_DB ?? '').toLowerCase())
const FAST_RETRY = { baseMs: 20, factor: 1, maxMs: 20, maxAttempts: 3, graceMs: 0, sweepMs: 10, leaseMs: 5000, jitter: false }

// --- 价格函数（纯逻辑，先把钱算对）-------------------------------------------
{
  check(parsePricing(undefined).models !== undefined && Object.keys(parsePricing(undefined).models).length === 0, 'pricing: an empty config means no prices')
  check(parsePricing(null) === EMPTY_PRICING, 'pricing: null is the same as missing')

  // 单价写的是"每 100 万 token 多少美元"，缓存价没写就按输入价 —— 宁可高估。
  const pricing = parsePricing({
    models: {
      alpha: { input: 1, output: 2 },
      'beta-preview': { input: 10 },
      '*': { input: 0.5, output: 0.5, cacheRead: 0.05 },
    },
  })
  check(pricing.models.alpha.cacheRead === 1 && pricing.models.alpha.cacheWrite === 1, 'pricing: cache prices default to the input price')
  check(pricing.models['beta-preview'].output === 10, 'pricing: output defaults from input when only one is given')

  throws(() => parsePricing({ models: { x: { input: -1 } } }), /must be a non-negative number/, 'pricing: a negative price is refused')
  throws(() => parsePricing({ models: { x: { input: '1' } } }), /must be a non-negative number/, 'pricing: a string price is refused')
  throws(() => parsePricing({ models: { x: {} } }), /needs at least an "input" or "output"/, 'pricing: an empty price row is refused')
  throws(() => parsePricing({ models: [] }), /models must be an object/, 'pricing: models must be an object')

  // 精确 > 最长前缀 > `*`。
  check(priceFor(pricing, 'alpha') === pricing.models.alpha, 'pricing: the exact model id wins')
  check(priceFor(pricing, 'beta-preview-2024-08') === pricing.models['beta-preview'], 'pricing: a dated model id matches by prefix')
  check(priceFor(pricing, 'gamma') === pricing.models['*'], 'pricing: an unknown model falls back to the default row')
  check(priceFor(parsePricing(undefined), 'anything') === undefined, 'pricing: no prices at all returns undefined')

  // 1e6 token × 0.28 美元/1e6 = 0.28 美元 = 280000 micros。
  check(costMicros({ inputTokens: 1_000_000 }, parsePricing({ models: { m: { input: 0.28 } } }).models.m) === 280_000, 'cost: a million input tokens costs the quoted price')
  check(costMicros({ inputTokens: 1000, outputTokens: 500, cacheReadTokens: 200 }, pricing.models.alpha) === 2200, 'cost: every token class is priced')
  check(costMicros({ inputTokens: 1000 }, undefined) === 0, 'cost: no price means zero, not a guess')
  check(costMicros({ inputTokens: 3 }, { input: 0.333333, output: 0, cacheRead: 0, cacheWrite: 0 }) === 1, 'cost: fractional prices round to whole micros')

  check(pricingReady(pricing) === true, 'pricing: a real price table is ready')
  check(pricingReady(parsePricing({ models: { m: { input: 0, output: 0 } } })) === false, 'pricing: an all-zero table counts as not configured')

  check(formatCost(0) === '$0.00', 'cost: zero formats as $0.00', formatCost(0))
  check(formatCost(4200) === '$0.0042', 'cost: sub-cent amounts keep four decimals', formatCost(4200))
  check(formatCost(1_200_000) === '$1.20', 'cost: larger amounts use two decimals', formatCost(1_200_000))
}

// --- 存储层契约：两套实现跑同一份 -------------------------------------------
let prefix = 'local'

async function contract(store, label) {
  const key = `${prefix}:cost`
  await store.save({ key, sessionId: 's-1', channel: 'qq', senderId: 'u-1', mode: 'ai', createdAt: new Date().toISOString() })

  const first = await store.bumpUsage(key, { inputTokens: 1000, outputTokens: 500, costMicros: 2200 })
  check(first.costMicros === 2200, `${label}: the cost is recorded`, JSON.stringify(first.costMicros))
  const second = await store.bumpUsage(key, { inputTokens: 100, outputTokens: 50, costMicros: 2000 })
  check(second.costMicros === 4200, `${label}: the cost accumulates on the same day`, String(second.costMicros))

  const rows = await store.listUsage({ key })
  check(rows.length === 1, `${label}: one usage row per day and conversation`, String(rows.length))
  check(rows[0].costMicros === 4200 && rows[0].inputTokens === 1100, `${label}: the report carries cost and tokens`, JSON.stringify(rows[0]))

  const other = `${prefix}:other`
  await store.save({ key: other, sessionId: 's-2', channel: 'qq', senderId: 'u-2', mode: 'ai', createdAt: new Date().toISOString() })
  await store.bumpUsage(other, { turns: 2, costMicros: 700 })
  const all = await store.listUsage({ days: 1 })
  check(all.length === 2, `${label}: the report covers every conversation by default`, String(all.length))
  check(all.every(row => typeof row.costMicros === 'number'), `${label}: a row without pricing still reports a number`)
  const scoped = await store.listUsage({ key, days: 1 })
  check(scoped.length === 1 && scoped[0].key === key, `${label}: the report can be scoped to one conversation`)

  // 窗口外的行不该出现：造一条很久以前的用量。
  await store.bumpUsage(key, { turns: 5, day: '2000-01-01', costMicros: 1 })
  const recent = await store.listUsage({ key, days: 7 })
  check(recent.every(row => row.day !== '2000-01-01'), `${label}: rows outside the window are dropped`)
  const everything = await store.listUsage({ key })
  check(everything.some(row => row.day === '2000-01-01'), `${label}: no window means no filtering`)

  // 消息上也能带模型与成本（逐条外发模式要靠它）。
  await store.saveMessage(key, { role: 'assistant', content: '带成本的一条', model: 'alpha', provider: 'p', costMicros: 2200 })
  const messages = await store.listMessages(key, 5)
  const withCost = messages.find(entry => entry.content === '带成本的一条')
  check(withCost?.model === 'alpha' && withCost?.costMicros === 2200, `${label}: a message keeps its model and cost`, JSON.stringify(withCost?.costMicros))
}

{
  const store = createStore({ kind: 'json', dataFile: path.join(temp, 'json-sessions.json'), seenFile: path.join(temp, 'json-seen.json') })
  await store.load()
  await contract(store, 'json')
  await store.close()
}

if (!dbEnabled) {
  console.log('SKIP database usage checks (set DSH_DB=1 to run them)')
} else {
  const { query, closePool } = await import('./db/pool.mjs')
  prefix = `usage-smoke-${process.pid}-${Date.now()}`
  try {
    const store = createStore({ kind: 'postgres' })
    await store.load()
    await contract(store, 'postgres')

    const daily = await query(
      `select u.cost_micros, u.input_tokens, u.output_tokens
         from usage_daily u join conversations c on c.id = u.conversation_id
        where c.external_key = $1 and u.day >= current_date - 1`,
      [`${prefix}:cost`],
    )
    check(daily.rows.length === 1, 'postgres: cost lands in usage_daily', String(daily.rows.length))
    check(Number(daily.rows[0].cost_micros) === 4200, 'postgres: the stored cost matches', String(daily.rows[0].cost_micros))

    const archived = await query(
      `select m.model, m.provider, m.cost_micros
         from messages m join conversations c on c.id = m.conversation_id
        where c.external_key = $1 and m.model is not null`,
      [`${prefix}:cost`],
    )
    check(archived.rows.length === 1 && archived.rows[0].model === 'alpha', 'postgres: messages keep the model that answered')
    check(Number(archived.rows[0].cost_micros) === 2200, 'postgres: messages keep their own cost')
  } finally {
    await query('delete from conversations where external_key like $1', [`${prefix}:%`])
    const left = await query('select count(*)::int as count from usage_daily u join conversations c on c.id = u.conversation_id where c.external_key like $1', [`${prefix}:%`])
    check(left.rows[0].count === 0, 'postgres: usage rows are cleaned up with the conversation', String(left.rows[0].count))
    await closePool()
  }
}

// --- 网关集成：成本按片段所属的模型算 ---------------------------------------
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
  senderId: 'u-cost',
  text: '这个月花了多少钱',
  messageId: `m-${Math.random().toString(36).slice(2, 10)}`,
  ...extra,
})

const resOf = () => ({ code: 0, body: '', writeHead(code) { this.code = code }, end(payload) { this.body = payload } })

const PRICING = {
  models: {
    alpha: { input: 1, output: 2 },
    beta: { input: 10, output: 20 },
    '*': { input: 0.5, output: 0.5 },
  },
}

{
  const workspace = path.join(temp, 'ws')
  await fs.mkdir(workspace, { recursive: true })
  const ctx = fakeCtx()
  const gateway = createGateway(ctx, {
    route: '/channel',
    workspace,
    agentPreset: 'service-desk',
    dataFile: path.join(temp, 'gw-sessions.json'),
    inboxRetry: FAST_RETRY,
    pricing: PRICING,
  })

  const first = await gateway.inbound(message({ messageId: 'm-cost-1' }))

  // 一轮里两个片段、两个模型：alpha 2200 micros + beta 2000 micros。
  gateway.observe({ id: first.sessionId }, {
    type: 'assistant/message',
    data: {
      message: { content: [{ type: 'text', text: '让我查一下' }], source: { kind: 'model', provider: 'p1', model: 'alpha' } },
      usage: { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 200 },
    },
  })
  gateway.observe({ id: first.sessionId }, {
    type: 'assistant/message',
    data: {
      message: { content: [{ type: 'text', text: '大概四块二' }], source: { kind: 'model', provider: 'p2', model: 'beta' } },
      usage: { inputTokens: 100, outputTokens: 50 },
    },
  })
  gateway.observe({ id: first.sessionId }, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  await gateway.flushArchives()

  const totals = await gateway.listUsage({ key: first.key })
  check(totals.length === 1, 'gateway: one usage row for the turn', String(totals.length))
  check(totals[0].costMicros === 4200, 'gateway: each fragment is priced by its own model', String(totals[0].costMicros))
  check(totals[0].inputTokens === 1100 && totals[0].outputTokens === 550, 'gateway: tokens still add up across fragments', JSON.stringify(totals[0]))

  // 未知模型走 `*`：0.5 美元/1e6 × 1000 = 500 micros。
  const second = await gateway.inbound(message({ senderId: 'u-cost-2', messageId: 'm-cost-2' }))
  gateway.observe({ id: second.sessionId }, {
    type: 'assistant/message',
    data: {
      message: { content: [{ type: 'text', text: '不知道什么模型' }], source: { kind: 'model', provider: 'p3', model: 'gamma' } },
      usage: { inputTokens: 1000 },
    },
  })
  gateway.observe({ id: second.sessionId }, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  await gateway.flushArchives()
  const fallback = await gateway.listUsage({ key: second.key })
  check(fallback[0]?.costMicros === 500, 'gateway: an unknown model uses the default price', String(fallback[0]?.costMicros))

  // `/usage` 端点：让人能直接看到总数与格式化好的金额。
  const res = resOf()
  await gateway.handleHttp({ method: 'GET', url: '/channel/usage?days=7', headers: {} }, res)
  check(res.code === 200, 'gateway: the usage endpoint answers', String(res.code))
  const body = JSON.parse(res.body)
  check(body.days === 7 && Array.isArray(body.rows), 'gateway: the usage report has a window and rows')
  check(body.pricing.configured === true, 'gateway: the report says pricing is configured')
  check(body.totals.costMicros === 4700 && body.totals.cost === '$0.0047', 'gateway: totals add up across conversations', JSON.stringify(body.totals))
  check(body.rows.every(row => typeof row.cost === 'string' && row.cost.startsWith('$')), 'gateway: every row carries a formatted cost')

  const scoped = resOf()
  await gateway.handleHttp({ method: 'GET', url: `/channel/usage?days=7&key=${encodeURIComponent(first.key)}`, headers: {} }, scoped)
  const scopedBody = JSON.parse(scoped.body)
  check(scopedBody.rows.length === 1 && scopedBody.totals.costMicros === 4200, 'gateway: the report can be scoped to one conversation', JSON.stringify(scopedBody.totals))

  const wide = resOf()
  await gateway.handleHttp({ method: 'GET', url: '/channel/usage?days=abc', headers: {} }, wide)
  check(JSON.parse(wide.body).days === 30, 'gateway: a bad window falls back to 30 days')
}

// 没配价格时必须明说"未配置"，而不是显示 $0.00 让人以为算过了。
{
  const workspace = path.join(temp, 'ws2')
  await fs.mkdir(workspace, { recursive: true })
  const gateway = createGateway(fakeCtx(), {
    route: '/plain',
    workspace,
    agentPreset: 'service-desk',
    dataFile: path.join(temp, 'plain-sessions.json'),
    inboxRetry: FAST_RETRY,
  })
  const first = await gateway.inbound(message({ senderId: 'u-plain', messageId: 'm-plain-1' }))
  gateway.observe({ id: first.sessionId }, {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text: '没配价格' }] }, usage: { inputTokens: 1000, outputTokens: 100 } },
  })
  gateway.observe({ id: first.sessionId }, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  await gateway.flushArchives()

  const res = resOf()
  await gateway.handleHttp({ method: 'GET', url: '/plain/usage', headers: {} }, res)
  const body = JSON.parse(res.body)
  check(body.pricing.configured === false, 'gateway: without prices the report says so')
  check(body.totals.turns === 1 && body.totals.costMicros === 0, 'gateway: without prices the cost is zero', JSON.stringify(body.totals))
  check(body.totals.inputTokens === 1000, 'gateway: tokens are counted even without prices')
}

// 逐条外发模式：token 与成本挂在消息上，日报只计轮数（不能算两遍）。
{
  const workspace = path.join(temp, 'ws3')
  await fs.mkdir(workspace, { recursive: true })
  const gateway = createGateway(fakeCtx(), {
    route: '/all',
    workspace,
    agentPreset: 'service-desk',
    dataFile: path.join(temp, 'all-sessions.json'),
    inboxRetry: FAST_RETRY,
    forward: 'all',
    pricing: PRICING,
  })
  const first = await gateway.inbound(message({ senderId: 'u-all', messageId: 'm-all-1' }))
  gateway.observe({ id: first.sessionId }, {
    type: 'assistant/message',
    data: {
      message: { content: [{ type: 'text', text: '片段一' }], source: { kind: 'model', provider: 'p1', model: 'alpha' } },
      usage: { inputTokens: 1000, outputTokens: 500 },
    },
  })
  gateway.observe({ id: first.sessionId }, {
    type: 'assistant/message',
    data: {
      message: { content: [{ type: 'text', text: '片段二' }], source: { kind: 'model', provider: 'p1', model: 'alpha' } },
      usage: { inputTokens: 1000, outputTokens: 500 },
    },
  })
  gateway.observe({ id: first.sessionId }, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  await gateway.flushArchives()

  const daily = await gateway.listUsage({ key: first.key })
  check(daily[0]?.turns === 1 && daily[0]?.costMicros === 0, 'gateway: the all-fragments mode only counts turns in the daily row', JSON.stringify(daily[0]))

  const messages = await gateway.listMessages(first.key, 10)
  const replies = messages.filter(entry => entry.role === 'assistant')
  check(replies.length === 2, 'gateway: every fragment is archived on its own', String(replies.length))
  // alpha: 1000*1 + 500*2 = 2000 micros，两条各 2000。
  check(replies.every(entry => entry.costMicros === 2000 && entry.model === 'alpha'), 'gateway: each fragment carries its own cost', JSON.stringify(replies.map(entry => entry.costMicros)))
}

if (failed > 0) {
  console.error(`\n${failed} usage check(s) failed`)
  process.exit(1)
}
console.log('\nall usage checks passed')
