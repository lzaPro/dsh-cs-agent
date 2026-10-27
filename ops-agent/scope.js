/**
 * Account scope: 一个工单只该看它自己那个客户的东西。
 *
 * 问题是这么来的：`ops_handoff` 的 `account` 参数原本只是写进任务卡的一行文字，
 * 运维 agent 看到「账号信息：acme」之后，用什么命名空间、查哪台机器，全靠 Prompt
 * 里的软约束。服务端没有任何东西把「这张工单属于 acme」和「工具调用只能碰 acme」
 * 连起来。所以 A 客户的工单完全可以查 B 客户的 pod 日志，只要模型顺手写了
 * 另一个 namespace——或者更常见：它根本没写 namespace，`kubectl get pods -A`
 * 直接扫全集群。
 *
 * 这里做的就是把那条软约束变成硬约束：工单派发时把 `account` 解析成一个作用域
 * 对象，挂到运维会话上；cluster 工具每次调用都拿这个作用域去收窄命名空间
 * 和 context。不认识的账号、没写账号、作用域为空，都按"拒绝"处理——失败要
 * 朝安全那边倒。
 *
 * @module @local/dsh-ops-agent/scope
 */

/** 没有配置任何账号映射时的空结果。 */
export const EMPTY_ACCOUNTS = { configured: false, entries: [] }

/**
 * 解析配置里的账号表。
 *
 * 形状：
 *
 * ```yaml
 * accounts:
 *   acme:
 *     namespaces: [acme-prod, acme-staging]
 *     contexts: [prod]
 *     aliases: ["Acme Inc", "acme.com"]
 * ```
 *
 * @param raw - `config.accounts`，可以是 undefined。
 * @returns {{configured: boolean, entries: Array<{id: string, namespaces?: string[],
 *   contexts?: string[], aliases: string[]}>}} 规范化后的账号表。
 */
export function parseAccounts(raw) {
  if (raw === undefined || raw === null) return { ...EMPTY_ACCOUNTS, entries: [] }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('ops-scope: accounts 必须是对象（账号 id -> 该账号的限制）')
  }
  const entries = []
  for (const [id, value] of Object.entries(raw)) {
    const account = String(id).trim()
    if (account === '') throw new Error('ops-scope: accounts 里不能有空账号 id')
    if (value !== null && typeof value !== 'object') {
      throw new Error(`ops-scope: accounts.${account} 必须是对象`)
    }
    const namespaces = stringList(value?.namespaces)
    const contexts = stringList(value?.contexts)
    const aliases = stringList(value?.aliases)
    entries.push({
      id: account,
      namespaces: namespaces.length === 0 ? undefined : namespaces,
      contexts: contexts.length === 0 ? undefined : contexts,
      aliases,
    })
  }
  return { configured: entries.length > 0, entries }
}

/**
 * 把工单里的 `account` 解析成作用域。
 *
 * 四种结果，调用方必须都处理：
 *
 * - `configured === false`：没配账号表，不做限制（保持重构前行为）。
 * - `unbound === true`：配了账号表但工单没写账号，拒绝取证。
 * - `unknown === true`：写了账号但账号表里没有，拒绝取证。
 * - 正常：拿到 `namespaces`/`contexts`（可能是 undefined，表示该账号不额外限制）。
 *
 * @param accounts - `parseAccounts()` 的结果。
 * @param raw - 工单里的 `account` 原文。
 * @returns {{configured: boolean, account: string, namespaces?: string[], contexts?: string[],
 *   unbound: boolean, unknown: boolean}} 作用域。
 */
export function scopeFor(accounts, raw) {
  const account = typeof raw === 'string' ? raw.trim() : ''
  if (accounts === undefined || accounts.configured !== true) {
    return { configured: false, account, unbound: false, unknown: false }
  }
  if (account === '') {
    return { configured: true, account: '', unbound: true, unknown: false }
  }
  const folded = account.toLowerCase()
  const hit = accounts.entries.find(entry =>
    entry.id.toLowerCase() === folded
    || entry.aliases.some(alias => alias.toLowerCase() === folded))
  if (hit === undefined) {
    return { configured: true, account, unbound: false, unknown: true }
  }
  return {
    configured: true,
    account: hit.id,
    namespaces: hit.namespaces,
    contexts: hit.contexts,
    unbound: false,
    unknown: false,
  }
}

/**
 * 该作用域实际能碰的命名空间。
 *
 * 取交集而不是并集：全局白名单是"这台机器允许碰什么"，账号表是"这个客户允许碰什么"，
 * 两边都过才算过。全局写 `*` 时，仍然以账号表为准——`*` 表示"运维有权限看很多客户"，
 * 不表示"每个工单都能看所有客户"。
 *
 * @param globalNamespaces - `config.namespaces`（可能含 `*`；空数组表示全拒）。
 * @param scope - `scopeFor()` 的结果。
 * @returns {{namespaces: string[], allowAll: boolean}} 有效白名单。
 */
export function effectiveNamespaces(globalNamespaces, scope) {
  const global = Array.isArray(globalNamespaces) ? globalNamespaces.map(String) : []
  const globalAll = global.includes('*')
  const scoped = scope?.namespaces
  if (Array.isArray(scoped)) {
    return {
      namespaces: globalAll ? [...scoped] : scoped.filter(name => global.includes(name)),
      allowAll: false,
    }
  }
  return { namespaces: global.filter(name => name !== '*'), allowAll: globalAll }
}

/**
 * 该作用域实际能用的 context。规则与命名空间一致。
 *
 * @param globalContexts - `config.contexts`（空 = 不限制）。
 * @param scope - `scopeFor()` 的结果。
 * @returns {string[]} 有效 context 白名单；空数组表示不限制。
 */
export function effectiveContexts(globalContexts, scope) {
  const global = Array.isArray(globalContexts) ? globalContexts.map(String) : []
  const scoped = scope?.contexts
  if (Array.isArray(scoped)) {
    return global.length === 0 ? [...scoped] : scoped.filter(name => global.includes(name))
  }
  return global
}

/**
 * 把作用域翻译成一句人话，供 `ops_env` 与错误提示使用。
 *
 * @param scope - `scopeFor()` 的结果。
 * @returns {string} 例如 `acme（命名空间：acme-prod）` 或 `未绑定账号（取证会被拒绝）`。
 */
export function describeScope(scope) {
  if (scope === undefined || scope.configured !== true) return '未配置账号映射（不做限制）'
  if (scope.unbound === true) return '工单未写账号（取证会被拒绝）'
  if (scope.unknown === true) return `账号「${scope.account}」不在账号表里（取证会被拒绝）`
  const namespaces = Array.isArray(scope.namespaces) ? scope.namespaces.join(', ') : '未额外限制'
  return `${scope.account}（命名空间：${namespaces}）`
}

/** 字符串数组，滤掉空值。 */
function stringList(value) {
  return Array.isArray(value) ? value.map(item => String(item)).filter(item => item !== '') : []
}
