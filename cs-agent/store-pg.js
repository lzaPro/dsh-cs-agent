// Postgres 版的会话存储：一个会话一行，一条入站去重一行。
//
// 相对于 JSON 文件的实质差别：
//   - 只有变化的那一行被写，不再整表重写；
//   - 唯一约束由数据库兜底（external_key），进程崩了也不会写出半个文件；
//   - 去重窗口不再"重启即失忆"，inbound_dedupe 里的记录是持久的。
//
// 这个文件**不**在顶层 import('pg')：不用数据库的部署连依赖都不需要装。
import { dbEnabled, getPool } from './db/pool.mjs'
import { localDay, usageWindowStart } from './time.js'

const DEFAULT_DEDUPE_LIMIT = 2000
/** 每插入这么多条去重记录，才做一次窗口裁剪，避免每条消息都跑一次 delete。 */
const TRIM_EVERY = 64
/** 网关的入站去重不区分渠道，这里统一用一个命名空间。 */
const DEDUPE_CHANNEL = 'gateway'

const iso = value => (value instanceof Date ? value.toISOString() : value === null ? null : String(value))

/**
 * 把一行 conversations 还原成网关认识的 record。
 *
 * 注意 `groupId` 必须是 null 而不是 undefined：网关里用 `record.groupId !== undefined`
 * 判断"是不是群聊"，改成 undefined 会让私有会话也走进群聊分支。
 */
function rowToRecord(row) {
  const record = {
    sessionId: row.dsh_session_id,
    key: row.external_key,
    channel: row.channel,
    groupId: row.group_id ?? null,
    groupName: row.group_name ?? null,
    senderName: row.sender_name ?? null,
    label: row.label ?? null,
    title: row.title ?? null,
    token: row.access_token ?? null,
    senderId: row.sender_id ?? null,
    createdAt: iso(row.created_at),
    lastSeenAt: iso(row.last_seen_at),
    mode: row.mode,
    modeChangedAt: iso(row.mode_changed_at),
  }
  // 这两个字段在原文件里是"有则出现、没有则不存在"，保持同样的语义。
  if (row.archived_at !== null && row.archived_at !== undefined) record.archivedAt = iso(row.archived_at)
  if (row.last_sender_id !== null && row.last_sender_id !== undefined) record.lastSenderId = row.last_sender_id
  return record
}

/** record → 插入/更新语句的参数。字段顺序与 UPSERT_SQL 的占位符一一对应。 */
function recordParams(record) {
  return [
    record.key,
    record.channel ?? 'unknown',
    record.groupId ?? null,
    record.groupName ?? null,
    record.senderId ?? null,
    record.senderName ?? null,
    record.label ?? null,
    record.title ?? null,
    record.token ?? null,
    record.sessionId ?? null,
    record.mode ?? 'ai',
    record.createdAt ?? null,
    record.lastSeenAt ?? null,
    record.modeChangedAt ?? null,
    record.archivedAt ?? null,
    record.lastSenderId ?? null,
  ]
}

const UPSERT_SQL = `
insert into conversations (
  external_key, channel, group_id, group_name, sender_id, sender_name,
  label, title, access_token, dsh_session_id, mode,
  created_at, last_seen_at, mode_changed_at, archived_at, last_sender_id
) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
          coalesce($12::timestamptz, now()), coalesce($13::timestamptz, now()), $14, $15, $16)
on conflict (external_key) do update set
  channel         = excluded.channel,
  group_id        = excluded.group_id,
  group_name      = excluded.group_name,
  sender_id       = excluded.sender_id,
  sender_name     = excluded.sender_name,
  label           = excluded.label,
  title           = excluded.title,
  access_token    = excluded.access_token,
  dsh_session_id  = excluded.dsh_session_id,
  mode            = excluded.mode,
  last_seen_at    = excluded.last_seen_at,
  mode_changed_at = excluded.mode_changed_at,
  archived_at     = excluded.archived_at,
  last_sender_id  = excluded.last_sender_id
returning id`

/** 裁掉比窗口更老的去重记录。 */
const TRIM_SQL = `
delete from inbound_dedupe
 where channel = $1
   and platform_msg_id not in (
     select platform_msg_id from inbound_dedupe
      where channel = $1
      order by seen_at desc
      limit $2
   )`

/**
 * 写一条消息。
 *
 * 用 insert ... select 直接从 conversations 取 id，避免在内存里维护一张
 * external_key → id 的缓存（那又得在删除/重建时同步，很容易脏）。会话不存在
 * 时影响 0 行，调用方按"没归档成功"处理即可。
 */
const INSERT_MESSAGE_SQL = `
insert into messages (
  conversation_id, dsh_session_id, role, content,
  platform_msg_id, trace_id, input_tokens, output_tokens,
  total_tokens, cache_read_tokens, cache_write_tokens,
  model, provider, cost_micros, created_at
)
select id, dsh_session_id, $2, $3, $4, $5, $6, $7, $8, $9, $10,
       $11, $12, $13, coalesce($14::timestamptz, now())
  from conversations
 where external_key = $1`

const LIST_MESSAGES_SQL = `
select m.role, m.content, m.platform_msg_id, m.trace_id,
       m.input_tokens, m.output_tokens, m.cache_read_tokens, m.cache_write_tokens,
       m.model, m.provider, m.cost_micros, m.created_at
  from messages m
  join conversations c on c.id = m.conversation_id
 where c.external_key = $1
 order by m.created_at desc, m.id desc
 limit $2`

const LIST_USAGE_SQL = `
select to_char(u.day, 'YYYY-MM-DD') as day,
       c.external_key as key,
       u.turns, u.input_tokens, u.output_tokens,
       u.cache_read_tokens, u.cache_write_tokens, u.cost_micros
  from usage_daily u
  join conversations c on c.id = u.conversation_id
 where ($1::text is null or c.external_key = $1)
   and ($2::date is null or u.day >= $2::date)
 order by u.day desc, c.external_key
 limit $3`

const BUMP_USAGE_SQL = `
insert into usage_daily (
  day, conversation_id, channel, turns,
  input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_micros
)
select coalesce($2::date, current_date), id, channel, $3, $4, $5, $6, $7, $8
  from conversations
 where external_key = $1
on conflict (day, conversation_id) do update set
  turns              = usage_daily.turns + excluded.turns,
  input_tokens       = usage_daily.input_tokens + excluded.input_tokens,
  output_tokens      = usage_daily.output_tokens + excluded.output_tokens,
  cache_read_tokens  = usage_daily.cache_read_tokens + excluded.cache_read_tokens,
  cache_write_tokens = usage_daily.cache_write_tokens + excluded.cache_write_tokens,
  cost_micros        = usage_daily.cost_micros + excluded.cost_micros
returning to_char(day, 'YYYY-MM-DD') as day, turns, input_tokens, output_tokens,
          cache_read_tokens, cache_write_tokens, cost_micros`

export function createPgStore(options = {}) {
  const dedupeLimit = options.dedupeLimit ?? DEFAULT_DEDUPE_LIMIT
  const logger = options.logger
  const records = new Map()
  const seen = new Map()

  let loading
  let pool
  let insertsSinceTrim = 0

  async function doLoad() {
    if (!dbEnabled()) {
      throw new Error(
        'store: postgres needs the database to be enabled (set DSH_DB=1 and run ./scripts/db-up.sh)',
      )
    }
    pool = await getPool()

    const { rows } = await pool.query(
      'select * from conversations order by last_seen_at desc nulls last',
    )
    for (const row of rows) {
      if (typeof row.dsh_session_id !== 'string') continue
      records.set(row.external_key, rowToRecord(row))
    }

    // 只把最近的 N 条放回内存：去重窗口是个窗口，不是一份完整历史。
    const seenRows = await pool.query(
      `select platform_msg_id, max(seen_at) as seen_at
         from inbound_dedupe
        group by platform_msg_id
        order by max(seen_at) desc
        limit $1`,
      [dedupeLimit],
    )
    for (const row of seenRows.rows) {
      seen.set(row.platform_msg_id, iso(row.seen_at))
    }
  }

  // 用内部函数而不是 this.load()：接口方法被解构出去时 this 会丢。
  function load() {
    loading ??= doLoad()
    return loading
  }

  return {
    kind: 'postgres',
    records,
    seen,
    load,
    async save(record) {
      if (pool === undefined) await load()
      records.set(record.key, record)
      await pool.query(UPSERT_SQL, recordParams(record))
    },
    async remove(key) {
      if (pool === undefined) await load()
      records.delete(key)
      await pool.query('delete from conversations where external_key = $1', [key])
    },
    /**
     * 彻底删除一个会话的业务数据。
     *
     * `messages` 和 `usage_daily` 都是 `on delete cascade`，删会话行就一起走；
     * 但 `inbound_dedupe` 不在级联里（它按平台消息 id 存在），故意保留 ——
     * 重放同一条平台消息不该因为客户数据被删就重新处理一遍。
     */
    async purgeConversation(key) {
      if (pool === undefined) await load()
      records.delete(key)
      const { rowCount } = await pool.query('delete from conversations where external_key = $1', [key])
      return rowCount
    },
    async rememberSeen(messageId, at) {
      if (pool === undefined) await load()
      seen.set(messageId, at)
      while (seen.size > dedupeLimit) seen.delete(seen.keys().next().value)
      await pool.query(
        `insert into inbound_dedupe (platform_msg_id, channel, seen_at)
         values ($1, $2, coalesce($3::timestamptz, now()))
         on conflict (platform_msg_id, channel) do update set seen_at = excluded.seen_at`,
        [messageId, DEDUPE_CHANNEL, at ?? null],
      )
      insertsSinceTrim += 1
      if (insertsSinceTrim >= TRIM_EVERY) {
        insertsSinceTrim = 0
        // 裁剪失败不该影响消息处理：下一轮再试。
        await pool.query(TRIM_SQL, [DEDUPE_CHANNEL, dedupeLimit]).catch(error => {
          logger?.warn?.(`channel-gateway: dedupe trim failed: ${error.message}`)
        })
      }
    },
    async saveMessage(key, message) {
      if (pool === undefined) await load()
      const { rowCount } = await pool.query(INSERT_MESSAGE_SQL, [
        key,
        message.role,
        message.content,
        message.platformMsgId ?? null,
        message.traceId ?? null,
        message.inputTokens ?? null,
        message.outputTokens ?? null,
        message.totalTokens ?? null,
        message.cacheReadTokens ?? null,
        message.cacheWriteTokens ?? null,
        message.model ?? null,
        message.provider ?? null,
        message.costMicros ?? null,
        message.createdAt ?? null,
      ])
      return rowCount > 0
    },
    async listMessages(key, limit = 50) {
      if (pool === undefined) await load()
      const { rows } = await pool.query(LIST_MESSAGES_SQL, [key, limit])
      return rows.reverse().map(row => ({
        role: row.role,
        content: row.content,
        ...(row.platform_msg_id === null ? {} : { platformMsgId: row.platform_msg_id }),
        ...(row.trace_id === null ? {} : { traceId: row.trace_id }),
        ...(row.input_tokens === null ? {} : { inputTokens: row.input_tokens }),
        ...(row.output_tokens === null ? {} : { outputTokens: row.output_tokens }),
        ...(row.cache_read_tokens === null ? {} : { cacheReadTokens: row.cache_read_tokens }),
        ...(row.cache_write_tokens === null ? {} : { cacheWriteTokens: row.cache_write_tokens }),
        ...(row.model === null ? {} : { model: row.model }),
        ...(row.provider === null ? {} : { provider: row.provider }),
        ...(row.cost_micros === null ? {} : { costMicros: Number(row.cost_micros) }),
        createdAt: iso(row.created_at),
      }))
    },
    async bumpUsage(key, usage) {
      if (pool === undefined) await load()
      const { rows } = await pool.query(BUMP_USAGE_SQL, [
        key,
        usage.day ?? localDay(),
        usage.turns ?? 1,
        usage.inputTokens ?? 0,
        usage.outputTokens ?? 0,
        usage.cacheReadTokens ?? 0,
        usage.cacheWriteTokens ?? 0,
        usage.costMicros ?? 0,
      ])
      const row = rows[0]
      if (row === undefined) return undefined
      // pg 把 bigint 读成字符串、date 读成 Date：统一成与 json 实现同一种形状，
      // 免得调用方到处 Number()/toISOString()。
      return {
        day: row.day,
        turns: Number(row.turns),
        inputTokens: Number(row.input_tokens),
        outputTokens: Number(row.output_tokens),
        cacheReadTokens: Number(row.cache_read_tokens),
        cacheWriteTokens: Number(row.cache_write_tokens),
        costMicros: Number(row.cost_micros),
      }
    },
    /**
     * 读用量报表。
     *
     * @param {{key?: string, days?: number, now?: Date, limit?: number}} [query] - 过滤条件。
     * @returns {Promise<object[]>} 按日期倒序的用量行。
     */
    async listUsage(query = {}) {
      if (pool === undefined) await load()
      const from = usageWindowStart(query.days, query.now)
      const { rows } = await pool.query(LIST_USAGE_SQL, [
        query.key ?? null,
        from ?? null,
        query.limit ?? 1000,
      ])
      return rows.map(row => ({
        day: row.day,
        key: row.key,
        turns: Number(row.turns),
        inputTokens: Number(row.input_tokens),
        outputTokens: Number(row.output_tokens),
        cacheReadTokens: Number(row.cache_read_tokens),
        cacheWriteTokens: Number(row.cache_write_tokens),
        costMicros: Number(row.cost_micros),
      }))
    },
    async flush() {
      if (pool !== undefined) await pool.query('select 1')
    },
    async close() {
      // 连接池是进程级共享的（db/pool.mjs 单例），关它等于把别人的连接也关了。
      // 真正的关闭由 db/pool.mjs 的 closePool() 在进程收尾时统一做。
    },
  }
}
