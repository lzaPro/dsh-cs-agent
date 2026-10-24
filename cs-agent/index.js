/**
 * File-backed knowledge base for the customer-service agent.
 *
 * One JSON document per entry, loaded on every call so edits take effect
 * without a restart. The three model-facing tools are deliberately small:
 * search finds candidates, get reads one in full, propose writes a candidate
 * that a human reviews before it joins the verified set.
 *
 * @module @local/dsh-cs-agent
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { defaultPaths } from './paths.js'

/** Cordis function-plugin name. */
export const name = 'cs-agent-kb'

/** Host services required before the tools can register. */
export const inject = ['tools']

/** Per-field match weights; a signature hit outweighs prose. */
const FIELD_WEIGHTS = {
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
const ROLES = new Set(['customer-service', 'ops'])

/** Entry fields copied into the model-facing summary. */
const SUMMARY_FIELDS = ['id', 'title', 'status', 'services', 'environments', 'errorSignatures']

/** Share of query tokens an entry must match before it counts as a hit. */
const MIN_COVERAGE = 0.25

/**
 * Register the knowledge-base tools on the calling composition.
 * @param ctx - context carrying the tool registry.
 * @param config - deployment configuration; `kbDir` names the entry directory.
 */
export function apply(ctx, config) {
  const kbDir = config?.kbDir ?? defaultPaths().kb
  const role = config?.role
  if (!ROLES.has(role)) {
    throw new Error('cs-agent: config.role must be "customer-service" or "ops"')
  }
  const root = path.resolve(kbDir)

  ctx.tools.register(searchTool(root))
  ctx.tools.register(getTool(root, role))
  ctx.tools.register(proposeTool(root))
}

/**
 * Build the `kb_search` definition.
 * @param root - absolute knowledge-base directory.
 */
function searchTool(root) {
  return {
    name: 'kb_search',
    description:
      'Search the historical incident knowledge base before answering a customer. '
      + 'Match on error text, service, and environment. Returns ranked entries with a score; '
      + 'a score below 20 is weak evidence and should be treated as a miss. '
      + 'Call kb_get with a hit id to read the full resolution.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: {
          type: 'string',
          description: 'Error text, error code, symptom, or a short description of the problem.',
        },
        service: {
          type: 'string',
          description: 'Optional service or application name to filter on.',
        },
        environment: {
          type: 'string',
          description: 'Optional environment such as production or staging.',
        },
        limit: {
          type: 'integer',
          description: 'Maximum hits to return (1-10, default 5).',
        },
      },
      required: ['query'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          hits: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string' },
                title: { type: 'string' },
                status: { type: 'string' },
                audience: { type: 'string' },
                score: { type: 'number' },
                services: { type: 'array', items: { type: 'string' } },
                environments: { type: 'array', items: { type: 'string' } },
                snippet: { type: 'string' },
              },
              required: ['id', 'title', 'status', 'audience', 'score', 'services', 'environments', 'snippet'],
            },
          },
          total: { type: 'integer' },
          hint: { type: 'string' },
        },
        required: ['hits', 'total'],
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.hits.length === 0
          ? `No knowledge-base entry matched. ${value.hint ?? ''}`.trim()
          : value.hits
            .map(hit => `[${hit.id}] ${hit.title} (score ${hit.score}, ${hit.status}, audience=${hit.audience})\n${hit.snippet}`)
            .join('\n\n'),
      }],
    },
    async execute(args) {
      const query = typeof args?.query === 'string' ? args.query.trim() : ''
      if (query === '') throw new Error('kb_search: query must be a non-empty string')
      const entries = await loadEntries(root)
      const tokens = tokenize(query)
      const limit = clamp(Number(args?.limit ?? 5), 1, 10)
      const service = typeof args?.service === 'string' ? args.service.trim().toLowerCase() : ''
      const environment = typeof args?.environment === 'string' ? args.environment.trim().toLowerCase() : ''

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

      const hits = scored.slice(0, limit).map(({ entry, score }) => ({
        id: entry.id,
        title: entry.title,
        status: entry.status,
        audience: entry.audience,
        score,
        services: entry.services,
        environments: entry.environments,
        snippet: snippetOf(entry),
      }))

      return {
        hits,
        total: scored.length,
        hint: scored.length === 0
          ? 'This is likely a new problem. Collect more detail and do not invent a fix.'
          : 'Scores below 20 are weak matches; verify services and environments before trusting a hit. '
            + 'audience=customer means you can answer directly; audience=ops means the fix needs the operations team.',
      }
    },
  }
}

/**
 * Build the `kb_get` definition.
 * @param root - absolute knowledge-base directory.
 * @param role - caller role; `customer-service` never receives internal steps.
 */
function getTool(root, role) {
  return {
    name: 'kb_get',
    description: role === 'ops'
      ? 'Read one complete knowledge-base entry by id, including root cause, resolution steps, and verification.'
      : 'Read one knowledge-base entry by id. Customer-facing entries return the reply you can send; '
        + 'operations-only entries return only the symptom, because the fix is handled internally.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', description: 'The entry id returned by kb_search.' },
      },
      required: ['id'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          found: { type: 'boolean' },
          internalHidden: { type: 'boolean' },
          entry: { type: 'object', additionalProperties: true },
        },
        required: ['found'],
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.found
          ? JSON.stringify(value.entry, undefined, 2)
          : 'No entry with that id. Call kb_search again and use one of the returned ids.',
      }],
    },
    async execute(args) {
      const id = typeof args?.id === 'string' ? args.id.trim() : ''
      if (id === '') throw new Error('kb_get: id must be a non-empty string')
      const entries = await loadEntries(root)
      const entry = entries.find(item => item.id === id)
      if (entry === undefined) return { found: false }
      const hidden = role === 'customer-service' && entry.audience === 'ops'
      return { found: true, internalHidden: hidden, entry: fullEntry(entry, hidden) }
    },
  }
}

/**
 * Build the `kb_propose` definition.
 * @param root - absolute knowledge-base directory.
 */
function proposeTool(root) {
  return {
    name: 'kb_propose',
    description:
      'Save a new incident as a CANDIDATE knowledge entry after the customer confirms it is resolved. '
      + 'Candidates are never returned by kb_search until a human reviews and moves them into the verified set. '
      + 'Call this only when the fix is verified; never for an unconfirmed guess.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        title: { type: 'string', description: 'Short, searchable title, e.g. "payment-service 5xx: upstream timeout".' },
        symptom: { type: 'string', description: 'What the customer observed, in one or two sentences.' },
        rootCause: { type: 'string', description: 'The diagnosed cause. Say "unknown" when it was not established.' },
        resolution: { type: 'string', description: 'The steps that actually fixed it, numbered.' },
        verification: { type: 'string', description: 'How recovery was confirmed.' },
        errorSignatures: {
          type: 'array',
          items: { type: 'string' },
          description: 'Exact error strings, codes, or keywords a future search should match.',
        },
        services: { type: 'array', items: { type: 'string' }, description: 'Affected services or applications.' },
        environments: { type: 'array', items: { type: 'string' }, description: 'Environments where this applies.' },
        audience: { type: 'string', enum: ['customer', 'ops'], description: 'customer = answerable by support directly; ops = needs the operations team.' },
        customerReply: { type: 'string', description: 'What support may say to the customer, verbatim. Never contains internal infrastructure detail.' },
      },
      required: ['title', 'symptom', 'resolution'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          saved: { type: 'boolean' },
          id: { type: 'string' },
          path: { type: 'string' },
        },
        required: ['saved', 'id', 'path'],
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Candidate saved as ${value.id} at ${value.path}. It stays out of search results until a human verifies it.`,
      }],
    },
    async execute(args) {
      const title = requireText(args?.title, 'title')
      const symptom = requireText(args?.symptom, 'symptom')
      const resolution = requireText(args?.resolution, 'resolution')
      const now = new Date()
      const id = `candidate-${stamp(now)}`
      const entry = {
        id,
        title,
        status: 'candidate',
        audience: args?.audience === 'ops' ? 'ops' : 'customer',
        errorSignatures: stringList(args?.errorSignatures),
        services: stringList(args?.services),
        environments: stringList(args?.environments),
        symptom,
        customerReply: typeof args?.customerReply === 'string' ? args.customerReply.trim() : '',
        rootCause: typeof args?.rootCause === 'string' ? args.rootCause.trim() : '',
        resolution,
        verification: typeof args?.verification === 'string' ? args.verification.trim() : '',
        tags: [],
        updated: now.toISOString().slice(0, 10),
        proposedAt: now.toISOString(),
      }
      const dir = path.join(root, '_candidates')
      await fs.mkdir(dir, { recursive: true })
      const file = path.join(dir, `${id}.json`)
      await fs.writeFile(file, `${JSON.stringify(entry, undefined, 2)}\n`, 'utf8')
      return { saved: true, id, path: file }
    },
  }
}

/**
 * Read and validate every verified entry under one directory.
 * @param root - absolute knowledge-base directory.
 * @returns parsed entries; unreadable or malformed files reject loudly.
 */
async function loadEntries(root) {
  let names
  try {
    names = await fs.readdir(root)
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
  const entries = []
  for (const file of names.sort()) {
    if (!file.endsWith('.json') || file.startsWith('_')) continue
    const raw = await fs.readFile(path.join(root, file), 'utf8')
    let data
    try {
      data = JSON.parse(raw)
    } catch (error) {
      throw new Error(`knowledge entry ${file} is not valid JSON: ${error.message}`)
    }
    if (typeof data?.id !== 'string' || data.id === '' || typeof data?.title !== 'string') {
      throw new Error(`knowledge entry ${file} must declare string "id" and "title"`)
    }
    entries.push(normalize(data))
  }
  return entries
}

/**
 * Project one stored document into the shape the scorer needs.
 * @param data - parsed JSON document.
 */
function normalize(data) {
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
    audience: data.audience === 'ops' ? 'ops' : 'customer',
    customerReply: typeof data.customerReply === 'string' ? data.customerReply : '',
    services: stringList(data.services),
    environments: stringList(data.environments),
    errorSignatures: stringList(data.errorSignatures),
    text,
  }
}

/**
 * Score one entry against query tokens.
 * @param entry - normalized entry.
 * @param tokens - deduplicated query tokens.
 * @param query - the raw query, used for whole-signature matching.
 */
function scoreEntry(entry, tokens, query) {
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
 * Split text into Latin words plus CJK bigrams, which keeps Chinese search
 * useful without a segmentation dependency.
 * @param text - raw query text.
 * @returns deduplicated tokens.
 */
function tokenize(text) {
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
 * @param entry - normalized entry.
 */
function snippetOf(entry) {
  const source = entry.symptom || entry.resolution || entry.title
  const flat = source.replace(/\s+/g, ' ').trim()
  return flat.length > 220 ? `${flat.slice(0, 220)}…` : flat
}

/**
 * Project an entry for `kb_get`, dropping the internal search haystack.
 * @param entry - normalized entry.
 * @param hidden - omit internal diagnosis because the caller is customer-facing.
 */
function fullEntry(entry, hidden) {
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
 * @param values - candidate list.
 * @param needle - already lowercased query value.
 */
function matchesAny(values, needle) {
  if (values.length === 0) return true
  return values.some(value => value.toLowerCase() === needle)
}

/**
 * Coerce an optional string array, dropping non-strings.
 * @param value - untrusted model input.
 */
function stringList(value) {
  return Array.isArray(value)
    ? value.filter(item => typeof item === 'string').map(item => item.trim()).filter(item => item !== '')
    : []
}

/**
 * Require a non-empty string argument.
 * @param value - untrusted model input.
 * @param field - argument name for the error message.
 */
function requireText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`kb_propose: ${field} must be a non-empty string`)
  }
  return value.trim()
}

/**
 * Clamp a number into an inclusive integer range.
 * @param value - candidate number.
 * @param min - lower bound.
 * @param max - upper bound.
 */
function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

/**
 * Compact UTC timestamp for generated ids.
 * @param date - instant to format.
 */
function stamp(date) {
  return date.toISOString().replace(/[-:T]/g, '').slice(0, 14)
}
