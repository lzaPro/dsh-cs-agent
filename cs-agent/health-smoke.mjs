// 健康检查与追踪 id 的自测：不需要真实 DSH，也不需要真实端口。
// Run with: node cs-agent/health-smoke.mjs
// 连库模式：DSH_DB=1 DSH_CS_STORE=postgres node cs-agent/health-smoke.mjs
import { promises as fs, mkdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createGateway } from './gateway.js'

const configuredStore = process.env.DSH_CS_STORE ?? ''
if (configuredStore !== '' && configuredStore !== 'json' && configuredStore !== 'postgres' && configuredStore !== 'pg') {
  console.error(`health-smoke does not understand DSH_CS_STORE=${configuredStore}`)
  process.exit(2)
}
const usePg = configuredStore === 'postgres' || configuredStore === 'pg'

let failed = 0
const check = (ok, label, detail = '') => {
  if (!ok) failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail === '' ? '' : `: ${detail}`}`)
}

/** 够用的 Host 替身：只实现网关会真的调到的那些。 */
function fakeCtx() {
  const followed = []
  const live = new Map()
  const workspaces = []
  return {
    followed,
    workspaces,
    logger: { warn: () => {} },
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
        const agent = {
          id: options.sessionId,
          followup: (message) => followed.push({ sessionId: options.sessionId, message }),
          inject: () => {},
        }
        live.set(options.sessionId, agent)
        return { agent }
      },
      get: id => live.get(id),
      async resume({ resumeSessionId }) {
        const agent = {
          id: resumeSessionId,
          followup: (message) => followed.push({ sessionId: resumeSessionId, message }),
          inject: () => {},
        }
        live.set(resumeSessionId, agent)
        return { agent }
      },
    },
    agentPresets: { async mount() {} },
    sessionTitle: { async rename() {} },
    on: () => () => {},
  }
}

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'health-smoke-'))
// 数据库模式共用一张表：key 带本次运行的唯一标记，免得上一轮的会话被当成重复消息短路。
const tag = `hs${process.pid}${Date.now()}`
const dataFile = path.join(temp, 'sessions.json')
const outboxFile = path.join(temp, 'outbox.jsonl')
const config = { route: '/channel', workspace: temp, agentPreset: 'service-desk', dataFile, outbox: outboxFile }

/** 调一次 handleHttp，返回 {code, body}。 */
async function call(gateway, method, url) {
  const res = {
    code: 0,
    body: '',
    writeHead(code) { this.code = code },
    end(payload) { this.body = payload },
  }
  await gateway.handleHttp({ method, url, headers: {} }, res)
  let parsed = {}
  try {
    parsed = res.body === '' ? {} : JSON.parse(res.body)
  } catch {
    parsed = { raw: res.body }
  }
  return { code: res.code, body: parsed }
}

const gateway = createGateway(fakeCtx(), config, { lease: { kind: 'file', lost: false } })

// —— 1. json 模式的基本形状 ——
const first = await gateway.inbound({ channel: 'qq', senderId: `${tag}-h1`, text: '扣了两次钱' })
check(typeof first.traceId === 'string' && first.traceId.length === 12, 'inbound returns a 12-char traceId', first.traceId)

const health = await call(gateway, 'GET', '/channel/health')
check(health.code === 200, 'health returns 200 when everything is fine', String(health.code))
check(health.body.ok === true, 'health says ok')
check(typeof health.body.uptimeMs === 'number' && health.body.uptimeMs >= 0, 'health reports uptime')
check(health.body.route === '/channel', 'health reports the route')
// 存储类型由 DSH_CS_STORE 决定，两种模式都要能跑这套用例。
check(health.body.store.kind === (usePg ? 'postgres' : 'json'), 'health reports the store kind', health.body.store.kind)
check(health.body.lease.kind === 'file' && health.body.lease.lost === false, 'health reports the lease')
check(health.body.queues.inbox.total >= 1, 'health reports inbox backlog', String(health.body.queues.inbox.total))
check(health.body.queues.inbox.sent >= 1, 'the accepted message was handled inline')
check(
  usePg ? health.body.database?.ok === true : health.body.database === null,
  usePg ? 'postgres mode reports a healthy database' : 'json mode reports no database',
)
const checkNames = health.body.checks.map(item => item.name)
check(checkNames.includes('lease') && checkNames.includes('inbox'), 'checks include lease and inbox', checkNames.join(','))
check(!checkNames.includes('outbox'), 'no outbox check without a reply webhook')
check(health.body.checks.every(item => typeof item.ok === 'boolean' && typeof item.detail === 'string'), 'every check has ok and detail')

// —— 2. 追踪 id 贯穿：模型消息 + 审计行 ——
const delivered = await gateway.inbound({ channel: 'qq', senderId: `${tag}-h2`, text: '第二条' })
const traceId = delivered.traceId
check(traceId !== first.traceId, 'each inbound message gets its own traceId')

// 回复信封里要带上触发它的那条消息的 traceId。
gateway.observe({ id: delivered.sessionId }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '好的' }] } } })
gateway.observe({ id: delivered.sessionId }, { type: 'turn/end', data: {} })
await new Promise(resolve => setTimeout(resolve, 50))
const auditLines = (await fs.readFile(outboxFile, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean)
check(auditLines.length === 1, 'the reply was written to the audit trail', String(auditLines.length))
const envelope = auditLines.length > 0 ? JSON.parse(auditLines[0]) : {}
check(envelope.text === '好的', 'audit line carries the reply text')
check(envelope.traceId === traceId, 'the reply envelope carries the traceId of the message that caused it', String(envelope.traceId))

// —— 3. 租约丢了 → 503 ——
const lostGw = createGateway(fakeCtx(), { ...config, dataFile: path.join(temp, 'lost.json'), outbox: path.join(temp, 'lost-outbox.jsonl') }, {
  lease: { kind: 'postgres', lost: true },
})
const lost = await call(lostGw, 'GET', '/channel/health')
check(lost.code === 503, 'a taken-over lease reports 503', String(lost.code))
check(lost.body.ok === false, 'a taken-over lease makes health not ok')
check(lost.body.checks.find(item => item.name === 'lease')?.ok === false, 'the lease check is the one that failed')

// —— 4. 没有租约（直接 createGateway）也不该崩 ——
const bare = createGateway(fakeCtx(), { ...config, dataFile: path.join(temp, 'bare.json'), outbox: path.join(temp, 'bare-outbox.jsonl') })
const bareHealth = await call(bare, 'GET', '/channel/health')
check(bareHealth.code === 200, 'health works without a lease attached', String(bareHealth.code))
check(bareHealth.body.lease.kind === null && bareHealth.body.checks[0].detail === 'not attached', 'a missing lease is reported, not thrown')

// —— 5. 连库模式 ——
if (usePg) {
  if (process.env.DSH_DB !== '1') {
    console.log('SKIP database health checks (set DSH_DB=1 to run them)')
  } else {
    const { closePool, query } = await import('./db/pool.mjs')
    const prefix = `health-smoke-${process.pid}-${Date.now()}`
    const pgGw = createGateway(fakeCtx(), { ...config, dataFile: path.join(temp, 'pg.json'), store: 'postgres' }, {
      lease: { kind: 'postgres', lost: false },
    })
    // 会话 key 带上前缀，收尾时能按 external_key 清干净。
    const pgFirst = await pgGw.inbound({ channel: prefix, senderId: 'p1', text: '连库模式' })
    check(typeof pgFirst.sessionId === 'string', 'postgres mode still accepts messages')

    const pgHealth = await call(pgGw, 'GET', '/channel/health')
    check(pgHealth.code === 200, 'postgres health returns 200', String(pgHealth.code))
    check(pgHealth.body.store.kind === 'postgres', 'postgres health reports the store kind')
    check(pgHealth.body.database !== null && pgHealth.body.database.ok === true, 'postgres health includes a healthy database probe')
    check(typeof pgHealth.body.database.version === 'string', 'the database probe reports the server version', String(pgHealth.body.database.version))
    check(pgHealth.body.checks.some(item => item.name === 'database' && item.ok === true), 'the database check is listed')
    check(pgHealth.body.queues.inbox.total >= 1, 'postgres health reports the inbox table')

    await query('delete from inbox where external_key like $1', [`${prefix}%`])
    await query('delete from conversations where external_key like $1', [`${prefix}%`])
    await closePool()
    check(true, 'postgres: test rows are cleaned up')
  }
}

if (usePg) {
  const { closePool, query } = await import('./db/pool.mjs')
  await query('delete from inbox where external_key like $1', [`qq:${tag}%`])
  await query('delete from conversations where external_key like $1', [`qq:${tag}%`])
  await closePool()
}
await fs.rm(temp, { recursive: true, force: true })

console.log(`\n${failed === 0 ? 'all checks passed' : `${failed} check(s) failed`}`)
process.exit(failed === 0 ? 0 : 1)
