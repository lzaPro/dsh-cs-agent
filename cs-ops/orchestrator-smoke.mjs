// Dispatcher smoke test with a fake Host context: no Harness process required.
// Run with: node cs-agent/orchestrator-smoke.mjs
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDispatcher, parseResult } from './orchestrator.js'

let failed = 0
const check = (ok, label, detail = '') => {
  if (!ok) failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail === '' ? '' : `: ${detail}`}`)
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/** Host stand-in: records created sessions and delivered messages. */
function fakeCtx() {
  const created = []
  const delivered = []
  const live = new Map()
  const attached = []
  const workspaces = []
  return {
    created, delivered, live, attached, workspaces,
    workspaceRegistry: {
      create: async (path) => {
        const record = { path, title: undefined }
        workspaces.push(record)
        return {
          attachSession: async (id) => { attached.push(id) },
          setTitle: async (title) => { record.title = title },
        }
      },
    },
    logger: { warn: () => {} },
    agentDefaultModel: { currentSelection: () => ({ provider: 'test', model: 'test' }) },
    agentPresets: { async mount() {} },
    sessionTitle: { rename() {} },
    agents: {
      async create(options) {
        created.push(options)
        const agent = {
          id: options.sessionId,
          followup: (message) => delivered.push({ sessionId: options.sessionId, message }),
        }
        live.set(options.sessionId, agent)
        return { agent }
      },
      get: id => live.get(id),
      async resume({ resumeSessionId }) {
        const agent = {
          id: resumeSessionId,
          followup: (message) => delivered.push({ sessionId: resumeSessionId, message }),
        }
        live.set(resumeSessionId, agent)
        return { agent }
      },
    },
  }
}

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'ops-'))
const taskLog = path.join(temp, 'tasks.jsonl')
const notifyLog = path.join(temp, 'notify.jsonl')

{
  const ctx = fakeCtx()
  ctx.live.set('cs-1', { id: 'cs-1', followup: m => ctx.delivered.push({ sessionId: 'cs-1', message: m }) })
  const dispatcher = createDispatcher(ctx, {
    opsPreset: 'ops',
    workspace: temp,
    timeoutMs: 60_000,
    taskLog,
    notifyLog,
  })
  const dispatched = await dispatcher.dispatch({
    requesterSessionId: 'cs-1',
    task: { symptom: '对话没反应', account: '138****', errorSignatures: ['no healthy upstream'] },
  })
  check(typeof dispatched.incidentId === 'string' && dispatched.incidentId.startsWith('INC-'), 'incident id allocated')
  check(ctx.created.length === 1 && ctx.created[0].meta.agentPreset === 'ops', 'ops session created with the ops preset')
  check(ctx.created[0].meta.cwd === temp, 'ops session uses the ops workspace')
  check(ctx.attached.includes(dispatched.opsSessionId), 'ops session is attached to the workspace')
  check(ctx.workspaces[0]?.title === '运维', 'ops workspace is titled 运维')
  const prompt = ctx.delivered.at(-1).message.content[0].text
  check(prompt.includes('对话没反应') && prompt.includes('no healthy upstream'), 'task card carries the symptom')
  check(prompt.includes('```json'), 'task card asks for the JSON block')

  // Ops answers with the protocol block.
  dispatcher.observe({ id: dispatched.opsSessionId }, {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text: '查到了，PVC 满了。' }] } },
  })
  dispatcher.observe({ id: dispatched.opsSessionId }, {
    type: 'assistant/message',
    data: {
      message: {
        content: [{
          type: 'text',
          text: '```json\n' + JSON.stringify({
            status: 'resolved',
            diagnosis: 'PVC 配额写满',
            evidence: ['pod CrashLoopBackOff', 'log: disk quota exceed'],
            actions_taken: [],
            verification: 'Pod Ready',
            customer_summary: '存储空间满了，已清理，可以重试',
          }) + '\n```',
        }],
      },
    },
  })
  dispatcher.observe({ id: dispatched.opsSessionId }, { type: 'turn/end', data: { reason: 'done' } })
  await sleep(20)

  const relay = ctx.delivered.filter(item => item.sessionId === 'cs-1').at(-1)
  check(relay !== undefined && relay.message.content[0].text.includes('resolved'), 'result relayed to customer service')
  check(relay.message.content[0].text.includes('存储空间满了'), 'relay carries the customer summary')
  check(dispatcher.getTask(dispatched.opsSessionId).state === 'resolved', 'task marked resolved')

  const rows = (await fs.readFile(taskLog, 'utf8')).trim().split('\n').map(JSON.parse)
  check(rows.length >= 1 && rows.at(-1).result?.status === 'resolved', 'task log records the result')
  dispatcher.dispose()
}

{
  const ctx = fakeCtx()
  ctx.live.set('cs-2', { id: 'cs-2', followup: m => ctx.delivered.push({ sessionId: 'cs-2', message: m }) })
  const dispatcher = createDispatcher(ctx, { opsPreset: 'ops', workspace: temp, timeoutMs: 60_000, taskLog, notifyLog })
  const dispatched = await dispatcher.dispatch({ requesterSessionId: 'cs-2', task: { symptom: '连不上' } })
  dispatcher.observe({ id: dispatched.opsSessionId }, {
    type: 'assistant/message',
    data: {
      message: {
        content: [{
          type: 'text',
          text: '```json\n{"status":"needs_human","diagnosis":"证据不足","evidence":[],"actions_taken":[],"verification":"","customer_summary":"需要人工介入"}\n```',
        }],
      },
    },
  })
  dispatcher.observe({ id: dispatched.opsSessionId }, { type: 'turn/end', data: { reason: 'done' } })
  await sleep(20)
  const notified = (await fs.readFile(notifyLog, 'utf8')).trim().split('\n').map(JSON.parse)
  check(notified.some(row => row.text.includes('需要人工')), 'needs_human notifies the admin')
  const relay = ctx.delivered.filter(item => item.sessionId === 'cs-2').at(-1)
  check(relay.message.content[0].text.includes('needs_human'), 'needs_human still relays to customer service')
  dispatcher.dispose()
}

{
  const ctx = fakeCtx()
  ctx.live.set('cs-3', { id: 'cs-3', followup: m => ctx.delivered.push({ sessionId: 'cs-3', message: m }) })
  const before = (await fs.readFile(notifyLog, 'utf8')).trim().split('\n').length
  const dispatcher = createDispatcher(ctx, { opsPreset: 'ops', workspace: temp, timeoutMs: 40, taskLog, notifyLog })
  await dispatcher.dispatch({ requesterSessionId: 'cs-3', task: { symptom: '很慢' } })
  await sleep(120)
  const after = (await fs.readFile(notifyLog, 'utf8')).trim().split('\n').map(JSON.parse)
  check(after.length > before && after.at(-1).text.includes('超时'), 'timeout notifies the admin')
  const relay = ctx.delivered.filter(item => item.sessionId === 'cs-3').at(-1)
  check(relay.message.content[0].text.includes('timeout'), 'timeout relays a fallback to customer service')
  dispatcher.dispose()
}

{
  const ctx = fakeCtx()
  const dispatcher = createDispatcher(ctx, { opsPreset: 'ops', workspace: temp, timeoutMs: 60_000, taskLog, notifyLog })
  // No closing JSON: treat as needs_human instead of silently losing the result.
  ctx.live.set('cs-4', { id: 'cs-4', followup: m => ctx.delivered.push({ sessionId: 'cs-4', message: m }) })
  const dispatched = await dispatcher.dispatch({ requesterSessionId: 'cs-4', task: { symptom: 'x' } })
  dispatcher.observe({ id: dispatched.opsSessionId }, {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text: '我查了一下，但没给结论。' }] } },
  })
  dispatcher.observe({ id: dispatched.opsSessionId }, { type: 'turn/end', data: { reason: 'done' } })
  await sleep(20)
  check(dispatcher.getTask(dispatched.opsSessionId).state === 'needs_human', 'missing JSON block falls back to needs_human')
  dispatcher.dispose()
}

{
  check(parseResult('no block') === undefined, 'parse rejects a missing block')
  check(parseResult('```json\n{"status":"resolved"}\n```')?.status === 'resolved', 'parse reads a block')
  check(parseResult('```json\n{bad}\n```') === undefined, 'parse rejects invalid JSON')
  check(parseResult('```json\n{"x":1}\n```') === undefined, 'parse rejects a missing status')
}

{
  const ctx = fakeCtx()
  const dispatcher = createDispatcher(ctx, { opsPreset: 'ops', workspace: temp, timeoutMs: 60_000, taskLog, notifyLog })
  let error
  try {
    await dispatcher.dispatch({ requesterSessionId: 'cs-x', task: {} })
  } catch (caught) {
    error = caught
  }
  check(error !== undefined, 'rejects a task without a symptom')
  dispatcher.dispose()
}

await fs.rm(temp, { recursive: true, force: true })
process.exit(failed === 0 ? 0 : 1)
