// Gateway smoke test with a fake Host context: no DSH process required.
// Run with: node cs-agent/gateway-smoke.mjs
import { promises as fs, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { Readable } from 'node:stream'
import { zstdCompressSync } from 'node:zlib'
import os from 'node:os'
import path from 'node:path'
import { apply, createGateway } from './gateway.js'

// 这套用例靠"一个独立的数据文件"隔离每条用例；换成数据库存储后所有实例共享
// 同一张表，前面的会话会串到后面的用例里。数据库那条路径由 store-smoke.mjs 验。
const configuredStore = process.env.DSH_CS_STORE ?? ''
if (configuredStore !== '' && configuredStore !== 'json') {
  console.error(
    'gateway-smoke runs many isolated gateways against one data file; unset DSH_CS_STORE (default json) and use cs-agent/store-smoke.mjs for the database path',
  )
  process.exit(2)
}

let failed = 0
const check = (ok, label, detail = '') => {
  if (!ok) failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail === '' ? '' : `: ${detail}`}`)
}

/** A Host stand-in that records what the gateway asks of it. */
function fakeCtx() {
  const created = []
  const resumed = []
  const followed = []
  const injected = []
  const listeners = []
  const live = new Map()
  const attached = []
  const workspaces = []
  return {
    created, resumed, followed, injected, listeners, live, attached, workspaces,
    workspaceRegistry: {
      list: () => workspaces.map(record => ({
        get sessionIds() { return record.sessions },
        detachSession: async id => { record.sessions = record.sessions.filter(item => item !== id) },
      })),
      create: async (path) => {
        const record = { path, title: undefined, sessions: [] }
        workspaces.push(record)
        return {
          id: `ws-${workspaces.length}`,
          get sessionIds() { return record.sessions },
          attachSession: async (id) => { record.sessions.push(id); attached.push(id) },
          detachSession: async (id) => { record.sessions = record.sessions.filter(item => item !== id) },
          setTitle: async (title) => { record.title = title },
        }
      },
    },
    logger: { warn: () => {} },
    agentDefaultModel: { currentSelection: () => ({ provider: 'test', model: 'test-model' }) },
    agents: {
      async create(options) {
        created.push(options)
        const agent = {
          id: options.sessionId,
          followup: (message) => followed.push({ sessionId: options.sessionId, message }),
          inject: (message) => injected.push({ sessionId: options.sessionId, message }),
        }
        live.set(options.sessionId, agent)
        return { agent }
      },
      get: (id) => live.get(id),
      async resume({ resumeSessionId }) {
        resumed.push(resumeSessionId)
        const agent = {
          id: resumeSessionId,
          followup: (message) => followed.push({ sessionId: resumeSessionId, message }),
          inject: (message) => injected.push({ sessionId: resumeSessionId, message }),
        }
        live.set(resumeSessionId, agent)
        return { agent }
      },
    },
    agentPresets: { async mount() {} },
    sessionTitle: { rename() {} },
    on: (event, handler) => { listeners.push([event, handler]) },
  }
}

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'gateway-'))
const dataFile = path.join(temp, 'sessions.json')
const outbox = path.join(temp, 'outbox.jsonl')

const ctx = fakeCtx()
const privateDir = path.join(temp, 'private')
const groupDir = path.join(temp, 'group')
const gateway = createGateway(ctx, {
  route: '/channel',
  privateWorkspace: privateDir,
  groupWorkspace: groupDir,
  agentPreset: 'service-desk',
  dataFile,
  outbox,
  forward: 'final',
})

const first = await gateway.inbound({ channel: 'qq', senderId: 'u1', text: '扣了9.9怎么回事' })
check(first.key === 'qq:u1', 'private key', first.key)
check(ctx.created.length === 1, 'first message creates a session')
check(ctx.attached.includes(first.sessionId), 'channel session is attached to the workspace')
const privateRecord = ctx.workspaces.find(record => record.path === privateDir)
check(privateRecord?.title === '客服' && privateRecord.sessions.includes(first.sessionId), 'private chat lands in its own workspace')

const second = await gateway.inbound({ channel: 'qq', senderId: 'u1', text: '还在吗' })
check(second.sessionId === first.sessionId, 'same user reuses the session')
check(ctx.created.length === 1, 'no duplicate session')

const other = await gateway.inbound({ channel: 'qq', senderId: 'u2', text: '我也想问' })
check(other.sessionId !== first.sessionId, 'different user gets a different session')

const group = await gateway.inbound({ channel: 'wechat', groupId: 'g1', senderId: 'u1', text: '群里提问' })
check(group.key === 'wechat:group:g1', 'group key includes the group', group.key)
check(group.sessionId !== first.sessionId, 'group message does not share the private session')
const groupRecord = ctx.workspaces.find(record => record.path === groupDir)
check(groupRecord?.title === '客服' && groupRecord.sessions.includes(group.sessionId), 'group chat lands in its own workspace')

const reloaded = createGateway(fakeCtx(), {
  route: '/channel', workspace: temp, agentPreset: 'service-desk', dataFile, outbox, forward: 'final',
})
const reused = await reloaded.inbound({ channel: 'qq', senderId: 'u1', text: '重启后继续' })
check(reused.sessionId === first.sessionId, 'mapping survives a restart', reused.sessionId)

// Outbound: `final` buffers until turn/end.
gateway.observe({ id: first.sessionId }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '中间过程' }] } } })
gateway.observe({ id: first.sessionId }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '最终回复' }] } } })
await new Promise(resolve => setTimeout(resolve, 20))
const beforeFlush = await fs.readFile(outbox, 'utf8').catch(() => '')
check(beforeFlush.trim() === '', 'nothing emitted before turn/end')

gateway.observe({ id: first.sessionId }, { type: 'turn/end', data: { reason: 'done' } })
await new Promise(resolve => setTimeout(resolve, 20))
const lines = (await fs.readFile(outbox, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse)
check(lines.length === 1 && lines[0].text.includes('最终回复'), 'turn/end emits one merged reply', String(lines.length))
check(lines[0].groupId === null, 'private reply has no groupId')

const strange = gateway.observe({ id: 'unknown-session' }, { type: 'turn/end', data: {} })
check(strange === undefined, 'unknown session output is ignored')

// A failed turn with no assistant text must still answer the customer.
const failOutbox = path.join(temp, 'fallback.jsonl')
const failGw = createGateway(fakeCtx(), {
  route: '/channel', workspace: temp, agentPreset: 'service-desk',
  dataFile: path.join(temp, 'fail-sessions.json'), outbox: failOutbox,
})
const failedTurn = await failGw.inbound({ channel: 'qq', senderId: 'f1', text: '在吗' })
failGw.observe({ id: failedTurn.sessionId }, { type: 'turn/end', data: { reason: { kind: 'error' } } })
await new Promise(resolve => setTimeout(resolve, 20))
const fallback = (await fs.readFile(failOutbox, 'utf8')).trim()
check(fallback.includes('没处理成功'), 'failed turn sends a fallback reply', fallback.slice(0, 40))

const okTurn = await failGw.inbound({ channel: 'qq', senderId: 'f2', text: '在吗' })
failGw.observe({ id: okTurn.sessionId }, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
await new Promise(resolve => setTimeout(resolve, 20))
const afterOk = (await fs.readFile(failOutbox, 'utf8')).trim().split('\n').filter(Boolean)
check(afterOk.length === 1, 'completed turn with no text sends nothing extra')

// Idempotency: the same platform message id is accepted once.
const dedupeCtx = fakeCtx()
const dedupe = createGateway(dedupeCtx, {
  route: '/channel', workspace: temp, agentPreset: 'service-desk', dataFile, outbox,
})
const once = await dedupe.inbound({ channel: 'qq', senderId: 'u9', text: 'hello', messageId: 'm-1' })
const again = await dedupe.inbound({ channel: 'qq', senderId: 'u9', text: 'hello', messageId: 'm-1' })
check(once.duplicate === false && again.duplicate === true, 'duplicate message id is ignored')
check(dedupeCtx.followed.length === 1, 'duplicate delivers once', String(dedupeCtx.followed.length))
const fresh = await dedupe.inbound({ channel: 'qq', senderId: 'u9', text: 'follow up', messageId: 'm-2' })
check(fresh.duplicate === false, 'a new message id is delivered')

// Rate limiting: the 3rd message in the window is refused.
const limited = createGateway(fakeCtx(), {
  route: '/channel', workspace: temp, agentPreset: 'service-desk', dataFile, outbox, maxPerMinute: 2,
})
await limited.inbound({ channel: 'qq', senderId: 'r1', text: 'one' })
await limited.inbound({ channel: 'qq', senderId: 'r1', text: 'two' })
let limitedError
try {
  await limited.inbound({ channel: 'qq', senderId: 'r1', text: 'three' })
} catch (error) {
  limitedError = error
}
check(limitedError?.code === 'RATE_LIMITED' && limitedError.retryAfter >= 1, 'rate limit refuses the third message')
const otherKey = await limited.inbound({ channel: 'qq', senderId: 'r2', text: 'different user' })
check(otherKey.duplicate === false, 'rate limit is per conversation key')

// Attachments: fetch, admit, and attach an image block to the user message.
const attachCtx = fakeCtx()
const saved = []
attachCtx.get = (service) => service === 'attachments'
  ? { saveImages: async (images) => images.map((image, index) => { saved.push(image); return { id: `att-${index}` } }) }
  : undefined
const attach = createGateway(attachCtx, {
  route: '/channel', workspace: temp, agentPreset: 'service-desk', dataFile, outbox,
})
const originalFetch = globalThis.fetch
globalThis.fetch = async (url) => new Response(new Uint8Array([137, 80, 78, 71]), {
  status: 200, headers: { 'content-type': 'image/png' },
})
const withImage = await attach.inbound({
  channel: 'qq', senderId: 'img1', text: '看截图', attachments: ['https://example.test/shot.png'],
})
globalThis.fetch = originalFetch
const parts = attachCtx.followed.at(-1).message.content
check(saved.length === 1 && saved[0].mediaType === 'image/png', 'attachment downloaded and admitted')
check(parts.some(part => part.type === 'image'), 'image block reaches the session', String(parts.length))
check(withImage.duplicate === false, 'attachment message routes normally')

// path 模式：图片落盘、只给模型一个路径（纯文本模型）
{
  const imageDir = path.join(temp, 'images')
  const pathCtx = fakeCtx()
  const pathGw = createGateway(pathCtx, {
    route: '/channel', workspace: temp, agentPreset: 'service-desk',
    dataFile: path.join(temp, 'path-sessions.json'), outbox: path.join(temp, 'path-outbox.jsonl'),
    imageMode: 'path', imageDir,
  })
  const original = globalThis.fetch
  globalThis.fetch = async () => new Response(new Uint8Array([137, 80, 78, 71]), {
    status: 200, headers: { 'content-type': 'image/png' },
  })
  await pathGw.inbound({ channel: 'qq', senderId: 'img2', text: '看截图', attachments: ['https://x/y.png'] })
  globalThis.fetch = original
  const content = pathCtx.followed.at(-1).message.content
  const note = content.find(part => part.type === 'text' && part.text.includes('ocr_image'))
  check(note !== undefined, 'path mode tells the model to call ocr_image')
  check(!content.some(part => part.type === 'image'), 'path mode sends no image block')
  const saved = note?.text.match(/已保存：(.+)/)?.[1]?.trim()
  check(saved !== undefined && saved.startsWith(imageDir), 'path mode writes the file under imageDir', saved)
  check(saved !== undefined && (await fs.stat(saved)).size === 4, 'saved image keeps its bytes')
}

const emptyCtx = fakeCtx()
const emptyGateway = createGateway(emptyCtx, {
  route: '/channel', workspace: temp, agentPreset: 'service-desk', dataFile, outbox,
})
let emptyError
try {
  await emptyGateway.inbound({ channel: 'qq', senderId: 'e1' })
} catch (error) {
  emptyError = error
}
check(emptyError !== undefined, 'rejects a message with no text and no attachment')

// HTTP surface: auth + body handling.
const makeReq = (body, headers = {}) => ({
  method: 'POST', url: '/channel', headers,
  async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)) },
})
const authed = createGateway(fakeCtx(), {
  route: '/channel', workspace: temp, agentPreset: 'service-desk', dataFile, outbox, token: 'secret',
})
const res = { code: 0, body: '', writeHead(c) { this.code = c }, end(b) { this.body = b } }
await authed.handleHttp(makeReq({ channel: 'qq', senderId: 'u1', text: 'hi' }, { authorization: 'Bearer nope' }), res)
check(res.code === 401, 'rejects a bad token', String(res.code))
const okRes = { code: 0, body: '', writeHead(c) { this.code = c }, end(b) { this.body = b } }
await authed.handleHttp(makeReq({ channel: 'qq', senderId: 'u1', text: 'hi' }, { authorization: 'Bearer secret' }), okRes)
check(okRes.code === 202, 'accepts an authorized message', String(okRes.code))

const badRes = { code: 0, body: '', writeHead(c) { this.code = c }, end(b) { this.body = b } }
await authed.handleHttp(makeReq({ channel: 'qq' }, { authorization: 'Bearer secret' }), badRes)
check(badRes.code === 400, 'rejects a malformed body', String(badRes.code))

const sessionsRes = { code: 0, body: '', writeHead(c) { this.code = c }, end(b) { this.body = b } }
await authed.handleHttp({ method: 'GET', url: '/channel/sessions', headers: { authorization: 'Bearer secret' } }, sessionsRes)
const listed = JSON.parse(sessionsRes.body).sessions
check(listed.length >= 3, 'lists routed sessions', String(listed.length))

// Queue order: whoever spoke most recently comes first, so an agent watching the
// list sees the customer who just wrote instead of whoever signed up first. The
// timestamps are pinned because two messages can land in the same millisecond.
const queue = [...authed.sessions.values()]
const originalTimes = queue.map(record => record.lastSeenAt)
queue.forEach((record, index) => {
  record.lastSeenAt = new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString()
})
const orderedRes = { code: 0, body: '', writeHead(c) { this.code = c }, end(b) { this.body = b } }
await authed.handleHttp({ method: 'GET', url: '/channel/sessions', headers: { authorization: 'Bearer secret' } }, orderedRes)
const orderedKeys = JSON.parse(orderedRes.body).sessions.map(record => record.key)
const expectedKeys = [...queue].reverse().map(record => record.key)
check(orderedKeys.join(',') === expectedKeys.join(','), 'lists the most recently active conversation first', orderedKeys.map(key => key.split(':').pop()).join(' '))
queue.forEach((record, index) => { record.lastSeenAt = originalTimes[index] })

const resetRes = { code: 0, body: '', writeHead(c) { this.code = c }, end(b) { this.body = b } }
await authed.handleHttp({
  method: 'POST', url: '/channel/reset', headers: { authorization: 'Bearer secret' },
  async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({ key: 'qq:u1' })) },
}, resetRes)
check(resetRes.code === 200 && JSON.parse(resetRes.body).removed.includes('qq:u1'), 'reset drops a conversation mapping')

const afterReset = await authed.inbound({ channel: 'qq', senderId: 'u1', text: '重新开始' })
check(afterReset.sessionId !== first.sessionId, 'a reset conversation starts a new session', afterReset.sessionId)

// Boot check: the Cordis entry point registers one route and one listener.
const registered = { routes: [], effects: 0, listeners: [] }
const bootCtx = {
  logger: { warn: () => {} },
  webServer: { register: (route) => { registered.routes.push(route); return () => {} } },
  effect: (callback) => { registered.effects += 1; callback() },
  on: (event, handler) => { registered.listeners.push([event, handler]); return () => {} },
  agents: {}, agentPresets: {}, sessionTitle: {}, agentDefaultModel: {},
}
apply(bootCtx, {
  route: '/channel', workspace: temp, agentPreset: 'service-desk', dataFile, outbox,
})
check(registered.routes.length === 1 && registered.routes[0].path === '/channel', 'apply registers the route')
check(registered.routes[0].kind === 'prefix', 'route is a prefix so subpaths resolve', registered.routes[0].kind)
check(registered.listeners.some(([event]) => event === 'session/event'), 'apply observes session events')

// 人工接管：客户消息注入而不触发回复，模型输出被屏蔽，管理员直发
const handoffOutbox = path.join(temp, 'handoff.jsonl')
const handoffCtx = fakeCtx()
const handoff = createGateway(handoffCtx, {
  route: '/channel', workspace: temp, agentPreset: 'service-desk',
  dataFile: path.join(temp, 'handoff-sessions.json'), outbox: handoffOutbox,
})
const handKey = await handoff.inbound({ channel: 'qq', senderId: 'h1', text: '你好' })
check(handoffCtx.followed.length === 1, 'ai mode delivers to the agent')

await handoff.setMode(handKey.key, 'human')
const held = await handoff.inbound({ channel: 'qq', senderId: 'h1', text: '我要人工' })
check(held.held === true, 'human mode holds the message')
check(handoffCtx.followed.length === 1, 'human mode does not wake the agent')
check(handoffCtx.injected.length === 1, 'human mode still shows the message in the session')

handoff.observe({ id: handKey.sessionId }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '模型不该发出去' }] } } })
handoff.observe({ id: handKey.sessionId }, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
await new Promise(resolve => setTimeout(resolve, 20))
const suppressed = await fs.readFile(handoffOutbox, 'utf8').catch(() => '')
check(!suppressed.includes('模型不该发出去'), 'human mode suppresses agent output')

await handoff.adminReply(handKey.key, '我是人工客服，正在看你这个问题')
const afterReply = await fs.readFile(handoffOutbox, 'utf8')
check(afterReply.includes('我是人工客服'), 'admin reply reaches the customer')

await handoff.setMode(handKey.key, 'ai')
await handoff.inbound({ channel: 'qq', senderId: 'h1', text: '继续问' })
check(handoffCtx.followed.length === 2, 'returning to ai resumes agent replies')

let badMode
try {
  await handoff.setMode('qq:nobody', 'ai')
} catch (error) {
  badMode = error
}
check(badMode !== undefined, 'mode change requires a known conversation')

// 运营面板：状态与页面都能取到
{
  const panelCtx = fakeCtx()
  const panel = createGateway(panelCtx, {
    route: '/channel', workspace: temp, agentPreset: 'service-desk',
    dataFile: path.join(temp, 'panel-sessions.json'), outbox: path.join(temp, 'panel-outbox.jsonl'),
  })
  await panel.inbound({ channel: 'qq', senderId: 'p1', text: '在吗' })
  const statusRes = { code: 0, body: '', writeHead(c) { this.code = c }, end(b) { this.body = b } }
  await panel.handleHttp({ method: 'GET', url: '/channel/status', headers: {} }, statusRes)
  const status = JSON.parse(statusRes.body)
  check(statusRes.code === 200 && status.conversations === 1 && status.ai === 1, 'status endpoint reports conversations')

  const panelRes = { code: 0, body: '', writeHead(c) { this.code = c }, end(b) { this.body = b } }
  await panel.handleHttp({ method: 'GET', url: '/channel/panel', headers: {} }, panelRes)
  check(panelRes.code === 200 && panelRes.body.includes('客服控制面板'), 'panel page is served')
  check(panelRes.body.includes('/mode') && panelRes.body.includes('/reply'), 'panel page wires takeover and reply')
}

// 坏映射自愈：会话被删掉后，下一条消息重建而不是报错
{
  const healData = path.join(temp, 'heal-sessions.json')
  writeFileSync(healData, JSON.stringify({
    'qq:h1': {
      sessionId: 'chan-dead', key: 'qq:h1', channel: 'qq', senderId: 'h1',
      createdAt: '2026-01-01T00:00:00.000Z', lastSeenAt: '2026-01-01T00:00:00.000Z', mode: 'ai',
    },
  }))
  const healCtx = fakeCtx()
  healCtx.agents.resume = async () => { throw new Error('session "chan-dead" not found') }
  const heal = createGateway(healCtx, {
    route: '/channel', workspace: temp, agentPreset: 'service-desk',
    dataFile: healData, outbox: path.join(temp, 'heal-outbox.jsonl'),
  })
  const healed = await heal.inbound({ channel: 'qq', senderId: 'h1', text: '还在吗' })
  check(healed.sessionId !== 'chan-dead' && healCtx.created.length === 1, 'stale mapping is replaced by a new session')
}

// 孤儿会话：磁盘上有、但没有工作区认领
{
  const sessionsRoot = path.join(temp, 'sessions-root')
  const dir = path.join(sessionsRoot, '--tmp-orphan--', 'chan-orphan')
  mkdirSync(dir, { recursive: true })
  const header = { type: 'session', version: 4, id: 'chan-orphan', createdAt: 1, cwd: temp, isSeeded: false, delegationDepth: 0, agentPreset: 'service-desk' }
  writeFileSync(
    path.join(dir, 'session.v4.jsonl.zstd'),
    zstdCompressSync(Buffer.from(`${JSON.stringify(header)}\n`)),
  )
  const orphanCtx = fakeCtx()
  const orphanGw = createGateway(orphanCtx, {
    route: '/channel', workspace: temp, agentPreset: 'service-desk',
    dataFile: path.join(temp, 'orphan-sessions.json'), outbox: path.join(temp, 'orphan-outbox.jsonl'),
    sessionsRoot,
  })
  const report = await orphanGw.listOrphans()
  check(report.scanned === 1 && report.orphans.length === 1, 'finds an unattached session')
  check(report.orphans[0].path === temp && report.orphans[0].sessions.includes('chan-orphan'), 'groups orphans by cwd')

  const restored = await orphanGw.restoreWorkspace(temp)
  check(restored.path === temp, 'restore registers the existing directory')
  check(orphanCtx.workspaces.at(-1)?.title === path.basename(temp), 'restored workspace gets a title')

  let missingError
  try {
    await orphanGw.restoreWorkspace(path.join(temp, 'does-not-exist'))
  } catch (error) {
    missingError = error
  }
  check(missingError !== undefined, 'restore refuses a missing directory')
}

// 会话历史：从会话日志里读出对话
{
  const historyGateway = createGateway(fakeCtx(), {
    route: '/channel', workspace: temp, agentPreset: 'service-desk',
    dataFile: path.join(temp, 'history-sessions.json'), outbox: path.join(temp, 'history-outbox.jsonl'),
    sessionsRoot: path.join(temp, 'history-root'),
  })
  const record = await historyGateway.inbound({ channel: 'qq', senderId: 'h3', text: '你好' })
  const encoded = `--${temp.replace(/^\//, '').replaceAll('/', '-')}--`
  const dir = path.join(temp, 'history-root', encoded, record.sessionId)
  mkdirSync(dir, { recursive: true })
  const events = [
    { type: 'user/message', time: 1, data: { message: { role: 'user', content: [{ type: 'text', text: '你好' }], source: { kind: 'channel' } } } },
    { type: 'user/message', time: 3, data: { message: { role: 'user', content: [{ type: 'text', text: '[图片 1] 已保存：/tmp/shot.png\n需要读其中的文字时调用 ocr_image。' }], source: { kind: 'channel' } } } },
    { type: 'user/message', time: 4, data: { message: { role: 'user', content: [{ type: 'text', text: 'Time sampled while preparing turn 1, step 1: 2026-10-24T01:57:42+08:00' }], source: { kind: 'time-context', form: 'snapshot' } } } },
    { type: 'assistant/message', time: 2, data: { message: { role: 'assistant', content: [{ type: 'reasoning', text: '想一下' }, { type: 'text', text: '在的，请问遇到什么问题？' }] } } },
  ]
  writeFileSync(
    path.join(dir, 'session.v4.jsonl.zstd'),
    zstdCompressSync(Buffer.from(events.map(event => JSON.stringify(event)).join('\n') + '\n')),
  )
  const history = await historyGateway.readHistory(record.key)
  check(history.messages.length === 3, 'history returns every message')
  check(!history.messages.some(item => item.text.includes('Time sampled')), 'runtime context is not shown as a customer message')
  check(history.messages[1].images?.[0] === '/tmp/shot.png', 'history extracts the image path')
  check(history.messages[1].text === '', 'image note text is stripped from the bubble')
  check(history.messages[0].kind === 'customer' && history.messages[0].text === '你好', 'customer message is read')
  check(history.messages[2].kind === 'ai' && history.messages[2].text.includes('在的'), 'assistant text skips reasoning')
}

// 群聊粒度：默认一个群一个会话
{
  const scope = createGateway(fakeCtx(), {
    route: '/channel', workspace: temp, agentPreset: 'service-desk',
    dataFile: path.join(temp, 'scope-sessions.json'), outbox: path.join(temp, 'scope-outbox.jsonl'),
  })
  const first = await scope.inbound({ channel: 'qq', groupId: 'G7', senderId: 'u1', text: '在吗' })
  const second = await scope.inbound({ channel: 'qq', groupId: 'G7', senderId: 'u2', text: '我也在' })
  check(first.key === second.key, 'group messages share one conversation by default')
  check(second.key.includes(':group:'), 'group key is scoped to the group', second.key)

  const perSender = createGateway(fakeCtx(), {
    route: '/channel', workspace: temp, agentPreset: 'service-desk', groupScope: 'sender',
    dataFile: path.join(temp, 'scope2-sessions.json'), outbox: path.join(temp, 'scope2-outbox.jsonl'),
  })
  const a = await perSender.inbound({ channel: 'qq', groupId: 'G8', senderId: 'u1', text: 'a' })
  const b = await perSender.inbound({ channel: 'qq', groupId: 'G8', senderId: 'u2', text: 'b' })
  check(a.key !== b.key, 'groupScope=sender keeps one conversation per member')
}

// 管理员回复会写进会话
{
  const injected = []
  const replyCtx = fakeCtx()
  replyCtx.agents.get = () => ({ inject: message => injected.push(message) })
  const reply = createGateway(replyCtx, {
    route: '/channel', workspace: temp, agentPreset: 'service-desk',
    dataFile: path.join(temp, 'reply-sessions.json'), outbox: path.join(temp, 'reply-outbox.jsonl'),
  })
  const record = await reply.inbound({ channel: 'qq', senderId: 'a1', text: '帮我看看' })
  await reply.adminReply(record.key, '我来处理')
  check(injected.length === 1, 'admin reply is recorded in the session')
  check(injected[0].source?.kind === 'admin', 'admin reply carries the admin source')
  check(injected[0].content?.[0]?.text === '我来处理', 'admin reply text is kept')
}

// 并发：两个人同时 @ 只能建一条会话
{
  const raceCtx = fakeCtx()
  const create = raceCtx.agents.create
  raceCtx.agents.create = async options => {
    await new Promise(resolve => setTimeout(resolve, 20))
    return create(options)
  }
  const race = createGateway(raceCtx, {
    route: '/channel', workspace: temp, agentPreset: 'service-desk',
    dataFile: path.join(temp, 'race-sessions.json'), outbox: path.join(temp, 'race-outbox.jsonl'),
  })
  const [left, right] = await Promise.all([
    race.inbound({ channel: 'qq', groupId: 'G9', senderId: 'u1', text: '在吗' }),
    race.inbound({ channel: 'qq', groupId: 'G9', senderId: 'u2', text: '同问' }),
  ])
  check(left.sessionId === right.sessionId, 'concurrent messages share one session')
  check(raceCtx.created.length === 1, 'concurrent messages create one session')
}

// @ 回复：mention 透传到适配器
{
  const mentionCtx = fakeCtx()
  mentionCtx.agents.get = () => ({ inject: () => {} })
  const mentionGateway = createGateway(mentionCtx, {
    route: '/channel', workspace: temp, agentPreset: 'service-desk',
    dataFile: path.join(temp, 'mention-sessions.json'), outbox: path.join(temp, 'mention-outbox.jsonl'),
  })
  const record = await mentionGateway.inbound({ channel: 'qq', groupId: 'G10', senderId: 'u1', text: '帮我' })
  await mentionGateway.adminReply(record.key, '收到', 'OPENID-A')
  const last = readFileSync(path.join(temp, 'mention-outbox.jsonl'), 'utf8').trim().split('\n').pop()
  check(JSON.parse(last).mention === 'OPENID-A', 'mention is forwarded to the adapter')
}

// 归档：列表隐藏，来消息自动恢复
{
  const arcCtx = fakeCtx()
  const arc = createGateway(arcCtx, {
    route: '/channel', workspace: temp, agentPreset: 'service-desk',
    dataFile: path.join(temp, 'arc-sessions.json'), outbox: path.join(temp, 'arc-outbox.jsonl'),
  })
  const record = await arc.inbound({ channel: 'qq', senderId: 'z1', text: '你好' })
  arc.sessions.get(record.key).archivedAt = new Date().toISOString()

  const listResponse = { code: 0, body: '', writeHead(code) { this.code = code }, end(body) { this.body = body } }
  await arc.handleHttp({ method: 'GET', url: '/channel/sessions', headers: {} }, listResponse)
  check(
    !JSON.parse(listResponse.body).sessions.some(item => item.key === record.key),
    'archived conversation is hidden from the list',
  )

  await arc.inbound({ channel: 'qq', senderId: 'z1', text: '还在吗' })
  check(arc.sessions.get(record.key).archivedAt === undefined, 'new activity unarchives the conversation')
  check(arcCtx.attached.includes(record.sessionId), 'unarchived conversation is re-attached to its workspace')
}

// 面板的归档与删除
{
  const admin = createGateway(fakeCtx(), {
    route: '/channel', workspace: temp, agentPreset: 'service-desk',
    dataFile: path.join(temp, 'admin-sessions.json'), outbox: path.join(temp, 'admin-outbox.jsonl'),
  })
  const record = await admin.inbound({ channel: 'qq', senderId: 'm1', text: '在吗' })
  await admin.setArchived(record.key, true)
  check(admin.sessions.get(record.key).archivedAt !== undefined, 'setArchived marks the conversation')
  await admin.setArchived(record.key, false)
  check(admin.sessions.get(record.key).archivedAt === undefined, 'setArchived can restore it')
  await admin.deleteConversation(record.key)
  check(admin.sessions.get(record.key) === undefined, 'delete removes the mapping')
}

// 预设漂移：装配失败时丢掉映射，下一条消息重建
{
  const drift = createGateway(fakeCtx(), {
    route: '/channel', workspace: temp, agentPreset: 'service-desk',
    dataFile: path.join(temp, 'drift-sessions.json'), outbox: path.join(temp, 'drift-outbox.jsonl'),
  })
  const record = await drift.inbound({ channel: 'qq', senderId: 'd1', text: '在吗' })
  drift.observe({ id: record.sessionId }, {
    type: 'turn/end',
    data: { reason: { kind: 'error', error: { message: 'prompt variable "{{model}}" has no value for this assembly (section "deployment:persona-prefix")' } } },
  })
  check(drift.sessions.get(record.key) === undefined, 'preset drift drops the mapping')
}

// 重启后映射要能直接读到（不依赖先来一条消息）
{
  const dataFile = path.join(temp, 'reload-sessions.json')
  writeFileSync(dataFile, JSON.stringify({
    'qq:r1': {
      sessionId: 'chan-r1', key: 'qq:r1', channel: 'qq', senderId: 'r1',
      createdAt: '2026-01-01T00:00:00.000Z', lastSeenAt: '2026-01-01T00:00:00.000Z', mode: 'ai',
    },
  }))
  const reload = createGateway(fakeCtx(), {
    route: '/channel', workspace: temp, agentPreset: 'service-desk',
    dataFile, outbox: path.join(temp, 'reload-outbox.jsonl'),
  })
  const response = { code: 0, body: '', writeHead(code) { this.code = code }, end(body) { this.body = body } }
  await reload.handleHttp({ method: 'GET', url: '/channel/sessions', headers: {} }, response)
  check(JSON.parse(response.body).sessions.length === 1, 'sessions load from disk before the first message')
}

// 昵称存进会话
{
  const nameGw = createGateway(fakeCtx(), {
    route: '/channel', workspace: temp, agentPreset: 'service-desk',
    dataFile: path.join(temp, 'name-sessions.json'), outbox: path.join(temp, 'name-outbox.jsonl'),
  })
  const record = await nameGw.inbound({ channel: 'qq', senderId: 'n1', senderName: '小明', text: '你好' })
  check(nameGw.sessions.get(record.key)?.senderName === '小明', 'sender nickname is stored on the conversation')
}

// 群聊归属：内容带成员标签，回复自动 @
{
  const seen = []
  const speakerCtx = fakeCtx()
  const create = speakerCtx.agents.create
  speakerCtx.agents.create = async options => {
    const handle = await create(options)
    handle.agent.followup = message => seen.push(message)
    return handle
  }
  const speaker = createGateway(speakerCtx, {
    route: '/channel', workspace: temp, agentPreset: 'service-desk',
    dataFile: path.join(temp, 'speaker-sessions.json'), outbox: path.join(temp, 'speaker-outbox.jsonl'),
  })
  const record = await speaker.inbound({ channel: 'qq', groupId: 'GM', senderId: 'u1', senderName: '小明', text: '看这个' })
  check(seen[0]?.content?.[0]?.text?.startsWith('[群成员 小明]') === true, 'group message content names the sender')

  speaker.observe({ id: record.sessionId }, { type: 'turn/start' })
  speaker.observe(
    { id: record.sessionId },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '收到，我看下' }] } } },
  )
  speaker.observe({ id: record.sessionId }, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  await new Promise(resolve => setTimeout(resolve, 20))
  const last = readFileSync(path.join(temp, 'speaker-outbox.jsonl'), 'utf8').trim().split('\n').pop()
  check(JSON.parse(last).mention === 'u1', 'group reply mentions the asker')
}

// 图片读取：只允许 imageDir 内的文件
{
  const imageDir = path.join(temp, 'images-test')
  mkdirSync(imageDir, { recursive: true })
  const file = path.join(imageDir, 'shot.png')
  writeFileSync(file, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  const images = createGateway(fakeCtx(), {
    route: '/channel', workspace: temp, agentPreset: 'service-desk', imageMode: 'path', imageDir,
    dataFile: path.join(temp, 'images-sessions.json'), outbox: path.join(temp, 'images-outbox.jsonl'),
  })
  const ok = { code: 0, body: undefined, writeHead(code) { this.code = code }, end(body) { this.body = body } }
  await images.handleHttp({ method: 'GET', url: `/channel/image?path=${encodeURIComponent(file)}`, headers: {} }, ok)
  check(ok.code === 200 && ok.body?.length === 4, 'serves an image inside the directory')

  const outside = { code: 0, body: undefined, writeHead(code) { this.code = code }, end(body) { this.body = body } }
  await images.handleHttp({ method: 'GET', url: `/channel/image?path=${encodeURIComponent('/etc/hosts')}`, headers: {} }, outside)
  check(outside.code === 403, 'refuses a path outside the image directory')
}

// 标题带可搜索的短码
{
  const tokenGw = createGateway(fakeCtx(), {
    route: '/channel', workspace: temp, agentPreset: 'service-desk',
    dataFile: path.join(temp, 'token-sessions.json'), outbox: path.join(temp, 'token-outbox.jsonl'),
  })
  const record = await tokenGw.inbound({ channel: 'qq', groupId: 'GT', senderId: 'u1', text: '你好' })
  const stored = tokenGw.sessions.get(record.key)
  check(/^[a-z0-9]{6}$/.test(stored.token ?? ''), 'conversation gets a short token', stored.token)
  check(stored.title?.endsWith(`#${stored.token}`) === true, 'title carries the token', stored.title)

  await tokenGw.setLabel(record.key, '支付问题群')
  check(tokenGw.sessions.get(record.key).title === `支付问题群 · #${stored.token}`, 'label rename keeps the token')
}

// 删除保留文件；投递失败要能报出来
{
  const keepRoot = path.join(temp, 'keep-root')
  const keep = createGateway(fakeCtx(), {
    route: '/channel', workspace: temp, agentPreset: 'service-desk', sessionsRoot: keepRoot,
    dataFile: path.join(temp, 'keep-sessions.json'), outbox: path.join(temp, 'keep-outbox.jsonl'),
  })
  const record = await keep.inbound({ channel: 'qq', senderId: 'k1', text: '你好' })
  const dir = path.join(keepRoot, `--${temp.replace(/^\//, '').replaceAll('/', '-')}--`, record.sessionId)
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'session.v4.jsonl.zstd'), 'x')
  const result = await keep.deleteConversation(record.key)
  check(result.deleted === true, 'delete removes the mapping')
  check(existsSync(dir) === true, 'delete keeps the session files for DSH')
}

{
  const failing = createGateway(fakeCtx(), {
    route: '/channel', workspace: temp, agentPreset: 'service-desk',
    dataFile: path.join(temp, 'fail-sessions.json'), outbox: path.join(temp, 'fail-outbox.jsonl'),
    replyWebhook: 'http://127.0.0.1:1/reply',
  })
  const record = await failing.inbound({ channel: 'qq', senderId: 'f1', text: '你好' })
  const result = await failing.adminReply(record.key, '在的')
  check(result.delivered === false && typeof result.error === 'string', 'failed delivery is reported')
}

// 自愈后的回退回复仍要发到正确的群
{
  const driftGw = createGateway(fakeCtx(), {
    route: '/channel', workspace: temp, agentPreset: 'service-desk',
    dataFile: path.join(temp, 'drift2-sessions.json'), outbox: path.join(temp, 'drift2-outbox.jsonl'),
  })
  const record = await driftGw.inbound({ channel: 'qq', groupId: 'GD', senderId: 'u1', text: '在吗' })
  driftGw.observe({ id: record.sessionId }, { type: 'turn/start' })
  driftGw.observe({ id: record.sessionId }, {
    type: 'turn/end',
    data: { reason: { kind: 'error', error: { message: 'prompt variable "{{model}}" has no value' } } },
  })
  await new Promise(resolve => setTimeout(resolve, 20))
  const last = readFileSync(path.join(temp, 'drift2-outbox.jsonl'), 'utf8').trim().split('\n').pop()
  const envelope = JSON.parse(last)
  check(envelope.groupId === 'GD', 'fallback keeps the group after self-heal')
  check(envelope.text.includes('抱歉'), 'fallback text is sent')
}

// 配置：读不到 secret，保存写 600 文件，测试连接
{
  const previous = process.env.DSH_CS_ROOT
  process.env.DSH_CS_ROOT = path.join(temp, 'runtime-cfg')
  try {
    const cfgGw = createGateway(fakeCtx(), {
      route: '/channel', workspace: temp, agentPreset: 'service-desk',
      dataFile: path.join(temp, 'cfg-sessions.json'), outbox: path.join(temp, 'cfg-outbox.jsonl'),
    })
    const call = async (url, method = 'GET', body) => {
      const res = { code: 0, body: '', writeHead(code) { this.code = code }, end(payload) { this.body = payload } }
      const req = body === undefined
        ? Readable.from([])
        : Readable.from([Buffer.from(JSON.stringify(body))])
      req.method = method
      req.url = url
      req.headers = { 'content-type': 'application/json' }
      await cfgGw.handleHttp(req, res)
      return { code: res.code, body: res.body === '' ? {} : JSON.parse(res.body) }
    }

    const initial = await call('/channel/config')
    check(initial.code === 200 && initial.body.appId === '' && initial.body.hasSecret === false, 'config starts empty')

    const saved = await call('/channel/config', 'POST', { appId: '123', appSecret: 'topsecret' })
    check(saved.code === 200 && saved.body.saved === true, 'config saves credentials')
    const envPath = path.join(temp, 'runtime-cfg', 'adapter', '.env.local')
    check(existsSync(envPath), 'env file is written')
    check(readFileSync(envPath, 'utf8').includes('QQ_APP_SECRET=topsecret'), 'secret is persisted')
    check((statSync(envPath).mode & 0o777) === 0o600, 'env file is 0600')

    const after = await call('/channel/config')
    check(after.body.appId === '123' && after.body.hasSecret === true, 'config reports what is stored')
    check(!JSON.stringify(after.body).includes('topsecret'), 'secret is never returned')

    const invalid = await call('/channel/config', 'POST', { appId: '', appSecret: 'x' })
    check(invalid.code === 400, 'empty AppID is rejected')

    const originalFetch = globalThis.fetch
    globalThis.fetch = async () => new Response(JSON.stringify({ access_token: 'T', expires_in: 7200 }), { status: 200 })
    try {
      const tested = await call('/channel/config/test', 'POST', {})
      check(tested.code === 200 && tested.body.ok === true && tested.body.expiresIn === 7200, 'credential test succeeds')
    } finally {
      globalThis.fetch = originalFetch
    }
  } finally {
    if (previous === undefined) delete process.env.DSH_CS_ROOT
    else process.env.DSH_CS_ROOT = previous
  }
}

// 群名、备注、机器人控制
{
  const metaCtx = fakeCtx()
  const meta = createGateway(metaCtx, {
    route: '/channel', workspace: temp, agentPreset: 'service-desk',
    dataFile: path.join(temp, 'meta-sessions.json'), outbox: path.join(temp, 'meta-outbox.jsonl'),
    adapterCommand: path.join(temp, 'missing-adapter.sh'),
  })
  const group = await meta.inbound({ channel: 'qq', groupId: 'G9', groupName: '测试群', senderId: 'u9', text: 'hi' })
  check(meta.sessions.get(group.key)?.groupName === '测试群', 'group name is stored on the conversation')
  await meta.setLabel(group.key, '支付问题群')
  check(meta.sessions.get(group.key)?.label === '支付问题群', 'label overrides the display name')
  await meta.setLabel(group.key, '')
  check(meta.sessions.get(group.key)?.label === null, 'empty label clears the override')

  const status = await meta.adapterStatus()
  check(status.configured === false && typeof status.running === 'boolean', 'adapter status reports unconfigured')

  let actionError
  try {
    await meta.adapterAction('start')
  } catch (error) {
    actionError = error
  }
  check(actionError !== undefined, 'adapter action requires configuration')
}

// 同一数据目录不允许两个实例同时跑
const lockData = path.join(temp, 'lock-test.json')
const bootCtxA = {
  logger: { warn: () => {} },
  webServer: { register: () => () => {} },
  effect: (callback) => { callback() },
  on: () => () => {},
  agents: {}, agentPresets: {}, sessionTitle: {}, agentDefaultModel: {}, workspaceRegistry: {},
}
apply(bootCtxA, {
  route: '/channel', workspace: temp, agentPreset: 'service-desk', dataFile: lockData, outbox,
})
let lockError
try {
  apply({
    logger: { warn: () => {} },
    webServer: { register: () => () => {} },
    effect: (callback) => { callback() },
    on: () => () => {},
    agents: {}, agentPresets: {}, sessionTitle: {}, agentDefaultModel: {}, workspaceRegistry: {},
  }, {
    route: '/channel', workspace: temp, agentPreset: 'service-desk', dataFile: lockData, outbox,
  })
} catch (error) {
  lockError = error
}
check(lockError !== undefined && /already in use/.test(lockError.message), 'second instance on the same data dir is refused')

// 回归：线上 cs-agent/cordis.patch.yml 不写 dataFile，apply() 必须自己用默认路径。
// 之前这里直接 requireText(config.dataFile) → 抛错 → 插件静默不激活 → /channel/* 全 404。
{
  process.env.DSH_CS_ROOT = path.join(temp, 'apply-root')
  const registered = []
  const applyCtx = {
    webServer: { register: (route) => { registered.push(route); return () => {} } },
    effect: () => {},
    on: () => () => {},
  }
  const shipped = {
    route: '/channel',
    imageMode: 'path',
    agentPreset: 'service-desk',
    forward: 'final',
    maxPerMinute: 20,
    maxAttachments: 4,
    dedupeLimit: 2000,
    replyWebhook: 'http://127.0.0.1:8080/reply',
  }
  let threw
  try { apply(applyCtx, shipped) } catch (error) { threw = error }
  check(threw === undefined, 'apply accepts the shipped config without dataFile', threw?.message)
  check(registered.length === 1 && registered[0].path === '/channel', 'apply registers the /channel route', registered.length)
  delete process.env.DSH_CS_ROOT
}

await fs.rm(temp, { recursive: true, force: true })
process.exit(failed === 0 ? 0 : 1)
