#!/usr/bin/env node
/**
 * 会话存储层的验收测试。
 *
 * 两套实现（JSON 文件 / Postgres）都要满足同一份接口约定，所以下面的大多数
 * 断言写成一个函数，对两个实现各跑一遍。重点覆盖三件事：
 *
 *   1. 并发写入不丢更新 —— 这是重构前的实际 bug：每次变化都把整张表重写一遍，
 *      两次写入撞在一起就后写的赢、前面的改动消失。
 *   2. load 只读一次 —— 重构前 `load()` 先置 loaded = true 再 await，两条消息
 *      同时进来时后一条看到空表，于是给同一个客户建出两个会话。
 *   3. 记录字段原样往返 —— 尤其 groupId 必须是 null 而不是 undefined，
 *      网关靠 `groupId !== undefined` 判断群聊。
 *
 * 不设 DSH_DB 时跳过 Postgres 部分（JSON 部分总是跑）。
 */
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createStore, storeKind } from './store.js'
import { createGateway } from './gateway.js'

let failures = 0
let checks = 0

function check(ok, label, detail) {
  checks += 1
  if (ok) {
    console.log(`PASS ${label}${detail === undefined ? '' : `: ${detail}`}`)
    return
  }
  failures += 1
  console.log(`FAIL ${label}${detail === undefined ? '' : `: ${detail}`}`)
}

function makeRecord(key, extra = {}) {
  const now = new Date().toISOString()
  return {
    sessionId: `chan-${key}`,
    key,
    channel: 'smoke',
    groupId: null,
    groupName: null,
    senderName: null,
    label: null,
    title: `会话 ${key}`,
    token: key.slice(-6),
    senderId: `u-${key}`,
    createdAt: now,
    lastSeenAt: now,
    mode: 'ai',
    modeChangedAt: now,
    ...extra,
  }
}

/** 两套实现共用的约定测试。 */
async function contract(store, label) {
  await store.load()

  // 字段往返：groupId 为 null 时要还原成 null，不能变成 undefined。
  const record = makeRecord(`k1-${label}`, { archivedAt: '2026-01-01T00:00:00.000Z', lastSenderId: 'u-42' })
  await store.save(record)
  check(store.records.has(record.key), `${label}: save 写入内存映射`)

  const store2 = createTestStore(label)
  const [a, b] = await Promise.all([store2.load(), store2.load()])
  check(a === b, `${label}: 并发 load 共享同一次读取`)
  check(store2.records.get(record.key)?.sessionId === record.sessionId, `${label}: 重新读出同一条记录`)
  check(store2.records.get(record.key)?.groupId === null, `${label}: groupId 还原为 null 而不是 undefined`)
  check(store2.records.get(record.key)?.archivedAt === record.archivedAt, `${label}: archivedAt 往返一致`)
  check(store2.records.get(record.key)?.lastSenderId === 'u-42', `${label}: lastSenderId 往返一致`)
  check(store2.records.get(record.key)?.title === record.title, `${label}: title 往返一致`)
  check('groupId' in store2.records.get(record.key), `${label}: groupId 字段存在`)
  await store2.close()

  // 同 key 再存一次是更新，不是新增。
  await store.save({ ...record, title: '改过的标题' })
  const store3 = createTestStore(label)
  await store3.load()
  // 不能断言"整张表只有 1 行"：Postgres 库里还有别的会话。
  const sameKey = [...store3.records.keys()].filter(key => key === record.key).length
  check(sameKey === 1, `${label}: 同 key 重复保存不产生新行`, `rows=${sameKey}`)
  check(store3.records.get(record.key)?.title === '改过的标题', `${label}: 更新后的标题生效`)
  await store3.close()

  // 并发写不同记录：一条都不能丢。
  const store4 = createTestStore(label)
  await store4.load()
  const many = Array.from({ length: 8 }, (_, index) => makeRecord(`p${index}-${label}`))
  await Promise.all(many.map(item => store4.save(item)))
  const store5 = createTestStore(label)
  await store5.load()
  const survived = many.filter(item => store5.records.has(item.key)).length
  check(survived === many.length, `${label}: 并发写 8 条全部落地`, `${survived}/${many.length}`)
  await store5.close()

  // 删除。
  await store4.remove(many[0].key)
  check(!store4.records.has(many[0].key), `${label}: remove 清掉内存映射`)
  const store6 = createTestStore(label)
  await store6.load()
  check(!store6.records.has(many[0].key), `${label}: remove 后重新加载不再出现`)
  await store6.close()
  await store4.close()

  // 去重窗口：超上限时丢最旧的。
  const store7 = createTestStore(label, { dedupeLimit: 3 })
  await store7.load()
  for (const index of [1, 2, 3, 4, 5]) await store7.rememberSeen(`m-${label}-${index}`, new Date(2026, 0, index).toISOString())
  check(store7.seen.size === 3, `${label}: 去重窗口裁到上限`, `size=${store7.seen.size}`)
  check(store7.seen.has(`m-${label}-5`), `${label}: 保留最新的一条`)
  check(!store7.seen.has(`m-${label}-1`), `${label}: 丢掉最旧的一条`)
  const store8 = createTestStore(label, { dedupeLimit: 3 })
  await store8.load()
  check(store8.seen.has(`m-${label}-5`), `${label}: 去重窗口重新加载后还在`)
  await store8.close()
  await store7.close()

  // flush 不报错。
  await store.flush()
  check(true, `${label}: flush 正常返回`)

  await store.remove(record.key)
}

/**
 * 网关真正跑在数据库上：两个实例共享一份真相。
 *
 * 这里验证的是接线，不是存储本身（存储由 contract 验）：
 *   - 入站消息真的写进了 conversations 表；
 *   - 第二个网关实例不用重启就能看到第一个实例建的会话；
 *   - 同一个平台消息 id 在第二个实例上也被判重（去重窗口在库里，不在进程里）。
 */
async function gatewayWithPg(temp) {
  const fakeCtx = () => {
    const workspaces = []
    const live = new Map()
    return {
      workspaceRegistry: {
        list: () => workspaces.map(record => ({
          get sessionIds() { return record.sessions },
          detachSession: async id => { record.sessions = record.sessions.filter(item => item !== id) },
        })),
        create: async target => {
          const record = { path: target, title: undefined, sessions: [] }
          workspaces.push(record)
          return {
            id: `ws-${workspaces.length}`,
            get sessionIds() { return record.sessions },
            attachSession: async id => { record.sessions.push(id) },
            detachSession: async id => { record.sessions = record.sessions.filter(item => item !== id) },
            setTitle: async title => { record.title = title },
          }
        },
      },
      logger: { warn: () => {} },
      agentDefaultModel: { currentSelection: () => ({ provider: 'test', model: 'test-model' }) },
      agents: {
        async create(options) {
          const agent = { id: options.sessionId, followup() {}, inject() {} }
          live.set(options.sessionId, agent)
          return { agent }
        },
        get: id => live.get(id),
        async resume({ resumeSessionId }) {
          const agent = { id: resumeSessionId, followup() {}, inject() {} }
          live.set(resumeSessionId, agent)
          return { agent }
        },
      },
      agentPresets: { async mount() {} },
      sessionTitle: { rename() {} },
      on: () => {},
    }
  }

  const options = {
    route: '/channel',
    workspace: temp,
    agentPreset: 'service-desk',
    store: 'postgres',
    outbox: path.join(temp, 'pg-outbox.jsonl'),
  }

  const first = createGateway(fakeCtx(), options)
  const message = { channel: 'pgsmoke', senderId: 's1', text: '你好', messageId: 'pgsmoke-mm1' }
  const created = await first.inbound(message)
  check(created.duplicate === false, 'pg 网关: 首条消息建了会话')

  const { getPool } = await import('./db/pool.mjs')
  const pool = await getPool()
  const row = await pool.query('select * from conversations where external_key = $1', ['pgsmoke:s1'])
  check(row.rowCount === 1, 'pg 网关: 会话写进了 conversations 表', `rows=${row.rowCount}`)
  check(row.rows[0]?.dsh_session_id === created.sessionId, 'pg 网关: 库里存的是同一个 sessionId')
  check(row.rows[0]?.last_sender_id === 's1', 'pg 网关: lastSenderId 落库')

  // 第二个实例：同一个数据库，不需要重启就能看到前面建的会话。
  const second = createGateway(fakeCtx(), options)
  const response = { code: 0, body: '', writeHead(code) { this.code = code }, end(body) { this.body = body } }
  await second.handleHttp({ method: 'GET', url: '/channel/sessions', headers: {} }, response)
  const listed = JSON.parse(response.body).sessions
  check(response.code === 200, 'pg 网关: 第二个实例能列会话', `code=${response.code}`)
  check(listed.some(item => item.key === 'pgsmoke:s1'), 'pg 网关: 第二个实例看到第一个实例的会话')

  // 去重窗口在库里：另一个进程也应该认得这条消息。
  const repeated = await second.inbound(message)
  check(repeated.duplicate === true, 'pg 网关: 跨实例去重生效')

  // 入站消息现在会先进 inbox 表（store=postgres 时队列也走库），一起清掉。
  await pool.query('delete from inbox where external_key like $1', ['pgsmoke%'])
  await pool.query('delete from conversations where channel = $1', ['pgsmoke'])
  await pool.query('delete from inbound_dedupe where platform_msg_id like $1', ['pgsmoke-%'])
  check(true, 'pg 网关: 测试数据已清理')
}

/** 造一个连着同一份数据的 store，用于验证"重新加载"的语义。 */
let testFactory = null
function createTestStore(label, extra) {
  return testFactory(label, extra)
}

async function main() {
  // 1. 开关解析。
  check(storeKind({}, {}) === 'json', '默认使用 json 存储')
  check(storeKind({}, { DSH_CS_STORE: 'postgres' }) === 'postgres', 'DSH_CS_STORE=postgres 切到数据库')
  check(storeKind({}, { DSH_CS_STORE: 'pg' }) === 'postgres', 'pg 是 postgres 的别名')
  check(storeKind({ store: 'json' }, { DSH_CS_STORE: 'postgres' }) === 'json', '插件配置优先于环境变量')
  check(storeKind({}, { DSH_CS_STORE: '' }) === 'json', '空字符串当作默认值')
  let threw = false
  try {
    storeKind({}, { DSH_CS_STORE: 'mysql' })
  } catch (error) {
    threw = /store must be "json" or "postgres"/.test(error.message)
  }
  check(threw, '非法存储名被拒绝并给出可读错误')

  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-store-'))
  const dataFile = path.join(temp, 'sessions.json')
  const seenFile = path.join(temp, 'sessions-seen.json')

  try {
    // 2. JSON 实现。
    testFactory = (label, extra) => createStore({
      kind: 'json',
      dataFile,
      seenFile,
      ...extra,
    })
    const jsonStore = createTestStore('json', { dedupeLimit: 3 })
    check(jsonStore.kind === 'json', 'JSON store 自报 kind')
    check(jsonStore.records === jsonStore.records, 'records 是稳定引用（网关直接改它）')
    await contract(jsonStore, 'json')

    // 文件权限与格式。
    const mode = (await fs.stat(dataFile)).mode & 0o777
    check(mode === 0o600, 'json 文件权限是 0600', mode.toString(8))
    const raw = JSON.parse(await fs.readFile(dataFile, 'utf8'))
    check(raw !== null && typeof raw === 'object' && !Array.isArray(raw), 'json 文件是 key -> record 的对象')
    await jsonStore.close()

    // 3. Postgres 实现（可选）。
    const dbEnabled = (process.env.DSH_DB ?? '') === '1' || /^(on|true|yes)$/i.test(process.env.DSH_DB ?? '')
    if (!dbEnabled) {
      console.log('SKIP postgres store checks (set DSH_DB=1 to run them)')
    } else {
      // key 全部带一次性前缀，跑完按前缀删掉，不碰开发库里的真实会话。
      const prefix = `smoke${process.pid}${Date.now()}`
      const label = `pg-${prefix}`
      testFactory = (name, extra) => createStore({ kind: 'postgres', dedupeLimit: extra?.dedupeLimit })
      const pgStore = createTestStore('pg', { dedupeLimit: 3 })
      check(pgStore.kind === 'postgres', 'PG store 自报 kind')
      try {
        await contract(pgStore, label)
      } finally {
        const { getPool } = await import('./db/pool.mjs')
        const pool = await getPool()
        await pool.query('delete from inbox where external_key like $1', [`%${prefix}%`])
        await pool.query('delete from conversations where external_key like $1', [`%${prefix}%`])
        await pool.query('delete from inbound_dedupe where platform_msg_id like $1', [`%${prefix}%`])
        check(true, 'pg: 测试数据已清理')
      }

      // 4. 网关真的跑在这个存储上（连接池最后统一关）。
      try {
        await gatewayWithPg(temp)
      } finally {
        const { closePool } = await import('./db/pool.mjs')
        await closePool()
      }
    }
  } finally {
    await fs.rm(temp, { recursive: true, force: true })
  }

  console.log(`\n${checks - failures}/${checks} checks passed`)
  if (failures > 0) {
    console.error(`${failures} check(s) failed`)
    process.exit(1)
  }
}

await main()
