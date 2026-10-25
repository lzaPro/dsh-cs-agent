/**
 * Embedding backends — the vector half of the hybrid retriever.
 *
 * Two backends, both optional:
 *
 * - `hash` (default): a deterministic, dependency-free feature-hashing
 *   embedder. It maps word tokens and character trigrams into a fixed-width
 *   space, so paraphrases and typos that share character material still land
 *   close together. It is *not* a semantic model — it will not connect
 *   "扣费" with "billing" — but it needs no network, no weights, and no
 *   GPU, which is what makes the hybrid retriever work out of the box.
 * - `http`: any OpenAI-compatible `/embeddings` endpoint. Point `baseURL` at a
 *   BGE / M3E / text-embedding service to get real semantic recall; results
 *   are cached on disk by content hash so a restarted process re-embeds
 *   nothing.
 *
 * With `backend: off` the retriever degrades to BM25 only, and every caller
 * keeps working.
 *
 * @module @local/dsh-kb/embed
 */

import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { tokenize } from './kb.js'

/** Default vector width for the hashing embedder. */
export const HASH_DIMS = 512

/** Characters per hashed n-gram. */
const TRIGRAM = 3

/**
 * FNV-1a, 32-bit. Small, fast, and stable across processes — the vector cache
 * is keyed by content, so the hash must not depend on runtime state.
 *
 * @param {string} value - input text.
 * @param {number} seed - small salt so one feature can hash to two positions.
 * @returns {number} unsigned 32-bit hash.
 */
function fnv1a(value, seed) {
  let hash = (0x811c9dc5 ^ seed) >>> 0
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}

/**
 * L2-normalize in place and return the vector.
 *
 * @param {number[]} vector - raw counts.
 * @returns {number[]} unit-length vector, or the zero vector when empty.
 */
export function normalizeVector(vector) {
  let sum = 0
  for (const value of vector) sum += value * value
  if (sum === 0) return vector
  const scale = 1 / Math.sqrt(sum)
  for (let index = 0; index < vector.length; index += 1) vector[index] *= scale
  return vector
}

/**
 * Cosine similarity of two unit vectors.
 *
 * @param {number[]} a - first vector.
 * @param {number[]} b - second vector.
 * @returns {number} similarity in [-1, 1].
 */
export function cosine(a, b) {
  const length = Math.min(a.length, b.length)
  let sum = 0
  for (let index = 0; index < length; index += 1) sum += a[index] * b[index]
  return sum
}

/**
 * Feature-hash one text into a unit vector.
 *
 * @param {string} text - raw text.
 * @param {number} dims - vector width.
 * @returns {number[]} unit-length vector.
 */
export function hashEmbed(text, dims = HASH_DIMS) {
  const vector = new Array(dims).fill(0)
  const lower = text.toLowerCase()
  const features = [...tokenize(lower)]
  for (let index = 0; index < lower.length - TRIGRAM + 1; index += 1) {
    const gram = lower.slice(index, index + TRIGRAM)
    if (/\s/.test(gram)) continue
    features.push(gram)
  }
  for (const feature of features) {
    const position = fnv1a(feature, 0) % dims
    const sign = (fnv1a(feature, 0x9e3779b9) & 1) === 0 ? 1 : -1
    vector[position] += sign
  }
  return normalizeVector(vector)
}

/**
 * SHA-256 of a text, used as the vector cache key.
 *
 * @param {string} text - input text.
 * @returns {string} hex digest.
 */
function digest(text) {
  return createHash('sha256').update(text).digest('hex')
}

/**
 * On-disk vector cache, keyed by `model + digest(text)`.
 */
class VectorCache {
  /**
   * @param {string|undefined} file - cache file; disabled when undefined.
   */
  constructor(file) {
    this.file = file
    this.entries = new Map()
    this.loaded = false
    this.dirty = false
  }

  /** Read the cache once. */
  async load() {
    if (this.loaded) return
    this.loaded = true
    if (this.file === undefined) return
    try {
      const raw = JSON.parse(await fs.readFile(this.file, 'utf8'))
      for (const [key, value] of Object.entries(raw)) {
        if (Array.isArray(value)) this.entries.set(key, value)
      }
    } catch {
      // A missing or corrupt cache is not an error: everything gets re-embedded.
    }
  }

  /**
   * @param {string} key - cache key.
   * @returns {number[]|undefined} cached vector.
   */
  get(key) {
    return this.entries.get(key)
  }

  /**
   * @param {string} key - cache key.
   * @param {number[]} vector - vector to store.
   */
  set(key, vector) {
    this.entries.set(key, vector)
    this.dirty = true
  }

  /** Persist if anything changed. */
  async flush() {
    if (!this.dirty || this.file === undefined) return
    this.dirty = false
    const payload = Object.fromEntries(this.entries)
    await fs.mkdir(path.dirname(this.file), { recursive: true })
    const temporary = `${this.file}.${process.pid}.tmp`
    await fs.writeFile(temporary, JSON.stringify(payload), 'utf8')
    await fs.rename(temporary, this.file)
  }
}

/**
 * Build an embedder from configuration.
 *
 * @param {{backend?: string, dims?: number, baseURL?: string, model?: string, apiKeyEnv?: string, cacheFile?: string, timeoutMs?: number, onError?: string}} [config] - embedding config.
 * @returns {object|null} embedder `{ name, dims, embed(texts) }`, or null when disabled.
 */
export function createEmbedder(config = {}) {
  const backend = config.backend ?? 'hash'
  if (backend === 'off' || backend === 'none') return null

  if (backend === 'hash') {
    const dims = Number.isFinite(config.dims) ? Math.max(64, Math.trunc(config.dims)) : HASH_DIMS
    return {
      name: `hash-${dims}`,
      dims,
      /**
       * @param {string[]} texts - texts to embed.
       * @returns {Promise<number[][]>} unit vectors, in input order.
       */
      async embed(texts) { return texts.map(text => hashEmbed(text, dims)) },
    }
  }

  if (backend !== 'http') {
    throw new Error(`dsh-kb: embedding.backend must be "hash", "http" or "off", got ${JSON.stringify(backend)}`)
  }

  const baseURL = typeof config.baseURL === 'string' ? config.baseURL.replace(/\/+$/, '') : ''
  if (baseURL === '') throw new Error('dsh-kb: embedding.baseURL is required when backend is "http"')
  const model = typeof config.model === 'string' && config.model !== '' ? config.model : 'text-embedding-3-small'
  const apiKeyEnv = typeof config.apiKeyEnv === 'string' && config.apiKeyEnv !== '' ? config.apiKeyEnv : 'DSH_KB_EMBEDDING_KEY'
  const timeoutMs = Number.isFinite(config.timeoutMs) ? config.timeoutMs : 15_000
  const onError = config.onError === 'raise' ? 'raise' : 'fallback'
  const cache = new VectorCache(config.cacheFile)
  let dims = Number.isFinite(config.dims) ? Math.trunc(config.dims) : 0

  /** Fall back to hashing so a dead endpoint never takes the KB offline. */
  const degrade = texts => texts.map(text => hashEmbed(text, dims > 0 ? dims : HASH_DIMS))

  /** One batched request. */
  async function request(texts) {
    const key = process.env[apiKeyEnv] ?? ''
    const response = await fetch(`${baseURL}/embeddings`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(key === '' ? {} : { authorization: `Bearer ${key}` }),
      },
      body: JSON.stringify({ model, input: texts }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 200)
      throw new Error(`dsh-kb: embedding endpoint returned HTTP ${response.status}: ${detail}`)
    }
    const body = await response.json()
    const rows = Array.isArray(body?.data) ? body.data : []
    if (rows.length !== texts.length) {
      throw new Error(`dsh-kb: embedding endpoint returned ${rows.length} vectors for ${texts.length} inputs`)
    }
    return rows
      .slice()
      .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
      .map(row => normalizeVector(Array.from(row.embedding ?? [], Number)))
  }

  return {
    name: `http:${model}`,
    get dims() { return dims },
    /**
     * @param {string[]} texts - texts to embed.
     * @returns {Promise<number[][]>} unit vectors, in input order.
     */
    async embed(texts) {
      await cache.load()
      const output = new Array(texts.length)
      const pending = []
      texts.forEach((text, index) => {
        const key = `${model}:${digest(text)}`
        const hit = cache.get(key)
        if (hit === undefined) pending.push({ index, text, key })
        else output[index] = hit
      })
      const batchSize = 32
      for (let start = 0; start < pending.length; start += batchSize) {
        const batch = pending.slice(start, start + batchSize)
        let vectors
        try {
          vectors = await request(batch.map(item => item.text))
        } catch (error) {
          if (onError === 'raise') throw error
          process.emitWarning(`dsh-kb: embedding failed, using hashed vectors for this call (${error.message})`)
          vectors = degrade(batch.map(item => item.text))
        }
        if (dims === 0 && vectors[0] !== undefined) dims = vectors[0].length
        batch.forEach((item, offset) => {
          output[item.index] = vectors[offset]
          cache.set(item.key, vectors[offset])
        })
      }
      await cache.flush()
      return output
    },
  }
}
