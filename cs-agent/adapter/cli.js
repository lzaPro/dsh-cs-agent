#!/usr/bin/env node
/**
 * Run the platform adapter.
 *
 * Environment:
 *   GATEWAY_URL        default http://127.0.0.1:3080
 *   GATEWAY_TOKEN      optional bearer token for the gateway
 *   ADAPTER_PORT       default 3090
 *   REPLY_MODE         webhook | poll (poll reads the gateway outbox; dev only)
 *   TRANSPORT          console | http
 *   PLATFORM_SEND_URL  required when TRANSPORT=http
 *   REQUIRE_MENTION    default true for group messages
 */
import { createAdapter, serve } from './index.js'

const env = process.env
const transportKind = env.TRANSPORT ?? 'console'
const transport = transportKind === 'http' ? httpTransport(env) : consoleTransport()

const adapter = createAdapter({
  gatewayUrl: env.GATEWAY_URL ?? 'http://127.0.0.1:3080',
  token: env.GATEWAY_TOKEN,
  transport,
  replyMode: env.REPLY_MODE ?? 'poll',
  requireMention: env.REQUIRE_MENTION !== 'false',
})

const running = await serve(adapter, Number(env.ADAPTER_PORT ?? 3090))
console.log(`platform-adapter listening on http://127.0.0.1:${running.port}`)
console.log(`  transport: ${transportKind}   reply mode: ${env.REPLY_MODE ?? 'poll'}`)
console.log(`  gateway:   ${adapter.gatewayUrl}`)

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    void running.close().then(() => process.exit(0))
  })
}

/** Print every outgoing message as one JSON line. */
function consoleTransport() {
  return {
    send: async (message) => {
      console.log(JSON.stringify({ sentTo: message.groupId ? `group:${message.groupId}` : `user:${message.userId}`, text: message.text }))
    },
  }
}

/** Forward to a real platform bridge; replace this with a platform SDK call. */
function httpTransport(config) {
  const url = config.PLATFORM_SEND_URL
  if (url === undefined || url === '') throw new Error('TRANSPORT=http requires PLATFORM_SEND_URL')
  return {
    send: async (message) => {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(message),
      })
      if (!response.ok) throw new Error(`platform send failed (${response.status})`)
    },
  }
}
