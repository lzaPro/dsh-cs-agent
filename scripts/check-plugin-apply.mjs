#!/usr/bin/env node
/**
 * 装配层检查：对每个本地插件真正调用一次 `apply()`。
 *
 * 为什么单独一个脚本：`smoke.mjs` 测的是导出的纯函数，而"插件在 DSH 里不生效"
 * 这类事故几乎都发生在 `apply()` 里——服务没 provide、工具没 register、路由前缀写错、
 * effect 的清理函数没返回。这些错误在静态检查里看不见，在浏览器里只表现为"这块 UI 不出现"。
 *
 *   node scripts/check-plugin-apply.mjs
 *
 * 不联网、不连集群：kubectl 只跑 `version --client`，指标工具在未配置时直接返回错误。
 */
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(fileURLToPath(import.meta.url), '..', '..')
const load = specifier => import(join(root, specifier))

let failed = 0
const check = (ok, label, detail = '') => {
  if (!ok) failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail === '' ? '' : `: ${detail}`}`)
}

/** 假 Host：记录 provide/register/effect/on，够跑通 apply 与一次 execute。 */
function fakeCtx() {
  const provided = new Map()
  const registered = []
  const routes = []
  const effects = []
  const listeners = []
  return {
    provided, registered, routes, effects, listeners,
    provide(service, value) {
      provided.set(service, value)
      return () => provided.delete(service)
    },
    get(service) {
      return provided.get(service)
    },
    effect(setup, label) {
      const dispose = setup()
      effects.push({ label, hasDispose: typeof dispose === 'function' })
      return () => {}
    },
    on(event, handler) {
      listeners.push({ event, handler })
      return () => {}
    },
    logger: { warn() {}, info() {}, error() {} },
    tools: {
      register(definition) {
        registered.push(definition)
      },
    },
    webServer: {
      register(route) {
        routes.push(route)
        return () => {}
      },
    },
  }
}

/**
 * 校验 schema 是否落在 harness 支持的方言子集内。
 *
 * 为什么需要：宿主只接受单值 `type`（`type: ['string','null']` 会被拒），
 * 而错误只在预设真正挂载时才抛——面板 200、smoke 全绿，派单却 500。
 * 这个函数把那次故障变成静态错误。
 */
const SCHEMA_TYPES = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']
const ANNOTATIONS = ['description', 'title']
const ONE_OF_SIBLINGS = ['properties', 'required', 'additionalProperties', 'items', 'enum', 'const']

function schemaViolations(node, path, out = []) {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) {
    out.push(`${path} must be a schema object`)
    return out
  }
  const allowed = new Set(['type', ...ANNOTATIONS, 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const', 'oneOf'])
  for (const key of Object.keys(node)) {
    if (!allowed.has(key)) out.push(`${path}.${key} is not a supported keyword`)
  }
  const hasType = Object.hasOwn(node, 'type')
  const hasOneOf = Object.hasOwn(node, 'oneOf')
  if (hasType && hasOneOf) out.push(`${path} cannot declare both type and oneOf`)
  if (hasOneOf) {
    for (const key of ONE_OF_SIBLINGS) {
      if (Object.hasOwn(node, key)) out.push(`${path}.${key} is not supported beside oneOf`)
    }
    if (!Array.isArray(node.oneOf) || node.oneOf.length < 2) out.push(`${path}.oneOf must hold at least two schemas`)
    else node.oneOf.forEach((branch, index) => schemaViolations(branch, `${path}.oneOf[${index}]`, out))
    return out
  }
  if (!hasType) return out
  if (Array.isArray(node.type)) {
    out.push(`${path}.type must be a single type string (type arrays are not supported)`)
    return out
  }
  if (!SCHEMA_TYPES.includes(node.type)) {
    out.push(`${path}.type must be one of ${SCHEMA_TYPES.join('/')}`)
    return out
  }
  if (node.type === 'object') {
    if (Object.hasOwn(node, 'properties')) {
      for (const [key, value] of Object.entries(node.properties)) schemaViolations(value, `${path}.properties.${key}`, out)
    }
    if (Object.hasOwn(node, 'required')) {
      if (!Array.isArray(node.required)) out.push(`${path}.required must hold strings`)
      else {
        const declared = node.properties ?? {}
        for (const key of node.required) {
          if (!Object.hasOwn(declared, key)) out.push(`${path}.required names "${key}" which is not in properties`)
        }
      }
    }
    if (Object.hasOwn(node, 'additionalProperties') && typeof node.additionalProperties !== 'boolean') {
      out.push(`${path}.additionalProperties must be a boolean`)
    }
  } else if (node.type === 'array' && Object.hasOwn(node, 'items')) {
    schemaViolations(node.items, `${path}.items`, out)
  }
  return out
}

/** 检查一个工具定义的基本契约。 */
function checkTool(tool, label) {
  check(typeof tool?.name === 'string' && tool.name !== '', `${label}: has a name`)
  check(typeof tool?.description === 'string' && tool.description.length > 20, `${label}: has a usable description`)
  check(tool?.parameters?.type === 'object', `${label}: parameters is an object schema`)
  const schemaProblems = [
    ...schemaViolations(tool?.parameters, `${label}.parameters`),
    ...schemaViolations(tool?.output?.schema, `${label}.output`),
  ]
  check(schemaProblems.length === 0, `${label}: schema stays inside the host dialect`, schemaProblems.join('; '))
  const required = tool?.output?.schema?.required
  check(Array.isArray(required), `${label}: output schema declares required fields`)
  const props = tool?.output?.schema?.properties ?? {}
  const missing = (required ?? []).filter(key => props[key] === undefined)
  check(missing.length === 0, `${label}: every required output field is described`, missing.join(', '))
  check(typeof tool?.output?.render === 'function', `${label}: has a renderer`)
  return tool
}

/** 用一次真实 execute 的返回值验证 renderer 能产出文本块。 */
function checkRender(tool, args, value) {
  try {
    const blocks = tool.output.render(args, value)
    const ok = Array.isArray(blocks) && blocks.length > 0 && blocks.every(block => block?.type === 'text' && typeof block.text === 'string')
    check(ok, `${tool.name}: renderer returns text blocks`)
  } catch (error) {
    check(false, `${tool.name}: renderer runs`, error.message)
  }
}

// --- 运维调度器 -------------------------------------------------------------
const dispatcherCtx = fakeCtx()
const dispatcher = await load('ops-agent/dispatcher.js')
dispatcher.apply(dispatcherCtx, {})
check(typeof dispatcherCtx.get('opsDispatch')?.dispatch === 'function', 'dispatcher: provides opsDispatch')
check(dispatcherCtx.listeners.some(item => item.event === 'session/event'), 'dispatcher: subscribes to session/event')
check(dispatcherCtx.effects.length >= 2, 'dispatcher: registers lifecycle effects', String(dispatcherCtx.effects.length))
check(dispatcherCtx.effects.every(item => item.hasDispose), 'dispatcher: every effect returns a disposer')

// --- 只读集群工具 -----------------------------------------------------------
const clusterCtx = fakeCtx()
const cluster = await load('ops-agent/cluster.js')
cluster.apply(clusterCtx, { namespaces: ['*'] })
const clusterNames = clusterCtx.registered.map(tool => tool.name).sort()
check(clusterNames.join(',') === 'ops_env,ops_k8s,ops_logs', 'cluster: registers ops_env/ops_k8s/ops_logs', clusterNames.join(','))
for (const tool of clusterCtx.registered.map(tool => checkTool(tool, `cluster/${tool.name}`))) {
  if (tool.name === 'ops_env') {
    const value = await tool.execute({})
    check(typeof value?.ok === 'boolean', 'ops_env: returns a verdict')
    check(Array.isArray(value?.checks) && value.checks.length >= 3, 'ops_env: reports every check', String(value?.checks?.length))
    checkRender(tool, {}, value)
  }
  if (tool.name === 'ops_k8s') {
    const value = await tool.execute({ verb: 'version', resource: 'version' })
    check(typeof value?.output === 'string', 'ops_k8s: runs kubectl version --client')
    checkRender(tool, { verb: 'version', resource: 'version' }, value)
    let refused = false
    try {
      await tool.execute({ verb: 'delete', resource: 'pods' })
    } catch {
      refused = true
    }
    check(refused, 'ops_k8s: refuses a non-read verb at execute time')
  }
  if (tool.name === 'ops_logs') {
    let refused = false
    try {
      await tool.execute({ pod: 'x' })
    } catch {
      refused = true
    }
    check(refused, 'ops_logs: requires a namespace')
  }
}

// --- 指标工具 ---------------------------------------------------------------
const metricsCtx = fakeCtx()
const metrics = await load('ops-agent/metrics.js')
metrics.apply(metricsCtx, {})
check(metricsCtx.registered.length === 1 && metricsCtx.registered[0].name === 'ops_metrics', 'metrics: registers ops_metrics')
const metricsTool = checkTool(metricsCtx.registered[0], 'metrics/ops_metrics')
const unconfigured = await metricsTool.execute({ query: 'up' })
check(unconfigured?.ok === false && unconfigured?.configured === false, 'ops_metrics: reports a missing data source instead of guessing')
checkRender(metricsTool, { query: 'up' }, unconfigured)

// --- 工单工具 ---------------------------------------------------------------
const taskCtx = fakeCtx()
const taskTools = await load('ops-agent/task-tools.js')
taskTools.apply(taskCtx)
check(taskCtx.registered.length === 1 && taskCtx.registered[0].name === 'ops_task', 'task tools: registers ops_task')
const taskTool = checkTool(taskCtx.registered[0], 'task/ops_task')
let needsDispatcher = false
try {
  await taskTool.execute({ action: 'set_status', status: 'diagnosing' }, { agent: { session: { id: 'ops-1' } } })
} catch (error) {
  needsDispatcher = /调度器未加载/.test(error.message)
}
check(needsDispatcher, 'ops_task: fails loudly without the dispatcher service')

// --- 控制面板 ---------------------------------------------------------------
const panelCtx = fakeCtx()
const panel = await load('ops-agent/panel.js')
panel.apply(panelCtx, { route: '/ops' })
const route = panelCtx.routes[0]
check(route?.kind === 'prefix' && route?.path === '/ops', 'panel: registers a prefix route', `${route?.kind} ${route?.path}`)
check(panelCtx.effects.length === 1 && panelCtx.effects[0].hasDispose, 'panel: disposes its route')

// --- 浏览器侧 UI 的宿主占位 ---------------------------------------------------
// patch 里 `ops-panel-ui` 那行的 name 是裸包名，被加载的就是这个文件；它必须是可挂载的
// Cordis 插件（否则整行激活失败），同时不能做任何事。
const uiCtx = fakeCtx()
const uiHost = await load('ops-agent/index.js')
uiHost.apply(uiCtx, {})
check(typeof uiHost.apply === 'function' && uiCtx.registered.length === 0 && uiCtx.routes.length === 0,
  'ops-agent: bare-package host half is an inert plugin')

// --- 共享知识库 -------------------------------------------------------------
const kbServiceCtx = fakeCtx()
const kbIndex = await load('kb-core/index.js')
kbIndex.apply(kbServiceCtx, {})
const store = kbServiceCtx.get('kbStore')
check(typeof store?.search === 'function', 'kb-store: provides the store')
check(['search', 'get', 'propose', 'candidates', 'verify', 'reject', 'stats'].every(name => typeof store[name] === 'function'), 'kb-store: exposes the full method set')

const kbToolsCtx = fakeCtx()
const kbTools = await load('kb-core/tools.js')
kbTools.apply(kbToolsCtx, { role: 'customer-service' })
const kbNames = kbToolsCtx.registered.map(tool => tool.name).sort()
check(kbNames.join(',') === 'kb_get,kb_propose,kb_search', 'kb tools: registers the three tools', kbNames.join(','))
for (const tool of kbToolsCtx.registered) checkTool(tool, `kb/${tool.name}`)

let rejectedRole = false
try {
  kbTools.apply(fakeCtx(), { role: 'intern' })
} catch (error) {
  rejectedRole = /role/.test(error.message)
}
check(rejectedRole, 'kb tools: refuses an unknown role')

let missingStore = false
try {
  await kbToolsCtx.registered.find(tool => tool.name === 'kb_search').execute({ query: 'x' }, {})
} catch (error) {
  missingStore = /知识库服务未加载/.test(error.message)
}
check(missingStore, 'kb tools: fails loudly without the kbStore service')

console.log(failed === 0 ? '\nplugin apply: all checks passed' : `\nplugin apply: ${failed} check(s) failed`)
process.exit(failed === 0 ? 0 : 1)
