// Ops package smoke test with a fake Host context: no Harness process required.
// Run with: node ops-agent/smoke.mjs
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDispatcher, parseResult, normalizeResult, parseLedger } from './dispatcher.js'
import { createCluster, redact } from './cluster.js'
import { createMetrics } from './metrics.js'
import { handleHttp } from './panel.js'

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
  const provided = new Map()
  const listeners = []
  return {
    created, delivered, live, attached, workspaces, provided, listeners,
    provide: (service, value) => { provided.set(service, value); return () => provided.delete(service) },
    get: service => provided.get(service),
    effect: () => {},
    on: (event, handler) => { listeners.push({ event, handler }); return () => {} },
    workspaceRegistry: {
      list: () => workspaces,
      create: async (workspacePath) => {
        const record = {
          path: workspacePath,
          title: undefined,
          sessionIds: [],
          attachSession: async (id) => { attached.push(id); record.sessionIds.push(id) },
          detachSession: async (id) => { record.sessionIds = record.sessionIds.filter(entry => entry !== id) },
          setTitle: async (title) => { record.title = title },
        }
        workspaces.push(record)
        return record
      },
    },
    logger: { warn: () => {} },
    agentDefaultModel: { currentSelection: () => ({ provider: 'test', model: 'test' }) },
    agentPresets: { async mount() {} },
    sessionTitle: { rename: () => {} },
    agents: {
      async create(options) {
        created.push(options)
        const agent = {
          session: { id: options.sessionId },
          followup: message => delivered.push({ sessionId: options.sessionId, message }),
        }
        live.set(options.sessionId, agent)
        return { agent }
      },
      get: id => live.get(id),
      async resume({ resumeSessionId }) {
        const agent = {
          session: { id: resumeSessionId },
          followup: message => delivered.push({ sessionId: resumeSessionId, message }),
        }
        live.set(resumeSessionId, agent)
        return { agent }
      },
    },
  }
}

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'ops-agent-'))
const ledger = path.join(temp, 'ops-ledger.jsonl')

// ---------------------------------------------------------------- dispatcher
{
  const ctx = fakeCtx()
  ctx.live.set('cs-1', {
    session: { id: 'cs-1' },
    followup: message => ctx.delivered.push({ sessionId: 'cs-1', message }),
  })
  const dispatcher = createDispatcher(ctx, { workspace: temp, ledger, timeoutMs: 60_000 })
  ctx.provided.set('opsDispatch', dispatcher)

  const dispatched = await dispatcher.dispatch({
    requesterSessionId: 'cs-1',
    task: { symptom: '付款成功但会员没到账', account: 'user-42', errorSignatures: ['-122'] },
  })
  check(dispatched.state === 'dispatched', 'dispatch returns dispatched')
  check(ctx.created.length === 1, 'dispatch creates one ops session')
  check(dispatched.opsSessionId.startsWith('ops-'), 'ops session id is prefixed')
  const taskText = ctx.delivered.find(item => item.sessionId === dispatched.opsSessionId)?.message?.content?.[0]?.text ?? ''
  check(taskText.includes(`运维任务 ${dispatched.incidentId}`), 'task card carries the incident id')
  check(taskText.includes('ops_env') && taskText.includes('ops_k8s') && taskText.includes('propose_change'), 'task card names the tools')
  check(taskText.includes('```json'), 'task card includes the closing protocol')

  // The ops agent closes with its JSON block; the dispatcher relays and settles.
  const opsSessionId = dispatched.opsSessionId
  dispatcher.observe({ id: opsSessionId }, {
    type: 'assistant/message',
    data: {
      message: {
        content: [{
          type: 'text',
          text: '查了 unless 的两条证据。\n```json\n'
            + JSON.stringify({
              status: 'resolved',
              severity: 'P2',
              confidence: 'high',
              diagnosis: '网关 token 被轮换，旧实例鉴权失败',
              evidence: [{ source: 'k8s', detail: 'payments-7d9 处于 CrashLoopBackOff' }, { source: 'log', detail: '401 invalid token' }],
              actions_taken: ['kubectl get pods -n payments'],
              verification: '重启后 200 恢复',
              customer_summary: '已经恢复，请重试。',
            })
            + '\n```',
        }],
      },
    },
  })
  dispatcher.observe({ id: opsSessionId }, { type: 'turn/end', data: {} })
  await sleep(50)

  const record = dispatcher.getIncident(dispatched.incidentId)
  check(record?.state === 'resolved', 'turn end settles the incident as resolved', record?.state)
  const relay = ctx.delivered.find(item => item.sessionId === 'cs-1' && item.message?.source?.kind === 'ops-result')
  check(relay !== undefined, 'result is relayed to the requesting session')
  const relayText = relay?.message?.content?.[0]?.text ?? ''
  check(relayText.includes('【运维回执】') && relayText.includes('已经恢复'), 'relay carries diagnosis and customer summary')
  check(relayText.includes('不要提及内部会话'), 'relay reminds the agent to de-identify')

  const raw = await fs.readFile(ledger, 'utf8')
  check(raw.includes('"kind":"dispatch"') && raw.includes('"kind":"result"'), 'ledger records dispatch and result')
  const history = parseLedger(raw)
  check(history.length === 1 && history[0].incidentId === dispatched.incidentId, 'ledger rebuilds one incident')
  check(history[0].state === 'resolved', 'ledger rebuild keeps the settled state')

  // Proposals: created from inside an ops session, approved by an administrator.
  const proposal = await dispatcher.proposeChange(opsSessionId, {
    action: '提高内存上限', target: 'payments/deploy', command: 'kubectl set resources ...',
    impact: '滚动重启 1 分钟', rollback: '改回 512Mi', verify: '观察 OOM 计数',
  }, { from: 'tool' })
  check(proposal.ok && proposal.id.startsWith('PR-'), 'proposeChange mints a PR id')
  check(dispatcher.listProposals().filter(item => item.status === 'pending').length === 1, 'proposal starts pending')
  const approved = await dispatcher.approveChange(proposal.id, { by: 'admin', note: '同意' })
  check(approved.ok && approved.proposal.status === 'approved', 'approval flips the proposal')
  const again = await dispatcher.approveChange(proposal.id, {})
  check(again.ok === false, 'approving twice is refused')

  // need_info round trip: ask, then resume the same ops session.
  const second = await dispatcher.dispatch({ requesterSessionId: 'cs-1', task: { symptom: '对话没反应' } })
  dispatcher.observe({ id: second.opsSessionId }, {
    type: 'assistant/message',
    data: {
      message: {
        content: [{
          type: 'text',
          text: '```json\n'
            + JSON.stringify({ status: 'need_info', diagnosis: '需要账号', need_from_customer: ['请提供账号 ID'], customer_summary: '需要确认一下账号。' })
            + '\n```',
        }],
      },
    },
  })
  dispatcher.observe({ id: second.opsSessionId }, { type: 'turn/end', data: {} })
  await sleep(50)
  check(dispatcher.getIncident(second.incidentId)?.state === 'need_info', 'need_info settles as need_info')
  const resumed = await dispatcher.resume(second.incidentId, '账号是 user-42')
  check(resumed.ok === true, 'resume continues the incident')
  const followup = ctx.delivered.filter(item => item.sessionId === second.opsSessionId).at(-1)
  check((followup?.message?.content?.[0]?.text ?? '').includes('补充信息'), 'resume delivers the补充信息 turn')
  check(dispatcher.getIncident(second.incidentId)?.state === 'running', 'resume returns the incident to running')
  const missing = await dispatcher.resume('INC-nope', 'x')
  check(missing.ok === false, 'resume unknown incident is refused')
  dispatcher.dispose()
}

// ---------------------------------------------- 管理员插话 vs 结论（relayEveryTurn）
{
  const ctx = fakeCtx()
  ctx.live.set('cs-2', {
    session: { id: 'cs-2' },
    followup: message => ctx.delivered.push({ sessionId: 'cs-2', message }),
  })
  const dispatcher = createDispatcher(ctx, { workspace: temp, ledger: path.join(temp, 'quiet.jsonl'), timeoutMs: 60_000, relayEveryTurn: false })
  ctx.provided.set('opsDispatch', dispatcher)
  const { incidentId, opsSessionId } = await dispatcher.dispatch({
    requesterSessionId: 'cs-2',
    task: { symptom: '接口偶发 502' },
  })
  const turnEnd = id => dispatcher.observe({ id }, { type: 'turn/end', data: {} })
  const say = (id, text) => dispatcher.observe({ id }, {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text }] } },
  })

  // 管理员插问一句，运维答了但没有结论块：不应回执，工单继续 running。
  say(opsSessionId, '顺便说一下，这个集群昨天升级过 kubectl。')
  turnEnd(opsSessionId)
  await sleep(50)
  check(dispatcher.getIncident(incidentId)?.state === 'running', 'interim turn keeps the incident running')
  check(ctx.delivered.filter(item => item.sessionId === 'cs-2').length === 0, 'interim turn does not relay to the requester')

  // 结论块到达时照常收尾。
  say(opsSessionId, '结论如下。\n```json\n' + JSON.stringify({ status: 'resolved', diagnosis: '上游连接池耗尽', customer_summary: '已恢复。' }) + '\n```')
  turnEnd(opsSessionId)
  await sleep(50)
  check(dispatcher.getIncident(incidentId)?.state === 'resolved', 'the closing block still settles the incident')
  check(ctx.delivered.some(item => item.sessionId === 'cs-2'), 'the closing block relays to the requester')
  dispatcher.dispose()
}

// ------------------------------------------------------------------ protocol
{
  check(parseResult('no block') === undefined, 'parseResult ignores text without a block')
  check(parseResult('```json\n{"status":"resolved"}\n```')?.status === 'resolved', 'parseResult reads a block')
  check(parseResult('```json\n{"noStatus":true}\n```') === undefined, 'parseResult requires status')
  check(parseResult('```json\n{bad json}\n```') === undefined, 'parseResult tolerates broken JSON')
  const normalized = normalizeResult({ status: 'weird', evidence: ['raw line'], actions_taken: 'nope' })
  check(normalized.status === 'needs_human', 'unknown status degrades to needs_human')
  check(normalized.evidence[0]?.source === 'unknown', 'string evidence gets a source')
  check(Array.isArray(normalized.actions_taken) && normalized.actions_taken.length === 0, 'non-array actions become []')
}

// -------------------------------------------------------------------- cluster
{
  check(redact('token: abc123').includes('***'), 'redact masks token')
  check(redact('联系 alice@example.com 或 13812345678').includes('***@***'), 'redact masks email')
  check(redact('电话 13812345678').includes('1**********'), 'redact masks phone')

  const cluster = createCluster({ kubeconfig: path.join(temp, 'kubeconfig'), namespaces: ['payments'] })
  let refused = ''
  try {
    await cluster.k8s({ verb: 'delete', resource: 'pods' })
  } catch (error) {
    refused = error.message
  }
  check(refused.includes('只读动词'), 'write verbs are refused', refused)

  refused = ''
  try {
    await cluster.k8s({ verb: 'get', resource: 'secrets' })
  } catch (error) {
    refused = error.message
  }
  check(refused.includes('禁止读取 secrets'), 'secret reads are refused', refused)

  refused = ''
  try {
    await cluster.k8s({ verb: 'get', resource: 'pods', namespace: 'kube-system' })
  } catch (error) {
    refused = error.message
  }
  check(refused.includes('不在白名单'), 'namespaces outside the allowlist are refused', refused)

  const env = await cluster.env()
  check(env.readOnly === true && Array.isArray(env.checks), 'env self-check always reports checks')
  check(env.ok === false, 'env reports failure without a kubeconfig')
}

// -------------------------------------------------------------------- metrics
{
  const metrics = createMetrics({})
  check(metrics.status().configured === false, 'metrics reports unconfigured')
  const result = await metrics.query({ query: 'up' })
  check(result.ok === false && result.configured === false, 'metrics query fails soft when unconfigured')
  const wired = createMetrics({ prometheusUrl: 'http://prom.example' })
  check(wired.status().configured === true, 'metrics accepts a prometheus url')
  let refused = ''
  try {
    createMetrics({ prometheusUrl: 'ftp://x' })
  } catch (error) {
    refused = error.message
  }
  check(refused.includes('http'), 'metrics rejects non-http urls')
}

// ---------------------------------------------------------------------- panel
{
  const ctx = fakeCtx()
  // 状态文件必须指向临时目录：跑测试不能改到 ~/.dsh 里真实的协同开关。
  const stateFile = path.join(temp, 'ops-state.json')
  const dispatcher = createDispatcher(ctx, { workspace: temp, ledger, timeoutMs: 60_000, stateFile })
  ctx.provided.set('opsDispatch', dispatcher)
  const panel = { route: '/ops', cluster: createCluster({ kubeconfig: path.join(temp, 'kubeconfig') }) }

  const call = async (method, url, body) => {
    const request = {
      method,
      url,
      async *[Symbol.asyncIterator]() {
        if (body !== undefined) yield Buffer.from(JSON.stringify(body))
      },
    }
    let status = 0
    let payload = ''
    const response = {
      writeHead: value => { status = value },
      end: value => { payload = String(value ?? '') },
    }
    await handleHttp(ctx, panel, request, response)
    return { status, payload }
  }

  const page = await call('GET', '/ops/panel')
  check(page.status === 200 && page.payload.includes('运维控制台'), 'panel serves the dashboard')
  const status = await call('GET', '/ops/status')
  check(status.status === 200 && JSON.parse(status.payload).ok === true, 'status endpoint answers')
  const incidents = await call('GET', '/ops/incidents')
  check(JSON.parse(incidents.payload).ok === true, 'incidents endpoint answers')
  const missing = await call('GET', '/ops/nope')
  check(missing.status === 404, 'unknown panel route is 404')
  const kb = await call('GET', '/ops/kb/candidates')
  check(kb.status === 503, 'kb endpoint reports a missing store')

  // 协同开关：关掉之后客服侧不再能派单，面板与状态接口都要如实反映。
  check(JSON.parse(status.payload).enabled === true, 'panel: collaboration starts enabled by default')
  const off = await call('POST', '/ops/disable', { by: 'admin' })
  check(off.status === 200 && JSON.parse(off.payload).enabled === false, 'panel: can switch collaboration off')
  check(JSON.parse((await call('GET', '/ops/status')).payload).enabled === false, 'panel: status reports the switch')
  let refused = ''
  try {
    await dispatcher.dispatch({ requesterSessionId: 'cs-1', task: { symptom: '关闭后派单' } })
  } catch (error) {
    refused = error.message
  }
  check(refused.includes('运维协同已关闭'), 'dispatch refuses while switched off', refused)
  const on = await call('POST', '/ops/enable', { by: 'admin' })
  check(on.status === 200 && JSON.parse(on.payload).enabled === true, 'panel: can switch collaboration back on')
  // 落盘：新调度器读到的是关闭状态，而不是默认开启。
  await call('POST', '/ops/disable', { by: 'admin' })
  const reloaded = createDispatcher(ctx, { workspace: temp, ledger, timeoutMs: 60_000, stateFile })
  check(reloaded.isEnabled() === false, 'the switch survives a restart')
  const page2 = await call('GET', '/ops/panel')
  check(page2.payload.includes('协同'), 'panel: the toggle is on the page')
  check(page2.payload.includes('opsSession='), 'panel: incidents link out to their conversations')
  reloaded.dispose()
  dispatcher.dispose()
}


// --- context 白名单：多集群时只能看被允许的那几个 -------------------------------
{
  const scoped = createCluster({ namespaces: ['*'], contexts: ['prod-only'], context: 'prod-only' })
  const env = await scoped.env()
  check(env.contexts.includes('prod-only'), 'env: reports the configured contexts')
  check(env.context === 'prod-only', 'env: reports the configured default context')

  let refused = false
  try {
    await scoped.k8s({ verb: 'get', resource: 'pods', namespace: 'default', context: 'dev-cluster' })
  } catch (error) {
    refused = /不在白名单/.test(error.message)
  }
  check(refused, 'k8s: refuses a context outside the allowlist')

  const logs = await scoped.logs({ pod: 'api-1', namespace: 'default', tailLines: 5 })
  check(logs.context === 'prod-only', 'logs: inherits the default context', String(logs.context))
}

// ------------------------------------------------- 归档 / 删除 / 搜索（会话整理）
{
  const ctx = fakeCtx()
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ops-tidy-'))
  const tidyLedger = path.join(dir, 'ops-ledger.jsonl')
  const dispatcher = createDispatcher(ctx, {
    workspace: dir,
    ledger: tidyLedger,
    timeoutMs: 60_000,
    stateFile: path.join(dir, 'ops-state.json'),
  })
  ctx.provided.set('opsDispatch', dispatcher)
  const panel = { route: '/ops', cluster: createCluster({ kubeconfig: path.join(dir, 'kubeconfig') }) }
  const call = async (method, url, body) => {
    const request = {
      method,
      url,
      async *[Symbol.asyncIterator]() {
        if (body !== undefined) yield Buffer.from(JSON.stringify(body))
      },
    }
    let status = 0
    let payload = ''
    await handleHttp(ctx, panel, request, {
      writeHead: value => { status = value },
      end: value => { payload = String(value ?? '') },
    })
    return { status, payload }
  }
  const finish = async (sessionId, text) => {
    dispatcher.observe({ id: sessionId }, {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text }] } },
    })
    dispatcher.observe({ id: sessionId }, { type: 'turn/end', data: {} })
    await sleep(5)
  }
  const silence = () => { createDispatcher; }

  // 一单跑完：归档之后从默认看板消失，但加上 archived=1 还在。
  const done = await dispatcher.dispatch({ requesterSessionId: 'cs-tidy', task: { symptom: 'PVC 已满 -122' } })
  await finish(done.opsSessionId, '```json\n{"status":"resolved","diagnosis":"磁盘已满","customer_summary":"好了"}\n```')
  const archived = await dispatcher.setArchived(done.incidentId, true, { by: 'admin', note: '误报' })
  check(archived.ok === true && archived.archived === true, 'archive: marks an incident archived')
  const hidden = await call('GET', '/ops/incidents')
  check(JSON.parse(hidden.payload).live.every(item => item.incidentId !== done.incidentId), 'archive: hidden from the default board')
  const shown = await call('GET', '/ops/incidents?archived=1')
  check(JSON.parse(shown.payload).archivedCount === 1, 'archive: still reachable with archived=1')
  const ledgerText = await fs.readFile(tidyLedger, 'utf8')
  check(ledgerText.includes('"kind":"archive"'), 'archive: leaves an audit row in the ledger')
  const unarchive = await dispatcher.setArchived(done.incidentId, false, { by: 'admin' })
  check(unarchive.ok === true && unarchive.archived === false, 'archive: can be undone')

  // 搜索：命中现象、会话 id、工单号；不命中的给 0。
  const bySymptom = JSON.parse((await call('GET', '/ops/incidents?q=PVC')).payload)
  check(bySymptom.live.some(item => item.incidentId === done.incidentId), 'search: matches the symptom')
  const bySession = JSON.parse((await call('GET', '/ops/incidents?q=' + encodeURIComponent(done.opsSessionId))).payload)
  check(bySession.live.some(item => item.incidentId === done.incidentId), 'search: matches the ops session id')
  const byId = JSON.parse((await call('GET', '/ops/incidents?q=' + encodeURIComponent(done.incidentId))).payload)
  check(byId.live.length === 1, 'search: matches the incident id')
  const none = JSON.parse((await call('GET', '/ops/incidents?q=完全不存在的词')).payload)
  check(none.live.length === 0 && none.historic.length === 0, 'search: no false positives')
  const two = JSON.parse((await call('GET', '/ops/incidents?q=' + encodeURIComponent('磁盘 PVC'))).payload)
  check(two.live.length === 1, 'search: every term must match')

  // 运行中的工单不许删：结论还没落库，删了就看不出它跑过。
  const running = await dispatcher.dispatch({ requesterSessionId: 'cs-tidy', task: { symptom: '还在跑' } })
  const refusedDelete = await dispatcher.removeIncident(running.incidentId, { by: 'admin' })
  check(refusedDelete.ok === false && refusedDelete.reason.includes('还在运行'), 'delete: refuses a running incident')
  await finish(running.opsSessionId, '```json\n{"status":"needs_human","diagnosis":"看不出来"}\n```')
  const removed = await dispatcher.removeIncident(running.incidentId, { by: 'admin' })
  check(removed.ok === true && removed.deleted === true, 'delete: removes a finished incident')
  check(removed.detached.length >= 2, 'delete: detaches both conversations from the workspace')
  const afterDelete = JSON.parse((await call('GET', '/ops/incidents')).payload)
  check(afterDelete.live.every(item => item.incidentId !== running.incidentId)
    && afterDelete.historic.every(item => item.incidentId !== running.incidentId), 'delete: gone from the board')
  const deleteRow = (await fs.readFile(tidyLedger, 'utf8')).includes('"kind":"delete"')
  check(deleteRow, 'delete: leaves an audit row in the ledger')
  const viaPanel = await call('POST', '/ops/incidents/' + encodeURIComponent(done.incidentId) + '/delete', { by: 'admin' })
  check(JSON.parse(viaPanel.payload).ok === true, 'delete: exposed over the panel route')

  dispatcher.dispose()
  await fs.rm(dir, { recursive: true, force: true })
}

await fs.rm(temp, { recursive: true, force: true })
console.log(failed === 0 ? '\nops-agent smoke: all checks passed' : `\nops-agent smoke: ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
