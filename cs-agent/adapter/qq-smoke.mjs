// QQ adapter smoke test: signature, handshake, event mapping, passive replies.
// Run with: node platform-adapter/qq-smoke.mjs
import { createQQBot, keypairFromSecret } from './qq.js'
import { sign } from 'node:crypto'

let failed = 0
const check = (ok, label, detail = '') => {
  if (!ok) failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail === '' ? '' : `: ${detail}`}`)
}

// 官方文档里的验证向量：secret DG5g3B4j9X2KOErG
const SECRET = 'DG5g3B4j9X2KOErG'
const qq = createQQBot({ appId: '11111111', appSecret: SECRET })

{
  const raw = JSON.stringify({ d: { plain_token: 'Arq0D5A61EgUu4OxUvOp', event_ts: '1725442341' }, op: 13 })
  const handled = qq.handleWebhook(raw)
  check(handled.body.plain_token === 'Arq0D5A61EgUu4OxUvOp', 'validation echoes plain_token')
  check(
    handled.body.signature === '87befc99c42c651b3aac0278e71ada338433ae26fcb24307bdc5ad38c1adc2d01bcfcadc0842edac85e85205028a1132afe09280305f13aa6909ffc2d652c706',
    'validation signature matches the official vector',
  )
}

{
  const { privateKey } = keypairFromSecret(SECRET)
  const body = '{"op":0,"t":"C2C_MESSAGE_CREATE","d":{"id":"m1"}}'
  const timestamp = '1725442341'
  const signature = sign(null, Buffer.from(timestamp + body), privateKey).toString('hex')
  check(qq.verifySignature({ 'x-signature-ed25519': signature, 'x-signature-timestamp': timestamp }, body), 'accepts a valid signature')
  check(!qq.verifySignature({ 'x-signature-ed25519': signature, 'x-signature-timestamp': timestamp }, `${body} `), 'rejects a tampered body')
  check(!qq.verifySignature({}, body), 'rejects a missing signature')
  check(!qq.verifySignature({ 'x-signature-ed25519': 'zz', 'x-signature-timestamp': timestamp }, body), 'rejects malformed hex')
}

{
  const payload = {
    op: 0,
    t: 'GROUP_AT_MESSAGE_CREATE',
    d: {
      id: 'msg-1',
      content: '<@!123456> 我的容器一直重启',
      group_openid: 'G1',
      author: { member_openid: 'U1' },
      attachments: [{ url: 'https://cdn.example.com/a.png' }, { url: 'not-a-url' }],
    },
  }
  const handled = qq.handleWebhook(JSON.stringify(payload))
  const message = handled.message
  check(message?.channel === 'qq', 'group event maps to channel qq')
  check(message?.groupId === 'G1' && message?.userId === 'U1', 'group event carries ids')
  check(message?.text === '我的容器一直重启', 'mention markup is stripped', message?.text)
  check(message?.images.length === 1, 'only http attachments survive')
  check(handled.body.op === 12, 'group event acknowledges with op 12')
}

{
  const payload = {
    op: 0,
    t: 'C2C_MESSAGE_CREATE',
    d: { id: 'msg-2', content: '你好', author: { user_openid: 'U9' } },
  }
  const message = qq.handleWebhook(JSON.stringify(payload)).message
  check(message?.groupId === undefined && message?.userId === 'U9', 'private event has no groupId')
}

{
  const message = qq.handleWebhook(JSON.stringify({
    op: 0,
    t: 'GROUP_MESSAGE_CREATE',
    d: {
      id: 'msg-full',
      content: '<@ABC123> 看这个报错',
      group_openid: 'G1',
      author: { member_openid: 'U1', username: '小明' },
      attachments: [{ content_type: 'image/png', url: 'https://x/1.png' }],
    },
  })).message
  check(message?.mentioned === false, 'full group message is not a mention')
  check(message?.senderName === '小明', 'full group message carries the nickname')
  check(message?.text === '看这个报错', 'mention markup is stripped from full group messages')
  check(message?.images?.length === 1, 'full group message keeps the image')
}

{
  const calls = []
  let clock = 0
  const fetch = async (url, options = {}) => {
    calls.push({ url, body: options.body === undefined ? undefined : JSON.parse(options.body), headers: options.headers })
    if (url.includes('getAppAccessToken')) {
      return new Response(JSON.stringify({ access_token: 'TOKEN', expires_in: 7200 }), { status: 200 })
    }
    return new Response(JSON.stringify({ id: 'sent' }), { status: 200 })
  }
  const bot = createQQBot({ appId: '1', appSecret: SECRET, fetch, now: () => clock, apiBase: 'https://api.example' })
  bot.handleWebhook(JSON.stringify({
    op: 0, t: 'GROUP_AT_MESSAGE_CREATE',
    d: { id: 'msg-1', content: 'hi', group_openid: 'G1', author: { member_openid: 'U1' } },
  }))
  await bot.send({ groupId: 'G1', userId: 'U1', text: '第一条' })
  await bot.send({ groupId: 'G1', userId: 'U1', text: '第二条' })
  const sends = calls.filter(call => call.url.includes('/messages'))
  check(sends[0].url === 'https://api.example/v2/groups/G1/messages', 'group send URL', sends[0].url)
  check(sends[0].body.msg_id === 'msg-1' && sends[0].body.msg_seq === 1, 'first reply is passive')
  check(sends[1].body.msg_id === 'msg-1' && sends[1].body.msg_seq === 2, 'second reply increments msg_seq')
  check(sends[0].headers.authorization === 'QQBot TOKEN', 'authorization header')
  check(calls.filter(call => call.url.includes('getAppAccessToken')).length === 1, 'access token is cached')

  clock = 5 * 60 * 1000
  await bot.send({ groupId: 'G1', userId: 'U1', text: '过期后' })
  const last = calls.filter(call => call.url.includes('/messages')).at(-1)
  check(last.body.msg_id === undefined, 'expired window falls back to an active message')
  await bot.send({ groupId: 'G1', userId: 'U1', text: '你好', mention: 'U2' })
  const mentioned = calls.filter(call => call.url.includes('/messages')).at(-1)
  check(mentioned.body.content === '<qqbot-at-user id=\"U2\" /> 你好', 'group reply mentions the target')

  await bot.send({ userId: 'U1', text: '私聊', mention: 'U2' })
  const privateSend = calls.filter(call => call.url.includes('/messages')).at(-1)
  check(privateSend.body.content === '私聊', 'private reply ignores the mention')
}

{
  const calls = []
  const fetch = async (url, options = {}) => {
    calls.push({ url, body: options.body === undefined ? undefined : JSON.parse(options.body) })
    if (url.includes('getAppAccessToken')) return new Response('{"access_token":"T"}', { status: 200 })
    if (calls.filter(call => call.url.includes('/messages')).length === 1) {
      return new Response(JSON.stringify({ code: 304103, message: 'msg id expired' }), { status: 200 })
    }
    return new Response(JSON.stringify({ id: 'ok' }), { status: 200 })
  }
  const bot = createQQBot({ appId: '1', appSecret: SECRET, fetch, apiBase: 'https://api.example' })
  bot.handleWebhook(JSON.stringify({
    op: 0, t: 'C2C_MESSAGE_CREATE',
    d: { id: 'm', content: 'hi', author: { user_openid: 'U1' } },
  }))
  await bot.send({ userId: 'U1', text: '回复' })
  const sends = calls.filter(call => call.url.includes('/messages'))
  check(sends.length === 2 && sends[1].body.msg_id === undefined, 'expired msg_id retries as active')
}

{
  const fetch = async (url) => {
    if (url.includes('getAppAccessToken')) return new Response(JSON.stringify({ code: 100016, message: 'bad secret' }), { status: 200 })
    return new Response('{}', { status: 200 })
  }
  const bot = createQQBot({ appId: '1', appSecret: SECRET, fetch, apiBase: 'https://api.example' })
  let error
  try {
    await bot.send({ userId: 'U1', text: 'x' })
  } catch (caught) {
    error = caught
  }
  check(error !== undefined && /access_token failed/.test(error.message), 'token failure surfaces')
}

process.exit(failed === 0 ? 0 : 1)
