/**
 * `ops_metrics`: read-only Prometheus / Grafana queries.
 *
 * Only two endpoints are ever called, both on the configured base URL, so the
 * model cannot turn this tool into a generic HTTP client. A time window is
 * mandatory for range queries, which keeps a diagnosis from turning into a
 * twelve-month scan.
 *
 * @module @local/dsh-ops-agent/metrics
 */
import { checkMetricsScope } from './promql.js'

/** Cordis function-plugin name. */
export const name = 'ops-metrics-tool'

/** Host services required to register the tool. */
export const inject = ['tools']

/** Largest query text accepted. */
const MAX_QUERY = 2000

/** Largest range accepted, in seconds (24h). */
const MAX_RANGE_SECONDS = 24 * 60 * 60

/**
 * Register `ops_metrics`.
 *
 * @param ctx - context carrying the tool registry.
 * @param config - `prometheusUrl`, `grafanaUrl`, `grafanaToken`, `datasourceUid`, `timeoutMs`.
 */
export function apply(ctx, config) {
  // 作用域在调用时现问：派单器可能晚于本插件挂载，缓存下来会一直是 undefined。
  const scopeOf = sessionId => ctx.get?.('opsDispatch')?.scopeFor?.(sessionId)
  const metrics = createMetrics(config, { scopeOf })
  ctx.tools.register(tool(metrics))
}

/**
 * Build the metrics accessor. Exported for tests.
 *
 * @param config - deployment configuration.
 * @returns accessor with `query` and `status`.
 */
export function createMetrics(config, options = {}) {
  const scopeOf = typeof options.scopeOf === 'function' ? options.scopeOf : () => undefined
  const prometheusUrl = normalizeBase(config?.prometheusUrl)
  const grafanaUrl = normalizeBase(config?.grafanaUrl)
  const datasourceUid = typeof config?.datasourceUid === 'string' && config.datasourceUid.trim() !== ''
    ? config.datasourceUid.trim()
    : ''
  const token = typeof config?.grafanaToken === 'string' && config.grafanaToken.trim() !== ''
    ? config.grafanaToken.trim()
    : process.env.GRAFANA_TOKEN ?? ''
  const timeoutMs = Number.isSafeInteger(config?.timeoutMs) && config.timeoutMs > 0 ? config.timeoutMs : 20_000
  const fetchImpl = config?.fetch ?? fetch

  /** Where to send a metrics query, or undefined when nothing is configured. */
  function endpoint() {
    if (prometheusUrl !== undefined) return `${prometheusUrl}/api/v1`
    if (grafanaUrl !== undefined && datasourceUid !== '') {
      return `${grafanaUrl}/api/datasources/proxy/uid/${encodeURIComponent(datasourceUid)}/api/v1`
    }
    return undefined
  }

  /** What the agent should know before calling. */
  function status() {
    const base = endpoint()
    return {
      configured: base !== undefined,
      endpoint: base ?? '',
      hint: base !== undefined
        ? 'Prometheus 兼容接口可用：用 PromQL 查询，range 查询必须带时间窗。'
        : '没有配置指标数据源（prometheusUrl 或 grafanaUrl + datasourceUid）。不要假装看过指标：把指标缺口写进 evidence。',
    }
  }

  /** 本会话所属的账号作用域（没有就是 undefined，不限制）。 */
  function scopeFor(sessionId) {
    return scopeOf(sessionId)
  }

  /** Run one query. */
  async function query(args, scope) {
    const base = endpoint()
    if (base === undefined) {
      return { ok: false, configured: false, error: status().hint, data: null }
    }
    const promql = typeof args?.query === 'string' ? args.query.trim() : ''
    if (promql === '') throw new Error('ops_metrics: query must be a non-empty string')
    if (promql.length > MAX_QUERY) throw new Error(`ops_metrics: query longer than ${MAX_QUERY} characters`)
    // 在发请求之前拦：先查了再过滤等于没过滤，数据已经出网了。
    checkMetricsScope(promql, scope)

    const minutes = Number(args?.minutes ?? 0)
    const rangeQuery = Number.isFinite(minutes) && minutes > 0
    const url = new URL(rangeQuery ? `${base}/query_range` : `${base}/query`)
    url.searchParams.set('query', promql)
    if (rangeQuery) {
      const seconds = Math.min(MAX_RANGE_SECONDS, Math.trunc(minutes * 60))
      const end = Math.trunc(Date.now() / 1000)
      url.searchParams.set('start', String(end - seconds))
      url.searchParams.set('end', String(end))
      url.searchParams.set('step', String(Math.max(15, Math.trunc(seconds / 120))))
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetchImpl(url, {
        method: 'GET',
        headers: token === '' ? {} : { authorization: `Bearer ${token}` },
        signal: controller.signal,
      })
      const text = await response.text()
      let body
      try {
        body = JSON.parse(text)
      } catch {
        body = undefined
      }
      if (!response.ok) {
        return {
          ok: false,
          configured: true,
          status: response.status,
          error: `metrics backend returned HTTP ${response.status}: ${text.slice(0, 300)}`,
          data: null,
        }
      }
      const series = body?.data?.result
      return {
        ok: true,
        configured: true,
        rangeQuery,
        series: Array.isArray(series) ? series.length : 0,
        data: capData(series ?? body?.data ?? null),
        raw: body?.data === undefined ? text.slice(0, 1000) : undefined,
      }
    } catch (error) {
      return {
        ok: false,
        configured: true,
        error: error?.name === 'AbortError' ? `查询超时（${timeoutMs}ms）` : String(error?.message ?? error),
        data: null,
      }
    } finally {
      clearTimeout(timer)
    }
  }

  return { query, status, endpoint, scopeFor }
}

/** `ops_metrics` definition. */
function tool(metrics) {
  const state = metrics.status()
  return {
    name: 'ops_metrics',
    description:
      'Read-only metrics query (PromQL) against the configured Prometheus/Grafana data source. '
      + 'Pass `minutes` for a range query; omit it for an instant value. '
      + 'Use it to confirm saturation, error rate, or restarts — never to guess.'
      + (state.configured ? '' : ' NOTE: no data source is configured in this deployment, so calls will return a configuration error.'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: 'PromQL expression, e.g. sum(rate(http_requests_total{code=~"5.."}[5m])) by (service).' },
        minutes: { type: 'integer', description: 'Range length in minutes (1-1440). Omit for an instant query.' },
        reason: { type: 'string', description: 'Why this query answers a question in the incident; one sentence.' },
      },
      required: ['query'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          configured: { type: 'boolean' },
          status: { type: 'integer' },
          rangeQuery: { type: 'boolean' },
          series: { type: 'integer' },
          error: { type: 'string' },
          data: { oneOf: [{ type: 'object' }, { type: 'array' }, { type: 'null' }] },
          raw: { type: 'string' },
        },
        required: ['ok', 'configured', 'data'],
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.ok
          ? `metrics ok · ${value.series ?? 0} series${value.rangeQuery === true ? ' (range)' : ''}\n${JSON.stringify(value.data, undefined, 2).slice(0, 6000)}`
          : `metrics unavailable: ${value.error ?? 'unknown error'}`,
      }],
    },
    async execute(args, exec) {
      return metrics.query(args, sessionScope(metrics, exec))
    },
  }
}

/**
 * 从工具执行上下文里取本会话的作用域。
 *
 * 没有 `exec`（模型在会话外被调用，或测试直接调工具）时返回 undefined ——
 * 与 k8s 工具保持一致：不限制，但也不会假装有作用域。
 *
 * @param metrics - the accessor.
 * @param exec - tool execution context.
 * @returns the account scope, or undefined.
 */
function sessionScope(metrics, exec) {
  const sessionId = exec?.agent?.session?.id
  return sessionId === undefined ? undefined : metrics.scopeFor(sessionId)
}

/** Normalize a base URL, rejecting anything that is not http(s). */
function normalizeBase(value) {
  if (typeof value !== 'string' || value.trim() === '') return undefined
  let url
  try {
    url = new URL(value.trim())
  } catch {
    throw new Error(`ops-metrics: 数据源地址不是合法 URL: ${value}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('ops-metrics: 数据源地址必须是 http(s)')
  }
  return url.toString().replace(/\/+$/, '')
}

/** Keep a bounded slice of series data. */
function capData(data) {
  if (data === null || data === undefined) return null
  const text = JSON.stringify(data)
  if (text.length <= 6000) return data
  if (Array.isArray(data)) return data.slice(0, 20)
  return { truncated: true, preview: text.slice(0, 6000) }
}
