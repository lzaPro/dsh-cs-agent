/**
 * QQ 机器人（官方开放平台 API v2）接入。
 *
 * 职责只有四件：
 *   1. 校验每一次回调的 Ed25519 签名
 *   2. 处理回调地址验证（op 13）
 *   3. 把 QQ 事件翻译成网关认识的消息
 *   4. 把回复发回 QQ（优先被动回复，超时后改主动消息）
 *
 * 它不认识 DSH，也不做业务判断。
 *
 * @module platform-adapter/qq
 */

import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto'

/** 被动回复有效期 5 分钟；留 1 分钟余量给重试。 */
const PASSIVE_WINDOW_MS = 4 * 60 * 1000

/** 提前 60 秒刷新 access_token，官方建议。 */
const TOKEN_REFRESH_MARGIN_MS = 60 * 1000

/** 被动回复过期时 QQ 返回的错误码，命中后改发主动消息。 */
const EXPIRED_MSG_ID_CODES = new Set([304103, 40034005, 40034128])

/**
 * 创建 QQ 机器人接入。
 * @param config - AppID / AppSecret 与可选的测试注入点。
 */
export function createQQBot(config) {
  const appId = requireText(config?.appId, 'appId')
  const appSecret = requireText(config?.appSecret, 'appSecret')
  const apiBase = stripSlash(config?.apiBase ?? 'https://api.bot.qq.com')
  const tokenUrl = config?.tokenUrl ?? `${apiBase}/app/getAppAccessToken`
  const fetchImpl = config?.fetch ?? fetch
  const now = config?.now ?? (() => Date.now())
  const { privateKey, publicKey } = keypairFromSecret(appSecret)

  let token
  let expiresAt = 0
  /** 会话 → 最近一条消息，用于被动回复。 */
  const recent = new Map()
  /** group_openid → 群名，一次查询长期缓存。 */
  const groupNames = new Map()

  /**
   * 校验回调签名。
   * @param headers - 原始请求头，小写键。
   * @param rawBody - 原始请求体文本，不能是重新序列化的 JSON。
   */
  function verifySignature(headers, rawBody) {
    const signatureHex = headers?.['x-signature-ed25519']
    const timestamp = headers?.['x-signature-timestamp']
    if (typeof signatureHex !== 'string' || typeof timestamp !== 'string') return false
    let signature
    try {
      signature = Buffer.from(signatureHex, 'hex')
    } catch {
      return false
    }
    if (signature.length !== 64) return false
    return verify(null, Buffer.from(`${timestamp}${rawBody}`, 'utf8'), publicKey, signature)
  }

  /**
   * 处理一次已验签的回调。
   * @param rawBody - 原始请求体。
   * @returns `{ body, message? }`；body 直接回给 QQ。
   */
  function handleWebhook(rawBody) {
    let payload
    try {
      payload = JSON.parse(rawBody)
    } catch {
      throw new Error('QQ payload is not valid JSON')
    }
    if (payload?.op === 13) {
      const plainToken = payload.d?.plain_token
      const eventTs = payload.d?.event_ts
      if (typeof plainToken !== 'string' || typeof eventTs !== 'string') {
        throw new Error('QQ validation payload is missing plain_token or event_ts')
      }
      const signature = sign(null, Buffer.from(`${eventTs}${plainToken}`, 'utf8'), privateKey).toString('hex')
      return { body: { plain_token: plainToken, signature } }
    }
    if (payload?.op !== 0) return { body: { op: 12 } }
    return { body: { op: 12 }, message: handleDispatch(payload) }
  }

  /**
   * 处理一条已经解析的 Dispatch 事件，并记录用于被动回复的消息 id。
   * WebSocket 模式直接调用它，不需要走 HTTP 回调。
   * @param payload - 网关下发的事件。
   * @returns 归一化后的消息，或 undefined。
   */
  function handleDispatch(payload) {
    const message = normalizeQQEvent(payload)
    if (message === undefined) return undefined
    const key = conversationKey(message)
    recent.set(key, { msgId: message.messageId, at: now(), seq: 0 })
    while (recent.size > 5000) recent.delete(recent.keys().next().value)
    return message
  }

  /** 取（并缓存）access_token。 */
  async function accessToken() {
    if (token !== undefined && now() < expiresAt - TOKEN_REFRESH_MARGIN_MS) return token
    const response = await fetchImpl(tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ appId, clientSecret: appSecret }),
    })
    const data = await response.json().catch(() => ({}))
    if (typeof data?.access_token !== 'string' || data.access_token === '') {
      throw new Error(`QQ access_token failed: ${JSON.stringify(data)}`)
    }
    token = data.access_token
    expiresAt = now() + Number(data.expires_in ?? 7200) * 1000
    return token
  }

  /**
   * 发一条消息。优先被动回复，窗口过了就发主动消息。
   * @param message - `{ groupId?, userId, text }`
   */
  async function send(message) {
    const groupId = message.groupId
    const userId = message.userId
    if ((groupId === undefined || groupId === null) && (userId === undefined || userId === '')) {
      throw new Error('QQ send needs a groupId or a userId')
    }
    const key = groupId ? `group:${groupId}` : `user:${userId}`
    const record = recent.get(key)
    const passive = record !== undefined && now() - record.at < PASSIVE_WINDOW_MS
    const mention = typeof message.mention === 'string' && message.mention !== '' && groupId
      ? `<qqbot-at-user id="${message.mention}" /> `
      : ''
    const body = { msg_type: 0, content: mention + message.text }
    if (passive) {
      body.msg_id = record.msgId
      body.msg_seq = record.seq + 1
    }
    const result = await postMessage(groupId, userId, body)
    if (passive) record.seq += 1
    if (result?.code === undefined) return
    if (EXPIRED_MSG_ID_CODES.has(result.code)) {
      // 被动窗口已过：改发主动消息，会受平台频控。
      const retry = await postMessage(groupId, userId, { msg_type: 0, content: mention + message.text })
      if (retry?.code !== undefined) throw new Error(`QQ send failed: ${JSON.stringify(retry)}`)
      return
    }
    throw new Error(`QQ send failed: ${JSON.stringify(result)}`)
  }

  async function postMessage(groupId, userId, body) {
    const path = groupId
      ? `${apiBase}/v2/groups/${encodeURIComponent(groupId)}/messages`
      : `${apiBase}/v2/users/${encodeURIComponent(userId)}/messages`
    const response = await fetchImpl(path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `QQBot ${await accessToken()}`,
      },
      body: JSON.stringify(body),
    })
    const data = await response.json().catch(() => ({}))
    if (!response.ok && data?.code === undefined) {
      throw new Error(`QQ send failed (${response.status}): ${JSON.stringify(data)}`)
    }
    return data
  }

  /** 查群名；取不到就返回 undefined，不影响消息处理。 */
  async function groupName(groupOpenId) {
    if (groupNames.has(groupOpenId)) return groupNames.get(groupOpenId)
    try {
      const response = await fetchImpl(`${apiBase}/v2/groups/${encodeURIComponent(groupOpenId)}/info`, {
        headers: { authorization: `QQBot ${await accessToken()}` },
        signal: AbortSignal.timeout(5000),
      })
      if (!response.ok) return undefined
      const data = await response.json()
      const name = typeof data?.group_name === 'string' && data.group_name.trim() !== ''
        ? data.group_name.trim()
        : undefined
      if (name !== undefined) groupNames.set(groupOpenId, name)
      return name
    } catch {
      return undefined
    }
  }

  return { verifySignature, handleWebhook, handleDispatch, send, groupName, conversationKey, accessToken }
}

/** 把 QQ 事件翻译成网关消息；无关事件返回 undefined。 */
export function normalizeQQEvent(payload) {
  const type = payload?.t
  const d = payload?.d ?? {}
  if (type === 'GROUP_AT_MESSAGE_CREATE' || type === 'GROUP_MESSAGE_CREATE') {
    return {
      channel: 'qq',
      groupId: requireText(d.group_openid, 'group_openid'),
      userId: requireText(d.author?.member_openid ?? d.author?.id, 'member_openid'),
      senderName: typeof d.author?.username === 'string' ? d.author.username : undefined,
      messageId: requireText(d.id, 'id'),
      text: cleanContent(d.content),
      images: imageUrls(d),
      // 全量模式的事件不一定是 @ 机器人的，由调用方决定是否处理。
      mentioned: type === 'GROUP_AT_MESSAGE_CREATE',
    }
  }
  if (type === 'C2C_MESSAGE_CREATE') {
    return {
      channel: 'qq',
      userId: requireText(d.author?.user_openid ?? d.author?.id, 'user_openid'),
      messageId: requireText(d.id, 'id'),
      text: cleanContent(d.content),
      images: imageUrls(d),
      mentioned: true,
    }
  }
  return undefined
}

/** 去掉 QQ 文本里的 @ 标记。 */
function cleanContent(content) {
  if (typeof content !== 'string') return ''
  // 全量模式下 @ 会替换成 <@openid>，@消息用 <@123>，两种都要去掉。
  return content.replace(/<@!?[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
}

/** 取消息附件里的图片地址。 */
function imageUrls(d) {
  if (!Array.isArray(d.attachments)) return []
  return d.attachments
    .map(item => item?.url)
    .filter(url => typeof url === 'string' && /^https?:\/\//i.test(url))
}

/** 会话键，与网关的消息形状保持一致。 */
function conversationKey(message) {
  return message.groupId === undefined || message.groupId === null
    ? `user:${message.userId}`
    : `group:${message.groupId}`
}

/**
 * Bot Secret → Ed25519 密钥对：secret 重复到 32 字节作为 seed。
 * @param secret - 开放平台的 Bot Secret。
 */
export function keypairFromSecret(secret) {
  let text = secret
  while (Buffer.byteLength(text, 'utf8') < 32) text += text
  const seed = Buffer.from(text, 'utf8').subarray(0, 32)
  const der = Buffer.concat([
    Buffer.from('302e020100300506032b657004220420', 'hex'),
    seed,
  ])
  const privateKey = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' })
  return { privateKey, publicKey: createPublicKey(privateKey) }
}

/** 必填非空字符串。 */
function requireText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`QQ event is missing ${field}`)
  }
  return value.trim()
}

/** 去掉结尾斜杠。 */
function stripSlash(value) {
  return value.endsWith('/') ? value.slice(0, -1) : value
}
