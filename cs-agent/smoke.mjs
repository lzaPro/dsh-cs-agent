// Development smoke test: exercises the tools without a Harness process.
// Run with: node cs-agent/smoke.mjs
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply } from './index.js'

/** Mount one role and hand back its tool map. */
function mount(role, kbDir) {
  const tools = new Map()
  apply({ tools: { register: (d) => { tools.set(d.name, d); return () => {} } } }, { kbDir, role })
  return tools
}

const kb = path.resolve('../kb')
const cs = mount('customer-service', kb)
const ops = mount('ops', kb)
let failed = 0
const check = (ok, label, detail = '') => {
  if (!ok) failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail === '' ? '' : `: ${detail}`}`)
}

const cases = [
  ['billing 9.9', '扣了9.9元', 'subscription-fee-9-9-19-9'],
  ['pvc -122', '-122 报错', 'pvc-disk-full'],
  ['no response', '对话没反应', 'dialog-no-response'],
  ['invite reward', '邀请好友没有奖励', 'signup-referral-rewards'],
  ['token', 'gateway token 401', 'gateway-token-changed'],
  ['unrelated', '打印机连不上', undefined],
]
for (const [label, query, expected] of cases) {
  const result = await cs.get('kb_search').execute({ query })
  check(result.hits[0]?.id === expected, `search/${label}`, `top=${result.hits[0]?.id ?? 'none'} score=${result.hits[0]?.score ?? 0}`)
}

const filtered = await cs.get('kb_search').execute({ query: '余额', service: 'grafana' })
check(filtered.total === 0, 'service filter')

const hidden = await cs.get('kb_get').execute({ id: 'pvc-disk-full' })
check(hidden.internalHidden === true && hidden.entry.resolution === undefined,
  'customer role hides internal steps', `hidden=${hidden.internalHidden} resolution=${hidden.entry.resolution === undefined ? 'absent' : 'LEAKED'}`)

const visible = await ops.get('kb_get').execute({ id: 'pvc-disk-full' })
check(visible.internalHidden === false && typeof visible.entry.resolution === 'string' && visible.entry.resolution !== '',
  'ops role sees internal steps')

const customerEntry = await cs.get('kb_get').execute({ id: 'refund-not-supported' })
check(customerEntry.internalHidden === false && customerEntry.entry.customerReply !== '',
  'customer entry returns reply')

const missing = await cs.get('kb_get').execute({ id: 'nope' })
check(missing.found === false, 'kb_get missing')

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-'))
const tempCs = mount('customer-service', temp)
const proposed = await tempCs.get('kb_propose').execute({
  title: 'test entry',
  symptom: 'something broke',
  resolution: 'internal fix only',
  customerReply: '正在处理',
  audience: 'ops',
  errorSignatures: ['BOOM'],
})
const written = JSON.parse(await fs.readFile(proposed.path, 'utf8'))
check(proposed.saved && written.status === 'candidate' && written.audience === 'ops', 'kb_propose writes candidate', proposed.id)
const invisible = await tempCs.get('kb_search').execute({ query: 'BOOM' })
check(invisible.total === 0, 'candidate excluded from search', `total=${invisible.total}`)
await fs.rm(temp, { recursive: true, force: true })

process.exit(failed === 0 ? 0 : 1)
