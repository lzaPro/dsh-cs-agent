#!/usr/bin/env node
/**
 * 运营面板的内联脚本语法检查。
 * 面板是一个模板字符串，写错引号只会在浏览器里炸，node --check 查不出来。
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createGateway } from '../cs-agent/gateway.js'
import { handleHttp } from '../ops-agent/panel.js'

const temp = mkdtempSync(path.join(tmpdir(), 'panel-check-'))
const ctx = {
  logger: { warn() {}, info() {} },
  agentDefaultModel: { currentSelection: () => ({ provider: 't', model: 't' }) },
  agentPresets: { async mount() {} },
  sessionTitle: { rename() {} },
  agents: {
    async create(options) { return { agent: { id: options.sessionId, followup() {}, inject() {} } } },
    get() {},
    async resume() { throw new Error('no') },
  },
  workspaceRegistry: {
    list: () => [],
    create: async () => ({ id: 'ws', sessionIds: [], attachSession: async () => {}, setTitle: async () => {} }),
  },
}

const gateway = createGateway(ctx, {
  route: '/channel',
  workspace: temp,
  agentPreset: 'service-desk',
  dataFile: path.join(temp, 'sessions.json'),
  outbox: path.join(temp, 'outbox.jsonl'),
  sessionsRoot: path.join(temp, 'sessions-root'),
})

const response = { code: 0, body: '', writeHead(code) { this.code = code }, end(body) { this.body = body } }
await gateway.handleHttp({ method: 'GET', url: '/channel/panel', headers: {} }, response)

if (response.code !== 200) {
  console.error(`FAIL panel responded ${response.code}`)
  process.exit(1)
}

const script = response.body.split('<script>')[1]?.split('</script>')[0]
if (script === undefined) {
  console.error('FAIL panel has no inline script')
  process.exit(1)
}

const file = path.join(temp, 'panel.js')
writeFileSync(file, script)
try {
  execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' })
  console.log('PASS panel inline script parses')
} catch (error) {
  console.error(`FAIL panel inline script: ${error.stderr?.toString() ?? error.message}`)
  process.exit(1)
} finally {
  rmSync(temp, { recursive: true, force: true })
}

for (const marker of ['/orphans', '/adapter', '/mode', '/reply', '/label',
  '/health', '/dead', '/replay', '/retention', '/audit', '/usage', '/whoami', '/alerts']) {
  if (!script.includes(marker)) {
    console.error(`FAIL panel script is missing ${marker}`)
    process.exit(1)
  }
}
console.log('PASS panel wires every endpoint')

// 运维视图是这一阶段新加的东西：按钮、重放入口、保留期执行入口都得在生成的 HTML 里，
// 少一个页面看着正常但那一块没法用。
for (const marker of ['id="ops-open"', "data-replay=", "data-replay-all=", 'id="ops-purge"', 'id="ops-scan"', 'id="ops-usage"', '死信', '数据保留', '用量', '自动清理', 'id="role-tag"', '告警']) {
  if (!response.body.includes(marker)) {
    console.error(`FAIL panel markup is missing ${marker}`)
    process.exit(1)
  }
}
console.log('PASS panel exposes the ops view')

// 运维视图读的是这四个端点的字段名。字段改名而 UI 不改，页面不会报错，
// 只会显示"未启用/没有"——所以在这里把契约钉住。
{
  const expect = async (url, keys, label) => {
    const res = { code: 0, body: '', writeHead(code) { this.code = code }, end(body) { this.body = body } }
    await gateway.handleHttp({ method: 'GET', url, headers: {} }, res)
    const body = JSON.parse(res.body)
    for (const key of keys) {
      if (!(key in body)) {
        console.error(`FAIL ${label} is missing ${key}`)
        process.exit(1)
      }
    }
  }
  await expect('/channel/health', ['ok', 'uptimeMs', 'store', 'lease', 'queues', 'checks'], 'health')
  await expect('/channel/dead', ['inbox'], 'dead letters')
  await expect('/channel/retention', ['dryRun', 'archive', 'purge', 'limits'], 'retention plan')
  await expect('/channel/audit', ['entries'], 'audit log')
  await expect('/channel/usage?days=7', ['days', 'pricing', 'totals', 'rows'], 'usage report')
  await expect('/channel/alerts?limit=5', ['status', 'entries'], 'alert feed')
  console.log('PASS ops view endpoints keep their shape')
}

// ── 运维控制台：/ops/panel 的内联脚本同样用模板字符串拼，语法错只会在浏览器里炸。
{
  const opsTemp = mkdtempSync(path.join(tmpdir(), 'ops-panel-check-'))
  const opsCtx = {
    get: () => undefined,
    logger: { warn() {}, info() {} },
  }
  const panel = { route: '/ops', cluster: { env: async () => ({ ok: true, checks: [] }) } }
  const response = { code: 0, body: '', writeHead(code) { this.code = code }, end(body) { this.body = body } }
  await handleHttp(opsCtx, panel, { method: 'GET', url: '/ops/panel', headers: {} }, response)

  if (response.code !== 200) {
    console.error(`FAIL ops panel responded ${response.code}`)
    process.exit(1)
  }
  const opsScript = response.body.split('<script>')[1]?.split('</script>')[0]
  if (opsScript === undefined) {
    console.error('FAIL ops panel has no inline script')
    process.exit(1)
  }
  const opsFile = path.join(opsTemp, 'panel.js')
  writeFileSync(opsFile, opsScript)
  try {
    execFileSync(process.execPath, ['--check', opsFile], { stdio: 'pipe' })
    console.log('PASS ops panel inline script parses')
  } catch (error) {
    console.error(`FAIL ops panel inline script: ${error.stderr?.toString() ?? error.message}`)
    process.exit(1)
  } finally {
    rmSync(opsTemp, { recursive: true, force: true })
  }
  for (const marker of ['/status', '/incidents', '/proposals', '/kb/candidates', '/archive', '/delete', 'showArchived', "el('q')", 'data-archive=', 'data-del=']) {
    if (!opsScript.includes(marker)) {
      console.error(`FAIL ops panel script is missing ${marker}`)
      process.exit(1)
    }
  }
  console.log('PASS ops panel wires every endpoint')
  // 搜索框和归档开关是可见控件：模板里少了任何一个，页面看着正常但没法用。
  for (const marker of ['id="q"', 'id="showArchived"', '含归档']) {
    if (!response.body.includes(marker)) {
      console.error(`FAIL ops panel markup is missing ${marker}`)
      process.exit(1)
    }
  }
  console.log('PASS ops panel exposes search and archive controls')
}
