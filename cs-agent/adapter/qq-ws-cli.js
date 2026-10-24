#!/usr/bin/env node
/**
 * QQ 机器人（WebSocket 模式）：无需公网地址。
 *
 *   QQ 网关 ⇄ 本进程 ──▶ channel gateway ──▶ 客服会话
 *                   ◀── POST /reply ────────
 *
 * Environment:
 *   QQ_APP_ID / QQ_APP_SECRET   开放平台凭证（必填）
 *   GATEWAY_URL                 默认 http://127.0.0.1:3080
 *   GATEWAY_TOKEN               网关配了 token 时填
 *   REPLY_HOST / REPLY_PORT     回复入口，默认 127.0.0.1:8080
 *
 * 凭证从同目录的 .env.local 读取（见 env.js），不需要每次输入。
 */
import './env.js'
import { createServer } from 'node:http'
import { createAdapter } from './index.js'
import { createQQBot } from './qq.js'
import { createQQWebSocket } from './qq-ws.js'

const env = process.env
if (env.QQ_APP_ID === undefined || env.QQ_APP_SECRET === undefined) {
  console.error('QQ_APP_ID and QQ_APP_SECRET are required')
  process.exit(1)
}

const qq = createQQBot({ appId: env.QQ_APP_ID, appSecret: env.QQ_APP_SECRET })
const adapter = createAdapter({
  gatewayUrl: env.GATEWAY_URL ?? 'http://127.0.0.1:3080',
  token: env.GATEWAY_TOKEN,
  transport: { send: message => qq.send(message) },
  replyMode: env.REPLY_MODE === 'poll' ? 'poll' : 'webhook',
})

let ws
const host = env.REPLY_HOST ?? '127.0.0.1'
const port = Number(env.REPLY_PORT ?? 8080)

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  if (req.method === 'GET' && url.pathname === '/health') {
    return json(res, 200, { ok: true, mode: 'websocket', ws: ws?.state?.() ?? null })
  }
  if (req.method === 'POST' && url.pathname === '/reply') {
    try {
      const result = await adapter.reply(await readJson(req))
      return json(res, 200, result)
    } catch (error) {
      console.error(`qq: reply failed: ${error.message}`)
      return json(res, 500, { error: error.message })
    }
  }
  return json(res, 404, { error: 'not found' })
})

await new Promise((resolve, reject) => {
  server.once('error', reject)
  server.listen(port, host, resolve)
})

ws = createQQWebSocket({
  getToken: () => qq.accessToken(),
  onStatus: (status) => {
    if (status.state === 'ready') {
      console.log(`qq: ready as ${status.user ?? 'bot'} (session ${status.sessionId})`)
      return
    }
    if (status.state === 'reconnecting') {
      console.log(`qq: reconnecting in ${status.delay}ms (attempt ${status.attempt})`)
      return
    }
    if (status.state === 'connect-failed' || status.state === 'error') {
      console.error(`qq: ${status.state}${status.error === undefined ? '' : `: ${status.error}`}`)
      return
    }
    console.log(`qq: ${status.state}`)
  },
  onEvent: (payload) => {
    const message = qq.handleDispatch(payload)
    if (message === undefined) return
    // 全量模式会推群里每条消息；只处理带图片的（截图报障），其余忽略。
    if (payload.t === 'GROUP_MESSAGE_CREATE' && (message.images?.length ?? 0) === 0) return
    console.log(`qq: ${payload.t} from ${message.userId}${message.groupId ? ` in ${message.groupId}` : ''}`)
    void (async () => {
      // 群名是一次性查询，失败不影响转发。
      if (message.groupId !== undefined) {
        const name = await qq.groupName(message.groupId)
        if (name !== undefined) message.groupName = name
      }
      await adapter.inbound(message)
    })().catch((error) => {
      console.error(`qq: gateway delivery failed: ${error.message}`)
    })
  },
})

const stopPolling = adapter.startPolling()
await ws.start()
console.log(`qq bot (websocket) running; replies on http://${host}:${port}/reply`)
console.log(`  gateway: ${adapter.gatewayUrl}`)

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    ws.stop()
    stopPolling()
    server.close(() => process.exit(0))
  })
}

/** Read a JSON body. */
async function readJson(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 1024 * 1024) throw new Error('request body too large')
    chunks.push(chunk)
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  if (raw.trim() === '') throw new Error('request body is empty')
  return JSON.parse(raw)
}

/** Write one JSON response. */
function json(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(value))
}
