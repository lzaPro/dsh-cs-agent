// 面板的端到端冒烟：用最小 DOM 替身把面板脚本真跑一遍。
//
// 面板是一整页 HTML + 内联脚本，用模板字符串拼出来的。这类代码的 bug 有个共同点：
// 语法没错、接口没改、`node --check` 也过，但**浏览器里一点就炸** ——
// 因为某个 id 拼错了、某个字段名和端点返回的对不上、或者视图切换时读了 null。
// scripts/check-panel.mjs 只能查语法和字符串标记，查不出这些。
//
// 这里搭一层最小的 DOM（getElementById / addEventListener / fetch 转发到真网关），
// 然后模拟点击，断言页面真的渲染出了东西、按钮真的打到了端点。不是浏览器，
// 但足以抓住「字段名写错」「忘了判空」「点了没反应」这三类问题。
//
//   node cs-agent/panel-dom-smoke.mjs
import vm from 'node:vm'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createGateway } from './gateway.js'

let failed = 0
const check = (ok, label, detail = '') => {
  if (!ok) failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail === '' ? '' : `: ${detail}`}`)
}

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-panel-dom-'))

// ── 假 Host ──────────────────────────────────────────────────────────────────
const live = new Map()
function fakeCtx() {
  const workspace = {
    id: 'ws-1', sessionIds: [], attachSession: async () => {}, detachSession: async () => {},
    setTitle: async () => {},
  }
  return {
    logger: { warn: () => {} },
    workspaceRegistry: { list: () => [workspace], create: async () => workspace },
    agentDefaultModel: { currentSelection: () => ({ provider: 'test', model: 'test-model' }) },
    agents: {
      async create(options) {
        const agent = { id: options.sessionId, followup() {}, inject() {} }
        live.set(options.sessionId, agent)
        return { agent }
      },
      get: id => live.get(id),
      async resume() { throw new Error('no session') },
    },
    agentPresets: { async mount() {} },
    sessionTitle: { rename: async () => {} },
    on: () => () => {},
    effect: () => {},
  }
}

// 投递端点：前 N 次失败，用来造死信。
function replyServer(failTimes) {
  const state = { failTimes, seen: [] }
  return import('node:http').then(http => new Promise(resolve => {
    const server = http.createServer((req, res) => {
      let body = ''
      req.on('data', chunk => { body += chunk })
      req.on('end', () => {
        state.seen.push(body)
        if (state.failTimes > 0) {
          state.failTimes -= 1
          res.writeHead(503)
          res.end('nope')
          return
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{"ok":true}')
      })
    })
    server.listen(0, '127.0.0.1', () => resolve({ server, state, url: `http://127.0.0.1:${server.address().port}/reply` }))
  }))
}

// ── 最小 DOM ────────────────────────────────────────────────────────────────
function makeDom(gateway) {
  const els = new Map()
  const makeEl = id => {
    const node = {
      id, _html: '', value: '', hidden: false, textContent: '', className: '', dataset: {}, style: {}, scrollTop: 0,
      classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
      addEventListener() {}, focus() {}, setSelectionRange() {}, querySelectorAll: () => [], closest: () => null,
    }
    Object.defineProperty(node, 'innerHTML', { get: () => node._html, set: value => { node._html = String(value) } })
    return node
  }
  const element = id => {
    if (!els.has(id)) els.set(id, makeEl(id))
    return els.get(id)
  }
  const listeners = { click: [], keydown: [], input: [], change: [] }
  const alerts = []
  const errors = []
  const document = {
    getElementById: element,
    addEventListener: (type, fn) => { (listeners[type] ??= []).push(fn) },
    querySelectorAll: () => [],
    activeElement: null,
  }
  const fakeFetch = async (url, options) => {
    const response = { code: 0, body: '', writeHead(code) { this.code = code }, end(body) { this.body = body } }
    try {
      await gateway.handleHttp({
        method: options?.method ?? 'GET', url, headers: {},
        async *[Symbol.asyncIterator]() { if (options?.body !== undefined) yield Buffer.from(options.body) },
      }, response)
    } catch (error) {
      errors.push(error)
      throw error
    }
    return {
      ok: response.code >= 200 && response.code < 300,
      status: response.code,
      json: async () => (response.body === '' ? {} : JSON.parse(response.body)),
    }
  }
  const sandbox = {
    document, console, fetch: fakeFetch, URLSearchParams, location: { search: '' },
    alert: message => alerts.push(String(message)),
    confirm: () => sandbox.__confirm ?? false,
    prompt: () => null,
    setInterval: () => 0,
    setTimeout: () => 0,
    navigator: { clipboard: { writeText: async () => {} } },
    window: {},
    Promise, JSON, Math, Date, String, Number, Object, Array, Set, Map, Error, RegExp, Boolean,
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  return {
    element, listeners, alerts, errors, sandbox,
    click: async props => {
      const event = { target: { id: '', classList: { contains: () => false }, closest: () => null, ...props } }
      for (const fn of listeners.click ?? []) await fn(event)
      await settle()
    },
    input: async (id, value) => {
      element(id).value = value
      for (const fn of listeners.input ?? []) await fn({ target: { id, value } })
      await settle()
    },
    change: async (id, value) => {
      element(id).checked = value
      for (const fn of listeners.change ?? []) await fn({ target: { id, checked: value } })
      await settle()
    },
  }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 60))

async function panelScript(gateway) {
  const response = { code: 0, body: '', writeHead(code) { this.code = code }, end(body) { this.body = body } }
  await gateway.handleHttp({ method: 'GET', url: '/channel/panel', headers: {} }, response)
  if (response.code !== 200) throw new Error(`panel responded ${response.code}`)
  return response.body.split('<script>')[1]?.split('</script>')[0]
}

function run(dom, script) {
  try {
    new vm.Script(script).runInContext(dom.sandbox)
    return true
  } catch (error) {
    console.log(`  脚本执行出错: ${error.message}`)
    return false
  }
}

async function waitFor(fn, label) {
  for (let index = 0; index < 40; index += 1) {
    if (await fn()) return true
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  console.log(`  等待超时: ${label}`)
  return false
}

// ── 场景一：空库，运维视图要能自己站住 ──────────────────────────────────────
{
  const workspace = path.join(temp, 'ws-1')
  await fs.mkdir(workspace, { recursive: true })
  const gateway = createGateway(fakeCtx(), {
    route: '/channel', workspace, agentPreset: 'service-desk',
    dataFile: path.join(temp, 'gw-1-sessions.json'),
    outbox: path.join(temp, 'gw-1-outbox.jsonl'),
  })
  const script = await panelScript(gateway)
  const dom = makeDom(gateway)
  check(run(dom, script), 'panel script runs without throwing')
  await settle()
  check(dom.element('list').innerHTML.includes('还没有客户会话'), 'an empty workspace shows the empty state')

  await dom.click({ id: 'ops-open' })
  const pane = dom.element('pane').innerHTML
  check(pane.includes('运维') && pane.includes('健康'), 'the ops view opens from the toolbar')
  check(pane.includes('入站积压') && pane.includes('出站积压'), 'the health card lists both queues')
  check(pane.includes('未启用'), 'a gateway without a reply webhook reports the outbox as disabled')
  check(pane.includes('死信') && pane.includes('没有'), 'the dead-letter card says there is nothing')
  check(pane.includes('群聊') && pane.includes('天归档'), 'the retention card shows the current limits', '')
  check(pane.includes('最近审计'), 'the audit card is present')
  check(dom.errors.length === 0, 'no request failed while rendering the ops view', String(dom.errors.length))

  // 模一次"看计划"：端点必须真的被调到。
  await dom.click({ id: 'ops-scan' })
  const scanned = dom.element('pane').innerHTML
  check(scanned.includes('将归档') && scanned.includes('将清除'), 'scanning renders the retention plan')

  // 没有到期会话时不该给出"执行"按钮。
  check(!scanned.includes('id="ops-purge"'), 'an empty plan offers no purge button')

  // 返回会话列表。
  await dom.click({ id: 'back' })
  check(dom.element('pane').innerHTML.includes('选择左侧会话'), 'back returns to the conversation list')
  check(dom.errors.length === 0, 'no request failed during the whole flow', String(dom.errors.length))
  await gateway.flushArchives()
}

// ── 场景二：有死信，重放要真的把消息推出去 ──────────────────────────────────
{
  const endpoint = await replyServer(2)
  const workspace = path.join(temp, 'ws-2')
  await fs.mkdir(workspace, { recursive: true })
  const gateway = createGateway(fakeCtx(), {
    route: '/channel', workspace, agentPreset: 'service-desk',
    dataFile: path.join(temp, 'gw-2-sessions.json'),
    outbox: path.join(temp, 'gw-2-outbox.jsonl'),
    replyWebhook: endpoint.url,
    outboxRetry: { baseMs: 0, factor: 1, maxMs: 0, maxAttempts: 2, graceMs: 0, sweepMs: 60000, leaseMs: 0, jitter: false },
  })
  const first = await gateway.inbound({ channel: 'qq', senderId: 'u1', text: '在吗', messageId: 'pm-1' })
  await gateway.observe(
    { id: first.sessionId },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '在的' }] } } },
  )
  await gateway.observe({ id: first.sessionId }, { type: 'turn/end', data: { turn: 1, reason: 'stop' } })
  await gateway.flushArchives()
  // 首发失败 → 再试一次 → 到上限变死信。
  await gateway.drainOutbox()
  await new Promise(resolve => setTimeout(resolve, 20))
  await gateway.drainOutbox()
  const dead = await gateway.outbox.listDead(5)
  check(dead.length === 1, 'a reply that ran out of retries becomes a dead letter', String(dead.length))

  const script = await panelScript(gateway)
  const dom = makeDom(gateway)
  check(run(dom, script), 'panel script runs on a gateway with a dead letter')
  await settle()
  await dom.click({ id: 'ops-open' })
  const pane = dom.element('pane').innerHTML
  check(pane.includes('在的'), 'the dead letter shows the reply text')
  check(pane.includes('data-replay='), 'the dead letter offers a replay button')
  check(pane.includes('试了 2 次'), 'the dead letter shows how many attempts it took')

  // 重放：点击之后消息应该真的送达，死信清零。
  const replayTarget = `outbox:${dead[0].idempotencyKey}`
  await dom.click({ closest: selector => (selector === '[data-replay]' ? { dataset: { replay: replayTarget } } : null) })
  check(dom.alerts.length > 0, 'replaying reports back to the operator', dom.alerts.join(' / '))
  await gateway.drainOutbox()
  const stats = await gateway.outbox.stats()
  check(stats.sent === 1 && stats.dead === 0, 'the replayed reply reaches the customer',
    `sent=${stats.sent} dead=${stats.dead}`)
  check(endpoint.state.seen.length === 3, 'the reply endpoint saw exactly three attempts', String(endpoint.state.seen.length))

  // 审计卡片应该看得到这次操作。
  await dom.click({ id: 'ops-audit' })
  check(dom.element('pane').innerHTML.includes('replay'), 'the audit card lists the replay')
  check(dom.errors.length === 0, 'no request failed during the replay flow', String(dom.errors.length))

  await new Promise(resolve => endpoint.server.close(resolve))
  await gateway.flushArchives()
}

await fs.rm(temp, { recursive: true, force: true })
console.log(failed === 0 ? '\nall panel checks passed' : `\n${failed} panel check(s) failed`)
process.exit(failed === 0 ? 0 : 1)
