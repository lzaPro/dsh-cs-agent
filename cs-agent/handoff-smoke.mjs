// ops_handoff 自测：没有运维插件时明确报错，装了就把任务交给调度器。
// Run with: node cs-agent/handoff-smoke.mjs
import { apply } from './handoff.js'

let failed = 0
const check = (ok, label, detail = '') => {
  if (!ok) failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail === '' ? '' : `: ${detail}`}`)
}

/** 挂载工具并返回 execute。 */
function mount(dispatch) {
  const tools = new Map()
  apply({
    tools: { register: definition => { tools.set(definition.name, definition); return () => {} } },
    get: service => (service === 'opsDispatch' ? dispatch : undefined),
  })
  return tools.get('ops_handoff').execute
}

// 没装运维插件
{
  const execute = mount(undefined)
  let error
  try {
    await execute({ symptom: '打不开' }, { agent: { id: 's1' } })
  } catch (caught) {
    error = caught
  }
  check(error !== undefined && /未安装/.test(error.message), 'missing ops plugin reports a clear error')
}

// 装了：任务被交给调度器
{
  const calls = []
  const execute = mount({ dispatch: async request => { calls.push(request); return { incidentId: 'INC-1', opsSessionId: 'ops-1', state: 'dispatched' } } })
  const result = await execute({ symptom: '打不开' }, { agent: { id: 's1' } })
  check(result.incidentId === 'INC-1', 'dispatch result is returned')
  check(calls[0].requesterSessionId === 's1' && calls[0].task.symptom === '打不开', 'requester and task are forwarded')
}

// 不是 agent 调用的
{
  const execute = mount({ dispatch: async () => ({}) })
  let error
  try {
    await execute({ symptom: 'x' }, {})
  } catch (caught) {
    error = caught
  }
  check(error !== undefined && /agent session/.test(error.message), 'requires an agent caller')
}

process.exit(failed === 0 ? 0 : 1)
