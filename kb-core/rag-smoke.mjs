/**
 * Unit tests for the retrieval pipeline: chunking, BM25, fusion, the vector
 * channel, duplicate absorption, and the deprecated filter.
 *
 * Each test uses a throwaway knowledge base so nothing touches the real one:
 *
 *   node kb-core/rag-smoke.mjs
 */

import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createKbStore } from './index.js'
import { chunksOf, corpusOf } from './chunks.js'
import { buildBm25, bm25Search, foldToEntries } from './bm25.js'
import { hashEmbed, cosine, createEmbedder } from './embed.js'
import { fuse, retrieve, signatureHit, signatureTokens, DEFAULT_TUNING, IndexHolder } from './hybrid.js'
import { tokenize, isSearchable, signatureSet, jaccard } from './kb.js'
import { createLedger } from './stats.js'

let failed = 0
let passed = 0

/**
 * Run one assertion block.
 *
 * @param {string} name - test label.
 * @param {() => void|Promise<void>} body - assertions.
 * @returns {Promise<void>} resolves after recording the result.
 */
async function test(name, body) {
  try {
    await body()
    passed += 1
    console.log(`PASS ${name}`)
  } catch (error) {
    failed += 1
    console.log(`FAIL ${name}: ${error.message}`)
  }
}

/**
 * Build an entry shaped like a real knowledge-base file.
 *
 * @param {object} overrides - fields to override.
 * @returns {object} entry.
 */
function entry(overrides) {
  return {
    id: overrides.id,
    title: overrides.title ?? overrides.id,
    status: overrides.status ?? 'verified',
    audience: overrides.audience ?? 'customer',
    errorSignatures: overrides.errorSignatures ?? [],
    services: overrides.services ?? ['chat'],
    environments: overrides.environments ?? ['saas'],
    symptom: overrides.symptom ?? '',
    customerReply: overrides.customerReply ?? '',
    rootCause: overrides.rootCause ?? '',
    resolution: overrides.resolution ?? '',
    verification: overrides.verification ?? '',
    tags: overrides.tags ?? [],
    updated: overrides.updated ?? '2026-10-01',
    supersededBy: overrides.supersededBy,
    text: {
      id: overrides.id,
      title: overrides.title ?? overrides.id,
      status: overrides.status ?? 'verified',
      errorSignatures: (overrides.errorSignatures ?? []).join(' \n '),
      services: (overrides.services ?? ['chat']).join(' '),
      tags: (overrides.tags ?? []).join(' '),
      symptom: overrides.symptom ?? '',
      customerReply: overrides.customerReply ?? '',
      rootCause: overrides.rootCause ?? '',
      resolution: overrides.resolution ?? '',
      verification: overrides.verification ?? '',
    },
  }
}

const fixtures = [
  entry({
    id: 'disk-full',
    title: 'PVC 已满',
    errorSignatures: ['-122', 'disk quota exceed'],
    symptom: '客户发消息返回 -122，日志显示 disk quota exceed。',
    customerReply: '存储空间满了，已经转技术同事处理。',
    resolution: '清理 /home/node。',
    verification: '容器 Ready。',
  }),
  entry({
    id: 'dialog-stuck',
    title: '对话没反应',
    errorSignatures: ['对话没反应', '一直转圈'],
    symptom: '客户发消息后一直转圈，没有回复。',
    customerReply: '已经收到，正在处理。',
    resolution: '重启对话容器。',
  }),
  entry({
    id: 'refund',
    title: '退款不支持',
    errorSignatures: ['退款'],
    symptom: '客户要求退款。',
    customerReply: '目前不支持退款。',
    resolution: '说明规则。',
  }),
]

console.log('== chunking')

await test('chunks carry field weights', () => {
  const chunks = chunksOf(fixtures[0])
  const byType = new Map(chunks.map(chunk => [chunk.type, chunk]))
  assert.equal(byType.get('signature').weight, 1.5)
  assert.equal(byType.get('verification').weight, 0.7)
  assert.equal(byType.get('title').weight, 1.3)
  assert.ok(byType.get('signature').text.includes('-122'))
})

await test('empty fields produce no chunk', () => {
  const chunks = chunksOf(fixtures[2])
  assert.equal(chunks.some(chunk => chunk.type === 'verification'), false)
  assert.equal(chunks.some(chunk => chunk.type === 'symptom'), true)
})

await test('corpus flattens every entry', () => {
  const corpus = corpusOf(fixtures)
  assert.ok(corpus.length > fixtures.length)
  assert.equal(new Set(corpus.map(chunk => chunk.id)).size, corpus.length)
  assert.equal(corpus.filter(chunk => chunk.entryId === 'disk-full').length >= 4, true)
})

console.log('== bm25')

await test('bm25 ranks the exact signature chunk first', () => {
  const index = buildBm25(corpusOf(fixtures), tokenize)
  const hits = bm25Search(index, tokenize('disk quota exceed'), { limit: 5 })
  assert.equal(hits[0].chunk.entryId, 'disk-full')
  assert.equal(hits[0].chunk.type, 'signature')
  assert.ok(hits[0].score > 0)
})

await test('bm25 returns nothing for unknown terms', () => {
  const index = buildBm25(corpusOf(fixtures), tokenize)
  assert.deepEqual(bm25Search(index, tokenize('打印机 墨盒'), { limit: 5 }), [])
})

await test('folding keeps the strongest chunk per entry', () => {
  const index = buildBm25(corpusOf(fixtures), tokenize)
  const folded = foldToEntries(bm25Search(index, tokenize('对话没反应'), { limit: 10 }))
  const best = folded.get('dialog-stuck')
  assert.ok(best !== undefined)
  assert.ok(best.score > 0)
  assert.equal(best.chunk.type === 'signature' || best.chunk.type === 'title', true)
})

console.log('== fusion')

await test('rrf prefers a chunk ranked well by both channels', () => {
  const lexical = [
    { chunk: { id: 'a#symptom', entryId: 'a' }, score: 5 },
    { chunk: { id: 'b#symptom', entryId: 'b' }, score: 4 },
  ]
  // Only "b" also has vector evidence, so it must overtake the lexical leader.
  const semantic = [{ chunk: { id: 'b#symptom', entryId: 'b' }, score: 0.9 }]
  const fused = fuse(lexical, semantic, 10)
  assert.equal(fused.get('b').rrf > fused.get('a').rrf, true)
  assert.equal(fused.get('b').semanticRank, 1)
  assert.equal(fused.get('a').semanticRank, undefined)
})

await test('rrf keeps one rank per entry per channel', () => {
  const lexical = [
    { chunk: { id: 'a#symptom', entryId: 'a' }, score: 9 },
    { chunk: { id: 'a#title', entryId: 'a' }, score: 8 },
    { chunk: { id: 'b#symptom', entryId: 'b' }, score: 1 },
  ]
  const fused = fuse(lexical, [], 10)
  assert.equal(fused.size, 2)
  // The better chunk of "a" wins and the weaker one is not double counted.
  assert.equal(fused.get('a').lexicalRank, 1)
  assert.equal(fused.get('a').rrf.toFixed(6), (1 / 61).toFixed(6))
})

console.log('== vector channel')

await test('hash embeddings are deterministic and normalized', () => {
  const one = hashEmbed('对话没反应', 512)
  const two = hashEmbed('对话没反应', 512)
  assert.deepEqual(one, two)
  const norm = Math.sqrt(one.reduce((sum, value) => sum + value * value, 0))
  assert.ok(Math.abs(norm - 1) < 1e-6)
  assert.equal(cosine(one, two).toFixed(5), '1.00000')
})

await test('similar text scores above unrelated text', () => {
  const base = hashEmbed('对话没有反应一直转圈', 512)
  const near = hashEmbed('发消息一直转圈没反应', 512)
  const far = hashEmbed('打印机墨盒怎么换', 512)
  assert.ok(cosine(base, near) > cosine(base, far))
})

await test('semantic channel can carry a miss with no lexical overlap', async () => {
  // A stub embedder maps every text containing 转圈 to the same unit vector so
  // the test exercises the vector path alone, without depending on hash luck.
  const vector = [1, 0, 0, 0]
  const embedder = {
    name: 'stub',
    async embed(texts) {
      return texts.map(text => (text.includes('转圈') || text.includes('卡住') ? vector : [0, 1, 0, 0]))
    },
  }
  const result = await retrieve(fixtures, '卡住不动了', {
    limit: 3,
    index: new IndexHolder(embedder),
    tuning: { ...DEFAULT_TUNING, semanticFloor: 0.5 },
  })
  assert.equal(result.verdict, 'reference')
  assert.equal(result.hits[0].entry.id, 'dialog-stuck')
  assert.equal(result.hits[0].signatures, false)
})

console.log('== signatures')

await test('whole signature match needs the literal string', () => {
  assert.equal(signatureHit(fixtures[0], '报错 -122'), true)
  assert.equal(signatureHit(fixtures[0], '报错 -123'), false)
})

await test('two-character signature counts but generic words do not', () => {
  assert.equal(signatureHit(fixtures[2], '我要退款'), true)
  const generic = entry({ id: 'g', errorSignatures: ['失败'] })
  assert.equal(signatureHit(generic, '上传失败了'), false)
})

await test('signature tokens measure evidence inside the field', () => {
  const tokens = tokenize('磁盘 占用 多少')
  const withHint = entry({ id: 'h', errorSignatures: ['磁盘占用'] })
  const without = entry({ id: 'w', errorSignatures: ['disk quota exceed'] })
  assert.ok(signatureTokens(withHint, tokens) > 0)
  assert.equal(signatureTokens(without, tokens), 0)
})

console.log('== gating')

const index = () => new IndexHolder(createEmbedder({ backend: 'hash' }))

await test('a single shared word is a lead, not a direct answer', async () => {
  const result = await retrieve(fixtures, '服务有点慢', { limit: 3, index: index() })
  assert.notEqual(result.verdict, 'direct')
})

await test('unrelated question stays a miss', async () => {
  const result = await retrieve(fixtures, '今天天气怎么样', { limit: 3, index: index() })
  assert.equal(result.verdict, 'miss')
  assert.equal(result.hits.length, 0)
})

await test('exact code resolves to a direct answer', async () => {
  const result = await retrieve(fixtures, '报错 disk quota exceed', { limit: 3, index: index() })
  assert.equal(result.verdict, 'direct')
  assert.equal(result.hits[0].entry.id, 'disk-full')
})

console.log('== store')

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-rag-'))
const kbDir = path.join(root, 'kb')
const opsKb = path.join(root, 'ops-kb')
await fs.mkdir(kbDir, { recursive: true })
await fs.mkdir(opsKb, { recursive: true })

/**
 * Write one entry as a knowledge-base file.
 *
 * @param {object} item - entry.
 * @returns {Promise<void>} resolves after writing.
 */
async function writeEntry(item) {
  const { text, ...rest } = item
  await fs.writeFile(path.join(kbDir, `${item.id}.json`), `${JSON.stringify(rest, null, 2)}\n`)
}

for (const item of fixtures) await writeEntry(item)

const store = createKbStore({ kbDir, opsKbDir: opsKb, dataDir: path.join(root, 'data') })

await test('search returns tiers and clarify questions', async () => {
  const hit = await store.search({ query: '对话没反应' }, 'customer-service')
  assert.equal(hit.verdict, 'direct')
  assert.equal(hit.hits[0].id, 'dialog-stuck')
  const miss = await store.search({ query: '打印机连不上' }, 'customer-service')
  assert.equal(miss.verdict, 'miss')
  assert.ok(miss.clarify.length > 0)
})

await test('deprecated entries drop out of search', async () => {
  await store.expire('refund', { reason: '政策变更' })
  const result = await store.search({ query: '我要退款' }, 'customer-service')
  assert.equal(result.hits.some(hit => hit.id === 'refund'), false)
  // The retired entry stays readable for audit, but it is marked as such.
  const lookup = await store.get('refund', 'customer-service')
  assert.equal(lookup.found, true)
  assert.equal(lookup.entry.status, 'deprecated')
  assert.equal(isSearchable(lookup.entry), false)
})

await test('superseded entries drop out of search', () => {
  assert.equal(isSearchable(entry({ id: 'x', supersededBy: 'y' })), false)
  assert.equal(isSearchable(entry({ id: 'x', status: 'candidate' })), false)
})

await test('probing a known signature absorbs into the existing entry', async () => {
  const before = (await store.ledger())['disk-full']?.occurrences ?? 0
  const result = await store.propose({
    title: '又是 -122',
    symptom: '客户发消息又是 -122，日志 disk quota exceed。',
    resolution: '清理磁盘。',
    audience: 'customer',
    errorSignatures: ['-122', 'disk quota exceed'],
  }, 'customer-service')
  assert.equal(result.saved, false)
  assert.equal(result.duplicateOf, 'disk-full')
  assert.equal((await store.ledger())['disk-full'].occurrences, before + 1)
})

await test('a novel problem is stored as a candidate', async () => {
  const result = await store.propose({
    title: '导出 PDF 乱码',
    symptom: '客户导出 PDF 后中文变成方块。',
    resolution: '换字体再导出。',
    audience: 'customer',
    errorSignatures: ['PDF 乱码'],
  }, 'customer-service')
  assert.equal(result.saved, true)
  const status = await store.stats()
  assert.equal(status.candidates >= 1, true)
})

await test('duplicate clusters expose near-identical signatures', async () => {
  await fs.writeFile(path.join(kbDir, 'disk-full-copy.json'), `${JSON.stringify({
    ...fixtures[0],
    text: undefined,
    id: 'disk-full-copy',
    title: '同样的 -122 另一个说法',
  }, null, 2)}\n`)
  const clusters = await store.duplicates()
  assert.ok(Array.isArray(clusters))
  const cluster = clusters.find(item => item.id === 'disk-full' || item.members.some(member => member.id === 'disk-full'))
  assert.ok(cluster !== undefined)
  // The group is anchored on one member and lists the rest.
  const memberIds = [cluster.id, ...cluster.members.map(member => member.id)]
  assert.ok(memberIds.includes('disk-full'))
  assert.ok(memberIds.includes('disk-full-copy'))
})

await test('signature sets compare by jaccard', () => {
  const a = signatureSet(entry({ id: 'a', errorSignatures: ['-122', 'disk quota exceed'] }))
  const b = signatureSet(entry({ id: 'b', errorSignatures: ['-122'] }))
  assert.ok(jaccard(a, b) > 0.4)
  assert.equal(jaccard(a, signatureSet(entry({ id: 'c', errorSignatures: ['401'] }))), 0)
})

await test('ledger persists occurrences to disk', async () => {
  const file = path.join(root, 'ledger.json')
  const ledger = createLedger(file)
  await ledger.record('disk-full', 'occurrence')
  await ledger.record('disk-full', 'served')
  const raw = JSON.parse(await fs.readFile(file, 'utf8'))
  assert.equal(raw['disk-full'].occurrences, 1)
  assert.equal(raw['disk-full'].served, 1)
  const reloaded = createLedger(file)
  assert.equal((await reloaded.occurrences()).get('disk-full'), 1)
})

await test('http embedder degrades to hash when the endpoint fails', async () => {
  const embedder = createEmbedder({
    backend: 'http',
    baseURL: 'http://127.0.0.1:9',
    onError: 'fallback',
    timeoutMs: 200,
    cacheFile: path.join(root, 'vectors.json'),
  })
  const [vector] = await embedder.embed(['对话没反应'])
  assert.equal(vector.length, 512)
})

await test('off backend disables the vector channel', () => {
  assert.equal(createEmbedder({ backend: 'off' }), null)
})

await fs.rm(root, { recursive: true, force: true })

console.log('')
console.log(`${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
