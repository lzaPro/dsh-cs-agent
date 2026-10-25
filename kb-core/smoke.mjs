// 开发期自检：不启动 Harness 进程，直接驱动 kbStore 与三个工具。
//   node kb-core/smoke.mjs
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createKbStore } from './index.js'
import { apply as applyTools } from './tools.js'

let failed = 0
const check = (ok, label, detail = '') => {
  if (!ok) failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail === '' ? '' : `: ${detail}`}`)
}

/** 造一个临时的知识库目录：共享条目 + 内部 runbook + 候选。 */
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-core-'))
  const kbDir = path.join(root, 'kb')
  const opsKbDir = path.join(root, 'ops-kb')
  await fs.mkdir(path.join(kbDir, '_candidates'), { recursive: true })
  await fs.mkdir(opsKbDir, { recursive: true })
  const shared = [
    { id: 'subscription-fee-9-9-19-9', audience: 'customer', symptom: '客户发现余额少了 9.9 元，找不到消费记录，扣了9.9元' },
    { id: 'pvc-disk-full', audience: 'ops', symptom: '-122 报错 磁盘写满 disk quota exceed', errorSignatures: ['-122', 'disk quota exceed'] },
    { id: 'dialog-no-response', audience: 'customer', symptom: '对话没反应，发消息后一直没有回复' },
    { id: 'gateway-token-changed', audience: 'customer', symptom: 'gateway token 401，鉴权失败' },
    { id: 'refund-not-supported', audience: 'customer', symptom: '客户要求退款' },
  ]
  for (const entry of shared) {
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
    await fs.writeFile(path.join(kbDir, `${full.id}.json`), JSON.stringify(full, null, 2))
  }
  const runbook = {
    id: 'runbook-pod-oom',
    title: 'Pod OOMKilled 处置',
    status: 'verified',
    audience: 'internal',
    symptom: '容器被 OOMKilled 反复重启',
    errorSignatures: ['OOMKilled', 'exit code 137'],
    services: ['api'],
    environments: ['production'],
    rootCause: '内存 limit 低于实际峰值',
    resolution: '1. kubectl top pod 确认峰值\n2. 提案调大 limit\n3. 观察 10 分钟',
    verification: 'kubectl get pod 重启次数不再增长',
    tags: ['k8s'],
    updated: '2026-01-01',
  }
  await fs.writeFile(path.join(opsKbDir, 'runbook-pod-oom.json'), JSON.stringify(runbook, null, 2))
  return { root, kbDir, opsKbDir }
}

/** 挂载一个角色，返回它的工具表。 */
function mount(role, store) {
  const tools = new Map()
  const ctx = {
    tools: { register: definition => { tools.set(definition.name, definition); return () => {} } },
    get: name => (name === 'kbStore' ? store : undefined),
  }
  applyTools(ctx, { role })
  return tools
}

const { root, kbDir, opsKbDir } = await fixture()
const store = createKbStore({ kbDir, opsKbDir, dataDir: path.join(root, 'data') })
const cs = mount('customer-service', store)
const ops = mount('ops', store)

const cases = [
  ['billing 9.9', '扣了9.9元', 'subscription-fee-9-9-19-9'],
  ['pvc -122', '-122 报错', 'pvc-disk-full'],
  ['no response', '对话没反应', 'dialog-no-response'],
  ['token', 'gateway token 401', 'gateway-token-changed'],
  ['unrelated', '打印机连不上', undefined],
]
for (const [label, query, expected] of cases) {
  const result = await cs.get('kb_search').execute({ query })
  check(result.hits[0]?.id === expected, `search/${label}`,
    `top=${result.hits[0]?.id ?? 'none'} score=${result.hits[0]?.score ?? 0}`)
}

const filtered = await cs.get('kb_search').execute({ query: '余额', service: 'grafana' })
check(filtered.total === 0, 'service filter')

const hidden = await cs.get('kb_get').execute({ id: 'pvc-disk-full' })
check(hidden.internalHidden === true && hidden.entry.resolution === undefined,
  'customer role hides internal steps',
  `hidden=${hidden.internalHidden} resolution=${hidden.entry.resolution === undefined ? 'absent' : 'LEAKED'}`)

const visible = await ops.get('kb_get').execute({ id: 'pvc-disk-full' })
check(visible.internalHidden === false && typeof visible.entry.resolution === 'string' && visible.entry.resolution !== '',
  'ops role sees internal steps')

const customerEntry = await cs.get('kb_get').execute({ id: 'refund-not-supported' })
check(customerEntry.internalHidden === false && customerEntry.entry.customerReply !== '', 'customer entry returns reply')

const missing = await cs.get('kb_get').execute({ id: 'nope' })
check(missing.found === false, 'kb_get missing')

// 内部 runbook 只有运维搜得到。
const csRunbook = await cs.get('kb_search').execute({ query: 'OOMKilled 137' })
check(csRunbook.total === 0, 'customer-service cannot search internal runbooks', `total=${csRunbook.total}`)
const opsRunbook = await ops.get('kb_search').execute({ query: 'OOMKilled 137' })
check(opsRunbook.hits[0]?.id === 'runbook-pod-oom' && opsRunbook.hits[0]?.source === 'internal',
  'ops searches internal runbooks', `top=${opsRunbook.hits[0]?.id} source=${opsRunbook.hits[0]?.source}`)
const opsRunbookGet = await ops.get('kb_get').execute({ id: 'runbook-pod-oom' })
check(opsRunbookGet.found === true && opsRunbookGet.entry.resolution.includes('kubectl'), 'ops reads internal runbook body')

// 客服不能提内部条目。
let rejectedInternal = false
try {
  await cs.get('kb_propose').execute({
    title: 'x', symptom: 'y', resolution: 'z', audience: 'internal',
  })
} catch (error) {
  rejectedInternal = /internal/.test(error.message)
}
check(rejectedInternal, 'customer-service cannot propose internal entries')

// 候选 → 审核 → 进入检索。
const proposed = await ops.get('kb_propose').execute({
  title: 'payment 5xx upstream timeout',
  symptom: '支付接口 502，上游超时',
  resolution: '1. 回滚 1.2.3\n2. 观察 5 分钟',
  errorSignatures: ['PAYMENT_502'],
  audience: 'ops',
  incidentId: 'INC-TEST',
})
check(proposed.saved === true, 'kb_propose writes candidate', proposed.id)
const before = await ops.get('kb_search').execute({ query: 'PAYMENT_502' })
check(before.total === 0, 'candidate excluded from search', `total=${before.total}`)

const candidates = await store.candidates()
check(candidates.length === 1 && candidates[0].id === proposed.id, 'candidate listed for review', `count=${candidates.length}`)

const verified = await store.verify(proposed.id, { reviewer: 'smoke' })
check(verified.ok === true && verified.path?.endsWith(`${proposed.id}.json`), 'candidate promoted', verified.path ?? verified.reason ?? '')
const after = await ops.get('kb_search').execute({ query: 'PAYMENT_502' })
check(after.hits[0]?.id === proposed.id && after.hits[0]?.status === 'verified', 'promoted entry is searchable',
  `top=${after.hits[0]?.id} status=${after.hits[0]?.status}`)

// 内部条目也能进 ops-kb。
const internalCandidate = await ops.get('kb_propose').execute({
  title: 'runbook: grafana 面板空白',
  symptom: '运维看板空白',
  resolution: '1. 检查 datasource\n2. 重新保存面板',
  audience: 'internal',
})
const promotedInternal = await store.verify(internalCandidate.id, {})
check(promotedInternal.ok === true && promotedInternal.path?.includes('ops-kb'), 'internal candidate lands in ops-kb',
  promotedInternal.path ?? '')

// 拒绝 → 进 _rejected，不再出现在候选里。
const doomed = await ops.get('kb_propose').execute({ title: 'bad', symptom: 'bad', resolution: 'bad' })
const rejected = await store.reject(doomed.id, { reason: '重复条目' })
const remaining = await store.candidates()
check(rejected.ok === true && remaining.every(item => item.id !== doomed.id), 'rejected candidate leaves the queue')

const stats = await store.stats()
check(stats.shared >= 5 && stats.internal >= 2, 'stats counts both directories', JSON.stringify(stats))

await fs.rm(root, { recursive: true, force: true })
process.exit(failed === 0 ? 0 : 1)
