/**
 * Chunking: one entry becomes several addressable spans — the error signature,
 * the symptom, the resolution, the verification, and the customer-facing reply.
 *
 * Retrieval scores chunks instead of whole documents, then folds a chunk score
 * back to its entry with that chunk type's weight. This is what makes "命中处置
 * 段落" and "命中验证段落" different evidence: a customer complaint usually
 * matches the symptom, while an operator's question matches the resolution.
 *
 * @module @local/dsh-kb/chunks
 */

/** Chunk type → (field in the entry, weight when folding back to the entry). */
export const CHUNK_FIELDS = {
  signature: { field: 'errorSignatures', weight: 1.5 },
  title: { field: 'title', weight: 1.3 },
  symptom: { field: 'symptom', weight: 1.2 },
  customerReply: { field: 'customerReply', weight: 1.1 },
  resolution: { field: 'resolution', weight: 1 },
  verification: { field: 'verification', weight: 0.7 },
  meta: { field: 'services', weight: 0.6 },
}

/** Chunk types in display order, used by reports and tests. */
export const CHUNK_TYPES = Object.keys(CHUNK_FIELDS)

/**
 * Split one normalized entry into chunks.
 *
 * @param {object} entry - normalized entry; `entry.text` holds lowercased fields.
 * @returns {object[]} chunks `{ id, entryId, type, weight, text }`.
 */
export function chunksOf(entry) {
  const chunks = []
  const text = entry.text ?? {}
  for (const [type, { field, weight }] of Object.entries(CHUNK_FIELDS)) {
    let value = text[field] ?? ''
    if (type === 'meta') {
      // Service and tag names are short and high precision; keep them in one
      // chunk so "grafana" alone cannot outrank a real symptom match.
      value = [value, text.tags ?? ''].filter(item => item !== '').join(' \n ')
    }
    const trimmed = value.trim()
    if (trimmed === '') continue
    chunks.push({ id: `${entry.id}#${type}`, entryId: entry.id, type, weight, text: trimmed })
  }
  return chunks
}

/**
 * Flatten entries into one chunk list.
 *
 * @param {object[]} entries - normalized entries.
 * @returns {object[]} every chunk across the corpus, in entry order.
 */
export function corpusOf(entries) {
  const chunks = []
  for (const entry of entries) chunks.push(...chunksOf(entry))
  return chunks
}
