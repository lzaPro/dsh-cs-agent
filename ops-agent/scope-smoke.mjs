// 账号作用域：把"这张工单属于哪个客户"变成服务端的硬约束，而不是 Prompt 里的软约束。
// Run with: node ops-agent/scope-smoke.mjs
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createCluster } from './cluster.js'
import { createDispatcher } from './dispatcher.js'
import { apply as applyMetrics, createMetrics } from './metrics.js'
import { checkMetricsScope, literalAlternatives, namespaceMatchers } from './promql.js'
import {
  describeScope,
  effectiveContexts,
  effectiveNamespaces,
  parseAccounts,
  scopeFor,
} from './scope.js'

let failed = 0
const check = (ok, label, detail = '') => {
  if (!ok) failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail === '' ? '' : `: ${detail}`}`)
}

/** 抓到同步/异步抛错，返回错误消息（没抛返回空串）。 */
async function caught(run) {
  try {
    await run()
    return ''
  } catch (error) {
    return error.message
  }
}

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'ops-scope-'))
const kubeconfig = path.join(temp, 'kubeconfig')

// ---------------------------------------------------------------- 纯函数
{
  const none = parseAccounts(undefined)
  check(none.configured === false && none.entries.length === 0, 'no accounts means no restriction', JSON.stringify(none))

  const bad = await caught(() => parseAccounts(['acme']))
  check(bad.includes('accounts 必须是对象'), 'a non-object accounts table is refused', bad)

  const emptyId = await caught(() => parseAccounts({ '  ': { namespaces: ['x'] } }))
  check(emptyId.includes('空账号 id'), 'a blank account id is refused', emptyId)

  const badEntry = await caught(() => parseAccounts({ acme: 'prod' }))
  check(badEntry.includes('accounts.acme 必须是对象'), 'a non-object account entry is refused', badEntry)

  const parsed = parseAccounts({
    acme: { namespaces: ['acme-prod', 'acme-staging'], contexts: ['prod'], aliases: ['Acme Inc', 'acme.com'] },
    globex: { namespaces: ['globex'] },
  })
  check(parsed.configured === true && parsed.entries.length === 2, 'two accounts parse', String(parsed.entries.length))
  const acme = parsed.entries.find(entry => entry.id === 'acme')
  check(acme.namespaces.length === 2 && acme.contexts[0] === 'prod', 'namespaces and contexts are kept', JSON.stringify(acme))
  check(acme.aliases.includes('Acme Inc'), 'aliases are kept')
  const globex = parsed.entries.find(entry => entry.id === 'globex')
  check(globex.contexts === undefined, 'an omitted context list stays undefined (no extra limit)', JSON.stringify(globex))

  // 不配账号表：一律不限制，保持重构前行为。
  const loose = scopeFor(none, 'whatever')
  check(loose.configured === false && loose.unbound === false && loose.unknown === false, 'unconfigured scope never blocks', JSON.stringify(loose))

  // 配了但工单没写账号：拒绝取证（最容易漏的一种）。
  const unbound = scopeFor(parsed, undefined)
  check(unbound.unbound === true, 'a missing account is unbound', JSON.stringify(unbound))
  const emptyAccount = scopeFor(parsed, '   ')
  check(emptyAccount.unbound === true, 'a blank account is unbound too')

  // 不认识的账号：拒绝，而不是"放行".
  const unknown = scopeFor(parsed, 'initech')
  check(unknown.unknown === true && unknown.account === 'initech', 'an unknown account is refused, not allowed', JSON.stringify(unknown))

  const exact = scopeFor(parsed, 'acme')
  check(exact.namespaces.length === 2 && exact.unknown === false, 'an exact account id narrows namespaces', JSON.stringify(exact))
  const folded = scopeFor(parsed, 'ACME')
  check(folded.account === 'acme', 'account matching ignores case', JSON.stringify(folded))
  const aliased = scopeFor(parsed, 'acme.com')
  check(aliased.account === 'acme' && aliased.namespaces.length === 2, 'an alias resolves to the account', JSON.stringify(aliased))

  // 交集语义：全局允许一切，也要以账号为准。
  check(
    JSON.stringify(effectiveNamespaces(['*'], exact)) === JSON.stringify({ namespaces: ['acme-prod', 'acme-staging'], allowAll: false }),
    'a global * still narrows to the account list',
    JSON.stringify(effectiveNamespaces(['*'], exact)),
  )
  const intersected = effectiveNamespaces(['acme-prod', 'shared'], exact)
  check(
    JSON.stringify(intersected.namespaces) === JSON.stringify(['acme-prod']),
    'the account list and the global list intersect',
    JSON.stringify(intersected),
  )
  check(effectiveNamespaces(['*'], loose).allowAll === true, 'without a scope the global * still allows everything')
  check(effectiveNamespaces([], exact).namespaces.length === 0, 'an empty global list still denies everything')

  check(
    JSON.stringify(effectiveContexts(['prod', 'dev'], exact)) === JSON.stringify(['prod']),
    'contexts intersect too',
    JSON.stringify(effectiveContexts(['prod', 'dev'], exact)),
  )
  check(effectiveContexts([], exact).includes('prod'), 'without a global context list the account list applies')
  check(effectiveContexts(['prod'], loose).includes('prod'), 'without a scope the global list applies')

  check(describeScope(undefined).includes('未配置'), 'describeScope explains an unconfigured scope', describeScope(undefined))
  check(describeScope(unbound).includes('未写账号'), 'describeScope explains an unbound scope', describeScope(unbound))
  check(describeScope(unknown).includes('不在账号表'), 'describeScope explains an unknown account', describeScope(unknown))
  check(describeScope(exact).includes('acme-prod'), 'describeScope lists the namespaces', describeScope(exact))
}

// ---------------------------------------------------------------- cluster 工具
{
  const accounts = parseAccounts({ acme: { namespaces: ['acme-prod'], contexts: ['prod'] } })
  const acme = scopeFor(accounts, 'acme')
  const scoped = createCluster({ kubeconfig, namespaces: ['*'], contexts: ['prod', 'dev'] })

  // 本账号的命名空间：允许继续（kubectl 会失败，但不是被作用域拦下的）。
  const allowed = await scoped.k8s({ verb: 'get', resource: 'pods', namespace: 'acme-prod' }, acme)
  check(allowed.ok === false && allowed.namespace === 'acme-prod', 'the account namespace passes the scope check', JSON.stringify({ ok: allowed.ok }))

  const foreign = await caught(() => scoped.k8s({ verb: 'get', resource: 'pods', namespace: 'globex-prod' }, acme))
  check(foreign.includes('不在白名单'), 'another customer namespace is refused', foreign)
  check(foreign.includes('本工单账号'), 'the refusal names the bound account', foreign)

  const noNamespace = await caught(() => scoped.k8s({ verb: 'get', resource: 'pods' }, acme))
  check(noNamespace.includes('必须显式写 namespace'), 'omitting the namespace under a scope is refused (no -A sweep)', noNamespace)

  const foreignContext = await caught(() => scoped.k8s({ verb: 'get', resource: 'pods', namespace: 'acme-prod', context: 'dev' }, acme))
  check(foreignContext.includes('不在白名单'), 'a context outside the account scope is refused', foreignContext)

  const foreignLogs = await caught(() => scoped.logs({ pod: 'x', namespace: 'globex-prod' }, acme))
  check(foreignLogs.includes('不在白名单'), 'logs are scoped the same way', foreignLogs)

  const env = await scoped.env(acme)
  check(env.account === 'acme' && env.scope.includes('acme-prod'), 'ops_env reports the bound account', JSON.stringify({ account: env.account, scope: env.scope }))
  check(env.namespaces.join(',') === 'acme-prod', 'ops_env reports the narrowed namespaces', JSON.stringify(env.namespaces))
  check(env.contexts.join(',') === 'prod', 'ops_env reports the narrowed contexts', JSON.stringify(env.contexts))
  check(env.hints.some(hint => hint.includes('必须显式写 namespace')), 'ops_env tells the model to name a namespace', JSON.stringify(env.hints))

  // 未绑定 / 未知账号：连命名空间都不用试，直接拒绝。
  const unboundScope = scopeFor(accounts, undefined)
  const unboundCluster = createCluster({ kubeconfig, namespaces: ['*'] })
  const unboundError = await caught(() => unboundCluster.k8s({ verb: 'get', resource: 'pods', namespace: 'acme-prod' }, unboundScope))
  check(unboundError.includes('没有账号信息'), 'an unbound incident cannot read any namespace', unboundError)

  const unknownScope = scopeFor(accounts, 'initech')
  const unknownCluster = createCluster({ kubeconfig, namespaces: ['*'] })
  const unknownError = await caught(() => unknownCluster.k8s({ verb: 'get', resource: 'pods', namespace: 'acme-prod' }, unknownScope))
  check(unknownError.includes('不在账号映射表'), 'an unknown account cannot read any namespace', unknownError)

  const unboundEnv = await unboundCluster.env(unboundScope)
  check(unboundEnv.ok === false || unboundEnv.hints.some(hint => hint.includes('会被拒绝')), 'ops_env warns that evidence gathering will be refused', JSON.stringify(unboundEnv.hints))

  // 没配账号表：行为与重构前完全一致（省略命名空间仍可，通配仍通配）。
  const plain = createCluster({ kubeconfig, namespaces: ['*'] })
  check((await plain.scopeFor('s1')) === undefined, 'without a dispatcher no scope is attached')
  const plainNoNamespace = await plain.k8s({ verb: 'get', resource: 'pods' })
  check(plainNoNamespace.ok === false && plainNoNamespace.namespace === '', 'without a scope, omitting the namespace still works', JSON.stringify({ namespace: plainNoNamespace.namespace }))
  const plainForeign = await plain.k8s({ verb: 'get', resource: 'pods', namespace: 'anything' })
  check(plainForeign.namespace === 'anything', 'without a scope the global * still allows any namespace', plainForeign.namespace)
}

// ---------------------------------------------------------------- 派单绑定
{
  function fakeCtx() {
    const created = []
    const live = new Map()
    const provided = new Map()
    return {
      created,
      live,
      provided,
      provide: (service, value) => { provided.set(service, value); return () => provided.delete(service) },
      get: service => provided.get(service),
      effect: () => {},
      on: () => () => {},
      logger: { warn: () => {} },
      workspaceRegistry: {
        list: () => [],
        create: async (dir) => {
          const record = {
            path: dir,
            title: undefined,
            sessionIds: [],
            attachSession: async (id) => { record.sessionIds.push(id) },
            detachSession: async () => {},
            setTitle: async (title) => { record.title = title },
          }
          return record
        },
      },
      agentDefaultModel: { currentSelection: () => ({ provider: 'test', model: 'test' }) },
      agentPresets: { async mount() {} },
      sessionTitle: { rename: () => {} },
      agents: {
        async create(options) {
          created.push(options)
          const agent = { session: { id: options.sessionId }, followup: () => {}, inject: () => {} }
          live.set(options.sessionId, agent)
          return { agent }
        },
        get: id => live.get(id),
        async resume({ resumeSessionId }) {
          const agent = { session: { id: resumeSessionId }, followup: () => {}, inject: () => {} }
          live.set(resumeSessionId, agent)
          return { agent }
        },
      },
    }
  }

  const ctx = fakeCtx()
  const dispatcher = createDispatcher(ctx, {
    workspace: path.join(temp, 'ops'),
    ledger: path.join(temp, 'ledger.jsonl'),
    stateFile: path.join(temp, 'state.json'),
    accounts: { acme: { namespaces: ['acme-prod'] }, globex: { namespaces: ['globex'] } },
  })

  const dispatched = await dispatcher.dispatch({
    requesterSessionId: 'cs-1',
    task: { symptom: '客户说付款失败', account: 'acme' },
  })
  const scope = dispatcher.scopeFor(dispatched.opsSessionId)
  check(scope !== undefined && scope.account === 'acme', 'dispatch binds the account to the ops session', JSON.stringify(scope))
  check(JSON.stringify(scope?.namespaces) === JSON.stringify(['acme-prod']), 'the bound session gets the account namespaces', JSON.stringify(scope?.namespaces))

  // cluster 工具按会话 id 取作用域——这条链路才是真正生效的地方。
  const cluster = createCluster({ kubeconfig, namespaces: ['*'] }, {
    scopeOf: sessionId => ctx.get('opsDispatch')?.scopeFor?.(sessionId),
  })
  ctx.provide('opsDispatch', dispatcher)
  const viaExec = async (sessionId, args) => caught(() => cluster.k8s(args, cluster.scopeFor(sessionId)))
  check((await viaExec(dispatched.opsSessionId, { verb: 'get', resource: 'pods', namespace: 'acme-prod' })) === '', 'the dispatched session may read its own namespace')
  const viaForeign = await viaExec(dispatched.opsSessionId, { verb: 'get', resource: 'pods', namespace: 'globex' })
  check(viaForeign.includes('不在白名单'), 'the dispatched session cannot read another account namespace', viaForeign)

  // 一张没写账号的单：绑定结果是 unbound，取证被拒。
  const noAccount = await dispatcher.dispatch({ requesterSessionId: 'cs-2', task: { symptom: '不知道是谁' } })
  const noAccountScope = dispatcher.scopeFor(noAccount.opsSessionId)
  check(noAccountScope?.unbound === true, 'an incident without an account is marked unbound', JSON.stringify(noAccountScope))
  const noAccountError = await viaExec(noAccount.opsSessionId, { verb: 'get', resource: 'pods', namespace: 'acme-prod' })
  check(noAccountError.includes('没有账号信息'), 'an unbound incident cannot gather evidence', noAccountError)

  // 不认识的账号：同样拒绝，并在派单时留一条告警。
  const unknown = await dispatcher.dispatch({ requesterSessionId: 'cs-3', task: { symptom: '不认识的客户', account: 'initech' } })
  check(dispatcher.scopeFor(unknown.opsSessionId)?.unknown === true, 'an unknown account is bound as unknown', JSON.stringify(dispatcher.scopeFor(unknown.opsSessionId)))

  // 不配账号表时，派单不附加任何限制。
  const looseCtx = fakeCtx()
  const looseDispatcher = createDispatcher(looseCtx, {
    workspace: path.join(temp, 'ops2'),
    ledger: path.join(temp, 'ledger2.jsonl'),
    stateFile: path.join(temp, 'state2.json'),
  })
  const looseDispatched = await looseDispatcher.dispatch({ requesterSessionId: 'cs-9', task: { symptom: '没有账号表' } })
  const looseScope = looseDispatcher.scopeFor(looseDispatched.opsSessionId)
  check(looseScope?.configured === false, 'without an accounts table nothing is restricted', JSON.stringify(looseScope))

  dispatcher.dispose()
  looseDispatcher.dispose()
}

// ---------------------------------------------------------------- 工具执行链路
{
  // 这一层才是真正生效的地方：apply() 注册工具，工具从 exec.agent.session.id 取会话，
  // 会话 id 再去派单器换作用域。前面几段测的是各环节，这里测它们接在一起。
  const { apply: applyCluster } = await import('./cluster.js')

  const live = new Map()
  const provided = new Map()
  const tools = new Map()
  const ctx = {
    provide: (service, value) => { provided.set(service, value); return () => provided.delete(service) },
    get: service => provided.get(service),
    effect: () => {},
    on: () => () => {},
    logger: { warn: () => {} },
    tools: { register: tool => tools.set(tool.name, tool) },
    workspaceRegistry: {
      list: () => [],
      create: async (dir) => ({
        path: dir,
        sessionIds: [],
        attachSession: async () => {},
        detachSession: async () => {},
        setTitle: async () => {},
      }),
    },
    agentDefaultModel: { currentSelection: () => ({ provider: 'test', model: 'test' }) },
    agentPresets: { async mount() {} },
    sessionTitle: { rename: () => {} },
    agents: {
      async create(options) {
        const agent = { session: { id: options.sessionId }, followup: () => {}, inject: () => {} }
        live.set(options.sessionId, agent)
        return { agent }
      },
      get: id => live.get(id),
      async resume({ resumeSessionId }) {
        const agent = { session: { id: resumeSessionId }, followup: () => {}, inject: () => {} }
        live.set(resumeSessionId, agent)
        return { agent }
      },
    },
  }

  const dispatcher = createDispatcher(ctx, {
    workspace: path.join(temp, 'ops3'),
    ledger: path.join(temp, 'ledger3.jsonl'),
    stateFile: path.join(temp, 'state3.json'),
    accounts: { acme: { namespaces: ['acme-prod'] } },
  })
  ctx.provide('opsDispatch', dispatcher)
  applyCluster(ctx, { kubeconfig, namespaces: ['*'] })

  check(tools.has('ops_k8s') && tools.has('ops_logs') && tools.has('ops_env'), 'apply registers all three cluster tools', [...tools.keys()].join(','))
  check(tools.get('ops_env').output.schema.required.includes('account') && tools.get('ops_env').output.schema.required.includes('scope'), 'ops_env output schema declares the new scope fields')

  const ticket = await dispatcher.dispatch({ requesterSessionId: 'cs-t', task: { symptom: '巡检', account: 'acme' } })
  const exec = { agent: { session: { id: ticket.opsSessionId } } }

  const envValue = await tools.get('ops_env').execute({}, exec)
  check(envValue.account === 'acme' && envValue.scope.includes('acme-prod'), 'ops_env through exec resolves the ticket account', JSON.stringify({ account: envValue.account }))
  const envText = tools.get('ops_env').output.render({}, envValue)[0].text
  check(envText.includes('account scope: acme'), 'the rendered ops_env text shows the account scope', envText.split('\n').find(line => line.startsWith('account scope')))

  const inScope = await caught(() => tools.get('ops_k8s').execute({ verb: 'get', resource: 'pods', namespace: 'acme-prod' }, exec))
  check(inScope === '', 'ops_k8s through exec allows the ticket namespace')
  const outOfScope = await caught(() => tools.get('ops_k8s').execute({ verb: 'get', resource: 'pods', namespace: 'globex-prod' }, exec))
  check(outOfScope.includes('不在白名单'), 'ops_k8s through exec refuses another customer namespace', outOfScope)
  const swept = await caught(() => tools.get('ops_logs').execute({ pod: 'x', namespace: 'globex-prod' }, exec))
  check(swept.includes('不在白名单'), 'ops_logs through exec refuses too', swept)

  // 没有 exec（比如模型在会话外被调用）：退回不限制，不能把正常调试弄坏。
  const noExecEnv = await tools.get('ops_env').execute({}, undefined)
  check(noExecEnv.scope.includes('未配置账号映射'), 'without an exec context the tools stay unrestricted', noExecEnv.scope)

  dispatcher.dispose()
}

// ---------------------------------------------------------------- 指标作用域
// k8s 靠"必须显式写 namespace"堵住扫全集群，指标这边必须有同一堵墙：
// 一条 sum(rate(...)) 是跨客户聚合，{namespace="globex-prod"} 更是直接读别人的数据。
{
  const acme = scopeFor(parseAccounts({ acme: { namespaces: ['acme-prod', 'acme-staging'] } }), 'acme')
  const open = scopeFor(parseAccounts(undefined), 'acme')

  check(namespaceMatchers('sum(rate(http_requests_total[5m]))').length === 0, 'an aggregation has no namespace matcher')
  check(namespaceMatchers('{namespace="acme-prod"}').length === 1, 'an exact matcher is found')
  check(namespaceMatchers('rate(x{namespace=~"a|b"}[5m]))').length === 1, 'a regex matcher is found')
  check(namespaceMatchers('kube_namespace_labels{job="x"}').length === 0, 'a metric name containing "namespace" is not a matcher')
  check(namespaceMatchers('sum by (namespace) (x)').length === 0, 'a grouping label is not a matcher')

  check(literalAlternatives('acme-prod')?.length === 1, 'a plain literal enumerates to itself')
  check(literalAlternatives('^acme-prod|acme-staging$')?.length === 2, 'an anchored enumeration is accepted')
  check(literalAlternatives('acme-.*') === undefined, 'a wildcard prefix is refused', String(literalAlternatives('acme-.*')))
  check(literalAlternatives('a|') === undefined, 'an empty alternative is refused')
  check(literalAlternatives('') === undefined, 'an empty pattern is refused')

  check((await caught(() => checkMetricsScope('{namespace="globex-prod"}', open))) === '', 'without accounts nothing is restricted')
  check(checkMetricsScope('{namespace="acme-prod"}', acme).namespaces[0] === 'acme-prod', 'an allowed namespace passes')

  const noMatcher = await caught(() => checkMetricsScope('sum(rate(http_requests_total[5m]))', acme))
  check(noMatcher.includes('必须显式写 namespace'), 'an aggregation without a matcher is refused', noMatcher)
  const foreign = await caught(() => checkMetricsScope('{namespace="globex-prod"}', acme))
  check(foreign.includes('不属于本工单账号'), 'another customer namespace is refused', foreign)
  const wildcard = await caught(() => checkMetricsScope('{namespace=~"acme-.*"}', acme))
  check(wildcard.includes('通配'), 'a wildcard regex is refused', wildcard)
  const negation = await caught(() => checkMetricsScope('{namespace!="globex-prod"}', acme))
  check(negation.includes('排除式'), 'a negation matcher is refused', negation)
  const enumeration = await caught(() => checkMetricsScope('{namespace=~"acme-prod|acme-staging"}', acme))
  check(enumeration === '', 'an enumeration of allowed namespaces passes', enumeration)
  const partial = await caught(() => checkMetricsScope('{namespace=~"acme-prod|globex-prod"}', acme))
  check(partial.includes('globex-prod'), 'an enumeration mixed with another customer is refused', partial)

  const unbound = scopeFor(parseAccounts({ acme: { namespaces: ['acme-prod'] } }), '')
  const unboundError = await caught(() => checkMetricsScope('{namespace="acme-prod"}', unbound))
  check(unboundError.includes('没有账号信息'), 'an unbound ticket cannot query metrics', unboundError)
  const unknown = scopeFor(parseAccounts({ acme: { namespaces: ['acme-prod'] } }), 'globex')
  const unknownError = await caught(() => checkMetricsScope('{namespace="acme-prod"}', unknown))
  check(unknownError.includes('不在账号映射表里'), 'an unknown account cannot query metrics', unknownError)
  const bare = scopeFor(parseAccounts({ acme: {} }), 'acme')
  const bareError = await caught(() => checkMetricsScope('{namespace="acme-prod"}', bare))
  check(bareError.includes('没有配置命名空间白名单'), 'an account without namespaces cannot query metrics', bareError)

  // 真跑一遍工具：命中允许范围时请求真的发出，越界时一个字节都不该出网。
  const seen = []
  const fetchImpl = async url => {
    seen.push(String(url))
    return { ok: true, status: 200, text: async () => JSON.stringify({ data: { result: [] } }) }
  }
  const metrics = createMetrics(
    { prometheusUrl: 'http://metrics.test', fetch: fetchImpl },
    { scopeOf: sessionId => (sessionId === 'ops-1' ? acme : undefined) },
  )

  const allowedResult = await metrics.query({ query: '{namespace="acme-prod"} up' }, metrics.scopeFor('ops-1'))
  check(allowedResult.ok === true && seen.length === 1, 'an allowed query reaches the backend', String(seen.length))

  const before = seen.length
  const denied = await caught(() => metrics.query({ query: '{namespace="globex-prod"} up' }, metrics.scopeFor('ops-1')))
  check(denied.includes('不属于本工单账号'), 'a foreign query is refused before the request', denied)
  check(seen.length === before, 'nothing is sent for a refused query', `${seen.length} requests`)

  // 走 tool 的完整链路：exec 里的 sessionId 决定作用域，没有 exec 就不限制。
  const tools = new Map()
  const ctx = {
    tools: { register: tool => tools.set(tool.name, tool) },
    get: () => ({ scopeFor: sessionId => (sessionId === 'ops-1' ? acme : undefined) }),
  }
  applyMetrics(ctx, { prometheusUrl: 'http://metrics.test', fetch: fetchImpl })
  check(tools.has('ops_metrics'), 'apply registers ops_metrics')

  const exec = { agent: { session: { id: 'ops-1' } } }
  const viaExec = await caught(() => tools.get('ops_metrics').execute({ query: '{namespace="globex-prod"} up' }, exec))
  check(viaExec.includes('不属于本工单账号'), 'ops_metrics through exec refuses another customer namespace', viaExec)
  const viaExecAllowed = await tools.get('ops_metrics').execute({ query: '{namespace="acme-prod"} up' }, exec)
  check(viaExecAllowed.ok === true, 'ops_metrics through exec allows the ticket namespace')
  const noExec = await tools.get('ops_metrics').execute({ query: 'sum(up)' }, undefined)
  check(noExec.ok === true, 'without an exec context the tool stays unrestricted')
}

await fs.rm(temp, { recursive: true, force: true })
console.log('')
console.log(failed === 0 ? 'all account scope checks passed' : `${failed} check(s) failed`)
process.exit(failed === 0 ? 0 : 1)
