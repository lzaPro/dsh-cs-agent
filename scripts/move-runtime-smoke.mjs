// 迁移工具自测：在临时 DSH home 上跑一遍，不碰真实数据。
// Run with: node scripts/move-runtime-smoke.mjs
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'

let failed = 0
const check = (ok, label, detail = '') => {
  if (!ok) failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail === '' ? '' : `: ${detail}`}`)
}

const temp = mkdtempSync(path.join(tmpdir(), 'move-'))
const home = path.join(temp, 'dsh-home')
const oldRoot = path.join(home, 'cs-runtime')
const newRoot = path.join(temp, 'moved-runtime')
const oldPath = path.join(oldRoot, 'customer')
const newPath = path.join(newRoot, 'customer')
const encode = p => `--${p.replace(/^\//, '').replaceAll('/', '-')}--`

mkdirSync(oldPath, { recursive: true })
mkdirSync(path.join(oldRoot, 'data'), { recursive: true })
writeFileSync(path.join(oldRoot, 'data/sessions.json'), JSON.stringify({ 'qq:u1': { sessionId: 'chan-a' } }))

const sessionDir = path.join(home, 'sessions', encode(oldPath), 'chan-a')
mkdirSync(sessionDir, { recursive: true })
const header = { type: 'session', version: 4, id: 'chan-a', createdAt: 1, cwd: oldPath, isSeeded: false, delegationDepth: 0, agentPreset: 'service-desk' }
const event = { seq: 1, time: 2, type: 'turn/start', data: { turn: 1 } }
writeFileSync(
  path.join(sessionDir, 'session.v4.jsonl.zstd'),
  zstdCompressSync(Buffer.from(`${JSON.stringify(header)}\n${JSON.stringify(event)}\n`)),
)

mkdirSync(path.join(home, 'storages'), { recursive: true })
writeFileSync(path.join(home, 'storages/workspace.json'), JSON.stringify({
  unit: { name: 'workspace', version: 2 },
  global: { initialized: true, workspaceIds: ['ws1', 'ws2'] },
  tables: {
    workspaces: {
      ws1: { path: oldPath, title: '客服', sessionIds: ['chan-a'], createdAt: '', updatedAt: '' },
      ws2: { path: path.join(temp, 'other'), title: '别的工作区', sessionIds: [], createdAt: '', updatedAt: '' },
    },
  },
}))

const configPath = path.join(temp, 'cordis.patch.yml')
writeFileSync(configPath, `privateWorkspace: ${oldPath}\ndataFile: ${path.join(oldRoot, 'data/sessions.json')}\n`)

const script = path.join(import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname), 'move-runtime.mjs')
const run = extra => execFileSync(process.execPath, [script, '--home', home, '--from', oldRoot, '--to', newRoot, '--config', configPath, '--force', ...extra], { encoding: 'utf8' })

// dry-run 不落盘
const dry = run([])
check(dry.includes('dry run'), 'dry run prints the plan')
check(!existsSync(newRoot), 'dry run writes nothing')

// 真跑
const out = run(['--yes'])
check(out.includes('sessions verified'), 'migration reports verification')

const newSessionDir = path.join(home, 'sessions', encode(newPath), 'chan-a')
check(existsSync(newSessionDir), 'session directory renamed for the new path')
check(existsSync(path.join(home, 'sessions', encode(oldPath), 'chan-a')), 'source session kept for rollback')

const rewritten = zstdDecompressSync(readFileSync(path.join(newSessionDir, 'session.v4.jsonl.zstd'))).toString('utf8')
const first = JSON.parse(rewritten.split('\n')[0])
check(first.cwd === newPath, 'session header cwd rewritten', first.cwd)
check(rewritten.includes('turn/start'), 'other events preserved')

const registry = JSON.parse(readFileSync(path.join(home, 'storages/workspace.json'), 'utf8'))
check(registry.tables.workspaces.ws1.path === newPath, 'workspace path updated')
check(registry.tables.workspaces.ws2.path === path.join(temp, 'other'), 'unrelated workspace untouched')
check(existsSync(path.join(home, 'storages/workspace.json.pre-move.bak')), 'registry backup written')

const config = readFileSync(configPath, 'utf8')
check(config.includes(newPath) && !config.includes(oldPath), 'plugin config rewritten')
check(existsSync(path.join(newRoot, 'data/sessions.json')), 'runtime data copied')

rmSync(temp, { recursive: true, force: true })
process.exit(failed === 0 ? 0 : 1)
