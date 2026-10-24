#!/usr/bin/env node
/**
 * 客服回复评测：把 eval/cases.json 里的问法各跑一遍，收集回复。
 *
 *   node scripts/eval-cs.mjs [--base http://127.0.0.1:3080] [--wait 180]
 *
 * 每个用例用独立的 senderId，等于每个都是新会话。
 * 结果写到 eval/last-run.json，控制台打印摘要。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const args = process.argv.slice(2)
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index === -1 ? fallback : args[index + 1]
}

const base = option('base', 'http://127.0.0.1:3080')
const waitSeconds = Number(option('wait', '180'))
const runId = new Date().toISOString().replace(/[-:T]/g, '').slice(2, 14)
const cases = JSON.parse(readFileSync(join(root, 'eval/cases.json'), 'utf8'))

// 泄漏检测：出现这些词说明回复跑偏了，哪怕答得通顺也算失败。
const LEAKS = [
  ['实现细节', /DSH|Harness|agent|prompt|token/iu],
  ['知识库编号', /知识库条目|`[a-z][a-z0-9-]{6,}`/u],
  ['检索旁白', /我先查|查一下知识库|查询结果匹配/u],
  ['错误承诺', /我去查|我这边核对|我先确认一下你的实例|我帮你查/u],
  ['平台术语', /插件|扩展|预设|社区/u],
  ['URL', /https?:\/\//u],
]

const keyOf = id => `qq:eval-${runId}-${id}`

if (args.includes('--report')) {
  const saved = JSON.parse(readFileSync(join(root, 'eval/last-run.json'), 'utf8'))
  report(saved.rows)
  process.exit(0)
}

console.log(`running ${cases.length} cases (run ${runId})`)

// 1. 派发
for (const item of cases) {
  const response = await fetch(`${base}/channel`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      channel: 'eval',
      senderId: `eval-${runId}-${item.id}`,
      messageId: `eval-${runId}-${item.id}`,
      text: item.text,
    }),
    signal: AbortSignal.timeout(10_000),
  })
  if (response.status !== 202) {
    console.error(`  ${item.id}: HTTP ${response.status} ${await response.text()}`)
  }
}

// 2. 收集回复
const replies = new Map()
const deadline = Date.now() + waitSeconds * 1000
while (Date.now() < deadline && replies.size < cases.length) {
  await new Promise(resolve => setTimeout(resolve, 3000))
  try {
    const response = await fetch(`${base}/channel/outbox?limit=200`, { signal: AbortSignal.timeout(5000) })
    const body = await response.json()
    for (const message of body.messages ?? []) {
      if (!message.key.startsWith(`qq:eval-${runId}-`)) continue
      replies.set(message.key, message.text)
    }
  } catch {
    // 下一轮再试
  }
  process.stdout.write(`\rcollected ${replies.size}/${cases.length}`)
}
console.log('')

// 3. 输出
const rows = cases.map((item) => {
  const text = replies.get(keyOf(item.id)) ?? ''
  return {
    id: item.id,
    question: item.text,
    expect: item.expect,
    reply: text,
    answered: text !== '',
    fallback: text.includes('没处理成功'),
  }
})

mkdirSync(join(root, 'eval'), { recursive: true })
writeFileSync(join(root, 'eval/last-run.json'), `${JSON.stringify({ runId, at: new Date().toISOString(), rows }, undefined, 2)}\n`)

for (const row of rows) {
  const mark = row.answered ? (row.fallback ? 'FALLBACK' : 'OK') : 'MISSING'
  console.log(`\n[${mark}] ${row.id}  —  ${row.question}`)
  console.log(`  期望: ${row.expect}`)
  console.log(`  回复: ${row.reply.replace(/\s+/g, ' ').slice(0, 220) || '(无)'}`)
}

// 4. 清理评测会话（保留会话会让侧边栏堆满测试记录）
if (!args.includes('--keep')) {
  for (const item of cases) {
    await fetch(`${base}/channel/reset`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: keyOf(item.id) }),
      signal: AbortSignal.timeout(5000),
    }).catch(() => {})
  }
  console.log(`cleaned up ${cases.length} eval sessions (use --keep to retain)`)
}

const ok = rows.filter(row => row.answered && !row.fallback).length
console.log(`\n${ok}/${rows.length} answered`)
process.exit(report(rows, ok === rows.length) ? 0 : 1)

/** 打印泄漏指标；有泄漏或未作答时返回 false。 */
function report(rows, allAnswered = true) {
  console.log('')
  let clean = allAnswered
  for (const [label, pattern] of LEAKS) {
    const hits = rows.filter(row => pattern.test(row.reply))
    if (hits.length > 0) clean = false
    console.log(`${hits.length === 0 ? 'PASS' : 'FAIL'} ${label}${hits.length === 0 ? '' : ` — ${hits.map(row => row.id).join(', ')}`}`)
  }
  const missing = rows.filter(row => !row.answered || row.fallback)
  if (missing.length > 0) console.log(`FAIL unanswered — ${missing.map(row => row.id).join(', ')}`)
  return clean
}
