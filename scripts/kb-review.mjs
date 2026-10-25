#!/usr/bin/env node
/**
 * Review queue for the knowledge base.
 *
 * The agent may propose a new incident while answering a customer, but nothing
 * it writes is searchable until a human promotes it. This CLI is that human
 * step, plus the retirement path for entries that stopped being true.
 *
 *   node scripts/kb-review.mjs list                  # pending candidates
 *   node scripts/kb-review.mjs show <id>             # full candidate
 *   node scripts/kb-review.mjs verify <id> [--ops|--internal] [--by NAME]
 *   node scripts/kb-review.mjs reject <id> --reason "…"
 *   node scripts/kb-review.mjs expire <id> --reason "…" [--superseded-by OTHER]
 *   node scripts/kb-review.mjs duplicates            # near-identical signatures
 *   node scripts/kb-review.mjs stats                 # counts and top recurrences
 *
 * Every command is read-only until you run verify / reject / expire.
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createKbStore } from '../kb-core/index.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const workspace = path.resolve(here, '..')

/**
 * Split argv into a command and `--flag value` pairs.
 *
 * @param {string[]} argv - process arguments.
 * @returns {{command: string, args: string[], flags: Record<string, string|boolean>}} parsed input.
 */
function parse(argv) {
  const flags = {}
  const args = []
  let command = ''
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token.startsWith('--')) {
      const name = token.slice(2)
      const next = argv[index + 1]
      if (next === undefined || next.startsWith('--')) flags[name] = true
      else {
        flags[name] = next
        index += 1
      }
    } else if (command === '') command = token
    else args.push(token)
  }
  return { command, args, flags }
}

const { command, args, flags } = parse(process.argv.slice(2))
const store = createKbStore({
  kbDir: path.resolve(workspace, String(flags.kb ?? 'kb')),
  opsKbDir: path.resolve(workspace, String(flags['ops-kb'] ?? 'ops-kb')),
  dataDir: path.resolve(workspace, String(flags['data-dir'] ?? path.join('.review', 'data'))),
})

/**
 * Print one candidate or entry as readable text.
 *
 * @param {object} item - candidate or entry.
 * @returns {void}
 */
function show(item) {
  const lines = [
    `id          ${item.id}`,
    `title       ${item.title ?? ''}`,
    `status      ${item.status ?? 'candidate'}   audience ${item.audience ?? 'customer'}`,
    `signatures  ${(item.errorSignatures ?? []).join(' | ')}`,
    `services    ${(item.services ?? []).join(', ')}   env ${(item.environments ?? []).join(', ')}`,
    '',
    `现象        ${item.symptom ?? ''}`,
    `答复        ${item.customerReply ?? ''}`,
    `根因        ${item.rootCause ?? ''}`,
    `处置        ${item.resolution ?? ''}`,
    `验证        ${item.verification ?? ''}`,
  ]
  if (item.file !== undefined) lines.push('', `file        ${item.file}`)
  console.log(lines.join('\n'))
}

if (command === '' || command === 'list') {
  const pending = await store.candidates()
  if (pending.length === 0) {
    console.log('没有待审核的候选。')
  } else {
    console.log(`${pending.length} 个待审核候选：`)
    for (const item of pending) {
      const sigs = (item.errorSignatures ?? []).slice(0, 3).join(' | ')
      console.log(`  ${item.id}  ${item.title ?? ''}${sigs === '' ? '' : `   [${sigs}]`}`)
    }
    console.log('')
    console.log('用 `show <id>` 看全文，`verify <id>` 入库，`reject <id> --reason "…"` 丢弃。')
  }
} else if (command === 'show') {
  const id = args[0]
  const pending = await store.candidates()
  const candidate = pending.find(item => item.id === id)
  if (candidate === undefined) {
    const lookup = await store.get(id, 'ops')
    if (!lookup.found) {
      console.error(`没有找到 ${id}`)
      process.exit(1)
    }
    show(lookup.entry)
  } else show(candidate)
} else if (command === 'verify') {
  const id = args[0]
  const audience = flags.internal === true ? 'internal' : flags.ops === true ? 'ops' : undefined
  const result = await store.verify(id, { audience, reviewer: typeof flags.by === 'string' ? flags.by : 'admin' })
  if (!result.ok) {
    console.error(result.reason)
    process.exit(1)
  }
  console.log(`已入库：${result.path}`)
  console.log('检索索引按条目内容自动重建，不需要额外操作。')
} else if (command === 'reject') {
  const id = args[0]
  const reason = typeof flags.reason === 'string' ? flags.reason : ''
  if (reason === '') {
    console.error('请用 --reason 写清楚丢弃原因，方便以后回看。')
    process.exit(1)
  }
  const result = await store.reject(id, { reason })
  if (!result.ok) {
    console.error(result.reason)
    process.exit(1)
  }
  console.log(`已丢弃 ${id}（记录在 _rejected 里，不会进入检索）。`)
} else if (command === 'expire') {
  const id = args[0]
  const reason = typeof flags.reason === 'string' ? flags.reason : ''
  if (reason === '') {
    console.error('请用 --reason 说明为什么这条不再成立。')
    process.exit(1)
  }
  const result = await store.expire(id, {
    reason,
    supersededBy: typeof flags['superseded-by'] === 'string' ? flags['superseded-by'] : undefined,
  })
  if (!result.ok) {
    console.error(result.reason)
    process.exit(1)
  }
  console.log(`已标记失效：${result.path}`)
  console.log('条目仍然保留可查，但不会再出现在检索结果里。')
} else if (command === 'duplicates') {
  const groups = await store.duplicates()
  if (groups.length === 0) {
    console.log('没有发现签名高度重合的条目。')
  } else {
    console.log(`${groups.length} 组疑似重复（签名 Jaccard ≥ 0.5）：`)
    for (const group of groups) {
      console.log(`  ${group.id} (${group.kind})`)
      for (const member of group.members) {
        console.log(`    ← ${member.id} (${member.kind}) ${member.title}  ${(member.similarity * 100).toFixed(0)}%`)
      }
    }
    console.log('')
    console.log('合并方式：保留更完整的一条，把另一条 `expire <id> --superseded-by <保留的 id>`。')
  }
} else if (command === 'stats') {
  const stats = await store.stats()
  const ledger = await store.ledger()
  console.log(`共享条目 ${stats.shared}   运维条目 ${stats.internal}   待审核 ${stats.candidates}`)
  console.log(`已失效 ${stats.deprecated}   重复出现 ${stats.recurring}   被引用 ${stats.served}`)
  console.log(`向量后端 ${stats.embedding}`)
  const ranked = Object.entries(ledger)
    .sort((a, b) => b[1].occurrences - a[1].occurrences)
    .slice(0, 10)
  if (ranked.length > 0) {
    console.log('')
    console.log('出现次数最多的条目：')
    for (const [id, counts] of ranked) {
      console.log(`  ${id.padEnd(32)} 出现 ${counts.occurrences} 次  被引用 ${counts.served} 次`)
    }
  }
} else {
  console.error(`未知命令 ${command}`)
  console.error('可用：list | show <id> | verify <id> | reject <id> | expire <id> | duplicates | stats')
  process.exit(1)
}
