// 入站受理队列。
//
// 重构前 `inbound()` 是同步做完所有事才返回的：归一化 → 去重 → 限流 → 下载附件 →
// 建 DSH 会话 → 落盘 → 唤醒模型。中间任何一步抛错，这条客户消息就没了 —— 平台
// 不一定会重投，客户那边看到的是"发了没反应"。
//
// 这一层把顺序换成"先收下，再处理"：
//   1. 校验 + 去重 + 限流（这些必须在受理前做，否则脏数据会进队列）；
//   2. 落进队列（数据库模式进 inbox 表，json 模式进状态文件），**这一步成功就算收下**；
//   3. 立刻在同一请求里试一次处理；成功就直接返回，用户感知不到队列存在；
//   4. 失败不再抛给调用方，而是留给后台按指数退避重试，重试用尽标 dead。
//
// 队列本身复用 outbox 的实现（幂等键、领取租约、退避、死信完全同构），差别只在
// 表名/状态文件。这样两套队列只有一份测试过的并发逻辑。
import { createOutbox, DEFAULT_RETRY, retryDelay } from './outbox.js'
import { shortHash } from './db/pool.mjs'

/** json 模式下状态文件放在会话文件旁边。 */
function stateFileFor(file) {
  return /\.jsonl$/i.test(file)
    ? `${file.replace(/\.jsonl$/i, '')}-inbox-state.json`
    : `${file.replace(/\.json$/i, '')}-inbox-state.json`
}

/**
 * 建一个入站队列。
 *
 * @param {object} options
 * @param {'json'|'postgres'} [options.kind]
 * @param {string} [options.file] json 实现用：状态文件命名的基准路径
 * @param {object} [options.retry] 覆盖 DEFAULT_RETRY
 * @param {{warn: Function}} [options.logger]
 */
export function createInbox(options = {}) {
  const kind = options.kind ?? 'json'
  const retry = { ...DEFAULT_RETRY, ...options.retry }
  if (kind === 'postgres') return createOutbox({ kind: 'postgres', table: 'inbox', retry, logger: options.logger })
  const file = options.file
  if (typeof file !== 'string' || file === '') throw new Error('inbox: json storage needs a file path')
  return createOutbox({ kind: 'json', stateFile: stateFileFor(file), retry, logger: options.logger })
}

/**
 * 一条入站消息的幂等键。
 *
 * 平台给了 messageId 就用它（同一条消息重投不会进两次队列）；没给就用内容指纹 ——
 * 这种情况无法区分"用户真的又发了一遍同样的字"和"平台重投"，选保守的一边：
 * 内容相同视为同一条。想放开就把 `dedupeByContent` 设 false。
 */
export function inboxKey(message, options = {}) {
  const id = message.messageId
  if (id !== undefined && id !== null && id !== '') return `${message.channel}:msg:${id}`
  if (options.dedupeByContent === false) return `${message.channel}:at:${Date.now()}:${Math.random()}`
  const parts = [
    message.channel,
    message.senderId,
    message.groupId ?? '',
    message.text ?? '',
    (message.attachments ?? []).map(item => `${item.mediaType}:${item.data?.length ?? 0}`).join(','),
  ]
  // 必须哈希：指纹里的 \u0000 分隔符不能进 jsonb（PostgreSQL 会报 22P05
  // "\u0000 cannot be converted to text"），而幂等键要原样写进 payload。
  return `${message.channel}:content:${shortHash(parts.join('\u0000'))}`
}

export { DEFAULT_RETRY, retryDelay }
