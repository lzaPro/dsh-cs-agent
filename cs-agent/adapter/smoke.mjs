// Adapter smoke test with a fake gateway: no network, no Harness.
// Run with: node platform-adapter/smoke.mjs
import { createAdapter, split } from './index.js'

let failed = 0
const check = (ok, label, detail = '') => {
  if (!ok) failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail === '' ? '' : `: ${detail}`}`)
}

/** A gateway stand-in that records calls and returns a canned reply record. */
function fakeGateway(status = 202) {
  const calls = []
  const fetch = async (url, options = {}) => {
    calls.push({ url, body: options.body === undefined ? undefined : JSON.parse(options.body), headers: options.headers })
    if (url.includes('/outbox')) {
      return new Response(JSON.stringify({ messages: [] }), { status: 200 })
    }
    return new Response(JSON.stringify({ key: 'qq:u1', duplicate: false, sessionId: 's1' }), { status })
  }
  return { fetch, calls }
}

const sent = []
const transport = { send: async (message) => { sent.push(message) } }

{
  const gateway = fakeGateway()
  const adapter = createAdapter({ gatewayUrl: 'http://gw', transport, fetch: gateway.fetch })
  const result = await adapter.inbound({ channel: 'qq', userId: 'u1', messageId: 'm1', text: '你好' })
  check(result.accepted === true, 'private message accepted')
  check(gateway.calls[0].body.senderId === 'u1', 'senderId forwarded')
  check(gateway.calls[0].body.groupId === undefined, 'private message has no groupId')
  check(gateway.calls[0].url === 'http://gw/channel', 'posts to /channel')
}

{
  const gateway = fakeGateway()
  const adapter = createAdapter({ gatewayUrl: 'http://gw', transport, fetch: gateway.fetch })
  const result = await adapter.inbound({ channel: 'wechat', groupId: 'g1', userId: 'u1', text: '群里问', mentioned: false })
  check(result.ignored === true, 'group message without mention is ignored')
  check(gateway.calls.length === 0, 'ignored message never reaches the gateway')
}

{
  const gateway = fakeGateway()
  const adapter = createAdapter({ gatewayUrl: 'http://gw', transport, fetch: gateway.fetch })
  await adapter.inbound({ channel: 'wechat', groupId: 'g1', userId: 'u1', text: '群里问', mentioned: true })
  check(gateway.calls[0].body.groupId === 'g1', 'mentioned group message forwards groupId')
}

{
  const gateway = fakeGateway()
  const adapter = createAdapter({ gatewayUrl: 'http://gw', transport, fetch: gateway.fetch })
  await adapter.inbound({ channel: 'qq', userId: 'u1', text: '看截图', images: ['https://x/y.png', 'bad'] })
  check(gateway.calls[0].body.attachments.length === 1, 'only http images are forwarded')
}

{
  const gateway = fakeGateway(500)
  const adapter = createAdapter({ gatewayUrl: 'http://gw', transport, fetch: gateway.fetch })
  let error
  try {
    await adapter.inbound({ channel: 'qq', userId: 'u1', text: '你好' })
  } catch (caught) {
    error = caught
  }
  check(error !== undefined && /500/.test(error.message), 'gateway rejection surfaces')
}

{
  sent.length = 0
  const adapter = createAdapter({ gatewayUrl: 'http://gw', transport, fetch: fakeGateway().fetch })
  await adapter.reply({ groupId: null, senderId: 'u1', text: '私聊回复' })
  check(sent[0].text === '私聊回复' && sent[0].groupId === undefined, 'private reply is sent plain')
}

{
  sent.length = 0
  const adapter = createAdapter({ gatewayUrl: 'http://gw', transport, fetch: fakeGateway().fetch })
  await adapter.reply({ groupId: 'g1', senderId: 'u1', text: '群回复' })
  check(sent[0].text === '@u1 群回复' && sent[0].groupId === 'g1', 'group reply mentions the sender')
}

{
  sent.length = 0
  const long = Array.from({ length: 40 }, (_, index) => `第 ${index} 段：${'内容'.repeat(40)}`).join('\n\n')
  const adapter = createAdapter({ gatewayUrl: 'http://gw', transport, fetch: fakeGateway().fetch, maxChars: 200 })
  const result = await adapter.reply({ groupId: null, senderId: 'u1', text: long })
  check(result.sent > 1 && sent.every(item => item.text.length <= 200), 'long reply is split', `${result.sent} chunks`)
}

{
  check(split('short', 100).length === 1, 'split keeps short text whole')
  const chunks = split('a'.repeat(250), 100)
  check(chunks.length === 3 && chunks.every(chunk => chunk.length <= 100), 'split hard-cuts over-long text', String(chunks.length))
}

{
  sent.length = 0
  let attempts = 0
  const flaky = {
    send: async (message) => {
      attempts += 1
      if (attempts < 3) throw new Error('flaky platform')
      sent.push(message)
    },
  }
  const adapter = createAdapter({ gatewayUrl: 'http://gw', transport: flaky, fetch: fakeGateway().fetch })
  const result = await adapter.reply({ groupId: null, senderId: 'u1', text: '重试' })
  check(result.sent === 1 && attempts === 3, 'send retries until it succeeds', `attempts=${attempts}`)
}

{
  sent.length = 0
  let polls = 0
  const fetch = async (url) => {
    if (!url.includes('/outbox')) return new Response('{}', { status: 202 })
    polls += 1
    const messages = polls === 1
      ? [{ key: 'qq:u1', groupId: null, senderId: 'u1', text: '第一次', at: '2026-01-01T00:00:01.000Z' }]
      : [
        { key: 'qq:u1', groupId: null, senderId: 'u1', text: '第一次', at: '2026-01-01T00:00:01.000Z' },
        { key: 'qq:u1', groupId: null, senderId: 'u1', text: '第二次', at: '2026-01-01T00:00:02.000Z' },
      ]
    return new Response(JSON.stringify({ messages }), { status: 200 })
  }
  const adapter = createAdapter({
    gatewayUrl: 'http://gw', transport, fetch, replyMode: 'poll', since: '2026-01-01T00:00:00.000Z',
  })
  await adapter.pollOnce()
  await adapter.pollOnce()
  check(sent.length === 2 && sent[1].text === '第二次', 'poll mode delivers each reply once', String(sent.length))
}

process.exit(failed === 0 ? 0 : 1)
