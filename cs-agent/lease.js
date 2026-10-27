// 写入域租约：保证同一份数据只有一个网关在写。
//
// 两种实现，语义一致：
//   - json：`<dataFile>.lock` 里记 pid，进程活着就拒绝第二个进程。单机足够。
//   - postgres：数据库租约 + 心跳。多机有效，且能接管"进程还在但卡住了"的持有者。
//
// 共同语义：拿不到就抛错（拒绝启动，而不是静默双写）；拿到之后要能 release；
// 数据库实现还要能 heartbeat，并在租约被别人接走时知道自己丢了。
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { dbEnabled, getPool } from './db/pool.mjs'

/** 默认租约 30 秒，每 10 秒心跳一次：一次 GC 停顿/网络抖动不至于丢锁。 */
export const DEFAULT_LEASE = { ttlMs: 30_000, heartbeatMs: 10_000 }

export function leaseKind(storeKind) {
  return storeKind === 'postgres' ? 'postgres' : 'json'
}

/** 进程是否还活着。 */
function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * 文件锁：行为与重构前完全一致（`acquireDataLock` 只是转调它）。
 * @param {string} dataFile 会话映射文件；锁文件是它加 `.lock`。
 */
export function createFileLease(dataFile) {
  const lockPath = `${dataFile}.lock`
  const take = () => {
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }))
    return () => rmSync(lockPath, { force: true })
  }
  mkdirSync(path.dirname(lockPath), { recursive: true })
  try {
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), { flag: 'wx' })
    return { kind: 'file', path: lockPath, release: () => rmSync(lockPath, { force: true }) }
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
  }
  let holder = {}
  try {
    holder = JSON.parse(readFileSync(lockPath, 'utf8'))
  } catch {
    holder = {}
  }
  if (Number.isSafeInteger(holder.pid) && isAlive(holder.pid)) {
    throw new Error(
      `channel-gateway: data dir already in use by pid ${holder.pid} (${lockPath}); `
      + 'use a separate dataFile for each dsh instance',
    )
  }
  // 上一个进程崩了，接管它的锁。
  const release = take()
  return { kind: 'file', path: lockPath, release }
}

const CLAIM = `
  insert into gateway_leases (scope, holder, host, pid, heartbeat_at, expires_at)
  values ($1, $2, $3, $4, now(), now() + ($5::int * interval '1 millisecond'))
  on conflict (scope) do update
     set holder = excluded.holder,
         host = excluded.host,
         pid = excluded.pid,
         heartbeat_at = now(),
         expires_at = excluded.expires_at
   where gateway_leases.expires_at <= now()
      or gateway_leases.holder = excluded.holder
  returning holder, host, pid, heartbeat_at, expires_at
`

const HEARTBEAT = `
  update gateway_leases
     set heartbeat_at = now(),
         expires_at = now() + ($3::int * interval '1 millisecond')
   where scope = $1 and holder = $2
  returning expires_at
`

/**
 * 数据库租约。拿不到就抛错；拿到之后必须在 dispose 前 release，否则别的实例要等过期。
 *
 * @param {object} options
 * @param {string} options.scope 逻辑写入域，同一份数据的所有实例用同一个值
 * @param {number} [options.ttlMs]
 * @param {number} [options.heartbeatMs]
 * @param {string} [options.holder] 仅测试用：指定持有者身份以模拟多实例
 * @param {{warn: Function}} [options.logger]
 */
export async function acquirePgLease(options) {
  if (!dbEnabled()) {
    throw new Error('channel-gateway: postgres lease needs the database to be enabled (set DSH_DB=1 and run ./scripts/db-up.sh)')
  }
  const scope = options.scope
  const ttlMs = options.ttlMs ?? DEFAULT_LEASE.ttlMs
  const heartbeatMs = options.heartbeatMs ?? Math.min(DEFAULT_LEASE.heartbeatMs, Math.max(1000, Math.floor(ttlMs / 3)))
  const logger = options.logger
  const holder = options.holder ?? `${os.hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`
  const pool = await getPool()

  const claimed = await pool.query(CLAIM, [scope, holder, os.hostname(), process.pid, ttlMs])
  if (claimed.rowCount === 0) {
    const current = await pool.query('select holder, host, pid, expires_at from gateway_leases where scope = $1', [scope])
    const row = current.rows[0]
    throw new Error(
      `channel-gateway: data dir already in use by ${row?.holder ?? 'another instance'} `
      + `(scope ${scope}, lease expires ${row?.expires_at?.toISOString?.() ?? 'unknown'}); `
      + 'wait for it to expire or stop that instance',
    )
  }

  let lost = false
  let timer
  const beat = async () => {
    if (lost) return
    try {
      const renewed = await pool.query(HEARTBEAT, [scope, holder, ttlMs])
      if (renewed.rowCount === 0) {
        // 租约被别人接走了：说明我们停顿太久。继续写就是双写，必须让上层知道。
        lost = true
        logger?.warn?.(`channel-gateway: lease ${scope} was taken over; this instance must stop writing`)
        if (timer !== undefined) clearInterval(timer)
      }
    } catch (error) {
      // 心跳失败（网络/库抖动）不立刻视为丢锁：等下一次，ttl 内还有机会续上。
      logger?.warn?.(`channel-gateway: lease heartbeat failed: ${error.message}`)
    }
  }
  timer = setInterval(beat, heartbeatMs)
  timer.unref?.()

  return {
    kind: 'postgres',
    scope,
    holder,
    get lost() { return lost },
    async heartbeat() { await beat() },
    async release() {
      if (timer !== undefined) {
        clearInterval(timer)
        timer = undefined
      }
      await pool.query('delete from gateway_leases where scope = $1 and holder = $2', [scope, holder])
    },
  }
}

/**
 * 按存储类型选实现。json 用文件锁（与重构前一致），postgres 用数据库租约。
 *
 * @param {object} options
 * @param {'json'|'postgres'} options.storeKind
 * @param {string} options.dataFile
 * @param {string} [options.scope]
 */
export async function acquireLease(options) {
  if (leaseKind(options.storeKind) === 'postgres') {
    return acquirePgLease({
      scope: options.scope ?? 'channel-gateway',
      ttlMs: options.ttlMs,
      heartbeatMs: options.heartbeatMs,
      logger: options.logger,
    })
  }
  return createFileLease(options.dataFile)
}
