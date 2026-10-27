// 数据生命周期的冒烟测试。
//
//   node cs-agent/purge-smoke.mjs            # json 存储
//   DSH_DB=1 node cs-agent/purge-smoke.mjs   # 额外跑数据库实现
//
// 要回答的问题：到期的会话会不会被归档、被清除的会话是不是**连消息和用量一起**没了、
// 按客户删除能不能只删那一个客户、以及这些操作有没有留痕。
// 最要紧的一条：dry-run 绝不能真的删东西。
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createStore } from './store.js'
import { createGateway } from './gateway.js'
import { DEFAULT_RETENTION, planPurgeByOwner, planRetention, retentionLimits } from './retention.js'

let failed = 0
const check = (ok, label, detail = '') => {
  if (!ok) failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail === '' ? '' : `: ${detail}`}`)
}
const DAY = 24 * 60 * 60 * 1000
const ago = days => new Date(Date.now() - days * DAY).toISOString()

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-purge-'))
const dbEnabled = ['1', 'on', 'true', 'yes'].includes(String(process.env.DSH_DB ?? '').toLowerCase())

function fakeCtx() {
  const live = new Map()
  const state = { followups: 0 }
  const makeAgent = id => ({ id, followup: () => { state.followups += 1 }, inject: () => {} })
  const workspace = { id: 'ws-1', sessionIds: [], attachSession: async () => {}, detachSession: async () => {}, setTitle: async () => {} }
  return {
    state,
    logger: { warn: () => {} },
    workspaceRegistry: { list: () => [workspace], create: async () => workspace },
    agentDefaultModel: { currentSelection: () => ({ provider: 'test', model: 'test-model' }) },
    agents: {
      async create(opts) {
        const agent = makeAgent(opts.sessionId)
        live.set(opts.sessionId, agent)
        return { agent }
      },
      get: id => live.get(id),
      async resume({ resumeSessionId }) {
        const agent = makeAgent(resumeSessionId)
        live.set(resumeSessionId, agent)
        return { agent }
      },
    },
    agentPresets: { async mount() {} },
    sessionTitle: { rename: async () => {} },
    on: () => () => {},
    effect: () => {},
  }
}

const resOf = () => ({ code: 0, body: '', writeHead(code) { this.code = code }, end(payload) { this.body = payload } })
const post = async (gateway, url, body) => {
  const res = resOf()
  await gateway.handleHttp({
    method: 'POST', url, headers: {},
    async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)) },
  }, res)
  return { code: res.code, body: res.body === '' ? undefined : JSON.parse(res.body) }
}
const get = async (gateway, url) => {
  const res = resOf()
  await gateway.handleHttp({ method: 'GET', url, headers: {} }, res)
  return { code: res.code, body: res.body === '' ? undefined : JSON.parse(res.body) }
}

// --- 纯规划函数 -------------------------------------------------------------
{
  check(JSON.stringify(DEFAULT_RETENTION) === JSON.stringify({ groupArchiveDays: 3, groupPurgeDays: 30, privateArchiveDays: 30, privatePurgeDays: 90 }),
    'default retention is 3/30 days for groups and 30/90 for private chats')

  const reversed = retentionLimits({ groupArchiveDays: 30, groupPurgeDays: 3 })
  check(reversed.groupPurgeDays === 30, 'a reversed policy is clamped instead of deleting early', String(reversed.groupPurgeDays))

  const records = [
    { key: 'qq:g-new', channel: 'qq', groupId: 'g-new', lastSeenAt: ago(1) },
    { key: 'qq:g-old', channel: 'qq', groupId: 'g-old', lastSeenAt: ago(10) },
    { key: 'qq:g-dead', channel: 'qq', groupId: 'g-dead', lastSeenAt: ago(60), archivedAt: ago(45) },
    { key: 'qq:p-old', channel: 'qq', lastSeenAt: ago(40) },
    { key: 'eval:1', channel: 'eval', lastSeenAt: ago(9999) },
  ]
  const plan = planRetention(records, { limits: DEFAULT_RETENTION })
  check(plan.archive.map(item => item.key).join(',') === 'qq:g-old,qq:p-old',
    'expired active conversations are archived, fresh ones are not', JSON.stringify(plan.archive.map(item => item.key)))
  check(plan.purge.map(item => item.key).join(',') === 'qq:g-dead',
    'archived conversations past their purge age are purged', JSON.stringify(plan.purge.map(item => item.key)))
  check(!plan.archive.some(item => item.key === 'eval:1') && !plan.purge.some(item => item.key === 'eval:1'),
    'eval-channel conversations are never auto-processed')

  // 同一个会话不能同一轮既归档又清除。
  const overlap = plan.archive.map(item => item.key).filter(key => plan.purge.some(item => item.key === key))
  check(overlap.length === 0, 'one conversation is never archived and purged in the same pass')

  check(planPurgeByOwner(records, { senderId: 'nobody' }).length === 0, 'an unknown owner matches nothing')
  check(planPurgeByOwner(records, { senderId: 'g-new' }).length === 0, 'group conversations do not match a sender id')
  check(planPurgeByOwner(records, { groupId: 'g-old' }).map(item => item.key).join(',') === 'qq:g-old',
    'a group can be found by its group id')
  let threw = false
  try {
    planPurgeByOwner(records, {})
  } catch {
    threw = true
  }
  check(threw, 'purging by owner without any filter is refused')
}

// --- 存储层：清除要连消息和用量一起删 ---------------------------------------
async function contract(makeStore, label, prefix) {
  const store = makeStore()
  await store.load()
  const target = `${prefix}:target`
  const keep = `${prefix}:keep`
  for (const key of [target, keep]) {
    await store.save({
      key, sessionId: `sess-${key}`, channel: 'qq', groupId: 'g1', groupName: 'G',
      senderId: 'u1', senderName: 'U', label: null, title: 'T', token: `tok-${key}`,
      createdAt: ago(40), lastSeenAt: ago(40), mode: 'ai', modeChangedAt: null,
    })
    await store.saveMessage(key, { role: 'user', content: `hi from ${key}` })
    await store.bumpUsage(key, { turns: 1, inputTokens: 10, outputTokens: 5 })
  }

  const removed = await store.purgeConversation(target)
  check(typeof removed === 'number' && removed === 1, `${label}: purge reports what it removed`, String(removed))

  // 重新建一个实例读同一份存储：内存里删掉不算数，要落到盘上/表里。
  const reloaded = makeStore()
  await reloaded.load()
  check(reloaded.records.has(target) === false, `${label}: the purged conversation is gone from storage`)
  check(reloaded.records.has(keep) === true, `${label}: other conversations are untouched`)
  check((await reloaded.listMessages(target, 10)).length === 0, `${label}: the purged conversation's messages are gone`)
  check((await reloaded.listMessages(keep, 10)).length > 0, `${label}: other conversations keep their messages`)
  await reloaded.close?.()
  await store.close?.()
}

{
  const jsonPaths = {
    dataFile: path.join(temp, 'store-sessions.json'),
    seenFile: path.join(temp, 'store-seen.json'),
  }
  await contract(
    () => createStore({ kind: 'json', ...jsonPaths, dedupeLimit: 100 }),
    'json',
    `purge-smoke-j-${process.pid}-${Date.now()}`,
  )
}

if (!dbEnabled) {
  console.log('SKIP database retention checks (set DSH_DB=1 to run them)')
} else {
  const { query, closePool } = await import('./db/pool.mjs')
  const prefix = `purge-smoke-${process.pid}-${Date.now()}`
  const pgStore = createStore({ kind: 'postgres', dataFile: path.join(temp, 'pg-sessions.json'), seenFile: path.join(temp, 'pg-seen.json'), dedupeLimit: 100 })
  await pgStore.load()
  const target = `${prefix}:target`
  const keep = `${prefix}:keep`
  for (const key of [target, keep]) {
    await pgStore.save({
      key, sessionId: `sess-${key}`, channel: 'qq', groupId: 'g1', groupName: 'G',
      senderId: 'u1', senderName: 'U', label: null, title: 'T', token: `tok-${key}`,
      createdAt: ago(40), lastSeenAt: ago(40), mode: 'ai', modeChangedAt: null,
    })
    await pgStore.saveMessage(key, { role: 'user', content: `hi from ${key}` })
    await pgStore.bumpUsage(key, { turns: 1, inputTokens: 10, outputTokens: 5 })
  }
  await pgStore.purgeConversation(target)
  const conversations = await query('select count(*)::int as count from conversations where external_key = $1', [target])
  check(conversations.rows[0].count === 0, 'postgres: the conversation row is deleted')
  const messages = await query('select count(*)::int as count from messages where content = $1', [`hi from ${target}`])
  check(messages.rows[0].count === 0, 'postgres: messages cascade away with the conversation')
  const usage = await query('select count(*)::int as count from usage_daily where conversation_id not in (select id from conversations)')
  check(usage.rows[0].count === 0, 'postgres: usage rows do not outlive their conversation')
  const kept = await query('select count(*)::int as count from messages where content = $1', [`hi from ${keep}`])
  check(kept.rows[0].count === 1, 'postgres: other conversations keep their messages', String(kept.rows[0].count))

  // 清理：先删会话（级联），再清 inbound_dedupe 里可能留下的行。
  await query('delete from conversations where external_key like $1', [`${prefix}%`])
  await pgStore.close?.()
  await closePool()
}

// --- 网关：dry-run 不删、真删有审计 -----------------------------------------
{
  const workspace = path.join(temp, 'ws')
  await fs.mkdir(workspace, { recursive: true })
  const dataFile = path.join(temp, 'gw-sessions.json')
  const gateway = createGateway(fakeCtx(), {
    route: '/channel',
    workspace,
    agentPreset: 'service-desk',
    dataFile,
    retention: { groupArchiveDays: 3, groupPurgeDays: 30, privateArchiveDays: 30, privatePurgeDays: 90 },
  })

  // 三个会话：一个刚聊过、一个还能归档、一个早该清除。
  // 三个不同群（key 由 channel+groupId 拼出来，同一个群就是同一个会话）。
  const fresh = await gateway.inbound({ channel: 'qq', senderId: 'u-fresh', groupId: 'g-fresh', groupName: 'G', text: '刚聊', messageId: 'pm1' })
  const stale = await gateway.inbound({ channel: 'qq', senderId: 'u-stale', groupId: 'g-stale', groupName: 'G', text: '很久以前', messageId: 'pm2' })
  const dead = await gateway.inbound({ channel: 'qq', senderId: 'u-dead', groupId: 'g-dead', groupName: 'G', text: '该清了', messageId: 'pm3' })
  await gateway.flushArchives()

  const age = async (key, days, archivedDays) => {
    const record = gateway.sessions.get(key)
    record.lastSeenAt = ago(days)
    if (archivedDays !== undefined) record.archivedAt = ago(archivedDays)
    await gateway.store.save(record)
  }
  await age(stale.key, 10)
  await age(dead.key, 60, 45)

  const dryPlan = await get(gateway, '/channel/retention')
  check(dryPlan.code === 200 && dryPlan.body.dryRun === true, 'gateway: GET /retention is always a dry run')
  check(dryPlan.body.archive.map(item => item.key).join(',') === stale.key,
    'gateway: the plan names the conversation to archive', JSON.stringify(dryPlan.body.archive.map(item => item.key)))
  check(dryPlan.body.purge.map(item => item.key).join(',') === dead.key,
    'gateway: the plan names the conversation to purge', JSON.stringify(dryPlan.body.purge.map(item => item.key)))
  check(gateway.sessions.get(dead.key)?.archivedAt !== undefined && gateway.sessions.has(stale.key),
    'gateway: a dry run changes nothing')

  const dryPost = await post(gateway, '/channel/retention', { dryRun: true })
  check(dryPost.body.dryRun === true && gateway.sessions.has(dead.key), 'gateway: POST with dryRun true changes nothing')

  // 有人把 dryRun 传成字符串 "false" 时也必须当作 dry-run：只认字面 false。
  const stringFlag = await post(gateway, '/channel/retention', { dryRun: 'false' })
  check(stringFlag.body.dryRun === true && gateway.sessions.has(dead.key), 'gateway: only a literal false enables deletion')

  const applied = await post(gateway, '/channel/retention', { dryRun: false, actor: 'ops-bob' })
  check(applied.body.archived.includes(stale.key), 'gateway: the stale conversation is archived', JSON.stringify(applied.body.archived))
  check(gateway.sessions.get(stale.key)?.archivedAt !== undefined, 'gateway: archiving really set archivedAt')
  check(applied.body.purged.includes(dead.key), 'gateway: the dead conversation is purged', JSON.stringify(applied.body.purged))
  check(gateway.sessions.has(dead.key) === false, 'gateway: the purged conversation is gone')

  // 清除要连消息一起清掉，否则"删了客户数据"是假的。
  const deadHistory = await gateway.listMessages(dead.key, 10)
  check(deadHistory.length === 0, 'gateway: a purged conversation loses its messages too', String(deadHistory.length))
  const freshHistory = await gateway.listMessages(fresh.key, 10)
  check(freshHistory.length > 0, 'gateway: other conversations keep their messages', String(freshHistory.length))

  const auditEntries = await gateway.audit.list(20)
  const archiveEntry = auditEntries.find(item => item.action === 'archive' && item.targetId === stale.key)
  const purgeEntry = auditEntries.find(item => item.action === 'purge' && item.targetId === dead.key)
  check(archiveEntry !== undefined && archiveEntry.actor === 'ops-bob', 'gateway: archiving is audited with the actor')
  check(purgeEntry !== undefined && purgeEntry.detail?.reason === 'retention', 'gateway: purging is audited with a reason',
    JSON.stringify(purgeEntry?.detail))

  // 按客户删除：只删这一个人，别的不动。
  const before = gateway.sessions.size
  const ownerDry = await post(gateway, '/channel/retention', { owner: { senderId: 'u-fresh' }, dryRun: true })
  check(ownerDry.body.purge.map(item => item.key).join(',') === fresh.key, 'gateway: owner purge finds the right conversations',
    JSON.stringify(ownerDry.body.purge))
  check(gateway.sessions.size === before, 'gateway: owner dry run deletes nothing')
  const ownerApplied = await post(gateway, '/channel/retention', { owner: { senderId: 'u-fresh' }, dryRun: false, actor: 'dpo-carol' })
  check(ownerApplied.body.purged.includes(fresh.key), 'gateway: owner purge deletes the conversation', JSON.stringify(ownerApplied.body.purged))
  check(gateway.sessions.has(fresh.key) === false, 'gateway: owner purge really removed it')
  check((await gateway.listMessages(fresh.key, 10)).length === 0, 'gateway: owner purge removed the messages too')
  const ownerAudit = (await gateway.audit.list(20)).find(item => item.targetId === fresh.key && item.action === 'purge')
  check(ownerAudit?.detail?.reason === 'owner-request' && ownerAudit?.actor === 'dpo-carol',
    'gateway: owner purge records who asked and why', JSON.stringify(ownerAudit?.detail))

  // 租约被别的实例接管之后，本进程不许删数据。
  const leased = createGateway(fakeCtx(), {
    route: '/chan2', workspace, agentPreset: 'service-desk',
    dataFile: path.join(temp, 'gw2-sessions.json'),
  }, { lease: { kind: 'postgres', lost: true } })
  const refused = await post(leased, '/chan2/retention', { dryRun: false })
  check(refused.code === 503 && refused.body?.code === 'LEASE_LOST', 'gateway: a taken-over instance refuses to purge',
    `${refused.code} ${refused.body?.code}`)
  const stillAllowed = await get(leased, '/chan2/retention')
  check(stillAllowed.code === 200, 'gateway: reading the plan still works after the lease is lost')

  await gateway.flushArchives()
}

await fs.rm(temp, { recursive: true, force: true })
console.log(failed === 0 ? '\nall retention checks passed' : `\n${failed} retention check(s) failed`)
process.exit(failed === 0 ? 0 : 1)
