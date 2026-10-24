#!/usr/bin/env node
/**
 * 会话对账：磁盘上有多少、工作区挂了多少、映射里有多少是坏的。
 *
 *   node scripts/session-report.mjs
 *
 * 只读，不修改任何文件。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const home = homedir()
const sessionsRoot = join(home, '.dsh/sessions')
const workspaceFile = join(home, '.dsh/storages/workspace.json')
const mappingFile = join(home, '.dsh/cs-runtime/data/sessions.json')

/** 工作区路径 → 会话目录名。 */
function encodePath(path) {
  return `--${path.replace(/^\//, '').replaceAll('/', '-')}--`
}

/** 目录名 → 最近一次已知的工作区路径（用登记表反查）。 */
function decodeIndex(workspaces) {
  const map = new Map()
  for (const workspace of workspaces) map.set(encodePath(workspace.path), workspace.path)
  return map
}

/** 读工作区登记。 */
function readWorkspaces() {
  if (!existsSync(workspaceFile)) return []
  const store = JSON.parse(readFileSync(workspaceFile, 'utf8'))
  return (store.global?.workspaceIds ?? [])
    .map(id => store.tables?.workspaces?.[id])
    .filter(Boolean)
    .map(record => ({ path: record.path, sessionIds: record.sessionIds ?? [] }))
}

const workspaces = readWorkspaces()
const decoded = decodeIndex(workspaces)
const attached = new Set(workspaces.flatMap(workspace => workspace.sessionIds))

const rows = []
let totalOnDisk = 0
for (const entry of readdirSync(sessionsRoot)) {
  const dir = join(sessionsRoot, entry)
  if (!statSync(dir).isDirectory()) continue
  const ids = readdirSync(dir).filter(name => /^(chan|ops|session)-/.test(name))
  totalOnDisk += ids.length
  rows.push({
    dir: entry,
    path: decoded.get(entry) ?? '(未登记)',
    sessions: ids,
    attached: ids.filter(id => attached.has(id)).length,
  })
}

console.log('工作区'.padEnd(52), '磁盘', '已挂', '孤儿')
for (const row of rows) {
  const orphans = row.sessions.length - row.attached
  console.log(
    row.path.padEnd(52),
    String(row.sessions.length).padStart(4),
    String(row.attached).padStart(4),
    String(orphans).padStart(4),
  )
}

// 映射里指向不存在会话的条目
const broken = []
if (existsSync(mappingFile)) {
  const mappings = JSON.parse(readFileSync(mappingFile, 'utf8'))
  for (const [key, record] of Object.entries(mappings)) {
    const id = record?.sessionId
    if (typeof id !== 'string') continue
    const found = rows.some(row => row.sessions.includes(id))
    if (!found) broken.push({ key, sessionId: id })
  }
}

console.log(`\n磁盘会话总数: ${totalOnDisk}`)
if (broken.length > 0) {
  console.log(`\n坏映射 ${broken.length} 条（指向已删除的会话，下一条消息会自愈）：`)
  for (const item of broken) console.log(`  ${item.key} → ${item.sessionId}`)
} else {
  console.log('映射干净：没有指向已删除会话的条目')
}

const orphanTotal = rows.reduce((sum, row) => sum + row.sessions.length - row.attached, 0)
if (orphanTotal > 0) {
  console.log(`\n孤儿会话 ${orphanTotal} 个：文件在磁盘上，但不在任何工作区里。`)
  console.log('通常是工作区路径改过、或工作区登记被删掉了。')
}
