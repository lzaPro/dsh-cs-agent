/**
 * QQ 机器人 WebSocket 接入。
 *
 * 与 qq.js 的分工：qq.js 负责签名、鉴权、发消息；这里只负责「保持长连接、
 * 收事件、断线重连」。不需要公网地址，适合本机或内网部署。
 *
 * 协议要点（官方 opcode）：
 *   10 Hello   → 拿到心跳间隔，随后发 2 Identify（或 6 Resume）
 *   0  Dispatch→ READY / RESUMED / 各类消息事件
 *   1  Heartbeat / 11 ACK
 *   7  Reconnect / 9 Invalid Session
 *
 * @module platform-adapter/qq-ws
 */

/** GROUP_AND_C2C_EVENT：群 @ 与私聊消息。 */
export const INTENT_GROUP_AND_C2C = 1 << 25

/** 重连退避上限。 */
const MAX_BACKOFF_MS = 30_000

/**
 * 创建 WebSocket 客户端。
 * @param config - token provider、事件回调与测试注入点。
 */
export function createQQWebSocket(config) {
  const apiBase = stripSlash(config?.apiBase ?? 'https://api.bot.qq.com')
  const getToken = config?.getToken
  if (typeof getToken !== 'function') throw new Error('qq-ws: getToken must be a function')
  const onEvent = config?.onEvent ?? (() => {})
  const onStatus = config?.onStatus ?? (() => {})
  const WebSocketImpl = config?.WebSocket ?? globalThis.WebSocket
  const fetchImpl = config?.fetch ?? fetch

  let socket
  let heartbeat
  let seq = 0
  let sessionId
  let stopped = false
  let attempts = 0
  let reconnectTimer

  /** 取网关地址。 */
  async function gatewayUrl() {
    const response = await fetchImpl(`${apiBase}/gateway/bot`, {
      headers: { authorization: `QQBot ${await getToken()}` },
    })
    const data = await response.json().catch(() => ({}))
    if (typeof data?.url !== 'string' || data.url === '') {
      throw new Error(`qq-ws: gateway lookup failed: ${JSON.stringify(data)}`)
    }
    return data.url
  }

  /** 发一帧。 */
  function send(payload) {
    if (socket !== undefined && socket.readyState === 1) socket.send(JSON.stringify(payload))
  }

  /** 建立连接并开始识别流程。 */
  async function connect() {
    if (stopped) return
    const url = await gatewayUrl()
    onStatus({ state: 'connecting', url })
    socket = new WebSocketImpl(url)

    socket.onmessage = (event) => {
      let payload
      try {
        payload = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data))
      } catch {
        return
      }
      if (typeof payload.s === 'number') seq = payload.s
      handleOp(payload)
    }
    socket.onclose = (event) => {
      clearInterval(heartbeat)
      if (stopped) return
      onStatus({ state: 'closed', code: event?.code })
      scheduleReconnect()
    }
    socket.onerror = () => {
      onStatus({ state: 'error' })
    }
  }

  /** 处理一帧网关消息。 */
  function handleOp(payload) {
    switch (payload.op) {
      case 10: {
        const interval = Number(payload.d?.heartbeat_interval ?? 30_000)
        clearInterval(heartbeat)
        heartbeat = setInterval(() => send({ op: 1, d: seq === 0 ? null : seq }), interval)
        if (sessionId !== undefined) {
          void getToken().then(token => send({ op: 6, d: { token: `QQBot ${token}`, session_id: sessionId, seq } }))
        } else {
          void getToken().then(token => send({
            op: 2,
            d: {
              token: `QQBot ${token}`,
              intents: config?.intents ?? INTENT_GROUP_AND_C2C,
              shard: [0, 1],
              properties: {},
            },
          }))
        }
        return
      }
      case 0: {
        if (payload.t === 'READY') {
          sessionId = payload.d?.session_id
          attempts = 0
          onStatus({ state: 'ready', sessionId, user: payload.d?.user?.username })
          return
        }
        if (payload.t === 'RESUMED') {
          attempts = 0
          onStatus({ state: 'resumed' })
          return
        }
        onEvent(payload)
        return
      }
      case 7:
        onStatus({ state: 'reconnect-requested' })
        socket?.close()
        return
      case 9:
        // 会话失效：丢掉 session_id，下一轮重新 identify。
        sessionId = undefined
        onStatus({ state: 'invalid-session' })
        socket?.close()
        return
      case 11:
        return
      default:
        return
    }
  }

  /** 指数退避重连。 */
  function scheduleReconnect() {
    attempts += 1
    const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** (attempts - 1))
    onStatus({ state: 'reconnecting', delay, attempt: attempts })
    clearTimeout(reconnectTimer)
    reconnectTimer = setTimeout(() => {
      void connect().catch((error) => {
        onStatus({ state: 'connect-failed', error: error.message })
        scheduleReconnect()
      })
    }, delay)
  }

  /** 启动。 */
  async function start() {
    stopped = false
    await connect()
  }

  /** 停止，不再重连。 */
  function stop() {
    stopped = true
    clearTimeout(reconnectTimer)
    clearInterval(heartbeat)
    socket?.close()
  }

  return { start, stop, state: () => ({ seq, sessionId }) }
}

/** 去掉结尾斜杠。 */
function stripSlash(value) {
  return value.endsWith('/') ? value.slice(0, -1) : value
}
