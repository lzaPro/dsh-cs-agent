// 回复投递队列。
//
// 重构前 `emit()` 的做法是：把信封追加进 outbox.jsonl（只记账），然后 POST 一次
// 回复 webhook；失败就 warn 一句、返回 { delivered: false } 就结束了。也就是说
// **适配器抖一下，这条回复就永久丢了**，而客户那边还在等。
//
// 这一层把"记账"升级成"会重发"：
//   - 每条回复带一个幂等键，重复入队不会发两遍；
//   - 发送失败按指数退避重排，重试用尽标记为 dead（不再无限重试）；
//   - 状态落盘/落库，进程崩溃重启后接着发；
//   - 发送前先领（claim）成 sending 并加租约，避免两个实例同时发同一条。
//
// jsonl 审计日志仍然照写，那是"发过什么"的完整流水；这里的队列是"还欠什么"。
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { DEFAULT_RETRY, outboxKey, retryDelay } from './outbox-retry.js'
import { createPgOutbox } from './outbox-pg.js'

export { DEFAULT_RETRY, outboxKey, retryDelay }

/** 队列落在哪个文件：审计是 outbox.jsonl，状态放旁边。 */
function stateFileFor(file) {
  return /\.jsonl$/i.test(file)
    ? `${file.replace(/\.jsonl$/i, '')}-state.json`
    : `${file}.state.json`
}

/**
 * 建一个投递队列。
 *
 * @param {object} options
 * @param {'json'|'postgres'} [options.kind]
 * @param {string} [options.file] json 实现用（审计 jsonl 的路径）
 * @param {string} [options.stateFile] json 实现用：直接指定状态文件，省掉从 file 推导
 * @param {'outbox'|'inbox'} [options.table] postgres 实现用：状态存在哪张表
 * @param {object} [options.retry] 覆盖 DEFAULT_RETRY
 * @param {{warn: Function}} [options.logger]
 */
export function createOutbox(options = {}) {
  const kind = options.kind ?? 'json'
  if (kind === 'postgres') return createPgOutbox(options)
  return createJsonOutbox(options)
}

function createJsonOutbox(options) {
  // 入站队列没有审计 jsonl，只有状态，所以允许直接给 stateFile。
  const stateFile = options.stateFile
    ?? (typeof options.file === 'string' && options.file !== '' ? stateFileFor(options.file) : undefined)
  if (stateFile === undefined) throw new Error('outbox: json storage needs a file path or a stateFile')
  const retry = { ...DEFAULT_RETRY, ...options.retry }
  const logger = options.logger
  const now = options.now ?? (() => Date.now())
  /** idempotencyKey -> record */
  const records = new Map()
  /** 已发送的记录只留最近这些条，否则状态文件会无限长。 */
  const keepSent = 500

  let loading
  let chain = Promise.resolve()
  let dirty = false

  const iso = at => new Date(at).toISOString()

  const writeJson = async (target, value) => {
    await fs.mkdir(path.dirname(target), { recursive: true })
    const temp = `${target}.${process.pid}.${Date.now()}.tmp`
    const handle = await fs.open(temp, 'w', 0o600)
    try {
      await handle.writeFile(`${JSON.stringify(value, undefined, 2)}\n`, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await fs.rename(temp, target)
  }

  async function doLoad() {
    let raw
    try {
      raw = JSON.parse(await fs.readFile(stateFile, 'utf8'))
    } catch (error) {
      if (error?.code === 'ENOENT') return
      if (error instanceof SyntaxError) {
        // 状态文件坏了不该让整个网关起不来：从空队列开始，审计日志还在。
        logger?.warn?.(`channel-gateway: outbox state is corrupt, starting empty (${error.message})`)
        return
      }
      throw error
    }
    for (const record of Array.isArray(raw) ? raw : []) {
      if (typeof record?.idempotencyKey === 'string') records.set(record.idempotencyKey, record)
    }
  }

  function load() {
    loading ??= doLoad()
    return loading
  }

  function schedule() {
    chain = chain.then(async () => {
      if (!dirty) return
      dirty = false
      // 裁掉过旧的已发送记录：只保留最近 keepSent 条。
      const sent = [...records.values()].filter(record => record.state === 'sent')
      if (sent.length > keepSent) {
        sent.sort((left, right) => String(left.sentAt).localeCompare(String(right.sentAt)))
        for (const record of sent.slice(0, sent.length - keepSent)) records.delete(record.idempotencyKey)
      }
      await writeJson(stateFile, [...records.values()])
    })
    return chain
  }

  /** 到期可发的：待发、失败到期、以及租约过期的 sending。 */
  function due(at = now()) {
    return [...records.values()].filter(record => {
      if (record.state === 'sent' || record.state === 'dead') return false
      return new Date(record.nextAttemptAt).getTime() <= at
    })
  }

  return {
    kind: 'json',
    load,
    records,
    retry,
    delayFor: attempts => retryDelay(attempts, retry),
    async enqueue(envelope, extra = {}) {
      await load()
      // 调用方可以自带幂等键（入站队列用它，键必须只由消息身份决定，不能含时间戳）。
      const idempotencyKey = envelope.idempotencyKey ?? outboxKey(envelope)
      const existing = records.get(idempotencyKey)
      if (existing !== undefined) return { record: { ...existing }, duplicate: true }
      const at = now()
      const record = {
        id: idempotencyKey,
        idempotencyKey,
        payload: envelope,
        state: 'pending',
        attempts: 0,
        lastError: null,
        nextAttemptAt: iso(at + (extra.notBefore ?? 0)),
        createdAt: iso(at),
        sentAt: null,
      }
      records.set(idempotencyKey, record)
      dirty = true
      await schedule()
      return { record: { ...record }, duplicate: false }
    },
    /** 领一批到期的条目：标记 sending 并把租约推到 leaseMs 之后。 */
    async claim(limit = 20) {
      await load()
      const at = now()
      const batch = due(at).slice(0, Math.max(1, limit))
      const leased = []
      for (const record of batch) {
        record.state = 'sending'
        record.nextAttemptAt = iso(at + retry.leaseMs)
        leased.push({ ...record })
      }
      if (leased.length > 0) {
        dirty = true
        await schedule()
      }
      return leased
    },
    async markSent(idempotencyKey) {
      await load()
      const record = records.get(idempotencyKey)
      if (record === undefined) return undefined
      record.state = 'sent'
      record.sentAt = iso(now())
      record.lastError = null
      dirty = true
      await schedule()
      return { ...record }
    },
    async markFailed(idempotencyKey, error) {
      await load()
      const record = records.get(idempotencyKey)
      if (record === undefined) return undefined
      record.attempts += 1
      record.lastError = typeof error === 'string' ? error : String(error?.message ?? error)
      if (record.attempts >= retry.maxAttempts) {
        record.state = 'dead'
        record.nextAttemptAt = iso(now())
      } else {
        record.state = 'failed'
        record.nextAttemptAt = iso(now() + retryDelay(record.attempts, retry))
      }
      dirty = true
      await schedule()
      return { ...record }
    },
    async get(idempotencyKey) {
      await load()
      const record = records.get(idempotencyKey)
      return record === undefined ? undefined : { ...record }
    },
    async stats() {
      await load()
      const counts = { pending: 0, sending: 0, sent: 0, failed: 0, dead: 0 }
      for (const record of records.values()) counts[record.state] = (counts[record.state] ?? 0) + 1
      return { kind: 'json', total: records.size, ...counts, due: due(now()).length }
    },
    /** 死信：重试用尽、需要人看一眼的条目。 */
    async listDead(limit = 50) {
      await load()
      return [...records.values()]
        .filter(record => record.state === 'dead')
        .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))
        .slice(0, Math.max(1, limit))
        .map(record => ({ ...record }))
    },
    /**
     * 人工重放：把死信放回队列，计数清零。
     *
     * 只对 dead/failed 生效。已经发出去的（sent）不能再重放 —— 否则客户会看到
     * 两条一样的回复；正在发的（sending）也不能，那是别的进程手里的租约。
     */
    async replay(idempotencyKey) {
      await load()
      const record = records.get(idempotencyKey)
      if (record === undefined) return undefined
      if (record.state !== 'dead' && record.state !== 'failed') return { ...record, replayed: false }
      record.state = 'pending'
      record.attempts = 0
      record.lastError = null
      record.nextAttemptAt = iso(now())
      record.sentAt = null
      dirty = true
      await schedule()
      return { ...record, replayed: true }
    },
    async list(limit = 50) {
      await load()
      return [...records.values()]
        .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))
        .slice(0, Math.max(1, limit))
        .map(record => ({ ...record }))
    },
    async flush() {
      await chain
    },
  }
}
