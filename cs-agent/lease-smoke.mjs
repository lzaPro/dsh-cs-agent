// 写入域租约的冒烟测试。
//
//   node cs-agent/lease-smoke.mjs            # 只跑文件锁
//   DSH_DB=1 node cs-agent/lease-smoke.mjs   # 额外跑数据库租约（需要 ./scripts/db-up.sh）
//
// 要证明的三件事：
//   1. 同一份数据只有一个写入者（拿不到就拒绝，不静默双写）；
//   2. 持有者崩了，锁能被接管，不需要人工删锁文件；
//   3. 持有者"活着但卡住"（数据库租约过期）也能被接管，而 pid 判断不出来。
import { promises as fs, existsSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { acquireLease, createFileLease } from './lease.js'
import { acquirePgLease } from './lease.js'

let failed = 0
const check = (ok, label, detail = '') => {
  if (!ok) failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail === '' ? '' : `: ${detail}`}`)
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const dbEnabled = ['1', 'on', 'true', 'yes'].includes(String(process.env.DSH_DB ?? '').toLowerCase())

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-lease-'))

function expectedFailure(label, run) {
  try {
    run()
    check(false, label, 'no error thrown')
  } catch (error) {
    check(true, label, error.message.slice(0, 60))
  }
}

// --- 文件锁：与重构前行为一致 ------------------------------------------------
{
  const dataFile = path.join(temp, 'sessions.json')
  const first = createFileLease(dataFile)
  check(existsSync(`${dataFile}.lock`), 'file lease writes a lock file')
  check(JSON.parse(readFileSync(`${dataFile}.lock`, 'utf8')).pid === process.pid, 'file lease records the pid')

  expectedFailure('a second file lease is refused', () => createFileLease(dataFile))

  first.release()
  check(!existsSync(`${dataFile}.lock`), 'release removes the lock file')
  const again = createFileLease(dataFile)
  check(existsSync(`${dataFile}.lock`), 'a released lock can be taken again')
  again.release()

  // 上一个进程崩了：锁文件留着、pid 已经不存在 → 接管。
  writeFileSync(`${dataFile}.lock`, JSON.stringify({ pid: 999_999, at: new Date().toISOString() }))
  const takeover = createFileLease(dataFile)
  check(JSON.parse(readFileSync(`${dataFile}.lock`, 'utf8')).pid === process.pid, 'a dead holder is taken over')
  takeover.release()

  // 锁文件内容坏了也要能接管，而不是永远起不来。
  writeFileSync(`${dataFile}.lock`, 'not json')
  const corrupt = createFileLease(dataFile)
  check(true, 'a corrupt lock file is taken over')
  corrupt.release()
}

// --- acquireLease 的分派 ------------------------------------------------------
{
  const dataFile = path.join(temp, 'dispatch.json')
  const lease = await acquireLease({ storeKind: 'json', dataFile })
  check(lease.kind === 'file', 'acquireLease picks the file lock for json storage')
  await lease.release()
}

if (!dbEnabled) {
  console.log('SKIP database lease checks (set DSH_DB=1 to run them)')
} else {
  const { query, closePool } = await import('./db/pool.mjs')
  const scope = `lease-smoke-${process.pid}-${Date.now()}`
  try {
    // 单持有者
    const first = await acquireLease({ storeKind: 'postgres', scope, ttlMs: 5000, heartbeatMs: 1000 })
    check(first.kind === 'postgres' && first.lost === false, 'postgres lease is claimed')
    const row = await query('select holder, host, pid, expires_at from gateway_leases where scope = $1', [scope])
    check(row.rowCount === 1 && row.rows[0].holder === first.holder, 'the lease row names the holder')

    // 第二个实例拿不到
    let refused
    try {
      await acquireLease({ storeKind: 'postgres', scope, ttlMs: 5000, heartbeatMs: 1000 })
      refused = false
    } catch (error) {
      refused = /already in use/.test(error.message)
    }
    check(refused, 'a second postgres lease is refused')

    // 同一个 holder 重复 claim 是幂等的（进程重启后 holder 变了，走不到这里）
    const same = await acquirePgLease({ scope, ttlMs: 5000, heartbeatMs: 1000, holder: first.holder })
    check(same.holder === first.holder, 'the same holder can re-claim its own lease')
    // 别 release：同一个 holder 的两个句柄共享一行，放开会让 first 也失去租约。
    same.release = async () => {}

    // 心跳：expires_at 会往后推
    const beforeBeat = (await query('select expires_at from gateway_leases where scope = $1', [scope])).rows[0].expires_at
    await sleep(1100)
    await first.heartbeat()
    const afterBeat = (await query('select expires_at from gateway_leases where scope = $1', [scope])).rows[0].expires_at
    check(afterBeat > beforeBeat, 'heartbeat extends the lease')

    // 关键场景：持有者"活着但卡住"——把过期时间推到过去，别的实例就能接管。
    await query('update gateway_leases set expires_at = now() - interval \'1 second\' where scope = $1', [scope])
    const takeover = await acquireLease({ storeKind: 'postgres', scope, ttlMs: 5000, heartbeatMs: 1000 })
    check(takeover.holder !== first.holder, 'an expired lease is taken over by another instance')

    // 原持有者下次心跳发现租约没了 → 必须知道自己丢了，不能再写。
    await first.heartbeat()
    check(first.lost === true, 'the previous holder learns it lost the lease')

    await takeover.release()
    const left = await query('select count(*)::int as count from gateway_leases where scope = $1', [scope])
    check(left.rows[0].count === 0, 'release deletes the lease row', String(left.rows[0].count))

    // 释放后别人能拿到
    const reacquired = await acquireLease({ storeKind: 'postgres', scope, ttlMs: 5000, heartbeatMs: 1000 })
    check(reacquired.holder !== takeover.holder, 'a released lease can be taken again')
    await reacquired.release()
  } finally {
    await query('delete from gateway_leases where scope = $1', [scope])
    await closePool()
  }
}

// --- 网关接线：postgres 存储下 apply() 必须真的抢租约 -------------------------
if (dbEnabled) {
  const { apply } = await import('./gateway.js')
  const { query, closePool } = await import('./db/pool.mjs')
  const scope = 'lease-smoke-apply'
  // Host 替身：effect 立即执行回调并收好它返回的 disposer，与 Cordis 一致。
  const boot = () => {
    const disposers = []
    const routes = []
    return {
      routes,
      disposers,
      logger: { warn: () => {} },
      webServer: { register: (route) => { routes.push(route); return () => {} } },
      effect: (callback) => { const disposer = callback(); if (typeof disposer === 'function') disposers.push(disposer) },
      on: () => () => {},
      agents: {}, agentPresets: {}, sessionTitle: {}, agentDefaultModel: {},
    }
  }
  const workspace = path.join(temp, 'ws-apply')
  await fs.mkdir(workspace, { recursive: true })
  const config = {
    route: '/channel',
    workspace,
    agentPreset: 'service-desk',
    dataFile: path.join(temp, 'apply-sessions.json'),
    store: 'postgres',
    leaseScope: scope,
    leaseTtlMs: 5000,
    leaseHeartbeatMs: 1000,
  }
  try {
    const ctx = boot()
    await apply(ctx, config)
    check(ctx.routes.length === 1, 'postgres apply registers the route after claiming the lease')
    const held = await query('select holder from gateway_leases where scope = $1', [scope])
    check(held.rowCount === 1, 'postgres apply holds a lease row')

    // 第二个实例：同一个 scope 必须被拦下，而不是静默双写。
    let refused = false
    try {
      await apply(boot(), config)
    } catch (error) {
      refused = /already in use/.test(error.message)
    }
    check(refused, 'a second gateway on the same lease scope is refused')

    // 走 effect 的 disposer 收尾：租约行必须消失，否则重启后要等 ttl 才能起来。
    for (const disposer of ctx.disposers) await disposer()
    const released = await query('select count(*)::int as count from gateway_leases where scope = $1', [scope])
    check(released.rows[0].count === 0, 'disposing the plugin releases the lease', String(released.rows[0].count))

    // 释放之后另一个实例能起来。
    const again = boot()
    await apply(again, config)
    check(again.routes.length === 1, 'another instance can start after the lease is released')
    for (const disposer of again.disposers) await disposer()
  } finally {
    await query('delete from gateway_leases where scope = $1', [scope])
    await closePool()
  }
}

await fs.rm(temp, { recursive: true, force: true })
console.log(failed === 0 ? '\nall lease checks passed' : `\n${failed} lease check(s) failed`)
process.exit(failed === 0 ? 0 : 1)
