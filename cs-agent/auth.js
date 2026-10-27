/**
 * 网关的访问控制。
 *
 * 重构前的状态是"要么全开、要么全锁"：`config.token` 一旦设置，连面板都打不开
 * （浏览器发不出 Authorization 头），不设置则 `POST /channel/delete`、
 * `POST /channel/config`（改 QQ 凭证）、`POST /channel/replay`、`POST /channel/retention`
 * （删客户数据）全部匿名可调。局域网里跑一台就等于把删库按钮挂在网上。
 *
 * 这里把访问分成三种角色：
 *
 * - `public`：`GET {route}/health`。编排系统/探针要能免凭证判断"能不能干活"，
 *   它不暴露客户数据（只有队列计数与版本）。
 * - `inbound`：`POST {route}`。平台适配器灌消息用。它有自己的令牌，因为适配器
 *   和运维面板不是同一拨人、不该共用一个凭证。
 * - `viewer`：全部读接口（面板、会话列表、历史、死信列表、审计、用量、保留期计划）。
 *   它的存在是因为"能看"和"能删"是两件事：值班的人要能查客户说了什么，但不该
 *   顺手能把会话删了、把死信重放了、把 QQ 凭证改了。
 * - `admin`：所有写接口（接管/交还、回复、删除、配置、重放、执行清除）。
 *
 * `viewer` 令牌是可选的：不配就没有这个角色（只有 admin 与 inbound 两档），
 * 行为与之前完全一样。
 *
 * 令牌来源优先级：`Authorization: Bearer` → `x-admin-token` / `x-inbound-token`
 * → `?token=` → 面板 cookie。面板 cookie 是为了让浏览器能用：`/panel?token=…`
 * 换一个 HttpOnly cookie 再跳转，之后浏览器自动带上。
 *
 * 没配任何令牌时保持重构前行为（全开），并在启动时警告一次——开发机方便，
 * 但日志里必须留痕迹，否则没人知道自己处于全开状态。
 */

import { createHash, timingSafeEqual } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'

/**
 * 面板 cookie 的名字与寿命。
 *
 * 只读令牌单独一个 cookie 名：同一个人可能同时拿着两个凭证，角色取决于用的是哪个，
 * 塞进一个 cookie 里就得把角色也编进去，反而更容易出错。
 */
export const DEFAULT_AUTH = {
  cookieName: 'cs_panel',
  viewerCookieName: 'cs_view',
  cookieSeconds: 12 * 60 * 60,
}

/**
 * 常数时间比较两个字符串。
 *
 * 先各自取 sha256 再比：`timingSafeEqual` 要求两个 Buffer 等长，直接比会按长度
 * 提前返回，等于把"令牌多长"泄漏给攻击者。哈希后长度固定。
 *
 * @param {string} left - 一侧。
 * @param {string} right - 另一侧。
 * @returns {boolean} 是否相同。
 */
export function constantTimeEqual(left, right) {
  const a = createHash('sha256').update(String(left)).digest()
  const b = createHash('sha256').update(String(right)).digest()
  return timingSafeEqual(a, b)
}

/**
 * 从文件读令牌：第一个非空行。文件权限过宽时警告——密钥文件不该是 644。
 *
 * @param {string} file - 绝对路径。
 * @param {{warn?: (text: string) => void}} [logger] - 日志出口。
 * @returns {string|undefined} 令牌，空文件返回 undefined。
 */
export function readTokenFile(file, logger) {
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    throw new Error(`channel-gateway: cannot read tokenFile ${file}: ${error.message}`)
  }
  try {
    const mode = statSync(file).mode & 0o777
    if ((mode & 0o077) !== 0) {
      logger?.warn?.(`channel-gateway: tokenFile ${file} is readable by other users (mode ${mode.toString(8)}); chmod 600 it`)
    }
  } catch {
    // 读得到内容就够了，权限查不到不影响启动。
  }
  const line = text.split('\n').map(item => item.trim()).find(item => item !== '')
  return line === undefined ? undefined : line
}

/** 从 Cookie 头里取一个值。 */
function cookieOf(header, name) {
  if (typeof header !== 'string' || header === '') return undefined
  for (const part of header.split(';')) {
    const index = part.indexOf('=')
    if (index === -1) continue
    if (part.slice(0, index).trim() !== name) continue
    try {
      return decodeURIComponent(part.slice(index + 1).trim())
    } catch {
      return undefined
    }
  }
  return undefined
}

/**
 * 建一个访问控制器。
 *
 * @param {{token?: string, tokenFile?: string, inboundToken?: string, inboundTokenFile?: string,
 *   viewerToken?: string, viewerTokenFile?: string,
 *   healthPublic?: boolean, cookieName?: string, viewerCookieName?: string, cookieSeconds?: number,
 *   logger?: {warn?: (text: string) => void}}} [options] - 配置。
 * @returns {object} 控制器。
 */
export function createAuth(options = {}) {
  const logger = options.logger
  const cookieName = typeof options.cookieName === 'string' && options.cookieName !== ''
    ? options.cookieName
    : DEFAULT_AUTH.cookieName
  const viewerCookieName = typeof options.viewerCookieName === 'string' && options.viewerCookieName !== ''
    ? options.viewerCookieName
    : DEFAULT_AUTH.viewerCookieName
  const cookieSeconds = Number.isFinite(options.cookieSeconds) && options.cookieSeconds >= 0
    ? Number(options.cookieSeconds)
    : DEFAULT_AUTH.cookieSeconds
  const healthPublic = options.healthPublic !== false

  const adminToken = blankToUndefined(options.token)
    ?? (blankToUndefined(options.tokenFile) === undefined ? undefined : readTokenFile(options.tokenFile, logger))
  // 没单独配 inbound 令牌就复用 admin 的：设了一个凭证却漏配另一个，不该导致适配器静默失联。
  const inboundToken = blankToUndefined(options.inboundToken)
    ?? (blankToUndefined(options.inboundTokenFile) === undefined ? undefined : readTokenFile(options.inboundTokenFile, logger))
    ?? adminToken
  // 只读令牌**不**回落到 admin：它存在的意义就是权限更低，不能因为没配 admin 就升级。
  const viewerToken = blankToUndefined(options.viewerToken)
    ?? (blankToUndefined(options.viewerTokenFile) === undefined ? undefined : readTokenFile(options.viewerTokenFile, logger))

  const mode = adminToken === undefined && inboundToken === undefined && viewerToken === undefined ? 'open' : 'token'
  if (mode === 'open') {
    logger?.warn?.(
      'channel-gateway: no access token configured; admin endpoints (delete, config, replay, retention) are open '
      + 'to anyone who can reach this port — set token or tokenFile before exposing it',
    )
  }
  if (mode === 'token' && viewerToken !== undefined && adminToken === undefined) {
    // 只配了只读令牌等于谁都不能写：面板能打开、全是灰的，看着像坏了。
    logger?.warn?.(
      'channel-gateway: a viewer token is configured but no admin token; nobody can use admin endpoints '
      + '(delete, config, replay, retention) — set token or tokenFile too',
    )
  }
  if (mode === 'token' && viewerToken !== undefined && adminToken !== undefined && constantTimeEqual(viewerToken, adminToken)) {
    // 两个令牌配成一样，只读角色就等于不存在，用户以为自己限制了权限其实没有。
    logger?.warn?.('channel-gateway: the viewer token equals the admin token; read-only access is not actually restricted')
  }

  /** 请求里带的凭证，以及它是从哪儿来的。 */
  function credentialsOf(req, url) {
    const headers = req?.headers ?? {}
    const authorization = headers.authorization ?? headers.Authorization
    if (typeof authorization === 'string' && /^Bearer /i.test(authorization)) {
      return { token: authorization.slice(7).trim(), via: 'header' }
    }
    const adminHeader = headers['x-admin-token']
    if (typeof adminHeader === 'string' && adminHeader !== '') return { token: adminHeader, via: 'header' }
    const inboundHeader = headers['x-inbound-token']
    if (typeof inboundHeader === 'string' && inboundHeader !== '') return { token: inboundHeader, via: 'header' }
    const query = url?.searchParams?.get('token')
    if (typeof query === 'string' && query !== '') return { token: query, via: 'query' }
    const cookie = cookieOf(headers.cookie, cookieName)
    if (cookie !== undefined && cookie !== '') return { token: cookie, via: 'cookie' }
    const viewerCookie = cookieOf(headers.cookie, viewerCookieName)
    if (viewerCookie !== undefined && viewerCookie !== '') return { token: viewerCookie, via: 'cookie' }
    return { token: undefined, via: undefined }
  }

  return {
    mode,
    adminToken,
    inboundToken,
    cookieName,
    cookieSeconds,
    healthPublic,

    viewerToken,
    viewerCookieName,

    /**
     * 这个请求需要哪种角色。
     *
     * 规则只有一条：读用 `viewer`，写用 `admin`。以后新加接口默认就是"写"，
     * 忘了归类只会更严，不会更松。
     *
     * @param {string} method - HTTP 方法。
     * @param {URL} url - 解析后的 URL。
     * @param {string} route - 网关挂载前缀，如 `/channel`。
     * @returns {'public'|'inbound'|'viewer'|'admin'} 所需角色。
     */
    required(method, url, route) {
      if (method === 'GET' && url.pathname === `${route}/health` && healthPublic) return 'public'
      if (method === 'POST' && url.pathname === route) return 'inbound'
      if (method === 'GET' || method === 'HEAD') return 'viewer'
      return 'admin'
    },

    /**
     * 判定请求能不能进。
     *
     * @param {object} req - Node 请求对象。
     * @param {URL} url - 解析后的 URL。
     * @param {string} route - 网关挂载前缀。
     * @returns {{allowed: boolean, role: string, status?: number, via?: string, setCookie?: boolean,
     *   reason?: string}} 判定结果。`status` 只在被拒时有值：401 是没凭证或凭证错，
     *   403 是凭证对但权限不够。
     */
    classify(req, url, route) {
      const required = this.required(req.method ?? 'GET', url, route)
      if (required === 'public') return { allowed: true, role: 'public' }
      // 全开模式下没有"只读"这个概念：没配令牌就是谁都能做任何事，如实报 admin，
      // 否则面板会自称只读却什么都能点，比不报还糟。
      if (mode === 'open') return { allowed: true, role: 'admin', reason: 'no token configured' }
      const { token, via } = credentialsOf(req, url)
      if (token === undefined) return { allowed: false, role: required, status: 401, reason: 'missing token' }
      if (required === 'inbound') {
        const ok = (inboundToken !== undefined && constantTimeEqual(token, inboundToken))
          || (adminToken !== undefined && constantTimeEqual(token, adminToken))
        return ok
          ? { allowed: true, role: 'inbound', via }
          : { allowed: false, role: 'inbound', status: 401, reason: 'bad token' }
      }
      const isAdmin = adminToken !== undefined && constantTimeEqual(token, adminToken)
      const isViewer = !isAdmin && viewerToken !== undefined && constantTimeEqual(token, viewerToken)
      if (!isAdmin && !isViewer) return { allowed: false, role: required, status: 401, reason: 'bad token' }
      const role = isAdmin ? 'admin' : 'viewer'
      if (required === 'admin' && role !== 'admin') {
        // 401 会让客户端重试或换凭证，而这里换凭证也没用：是权限不够。
        return { allowed: false, role, status: 403, reason: 'this token is read-only' }
      }
      // 从 ?token= 进来的是浏览器首次打开面板：发个 cookie，后面的请求就不用再带查询串
      // （查询串会留在浏览器历史和反向代理日志里）。
      return { allowed: true, role, via, setCookie: via === 'query' }
    },

    /**
     * 面板 cookie 的 Set-Cookie 值。
     *
     * @param {string} route - 网关挂载前缀，决定 cookie 的 Path。
     * @param {'admin'|'viewer'} [role] - 用哪个角色的令牌与 cookie 名。
     * @returns {string} Set-Cookie 头。
     */
    cookieHeader(route, role = 'admin') {
      const viewer = role === 'viewer'
      const parts = [
        `${viewer ? viewerCookieName : cookieName}=${encodeURIComponent(String((viewer ? viewerToken : adminToken) ?? ''))}`,
        `Path=${route}`,
        'HttpOnly',
        'SameSite=Strict',
      ]
      if (cookieSeconds > 0) parts.push(`Max-Age=${Math.floor(cookieSeconds)}`)
      return parts.join('; ')
    },
  }
}

/** 空字符串、全空白、非字符串都算没配。 */
function blankToUndefined(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}
