#!/usr/bin/env node
/**
 * QQ 机器人服务：接 QQ 回调 → 渠道网关 → 回复回 QQ。
 *
 * Environment:
 *   QQ_APP_ID / QQ_APP_SECRET   开放平台凭证（必填）
 *   QQ_PORT                     监听端口，默认 8080（平台只允许 80/443/8080/8443）
 *   QQ_PATH                     回调路径，默认 /qq/webhook
 *   GATEWAY_URL                 默认 http://127.0.0.1:3080
 *   GATEWAY_TOKEN               网关配了 token 时填
 *   REPLY_MODE                  webhook | poll，默认 webhook
 */
import { createServer } from 'node:http'
import { createAdapter } from './index.js'
import { createQQBot } from './qq.js'

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
  // QQ 的回复走 /reply，所以默认 webhook；poll 只用于本地联调。
  replyMode: env.REPLY_MODE ?? 'webhook',
})

const port = Number(env.QQ_PORT ?? 8080)
const path = env.QQ_PATH ?? '/qq/webhook'

const host = env.QQ_HOST ?? '127.0.0.1'
const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  if (req.method === 'GET' && url.pathname === '/health') {
    return json(res, 200, { ok: true, qq: true, path })
  }
  if (req.method === 'POST' && url.pathname === path) {
    let raw
    try {
      raw = await readRaw(req)
    } catch (error) {
      return json(res, 400, { error: error.message })
    }
    if (!qq.verifySignature(req.headers, raw)) {
      console.warn('qq: rejected a callback with an invalid signature')
      return json(res, 401, { error: 'invalid signature' })
    }
    let handled
    try {
      handled = qq.handleWebhook(raw)
    } catch (error) {
      console.error(`qq: bad payload: ${error.message}`)
      return json(res, 400, { error: error.message })
    }
    if (handled.message !== undefined) {
      try {
        await adapter.inbound(handled.message)
      } catch (error) {
        // 交给 QQ 重投；网关侧已经按 messageId 去重。
        console.error(`qq: gateway delivery failed: ${error.message}`)
        return json(res, 500, { error: 'gateway delivery failed' })
      }
    }
    return json(res, 200, handled.body)
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

console.log(`qq bot listening on ${host}:${port}${path}`)
console.log(`  gateway: ${adapter.gatewayUrl}`)
console.log(`  reply mode: ${env.REPLY_MODE ?? 'webhook'}`)
console.log('  callback URL must be public HTTPS on port 80/443/8080/8443')

const stopPolling = adapter.startPolling()
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    stopPolling()
    server.close(() => process.exit(0))
  })
}

/** Read the untouched request body; signature verification needs the exact bytes. */
async function readRaw(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 1024 * 1024) throw new Error('request body too large')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** Read a JSON body. */
async function readJson(req) {
  const raw = await readRaw(req)
  if (raw.trim() === '') throw new Error('request body is empty')
  return JSON.parse(raw)
}

/** Write one JSON response. */
function json(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(value))
}
