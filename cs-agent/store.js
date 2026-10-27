// 会话状态的持久化层。
//
// 网关只跟这个接口打交道，底下可以是「一个 JSON 文件」也可以是 Postgres。
// 为什么要这一层：原来 `sessions.json` 是每次变化全量重写，两件事同时发生就会
// 互相覆盖；`load()` 还有个竞态（先置 loaded = true 再 await），并发首条消息
// 可能读到空表而重复建会话。接口化之后这两件事都能在实现里修掉。
//
// 选哪个实现是**显式**的，不看 DSH_DB：
//   - 默认 json —— 和重构前行为完全一致，老部署零影响
//   - 想用数据库时设 DSH_CS_STORE=postgres（或在插件配置里写 store: postgres）
// 分开的理由：DSH_DB 只表示"数据库这层能力打开了"，不该顺手改变会话存哪儿。
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { createPgStore } from './store-pg.js'
import { localDay, usageWindowStart } from './time.js'

const DEFAULT_DEDUPE_LIMIT = 2000

/**
 * 决定用哪种存储。
 * @param {{store?: string}} config 插件配置
 * @param {NodeJS.ProcessEnv} env 环境变量，测试时可注入
 * @returns {'json' | 'postgres'}
 */
export { localDay, usageWindowStart }

export function storeKind(config = {}, env = process.env) {
  const explicit = config?.store ?? env.DSH_CS_STORE
  if (explicit === undefined || explicit === null || explicit === '' || explicit === 'json') return 'json'
  if (explicit === 'postgres' || explicit === 'pg') return 'postgres'
  throw new Error(`store must be "json" or "postgres", got: ${explicit}`)
}

/**
 * 建一个存储实例。同步返回；真正的 IO 在 `load()` 里。
 *
 * 两套实现共用同一组成员：
 *   records   Map<key, record>   会话映射。网关直接拿这个引用并就地改记录。
 *   seen      Map<msgId, ISO>    去重窗口。网关直接读 has()。
 *   load()    幂等；并发调用只会真正读一次。
 *   save(r)   写入并持久化一条记录。
 *   remove(k) 删除一条记录。
 *   rememberSeen(id, at) 记一条去重，并把窗口裁到上限。
 *   flush()   等所有在途写入落地。
 *   close()   释放资源。
 *
 * @param {object} options
 * @param {'json'|'postgres'} [options.kind] 默认 json
 * @param {string} [options.dataFile] json 实现用
 * @param {string} [options.seenFile] json 实现用
 * @param {number} [options.dedupeLimit]
 * @param {object} [options.db] postgres 实现用
 * @param {{warn: Function}} [options.logger]
 */
export function createStore(options = {}) {
  const kind = options.kind ?? 'json'
  if (kind === 'postgres') return createPgStore(options)
  return createJsonStore(options)
}

/** 原来的文件存储：行为保持兼容，但写入串行化，并加了 fsync。 */
function createJsonStore(options) {
  const { dataFile, seenFile } = options
  // 消息存档与用量单独落文件：会话映射是"当前状态"，消息是"追加日志"，
  // 两者写频率和保留策略都不一样，混在一个文件里会让每次都全量重写。
  const messagesFile = `${dataFile.replace(/\.json$/i, '')}-messages.jsonl`
  const usageFile = `${dataFile.replace(/\.json$/i, '')}-usage.json`
  const dedupeLimit = options.dedupeLimit ?? DEFAULT_DEDUPE_LIMIT
  const records = new Map()
  const seen = new Map()

  /** load 的并发保护：并发调用共享同一次读取，而不是各读一遍。 */
  let loading
  /** 写入串行化：同一时刻只有一次写盘，两次 temp+rename 不会互相覆盖。 */
  let chain = Promise.resolve()
  let recordsDirty = false
  let seenDirty = false

  const writeJson = async (file, value) => {
    await fs.mkdir(path.dirname(file), { recursive: true })
    const temp = `${file}.${process.pid}.${Date.now()}.tmp`
    const text = `${JSON.stringify(value, undefined, 2)}\n`
    const handle = await fs.open(temp, 'w', 0o600)
    try {
      await handle.writeFile(text, 'utf8')
      // 没有 fsync 的话，断电后可能留下 rename 成功但内容不全的文件。
      await handle.sync()
    } finally {
      await handle.close()
    }
    await fs.rename(temp, file)
  }

  const readJson = async file => {
    try {
      return JSON.parse(await fs.readFile(file, 'utf8'))
    } catch (error) {
      if (error?.code === 'ENOENT') return undefined
      throw error
    }
  }

  async function doLoad() {
    const stored = await readJson(dataFile)
    for (const [key, record] of Object.entries(stored ?? {})) {
      if (typeof record?.sessionId === 'string') records.set(key, record)
    }
    const ids = await readJson(seenFile)
    if (Array.isArray(ids)) {
      for (const entry of ids) {
        if (Array.isArray(entry) && typeof entry[0] === 'string') seen.set(entry[0], String(entry[1] ?? ''))
      }
    }
  }

  /** 把待写的东西落盘。并发调用会排在同一个写链上，先到的写完，后到的看到已清空就跳过。 */
  function schedule() {
    chain = chain.then(async () => {
      if (recordsDirty) {
        recordsDirty = false
        await writeJson(dataFile, Object.fromEntries(records))
      }
      if (seenDirty) {
        seenDirty = false
        await writeJson(seenFile, [...seen.entries()])
      }
    })
    return chain
  }

  // 用内部函数而不是 this.load()：接口方法被解构出去时 this 会丢。
  function load() {
    loading ??= doLoad()
    return loading
  }

  return {
    kind: 'json',
    records,
    seen,
    load,
    async save(record) {
      records.set(record.key, record)
      recordsDirty = true
      await schedule()
    },
    async remove(key) {
      records.delete(key)
      recordsDirty = true
      await schedule()
    },
    async rememberSeen(messageId, at) {
      seen.set(messageId, at)
      while (seen.size > dedupeLimit) seen.delete(seen.keys().next().value)
      seenDirty = true
      await schedule()
    },
    /** 追加一条消息。用 appendFile 而不是整份重写：消息只增不改。 */
    async saveMessage(key, message) {
      const line = JSON.stringify({ key, ...message, createdAt: message.createdAt ?? new Date().toISOString() })
      // 挂在同一条写链上：flush() 才能保证"这条已经落盘"。
      chain = chain.then(async () => {
        await fs.mkdir(path.dirname(messagesFile), { recursive: true })
        await fs.appendFile(messagesFile, `${line}\n`, 'utf8')
      })
      await chain
    },
    /** 读某个会话最近 limit 条消息，按时间正序返回。 */
    async listMessages(key, limit = 50) {
      const text = await fs.readFile(messagesFile, 'utf8').catch(error => {
        if (error?.code === 'ENOENT') return ''
        throw error
      })
      const matched = []
      for (const line of text.split('\n')) {
        if (line.trim() === '') continue
        let entry
        try {
          entry = JSON.parse(line)
        } catch {
          // 半行（上次写到一半就崩了）跳过，别让整个历史读不出来。
          continue
        }
        if (entry?.key !== key) continue
        matched.push(entry)
      }
      return matched.slice(-limit)
    },
    /** 按天累加用量与成本。 */
    async bumpUsage(key, usage) {
      const day = usage.day ?? localDay()
      const stored = (await readJson(usageFile)) ?? {}
      const id = `${day}|${key}`
      const current = stored[id] ?? {
        day,
        key,
        turns: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costMicros: 0,
      }
      current.turns += usage.turns ?? 1
      current.inputTokens += usage.inputTokens ?? 0
      current.outputTokens += usage.outputTokens ?? 0
      current.cacheReadTokens += usage.cacheReadTokens ?? 0
      current.cacheWriteTokens += usage.cacheWriteTokens ?? 0
      current.costMicros += usage.costMicros ?? 0
      stored[id] = current
      chain = chain.then(() => writeJson(usageFile, stored))
      await chain
      return current
    },
    /**
     * 读用量报表。
     *
     * @param {{key?: string, days?: number, now?: Date}} [query] - 过滤条件；`days` 为最近若干天（含今天）。
     * @returns {Promise<object[]>} 按日期倒序的用量行。
     */
    async listUsage(query = {}) {
      const stored = (await readJson(usageFile)) ?? {}
      const from = usageWindowStart(query.days, query.now)
      const rows = []
      for (const row of Object.values(stored)) {
        if (typeof row?.day !== 'string') continue
        if (from !== undefined && row.day < from) continue
        if (query.key !== undefined && row.key !== query.key) continue
        rows.push({ ...row, costMicros: row.costMicros ?? 0 })
      }
      rows.sort((left, right) => (left.day === right.day ? 0 : left.day < right.day ? 1 : -1))
      return rows
    },
    /**
     * 彻底删除一个会话的业务数据：映射 + 消息 + 用量。
     *
     * 和 `remove` 的区别：`remove` 只摘映射（客户下次来消息会重建会话，
     * 历史还在），这里是"这个客户的数据不要了"，不可逆。
     */
    async purgeConversation(key) {
      records.delete(key)
      recordsDirty = true
      // 消息是 jsonl，只能按 key 过滤后整份重写。删除不频繁，这样够用。
      chain = chain.then(async () => {
        const text = await fs.readFile(messagesFile, 'utf8').catch(error => {
          if (error?.code === 'ENOENT') return ''
          throw error
        })
        const kept = []
        let removed = 0
        for (const line of text.split('\n')) {
          if (line.trim() === '') continue
          let entry
          try {
            entry = JSON.parse(line)
          } catch {
            // 坏行保留不了也无所谓，反正本来就读不出来。
            continue
          }
          if (entry?.key === key) {
            removed += 1
            continue
          }
          kept.push(line)
        }
        if (removed > 0) {
          const body = kept.length === 0 ? '' : `${kept.join('\n')}\n`
          const temp = `${messagesFile}.${process.pid}.${Date.now()}.tmp`
          const handle = await fs.open(temp, 'w', 0o600)
          try {
            await handle.writeFile(body, 'utf8')
            await handle.sync()
          } finally {
            await handle.close()
          }
          await fs.rename(temp, messagesFile)
        }
        // 用量表里这个会话的所有日期行一起清掉。
        const usage = (await readJson(usageFile)) ?? {}
        let usageRemoved = 0
        for (const id of Object.keys(usage)) {
          if (id.endsWith(`|${key}`)) {
            delete usage[id]
            usageRemoved += 1
          }
        }
        if (usageRemoved > 0) await writeJson(usageFile, usage)
        return removed
      })
      const removed = await chain
      await schedule()
      return removed
    },
    async flush() {
      await chain
    },
    async close() {
      await chain
    },
  }
}
