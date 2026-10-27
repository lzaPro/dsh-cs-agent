// 投递队列的数据库实现。
//
// 与 outbox.js 的 json 实现共用同一套语义（幂等键、租约、退避、dead 上限），差别只在
// 状态存哪儿。用数据库的场合是"多实例 + 进程随时会被杀"，所以领取用
// `for update skip locked`，两个实例不会同时发同一条。
//
// 回复投递（outbox 表）和入站受理（inbox 表）共用这份代码：两者都是"持久队列 + 幂等入队 +
// 领取租约 + 指数退避 + 死信"，差别只有表名。表名走白名单，不会有任何外部字符串拼进 SQL。
import { dbEnabled, getPool, withTransaction } from './db/pool.mjs'
import { DEFAULT_RETRY, outboxKey, retryDelay } from './outbox-retry.js'

const LEASE = `now() + ($1::int * interval '1 millisecond')`

const TABLES = new Set(['outbox', 'inbox'])

const insertSql = table => `
  insert into ${table} (
    external_key, channel, payload, idempotency_key, state, attempts, next_attempt_at
  ) values ($1, $2, $3::jsonb, $4, 'pending', 0, now() + ($5::int * interval '1 millisecond'))
  on conflict (idempotency_key) do nothing
  returning *
`

const claimSql = table => `
  update ${table}
     set state = 'sending',
         next_attempt_at = ${LEASE}
   where id in (
     select id from ${table}
      where state in ('pending', 'failed', 'sending')
        and next_attempt_at <= now()
      order by next_attempt_at
      limit $2
      for update skip locked
   )
  returning *
`

const RECORD_COLUMNS = `
  id, conversation_id, external_key, channel, payload, idempotency_key,
  state, attempts, last_error, next_attempt_at, created_at, sent_at
`

function toIso(value) {
  return value === null || value === undefined ? null : new Date(value).toISOString()
}

function rowToRecord(row) {
  return {
    id: String(row.id),
    idempotencyKey: row.idempotency_key,
    payload: row.payload,
    state: row.state,
    attempts: Number(row.attempts),
    lastError: row.last_error ?? null,
    nextAttemptAt: toIso(row.next_attempt_at),
    createdAt: toIso(row.created_at),
    sentAt: toIso(row.sent_at),
  }
}

/**
 * @param {object} options
 * @param {'outbox'|'inbox'} [options.table] 状态存在哪张表，默认 outbox
 * @param {object} [options.retry] 覆盖 DEFAULT_RETRY
 * @param {{warn: Function}} [options.logger]
 */
export function createPgOutbox(options = {}) {
  const table = TABLES.has(options.table) ? options.table : 'outbox'
  const retry = { ...DEFAULT_RETRY, ...options.retry }
  const logger = options.logger
  const now = options.now ?? (() => Date.now())
  const INSERT = insertSql(table)
  const CLAIM = claimSql(table)
  let loaded
  let pool

  async function doLoad() {
    if (!dbEnabled()) {
      throw new Error(`${table}: postgres storage needs the database to be enabled (set DSH_DB=1 and run ./scripts/db-up.sh)`)
    }
    pool = await getPool()
    // 连一次，把"库没起来"的失败提前到启动阶段，而不是等到要投递/受理的时候。
    await pool.query(`select 1 from ${table} limit 1`)
  }

  function load() {
    loaded ??= doLoad()
    return loaded
  }

  async function query(text, params) {
    await load()
    return pool.query(text, params)
  }

  // 内部函数而不是 this.get()：方法被解构出去时 this 会丢。
  async function getRecord(idempotencyKey) {
    const found = await query(
      `select ${RECORD_COLUMNS} from ${table} where idempotency_key = $1`,
      [idempotencyKey],
    )
    return found.rowCount === 0 ? undefined : rowToRecord(found.rows[0])
  }

  return {
    kind: 'postgres',
    table,
    load,
    retry,
    delayFor: attempts => retryDelay(attempts, retry),
    async enqueue(envelope, extra = {}) {
      // 与 json 实现一致：调用方给了幂等键就用它。
      const idempotencyKey = envelope.idempotencyKey ?? outboxKey(envelope)
      const inserted = await query(INSERT, [
        String(envelope.key ?? ''),
        String(envelope.channel ?? 'unknown'),
        JSON.stringify(envelope),
        idempotencyKey,
        extra.notBefore ?? 0,
      ])
      if (inserted.rowCount > 0) return { record: rowToRecord(inserted.rows[0]), duplicate: false }
      const existing = await query(
        `select ${RECORD_COLUMNS} from ${table} where idempotency_key = $1`,
        [idempotencyKey],
      )
      return { record: rowToRecord(existing.rows[0]), duplicate: true }
    },
    async claim(limit = 20) {
      const claimed = await query(CLAIM, [retry.leaseMs, Math.max(1, limit)])
      return claimed.rows.map(rowToRecord)
    },
    async markSent(idempotencyKey) {
      const done = await query(
        `update ${table}
            set state = 'sent', sent_at = now(), last_error = null
          where idempotency_key = $1
          returning ${RECORD_COLUMNS}`,
        [idempotencyKey],
      )
      return done.rowCount === 0 ? undefined : rowToRecord(done.rows[0])
    },
    async markFailed(idempotencyKey, error) {
      const message = typeof error === 'string' ? error : String(error?.message ?? error)
      // 行锁住再算：退避时间要基于**当前**的 attempts，SQL 里算不清楚抖动。
      return withTransaction(async client => {
        const found = await client.query(
          `select ${RECORD_COLUMNS} from ${table} where idempotency_key = $1 for update`,
          [idempotencyKey],
        )
        if (found.rowCount === 0) return undefined
        const attempts = Number(found.rows[0].attempts) + 1
        const dead = attempts >= retry.maxAttempts
        const nextAt = new Date(dead ? now() : now() + retryDelay(attempts, retry))
        const updated = await client.query(
          `update ${table}
              set attempts = $2, state = $3, last_error = $4, next_attempt_at = $5
            where idempotency_key = $1
            returning ${RECORD_COLUMNS}`,
          [idempotencyKey, attempts, dead ? 'dead' : 'failed', message, nextAt],
        )
        if (dead) logger?.warn?.(`channel-gateway: giving up on ${table} item after ${attempts} attempts`)
        return rowToRecord(updated.rows[0])
      })
    },
    async get(idempotencyKey) {
      return getRecord(idempotencyKey)
    },
    async stats() {
      const grouped = await query(`select state, count(*)::int as count from ${table} group by state`)
      const counts = { pending: 0, sending: 0, sent: 0, failed: 0, dead: 0 }
      let total = 0
      for (const row of grouped.rows) {
        counts[row.state] = row.count
        total += row.count
      }
      const due = await query(
        `select count(*)::int as count from ${table}
          where state in ('pending', 'failed', 'sending') and next_attempt_at <= now()`,
      )
      return { kind: 'postgres', table, total, ...counts, due: due.rows[0].count }
    },
    /** 死信：重试用尽、需要人看一眼的条目。 */
    async listDead(limit = 50) {
      const rows = await query(
        `select ${RECORD_COLUMNS} from ${table} where state = 'dead' order by created_at desc limit $1`,
        [Math.max(1, limit)],
      )
      return rows.rows.map(rowToRecord)
    },
    /**
     * 人工重放：把死信放回队列，计数清零。
     *
     * `state in ('dead','failed')` 这个条件写在 SQL 里而不是先查再改：
     * 两个运维同时点"重放"时，只有一个能改到行，另一个看到 0 行不会误报成功。
     */
    async replay(idempotencyKey) {
      const updated = await query(
        `update ${table}
            set state = 'pending', attempts = 0, last_error = null,
                next_attempt_at = now(), sent_at = null
          where idempotency_key = $1 and state in ('dead', 'failed')
      returning ${RECORD_COLUMNS}`,
        [idempotencyKey],
      )
      if (updated.rows.length > 0) return { ...rowToRecord(updated.rows[0]), replayed: true }
      const existing = await getRecord(idempotencyKey)
      return existing === undefined ? undefined : { ...existing, replayed: false }
    },
    async list(limit = 50) {
      const rows = await query(
        `select ${RECORD_COLUMNS} from ${table} order by created_at desc limit $1`,
        [Math.max(1, limit)],
      )
      return rows.rows.map(rowToRecord)
    },
    async flush() {
      if (loaded !== undefined) await loaded.catch(() => {})
    },
  }
}
