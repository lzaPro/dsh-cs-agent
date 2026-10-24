// Development smoke test: exercises the tools without a Harness process.
// Run with: node cs-agent/smoke.mjs
import { existsSync, promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply } from './index.js'

/** Mount one role and hand back its tool map. */
function mount(role, kbDir) {
  const tools = new Map()
  apply({ tools: { register: (d) => { tools.set(d.name, d); return () => {} } } }, { kbDir, role })
  return tools
}

/** 仓库里没有 ../kb 时，用自带的样例条目跑同一组断言。 */
async function fixtureKb() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-fixture-'))
  const entries = [
    { id: 'subscription-fee-9-9-19-9', audience: 'customer', symptom: '客户发现余额少了 9.9 元，找不到消费记录，扣了9.9元' },
    { id: 'pvc-disk-full', audience: 'ops', symptom: '-122 报错 磁盘写满 disk quota exceed', errorSignatures: ['-122', 'disk quota exceed'] },
    { id: 'dialog-no-response', audience: 'customer', symptom: '对话没反应，发消息后一直没有回复' },
    { id: 'signup-referral-rewards', audience: 'customer', symptom: '邀请好友没有奖励，奖励没到账' },
    { id: 'gateway-token-changed', audience: 'customer', symptom: 'gateway token 401，鉴权失败' },
    { id: 'refund-not-supported', audience: 'customer', symptom: '客户要求退款' },
  ]
  for (const entry of entries) {
    const full = {
      status: 'verified',
      title: entry.id,
      services: ['demo'],
      environments: ['production'],
      customerReply: '我们正在核对，稍后回复你。',
      rootCause: '内部原因',
      resolution: '内部处置步骤',
      verification: '复查通过',
      tags: ['demo'],
      updated: '2026-01-01',
      ...entry,
    }
    await fs.writeFile(path.join(dir, `${full.id}.json`), JSON.stringify(full, null, 2))
  }
  return dir
}

const source = path.resolve('../kb')
const kb = existsSync(source) ? source : await fixtureKb()
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
