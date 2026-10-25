/**
 * `kb_search` / `kb_get` / `kb_propose`: the model-facing knowledge-base tools.
 *
 * Mount this in a preset with a `role`. Both roles share the ranking rules and
 * the shared entry directory; `ops` additionally reads the internal runbook
 * directory (`ops-kb/`) and may propose internal entries.
 *
 * @module @local/dsh-kb/tools
 */

import { stringList } from './kb.js'

/** Cordis function-plugin name. */
export const name = 'kb-tools'

/** Host services required to register the tools. */
export const inject = ['tools']

/**
 * Register the knowledge-base tools on the calling composition.
 *
 * @param ctx - context carrying the tool registry and the `kbStore` service.
 * @param config - `role` selects the read/write permission set.
 */
export function apply(ctx, config) {
  const role = config?.role
  if (role !== 'customer-service' && role !== 'ops') {
    throw new Error('dsh-kb/tools: config.role must be "customer-service" or "ops"')
  }
  ctx.tools.register(searchTool(ctx, role))
  ctx.tools.register(getTool(ctx, role))
  ctx.tools.register(proposeTool(ctx, role))
}

/**
 * Resolve the store lazily so a missing host row produces an actionable error
 * at call time instead of a silently inactive tool.
 *
 * @param ctx - plugin context.
 * @returns the knowledge-base service.
 */
function storeOf(ctx) {
  const store = ctx.get?.('kbStore')
  if (store === undefined || store === null) {
    throw new Error('知识库服务未加载：@local/dsh-kb 的 kb-store 没有挂到当前组合上。')
  }
  return store
}

/**
 * Build the `kb_search` definition.
 *
 * @param ctx - plugin context.
 * @param {string} role - caller role.
 * @returns {object} tool definition.
 */
function searchTool(ctx, role) {
  return {
    name: 'kb_search',
    description: role === 'ops'
      ? 'Search the incident knowledge base AND the internal ops runbooks before touching the cluster. '
        + 'Match on error text, service, and environment. The result carries a verdict: '
        + 'direct = strong, unambiguous evidence; reference = related but needs verification; miss = nothing credible. '
        + 'Treat reference as a hypothesis, and treat miss as "ask, do not generate". '
        + 'Call kb_get with a hit id to read the full resolution. Entries with source=internal are internal runbooks.'
      : 'Search the historical incident knowledge base before answering a customer. '
        + 'Match on error text, service, and environment. The result carries a verdict: '
        + 'direct = answer from the entry; reference = hint only, say what still needs checking; '
        + 'miss = no credible entry, so ask the customer for detail instead of inventing a fix. '
        + 'When verdict is miss, ask the questions in `clarify` — do not propose a solution. '
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
          verdict: {
            type: 'string',
            enum: ['direct', 'reference', 'miss'],
            description: 'Confidence tier: direct = answer from the entry, reference = hint only, miss = ask for detail.',
          },
          confidence: { type: 'number' },
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
                source: { type: 'string' },
                score: { type: 'number' },
                chunk: { type: 'string' },
                occurrences: { type: 'integer' },
                services: { type: 'array', items: { type: 'string' } },
                environments: { type: 'array', items: { type: 'string' } },
                snippet: { type: 'string' },
              },
              required: ['id', 'title', 'status', 'audience', 'source', 'score', 'chunk', 'services', 'environments', 'snippet'],
            },
          },
          total: { type: 'integer' },
          clarify: { type: 'array', items: { type: 'string' } },
          hint: { type: 'string' },
        },
        required: ['verdict', 'hits', 'total'],
      },
      render: (_args, value) => {
        const lines = [`verdict=${value.verdict} confidence=${Number(value.confidence ?? 0).toFixed(2)}`]
        lines.push(value.hits.length === 0
          ? 'No knowledge-base entry matched.'
          : value.hits
            .map(hit => `[${hit.id}] ${hit.title} (score ${hit.score}, ${hit.status}, audience=${hit.audience}, `
              + `source=${hit.source}, matched_in=${hit.chunk}${hit.occurrences > 0 ? `, seen ${hit.occurrences}x` : ''})\n${hit.snippet}`)
            .join('\n\n'))
        if (Array.isArray(value.clarify) && value.clarify.length > 0) {
          lines.push(`Ask before answering:\n${value.clarify.map(question => `- ${question}`).join('\n')}`)
        }
        if (value.hint !== undefined) lines.push(value.hint)
        return [{ type: 'text', text: lines.join('\n\n') }]
      },
    },
    async execute(args) {
      const query = typeof args?.query === 'string' ? args.query.trim() : ''
      if (query === '') throw new Error('kb_search: query must be a non-empty string')
      const result = await storeOf(ctx).search({
        query,
        service: typeof args?.service === 'string' ? args.service : undefined,
        environment: typeof args?.environment === 'string' ? args.environment : undefined,
        limit: Number(args?.limit ?? 5),
      }, role)
      const hint = result.verdict === 'direct'
        ? 'Strong evidence. Verify services and environments, then answer from the entry.'
        : result.verdict === 'reference'
          ? 'Related but not conclusive: present it as a possibility and say what still needs checking.'
          : 'No credible entry: ask the customer the clarify questions. Do not invent a fix.'
      return { ...result, hint }
    },
  }
}

/**
 * Build the `kb_get` definition.
 *
 * @param ctx - plugin context.
 * @param {string} role - caller role; `customer-service` never receives internal steps.
 * @returns {object} tool definition.
 */
function getTool(ctx, role) {
  return {
    name: 'kb_get',
    description: role === 'ops'
      ? 'Read one complete knowledge-base entry by id, including root cause, resolution steps, verification, and the raw internal runbook when source=internal.'
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
      return storeOf(ctx).get(id, role)
    },
  }
}

/**
 * Build the `kb_propose` definition.
 *
 * @param ctx - plugin context.
 * @param {string} role - caller role; only `ops` may propose internal entries.
 * @returns {object} tool definition.
 */
function proposeTool(ctx, role) {
  const audiences = role === 'ops' ? ['customer', 'ops', 'internal'] : ['customer', 'ops']
  return {
    name: 'kb_propose',
    description:
      'Save a new incident as a CANDIDATE knowledge entry once the fix is verified. '
      + 'Candidates are never returned by kb_search until a human reviews and moves them into the verified set. '
      + 'If an existing entry already covers the same error signature, the call is absorbed into that entry '
      + 'and only its recurrence count goes up — report that instead of claiming a new entry was saved. '
      + 'Never propose an unconfirmed guess.'
      + (role === 'ops'
        ? ' Use audience=internal for an internal runbook that must stay invisible to customer service.'
        : ''),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        title: { type: 'string', description: 'Short, searchable title, e.g. "payment-service 5xx: upstream timeout".' },
        symptom: { type: 'string', description: 'What was observed, in one or two sentences.' },
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
        tags: { type: 'array', items: { type: 'string' }, description: 'Extra search keywords.' },
        audience: {
          type: 'string',
          enum: audiences,
          description: 'customer = answerable by support directly; ops = needs the operations team; internal = ops-only runbook.',
        },
        customerReply: { type: 'string', description: 'What support may say to the customer, verbatim. Never contains internal infrastructure detail.' },
        incidentId: { type: 'string', description: 'Incident id this entry came from, when there is one.' },
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
          duplicateOf: { type: 'string' },
          occurrences: { type: 'integer' },
        },
        required: ['saved', 'id', 'path'],
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.saved === false
          ? `Not saved as a new candidate: the same error signature is already covered by ${value.id} `
            + `(now seen ${value.occurrences ?? 0} times). Do not tell the customer a new entry was created.`
          : `Candidate saved as ${value.id} at ${value.path}. It stays out of search results until a human verifies it.`,
      }],
    },
    async execute(args) {
      const title = requireText(args?.title, 'title')
      const symptom = requireText(args?.symptom, 'symptom')
      const resolution = requireText(args?.resolution, 'resolution')
      if (args?.audience === 'internal' && role !== 'ops') {
        throw new Error('kb_propose: audience=internal is reserved for the operations role')
      }
      const audience = audiences.includes(args?.audience) ? args.audience : 'customer'
      return storeOf(ctx).propose({
        title,
        symptom,
        rootCause: typeof args?.rootCause === 'string' ? args.rootCause : '',
        resolution,
        verification: typeof args?.verification === 'string' ? args.verification : '',
        errorSignatures: stringList(args?.errorSignatures),
        services: stringList(args?.services),
        environments: stringList(args?.environments),
        tags: stringList(args?.tags),
        audience,
        customerReply: typeof args?.customerReply === 'string' ? args.customerReply : '',
        incidentId: typeof args?.incidentId === 'string' ? args.incidentId : '',
        source: role,
      })
    },
  }
}

/** Require a non-empty string argument. */
function requireText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`kb_propose: ${field} must be a non-empty string`)
  }
  return value.trim()
}
