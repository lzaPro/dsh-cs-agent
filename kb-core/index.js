/**
 * Shared knowledge-base host: one `kbStore` service over the verified entries,
 * the ops-only runbooks, and the candidate queue.
 *
 * The model-facing tools live in `./tools.js` and are mounted per preset with a
 * role, so the customer-service composition and the ops composition share the
 * same ranking rules but different read permissions. The host also exposes the
 * candidate queue so the ops panel can review proposals a human has to verify.
 *
 * Retrieval is hybrid (`hybrid.js`): chunked BM25 plus vector recall, fused and
 * reranked into three confidence tiers. The tier is the contract the agent
 * follows: answer, hedge, or ask — and asking is never a generation step.
 *
 * Entries are read on every call: editing a JSON file takes effect without a
 * restart. The BM25 index and chunk vectors are cached until the entry set
 * changes.
 *
 * @module @local/dsh-kb
 */

import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import {
  fullEntry,
  isSearchable,
  jaccard,
  loadCandidates,
  loadEntries,
  normalize,
  ROLES,
  signatureSet,
  snippetOf,
  stamp,
  stringList,
} from './kb.js'
import { createEmbedder, IndexHolder, retrieve, tuningOf } from './hybrid.js'
import { createLedger } from './stats.js'

/** Cordis function-plugin name. */
export const name = 'kb-store'

/** Nothing is injected: the store only needs the filesystem. */
export const inject = []

/** DSH home directory. */
function dshHome() {
  return process.env.DSH_HOME ?? path.join(homedir(), '.dsh')
}

/** Customer-service runtime root, shared with the gateway's ledger. */
function runtimeRoot() {
  return process.env.DSH_CS_ROOT ?? path.join(dshHome(), 'cs-runtime')
}

/**
 * Register the `kbStore` service.
 *
 * @param ctx - host context.
 * @param config - `kbDir`, `opsKbDir`, and `candidateDir`; all optional.
 */
export function apply(ctx, config) {
  const store = createKbStore(config)
  const dispose = ctx.provide('kbStore', store)
  ctx.effect(() => dispose, 'kb-store: service')
}

/**
 * Build the store. Exported for tests.
 *
 * @param config - deployment configuration.
 * @returns the knowledge-base service.
 */
export function createKbStore(config) {
  const root = runtimeRoot()
  const dataDir = requireAbsolute(blankToUndefined(config?.dataDir) ?? path.join(root, 'data'), 'dataDir')
  const kbDir = requireAbsolute(blankToUndefined(config?.kbDir) ?? path.join(root, 'kb'), 'kbDir')
  const opsKbDir = requireAbsolute(blankToUndefined(config?.opsKbDir) ?? path.join(root, 'ops-kb'), 'opsKbDir')
  const candidateDir = requireAbsolute(
    blankToUndefined(config?.candidateDir) ?? path.join(kbDir, '_candidates'),
    'candidateDir',
  )
  const indexDir = requireAbsolute(blankToUndefined(config?.indexDir) ?? path.join(dataDir, 'kb-index'), 'indexDir')
  const statsFile = requireAbsolute(
    blankToUndefined(config?.statsFile) ?? path.join(dataDir, 'kb-stats.json'),
    'statsFile',
  )

  const embedding = config?.embedding ?? {}
  const embedder = createEmbedder({
    ...embedding,
    cacheFile: blankToUndefined(embedding.cacheFile) ?? path.join(indexDir, 'vectors.json'),
  })
  const index = new IndexHolder(embedder)
  const ledger = createLedger(statsFile)
  const tuning = tuningOf(config?.tuning)

  /** Directories one role may read, in precedence order. */
  function sourcesFor(role) {
    requireRole(role)
    const sources = [{ dir: kbDir, kind: 'shared' }]
    if (role === 'ops') sources.push({ dir: opsKbDir, kind: 'internal' })
    return sources
  }

  /** Live entries for a role, i.e. everything search is allowed to return. */
  async function searchableFor(role) {
    const entries = await loadEntries(sourcesFor(role), role)
    return entries.filter(isSearchable)
  }

  return {
    kbDir,
    opsKbDir,
    candidateDir,
    dataDir,
    indexDir,
    statsFile,
    embeddingName: embedder?.name ?? 'off',

    /**
     * Rank entries against a query for one role.
     *
     * @param {{query: string, service?: string, environment?: string, limit?: number}} args - query.
     * @param {string} role - caller role.
     * @returns {Promise<{hits: object[], total: number, verdict: string, confidence: number, margin: number, clarify: string[]}>} retrieval result.
     */
    async search({ query, service, environment, limit }, role) {
      const entries = await searchableFor(role)
      const filtered = filterEntries(entries, { service, environment })
      const occurrences = await ledger.occurrences()
      // A service/environment filter that matches nothing must not be reported as
      // "the knowledge base has nothing": the model guessed the service name and
      // the entry uses another one. Retry unfiltered, and say so in the note.
      let pool = filtered
      let note
      if (pool.length === 0 && entries.length > 0) {
        pool = entries
        const filters = [
          service === undefined || service === '' ? undefined : `service=${service}`,
          environment === undefined || environment === '' ? undefined : `environment=${environment}`,
        ].filter(Boolean).join(' ')
        note = `No entry carries ${filters}; the results below ignore that filter.`
      }
      const result = await retrieve(pool, query, {
        index,
        limit,
        tuning,
        occurrences,
      })
      const hits = result.hits.map(item => ({
        id: item.entry.id,
        title: item.entry.title,
        status: item.entry.status,
        audience: item.entry.audience,
        source: item.entry.source,
        score: item.score,
        services: item.entry.services,
        environments: item.entry.environments,
        snippet: snippetOf(item.entry),
        chunk: item.chunk?.type ?? 'entry',
        signals: {
          relevance: item.relevance,
          coverage: item.coverage,
          signature: item.signatures,
          signatureTokens: item.signatureTokens,
          occurrences: item.occurrences,
        },
      }))
      return {
        hits,
        total: hits.length,
        verdict: result.verdict,
        confidence: result.confidence,
        margin: result.margin,
        clarify: result.verdict === 'miss' ? missingDetail(query, role) : [],
        note,
      }
    },

    /**
     * Read one entry by id for one role.
     *
     * @param {string} id - entry id.
     * @param {string} role - caller role.
     * @returns {Promise<{found: boolean, internalHidden?: boolean, entry?: object}>} lookup result.
     */
    async get(id, role) {
      const entries = await loadEntries(sourcesFor(role), role)
      const entry = entries.find(item => item.id === id)
      if (entry === undefined) return { found: false }
      // 对外条目里的内部诊断对客服隐藏；ops 条目只给在一次被动检索里看到的症状。
      const hidden = role === 'customer-service' && entry.audience !== 'customer'
      void ledger.record(id, 'served')
      return { found: true, internalHidden: hidden, entry: { ...fullEntry(entry, hidden), source: entry.source } }
    },

    /**
     * Save one candidate entry for human review, or absorb it into an entry it
     * duplicates and bump that entry's recurrence count.
     *
     * @param {object} input - candidate fields from the model.
     * @returns {Promise<{saved: boolean, id: string, path: string, duplicateOf?: string, occurrences?: number}>} write result.
     */
    async propose(input) {
      const voluntary = stringList(input.errorSignatures)
      const volunteerSet = new Set(voluntary.map(value => value.toLowerCase().trim()).filter(value => value !== ''))
      const role = input.source === 'ops' ? 'ops' : 'customer-service'
      const existing = await loadEntries(sourcesFor(role), role)
      const candidates = await loadCandidates(candidateDir)
      const duplicate = findDuplicate(volunteerSet, [
        ...existing.map(item => ({ id: item.id, file: item.file, signatures: signatureSet(item) })),
        ...candidates.map(item => ({ id: item.id, file: item.file, signatures: signatureSet(item) })),
      ])
      if (duplicate !== undefined) {
        // A recurring incident is not a new incident: count it against the
        // entry that already covers it, so ranking can lift it next time.
        const counts = await ledger.record(duplicate.id, 'occurrence')
        return {
          saved: false,
          id: duplicate.id,
          path: duplicate.file,
          duplicateOf: duplicate.id,
          occurrences: counts.occurrences,
        }
      }

      const now = new Date()
      const id = `candidate-${stamp(now)}-${Math.random().toString(36).slice(2, 6)}`
      const entry = {
        id,
        title: input.title,
        status: 'candidate',
        audience: input.audience === 'ops' ? 'ops' : input.audience === 'internal' ? 'internal' : 'customer',
        errorSignatures: voluntary,
        services: stringList(input.services),
        environments: stringList(input.environments),
        symptom: input.symptom ?? '',
        customerReply: input.customerReply ?? '',
        rootCause: input.rootCause ?? '',
        resolution: input.resolution ?? '',
        verification: input.verification ?? '',
        tags: stringList(input.tags),
        source: input.source ?? 'unknown',
        incidentId: input.incidentId ?? '',
        updated: now.toISOString().slice(0, 10),
        proposedAt: now.toISOString(),
      }
      await fs.mkdir(candidateDir, { recursive: true })
      const file = path.join(candidateDir, `${id}.json`)
      await fs.writeFile(file, `${JSON.stringify(entry, undefined, 2)}\n`, 'utf8')
      return { saved: true, id, path: file }
    },

    /**
     * List pending candidates, newest first.
     *
     * @returns {Promise<object[]>} candidate documents with `file`.
     */
    async candidates() {
      return loadCandidates(candidateDir)
    },

    /**
     * Promote one candidate into the verified set (or the ops runbook set).
     *
     * @param {string} id - candidate id.
     * @param {{audience?: string, reviewer?: string}} [options] - target audience override.
     * @returns {Promise<{ok: boolean, reason?: string, path?: string}>} outcome.
     */
    async verify(id, options = {}) {
      const candidates = await loadCandidates(candidateDir)
      const candidate = candidates.find(item => item.id === id)
      if (candidate === undefined) return { ok: false, reason: `没有待审核的候选 ${id}` }
      const audience = options.audience === 'ops' || options.audience === 'internal'
        ? options.audience
        : candidate.audience ?? 'customer'
      const target = audience === 'internal' ? opsKbDir : kbDir
      const entry = normalize({
        ...candidate,
        status: 'verified',
        audience,
        verifiedAt: new Date().toISOString(),
        verifiedBy: options.reviewer ?? 'admin',
      })
      delete entry.text
      delete entry.file
      const file = path.join(target, `${entry.id}.json`)
      await fs.mkdir(target, { recursive: true })
      await fs.writeFile(file, `${JSON.stringify(entry, undefined, 2)}\n`, 'utf8')
      await fs.rm(candidate.file, { force: true })
      return { ok: true, path: file }
    },

    /**
     * Drop one candidate without promoting it.
     *
     * @param {string} id - candidate id.
     * @param {{reason?: string}} [options] - rejection note.
     * @returns {Promise<{ok: boolean, reason?: string}>} outcome.
     */
    async reject(id, options = {}) {
      const candidates = await loadCandidates(candidateDir)
      const candidate = candidates.find(item => item.id === id)
      if (candidate === undefined) return { ok: false, reason: `没有待审核的候选 ${id}` }
      candidate.rejectedAt = new Date().toISOString()
      candidate.rejectReason = options.reason ?? ''
      const dir = path.join(candidateDir, '_rejected')
      await fs.mkdir(dir, { recursive: true })
      await fs.writeFile(path.join(dir, path.basename(candidate.file)), `${JSON.stringify(candidate, undefined, 2)}\n`, 'utf8')
      await fs.rm(candidate.file, { force: true })
      return { ok: true }
    },

    /**
     * Retire an entry without deleting it.
     *
     * @param {string} id - entry id.
     * @param {{reason?: string, supersededBy?: string}} [options] - why it stopped being true.
     * @returns {Promise<{ok: boolean, reason?: string, path?: string}>} outcome.
     */
    async expire(id, options = {}) {
      for (const dir of [kbDir, opsKbDir]) {
        const file = path.join(dir, `${id}.json`)
        let data
        try {
          data = JSON.parse(await fs.readFile(file, 'utf8'))
        } catch {
          continue
        }
        data.status = 'deprecated'
        data.deprecatedAt = new Date().toISOString()
        data.deprecatedReason = options.reason ?? ''
        if (typeof options.supersededBy === 'string' && options.supersededBy !== '') {
          data.supersededBy = options.supersededBy
        }
        await fs.writeFile(file, `${JSON.stringify(data, undefined, 2)}\n`, 'utf8')
        return { ok: true, path: file }
      }
      return { ok: false, reason: `没有找到条目 ${id}` }
    },

    /**
     * Cluster live entries and candidates that share error signatures.
     *
     * @returns {Promise<{id: string, kind: string, members: {id: string, kind: string, title: string, similarity: number}[]}[]>} duplicate groups.
     */
    async duplicates() {
      const entries = await loadEntries([{ dir: kbDir, kind: 'shared' }, { dir: opsKbDir, kind: 'internal' }], 'ops')
      const candidates = await loadCandidates(candidateDir)
      const nodes = [
        ...entries.map(item => ({ id: item.id, kind: item.status === 'verified' ? 'verified' : item.status, title: item.title, signatures: signatureSet(item) })),
        ...candidates.map(item => ({ id: item.id, kind: 'candidate', title: item.title ?? '', signatures: signatureSet(item) })),
      ].filter(node => node.signatures.size > 0)
      const groups = []
      const used = new Set()
      for (const node of nodes) {
        if (used.has(node.id)) continue
        const members = nodes
          .filter(other => other.id !== node.id && jaccard(node.signatures, other.signatures) >= 0.5)
          .map(other => ({ id: other.id, kind: other.kind, title: other.title, similarity: jaccard(node.signatures, other.signatures) }))
        if (members.length === 0) continue
        used.add(node.id)
        for (const member of members) used.add(member.id)
        groups.push({ id: node.id, kind: node.kind, members })
      }
      return groups
    },

    /**
     * Counts for the panel status card.
     *
     * @returns {Promise<{shared: number, internal: number, candidates: number, deprecated: number, recurring: number, served: number, embedding: string}>} totals.
     */
    async stats() {
      const [shared, internal, candidates, stats] = await Promise.all([
        loadEntries([{ dir: kbDir, kind: 'shared' }], 'ops'),
        loadEntries([{ dir: opsKbDir, kind: 'internal' }], 'ops'),
        loadCandidates(candidateDir),
        ledger.snapshot(),
      ])
      const values = Object.values(stats)
      return {
        shared: shared.length,
        internal: internal.length,
        candidates: candidates.length,
        deprecated: [...shared, ...internal].filter(item => !isSearchable(item)).length,
        recurring: values.filter(item => (item.occurrences ?? 0) > 0).length,
        served: values.reduce((sum, item) => sum + (item.served ?? 0), 0),
        embedding: embedder?.name ?? 'off',
      }
    },

    /**
     * Occurrence ledger, for reports.
     *
     * @returns {Promise<object>} id → counts.
     */
    async ledger() {
      return ledger.snapshot()
    },
  }
}

/**
 * Apply the optional service / environment narrowing before retrieval.
 *
 * @param {object[]} entries - normalized entries.
 * @param {{service?: string, environment?: string}} filter - caller filter.
 * @returns {object[]} entries that satisfy the filter.
 */
function filterEntries(entries, filter) {
  const service = typeof filter.service === 'string' ? filter.service.trim().toLowerCase() : ''
  const environment = typeof filter.environment === 'string' ? filter.environment.trim().toLowerCase() : ''
  return entries.filter(entry => {
    if (service !== '' && !matches(entry.services, service)) return false
    if (environment !== '' && !matches(entry.environments, environment)) return false
    return true
  })
}

/** Case-insensitive membership test against a list, tolerant of a missing list. */
function matches(values, needle) {
  if (values.length === 0) return true
  return values.some(value => value.toLowerCase() === needle)
}

/**
 * Find an entry or candidate that already covers the same signatures.
 *
 * @param {Set<string>} signatures - proposed signatures.
 * @param {{id: string, file: string, signatures: Set<string>}[]} pool - existing material.
 * @returns {object|undefined} the duplicate, if any.
 */
function findDuplicate(signatures, pool) {
  if (signatures.size === 0) return undefined
  for (const item of pool) {
    if (item.signatures.size === 0) continue
    if (jaccard(signatures, item.signatures) >= 0.5) return item
  }
  return undefined
}

/**
 * Pick the questions that are still missing from a report.
 *
 * The list is deterministic and short on purpose: a miss must produce concrete
 * questions, not an invitation to guess. It is also role-aware, because the two
 * roles talk to different people: asking a customer "生产环境还是测试环境" or
 * "影响所有用户还是个别账号" is nonsense, while asking them for the exact
 * error text, the account, and the time is exactly what support needs.
 *
 * @param {string} query - raw query text.
 * @param {string} role - `customer-service` or `ops`.
 * @returns {string[]} up to three questions.
 */
function missingDetail(query, role) {
  const text = query.toLowerCase()
  const questions = []
  const hasError = /[a-z][a-z0-9_]{2,}|\b\d{3,5}\b|报错|错误|失败|异常|超时|报[0-9]/.test(text)

  if (role === 'customer-service') {
    if (!hasError) questions.push('具体提示的是什么？把屏幕上的原文或截图发我看看。')
    if (!/@|邮箱|手机号|账号|工号|用户名/.test(text)) {
      questions.push('方便说下你登录用的手机号或邮箱吗？我核对一下是哪个账号。')
    }
    if (!/刚才|今天|昨天|早上|下午|晚上|\d+\s*(点|时|分钟|小时)|\d{1,2}:\d{2}/.test(text)) {
      questions.push('大概什么时候开始的？现在还会出现吗？')
    }
    return questions.slice(0, 3)
  }

  if (!hasError) questions.push('报错的原文或错误码是什么？可以直接截图发我。')
  if (!/生产|线上|测试|预发|灰度|prod|staging|test/.test(text)) {
    questions.push('是在生产环境还是测试环境？')
  }
  if (!/刚才|今天|昨天|早上|下午|\d+\s*(点|时|分钟|小时)|\d{1,2}:\d{2}/.test(text)) {
    questions.push('大概什么时候开始的？现在还在发生吗？')
  }
  if (!/所有|全部|部分|只有|几个|一个|全部用户|个用户/.test(text)) {
    questions.push('影响范围有多大，是所有用户还是个别账号？')
  }
  return questions.slice(0, 3)
}

/** Require a known role. */
function requireRole(role) {
  if (!ROLES.has(role)) {
    throw new Error(`dsh-kb: role must be "customer-service" or "ops", got ${JSON.stringify(role)}`)
  }
}

/** Treat a blank config value as "use the default". */
function blankToUndefined(value) {
  return typeof value === 'string' && value.trim() === '' ? undefined : value
}

/** Require a non-empty absolute path. */
function requireAbsolute(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`dsh-kb: config.${field} must be a non-empty string`)
  }
  if (!path.isAbsolute(value)) throw new Error(`dsh-kb: config.${field} must be absolute`)
  return value
}
