#!/usr/bin/env node
/**
 * 清理客服/运维会话，并把运行数据迁到独立目录。
 *
 *   node scripts/cleanup-sessions.mjs            # 只列出，不删
 *   node scripts/cleanup-sessions.mjs --yes      # 真删
 *
 * 只删 `chan-*` 和 `ops-*`，绝不碰 `session-*`（用户自己的会话）。
 */
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const yes = process.argv.includes('--yes')
const home = homedir()
const sessionsRoot = join(home, '.dsh/sessions')
const workspacePath = join(home, 'Documents/deepseek-harness/default-workspace')
// 扫描所有工作区的会话目录：chan-/ops- 会出现在私聊、群聊、评测、运维四个目录里
const sessionDirs = readdirSync(sessionsRoot, { withFileTypes: true })
  .filter(entry => entry.isDirectory())
  .map(entry => join(sessionsRoot, entry.name))
const workspaceFile = join(home, '.dsh/storages/workspace.json')
const runtimeRoot = join(home, '.dsh/cs-runtime')
const runtimeDirs = ['customer-private', 'customer-group', 'ops', 'data']

const targets = []
let kept = 0
for (const dir of sessionDirs) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    if (/^(chan|ops)-/.test(entry.name)) targets.push(join(dir, entry.name))
    else kept += 1
  }
}

console.log(`session dirs scanned: ${sessionDirs.length}`)
console.log(`to delete: ${targets.length}`)
console.log(`to keep:   ${kept} (用户自己的会话)`)

// 安全断言：每个目标都必须是 chan-/ops- 目录
for (const target of targets) {
  if (!/\/(chan|ops)-[0-9a-f-]+$/.test(target) || !target.startsWith(sessionsRoot)) {
    console.error(`refusing unexpected target: ${target}`)
    process.exit(1)
  }
}

if (!yes) {
  console.log('\n(dry run) add --yes to delete and migrate')
  process.exit(0)
}

const deletedIds = new Set(targets.map(target => target.split('/').pop()))
for (const target of targets) rmSync(target, { recursive: true, force: true })
console.log(`deleted ${targets.length} sessions`)

// 同步清掉会话映射，否则网关下次会去恢复一个已经不存在的会话。
const runtimeMap = join(home, '.dsh/cs-runtime/data/sessions.json')
if (existsSync(runtimeMap)) {
  const map = JSON.parse(readFileSync(runtimeMap, 'utf8'))
  const kept = Object.fromEntries(
    Object.entries(map).filter(([, record]) => !deletedIds.has(record?.sessionId)),
  )
  const dropped = Object.keys(map).length - Object.keys(kept).length
  if (dropped > 0) {
    writeFileSync(runtimeMap, `${JSON.stringify(kept, undefined, 2)}\n`)
    console.log(`dropped ${dropped} stale conversation mappings`)
  }
}

// 建独立运行目录
for (const dir of runtimeDirs) mkdirSync(join(runtimeRoot, dir), { recursive: true })
console.log(`runtime dir: ${runtimeRoot} (${runtimeDirs.join(', ')})`)

// 清理工作区登记：移除已删除的会话；移除旧的 ops-workspace 记录
if (existsSync(workspaceFile)) {
  copyFileSync(workspaceFile, `${workspaceFile}.bak`)
  const store = JSON.parse(readFileSync(workspaceFile, 'utf8'))
  const workspaces = store.tables?.workspaces ?? {}
  let droppedSessions = 0
  let prunedWorkspaces = 0
  for (const [id, record] of Object.entries(workspaces)) {
    if (record?.path === join(workspacePath, 'ops-workspace')) {
      delete workspaces[id]
      store.global.workspaceIds = (store.global.workspaceIds ?? []).filter(item => item !== id)
      continue
    }
    const kept = (record?.sessionIds ?? []).filter((sessionId) => {
      const gone = /^(chan|ops)-/.test(sessionId)
      if (gone) droppedSessions += 1
      return !gone
    })
    record.sessionIds = kept
    // 运行目录下的空工作区（客服私聊/群聊/评测的旧路径）一并移除
    if (kept.length === 0 && record?.path?.startsWith(`${home}/.dsh/cs-runtime/`)) {
      delete workspaces[id]
      store.global.workspaceIds = (store.global.workspaceIds ?? []).filter(item => item !== id)
      prunedWorkspaces += 1
    }
  }
  writeFileSync(workspaceFile, `${JSON.stringify(store, undefined, 2)}\n`)
  console.log(`workspace registry cleaned (${droppedSessions} session refs dropped, ${prunedWorkspaces} empty runtime workspaces removed, backup at ${workspaceFile}.bak)`)
}

console.log('done')
