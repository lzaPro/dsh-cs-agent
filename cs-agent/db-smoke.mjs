// 数据库层自测：配置解析、迁移状态、schema 结构、约束与 append-only 保护。
// Run with: DSH_DB=1 node cs-agent/db-smoke.mjs
//
// 没设 DSH_DB 时整体跳过——不开数据库的部署不该因为这个测试变红。
//
// 所有写操作都在一个事务里执行，结束时统一回滚，所以可以反复跑，
// 也不会在库里斯留下任何测试数据。
import {
  DatabaseDisabledError,
  closePool,
  dbConfig,
  dbEnabled,
  describeDb,
  dbHealth,
  getPool,
  shortHash,
} from './db/pool.mjs'
import { migrate } from './db/migrate.mjs'

let failed = 0
const check = (ok, label, detail = '') => {
  if (!ok) failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail === '' ? '' : `: ${detail}`}`)
}

// ── 未启用数据库：必须是"什么都不做"，不是报错 ────────────────────────────
{
  const env = {}
  check(dbEnabled(env) === false, 'database is disabled by default')
  check(dbEnabled({ DSH_DB: '0' }) === false, '"0" keeps the database disabled')
  check(dbEnabled({ DSH_DB: '1' }) === true, '"1" enables the database')
  check(dbEnabled({ DSH_DB: 'on' }) === true, '"on" enables the database')

  let caught
  try {
    await getPool(env)
  } catch (error) {
    caught = error
  }
  check(caught instanceof DatabaseDisabledError, 'getPool refuses to work when disabled')

  const health = await dbHealth(env)
  check(health.enabled === false && health.reason === 'disabled', 'health reports disabled without connecting')
}

// ── 配置解析：不需要连库 ───────────────────────────────────────────────────
{
  const config = dbConfig({})
  check(config.port === 55432, 'default port avoids the usual 5432', String(config.port))
  check(config.database === 'cs_agent' && config.user === 'cs_agent', 'default database and user')
  check(config.max === 10, 'default pool size is bounded', String(config.max))

  const fromUrl = dbConfig({ DSH_DB_URL: 'postgres://u:p@h:6000/d' })
  check(fromUrl.connectionString === 'postgres://u:p@h:6000/d', 'DSH_DB_URL wins over discrete variables')
  check(fromUrl.max === 10, 'pool options still apply with a URL')

  const described = describeDb({ DSH_DB_URL: 'postgres://u:secret@h:6000/d' })
  check(described.includes('***') && !described.includes('secret'), 'describeDb redacts the password', described)
  check(describeDb({}).startsWith('postgres://cs_agent@'), 'describeDb works without a URL')

  let caught
  try {
    dbConfig({ DSH_DB_PORT: 'not-a-port' })
  } catch (error) {
    caught = error
  }
  check(caught?.code === 'DB_CONFIG', 'invalid port is rejected at parse time')

  check(shortHash('a', 'b') === shortHash('a', 'b'), 'shortHash is stable')
  check(shortHash('a', 'b') !== shortHash('b', 'a'), 'shortHash is order sensitive')
  check(shortHash('a', 'b').length === 32, 'shortHash is 32 hex chars')
}

// 没启用就到此为止。
if (!dbEnabled()) {
  console.log('SKIP database checks (set DSH_DB=1 to run them)')
  process.exitCode = failed === 0 ? 0 : 1
} else {
  await runDatabaseChecks()
}

/** 需要真实数据库的部分。 */
async function runDatabaseChecks() {
  // ── 迁移状态 ────────────────────────────────────────────────────────────
  const status = await migrate({ status: true, quiet: true })
  check(status.applied >= 1, 'at least one migration is applied', `applied=${status.applied}`)
  check(status.pending === 0, 'no migration is pending', `pending=${status.pending}`)

  const health = await dbHealth()
  check(health.ok === true, 'health check passes', health.message ?? '')
  check(health.migrations >= 1, 'health reports applied migrations', String(health.migrations))
  check(/^PostgreSQL/.test(String(health.version)), 'health reports the server version', String(health.version))

  const pool = await getPool()
  const client = await pool.connect()
  try {
    // ── schema 结构 ───────────────────────────────────────────────────────
    const expected = [
      'audit_log', 'conversations', 'inbound_dedupe', 'messages',
      'gateway_leases', 'inbox', 'outbox', 'schema_migrations',
      'ticket_events', 'tickets', 'usage_daily',
    ]
    const { rows: tables } = await client.query(
      "select table_name from information_schema.tables where table_schema = 'public'",
    )
    const present = new Set(tables.map(row => row.table_name))
    for (const name of expected) check(present.has(name), `table ${name} exists`)

    // 这三列是这次重构的核心：关联键、客户作用域、租户预留位。
    const { rows: columns } = await client.query(
      "select column_name from information_schema.columns where table_name = 'conversations'",
    )
    const cols = new Set(columns.map(row => row.column_name))
    check(cols.has('dsh_session_id'), 'conversations carries the DSH session link')
    check(cols.has('account_id'), 'conversations carries the account scope')
    check(cols.has('tenant_id'), 'conversations reserves tenant_id')

    const { rows: triggers } = await client.query(
      "select tgname from pg_trigger where not tgisinternal",
    )
    const triggerNames = new Set(triggers.map(row => row.tgname))
    check(triggerNames.has('audit_log_immutable'), 'audit_log is protected by a trigger')
    check(triggerNames.has('ticket_events_immutable'), 'ticket_events is protected by a trigger')

    // ── 约束行为：全部在一个事务里，最后回滚 ───────────────────────────────
    // 每条"预期被拒绝"的语句都必须包在 savepoint 里：Postgres 一旦某条语句
    // 报错，整个事务就进入 aborted 状态，后续断言会全部被 25P02 污染。
    await client.query('begin')
    const savepoint = 'sp'

    /** 断言语句成功。 */
    const accepts = async (label, sql, params = []) => {
      await client.query(`savepoint ${savepoint}`)
      try {
        await client.query(sql, params)
        await client.query(`release savepoint ${savepoint}`)
        check(true, label)
        return true
      } catch (error) {
        await client.query(`rollback to savepoint ${savepoint}`)
        check(false, label, `${error.code ?? ''} ${error.message ?? ''}`.slice(0, 120))
        return false
      }
    }

    /** 断言语句被拒绝，且错误码/信息符合预期。 */
    const rejects = async (label, matcher, sql, params = []) => {
      await client.query(`savepoint ${savepoint}`)
      let caught
      try {
        await client.query(sql, params)
      } catch (error) {
        caught = error
      }
      await client.query(`rollback to savepoint ${savepoint}`)
      if (caught === undefined) {
        check(false, label, 'expected a rejection, but the statement succeeded')
        return
      }
      const text = `${caught.code ?? ''} ${caught.message ?? ''}`
      check(matcher.test(text), label, text.slice(0, 120))
    }

    const { rows: created } = await client.query(
      `insert into conversations (external_key, channel, sender_id, dsh_session_id)
       values ('private:test-1', 'test', 'test-1', 'sess-test-1')
       returning id`,
    )
    const conversationId = created[0].id
    check(Number.isInteger(Number(conversationId)), 'a conversation can be inserted', String(conversationId))

    await rejects(
      'duplicate external_key is rejected',
      /duplicate key|23505/,
      "insert into conversations (external_key, channel) values ('private:test-1', 'test')",
    )

    await rejects(
      'unknown mode is rejected',
      /check constraint|23514/,
      "insert into conversations (external_key, channel, mode) values ('private:test-2', 'test', 'robot')",
    )

    // ── 消息 ───────────────────────────────────────────────────────────────
    await accepts(
      'a message can be inserted',
      "insert into messages (conversation_id, role, content, platform_msg_id) values ($1, 'user', 'hi', 'msg-1')",
      [conversationId],
    )

    await rejects(
      'duplicate platform_msg_id is rejected',
      /duplicate key|23505/,
      "insert into messages (conversation_id, role, content, platform_msg_id) values ($1, 'user', 'again', 'msg-1')",
      [conversationId],
    )

    await rejects(
      'unknown message role is rejected',
      /check constraint|23514/,
      "insert into messages (conversation_id, role, content) values ($1, 'robot', 'x')",
      [conversationId],
    )

    // ── 投递队列表 ─────────────────────────────────────────────────────────
    await accepts(
      'an outbox row can be inserted',
      `insert into outbox (external_key, channel, payload, idempotency_key)
       values ('private:test-1', 'test', '{"text":"hello"}', 'idem-1')`,
    )

    await rejects(
      'duplicate idempotency_key is rejected',
      /duplicate key|23505/,
      `insert into outbox (external_key, channel, payload, idempotency_key)
       values ('private:test-1', 'test', '{"text":"hello"}', 'idem-1')`,
    )

    await rejects(
      'unknown outbox state is rejected',
      /check constraint|23514/,
      `insert into outbox (external_key, channel, payload, idempotency_key, state)
       values ('k', 'test', '{}', 'idem-2', 'teleported')`,
    )

    // ── 入站去重 ───────────────────────────────────────────────────────────
    await accepts(
      'an inbound message can be recorded once',
      "insert into inbound_dedupe (platform_msg_id, channel) values ('m-1', 'test')",
    )
    await rejects(
      'inbound dedupe refuses the same platform message twice',
      /duplicate key|23505/,
      "insert into inbound_dedupe (platform_msg_id, channel) values ('m-1', 'test')",
    )

    // ── 工单与 append-only 流水 ────────────────────────────────────────────
    const { rows: ticketRows } = await client.query(
      `insert into tickets (account_id, incident_id, state, symptom)
       values ('acct-1', 'INC-1', 'open', '打不开')
       returning id`,
    )
    const ticketId = ticketRows[0].id
    check(Number.isInteger(Number(ticketId)), 'a ticket can be inserted', String(ticketId))

    await rejects(
      'unknown ticket state is rejected',
      /check constraint|23514/,
      "insert into tickets (incident_id, state) values ('INC-2', 'thinking')",
    )

    await accepts(
      'a ticket event can be appended',
      `insert into ticket_events (ticket_id, seq, kind, payload)
       values ($1, 1, 'created', '{"by":"test"}')`,
      [ticketId],
    )

    await rejects(
      'duplicate ticket event sequence is rejected',
      /duplicate key|23505/,
      `insert into ticket_events (ticket_id, seq, kind) values ($1, 1, 'created')`,
      [ticketId],
    )

    await rejects(
      'ticket events cannot be updated',
      /append-only/,
      "update ticket_events set kind = 'rewritten' where ticket_id = $1",
      [ticketId],
    )

    await rejects(
      'ticket events cannot be deleted',
      /append-only/,
      'delete from ticket_events where ticket_id = $1',
      [ticketId],
    )

    // 审计表同样不可改，但保留策略需要能删——只有显式开闸才允许。
    await accepts(
      'an audit entry can be written',
      "insert into audit_log (actor, action, target_type, target_id, target_account) values ('ops-1', 'read_logs', 'account', 'acct-1', 'acct-1')",
    )

    await rejects(
      'audit entries cannot be updated',
      /append-only/,
      "update audit_log set action = 'forged' where actor = 'ops-1'",
    )

    await rejects(
      'audit entries cannot be deleted without a purge grant',
      /append-only/,
      "delete from audit_log where actor = 'ops-1'",
    )

    await client.query("set local app.allow_purge = 'on'")
    const { rowCount } = await client.query("delete from audit_log where actor = 'ops-1'")
    check(rowCount === 1, 'a purge grant allows retention to delete audit rows', String(rowCount))

    // ── 用量表 ─────────────────────────────────────────────────────────────
    await accepts(
      'a usage row can be recorded',
      `insert into usage_daily (day, conversation_id, channel, turns, input_tokens)
       values (current_date, $1, 'test', 1, 100)`,
      [conversationId],
    )

    await rejects(
      'usage rows are unique per day and conversation',
      /duplicate key|23505/,
      `insert into usage_daily (day, conversation_id, channel) values (current_date, $1, 'test')`,
      [conversationId],
    )

    // ── 级联删除：会话删掉后消息不能留下孤儿 ───────────────────────────────
    // 用独立的会话测，避免和上面那些断言互相影响。
    const { rows: doomed } = await client.query(
      `insert into conversations (external_key, channel) values ('private:doomed', 'test') returning id`,
    )
    const doomedId = doomed[0].id
    await client.query(
      "insert into messages (conversation_id, role, content) values ($1, 'user', 'bye')",
      [doomedId],
    )
    await client.query('delete from conversations where id = $1', [doomedId])
    const { rows: orphan } = await client.query(
      'select count(*)::int as n from messages where conversation_id = $1',
      [doomedId],
    )
    check(orphan[0].n === 0, 'deleting a conversation cascades its messages')
  } finally {
    // 无论断言成功失败都回滚：测试不能留下数据。
    await client.query('rollback').catch(() => {})
    client.release()
    await closePool()
  }

  if (failed > 0) {
    console.log(`\n${failed} database check(s) failed`)
    process.exitCode = 1
  } else {
    console.log('\nall database checks passed')
  }
}
