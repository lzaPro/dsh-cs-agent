#!/usr/bin/env node
/**
 * 会话保留策略：先归档（隐藏），再清除（删除）。
 *
 * 归档 = 打 archivedAt + 从工作区摘掉。映射保留，客户再来消息时自动恢复，
 *        所以上下文不丢，只是不占侧边栏。
 * 清除 = 删会话目录 + 删映射 + 从所有工作区摘掉。不可逆。
 *
 *   node scripts/retention.mjs                 # dry-run
 *   node scripts/retention.mjs --yes           # 执行
 *   node scripts/retention.mjs --group-archive 3 --group-purge 30 \
 *                              --private-archive 30 --private-purge 90
 */
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const args = process.argv.slice(2)
const number = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  if (index === -1) return fallback
  const value = Number(args[index + 1])
  return Number.isFinite(value) ? value : fallback
}

const yes = args.includes('--yes')
const DAY = 24 * 60 * 60 * 1000
const limits = {
  group: { archive: number('group-archive', 3), purge: number('group-purge', 30) },
  private: { archive: number('private-archive', 30), purge: number('private-purge', 90) },
}

const dshHome = (() => {
  const index = args.indexOf('--home')
  return index === -1 ? join(homedir(), '.dsh') : args[index + 1]
})()
const dataFile = join(dshHome, 'cs-runtime/data/sessions.json')
const workspaceFile = join(dshHome, 'storages/workspace.json')
const sessionsRoot = join(dshHome, 'sessions')

if (!existsSync(dataFile)) {
  console.log(`没有会话映射：${dataFile}`)
  process.exit(0)
}

const mappings = JSON.parse(readFileSync(dataFile, 'utf8'))
const store = existsSync(workspaceFile) ? JSON.parse(readFileSync(workspaceFile, 'utf8')) : undefined

/** 在所有工作区目录里找这个会话的落盘位置。 */
function sessionDir(sessionId) {
  if (!existsSync(sessionsRoot)) return undefined
  for (const entry of readdirSync(sessionsRoot)) {
    const candidate = join(sessionsRoot, entry, sessionId)
    if (existsSync(candidate) && statSync(candidate).isDirectory()) return candidate
  }
  return undefined
}

/** 从所有工作区摘掉这个会话。 */
function detach(sessionId) {
  if (store === undefined) return
  for (const id of store.global?.workspaceIds ?? []) {
    const record = store.tables?.workspaces?.[id]
    if (record === undefined || !Array.isArray(record.sessionIds)) continue
    record.sessionIds = record.sessionIds.filter(item => item !== sessionId)
  }
}

const archive = []
const purge = []
const now = Date.now()

for (const [key, record] of Object.entries(mappings)) {
  if (record?.archivedAt) continue
  if (record?.mode === 'human') continue
  const seen = Date.parse(record?.lastSeenAt ?? '')
  if (!Number.isFinite(seen)) continue
  const scope = record?.groupId ? 'group' : 'private'
  const ageDays = (now - seen) / DAY
  if (ageDays > limits[scope].purge) purge.push({ key, record, scope, ageDays })
  else if (ageDays > limits[scope].archive) archive.push({ key, record, scope, ageDays })
}

console.log(`归档阈值：群聊 ${limits.group.archive} 天 / 私聊 ${limits.private.archive} 天`)
console.log(`清除阈值：群聊 ${limits.group.purge} 天 / 私聊 ${limits.private.purge} 天\n`)

for (const item of archive) {
  console.log(`归档  ${item.record.lastSeenAt?.slice(0, 10) ?? '?'}  ${item.key}  (${Math.round(item.ageDays)} 天未活动)`)
}
for (const item of purge) {
  console.log(`清除  ${item.record.lastSeenAt?.slice(0, 10) ?? '?'}  ${item.key}  (${Math.round(item.ageDays)} 天未活动)`)
}
if (archive.length === 0 && purge.length === 0) {
  console.log('没有需要处理的会话')
  process.exit(0)
}

console.log(`\n合计：归档 ${archive.length} · 清除 ${purge.length}`)
if (!yes) {
  console.log('(dry run) 加 --yes 执行')
  process.exit(0)
}

copyFileSync(dataFile, `${dataFile}.pre-retention.bak`)
if (store !== undefined) copyFileSync(workspaceFile, `${workspaceFile}.pre-retention.bak`)

for (const item of archive) {
  item.record.archivedAt = new Date().toISOString()
  detach(item.record.sessionId)
}

for (const item of purge) {
  const dir = sessionDir(item.record.sessionId)
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  detach(item.record.sessionId)
  delete mappings[item.key]
}

writeFileSync(dataFile, `${JSON.stringify(mappings, undefined, 2)}\n`)
if (store !== undefined) writeFileSync(workspaceFile, `${JSON.stringify(store, undefined, 2)}\n`)

console.log(`\n完成：归档 ${archive.length} · 清除 ${purge.length}`)
console.log(`备份：${dataFile}.pre-retention.bak`)
