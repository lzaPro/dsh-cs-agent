#!/usr/bin/env node
/**
 * 迁移客服运行目录（含会话）。
 *
 * DSH 的会话目录名、工作区归属都由会话头里的 `cwd` 决定，所以迁移四件事必须一起做：
 *   1. 复制运行目录到新位置
 *   2. 按新路径重命名会话目录
 *   3. 改写每个会话头的 cwd
 *   4. 更新工作区登记和插件配置里的路径
 *
 * 默认 dry-run；--yes 才执行。源目录保留，确认无误后手动删除。
 *
 *   node scripts/move-runtime.mjs --to /Volumes/Data/cs-runtime
 *   node scripts/move-runtime.mjs --to /Volumes/Data/cs-runtime --yes
 *
 * 测试用 --home 指向临时目录，避免碰真实数据。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { homedir } from 'node:os'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'

const args = process.argv.slice(2)
const value = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index === -1 ? fallback : args[index + 1]
}
const home = value('home', join(homedir(), '.dsh'))
const from = value('from', join(home, 'cs-runtime'))
const to = value('to')
const yes = args.includes('--yes')
const force = args.includes('--force')
const configPath = value('config', join(process.cwd(), 'cs-agent/cordis.patch.yml'))

if (to === undefined) {
  console.error('usage: move-runtime.mjs --to <new-root> [--from <old-root>] [--home <dsh-home>] [--config <patch>] [--yes] [--force]')
  process.exit(2)
}

const workspaceFile = join(home, 'storages/workspace.json')
const sessionsRoot = join(home, 'sessions')

/** 工作区路径 → 会话目录名。 */
const encode = path => `--${path.replace(/^\//, '').replaceAll('/', '-')}--`

/** 目标路径是否为空目录或不存在。 */
function targetUsable(path) {
  if (!existsSync(path)) return true
  return statSync(path).isDirectory() && readdirSync(path).length === 0
}

/** 递归复制目录。 */
function copyTree(source, target) {
  mkdirSync(target, { recursive: true })
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const src = join(source, entry.name)
    const dst = join(target, entry.name)
    if (entry.isDirectory()) copyTree(src, dst)
    else copyFileSync(src, dst)
  }
}

/** 把所有 zstd 帧解成一段 JSONL 文本。 */
function decodeAll(buffer) {
  if (buffer.length === 0) return ''
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
  const offsets = []
  for (let i = 0; i + 4 <= buffer.length; i += 1) {
    if (buffer.compare(magic, 0, 4, i, i + 4) === 0) offsets.push(i)
  }
  if (offsets.length === 0) throw new Error('not a zstd stream')
  let text = ''
  for (let i = 0; i < offsets.length; i += 1) {
    const slice = buffer.subarray(offsets[i], i + 1 < offsets.length ? offsets[i + 1] : buffer.length)
    text += zstdDecompressSync(slice).toString('utf8')
  }
  return text
}

/** 改写一个会话文件头里的 cwd，其它事件原样保留。 */
function rewriteSessionCwd(file, oldPath, newPath) {
  const buffer = readFileSync(file)
  const text = decodeAll(buffer)
  const lines = text.split('\n').filter(line => line !== '')
  if (lines.length === 0) throw new Error(`${file}: empty session log`)
  const header = JSON.parse(lines[0])
  if (header.type !== 'session') throw new Error(`${file}: first event is not a session header`)
  if (header.cwd !== oldPath) return false
  header.cwd = newPath
  lines[0] = JSON.stringify(header)
  writeFileSync(file, zstdCompressSync(Buffer.from(`${lines.join('\n')}\n`, 'utf8')))
  return true
}

/** 读工作区登记。 */
function readRegistry() {
  if (!existsSync(workspaceFile)) return { store: undefined, selected: [] }
  const store = JSON.parse(readFileSync(workspaceFile, 'utf8'))
  const ids = store.global?.workspaceIds ?? []
  const selected = ids
    .map(id => ({ id, record: store.tables.workspaces[id] }))
    .filter(item => item.record?.path?.startsWith(`${from}/`) || item.record?.path === from)
  return { store, selected }
}

// ── 规划 ────────────────────────────────────────────────────────────────
if (!existsSync(from)) {
  console.error(`source does not exist: ${from}`)
  process.exit(1)
}
if (!targetUsable(to)) {
  console.error(`target is not empty: ${to}`)
  process.exit(1)
}
if (to.startsWith(`${from}/`) || from.startsWith(`${to}/`)) {
  console.error('target must not be inside the source (or the reverse)')
  process.exit(1)
}
if (!force) {
  try {
    await fetch('http://127.0.0.1:3080/', { signal: AbortSignal.timeout(1500) })
    console.error('dsh web appears to be running on :3080 — stop it first, or pass --force')
    process.exit(1)
  } catch {
    // 连不上就是停着的，继续
  }
}

const { store, selected } = readRegistry()
if (selected.length === 0) {
  console.error(`no workspace is registered under ${from}`)
  process.exit(1)
}

const plan = []
for (const { id, record } of selected) {
  const suffix = record.path.slice(from.length)
  const newPath = `${to}${suffix}`
  const oldDir = join(sessionsRoot, encode(record.path))
  const newDir = join(sessionsRoot, encode(newPath))
  const sessions = existsSync(oldDir) ? readdirSync(oldDir).filter(name => /^(chan|ops|session)-/.test(name)) : []
  plan.push({ id, oldPath: record.path, newPath, oldDir, newDir, sessions })
}

console.log(`source: ${from}`)
console.log(`target: ${to}`)
console.log(`config: ${configPath}\n`)
for (const item of plan) {
  console.log(`${item.oldPath}\n  → ${item.newPath}`)
  console.log(`  sessions: ${item.sessions.length} (${item.sessions.slice(0, 3).join(', ')}${item.sessions.length > 3 ? '…' : ''})`)
}

if (!yes) {
  console.log('\n(dry run) 加 --yes 执行。源目录会保留，确认无误后再删。')
  process.exit(0)
}

// ── 执行 ────────────────────────────────────────────────────────────────
mkdirSync(dirname(to), { recursive: true })
copyTree(from, to)
console.log(`\ncopied ${from} → ${to}`)

const moved = []
for (const item of plan) {
  mkdirSync(item.newPath, { recursive: true })
  if (!existsSync(item.oldDir)) continue
  // 会话文件先复制到新目录，再改 cwd；旧目录不动。
  copyTree(item.oldDir, item.newDir)
  for (const session of item.sessions) {
    const file = join(item.newDir, session, 'session.v4.jsonl.zstd')
    if (!existsSync(file)) continue
    rewriteSessionCwd(file, item.oldPath, item.newPath)
  }
  moved.push(item)
  console.log(`sessions moved: ${item.oldDir} → ${item.newDir}`)
}

// 工作区登记改路径
if (store !== undefined) {
  copyFileSync(workspaceFile, `${workspaceFile}.pre-move.bak`)
  for (const { id, record } of selected) {
    const suffix = record.path.slice(from.length)
    store.tables.workspaces[id].path = `${to}${suffix}`
  }
  writeFileSync(workspaceFile, `${JSON.stringify(store, undefined, 2)}\n`)
  console.log(`workspace registry updated (backup: ${workspaceFile}.pre-move.bak)`)
}

// 插件配置改路径
if (existsSync(configPath)) {
  const config = readFileSync(configPath, 'utf8')
  if (config.includes(from)) {
    copyFileSync(configPath, `${configPath}.pre-move.bak`)
    writeFileSync(configPath, config.replaceAll(from, to))
    console.log(`config rewritten: ${configPath} (backup: ${configPath}.pre-move.bak)`)
  }
}

// 校验
let total = 0
for (const item of plan) {
  if (!existsSync(item.newDir)) continue
  for (const session of item.sessions) {
    const file = join(item.newDir, session, 'session.v4.jsonl.zstd')
    if (!existsSync(file)) continue
    const header = JSON.parse(decodeAll(readFileSync(file)).split('\n')[0])
    if (header.cwd !== item.newPath) {
      console.error(`FAIL ${session}: header cwd is ${header.cwd}, expected ${item.newPath}`)
      process.exit(1)
    }
    total += 1
  }
}

console.log(`\n${total} sessions verified with the new cwd`)
console.log('下一步：重启 dsh，然后跑 node scripts/session-report.mjs 核对')
console.log(`确认无误后手动删除旧目录：${from}`)
