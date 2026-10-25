/**
 * Pure knowledge-base helpers: loading, scoring, projection, validation.
 *
 * No Cordis, no filesystem-watching state — callers pass a directory list so
 * the same rules serve the customer-service preset and the ops preset, which
 * read different directories with different audience gating.
 *
 * @module @local/dsh-kb/kb
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'

/** Per-field match weights; a signature hit outweighs prose. */
export const FIELD_WEIGHTS = {
  errorSignatures: 6,
  title: 4,
  customerReply: 2,
  services: 2,
  tags: 2,
  symptom: 2,
  rootCause: 1,
  resolution: 1,
  verification: 1,
}

/** Who is allowed to read an entry's internal diagnosis. */
export const ROLES = new Set(['customer-service', 'ops'])

/** Entry fields copied into the model-facing summary. */
const SUMMARY_FIELDS = ['id', 'title', 'status', 'services', 'environments', 'errorSignatures']

/** Share of query tokens an entry must match before it counts as a hit. */
const MIN_COVERAGE = 0.25

/**
 * One knowledge-base directory plus how its entries are gated.
 *
 * @typedef {object} KbSource
 * @property {string} dir - absolute directory of `*.json` entries.
 * @property {'shared'|'internal'} kind - `internal` entries are ops-only runbooks.
 */

/**
 * Read and validate every verified entry under the given directories.
 *
 * @param {KbSource[]} sources - directories to read, in precedence order.
 * @param {string} role - caller role, used to drop `internal` sources.
 * @returns {Promise<object[]>} normalized entries, each carrying `source`.
 */
export async function loadEntries(sources, role) {
  const entries = []
  for (const source of sources) {
    if (source.kind === 'internal' && role !== 'ops') continue
    let names
    try {
      names = await fs.readdir(source.dir)
    } catch (error) {
      if (error?.code === 'ENOENT') continue
      throw error
    }
    for (const file of names.sort()) {
      if (!file.endsWith('.json') || file.startsWith('_')) continue
      const raw = await fs.readFile(path.join(source.dir, file), 'utf8')
      let data
      try {
        data = JSON.parse(raw)
      } catch (error) {
        throw new Error(`knowledge entry ${file} is not valid JSON: ${error.message}`)
      }
      if (typeof data?.id !== 'string' || data.id === '' || typeof data?.title !== 'string') {
        throw new Error(`knowledge entry ${file} must declare string "id" and "title"`)
      }
      entries.push({ ...normalize(data), source: source.kind, file: path.join(source.dir, file) })
    }
  }
  return entries
}

/**
 * Read every candidate document under one directory, newest first.
 *
 * @param {string} dir - candidate directory (`_candidates`).
 * @returns {Promise<object[]>} candidate entries with their paths.
 */
export async function loadCandidates(dir) {
  let names
  try {
    names = await fs.readdir(dir)
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
  const candidates = []
  for (const file of names.sort().reverse()) {
    if (!file.endsWith('.json')) continue
    const filePath = path.join(dir, file)
    try {
      const data = JSON.parse(await fs.readFile(filePath, 'utf8'))
      candidates.push({ ...data, file: filePath })
    } catch {
      // 坏文件不该挡住整个审核列表；跳过并让审核人看到缺口。
    }
  }
  return candidates
}

/**
 * Project one stored document into the shape the scorer needs.
 *
 * @param {object} data - parsed JSON document.
 * @returns {object} normalized entry.
 */
export function normalize(data) {
  const text = {}
  for (const field of Object.keys(FIELD_WEIGHTS)) {
    const value = data[field]
    text[field] = Array.isArray(value)
      ? value.join(' \n ').toLowerCase()
      : typeof value === 'string' ? value.toLowerCase() : ''
  }
  return {
    ...data,
    id: data.id,
    title: data.title,
    status: typeof data.status === 'string' ? data.status : 'unverified',
    audience: data.audience === 'ops' ? 'ops' : data.audience === 'internal' ? 'internal' : 'customer',
    customerReply: typeof data.customerReply === 'string' ? data.customerReply : '',
    services: stringList(data.services),
    environments: stringList(data.environments),
    errorSignatures: stringList(data.errorSignatures),
    text,
  }
}

/**
 * Whether an entry may be returned by search.
 *
 * Deprecated entries stay on disk (the history is worth keeping) but drop out
 * of retrieval, and an entry superseded by another one is never a better answer
 * than its replacement.
 *
 * @param {object} entry - normalized entry.
 * @returns {boolean} true when the entry is part of the live corpus.
 */
export function isSearchable(entry) {
  if (entry.status === 'candidate' || entry.status === 'deprecated' || entry.status === 'retired') return false
  return typeof entry.supersededBy !== 'string' || entry.supersededBy === ''
}

/**
 * Normalized signature set, used for duplicate detection and recurrence counts.
 *
 * @param {object} entry - normalized entry or candidate document.
 * @returns {Set<string>} lowercased, trimmed signatures.
 */
export function signatureSet(entry) {
  return new Set(stringList(entry.errorSignatures).map(value => value.toLowerCase().trim()).filter(value => value !== ''))
}

/**
 * Jaccard overlap of two signature sets.
 *
 * @param {Set<string>} a - first set.
 * @param {Set<string>} b - second set.
 * @returns {number} overlap in [0, 1]; 0 when either side is empty.
 */
export function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0
  let shared = 0
  for (const value of a) if (b.has(value)) shared += 1
  return shared / (a.size + b.size - shared)
}

/**
 * Score one entry against query tokens.
 *
 * @param {object} entry - normalized entry.
 * @param {string[]} tokens - deduplicated query tokens.
 * @param {string} query - the raw query, used for whole-signature matching.
 * @returns {{score: number, coverage: number, signatureHit: boolean}} ranking signal.
 */
export function scoreEntry(entry, tokens, query) {
  let score = 0
  const matched = new Set()
  for (const [field, weight] of Object.entries(FIELD_WEIGHTS)) {
    const haystack = entry.text[field]
    if (haystack === '') continue
    for (const token of tokens) {
      if (haystack.includes(token)) {
        score += weight
        matched.add(token)
      }
    }
  }
  let signatureHit = false
  const normalizedQuery = query.toLowerCase()
  for (const signature of entry.errorSignatures) {
    const needle = signature.toLowerCase()
    if (needle.length >= 3 && normalizedQuery.includes(needle)) {
      score += 10
      signatureHit = true
    }
  }
  return { score, coverage: tokens.length === 0 ? 0 : matched.size / tokens.length, signatureHit }
}

/**
 * Rank entries against a query.
 *
 * @param {object[]} entries - normalized entries.
 * @param {string} query - raw query text.
 * @param {{service?: string, environment?: string, limit?: number}} [filter] - optional narrowing.
 * @returns {object[]} ranked hits carrying `entry` and `score`.
 */
export function rank(entries, query, filter = {}) {
  const tokens = tokenize(query)
  const limit = clamp(Number(filter.limit ?? 5), 1, 10)
  const service = typeof filter.service === 'string' ? filter.service.trim().toLowerCase() : ''
  const environment = typeof filter.environment === 'string' ? filter.environment.trim().toLowerCase() : ''

  const scored = []
  for (const entry of entries) {
    if (service !== '' && !matchesAny(entry.services, service)) continue
    if (environment !== '' && !matchesAny(entry.environments, environment)) continue
    const { score, coverage, signatureHit } = scoreEntry(entry, tokens, query)
    // A single shared bigram ("连接") must not surface an unrelated incident:
    // require either a whole signature match or a quarter of the query tokens.
    if (score > 0 && (signatureHit || coverage >= MIN_COVERAGE)) scored.push({ entry, score })
  }
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, limit)
}

/**
 * Split text into Latin words plus CJK bigrams, which keeps Chinese search
 * useful without a segmentation dependency.
 *
 * @param {string} text - raw query text.
 * @returns {string[]} deduplicated tokens.
 */
export function tokenize(text) {
  const lower = text.toLowerCase()
  const words = lower.match(/[a-z0-9][a-z0-9_.:/-]{1,}/g) ?? []
  const runs = lower.match(/[\u4e00-\u9fff]+/g) ?? []
  const bigrams = []
  for (const run of runs) {
    if (run.length === 1) bigrams.push(run)
    for (let index = 0; index < run.length - 1; index += 1) bigrams.push(run.slice(index, index + 2))
  }
  return [...new Set([...words, ...bigrams])]
}

/**
 * Build the short model-facing snippet for one hit.
 *
 * @param {object} entry - normalized entry.
 * @returns {string} one-line snippet.
 */
export function snippetOf(entry) {
  const source = entry.symptom || entry.resolution || entry.title
  const flat = String(source).replace(/\s+/g, ' ').trim()
  return flat.length > 220 ? `${flat.slice(0, 220)}…` : flat
}

/**
 * Project an entry for `kb_get`, dropping the internal search haystack.
 *
 * @param {object} entry - normalized entry.
 * @param {boolean} hidden - omit internal diagnosis because the caller is customer-facing.
 * @returns {object} model-facing entry.
 */
export function fullEntry(entry, hidden) {
  const copy = {}
  for (const field of SUMMARY_FIELDS) copy[field] = entry[field]
  copy.audience = entry.audience
  copy.symptom = entry.symptom ?? ''
  copy.customerReply = entry.customerReply ?? ''
  copy.tags = stringList(entry.tags)
  copy.updated = entry.updated ?? ''
  if (!hidden) {
    copy.rootCause = entry.rootCause ?? ''
    copy.resolution = entry.resolution ?? ''
    copy.verification = entry.verification ?? ''
  }
  return copy
}

/**
 * Case-insensitive membership test against a list, tolerant of a missing list.
 *
 * @param {string[]} values - candidate list.
 * @param {string} needle - already lowercased query value.
 * @returns {boolean} whether the list is unconstrained or contains the needle.
 */
export function matchesAny(values, needle) {
  if (values.length === 0) return true
  return values.some(value => value.toLowerCase() === needle)
}

/**
 * Coerce an optional string array, dropping non-strings.
 *
 * @param {unknown} value - untrusted model input.
 * @returns {string[]} cleaned list.
 */
export function stringList(value) {
  return Array.isArray(value)
    ? value.filter(item => typeof item === 'string').map(item => item.trim()).filter(item => item !== '')
    : []
}

/**
 * Require a non-empty string argument.
 *
 * @param {unknown} value - untrusted model input.
 * @param {string} field - argument name for the error message.
 * @returns {string} trimmed text.
 */
export function requireText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${field} must be a non-empty string`)
  }
  return value.trim()
}

/**
 * Clamp a number into an inclusive integer range.
 *
 * @param {number} value - candidate number.
 * @param {number} min - lower bound.
 * @param {number} max - upper bound.
 * @returns {number} clamped integer.
 */
export function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

/**
 * Compact UTC timestamp for generated ids.
 *
 * @param {Date} [date] - instant to format.
 * @returns {string} `YYYYMMDDHHmmss`.
 */
export function stamp(date = new Date()) {
  return date.toISOString().replace(/[-:T]/g, '').slice(0, 14)
}
