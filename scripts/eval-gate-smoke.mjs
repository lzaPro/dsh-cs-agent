#!/usr/bin/env node
/**
 * 评测门禁自己的测试。
 *
 * 门禁挂了比没有门禁更危险：它会显示 PASS，然后你放心的合并。所以这里对
 * `scripts/eval-gate.mjs` 的两种模式分别造数据，断言它在"该挂"的时候真的挂、
 * 退出码是对的（0 通过 / 1 回退 / 2 数据不全）。
 *
 * 用真实知识库当输入（只读，或者复制一份改坏），因为门禁的全部意义就是盯着这份库。
 */

import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const workspace = path.resolve(here, '..')
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'eval-gate-smoke-'))

// 自带的迷你知识库：门禁自检不该依赖部署那份 kb/。
// 发布出去的插件仓库没有 kb/（部署数据，含真实客服话术），门禁自检又必须能在那里跑，
// 所以这里造两条最小可用条目，而不是去读 ../kb。
const kbDir = path.join(temp, 'kb')
await fs.mkdir(kbDir, { recursive: true })
const FIXTURES = {
  'bad-request-400': {
    id: 'bad-request-400',
    title: '400 Bad Request：配置或参数错误',
    status: 'verified',
    audience: 'ops',
    errorSignatures: ['400 Bad Request', 'invalid request', 'model not found'],
    services: ['sophclaw'],
    environments: ['production'],
    symptom: '客户发送消息返回 400。',
    customerReply: '这是请求参数不合法导致的，请检查模型名与账号配置。',
    rootCause: '模型名或参数不合法。',
    resolution: '核对模型名与参数后重试。',
    tags: ['400'],
    updated: '2026-01-01',
  },
  'pvc-disk-full': {
    id: 'pvc-disk-full',
    title: 'PVC 已满：-122 报错 / disk quota exceed',
    status: 'verified',
    audience: 'ops',
    errorSignatures: ['-122', 'disk quota exceed', 'Unknown system error -122', 'EDQUOT', 'No space left on device'],
    services: ['sophclaw'],
    environments: ['production'],
    symptom: '客户发送消息返回 -122，容器日志显示 disk quota exceed。',
    customerReply: '这是我们这边存储配额的问题，正在处理。',
    rootCause: 'PVC 配额用尽。',
    resolution: '扩容 PVC 或清理日志后重启。',
    tags: ['-122', 'disk'],
    updated: '2026-01-01',
  },
}
for (const [name, entry] of Object.entries(FIXTURES)) {
  await fs.writeFile(path.join(kbDir, `${name}.json`), `${JSON.stringify(entry, undefined, 2)}\n`)
}

let passed = 0
let failed = 0

/**
 * 断言一条结论。
 *
 * @param {boolean} ok - 是否成立。
 * @param {string} label - 人类可读的结论。
 * @param {string} [detail] - 失败时的上下文。
 */
function check(ok, label, detail) {
  if (ok) {
    passed += 1
    console.log(`PASS ${label}`)
    return
  }
  failed += 1
  console.log(`FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`)
}

/**
 * 跑一次门禁，收退出码与输出。
 *
 * @param {string[]} args - 传给 eval-gate.mjs 的参数。
 * @returns {Promise<{code: number, out: string}>} 退出码与合并输出。
 */
function gate(args) {
  return new Promise(resolve => {
    // 除非调用方显式给了 --kb，否则一律用自带的迷你知识库。
    const full = args.includes('--kb') ? args : [...args, '--kb', kbDir]
    execFile(process.execPath, [path.join(here, 'eval-gate.mjs'), ...full], { cwd: workspace }, (error, stdout, stderr) => {
      // out 合并两路方便断言"错误里说了什么"；stdout 单独留着解析 JSON——
      // node 自己会往 stderr 打实验特性警告，混进来就不是合法 JSON 了。
      resolve({ code: error?.code ?? 0, out: `${stdout}${stderr}`, stdout })
    })
  })
}

/** 往临时目录写一个 JSON 文件，返回路径。 */
async function writeJson(name, value) {
  const file = path.join(temp, name)
  await fs.writeFile(file, `${JSON.stringify(value, undefined, 2)}\n`)
  return file
}

const CASES = [
  { id: 'hit-400', query: '报错 -400 是什么原因', expect: 'bad-request-400', tier: 'direct' },
  { id: 'hit-122', query: '报错 -122', expect: 'pvc-disk-full', tier: 'direct' },
  { id: 'miss-weather', query: '今天天气怎么样', expect: null, tier: 'miss' },
]

const casesFile = await writeJson('cases.json', CASES)
const baselineFile = path.join(temp, 'rag-baseline.json')

// —— 检索门禁 ——

const record = await gate(['--cases', casesFile, '--baseline', baselineFile, '--update'])
check(record.code === 0, 'recording a baseline succeeds', `exit ${record.code}: ${record.out.slice(0, 200)}`)
const recorded = JSON.parse(await fs.readFile(baselineFile, 'utf8').catch(() => '{}'))
check(
  recorded.cases?.length === CASES.length && typeof recorded.metrics?.recall1 === 'number' && typeof recorded.embedding === 'string',
  'the baseline records cases, metrics and the embedding name',
  JSON.stringify({ cases: recorded.cases?.length, metrics: recorded.metrics, embedding: recorded.embedding }),
)
check(typeof recorded.kb?.fingerprint === 'string' && recorded.kb.fingerprint.length === 12, 'the baseline records a knowledge base fingerprint')

const repeat = await gate(['--cases', casesFile, '--baseline', baselineFile])
check(repeat.code === 0, 'comparing the same knowledge base passes', `exit ${repeat.code}: ${repeat.out.slice(0, 200)}`)
check(repeat.out.includes('retrieval quality matches the baseline'), 'the pass message says what happened')

// 改坏一份知识库：把 bad-request-400 的错误签名清空，它就不该再被 -400 命中。
const brokenKb = path.join(temp, 'kb-broken')
await fs.cp(kbDir, brokenKb, { recursive: true })
const brokenEntry = path.join(brokenKb, 'bad-request-400.json')
const entry = JSON.parse(await fs.readFile(brokenEntry, 'utf8'))
// 把 400 的痕迹从这条目里彻底抹掉，它就不该再被"报错 -400"命中。
entry.errorSignatures = []
entry.title = '请求异常'
entry.symptom = '客户无法使用。'
entry.tags = []
await fs.writeFile(brokenEntry, `${JSON.stringify(entry, undefined, 2)}\n`)

const regressed = await gate(['--cases', casesFile, '--baseline', baselineFile, '--kb', brokenKb])
check(regressed.code === 1, 'a retrieval regression exits 1', `exit ${regressed.code}: ${regressed.out.slice(0, 300)}`)
check(
  regressed.out.includes('hit-400') && regressed.out.includes('used to hit'),
  'the gate names the case that stopped hitting',
  regressed.out.split('\n').filter(line => line.startsWith('FAIL')).join(' | '),
)
check(regressed.out.includes('knowledge base changed since the baseline'), 'the gate says the knowledge base itself changed')

const unknownExpect = await writeJson('cases-unknown.json', [
  { id: 'ghost', query: '报错 -400', expect: 'no-such-entry', tier: 'direct' },
])
const ghost = await gate(['--cases', unknownExpect, '--baseline', baselineFile])
check(ghost.code === 2, 'an expect that points at no entry exits 2', `exit ${ghost.code}`)
check(ghost.out.includes('no-such-entry'), 'the gate names the missing entry')

const duplicate = await writeJson('cases-duplicate.json', [...CASES, { ...CASES[0] }])
const dup = await gate(['--cases', duplicate, '--baseline', baselineFile])
check(dup.code === 2, 'duplicate case ids exit 2', `exit ${dup.code}`)
check(dup.out.includes('duplicate case id'), 'the gate names the duplicate id')

const noBaseline = await gate(['--cases', casesFile, '--baseline', path.join(temp, 'absent.json')])
check(noBaseline.code === 2, 'a missing baseline exits 2', `exit ${noBaseline.code}`)
check(noBaseline.out.includes('--update'), 'the error tells you how to record a baseline')

const otherEmbedding = path.join(temp, 'rag-baseline-openai.json')
await fs.writeFile(otherEmbedding, `${JSON.stringify({ ...recorded, embedding: 'openai' }, undefined, 2)}\n`)
const switched = await gate(['--cases', casesFile, '--baseline', otherEmbedding])
check(switched.code === 1, 'a different embedding provider exits 1', `exit ${switched.code}`)
check(switched.out.includes('embedding provider changed'), 'the gate explains that the embedding changed')

const shrunkCases = await writeJson('cases-shrunk.json', CASES.slice(0, 2))
const shrunk = await gate(['--cases', shrunkCases, '--baseline', baselineFile])
check(shrunk.code === 1, 'dropping a case that the baseline knows exits 1', `exit ${shrunk.code}`)
check(shrunk.out.includes('miss-weather'), 'the gate names the dropped case')

const json = await gate(['--cases', casesFile, '--baseline', baselineFile, '--json'])
let parsed
try {
  parsed = JSON.parse(json.stdout)
} catch {
  parsed = undefined
}
check(parsed?.ok === true && parsed.cases?.length === CASES.length, '--json emits one parseable object', json.out.slice(0, 200))

// —— 回复门禁 ——

const reply = (id, text, extra = {}) => ({ id, question: id, expect: id, reply: text, answered: text !== '', fallback: false, ...extra })
const reviewed = await writeJson('replies-baseline.json', {
  runId: 'reviewed',
  at: '2026-01-01T00:00:00.000Z',
  rows: [reply('refund', '目前平台不支持退款。'), reply('vague', '你说的是哪一类问题？')],
})
const same = await writeJson('last-run-same.json', {
  runId: 'same',
  rows: [reply('refund', '暂时不支持退款呢。'), reply('vague', '能具体说是哪一类问题吗？')],
})
const ok = await gate(['--replies', '--run', same, '--replies-baseline', reviewed])
check(ok.code === 0, 'rewording a reply does not fail the gate', `exit ${ok.code}: ${ok.out.slice(0, 200)}`)

const fellBack = await writeJson('last-run-fallback.json', {
  runId: 'fallback',
  rows: [reply('refund', '抱歉，我这边刚才没处理成功，能再说一次吗？', { fallback: true }), reply('vague', '你说的是哪一类问题？')],
})
const fallbackRun = await gate(['--replies', '--run', fellBack, '--replies-baseline', reviewed])
check(fallbackRun.code === 1, 'a new fallback reply exits 1', `exit ${fallbackRun.code}`)
check(fallbackRun.out.includes('falls back'), 'the gate says the case fell back to the apology reply')

const leaked = await writeJson('last-run-leak.json', {
  runId: 'leak',
  rows: [reply('refund', '我先查一下知识库条目，Harness 里没有相关 prompt。'), reply('vague', '你说的是哪一类问题？')],
})
const leakRun = await gate(['--replies', '--run', leaked, '--replies-baseline', reviewed])
check(leakRun.code === 1, 'a new leak exits 1', `exit ${leakRun.code}`)
check(leakRun.out.includes('now leaks'), 'the gate names the leak that appeared')

const empty = await writeJson('last-run-empty.json', {
  runId: 'empty',
  rows: [reply('refund', ''), reply('vague', '你说的是哪一类问题？')],
})
const emptyRun = await gate(['--replies', '--run', empty, '--replies-baseline', reviewed])
check(emptyRun.code === 1, 'an answer that became empty exits 1', `exit ${emptyRun.code}`)

const partial = await writeJson('last-run-partial.json', {
  runId: 'partial',
  rows: [reply('refund', '目前平台不支持退款。')],
})
const partialRun = await gate(['--replies', '--run', partial, '--replies-baseline', reviewed])
check(partialRun.code === 1, 'a case missing from the run exits 1', `exit ${partialRun.code}`)

const absentRun = await gate(['--replies', '--run', path.join(temp, 'no-run.json'), '--replies-baseline', reviewed])
check(absentRun.code === 2, 'a missing run file exits 2', `exit ${absentRun.code}`)

await fs.rm(temp, { recursive: true, force: true })
console.log('')
console.log(`${passed}/${passed + failed} checks passed`)
process.exit(failed === 0 ? 0 : 1)
