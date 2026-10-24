/**
 * Platform adapter: the only piece that knows a real chat platform.
 *
 * It sits between QQ/WeChat/Appia and the channel gateway:
 *
 *   platform ──inbound──▶ adapter ──POST /channel──▶ gateway ──▶ agent
 *   platform ◀──send───── adapter ◀──replyWebhook─── gateway
 *
 * Everything platform-specific lives in a transport. The gateway never learns
 * which platform it is talking to, and the adapter never learns what the agent
 * said or why.
 *
 * @module platform-adapter
 */

import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'

/** Longest single platform message before splitting. */
const DEFAULT_MAX_CHARS = 1800

/** Transport attempts per outgoing message. */
const MAX_SEND_ATTEMPTS = 3

/**
 * Build the adapter.
 * @param config - gateway URL, transport, and delivery policy.
 */
export function createAdapter(config) {
  const gatewayUrl = stripSlash(requireText(config?.gatewayUrl, 'gatewayUrl'))
  const token = typeof config?.token === 'string' && config.token !== '' ? config.token : undefined
  const requireMention = config?.requireMention !== false
  const maxChars = positiveInteger(config?.maxChars, DEFAULT_MAX_CHARS)
  const transport = config?.transport
  if (typeof transport?.send !== 'function') {
    throw new Error('platform-adapter: config.transport.send must be a function')
  }
  const fetchImpl = config?.fetch ?? fetch
  const replyMode = config?.replyMode === 'poll' ? 'poll' : 'webhook'
  const pollIntervalMs = positiveInteger(config?.pollIntervalMs, 2000)

  const delivered = new Set()
  // Default cursor drops replies that predate this process; a dev restart does
  // not replay yesterday's outbox.
  let cursor = config?.since ?? new Date().toISOString()
  let timer

  /** Platform message → gateway call. Returns what to answer the platform with. */
  async function inbound(payload) {
    const message = normalizePlatformMessage(payload)
    if (message.groupId !== undefined && requireMention && message.mentioned !== true) {
      return { ignored: true, reason: 'not mentioned' }
    }
    const body = {
      channel: message.channel,
      senderId: message.userId,
      messageId: message.messageId,
      ...(message.groupId === undefined ? {} : { groupId: message.groupId }),
      ...(message.groupName === undefined ? {} : { groupName: message.groupName }),
      ...(message.senderName === undefined ? {} : { senderName: message.senderName }),
      ...(message.text === '' ? {} : { text: message.text }),
      ...(message.images.length === 0 ? {} : { attachments: message.images }),
    }
    const response = await fetchImpl(`${gatewayUrl}/channel`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      },
      body: JSON.stringify(body),
    })
    const text = await response.text()
    if (response.status !== 202 && response.status !== 200) {
      throw new Error(`gateway rejected the message (${response.status}): ${text}`)
    }
    return { accepted: true, gateway: JSON.parse(text) }
  }

  /** Gateway reply → platform delivery. */
  async function reply(envelope) {
    // 评测流量不属于任何真实用户，永远不要发到平台上。
    if (envelope?.channel === 'eval') return { sent: 0 }
    const text = typeof envelope?.text === 'string' ? envelope.text.trim() : ''
    if (text === '') return { sent: 0 }
    const groupId = typeof envelope.groupId === 'string' && envelope.groupId !== '' ? envelope.groupId : undefined
    const senderId = typeof envelope.senderId === 'string' ? envelope.senderId : ''
    const mention = groupId !== undefined && senderId !== '' ? `@${senderId} ` : ''
    const chunks = split(text, Math.max(50, maxChars - mention.length))
    let sent = 0
    for (const [index, chunk] of chunks.entries()) {
      await sendWithRetry({
        groupId,
        userId: senderId,
        text: index === 0 ? `${mention}${chunk}` : chunk,
      })
      sent += 1
    }
    return { sent }
  }

  async function sendWithRetry(message) {
    let lastError
    for (let attempt = 1; attempt <= MAX_SEND_ATTEMPTS; attempt += 1) {
      try {
        await transport.send(message)
        return
      } catch (error) {
        lastError = error
        if (attempt < MAX_SEND_ATTEMPTS) await sleep(300 * 2 ** (attempt - 1))
      }
    }
    throw lastError
  }

  /** Dev mode: read replies from the gateway outbox instead of a webhook. */
  async function pollOnce() {
    const response = await fetchImpl(`${gatewayUrl}/channel/outbox?limit=50`)
    if (!response.ok) throw new Error(`outbox read failed (${response.status})`)
    const body = await response.json()
    const messages = Array.isArray(body?.messages) ? body.messages : []
    for (const message of messages) {
      const id = `${message.at}|${message.key}`
      if (delivered.has(id)) continue
      if (cursor !== '' && message.at <= cursor) continue
      delivered.add(id)
      cursor = message.at
      await reply(message)
    }
    if (delivered.size > 500) delivered.clear()
  }

  function startPolling() {
    if (replyMode !== 'poll') return () => {}
    let stopped = false
    const tick = async () => {
      if (stopped) return
      try {
        await pollOnce()
      } catch {
        // Polling is best effort; the next tick retries.
      }
      if (!stopped) timer = setTimeout(tick, pollIntervalMs)
    }
    void tick()
    return () => {
      stopped = true
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  return { inbound, reply, pollOnce, startPolling, gatewayUrl }
}

/**
 * Start the adapter's HTTP surface.
 * @param adapter - value returned by {@link createAdapter}.
 * @param port - listening port; 0 asks the OS for one.
 */
export async function serve(adapter, port = 3090) {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (req.method === 'GET' && url.pathname === '/health') {
        return json(res, 200, { ok: true, gateway: adapter.gatewayUrl })
      }
      if (req.method === 'POST' && url.pathname === '/platform/message') {
        const result = await adapter.inbound(await readJson(req))
        return json(res, 202, result)
      }
      if (req.method === 'POST' && url.pathname === '/reply') {
        const result = await adapter.reply(await readJson(req))
        return json(res, 200, result)
      }
      return json(res, 404, { error: 'not found' })
    } catch (error) {
      return json(res, 400, { error: error.message })
    }
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  })
  const stopPolling = adapter.startPolling()
  return {
    server,
    port: server.address().port,
    close: async () => {
      stopPolling()
      await new Promise(resolve => server.close(resolve))
    },
  }
}

/** Shape one platform callback body. */
function normalizePlatformMessage(payload) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('platform message must be an object')
  }
  const channel = requireText(payload.channel, 'channel')
  const userId = requireText(payload.userId, 'userId')
  const text = typeof payload.text === 'string' ? payload.text.trim() : ''
  const images = Array.isArray(payload.images)
    ? payload.images.filter(item => typeof item === 'string' && /^https?:\/\//i.test(item))
    : []
  if (text === '' && images.length === 0) {
    throw new Error('platform message needs text or images')
  }
  const groupId = payload.groupId === undefined || payload.groupId === null || payload.groupId === ''
    ? undefined
    : requireText(payload.groupId, 'groupId')
  const groupName = typeof payload.groupName === 'string' && payload.groupName.trim() !== ''
    ? payload.groupName.trim()
    : undefined
  const senderName = typeof payload.senderName === 'string' && payload.senderName.trim() !== ''
    ? payload.senderName.trim()
    : undefined
  const messageId = typeof payload.messageId === 'string' && payload.messageId !== ''
    ? payload.messageId
    : `adapter-${randomUUID()}`
  return {
    channel,
    userId,
    text,
    images,
    messageId,
    mentioned: payload.mentioned === true,
    ...(groupId === undefined ? {} : { groupId }),
    ...(groupName === undefined ? {} : { groupName }),
    ...(senderName === undefined ? {} : { senderName }),
  }
}

/**
 * Split a long reply on paragraph, then line, then hard boundaries.
 * @param text - complete reply.
 * @param limit - maximum characters per chunk.
 */
export function split(text, limit) {
  if (text.length <= limit) return [text]
  const chunks = []
  let rest = text
  while (rest.length > limit) {
    const window = rest.slice(0, limit)
    const at = Math.max(window.lastIndexOf('\n\n'), window.lastIndexOf('\n'))
    const cut = at > limit * 0.5 ? at : limit
    chunks.push(rest.slice(0, cut).trim())
    rest = rest.slice(cut).trim()
  }
  if (rest !== '') chunks.push(rest)
  return chunks
}

/** Read a JSON body with a size ceiling. */
async function readJson(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 1024 * 1024) throw new Error('request body too large')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') throw new Error('request body is empty')
  return JSON.parse(text)
}

/** Write one JSON response. */
function json(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(value))
}

/** Require a non-empty string. */
function requireText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`platform-adapter: ${field} must be a non-empty string`)
  }
  return value.trim()
}

/** Positive integer or fallback. */
function positiveInteger(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback
}

/** Remove a trailing slash. */
function stripSlash(value) {
  return value.endsWith('/') ? value.slice(0, -1) : value
}

/** Sleep for a delay. */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}
