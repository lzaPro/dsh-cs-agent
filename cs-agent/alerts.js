// 告警：把"网关现在不能干活"这件事推出去，而不是等人来查 /health。
//
// 为什么单独一个模块：判断"要不要报警"是一组纯函数（这次该报吗、之前报过吗、
// 恢复了吗），发送是 IO。把判断抽出来才能用一条条断言覆盖各种跳变——直接写在
// 网关定时器里，只能靠"跑一遍看看有没有发"来验，边界条件全测不到。
//
// 一条告警的生命周期：
//   健康 → 不健康：fire（带首次发生时间）
//   持续不健康：每 repeatMs 再提醒一次（不是每轮都刷，否则手机一直响）
//   不健康 → 健康：recover（明确说"恢复了"，否则没人知道能不能下班）

/** 默认节拍：每分钟查一次，同一问题每小时重复提醒一次。 */
export const DEFAULT_ALERTS = {
  intervalMs: 60_000,
  repeatMs: 3_600_000,
  // 刚启动的十几秒里数据库/队列可能还在握手，这段先不报，避免重启就刷屏。
  graceMs: 15_000,
}

/**
 * 解析告警配置。
 *
 * 必须同时有 webhook 和收件人：只配 webhook 时不知道该发给谁，只配收件人时没有
 * 发送通道。缺一个就整条告警链关闭（而不是发到某个默认地址）——静默比发错安全。
 *
 * @param config - 网关配置里的 `alertWebhook` / `alertTo` / `alertIntervalMs` / `alertRepeatMs` / `alertGraceMs`。
 * @returns 归一化后的告警配置。
 */
export function parseAlertConfig(config) {
  const webhook = typeof config?.alertWebhook === 'string' && config.alertWebhook !== ''
    ? config.alertWebhook
    : undefined
  const to = typeof config?.alertTo === 'string' && config.alertTo !== ''
    ? config.alertTo
    : undefined
  const positive = (value, fallback) => (Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback)
  const nonNegative = (value, fallback) => (Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback)
  return {
    enabled: webhook !== undefined && to !== undefined,
    webhook,
    to,
    intervalMs: positive(config?.alertIntervalMs, DEFAULT_ALERTS.intervalMs),
    // repeatMs 允许 0：表示每轮都重报。测试和“一直盯着”的场景都用得上。
    repeatMs: nonNegative(config?.alertRepeatMs, DEFAULT_ALERTS.repeatMs),
    graceMs: nonNegative(config?.alertGraceMs, DEFAULT_ALERTS.graceMs),
    // 只配一个的时候留给启动日志说清楚缺什么。
    missing: webhook === undefined
      ? 'alertWebhook'
      : (to === undefined ? 'alertTo' : undefined),
  }
}

/** 哪些检查项挂了属于"不能干活"，哪些属于"要人看一眼"。 */
const CRITICAL_CHECKS = new Set(['lease', 'database'])

/**
 * 把一份 health 报告翻成一组问题。
 *
 * 每条问题有稳定的 `key`：稳定是因为它同时用于去重、重复提醒计时和恢复通知。
 * 用检查项名字（而不是消息文本）当 key，文本变了也不会被当成新故障重新报一遍。
 *
 * @param health - `health()` 的返回值。
 * @returns {{key: string, severity: string, title: string, detail: string, action: string}[]}
 */
export function collectIssues(health) {
  const issues = []
  for (const check of health?.checks ?? []) {
    if (check.ok === true) continue
    issues.push({
      key: `check:${check.name}`,
      severity: CRITICAL_CHECKS.has(check.name) ? 'critical' : 'warning',
      title: `${check.name} 不健康`,
      detail: String(check.detail ?? ''),
      action: check.name === 'lease'
        ? '这个实例的写入租约被别的实例接管了，它已经不能再写。确认另一个实例正常后重启本实例。'
        : (check.name === 'database'
          ? '数据库连不上，会话与队列都写不进。检查 ./scripts/db-up.sh 与 DSH_DB_URL。'
          : '队列读写失败，客户消息可能堆积。看日志里的具体错误。'),
    })
  }

  // 死信不算"网关挂了"（health.ok 仍为 true），但必须有人处理：它们是处理过又
  // 放弃的客户消息或回复，客户在等。
  for (const queueName of ['inbox', 'outbox']) {
    const stats = health?.queues?.[queueName]
    const dead = Number(stats?.dead ?? 0)
    if (dead <= 0) continue
    issues.push({
      key: `dead:${queueName}`,
      severity: 'warning',
      title: `${queueName} 有 ${dead} 条死信`,
      detail: `${dead} 条消息重试用尽被标为 dead`,
      action: '面板「运维 → 死信」可以看正文并重放；重放前先确认对方还没收到。',
    })
  }

  // 自动清理失败不会立刻造成数据问题，但"以为在删其实没删"是合规风险。
  const retention = health?.retention
  if (typeof retention?.lastError === 'string' && retention.lastError !== '') {
    issues.push({
      key: 'retention',
      severity: 'warning',
      title: '自动清理失败',
      detail: retention.lastError,
      action: `数据保留策略没有生效（上次失败于 ${String(retention.lastRunAt ?? '未知')}）。检查数据库与权限。`,
    })
  }

  return issues
}

/**
 * 决定这一轮该发什么。
 *
 * 纯函数：给同样的 (issues, state, now) 一定得到同样的结果，所以每条边界都能断言。
 *
 * @param options - `issues`、上一次的 `state`、`now`、`repeatMs`。
 * @returns `{fire, recover, state, active}`。
 */
export function evaluateAlerts({ issues, state, now = Date.now(), repeatMs = DEFAULT_ALERTS.repeatMs }) {
  const previous = state ?? new Map()
  const next = new Map()
  const fire = []
  const recover = []

  for (const issue of issues) {
    const seen = previous.get(issue.key)
    if (seen === undefined) {
      // 第一次出现：立刻报，并记住时间用于下一轮重复提醒的计时。
      next.set(issue.key, { since: now, lastSentAt: now, severity: issue.severity, title: issue.title, detail: issue.detail })
      fire.push({ ...issue, reason: 'new', since: now })
      continue
    }
    if (now - seen.lastSentAt >= repeatMs) {
      // 还没好：隔一段时间再提醒一次。带上再次发生的轮次，收件人能看到"这是老问题"。
      next.set(issue.key, { ...seen, lastSentAt: now, severity: issue.severity, title: issue.title, detail: issue.detail })
      fire.push({ ...issue, reason: 'repeat', since: seen.since })
      continue
    }
    next.set(issue.key, { ...seen, severity: issue.severity, title: issue.title, detail: issue.detail })
  }

  for (const [key, seen] of previous) {
    if (next.has(key)) continue
    // 上次报过、这次没了：明确说恢复，否则值班的人不知道能不能停下。
    recover.push({ key, title: seen.title, severity: seen.severity, since: seen.since, lastedMs: now - seen.since })
  }

  return { fire, recover, state: next, active: [...next.keys()] }
}

/**
 * 把一轮变化排成一段人话。
 *
 * 一条消息里同时说清"新出的"和"好了的"：分两条发容易只看到一条。
 *
 * @param fire - 本轮要报的问题。
 * @param recover - 本轮恢复的问题。
 * @param options - `route`、`now`。
 * @returns 消息文本；没有变化时返回空串。
 */
export function formatAlert(fire, recover, options = {}) {
  if (fire.length === 0 && recover.length === 0) return ''
  const route = options.route ?? '/channel'
  const stamp = new Date(options.now ?? Date.now()).toISOString()
  const lines = []

  const critical = fire.filter(item => item.severity === 'critical')
  if (critical.length > 0) {
    lines.push(`【严重】客服网关不能干活（${route}）`)
  } else if (fire.length > 0) {
    lines.push(`【注意】客服网关有问题（${route}）`)
  } else {
    lines.push(`【恢复】客服网关恢复正常（${route}）`)
  }

  for (const item of fire) {
    const tag = item.reason === 'repeat' ? '持续未恢复' : '新出现'
    lines.push(`- ${item.title}（${tag}）: ${item.detail}`)
    if (item.action !== '') lines.push(`  → ${item.action}`)
  }
  for (const item of recover) {
    lines.push(`- ${item.title} 已恢复（持续 ${Math.round(item.lastedMs / 1000)} 秒）`)
  }
  lines.push(`时间：${stamp}`)
  return lines.join('\n')
}

/**
 * 建一个发送器：持有告警状态、负责把消息发出去、留一份最近记录给面板查。
 *
 * 发送失败只 warn 不重试。告警是有时效的，"十分钟后再补发一条旧的"没有意义，
 * 而且会让人误以为问题还在。下一轮自检会重新判断，真没恢复会再报。
 *
 * @param options - `config`（parseAlertConfig 的返回值）、`fetchImpl`、`logger`、`route`、`history`。
 * @returns 发送器。
 */
export function createAlerter(options = {}) {
  const config = options.config ?? parseAlertConfig(undefined)
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const logger = options.logger
  const route = options.route ?? '/channel'
  const historyLimit = Number.isFinite(options.historyLimit) ? options.historyLimit : 50

  let state = new Map()
  const history = []
  let lastSentAt
  let lastError

  /**
   * 处理一份 health 报告。
   *
   * @param health - `health()` 的返回值。
   * @param options - `now`。
   * @returns `{fired, recovered, active, text, sent}`。
   */
  async function check(health, at = {}) {
    const now = at.now ?? Date.now()
    const issues = collectIssues(health)
    const result = evaluateAlerts({ issues, state, now, repeatMs: config.repeatMs })
    state = result.state
    const text = formatAlert(result.fire, result.recover, { route, now })
    const summary = {
      fired: result.fire.length,
      recovered: result.recover.length,
      active: result.active,
      text,
      sent: false,
    }
    if (text === '') return summary
    if (config.enabled !== true) {
      // 没配发送通道也留记录：面板上能看到"本来要报什么"，配好之后能立刻用上。
      history.unshift({ at: new Date(now).toISOString(), text, sent: false, reason: 'alerts are not configured' })
      trim()
      return summary
    }
    try {
      const response = await fetchImpl(config.webhook, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // 与运维派单器的通知同一个载荷形状，适配器 /reply 认这个。
        body: JSON.stringify({ senderId: config.to, groupId: null, text, source: 'cs-agent-alerts' }),
        signal: AbortSignal.timeout(10_000),
      })
      // 适配器返回 503 时网络是通的，但消息没送出去。只看"没抛异常"会把
      // 发送失败记成成功，下一轮就不再重试了。
      if (response !== undefined && response.ok === false) {
        throw new Error(`HTTP ${response.status}`)
      }
      summary.sent = true
      lastSentAt = now
      lastError = undefined
      history.unshift({ at: new Date(now).toISOString(), text, sent: true })
    } catch (error) {
      lastError = error.message
      logger?.warn?.(`channel-gateway: alert delivery failed: ${error.message}`)
      history.unshift({ at: new Date(now).toISOString(), text, sent: false, reason: error.message })
    }
    trim()
    return summary
  }

  function trim() {
    while (history.length > historyLimit) history.pop()
  }

  return {
    config,
    /** 发送器是否真的会发（webhook 与收件人都配了）。 */
    get enabled() { return config.enabled === true },
    /** 当前未恢复的问题 key 列表。 */
    get active() { return [...state.keys()] },
    /** 最近一次成功发送的时间戳。 */
    get lastSentAt() { return lastSentAt },
    /** 最近一次发送失败的原因。 */
    get lastError() { return lastError },
    /** 最近的告警记录（最新的在前），给面板与 `/alerts` 用。 */
    list: (limit = historyLimit) => history.slice(0, limit),
    /** 状态摘要，给 `/health` 与 `/alerts` 用。 */
    status: () => ({
      enabled: config.enabled === true,
      configured: {
        webhook: config.webhook !== undefined,
        to: config.to !== undefined,
      },
      missing: config.missing ?? null,
      intervalMs: config.intervalMs,
      repeatMs: config.repeatMs,
      graceMs: config.graceMs,
      active: [...state.keys()],
      lastSentAt: lastSentAt === undefined ? null : new Date(lastSentAt).toISOString(),
      lastError: lastError ?? null,
    }),
    check,
    /** 重置内部状态（测试与"运维看过之后想重新开始"用）。 */
    reset: () => { state = new Map(); history.length = 0; lastSentAt = undefined; lastError = undefined },
  }
}
