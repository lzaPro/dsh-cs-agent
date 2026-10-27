/**
 * 迁移执行器。
 *
 *   node db/migrate.mjs           应用所有未执行的迁移
 *   node db/migrate.mjs --status  只列出状态，不写库
 *   node db/migrate.mjs --dry-run 打印将要执行什么，然后回滚
 *
 * 规则：
 *   - 文件按文件名排序执行，所以用 0001_ 这样的零填充前缀。
 *   - 每个迁移记录版本号 + 内容 sha256。内容被改过就报错，不许偷偷改历史。
 *   - 单个迁移在一个事务里跑完，失败即整体回滚，不会留半截 schema。
 */
import { readdir, readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  DatabaseDisabledError,
  closePool,
  dbEnabled,
  describeDb,
  getPool,
} from './pool.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const MIGRATIONS_DIR = path.join(here, 'migrations')

/** 迁移记录表本身不放在迁移文件里，否则第一个迁移没地方记自己。 */
const BOOTSTRAP = `
create table if not exists schema_migrations (
  version    text primary key,
  checksum   text not null,
  applied_at timestamptz not null default now()
)`

/** 读迁移目录，按文件名排序。 */
async function readMigrations() {
  const names = (await readdir(MIGRATIONS_DIR)).filter(name => name.endsWith('.sql')).sort()
  const migrations = []
  for (const name of names) {
    const sql = await readFile(path.join(MIGRATIONS_DIR, name), 'utf8')
    migrations.push({
      version: name.replace(/\.sql$/, ''),
      name,
      sql,
      checksum: createHash('sha256').update(sql).digest('hex'),
    })
  }
  return migrations
}

/** 已应用的版本 -> 记录。 */
async function appliedMap(client) {
  await client.query(BOOTSTRAP)
  const { rows } = await client.query('select version, checksum, applied_at from schema_migrations')
  return new Map(rows.map(row => [row.version, row]))
}

/**
 * 应用迁移。
 * @param options - status/dryRun/quiet。
 */
export async function migrate(options = {}) {
  const { status = false, dryRun = false, quiet = false, env = process.env } = options
  if (!dbEnabled(env)) {
    throw new DatabaseDisabledError()
  }
  const say = (message) => { if (!quiet) console.log(message) }
  const pool = await getPool(env)
  const client = await pool.connect()
  try {
    const applied = await appliedMap(client)
    const migrations = await readMigrations()
    const pending = []
    for (const migration of migrations) {
      const record = applied.get(migration.version)
      if (record === undefined) {
        pending.push(migration)
        continue
      }
      // 已应用的迁移被别人改过：宁可停下，也不要假装没事。
      if (record.checksum !== migration.checksum) {
        throw new Error(
          `migration ${migration.name} was modified after being applied `
          + `(recorded ${record.checksum.slice(0, 12)}, now ${migration.checksum.slice(0, 12)}); `
          + 'add a new migration instead of editing history',
        )
      }
    }

    say(`target: ${describeDb(env)}`)
    say(`migrations on disk: ${migrations.length}, applied: ${applied.size}, pending: ${pending.length}`)
    for (const migration of migrations) {
      const record = applied.get(migration.version)
      const mark = record === undefined ? 'pending' : `applied ${String(record.applied_at).slice(0, 19)}`
      say(`  ${migration.name.padEnd(28)} ${mark}`)
    }

    if (status) return { applied: applied.size, pending: pending.length, migrations }
    if (pending.length === 0) {
      say('nothing to do')
      return { applied: applied.size, pending: 0, appliedNow: [] }
    }

    const appliedNow = []
    for (const migration of pending) {
      if (dryRun) {
        say(`[dry-run] would apply ${migration.name} (${migration.sql.length} bytes)`)
        appliedNow.push(migration.version)
        continue
      }
      say(`applying ${migration.name} ...`)
      await client.query('begin')
      try {
        // 迁移里可能有多条语句，直接整段执行。
        await client.query(migration.sql)
        await client.query(
          'insert into schema_migrations (version, checksum) values ($1, $2)',
          [migration.version, migration.checksum],
        )
        await client.query('commit')
        appliedNow.push(migration.version)
      } catch (error) {
        await client.query('rollback').catch(() => {})
        throw new Error(`migration ${migration.name} failed: ${error.message}`, { cause: error })
      }
    }
    if (!dryRun) say(`done: applied ${appliedNow.length} migration(s)`)
    return { applied: applied.size + appliedNow.length, pending: 0, appliedNow }
  } finally {
    client.release()
    if (options.closeAfter !== false) await closePool()
  }
}

/** CLI 入口。 */
async function main(argv) {
  const flags = new Set(argv.filter(arg => arg.startsWith('--')))
  try {
    await migrate({
      status: flags.has('--status'),
      dryRun: flags.has('--dry-run'),
      closeAfter: true,
    })
  } catch (error) {
    if (error instanceof DatabaseDisabledError) {
      console.error(`数据库未启用：${error.message}`)
      console.error('（这是预期状态：不配数据库时插件应当完全照旧工作）')
      process.exitCode = 2
      return
    }
    console.error(`迁移失败：${error.message}`)
    if (error.cause?.code === 'ECONNREFUSED') {
      console.error('连接被拒绝——数据库没起来？先跑 ./scripts/db-up.sh')
    }
    process.exitCode = 1
  }
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2))
}
