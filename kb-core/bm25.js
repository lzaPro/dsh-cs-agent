/**
 * BM25 over chunks — the lexical half of the hybrid retriever.
 *
 * Standard Okapi BM25 (k1 = 1.2, b = 0.75) with an inverted index so a query
 * only touches postings that actually exist. The corpus is small (tens to low
 * thousands of chunks), so the index is rebuilt when the entry set changes and
 * held in memory by the caller.
 *
 * @module @local/dsh-kb/bm25
 */

/** Term-frequency saturation. */
export const BM25_K1 = 1.2

/** Length-normalization strength. */
export const BM25_B = 0.75

/**
 * Count tokens.
 *
 * @param {string[]} tokens - token list, duplicates allowed.
 * @returns {Map<string, number>} token → frequency.
 */
function countTokens(tokens) {
  const tf = new Map()
  for (const token of tokens) tf.set(token, (tf.get(token) ?? 0) + 1)
  return tf
}

/**
 * Build an inverted index over chunks.
 *
 * @param {object[]} chunks - `{ id, entryId, type, weight, text }`.
 * @param {(text: string) => string[]} tokenizeFn - tokenizer, shared with the store.
 * @returns {{postings: Map<string, {doc: number, tf: number}[]>, docs: object[], avgLen: number, n: number}} index.
 */
export function buildBm25(chunks, tokenizeFn) {
  const postings = new Map()
  const docs = []
  let totalLength = 0
  chunks.forEach((chunk, doc) => {
    const tokens = tokenizeFn(chunk.text)
    const tf = countTokens(tokens)
    totalLength += tokens.length
    docs.push({ chunk, length: tokens.length })
    for (const [token, frequency] of tf) {
      const list = postings.get(token)
      if (list === undefined) postings.set(token, [{ doc, tf: frequency }])
      else list.push({ doc, tf: frequency })
    }
  })
  return { postings, docs, avgLen: docs.length === 0 ? 1 : totalLength / docs.length, n: docs.length }
}

/**
 * Inverse document frequency for one posting length.
 *
 * @param {number} n - document count.
 * @param {number} df - documents containing the term.
 * @returns {number} IDF, always positive.
 */
function idf(n, df) {
  return Math.log(1 + (n - df + 0.5) / (df + 0.5))
}

/**
 * Score chunks against query tokens.
 *
 * @param {object} index - built by {@link buildBm25}.
 * @param {string[]} queryTokens - deduplicated query tokens.
 * @param {{limit?: number}} [options] - result cap.
 * @returns {{chunk: object, score: number, matched: string[]}[]} top chunks by score.
 */
export function bm25Search(index, queryTokens, options = {}) {
  const limit = options.limit ?? 20
  const scores = new Map()
  const matched = new Map()
  for (const token of queryTokens) {
    const list = index.postings.get(token)
    if (list === undefined) continue
    const weight = idf(index.n, list.length)
    for (const { doc, tf } of list) {
      const { length } = index.docs[doc]
      const norm = 1 - BM25_B + BM25_B * (length / index.avgLen)
      const gain = weight * ((tf * (BM25_K1 + 1)) / (tf + BM25_K1 * norm))
      scores.set(doc, (scores.get(doc) ?? 0) + gain)
      const hits = matched.get(doc)
      if (hits === undefined) matched.set(doc, [token])
      else hits.push(token)
    }
  }
  return [...scores.entries()]
    .map(([doc, score]) => ({ chunk: index.docs[doc].chunk, score, matched: matched.get(doc) ?? [] }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
}

/**
 * Fold chunk scores back to entries.
 *
 * The best chunk of an entry is the evidence; other chunks only add a small
 * bonus, so one entry cannot win by scattering weak matches everywhere.
 *
 * @param {{chunk: object, score: number, matched: string[]}[]} chunkHits - BM25 hits.
 * @returns {Map<string, {score: number, chunk: object, matched: string[], secondary: number}>} entry → evidence.
 */
export function foldToEntries(chunkHits) {
  const entries = new Map()
  for (const hit of chunkHits) {
    const contribution = hit.score * hit.chunk.weight
    const current = entries.get(hit.chunk.entryId)
    if (current === undefined) {
      entries.set(hit.chunk.entryId, { score: contribution, chunk: hit.chunk, matched: hit.matched, secondary: 0 })
      continue
    }
    if (contribution > current.score) {
      current.secondary += current.score
      current.score = contribution
      current.chunk = hit.chunk
      current.matched = hit.matched
    } else {
      current.secondary += contribution
    }
  }
  return entries
}
