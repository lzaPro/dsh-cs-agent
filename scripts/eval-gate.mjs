#!/usr/bin/env node
/**
 * 检索质量门禁：拿当前检索结果和一份**基线**逐条比对。
 *
 *   node scripts/eval-gate.mjs              # 和 eval/rag-baseline.json 比
 *   node scripts/eval-gate.mjs --update     # 用当前结果重写基线
 *   node scripts/eval-gate.mjs --json       # 机器可读输出
 *   node scripts/eval-gate.mjs --tolerance 0.02
 *
 *   node scripts/eval-gate.mjs --replies    # 比回复质量：跑完 eval-cs 后门禁用
 *
 * 和 `scripts/eval-rag.mjs` 的分工：那个是**体检**，打印 recall/miss/tier 几个
 * 百分比，人看；这个是**门禁**，逐条比"以前命中的现在还命中吗"，挂了就退出非零。
 *
 * 为什么要逐条比：百分比会互相抵消。改一条知识条目的签名，可能让 2 条以前命中
 * 的变成 miss、同时让 1 条以前 miss 的变成命中，于是 recall@1 从 100% 掉到 96%，
 * 你只知道"掉了一点"，不知道是哪两条——而这才是要修的东西。
 *
 * 为什么要校验用例本身：`expect` 写的是知识条目 id，条目改名/停用后那些用例会
 * 变成"永远不命中"，门禁从此静默失效。所以每条用例的 expect 必须真的能查到。
 *
 * 离线、确定性：默认 hash 向量、临时索引目录，不碰网络、不碰真实运行时数据。
 */

import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { createKbStore } from '../kb-core/index.js'
import { findLeaks } from './reply-leaks.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const workspace = path.resolve(here, '..')

/** 解析 `--name value` 形式的参数。 */
function flags(argv) {
  const out = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) continue
    const name = token.slice(2)
    const next = argv[index + 1]
    if (next === undefined || next.startsWith('--')) out[name] = true
    else {
      out[name] = next
      index += 1
    }
  }
  return out
}

const options = flags(process.argv.slice(2))
const baselineFile = path.resolve(workspace, String(options.baseline ?? 'eval/rag-baseline.json'))
const casesFile = path.resolve(workspace, String(options.cases ?? 'eval/rag-cases.json'))
const kbDir = path.resolve(workspace, String(options.kb ?? 'kb'))
const opsKbDir = path.resolve(workspace, String(options['ops-kb'] ?? 'ops-kb'))
const tolerance = Number(options.tolerance ?? 0)
const asJson = options.json === true

/**
 * 给知识库内容算个指纹。
 *
 * 对**文件正文**取哈希而不是只对 id 和 updated 取：改了签名、改了措辞但忘了
 * 改 `updated` 的情况太常见，而这类改动恰好最能让检索变差。
 */
async function kbFingerprint(dir) {
  let names = []
  try {
    names = (await fs.readdir(dir)).filter(name => name.endsWith('.json')).sort()
  } catch {
    return { entries: 0, fingerprint: 'missing' }
  }
  const hash = createHash('sha256')
  for (const name of names) {
    hash.update(`${name}\u0000`)
    try {
      hash.update(await fs.readFile(path.join(dir, name), 'utf8'))
    } catch {
      hash.update('unreadable')
    }
    hash.update('\u0000')
  }
  return { entries: names.length, fingerprint: hash.digest('hex').slice(0, 12) }
}

/** 百分比，保留一位小数。 */
const pct = value => `${(value * 100).toFixed(1)}%`

/** 打印一行检查结论。 */
function report(ok, label, detail) {
  if (asJson) return
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail === undefined ? '' : ` — ${detail}`}`)
}

/** 准备：读用例、校验用例本身、跑检索。 */
async function runCases() {
  const cases = JSON.parse(await fs.readFile(casesFile, 'utf8'))
  if (!Array.isArray(cases) || cases.length === 0) {
    console.error(`${casesFile}: no cases`)
    process.exit(2)
  }
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-eval-gate-'))
  const store = createKbStore({
    kbDir,
    opsKbDir,
    dataDir,
    embedding: { backend: String(options.embedding ?? 'hash') },
  })

  const problems = []
  const seen = new Set()
  for (const item of cases) {
    if (typeof item?.id !== 'string' || item.id === '') problems.push('a case has no id')
    else if (seen.has(item.id)) problems.push(`duplicate case id: ${item.id}`)
    else seen.add(item.id)
    if (typeof item?.query !== 'string' || item.query === '') problems.push(`case ${item.id} has no query`)
    if (item?.tier !== undefined && !['direct', 'reference', 'miss'].includes(item.tier)) {
      problems.push(`case ${item.id} has an unknown tier: ${item.tier}`)
    }
    if (item?.expect === undefined) problems.push(`case ${item.id} has no expect (use null for a miss)`)
    if (typeof item?.expect === 'string') {
      // 用 ops 角色查：它同时能看见 shared 与 internal，够判断"条目还在不在"。
      const found = await store.get(item.expect, 'ops')
      if (!found.found) problems.push(`case ${item.id} expects "${item.expect}", which is not in the knowledge base`)
    }
  }

  const rows = []
  for (const item of cases) {
    const result = await store.search({ query: item.query, limit: 3 }, 'customer-service')
    const top = result.hits[0]
    const hit1 = item.expect === null ? top === undefined : top?.id === item.expect
    const hit3 = item.expect === null
      ? top === undefined
      : result.hits.slice(0, 3).some(hit => hit.id === item.expect)
    rows.push({
      id: item.id,
      expect: item.expect,
      wantTier: item.tier ?? null,
      top: top?.id ?? null,
      score: Number((top?.score ?? 0).toFixed(4)),
      verdict: result.verdict,
      confidence: Number(result.confidence.toFixed(4)),
      hit1,
      hit3,
      tierOk: item.tier === undefined ? true : result.verdict === item.tier,
    })
  }

  const positives = rows.filter(row => row.expect !== null)
  const negatives = rows.filter(row => row.expect === null)
  const metrics = {
    recall1: positives.length === 0 ? 0 : positives.filter(row => row.hit1).length / positives.length,
    recall3: positives.length === 0 ? 0 : positives.filter(row => row.hit3).length / positives.length,
    missPrecision: negatives.length === 0 ? 0 : negatives.filter(row => row.verdict === 'miss').length / negatives.length,
    tierAgreement: rows.filter(row => row.tierOk).length / Math.max(1, rows.length),
  }

  await fs.rm(dataDir, { recursive: true, force: true })
  return { cases, rows, metrics, problems, embedding: store.embeddingName, kb: await kbFingerprint(kbDir) }
}

/**
 * 回复质量门禁：把 `eval/last-run.json` 与人工审过的 `eval/baseline.json` 比。
 *
 * 检索是确定性的，可以进 CI；回复要真实模型，只能人跑完再门禁。这里比的是
 * **可判定的三件事**：以前答出来的现在答没答、以前没兜底的现在兜没兜底、
 * 以前没泄漏的现在泄漏没泄漏。措辞怎么变不管——那是人的判断。
 *
 * 退出码：0 一致，1 有回退，2 文件不全/用例对不上。
 */
async function runReplies() {
  const runFile = path.resolve(workspace, String(options.run ?? 'eval/last-run.json'))
  const baselineReplies = path.resolve(workspace, String(options['replies-baseline'] ?? 'eval/baseline.json'))
  const readRows = async file => {
    const payload = JSON.parse(await fs.readFile(file, 'utf8'))
    const rows = Array.isArray(payload) ? payload : payload.rows
    if (!Array.isArray(rows)) throw new Error(`${path.relative(workspace, file)}: no rows`)
    return { payload, rows }
  }

  let current
  let baselineRun
  try {
    current = await readRows(runFile)
    baselineRun = await readRows(baselineReplies)
  } catch (error) {
    console.error(`replies gate: ${error.message}`)
    console.error('run `node scripts/eval-cs.mjs` first, and keep eval/baseline.json as the reviewed reference')
    process.exit(2)
  }

  const shape = row => ({
    id: row.id,
    answered: row.answered === true,
    fallback: row.fallback === true,
    leaks: findLeaks(row.reply),
  })
  const before = new Map(baselineRun.rows.map(row => [row.id, shape(row)]))
  const after = new Map(current.rows.map(row => [row.id, shape(row)]))

  const problems = []
  const notes = []
  for (const [id, row] of before) {
    if (!after.has(id)) problems.push(`case ${id} is in the baseline but missing from ${path.relative(workspace, runFile)}`)
  }
  for (const [id, row] of after) {
    const old = before.get(id)
    if (old === undefined) {
      notes.push(`case ${id} is new since the baseline`)
      if (!row.answered) problems.push(`case ${id} was not answered`)
      if (row.leaks.length > 0) problems.push(`case ${id} leaks: ${row.leaks.join(', ')}`)
      continue
    }
    if (old.answered && !row.answered) problems.push(`case ${id} used to be answered and is now empty`)
    if (!old.fallback && row.fallback) problems.push(`case ${id} used to answer and now falls back to the apology reply`)
    const added = row.leaks.filter(label => !old.leaks.includes(label))
    if (added.length > 0) problems.push(`case ${id} now leaks: ${added.join(', ')}`)
  }

  const summary = {
    cases: after.size,
    answered: [...after.values()].filter(row => row.answered && !row.fallback).length,
    leaks: [...after.values()].reduce((total, row) => total + row.leaks.length, 0),
  }

  if (asJson) {
    console.log(JSON.stringify({ ok: problems.length === 0, summary, problems, notes, cases: [...after.values()] }, undefined, 2))
  } else {
    console.log(`replies gate: ${summary.cases} cases from ${path.relative(workspace, runFile)} (run ${current.payload.runId ?? '?'})`)
    console.log(`baseline: ${path.relative(workspace, baselineReplies)} (run ${baselineRun.payload.runId ?? '?'})`)
    console.log('')
    for (const [id, row] of after) {
      const old = before.get(id)
      const regressed = old !== undefined
        && ((old.answered && !row.answered) || (!old.fallback && row.fallback) || row.leaks.some(label => !old.leaks.includes(label)))
      const mark = regressed ? 'FAIL' : row.answered && !row.fallback && row.leaks.length === 0 ? 'PASS' : 'WARN'
      console.log(`${mark.padEnd(4)} ${id.padEnd(20)} answered=${row.answered ? 'yes' : 'no '} fallback=${row.fallback ? 'yes' : 'no '} leaks=${row.leaks.length === 0 ? 'none' : row.leaks.join(',')}`)
    }
    console.log('')
    console.log(`${summary.answered}/${summary.cases} answered without the apology fallback, ${summary.leaks} leak hit(s)`)
    for (const note of notes) console.log(`NOTE ${note}`)
    if (problems.length === 0) console.log('PASS replies match the reviewed baseline')
    else for (const problem of problems) console.log(`FAIL ${problem}`)
  }
  process.exit(problems.length === 0 ? 0 : 1)
}

if (options.replies === true) await runReplies()

const run = await runCases()

if (run.problems.length > 0) {
  for (const problem of run.problems) report(false, 'cases', problem)
  console.error(`${run.problems.length} problem(s) in ${path.relative(workspace, casesFile)}; the gate cannot be trusted until they are fixed`)
  process.exit(2)
}

const baseline = await fs.readFile(baselineFile, 'utf8').then(JSON.parse, () => undefined)

if (options.update === true) {
  const payload = {
    version: 1,
    runId: new Date().toISOString().replace(/[-:T]/g, '').slice(2, 14),
    at: new Date().toISOString(),
    embedding: run.embedding,
    kb: run.kb,
    casesFile: path.relative(workspace, casesFile),
    cases: run.rows,
    metrics: run.metrics,
  }
  await fs.writeFile(baselineFile, `${JSON.stringify(payload, undefined, 2)}\n`)
  console.log(`wrote baseline: ${path.relative(workspace, baselineFile)} (${run.rows.length} cases, recall@1 ${pct(run.metrics.recall1)})`)
  process.exit(0)
}

if (baseline === undefined) {
  console.error(`no baseline at ${path.relative(workspace, baselineFile)}; record one first:`)
  console.error('  node scripts/eval-gate.mjs --update')
  process.exit(2)
}

const problems = []
const notes = []

// 向量后端换了，指标本来就会变，跟代码好坏无关——必须重记基线，不能静默比较。
if (baseline.embedding !== run.embedding) {
  problems.push(`embedding provider changed since the baseline (${baseline.embedding} → ${run.embedding}); rebuild the baseline with --update`)
}
if (baseline.kb?.fingerprint !== undefined && baseline.kb.fingerprint !== run.kb.fingerprint) {
  notes.push(`knowledge base changed since the baseline (${baseline.kb.fingerprint} → ${run.kb.fingerprint}); a regression may come from the entries, not from code`)
}

const before = new Map((baseline.cases ?? []).map(row => [row.id, row]))
const after = new Map(run.rows.map(row => [row.id, row]))

for (const [id, row] of before) {
  if (!after.has(id)) problems.push(`case ${id} is in the baseline but no longer in the cases file`)
}
for (const [id, row] of after) {
  const old = before.get(id)
  if (old === undefined) {
    notes.push(`case ${id} is new since the baseline`)
    continue
  }
  if (old.hit1 === true && row.hit1 === false) {
    problems.push(`case ${id} used to hit "${old.top}" and now returns ${row.top === null ? 'nothing' : `"${row.top}"`}`)
  }
  if (old.tierOk === true && row.tierOk === false) {
    problems.push(`case ${id} used to report verdict "${old.verdict}" and now reports "${row.verdict}"`)
  }
}

for (const [name, floor] of Object.entries({
  recall1: baseline.metrics?.recall1 ?? 0,
  recall3: baseline.metrics?.recall3 ?? 0,
  missPrecision: baseline.metrics?.missPrecision ?? 0,
  tierAgreement: baseline.metrics?.tierAgreement ?? 0,
})) {
  const value = run.metrics[name]
  if (value + tolerance < floor) {
    problems.push(`${name} dropped from ${pct(floor)} to ${pct(value)} (tolerance ${pct(tolerance)})`)
  }
}

if (asJson) {
  console.log(JSON.stringify({
    ok: problems.length === 0,
    embedding: run.embedding,
    kb: run.kb,
    metrics: run.metrics,
    baseline: { runId: baseline.runId, at: baseline.at, metrics: baseline.metrics },
    problems,
    notes,
    cases: run.rows,
  }, undefined, 2))
} else {
  console.log(`retrieval gate: ${run.rows.length} cases, embedding ${run.embedding}, kb ${run.kb.entries} entries (${run.kb.fingerprint})`)
  console.log(`baseline: ${path.relative(workspace, baselineFile)} run ${baseline.runId ?? '?'} at ${baseline.at ?? '?'}`)
  console.log('')
  for (const row of run.rows) {
    const old = before.get(row.id)
    const regressed = old?.hit1 === true && row.hit1 === false
    const mark = row.hit1 === false ? 'FAIL' : regressed ? 'FAIL' : row.tierOk ? 'PASS' : 'TIER'
    console.log(
      `${mark.padEnd(4)} ${row.id.padEnd(20)} top=${String(row.top).padEnd(32)} `
      + `verdict=${row.verdict}${row.tierOk ? '' : ` (want ${row.wantTier})`}`,
    )
  }
  console.log('')
  console.log(`recall@1 ${pct(run.metrics.recall1)}   recall@3 ${pct(run.metrics.recall3)}   `
    + `miss-precision ${pct(run.metrics.missPrecision)}   tier-agreement ${pct(run.metrics.tierAgreement)}`)
  for (const note of notes) console.log(`NOTE ${note}`)
  if (problems.length === 0) console.log('PASS retrieval quality matches the baseline')
  else for (const problem of problems) console.log(`FAIL ${problem}`)
}

process.exit(problems.length === 0 ? 0 : 1)
