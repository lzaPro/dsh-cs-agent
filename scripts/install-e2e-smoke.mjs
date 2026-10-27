#!/usr/bin/env node
/**
 * 端到端安装检查：从干净环境按 INSTALL.md 走一遍，再让真插件代码跑起来。
 *
 *   node scripts/install-e2e-smoke.mjs
 *
 * 为什么单独一个脚本：`setup-smoke.mjs` 只验"目录和文件到位了"，
 * `check-plugin-apply.mjs` 只验"apply() 不抛"。两者都不回答最要紧的那个问题——
 * **按文档装完之后，这套东西真的能收一条消息、回一条消息、重启后还认得那个客户吗？**
 * 那些"装是装上了但跑不起来"的事故（路径不对、凭证没读到、kb 目录空、路由前缀写错）
 * 全在这个缝里。
 *
 * 全程在临时 DSH_HOME 里做，不碰真实的 ~/.dsh，不联网（适配器是假的）。
 */
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

let failed = 0
const check = (ok, label, detail = '') => {
  if (!ok) failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail === '' ? '' : `: ${detail}`}`)
}

const temp = mkdtempSync(join(tmpdir(), 'install-e2e-'))
// 装到一个空 home：这样 paths.js 解析出来的每个目录都必须由安装脚本创建。
const home = join(temp, 'dsh')
const runtime = join(home, 'cs-runtime')

// ── 1. 按文档初始化 ─────────────────────────────────────────────────────
step('run the installer into an empty DSH_HOME')
const installOutput = execFileSync(
  process.execPath,
  [join(root, 'cs-agent/install/setup.mjs'), '--home', home, '--app-id', '1024', '--app-secret', 'a-secret'],
  // 故意从别的目录跑：用户不会在包目录里执行 npx。
  { encoding: 'utf8', cwd: temp },
)
check(installOutput.includes('完成'), 'the installer reports success')
check(existsSync(join(runtime, 'adapter/.env.local')), 'the adapter credentials land in the runtime root')

// 安装脚本之后，插件代码才第一次接触这个 home。这里之后才设 DSH_HOME，
// 是为了证明"先装、后启动"的顺序是可行的（INSTALL 就是这么写的）。
process.env.DSH_HOME = home
delete process.env.DSH_CS_STORE
delete process.env.DSH_DB

// ── 2. 装完的目录布局能用 ───────────────────────────────────────────────
step('the installed layout is enough for the plugins')
const { defaultPaths } = await import(join(root, 'cs-agent/paths.js'))
const paths = defaultPaths()
check(paths.root === runtime, 'paths.js resolves the installed runtime root', paths.root)
for (const name of ['customer', 'eval', 'ops', 'data', 'kb', 'adapter']) {
  check(existsSync(join(runtime, name)), `the installed root has ${name}/`)
}
// 这一条最容易坏：知识库目录存在但空着，客服就一条也搜不到，而"目录存在"看起来是对的。
const starterFiles = readdirSync(join(runtime, 'kb')).filter(name => name.endsWith('.json') && name !== '_template.json')
check(starterFiles.length >= 1, 'the knowledge base is not just an empty directory', starterFiles.join(','))
check(existsSync(join(runtime, 'kb/_candidates')), 'the candidate queue directory exists')

// ── 3. kb-core 真的加载了装好的知识库 ───────────────────────────────────
{
  const { apply: applyKb } = await import(join(root, 'kb-core/index.js'))
  const { apply: applyKbTools } = await import(join(root, 'kb-core/tools.js'))
  const ctx = fakeCtx()
  applyKb(ctx, {})
  applyKbTools(ctx, { role: 'customer-service' })

  const store = ctx.get('kbStore')
  check(store !== undefined, 'kb-core provides the store service')
  const stats = await store.stats()
  check(stats.shared >= 1, 'the installed knowledge base has entries', `${stats.shared} shared entries`)

  // 真跑一次工具：装好的 example-disk-full 应该能被搜到。
  const search = ctx.toolMap.get('kb_search')
  const result = await search.execute({ query: '磁盘空间不足 no space left on device' }, {})
  const hits = result.hits ?? []
  check(hits.length >= 1, 'kb_search finds the starter entry', JSON.stringify(hits.map(hit => hit.id).slice(0, 3)))
  check(hits[0].id === 'example-disk-full', 'the top hit is the starter entry', String(hits[0]?.id))
  check(result.verdict === 'direct', 'the starter entry is strong enough to answer from', String(result.verdict))
}

// ── 4. 网关在装好的 home 上起来 ─────────────────────────────────────────
step('the gateway starts on the installed home')
const adapter = await fakeAdapter()
{
  const { apply: applyGateway } = await import(join(root, 'cs-agent/gateway.js'))
  const ctx = fakeCtx()
  const booted = await applyGateway(ctx, {
    route: '/channel',
    agentPreset: 'service-desk',
    replyWebhook: adapter.url,
    maxPerMinute: 100,
  })
  check(booted !== undefined, 'apply() returns the gateway')
  check(ctx.routes.some(entry => entry.path === '/channel'), 'the gateway registers its route')
  check(ctx.effects.length >= 5, 'every worker registers a disposer', `${ctx.effects.length} effects`)

  const gateway = booted
  // 凭证是安装脚本写的，网关应该读得到——这是"装完就能用"的最小证据。
  const config = await call(gateway, 'GET', '/channel/config')
  check(config.code === 200, '/config answers', String(config.code))
  check(config.body.appId === '1024', 'the gateway reads the installed credentials', String(config.body.appId))
  check(config.body.hasSecret === true, 'the secret is detected but not echoed')
  check(JSON.stringify(config.body).includes('a-secret') === false, 'the secret is never returned')
  check(config.body.envFile === join(runtime, 'adapter/.env.local'), 'the credential file is the installed one')

  // 未配令牌时的默认行为：全开 + 告警（INSTALL 里写明开发机可用）。
  check(gateway.auth.mode === 'open', 'a fresh install runs without a token', gateway.auth.mode)
  check(ctx.warnings.some(line => line.includes('no access token configured')), 'and says so in the log')

  // 面板能打开：这是用户装完之后第一个点开的东西。
  const panel = await call(gateway, 'GET', '/channel/panel')
  check(panel.code === 200, 'the panel renders', String(panel.code))
  check(String(panel.body).includes('<!doctype html>') || String(panel.body).includes('<!DOCTYPE html>'), 'the panel is an html document')
  check(String(panel.body).includes('/channel'), 'the panel is wired to the registered route')

  // 健康检查：装完就该是健康的。
  const health = await call(gateway, 'GET', '/channel/health')
  check(health.code === 200 && health.body.ok === true, 'a fresh install is healthy', JSON.stringify(health.body.checks?.map(item => item.name)))
  check(health.body.database === null, 'the database stays off unless it is enabled')
  check(health.body.store.kind === 'json', 'a fresh install uses the file store', health.body.store.kind)

  // ── 5. 一条客户消息走完全程 ───────────────────────────────────────────
  step('a customer message goes all the way through')
  const first = await gateway.inbound({
    channel: 'qq',
    senderId: 'customer-1',
    senderName: '客户甲',
    text: '容器起不来，报 no space left on device',
    messageId: 'e2e-1',
  })
  check(first.key === 'qq:customer-1', 'the conversation key is derived from the channel and sender', first.key)
  check(typeof first.sessionId === 'string' && first.sessionId !== '', 'a session is created for the conversation')

  gateway.observe({ id: first.sessionId }, {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text: '磁盘满了，先清理 /tmp 再重启容器。' }] } },
  })
  gateway.observe({ id: first.sessionId }, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  await gateway.flushArchives()
  await waitFor(() => adapter.received.length >= 1)
  check(adapter.received.length === 1, 'the reply reaches the adapter', String(adapter.received.length))
  check(adapter.received[0].text.includes('磁盘满了'), 'the reply text is the model answer')
  check(adapter.received[0].key === 'qq:customer-1', 'the reply is addressed to the right conversation', String(adapter.received[0].key))

  // 回复同时也落在 outbox 审计文件里（装好的 data/ 目录下）。
  check(existsSync(join(runtime, 'data/outbox.jsonl')), 'the reply audit trail is written under the installed data/')
  const auditLines = readFileSync(join(runtime, 'data/outbox.jsonl'), 'utf8').trim().split('\n')
  check(auditLines.length === 1 && JSON.parse(auditLines[0]).text.includes('磁盘满了'), 'the audit line matches what was sent')

  // 历史也能查（面板"会话详情"用的就是它）。
  const history = await call(gateway, 'GET', `/channel/history?key=${encodeURIComponent(first.key)}`)
  check(history.code === 200, '/history answers after a turn', String(history.code))

  // ── 6. 重启后还认得这个客户 ───────────────────────────────────────────
  step('a restart keeps the conversation')
  await gateway.store.flush()
  for (const disposer of ctx.disposers) await disposer()

  const ctx2 = fakeCtx()
  const restarted = await applyGateway(ctx2, {
    route: '/channel',
    agentPreset: 'service-desk',
    replyWebhook: adapter.url,
    maxPerMinute: 100,
  })
  const again = await restarted.inbound({
    channel: 'qq',
    senderId: 'customer-1',
    senderName: '客户甲',
    text: '清理完了，还是起不来',
    messageId: 'e2e-2',
  })
  check(again.duplicate !== true, 'a new message after restart is accepted')
  check(again.sessionId === first.sessionId, 'the same customer gets the same session back', `${again.sessionId}`)
  check(again.key === first.key, 'the conversation key survives the restart')

  const sessions = await call(restarted, 'GET', '/channel/sessions')
  const listed = (sessions.body.sessions ?? []).filter(item => item.key === first.key)
  check(listed.length === 1, 'the conversation appears exactly once after restart', String(listed.length))

  for (const disposer of ctx2.disposers) await disposer()
}

// ── 7. 装好的 home 之外没有东西被写 ─────────────────────────────────────
step('nothing is written outside the installed home')
{
  // data/ 存的是运行状态，应该都在装好的 root 里。真实 ~/.dsh 下的 cs-runtime
  // 若被写过，说明有路径没走 defaultPaths()——那种 bug 只在"用户机器上已有旧数据"时
  // 才会显形，测试里不检查就永远发现不了。
  const entries = readdirSync(join(runtime, 'data')).sort()
  check(entries.includes('sessions.json'), 'session state lives under the installed data/', entries.join(','))
  const sessionsFile = JSON.parse(readFileSync(join(runtime, 'data/sessions.json'), 'utf8'))
  check(Object.keys(sessionsFile).length === 1, 'exactly one conversation is persisted', String(Object.keys(sessionsFile).length))
  const record = Object.values(sessionsFile)[0]
  check(record.key === 'qq:customer-1' && record.senderName === '客户甲', 'the persisted record is the customer we talked to', JSON.stringify({ key: record.key, senderName: record.senderName }))
  check((statSync(join(runtime, 'adapter/.env.local')).mode & 0o777) === 0o600, 'the credential file stays 0600')
}

adapter.server.close()
rmSync(temp, { recursive: true, force: true })
console.log('')
console.log(failed === 0 ? 'all end-to-end install checks passed' : `${failed} check(s) failed`)
process.exit(failed === 0 ? 0 : 1)

// ── helpers ─────────────────────────────────────────────────────────────

function step(title) {
  console.log(`\n▸ ${title}`)
}

function waitFor(predicate, timeoutMs = 2000) {
  const startedAt = Date.now()
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) return resolve()
      if (Date.now() - startedAt > timeoutMs) return reject(new Error('timed out waiting for the adapter'))
      setTimeout(tick, 10)
    }
    tick()
  })
}

/** 一次 HTTP 调用，走真实的 handleHttp。 */
function call(gateway, method, url) {
  const res = {
    code: 0,
    body: '',
    writeHead(code) { this.code = code },
    end(payload) { this.body = payload ?? '' },
  }
  return gateway.handleHttp({ method, url, headers: {}, on: () => {} }, res).then(() => ({
    code: res.code,
    body: (() => {
      try {
        return JSON.parse(res.body)
      } catch {
        return res.body
      }
    })(),
  }))
}

/** 假适配器：收下网关发出的回复。 */
async function fakeAdapter() {
  const received = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      received.push(JSON.parse(body))
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"ok":true}')
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return { server, received, url: `http://127.0.0.1:${server.address().port}/reply` }
}

/** 假 Host：够跑通 apply()、工具注册与事件。 */
function fakeCtx(options = {}) {
  const provided = new Map()
  const routes = []
  const effects = []
  const tools = new Map()
  const disposers = []
  const warnings = []
  const live = new Map()
  const makeAgent = id => ({ id, followup: () => {}, inject: () => {} })
  return {
    routes,
    effects,
    tools: { register: tool => tools.set(tool.name, tool) },
    toolMap: tools,
    disposers,
    warnings,
    logger: { warn: text => warnings.push(text) },
    provide(service, value) {
      provided.set(service, value)
      return () => provided.delete(service)
    },
    get: service => provided.get(service),
    effect(factory, label) {
      const disposer = factory()
      effects.push(label)
      if (typeof disposer === 'function') disposers.push(disposer)
      return () => {}
    },
    on: () => () => {},
    webServer: {
      register(entry) {
        routes.push(entry)
        return () => {}
      },
    },
    workspaceRegistry: {
      list: () => [],
      create: async dir => ({
        path: dir,
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
    ...options,
  }
}
