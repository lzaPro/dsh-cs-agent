/**
 * PromQL 的账号作用域检查。
 *
 * `ops_metrics` 接受任意 PromQL，这本身就是一个出口：`sum(rate(http_requests_total[5m]))`
 * 会跨所有 namespace 聚合，`{namespace="globex-prod"}` 更是直接读别人的指标。
 * k8s 工具靠"必须显式写 namespace"堵住了扫全集群（见 cluster.js 的 checkNamespace），
 * 指标这边需要同一堵墙，否则作用域只是个摆设——客服把工单派给 acme，
 * 运维用一条聚合查询就能看见 globex 的错误率。
 *
 * 这里不尝试解析完整 PromQL（那是个无底洞），只做一件事：**找出 namespace 标签匹配器，
 * 判断它是否被限定在允许的命名空间里**。规则刻意保守——看不懂就当越界拒绝。
 *
 * @module @local/dsh-ops-agent/promql
 */

/** 匹配 namespace 标签的 `标签名 运算符 "值"` 形式。 */
const MATCHER = /(?:^|[\s{,(])namespace\s*(=~|!~|!=|=)\s*"((?:[^"\\]|\\.)*)"/g

/**
 * 找出查询里所有 namespace 标签匹配器。
 *
 * @param promql - the query text.
 * @returns matchers in source order.
 */
export function namespaceMatchers(promql) {
  const text = typeof promql === 'string' ? promql : ''
  const found = []
  MATCHER.lastIndex = 0
  let match = MATCHER.exec(text)
  while (match !== null) {
    found.push({ op: match[1], value: match[2] })
    match = MATCHER.exec(text)
  }
  return found
}

/**
 * 把一个 `=~` 的正则值展开成字面量列表。
 *
 * 只接受两种形态：纯字面量（`"acme-prod"`），以及用 `|` 枚举的字面量（`"acme-prod|acme-staging"`，
 * 可带 `^`/`$` 锚点）。出现任何其它正则元字符一律返回 undefined —— 因为无法证明
 * `"acme-.*"` 不会匹配到 `acme-secret-project`。要枚举就老实枚举，这正是白名单的意义。
 *
 * @param value - the raw string inside the matcher.
 * @returns the alternatives, or undefined when the pattern is not a plain enumeration.
 */
export function literalAlternatives(value) {
  let text = String(value)
  if (text.startsWith('^')) text = text.slice(1)
  if (text.endsWith('$')) text = text.slice(0, -1)
  if (text === '') return undefined
  const parts = text.split('|')
  const literals = []
  for (const part of parts) {
    if (part === '') return undefined
    // 正则元字符；`. * + ? [ ] ( ) { } ^ $ \` 出现在枚举里就意味着这不是枚举。
    if (/[.*+?[\](){}^$\\]/.test(part)) return undefined
    literals.push(part)
  }
  return literals
}

/**
 * 校验一条 PromQL 是否只落在工单所属账号的命名空间里。
 *
 * @param promql - the query text.
 * @param scope - `scopeFor()` 的结果；未配置时为 undefined。
 * @returns `{namespaces}` — 查询点的命名空间。
 * @throws Error when the query cannot be bounded to the account.
 */
export function checkMetricsScope(promql, scope) {
  // 没配账号表 = 这套部署不分客户，行为与重构前一致。
  if (scope === undefined || scope.configured !== true) return { namespaces: [] }

  if (scope.unbound === true) {
    throw new Error('ops_metrics: 这张工单没有账号信息，无法确定该看哪个客户的指标；让客服在 ops_handoff 里补 account 后再查，不要跨客户猜')
  }
  if (scope.unknown === true) {
    throw new Error(`ops_metrics: 账号「${scope.account ?? ''}」不在账号映射表里（config.accounts），拒绝查指标；让管理员补这个账号的命名空间，或让客服核对账号`)
  }

  const allowed = Array.isArray(scope.namespaces) ? scope.namespaces : []
  if (allowed.length === 0) {
    throw new Error('ops_metrics: 这个账号没有配置命名空间白名单（config.accounts.<account>.namespaces），指标查询无法限定范围，拒绝执行')
  }

  // 聚合查询（sum by (...) / rate(...)）没有 namespace 匹配器时会跨全部命名空间，
  // 所以这里与 k8s 那边同一条规则：作用域生效时必须显式写出来。
  const matchers = namespaceMatchers(promql)
  if (matchers.length === 0) {
    throw new Error('ops_metrics: 这张工单绑定了账号作用域，PromQL 必须显式写 namespace 匹配器（例如 namespace="acme-prod"）；不写会跨客户聚合，拒绝执行')
  }

  const used = []
  for (const matcher of matchers) {
    if (matcher.op === '!=' || matcher.op === '!~') {
      throw new Error(`ops_metrics: 作用域生效时不能用排除式 namespace 匹配（${matcher.op}"${matcher.value}"）：排除掉一个客户，剩下的仍然包含所有别的客户`)
    }
    if (matcher.op === '=') {
      if (!allowed.includes(matcher.value)) {
        throw new Error(`ops_metrics: namespace "${matcher.value}" 不属于本工单账号；这个账号只有：${allowed.join(', ')}`)
      }
      used.push(matcher.value)
      continue
    }
    // =~
    const literals = literalAlternatives(matcher.value)
    if (literals === undefined) {
      throw new Error(`ops_metrics: namespace 正则是通配（=~"${matcher.value}"），无法证明它不会匹配到别的客户；请改成精确值或 "a|b" 这样的枚举`)
    }
    for (const literal of literals) {
      if (!allowed.includes(literal)) {
        throw new Error(`ops_metrics: namespace 正则里的 "${literal}" 不属于本工单账号；这个账号只有：${allowed.join(', ')}`)
      }
    }
    used.push(...literals)
  }

  return { namespaces: [...new Set(used)] }
}
