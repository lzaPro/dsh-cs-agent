#!/usr/bin/env node
/**
 * Offline retrieval evaluation for the knowledge base.
 *
 *   node scripts/eval-rag.mjs                 # labelled cases against ./kb
 *   node scripts/eval-rag.mjs --cases FILE    # different case file
 *   node scripts/eval-rag.mjs --kb DIR        # different knowledge base
 *   node scripts/eval-rag.mjs --fail-below 0.9
 *
 * Measures what the hybrid retriever actually promises: did the right entry come
 * back first, was the confidence tier honest, and did an unrelated question
 * stay a miss. No model, no network, no sessions — this is a pure retriever
 * benchmark, so it can run in CI.
 */

import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createKbStore } from '../kb-core/index.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const workspace = path.resolve(here, '..')

/**
 * Parse `--name value` flags.
 *
 * @param {string[]} argv - process arguments.
 * @returns {Record<string, string|boolean>} flag map.
 */
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

/**
 * Pick the first existing path, so the same script works in this workspace
 * (real knowledge base) and in a freshly cloned repo (bundled demo fixtures).
 *
 * @param {string[]} candidates - absolute paths, best first.
 * @returns {Promise<string|null>} the first that exists.
 */
async function firstExisting(candidates) {
  for (const candidate of candidates) {
    try {
      await fs.access(candidate)
      return candidate
    } catch {
      continue
    }
  }
  return null
}

const realKb = path.resolve(workspace, 'kb')
const casesFile = path.resolve(workspace, String(options.cases ?? 'eval/rag-cases.json'))
const fallbackCases = path.join(workspace, 'kb-core', 'demo-cases.json')
const fallbackKb = path.join(workspace, 'kb-core', 'demo-kb')
const resolvedCases = await firstExisting([casesFile, fallbackCases])
const kbDir = path.resolve(workspace, String(options.kb ?? await firstExisting([realKb, fallbackKb])))
if (resolvedCases === null) {
  console.error('no case file found; expected eval/rag-cases.json or kb-core/demo-cases.json')
  process.exit(1)
}
if (resolvedCases !== casesFile) {
  console.log('note: eval/rag-cases.json not found, running the bundled demo fixtures')
}
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-rag-eval-'))

const store = createKbStore({
  kbDir,
  opsKbDir: path.resolve(workspace, 'ops-kb'),
  dataDir,
  embedding: { backend: String(options.embedding ?? 'hash') },
})

const cases = JSON.parse(await fs.readFile(resolvedCases, 'utf8'))
const rows = []
for (const item of cases) {
  const result = await store.search({ query: item.query, limit: 3 }, 'customer-service')
  const top = result.hits[0]
  rows.push({
    id: item.id,
    query: item.query,
    expect: item.expect,
    wantTier: item.tier,
    top: top?.id ?? null,
    score: top?.score ?? 0,
    verdict: result.verdict,
    confidence: result.confidence,
    chunk: top?.chunk ?? '',
    hit1: item.expect === null ? top === undefined : top?.id === item.expect,
    hit3: item.expect === null
      ? top === undefined
      : result.hits.slice(0, 3).some(hit => hit.id === item.expect),
    tierOk: item.tier === undefined ? true : result.verdict === item.tier,
  })
}

const positives = rows.filter(row => row.expect !== null)
const negatives = rows.filter(row => row.expect === null)
const recall1 = positives.length === 0 ? 0 : positives.filter(row => row.hit1).length / positives.length
const recall3 = positives.length === 0 ? 0 : positives.filter(row => row.hit3).length / positives.length
const missRate = negatives.length === 0 ? 0 : negatives.filter(row => row.verdict === 'miss').length / negatives.length
const tierOk = rows.filter(row => row.tierOk).length / Math.max(1, rows.length)

console.log(`embedding: ${store.embeddingName}   cases: ${rows.length}   kb: ${kbDir}`)
console.log('')
for (const row of rows) {
  const mark = row.hit1 && row.tierOk ? 'PASS' : row.hit1 ? 'TIER' : 'FAIL'
  console.log(
    `${mark.padEnd(4)} ${row.id.padEnd(18)} top=${String(row.top).padEnd(32)} `
    + `score=${row.score.toFixed(2)} verdict=${row.verdict}${row.verdict === row.wantTier ? '' : ` (want ${row.wantTier})`}`,
  )
}
console.log('')
console.log(`recall@1 ${(recall1 * 100).toFixed(1)}%   recall@3 ${(recall3 * 100).toFixed(1)}%   `
  + `miss-precision ${(missRate * 100).toFixed(1)}%   tier-agreement ${(tierOk * 100).toFixed(1)}%`)

await fs.rm(dataDir, { recursive: true, force: true })

const floor = Number(options['fail-below'] ?? 0)
if (Number.isFinite(floor) && floor > 0 && recall1 < floor) {
  console.error(`recall@1 ${(recall1 * 100).toFixed(1)}% is below the required ${(floor * 100).toFixed(1)}%`)
  process.exit(1)
}
if (options.strict === true && (recall1 < 1 || missRate < 1 || tierOk < 1)) process.exit(1)
