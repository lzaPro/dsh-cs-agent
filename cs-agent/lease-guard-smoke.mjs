// 丢锁之后的写入门禁：读还能读，写必须被明确拒绝，后台扫描要自己停。
// Run with: node cs-agent/lease-guard-smoke.mjs
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createGateway } from './gateway.js'

let failed = 0
const check = (ok, label, detail = '') => {
  if (!ok) failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail === '' ? '' : `: ${detail}`}`)
}

function fakeCtx() {
  const followed = []
  const live = new Map()
  const workspaces = []
  return {
    followed,
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
          followup: message => followed.push({ sessionId: options.sessionId, message }),
          inject: () => {},
        }
        live.set(options.sessionId, agent)
        return { agent }
      },
      get: id => live.get(id),
      async resume({ resumeSessionId }) {
        const agent = {
          id: resumeSessionId,
          followup: message => followed.push({ sessionId: resumeSessionId, message }),
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

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'lease-guard-'))
const dataFile = path.join(temp, 'sessions.json')
const outboxFile = path.join(temp, 'outbox.jsonl')
const config = { route: '/channel', workspace: temp, agentPreset: 'service-desk', dataFile, outbox: outboxFile }

/** 可切换的租约替身：验证"丢锁之后"的行为最方便的写法。 */
const lease = { kind: 'postgres', lost: false }
const warnings = []
const ctx = { ...fakeCtx(), logger: { warn: message => warnings.push(message) } }
const gateway = createGateway(ctx, config, { lease })

let rejection
const rejects = async (label, run) => {
  try {
    await run()
    check(false, label, 'no error thrown')
    return undefined
  } catch (error) {
    check(true, label, error.code ?? error.message)
    return error
  }
}

// —— 1. 租约还在：一切照旧 ——
const first = await gateway.inbound({ channel: 'qq', senderId: 'g1', text: '扣了两次钱' })
check(typeof first.sessionId === 'string', 'a message is accepted while the lease is held')
check(ctx.followed.length === 1, 'the model was woken once')

// —— 2. 丢锁之后：写入被拒 ——
lease.lost = true
rejection = await rejects('an inbound message is refused after the lease is lost', () =>
  gateway.inbound({ channel: 'qq', senderId: 'g2', text: '第二个人' }))
check(rejection?.code === 'LEASE_LOST', 'the refusal carries a LEASE_LOST code', String(rejection?.code))
check(
  /write refused, the write lease was taken over/.test(rejection?.message ?? ''),
  'the refusal explains that the lease was taken over',
)
check(ctx.followed.length === 1, 'no model call happened for the refused message')

// emit 是内部函数：走 observe 的真实路径 —— 模型回了话，但租约已丢，回复必须发不出去，
// 而且不能变成未捕获的 Promise 拒绝把进程带走。
gateway.observe({ id: first.sessionId }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '这条不该发出去' }] } } })
gateway.observe({ id: first.sessionId }, { type: 'turn/end', data: {} })
await new Promise(resolve => setTimeout(resolve, 50))
check(warnings.some(message => /reply not sent: .*write lease was taken over/.test(message)), 'the refused reply is logged, not thrown', warnings[0] ?? '')
const outboxAfter = await fs.readFile(outboxFile, 'utf8').catch(() => '')
check(outboxAfter.trim() === '', 'the refused reply never reached the audit trail')

await rejects('changing the mode is refused after the lease is lost', () => gateway.setMode('qq:g1', 'human'))
await rejects('deleting a conversation is refused after the lease is lost', () => gateway.deleteConversation('qq:g1'))

// —— 3. 读路径不受影响：丢锁后仍然能看状态 ——
const statusRes = { code: 0, body: '', writeHead(code) { this.code = code }, end(payload) { this.body = payload } }
await gateway.handleHttp({ method: 'GET', url: '/channel/status', headers: {} }, statusRes)
check(statusRes.code === 200, 'status still works after the lease is lost', String(statusRes.code))

const modeRes = { code: 0, body: '', writeHead(code) { this.code = code }, end(payload) { this.body = payload } }
await gateway.handleHttp({
  method: 'POST', url: '/channel/mode', headers: {},
  async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({ key: 'qq:g1', mode: 'human' })) },
}, modeRes)
check(modeRes.code === 503, 'a write through HTTP answers 503 after the lease is lost', String(modeRes.code))
check(JSON.parse(modeRes.body).code === 'LEASE_LOST', 'the HTTP error names LEASE_LOST', String(JSON.parse(modeRes.body).code))

const healthRes = { code: 0, body: '', writeHead(code) { this.code = code }, end(payload) { this.body = payload } }
await gateway.handleHttp({ method: 'GET', url: '/channel/health', headers: {} }, healthRes)
check(healthRes.code === 503, 'health reports 503 after the lease is lost', String(healthRes.code))
check(
  JSON.parse(healthRes.body).checks.some(item => item.name === 'lease' && item.ok === false),
  'health names the lease check as the failing one',
)

// —— 4. 后台扫描自己停：不能继续往别人的库里写 ——
const workerWarnings = []
const watched = { ...ctx, logger: { warn: message => workerWarnings.push(message) } }
const workerLease = { kind: 'postgres', lost: false }
const workerGw = createGateway(watched, { ...config, dataFile: path.join(temp, 'w.json'), outbox: path.join(temp, 'w-outbox.jsonl') }, { lease: workerLease })
workerLease.lost = true
check(workerGw.startWorker() === true, 'the worker starts while the lease is held')
await new Promise(resolve => setTimeout(resolve, 120))
check(workerWarnings.some(message => /write lease lost; stopping the retry worker/.test(message)), 'the worker warns once and stops itself', workerWarnings[0] ?? '')
check(workerGw.stopWorker() === false, 'stopping an already-stopped worker is not an error')

await fs.rm(temp, { recursive: true, force: true })

console.log(`\n${failed === 0 ? 'all checks passed' : `${failed} check(s) failed`}`)
process.exit(failed === 0 ? 0 : 1)
