/**
 * Hybrid retrieval: chunk index → BM25 recall + vector recall → reciprocal
 * rank fusion → rule-based rerank → confidence tier.
 *
 * The tiers are the contract the agent plays against:
 *
 * - `direct`    — evidence is strong and unambiguous: answer from the entry.
 * - `reference` — evidence is related but not conclusive: use it as a hint,
 *                 say what still needs checking.
 * - `miss`      — nothing convincing: ask for detail, never invent a fix.
 *
 * Everything here is deterministic and offline by default; the only optional
 * dependency is an embedding endpoint (see `embed.js`).
 *
 * @module @local/dsh-kb/hybrid
 */

import { buildBm25, bm25Search, foldToEntries } from './bm25.js'
import { cosine, createEmbedder } from './embed.js'
import { corpusOf } from './chunks.js'
import { scoreEntry, tokenize } from './kb.js'

/** Reciprocal-rank-fusion damping constant. */
export const RRF_K = 60

/** Default tier thresholds and feature weights, overridable by config. */
export const DEFAULT_TUNING = {
  /** Weight of fused rank relevance in the final score. */
  relevance: 0.46,
  /** Weight of a whole-signature match. */
  signature: 0.32,
  /** Weight of query-token coverage. */
  coverage: 0.22,
  /** Weight of the "this entry keeps recurring" prior. */
  occurrences: 0.06,
  /** Weight of partial evidence inside the error-signature field. */
  signatureTokens: 0.20,
  /** Final score at or above which an entry can be answered directly. */
  direct: 0.56,
  /** Final score at or above which an entry is a usable reference. */
  reference: 0.3,
  /** Extra lead the top hit needs over the runner-up to count as direct. */
  margin: 0.08,
  /** Minimum share of the query that must appear for a direct answer. */
  directCoverage: 0.3,
  /** Cosine below which a vector-only recall is noise rather than evidence. */
  semanticFloor: 0.45,
  /** Query-token coverage below which lexical recall needs a signature hit. */
  lexicalFloor: 0.15,
}

/**
 * Merge caller tuning over the defaults.
 *
 * @param {object} [config] - partial tuning.
 * @returns {object} complete tuning.
 */
export function tuningOf(config) {
  const merged = { ...DEFAULT_TUNING }
  for (const [key, value] of Object.entries(config ?? {})) {
    if (Number.isFinite(value)) merged[key] = value
  }
  return merged
}

/**
 * Caches the BM25 index and chunk vectors until the corpus changes.
 */
export class IndexHolder {
  /**
   * @param {object|null} embedder - vector backend, or null for BM25-only.
   */
  constructor(embedder) {
    this.embedder = embedder
    this.key = ''
    this.bm25 = null
    this.chunks = []
    this.vectors = []
  }

  /**
   * Rebuild when the entry set changed.
   *
   * @param {object[]} entries - normalized, searchable entries.
   * @returns {Promise<{bm25: object, chunks: object[], vectors: number[][]}>} current index.
   */
  async ensure(entries) {
    const key = [
      this.embedder?.name ?? 'none',
      ...entries.map(entry => `${entry.id}:${entry.updated ?? ''}:${entry.status}`),
    ].join('|')
    if (key === this.key && this.bm25 !== null) {
      return { bm25: this.bm25, chunks: this.chunks, vectors: this.vectors }
    }
    this.chunks = corpusOf(entries)
    this.bm25 = buildBm25(this.chunks, tokenize)
    this.vectors = this.embedder === null
      ? []
      : await this.embedder.embed(this.chunks.map(chunk => chunk.text))
    this.key = key
    return { bm25: this.bm25, chunks: this.chunks, vectors: this.vectors }
  }
}

/**
 * Fold chunk-level vector similarity back to entries.
 *
 * @param {object[]} chunks - chunk list, parallel to `vectors`.
 * @param {number[][]} vectors - chunk vectors.
 * @param {number[]} queryVector - query vector.
 * @returns {{chunk: object, score: number}[]} chunk hits, best first.
 */
function vectorHits(chunks, vectors, queryVector) {
  const hits = []
  for (let index = 0; index < chunks.length; index += 1) {
    const similarity = cosine(queryVector, vectors[index])
    if (similarity <= 0) continue
    hits.push({ chunk: chunks[index], score: similarity * chunks[index].weight, similarity })
  }
  return hits.sort((a, b) => b.score - a.score)
}

/**
 * Reciprocal rank fusion over two ranked lists.
 *
 * @param {{chunk: object, score: number}[]} lexical - BM25 hits.
 * @param {{chunk: object, score: number}[]} semantic - vector hits.
 * @param {number} limit - how many ranked positions to consider per list.
 * @returns {Map<string, {rrf: number, lexicalRank?: number, semanticRank?: number}>} entry → fused evidence.
 */
export function fuse(lexical, semantic, limit) {
  const fused = new Map()
  const bump = (hit, rank, channel) => {
    const current = fused.get(hit.chunk.entryId) ?? { rrf: 0 }
    const previous = channel === 'lexical' ? current.lexicalRank : current.semanticRank
    // Keep only the best position per entry per channel.
    if (previous !== undefined && previous <= rank) return
    if (previous !== undefined) current.rrf -= 1 / (RRF_K + previous)
    current.rrf += 1 / (RRF_K + rank)
    if (channel === 'lexical') current.lexicalRank = rank
    else current.semanticRank = rank
    fused.set(hit.chunk.entryId, current)
  }
  lexical.slice(0, limit).forEach((hit, index) => bump(hit, index + 1, 'lexical'))
  semantic.slice(0, limit).forEach((hit, index) => bump(hit, index + 1, 'semantic'))
  return fused
}

/**
 * Whole-signature match: the query literally contains an error signature.
 *
 * @param {object} entry - normalized entry.
 * @param {string} query - raw query text.
 * @returns {boolean} whether a signature matched.
 */
export function signatureHit(entry, query) {
  const lower = query.toLowerCase()
  return entry.errorSignatures.some(signature => {
    const needle = signature.toLowerCase()
    if (needle.length >= 3) return lower.includes(needle)
    // Two-character Chinese signatures are often the whole point ("退款",
    // "注销"). They count, except for the words that appear in every incident.
    if (GENERIC_SIGNATURES.has(needle)) return false
    return needle.length === 2 && lower.includes(needle)
  })
}

/** Signatures too generic to be evidence on their own. */
const GENERIC_SIGNATURES = new Set([
  '失败', '错误', '异常', '报错', '超时', '问题', '无法', '不能', '不行', '不可用',
])

/**
 * Share of the query that appears inside the entry's error-signature field.
 *
 * A hit buried in "验证" is weaker evidence than the same token in "错误特征",
 * and this is what separates "客户在问用量" from "客户真的磁盘满了".
 *
 * @param {object} entry - normalized entry.
 * @param {string[]} tokens - query tokens.
 * @returns {number} overlap in [0, 1], saturating after two matched tokens.
 */
export function signatureTokens(entry, tokens) {
  const haystack = entry.text?.errorSignatures ?? ''
  if (haystack === '') return 0
  let matched = 0
  for (const token of tokens) if (haystack.includes(token)) matched += 1
  return Math.min(1, matched / 2)
}

/**
 * Run the full retrieval pipeline.
 *
 * @param {object[]} entries - normalized, searchable entries.
 * @param {string} query - raw query text.
 * @param {object} options - pipeline options.
 * @param {IndexHolder} options.index - warm index holder.
 * @param {number} [options.limit] - hits to return.
 * @param {number} [options.pool] - per-channel recall depth.
 * @param {object} [options.tuning] - tier thresholds and weights.
 * @param {Map<string, number>} [options.occurrences] - entry id → times reported.
 * @returns {Promise<{hits: object[], verdict: string, confidence: number, margin: number}>} retrieval result.
 */
export async function retrieve(entries, query, options) {
  const tuning = options.tuning ?? DEFAULT_TUNING
  const limit = options.limit ?? 5
  const pool = options.pool ?? Math.max(20, limit * 4)
  const tokens = tokenize(query)
  if (tokens.length === 0 || entries.length === 0) {
    return { hits: [], verdict: 'miss', confidence: 0, margin: 0 }
  }

  const { bm25, chunks, vectors } = await options.index.ensure(entries)
  const lexical = bm25Search(bm25, tokens, { limit: pool })

  let semantic = []
  if (options.index.embedder !== null && vectors.length === chunks.length) {
    const [queryVector] = await options.index.embedder.embed([query])
    semantic = vectorHits(chunks, vectors, queryVector)
  }

  const fused = fuse(lexical, semantic, pool)
  const bestRrf = Math.max(0, ...fused.values().map(item => item.rrf))
  if (bestRrf === 0) return { hits: [], verdict: 'miss', confidence: 0, margin: 0 }

  const byId = new Map(entries.map(entry => [entry.id, entry]))
  const lexicalByEntry = foldToEntries(lexical)
  const chunkByEntry = new Map()
  for (const hit of [...lexical, ...semantic]) {
    const current = chunkByEntry.get(hit.chunk.entryId)
    if (current === undefined || hit.score > current.score) chunkByEntry.set(hit.chunk.entryId, hit)
  }

  const bestSimilarity = new Map()
  for (const hit of semantic) {
    const current = bestSimilarity.get(hit.chunk.entryId) ?? 0
    if (hit.similarity > current) bestSimilarity.set(hit.chunk.entryId, hit.similarity)
  }

  const scored = []
  for (const [entryId, evidence] of fused) {
    const entry = byId.get(entryId)
    if (entry === undefined) continue
    const signal = scoreEntry(entry, tokens, query)
    const signature = signatureHit(entry, query)
    // Fusion always produces a rank; evidence is what decides whether that
    // rank is meaningful. Without lexical overlap or a strong vector match the
    // entry is noise, and noise must not reach the agent as a "reference".
    const semanticEvidence = (bestSimilarity.get(entryId) ?? 0) >= tuning.semanticFloor
    const lexicalEvidence = signature || signal.coverage >= tuning.lexicalFloor
    if (!lexicalEvidence && !semanticEvidence) continue
    const sigTokens = signatureTokens(entry, tokens)
    const occurrences = options.occurrences?.get(entryId) ?? 0
    const prior = Math.min(1, Math.log1p(occurrences) / Math.log1p(10))
    const relevance = evidence.rrf / bestRrf
    const statusFactor = entry.status === 'verified' ? 1 : entry.status === 'stale' ? 0.75 : 0.6
    const final = Math.min(1,
      (tuning.relevance * relevance
        + tuning.signature * (signature ? 1 : 0)
        + tuning.coverage * Math.min(1, signal.coverage)
        + tuning.occurrences * prior
        + tuning.signatureTokens * sigTokens) * statusFactor)
    scored.push({
      entry,
      score: Number(final.toFixed(4)),
      relevance: Number(relevance.toFixed(4)),
      similarity: Number((bestSimilarity.get(entryId) ?? 0).toFixed(4)),
      signatures: signature,
      signatureTokens: Number(sigTokens.toFixed(4)),
      coverage: Number(signal.coverage.toFixed(4)),
      occurrences,
      chunk: chunkByEntry.get(entryId)?.chunk ?? lexicalByEntry.get(entryId)?.chunk,
      evidence,
    })
  }

  scored.sort((a, b) => b.score - a.score)
  const top = scored[0]
  const runnerUp = scored[1]
  const margin = runnerUp === undefined ? 1 : top.score - runnerUp.score

  if (top === undefined) return { hits: [], verdict: 'miss', confidence: 0, margin: 0 }

  let verdict = 'miss'
  if (top.score >= tuning.reference) verdict = 'reference'
  // "直接答" needs both a confident score and evidence that covers enough of the
  // question: a single shared word ("服务有点慢" matching 服务) is a lead, not an answer.
  const covered = top.coverage >= tuning.directCoverage
  if (top.score >= tuning.direct && margin >= tuning.margin && (top.signatures || covered)) {
    verdict = 'direct'
  }
  // A clean whole-signature hit with an exact code is conclusive even when a
  // second entry is close, because the caller quoted the identifier.
  if (top.signatures && top.score >= tuning.direct - 0.12) verdict = 'direct'

  const kept = scored
    .filter(item => item.score >= tuning.reference)
    .slice(0, limit)
  return {
    hits: kept,
    verdict,
    confidence: top.score,
    margin: Number(margin.toFixed(4)),
  }
}

export { createEmbedder }
