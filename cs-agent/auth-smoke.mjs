// 访问控制：谁是 public、谁要 inbound 令牌、谁要 admin 令牌；浏览器怎么带令牌。
// Run with: node cs-agent/auth-smoke.mjs
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createGateway } from './gateway.js'
import { createAuth, constantTimeEqual, readTokenFile } from './auth.js'

let failed = 0
const check = (ok, label, detail = '') => {
  if (!ok) failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail === '' ? '' : `: ${detail}`}`)
}

function fakeCtx(warnings = []) {
  const live = new Map()
  const workspaces = []
  return {
    logger: { warn: message => warnings.push(message) },
    workspaceRegistry: {
      list: () => workspaces.map(record => ({
        get sessionIds() { return record.sessions },
        detachSession: async id => { record.sessions = record.sessions.filter(item => item !== id) },
      })),
      create: async (dir) => {
        const record = { path: dir, title: undefined, sessions: [] }
        workspaces.push(record)
        return {
          id: `ws-${workspaces.length}`,
          get sessionIds() { return record.sessions },
          attachSession: async (id) => { record.sessions.push(id) },
          detachSession: async (id) => { record.sessions = record.sessions.filter(item => item !== id) },
          setTitle: async (title) => { record.title = title },
        }
      },
    },
    agentDefaultModel: { currentSelection: () => ({ provider: 'test', model: 'test-model' }) },
    agents: {
      async create(options) {
        const agent = { id: options.sessionId, followup: () => {}, inject: () => {} }
        live.set(options.sessionId, agent)
        return { agent }
      },
      get: id => live.get(id),
      async resume({ resumeSessionId }) {
        const agent = { id: resumeSessionId, followup: () => {}, inject: () => {} }
        live.set(resumeSessionId, agent)
        return { agent }
      },
    },
    agentPresets: { async mount() {} },
    sessionTitle: { async rename() {} },
    on: () => () => {},
  }
}

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'auth-smoke-'))
let sequence = 0

/** 建一个带独立数据文件的网关，避免用例之间互相看见会话。 */
function makeGateway(config = {}, warnings = []) {
  sequence += 1
  const dataFile = path.join(temp, `sessions-${sequence}.json`)
  return createGateway(fakeCtx(warnings), {
    route: '/channel',
    workspace: temp,
    agentPreset: 'service-desk',
    dataFile,
    outbox: path.join(temp, `outbox-${sequence}.jsonl`),
    ...config,
  })
}

/** 走一遍真实的 HTTP 入口，返回状态码、头与正文。 */
async function request(gateway, { method = 'GET', url = '/channel/sessions', headers = {}, body } = {}) {
  let payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body))
  const req = {
    method,
    url,
    headers,
    async *[Symbol.asyncIterator]() {
      if (payload !== undefined) yield payload
    },
  }
  const res = {
    code: 0,
    headers: {},
    body: '',
    writeHead(code, extra) { this.code = code; this.headers = extra ?? {} },
    setHeader(name, value) { this.headers[name] = value },
    end(value) { this.body = value ?? '' },
  }
  await gateway.handleHttp(req, res)
  return res
}

// —— 全开模式：不配令牌时和重构前一致 ——

const openWarnings = []
const openGateway = makeGateway({}, openWarnings)
check(openGateway.auth.mode === 'open', 'no token means open mode', openGateway.auth.mode)
check(
  openWarnings.some(message => message.includes('admin endpoints') && message.includes('open')),
  'open mode warns once at startup',
  JSON.stringify(openWarnings),
)

const openAdmin = await request(openGateway)
check(openAdmin.code === 200, 'open mode serves admin endpoints', String(openAdmin.code))
const openHealth = await request(openGateway, { url: '/channel/health' })
check(openHealth.code === 200, 'open mode serves health', String(openHealth.code))
const openInbound = await request(openGateway, {
  method: 'POST',
  url: '/channel',
  body: { channel: 'qq', senderId: 'open-1', text: '你好' },
})
check(openInbound.code === 202, 'open mode accepts inbound', String(openInbound.code))

// —— 令牌模式：三种角色的边界 ——

const gateway = makeGateway({ token: 'admin-secret' })
const send = (...args) => request(gateway, ...args)

const noToken = await send()
check(noToken.code === 401, 'admin endpoint refuses a request with no token', String(noToken.code))
check(JSON.parse(noToken.body).code === 'UNAUTHORIZED', 'the 401 carries a machine-readable code', noToken.body)

const badToken = await send({ headers: { authorization: 'Bearer nope' } })
check(badToken.code === 401, 'admin endpoint refuses a wrong token', String(badToken.code))

const goodToken = await send({ headers: { authorization: 'Bearer admin-secret' } })
check(goodToken.code === 200, 'admin endpoint accepts the token', String(goodToken.code))

const headerToken = await send({ headers: { 'x-admin-token': 'admin-secret' } })
check(headerToken.code === 200, 'x-admin-token is accepted', String(headerToken.code))

const queryToken = await send({ url: '/channel/sessions?token=admin-secret' })
check(queryToken.code === 200, '?token= is accepted', String(queryToken.code))

const cookieToken = await send({ headers: { cookie: 'other=1; cs_panel=admin-secret' } })
check(cookieToken.code === 200, 'the panel cookie is accepted', String(cookieToken.code))

const cookieWrong = await send({ headers: { cookie: 'cs_panel=nope' } })
check(cookieWrong.code === 401, 'a wrong panel cookie is refused', String(cookieWrong.code))

// /health 免令牌：编排系统要用它判断能不能干活，而它不返回客户数据。
const health = await send({ url: '/channel/health' })
check(health.code === 200, 'health needs no token', String(health.code))
const healthBody = JSON.parse(health.body)
check(healthBody.ok === true && healthBody.store?.kind === 'json', 'health reports something an orchestrator can use', health.body.slice(0, 120))

const closedHealth = makeGateway({ token: 'admin-secret', healthPublic: false })
check(
  (await request(closedHealth, { url: '/channel/health' })).code === 401,
  'healthPublic: false makes health require the token',
)
check(
  (await request(closedHealth, { url: '/channel/health?token=admin-secret' })).code === 200,
  'healthPublic: false still accepts the token',
)

// —— 入站令牌：适配器和运维面板不该共用凭证 ——

const split = makeGateway({ token: 'admin-secret', inboundToken: 'adapter-secret' })
const inboundOk = await request(split, {
  method: 'POST',
  url: '/channel',
  headers: { 'x-inbound-token': 'adapter-secret' },
  body: { channel: 'qq', senderId: 'split-1', text: '在吗' },
})
check(inboundOk.code === 202, 'the inbound token accepts messages', String(inboundOk.code))

const inboundWrong = await request(split, {
  method: 'POST',
  url: '/channel',
  headers: { authorization: 'Bearer admin-secret' },
  body: { channel: 'qq', senderId: 'split-2', text: '在吗' },
})
check(inboundWrong.code === 202, 'the admin token also works for inbound', String(inboundWrong.code))

const inboundAsAdmin = await request(split, { headers: { 'x-inbound-token': 'adapter-secret' } })
check(inboundAsAdmin.code === 401, 'the inbound token cannot touch admin endpoints', String(inboundAsAdmin.code))

const noInbound = await request(split, { method: 'POST', url: '/channel', body: { channel: 'qq', senderId: 'split-3', text: '在吗' } })
check(noInbound.code === 401, 'inbound without a token is refused', String(noInbound.code))

// —— 面板：浏览器怎么带令牌 ——

const login = await send({ url: '/channel/panel' })
check(login.code === 401, 'an unauthenticated panel request gets the login page', String(login.code))
check(login.body.includes('name="token"') && login.body.includes('action="/channel/panel"'), 'the login page is a plain form back to the panel')
check(login.body.includes('这个面板需要访问令牌'), 'the login page explains itself')

const withQuery = await send({ url: '/channel/panel?token=admin-secret' })
check(withQuery.code === 302, 'opening the panel with ?token= redirects', String(withQuery.code))
check(withQuery.headers.location === '/channel/panel', 'the redirect drops the token from the address bar', withQuery.headers.location)
const cookieHeader = withQuery.headers['set-cookie'] ?? ''
check(cookieHeader.includes('cs_panel=admin-secret'), 'the redirect sets the cookie', cookieHeader)
check(cookieHeader.includes('HttpOnly') && cookieHeader.includes('SameSite=Strict'), 'the cookie is HttpOnly and SameSite=Strict', cookieHeader)
check(cookieHeader.includes('Path=/channel'), 'the cookie is scoped to the gateway route', cookieHeader)

const panelWithCookie = await send({ url: '/channel/panel', headers: { cookie: 'cs_panel=admin-secret' } })
check(panelWithCookie.code === 200, 'the panel loads with the cookie', String(panelWithCookie.code))
check(panelWithCookie.body.includes('id="ops-open"'), 'the loaded panel is the real one')

const panelBadCookie = await send({ url: '/channel/panel', headers: { cookie: 'cs_panel=wrong' } })
check(panelBadCookie.code === 401 && panelBadCookie.body.includes('name="token"'), 'a wrong cookie falls back to the login page')

// —— 令牌文件：密钥不该写在 YAML 里 ——

const tokenFile = path.join(temp, 'admin.token')
await fs.writeFile(tokenFile, '\n  file-secret  \nextra line\n', { mode: 0o600 })
check(readTokenFile(tokenFile) === 'file-secret', 'readTokenFile takes the first non-empty line')

const fileWarnings = []
const fileGateway = makeGateway({ tokenFile }, fileWarnings)
check(fileGateway.auth.mode === 'token', 'a tokenFile switches to token mode', fileGateway.auth.mode)
check(
  (await request(fileGateway, { headers: { authorization: 'Bearer file-secret' } })).code === 200,
  'the token from the file is accepted',
)

const looseFile = path.join(temp, 'loose.token')
await fs.writeFile(looseFile, 'loose-secret\n', { mode: 0o644 })
const looseWarnings = []
makeGateway({ tokenFile: looseFile }, looseWarnings)
check(
  looseWarnings.some(message => message.includes('readable by other users') && message.includes('chmod 600')),
  'a world-readable token file is reported',
  JSON.stringify(looseWarnings),
)

let missingTokenError
try {
  makeGateway({ tokenFile: path.join(temp, 'does-not-exist.token') })
} catch (error) {
  missingTokenError = error
}
check(
  missingTokenError !== undefined && /cannot read tokenFile/.test(missingTokenError.message),
  'a missing token file fails loudly instead of running open',
  missingTokenError?.message,
)

// 空文件等于没配：退回全开，但要警告。
const emptyFile = path.join(temp, 'empty.token')
await fs.writeFile(emptyFile, '\n\n', { mode: 0o600 })
const emptyWarnings = []
const emptyGateway = makeGateway({ tokenFile: emptyFile }, emptyWarnings)
check(emptyGateway.auth.mode === 'open', 'an empty token file means open mode', emptyGateway.auth.mode)
check(
  emptyWarnings.some(message => message.includes('no access token configured')),
  'open mode after an empty token file still warns',
)

// —— 只读令牌：能看不能改 ——

{
  const warnings = []
  const viewer = makeGateway({ token: 'admin-secret', viewerToken: 'view-secret' }, warnings)
  const ask = (...args) => request(viewer, ...args)

  const asViewer = { headers: { 'x-admin-token': 'view-secret' } }
  const asAdmin = { headers: { 'x-admin-token': 'admin-secret' } }

  const whoamiViewer = await ask({ url: '/channel/whoami', headers: asViewer.headers })
  const me = JSON.parse(whoamiViewer.body)
  check(whoamiViewer.code === 200, 'viewer can read whoami', String(whoamiViewer.code))
  check(me.role === 'viewer' && me.readonly === true, 'whoami reports a read-only role', whoamiViewer.body)

  const whoamiAdmin = JSON.parse((await ask({ url: '/channel/whoami', headers: asAdmin.headers })).body)
  check(whoamiAdmin.role === 'admin' && whoamiAdmin.readonly === false, 'whoami reports admin for the admin token', JSON.stringify(whoamiAdmin))

  const viewerSessions = await ask({ url: '/channel/sessions', headers: asViewer.headers })
  check(viewerSessions.code === 200, 'viewer can list sessions', String(viewerSessions.code))
  const viewerHealth = await ask({ url: '/channel/health' })
  check(viewerHealth.code === 200, 'health stays public regardless of role', String(viewerHealth.code))
  const viewerAudit = await ask({ url: '/channel/audit', headers: asViewer.headers })
  check(viewerAudit.code === 200, 'viewer can read the audit log', String(viewerAudit.code))
  const viewerDead = await ask({ url: '/channel/dead', headers: asViewer.headers })
  check(viewerDead.code === 200, 'viewer can read the dead letters', String(viewerDead.code))

  // 写：一个都不能过，而且要 403 不是 401——凭证是对的，只是权限不够。
  const deletes = await ask({ method: 'POST', url: '/channel/delete', headers: asViewer.headers, body: { keys: ['qq:u1'] } })
  check(deletes.code === 403, 'viewer cannot delete a conversation', String(deletes.code))
  check(JSON.parse(deletes.body).code === 'FORBIDDEN', 'the refusal is machine-readable', deletes.body)
  const replay = await ask({ method: 'POST', url: '/channel/replay', headers: asViewer.headers, body: { queue: 'outbox' } })
  check(replay.code === 403, 'viewer cannot replay dead letters', String(replay.code))
  const purge = await ask({ method: 'POST', url: '/channel/retention', headers: asViewer.headers, body: { dryRun: false } })
  check(purge.code === 403, 'viewer cannot purge customer data', String(purge.code))
  const config = await ask({ method: 'POST', url: '/channel/config', headers: asViewer.headers, body: { appId: 'x' } })
  check(config.code === 403, 'viewer cannot rewrite the bot credentials', String(config.code))
  const mode = await ask({ method: 'POST', url: '/channel/mode', headers: asViewer.headers, body: { key: 'qq:u1', mode: 'human' } })
  check(mode.code === 403, 'viewer cannot take over a conversation', String(mode.code))
  const inbound = await ask({ method: 'POST', url: '/channel', headers: asViewer.headers, body: { channel: 'qq', senderId: 'u1', text: 'hi' } })
  check(inbound.code === 401, 'the viewer token is not an inbound token', String(inbound.code))

  // admin 仍然什么都能做。
  const adminConfig = await ask({ url: '/channel/config', headers: asAdmin.headers })
  check(adminConfig.code === 200, 'admin can still read the config', String(adminConfig.code))

  // 用查询串进来的只读用户，拿到的是只读 cookie（名字不同，不会覆盖 admin 的）。
  const viewerLogin = await ask({ url: '/channel/panel?token=view-secret' })
  check(viewerLogin.code === 302, 'the viewer login redirects', String(viewerLogin.code))
  const setCookie = String(viewerLogin.headers['set-cookie'] ?? '')
  check(setCookie.startsWith('cs_view='), 'the viewer gets its own cookie name', setCookie.slice(0, 24))
  check(!setCookie.startsWith('cs_panel='), 'the viewer cookie does not overwrite the admin cookie')
  const adminLogin = await ask({ url: '/channel/panel?token=admin-secret' })
  check(String(adminLogin.headers['set-cookie'] ?? '').startsWith('cs_panel='), 'the admin still gets the admin cookie')

  // 只读 cookie 之后的请求按只读处理。
  const viaCookie = await ask({ method: 'POST', url: '/channel/delete', headers: { cookie: 'cs_view=view-secret' }, body: { keys: [] } })
  check(viaCookie.code === 403, 'a viewer cookie survives to the next request and stays read-only', String(viaCookie.code))
  const adminCookieRead = await ask({ url: '/channel/config', headers: { cookie: 'cs_panel=admin-secret' } })
  check(adminCookieRead.code === 200, 'an admin cookie still works', String(adminCookieRead.code))

  // 配了只读却没配 admin：能起来，但要警告"没人能写"。
  const lonely = []
  const onlyViewer = makeGateway({ viewerToken: 'view-secret' }, lonely)
  check(onlyViewer.auth.mode === 'token', 'a viewer-only deployment is still token mode')
  check(
    lonely.some(text => text.includes('no admin token') && text.includes('nobody can use admin endpoints')),
    'a viewer without an admin warns that nobody can administer',
    JSON.stringify(lonely),
  )
  const onlyViewerWrite = await request(onlyViewer, { method: 'POST', url: '/channel/delete', headers: { 'x-admin-token': 'view-secret' }, body: { keys: [] } })
  check(onlyViewerWrite.code === 403, 'the only configured token cannot write either', String(onlyViewerWrite.code))

  // 两个令牌配成一样：只读其实不存在，必须警告。
  const same = []
  makeGateway({ token: 'same-secret', viewerToken: 'same-secret' }, same)
  check(
    same.some(text => text.includes('viewer token equals the admin token')),
    'identical tokens warn that read-only is not restricted',
    JSON.stringify(same),
  )
  void warnings
}

// —— 常数时间比较 ——

check(constantTimeEqual('abc', 'abc') === true, 'constantTimeEqual matches equal strings')
check(constantTimeEqual('abc', 'abd') === false, 'constantTimeEqual rejects different strings')
check(constantTimeEqual('abc', 'abcdef') === false, 'constantTimeEqual survives different lengths')

// 直接测 classify：请求头优先于查询串，凭证来源要能报出来。
const direct = createAuth({ token: 'admin-secret' })
const url = token => new globalThis.URL(`http://localhost/channel/sessions?token=${token}`)
check(direct.classify({ method: 'GET', headers: { authorization: 'Bearer admin-secret' } }, url('nope'), '/channel').allowed === true, 'the header wins over the query string')
check(direct.classify({ method: 'GET', headers: {} }, url('admin-secret'), '/channel').via === 'query', 'classify reports when the token came from the query')
const inboundUrl = new globalThis.URL('http://localhost/channel')
check(direct.classify({ method: 'POST', headers: {} }, inboundUrl, '/channel').role === 'inbound', 'classify marks the inbound route')

await fs.rm(temp, { recursive: true, force: true })
console.log('')
console.log(failed === 0 ? 'all access control checks passed' : `${failed} check(s) failed`)
process.exit(failed === 0 ? 0 : 1)
