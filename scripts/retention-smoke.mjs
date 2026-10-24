// 保留策略自测：在临时 home 上跑，确认归档/清除/跳过都对。
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

let failed = 0
const check = (ok, label, detail = '') => {
  if (!ok) failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail === '' ? '' : `: ${detail}`}`)
}

const root = mkdtempSync(path.join(tmpdir(), 'retention-'))
const dsh = path.join(root, 'dsh')
mkdirSync(path.join(dsh, 'cs-runtime/data'), { recursive: true })
mkdirSync(path.join(dsh, 'storages'), { recursive: true })

const ago = days => new Date(Date.now() - days * 86_400_000).toISOString()
const records = {
  'qq:group:G1': { sessionId: 'chan-g1', key: 'qq:group:G1', channel: 'qq', groupId: 'G1', senderId: 'u1', mode: 'ai', lastSeenAt: ago(10) },
  'qq:u2': { sessionId: 'chan-u2', key: 'qq:u2', channel: 'qq', groupId: null, senderId: 'u2', mode: 'ai', lastSeenAt: ago(100) },
  'qq:u3': { sessionId: 'chan-u3', key: 'qq:u3', channel: 'qq', groupId: null, senderId: 'u3', mode: 'ai', lastSeenAt: ago(0.01) },
  'qq:u4': { sessionId: 'chan-u4', key: 'qq:u4', channel: 'qq', groupId: null, senderId: 'u4', mode: 'human', lastSeenAt: ago(100) },
}
writeFileSync(path.join(dsh, 'cs-runtime/data/sessions.json'), JSON.stringify(records))

const workspace = {
  unit: { name: 'workspace', version: 2 },
  global: { initialized: true, workspaceIds: ['ws1'] },
  tables: { workspaces: { ws1: { path: path.join(dsh, 'cs-runtime/customer'), title: '客服', sessionIds: ['chan-g1', 'chan-u2', 'chan-u3', 'chan-u4'] } } },
}
writeFileSync(path.join(dsh, 'storages/workspace.json'), JSON.stringify(workspace))

for (const id of ['chan-g1', 'chan-u2', 'chan-u3', 'chan-u4']) {
  mkdirSync(path.join(dsh, 'sessions/--customer--', id), { recursive: true })
  writeFileSync(path.join(dsh, 'sessions/--customer--', id, 'session.v4.jsonl.zstd'), 'x')
}

const script = path.join(import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname), 'retention.mjs')
const run = extra => execFileSync(process.execPath, [script, '--home', dsh, ...extra], { encoding: 'utf8' })

const dry = run([])
check(dry.includes('dry run'), 'dry run does not execute')
check(JSON.parse(readFileSync(path.join(dsh, 'cs-runtime/data/sessions.json'), 'utf8'))['qq:u2'] !== undefined, 'dry run keeps the mapping')

const out = run(['--yes'])
check(out.includes('完成'), 'run reports completion', out.split('\n').at(-2))

const after = JSON.parse(readFileSync(path.join(dsh, 'cs-runtime/data/sessions.json'), 'utf8'))
check(after['qq:group:G1']?.archivedAt !== undefined, 'old group conversation is archived')
check(after['qq:u2'] === undefined, 'old private conversation is purged')
check(after['qq:u3'] !== undefined && after['qq:u3'].archivedAt === undefined, 'recent conversation is untouched')
check(after['qq:u4'] !== undefined && after['qq:u4'].archivedAt === undefined, 'human-handled conversation is skipped')
check(!existsSync(path.join(dsh, 'sessions/--customer--', 'chan-u2')), 'purged session directory is deleted')
check(existsSync(path.join(dsh, 'sessions/--customer--', 'chan-g1')), 'archived session files are kept')

const workspaceAfter = JSON.parse(readFileSync(path.join(dsh, 'storages/workspace.json'), 'utf8'))
const ids = workspaceAfter.tables.workspaces.ws1.sessionIds
check(!ids.includes('chan-g1') && !ids.includes('chan-u2'), 'archived and purged sessions are detached')
check(ids.includes('chan-u3'), 'recent conversation stays attached')

rmSync(root, { recursive: true, force: true })
process.exit(failed === 0 ? 0 : 1)
