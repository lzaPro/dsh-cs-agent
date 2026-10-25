#!/usr/bin/env node
/**
 * 配置落点检查（两个包分开校验）。
 *
 * 2026-10-23 出过一次事故：`adapterCommand` 被写到了 ops-dispatch 行上，
 * 因为两行的 `notifyWebhook` 一模一样，字符串替换锚错了行。
 *
 *   node scripts/check-config.mjs
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const problems = []
const EXPECTED_ROWS = {
  'cs-agent/cordis.patch.yml': ['channel-gateway', 'preset-service-desk'],
  'kb-core/cordis.patch.yml': ['kb-store'],
  'ops-agent/cordis.patch.yml': ['ops-dispatch', 'ops-panel', 'ops-panel-ui', 'preset-ops'],
}

/** 按 `    - id: <id>` 切出行块。 */
function blocks(source) {
  const map = new Map()
  let current
  for (const line of source.split('\n')) {
    const match = /^ {4}- id: (.+)$/.exec(line)
    if (match !== null) {
      current = match[1].trim()
      map.set(current, [])
      continue
    }
    if (current !== undefined) map.get(current).push(line)
  }
  return map
}

const patches = {}
for (const [file, rows] of Object.entries(EXPECTED_ROWS)) {
  let source
  try {
    source = readFileSync(join(root, file), 'utf8')
  } catch {
    problems.push(`${file}: missing`)
    continue
  }
  const parsed = blocks(source)
  patches[file] = parsed
  for (const row of rows) {
    if (!parsed.has(row)) problems.push(`${file}: missing row "${row}"`)
  }
  for (const row of parsed.keys()) {
    if (!rows.includes(row)) problems.push(`${file}: unexpected row "${row}"`)
  }
}

/** 断言某行块包含 / 不包含某些文本。 */
function expect(file, row, needle, present = true) {
  const body = patches[file]?.get(row)
  if (body === undefined) return
  const found = body.join('\n').includes(needle)
  if (found !== present) {
    problems.push(`${file} row "${row}" must ${present ? 'contain' : 'not contain'} "${needle}"`)
  }
}

const agent = 'cs-agent/cordis.patch.yml'
const ops = 'ops-agent/cordis.patch.yml'
const kb = 'kb-core/cordis.patch.yml'

expect(agent, 'channel-gateway', 'route: /channel')
expect(agent, 'channel-gateway', 'agentPreset: service-desk')
expect(agent, 'channel-gateway', 'forward: final')
expect(agent, 'preset-service-desk', "name: '@local/dsh-cs-agent/ocr'")
expect(agent, 'preset-service-desk', "name: '@local/dsh-cs-agent/handoff'")
expect(ops, 'ops-dispatch', 'opsPreset: ops')
expect(ops, 'ops-dispatch', 'adapterCommand:', false)
// 发版要求：两个 patch 里不能出现机器相关的绝对路径
for (const [file, rows] of Object.entries(patches)) {
  for (const row of rows.keys()) {
    if (/^\s+.*:\s+\/Users\//m.test(patches[file].get(row).join('\n'))) {
      problems.push(`${file} row "${row}" still contains an absolute /Users/ path`)
    }
  }
}
// 运维预设必须挂共享知识库（role: ops）和本包的只读集群工具
expect(ops, 'preset-ops', "name: '@local/dsh-kb/tools'")
expect(ops, 'preset-ops', 'role: ops')
expect(ops, 'preset-ops', "name: '@local/dsh-ops-agent/cluster'")
expect(ops, 'preset-ops', "name: '@local/dsh-ops-agent/task-tools'")
// 拿掉 bash：否则 ops_k8s 的只读白名单和审批都能被绕过
expect(ops, 'preset-ops', "name: '@deepseek-ai/dsh-tool-bash'", false)
expect(ops, 'preset-ops', 'tool-fs', true)
expect(kb, 'kb-store', "name: '@local/dsh-kb'")
// 浏览器侧只认裸包名行：写成子路径，面板在 Web 里就静默消失（2026-10-24 踩过）。
expect(ops, 'ops-panel-ui', "name: '@local/dsh-ops-agent'")
expect(ops, 'ops-panel', 'route: /ops')
// 技能：宿主在 web-app 层关了 skill-filesystem/tool-skill，两个预设都必须自己挂。
expect(ops, 'preset-ops', "name: '@deepseek-ai/dsh-skill-filesystem'")
expect(ops, 'preset-ops', "name: '@deepseek-ai/dsh-tool-skill'")
expect(agent, 'preset-service-desk', "name: '@deepseek-ai/dsh-skill-filesystem'")
expect(agent, 'preset-service-desk', "name: '@deepseek-ai/dsh-tool-skill'")
expect(ops, 'ops-dispatch', "name: '@local/dsh-ops-agent/dispatcher'")

const totalRows = Object.values(patches).reduce((sum, map) => sum + map.size, 0)
if (problems.length === 0) console.log(`PASS ${totalRows} rows across ${Object.keys(patches).length} patches`)
for (const problem of problems) console.log(`FAIL ${problem}`)
console.log(`\n${totalRows} rows checked, ${problems.length} problems`)
process.exit(problems.length === 0 ? 0 : 1)
