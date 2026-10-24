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

for (const marker of ['/orphans', '/adapter', '/mode', '/reply', '/label']) {
  if (!script.includes(marker)) {
    console.error(`FAIL panel script is missing ${marker}`)
    process.exit(1)
  }
}
console.log('PASS panel wires every endpoint')
