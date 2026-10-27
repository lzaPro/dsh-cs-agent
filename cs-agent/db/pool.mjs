/**
 * Postgres 连接池。
 *
 * 两条硬约束：
 *   1. 默认关闭。不设 DSH_DB=1 时这个模块不会加载任何驱动，系统行为与没有数据库时完全一样。
 *   2. `pg` 是可选依赖。缺了它只在真正启用数据库时才报错，并且错误信息要能直接照做。
 *
 * 配置优先级：DSH_DB_URL > 分项环境变量 > 内置默认值。
 */
import { createHash } from 'node:crypto'

/** 数据库未启用。调用方应当把它当"没配数据库"，不要当故障。 */
export class DatabaseDisabledError extends Error {
  constructor() {
    super('database disabled: set DSH_DB=1 to enable')
    this.name = 'DatabaseDisabledError'
    this.code = 'DB_DISABLED'
  }
}

/** 启用了但环境不完整/驱动缺失。这是真故障，必须让人看见。 */
export class DatabaseConfigError extends Error {
  constructor(message, options) {
    super(message, options)
    this.name = 'DatabaseConfigError'
    this.code = 'DB_CONFIG'
  }
}

/** 把 "1"/"on"/"true" 之类的写法统一成布尔。 */
export function envFlag(value) {
  if (value === undefined || value === null) return false
  const text = String(value).trim().toLowerCase()
  return text === '1' || text === 'on' || text === 'true' || text === 'yes'
}

/** 数据库是否启用。默认关闭。 */
export function dbEnabled(env = process.env) {
  return envFlag(env.DSH_DB)
}

/** 解析连接参数，不建立连接。导出的目的是让脚本和测试可以断言配置。 */
export function dbConfig(env = process.env) {
  const url = typeof env.DSH_DB_URL === 'string' && env.DSH_DB_URL.trim() !== ''
    ? env.DSH_DB_URL.trim()
    : undefined
  const base = {
    host: env.DSH_DB_HOST ?? '127.0.0.1',
    // 默认 55432：避开本机 5432 与其它项目的占用。
    port: Number(env.DSH_DB_PORT ?? 55432),
    database: env.DSH_DB_NAME ?? 'cs_agent',
    user: env.DSH_DB_USER ?? 'cs_agent',
    password: env.DSH_DB_PASSWORD ?? 'cs_agent_dev',
    // 单进程百级并发足够；每个 worker 手里最多一条连接。
    max: Number(env.DSH_DB_POOL_MAX ?? 10),
    idleTimeoutMillis: Number(env.DSH_DB_IDLE_MS ?? 30_000),
    connectionTimeoutMillis: Number(env.DSH_DB_CONNECT_MS ?? 5_000),
    application_name: env.DSH_DB_APP_NAME ?? 'cs-agent',
  }
  const config = url === undefined ? base : { ...base, connectionString: url }
  if (!Number.isFinite(config.port) || config.port <= 0) {
    throw new DatabaseConfigError(`invalid DSH_DB_PORT: ${env.DSH_DB_PORT}`)
  }
  if (!Number.isFinite(config.max) || config.max <= 0) {
    throw new DatabaseConfigError(`invalid DSH_DB_POOL_MAX: ${env.DSH_DB_POOL_MAX}`)
  }
  return config
}

/** 脱敏后的连接描述，可以安全打进日志。 */
export function describeDb(env = process.env) {
  const config = dbConfig(env)
  if (config.connectionString !== undefined) {
    try {
      const parsed = new URL(config.connectionString)
      parsed.password = parsed.password === '' ? '' : '***'
      return parsed.toString()
    } catch {
      return 'postgres://(unparsable DSH_DB_URL)'
    }
  }
  return `postgres://${config.user}@{${config.host}:${config.port}}/${config.database}`
}

/** 只读这一段提示，反复出现在错误信息里。 */
const DRIVER_HINT = 'install it with: cd cs-agent && npm install pg'

/**
 * 懒加载驱动。只有真正要连库时才 import，保证不开库的部署零依赖。
 * @returns pg 模块的命名空间。
 */
export async function loadDriver() {
  try {
    return await import('pg')
  } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND') {
      throw new DatabaseConfigError(
        `database driver "pg" is missing (${DRIVER_HINT})`,
        { cause: error },
      )
    }
    throw error
  }
}

/** 进程级单例，避免每个模块各建一个池把连接数打满。 */
let poolPromise
let poolOwner

/**
 * 取共用连接池。首次调用时建池，之后复用。
 * @param env - 环境变量来源，测试可注入。
 */
export async function getPool(env = process.env) {
  if (!dbEnabled(env)) throw new DatabaseDisabledError()
  if (poolPromise !== undefined && poolOwner === env) return await poolPromise
  poolOwner = env
  poolPromise = (async () => {
    const { default: pg } = await loadDriver()
    const config = dbConfig(env)
    const pool = new pg.Pool(config)
    // 池级别的错误（空闲连接被服务端掐断等）不应该静默消失。
    pool.on('error', (error) => {
      console.error(`[db] idle client error: ${error.message}`)
    })
    return pool
  })()
  try {
    return await poolPromise
  } catch (error) {
    // 建池失败要把 promise 清掉，否则后续调用永远拿到同一个失败结果。
    poolPromise = undefined
    poolOwner = undefined
    throw error
  }
}

/** 取一条连接执行若干语句，用于需要事务的场合。 */
export async function withTransaction(fn, env = process.env) {
  const pool = await getPool(env)
  const client = await pool.connect()
  try {
    await client.query('begin')
    const result = await fn(client)
    await client.query('commit')
    return result
  } catch (error) {
    try {
      await client.query('rollback')
    } catch {
      // 回滚失败说明连接已经坏了，原始错误更重要，不要覆盖它。
    }
    throw error
  } finally {
    client.release()
  }
}

/** 简单查询，自动从池里取连接。 */
export async function query(text, params = [], env = process.env) {
  const pool = await getPool(env)
  return await pool.query(text, params)
}

/**
 * 健康检查：连得上、版本、已应用的迁移数。
 * 不抛异常，把失败也当成一种健康状态返回。
 */
export async function dbHealth(env = process.env) {
  if (!dbEnabled(env)) {
    return { enabled: false, ok: false, reason: 'disabled' }
  }
  const startedAt = Date.now()
  try {
    const pool = await getPool(env)
    const { rows } = await pool.query(
      "select current_database() as database, version() as version, "
      + "coalesce((select count(*) from schema_migrations), 0)::int as migrations",
    )
    const row = rows[0] ?? {}
    return {
      enabled: true,
      ok: true,
      database: row.database,
      version: String(row.version ?? '').split(',')[0],
      migrations: row.migrations,
      latencyMs: Date.now() - startedAt,
      target: describeDb(env),
    }
  } catch (error) {
    return {
      enabled: true,
      ok: false,
      reason: error?.code ?? 'ERROR',
      message: error?.message ?? String(error),
      latencyMs: Date.now() - startedAt,
      target: describeDb(env),
    }
  }
}

/** 关闭连接池。进程退出前调用，测试之间也要调。 */
export async function closePool() {
  if (poolPromise === undefined) return
  const pending = poolPromise
  poolPromise = undefined
  poolOwner = undefined
  try {
    const pool = await pending
    await pool.end()
  } catch {
    // 池没建起来就没什么可关的。
  }
}

/** 生成一个可以写进 idempotency_key 的短哈希。 */
export function shortHash(...parts) {
  const hash = createHash('sha256')
  for (const part of parts) hash.update(String(part))
  return hash.digest('hex').slice(0, 32)
}
