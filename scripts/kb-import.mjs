#!/usr/bin/env node
/**
 * 知识库导入：只接受 JSON，先校验再落盘。
 *
 *   node scripts/kb-import.mjs --from ./incoming                    # dry-run
 *   node scripts/kb-import.mjs --from ./incoming --write            # 真正写入
 *   node scripts/kb-import.mjs --from ./incoming --write --on-conflict rename
 *
 * --from 可以是目录（读其中的 *.json）或单个文件（一个条目，或条目数组）。
 * 默认 dry-run：只报告，不写任何文件。
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'

/** 允许的 audience 值。 */
const AUDIENCES = new Set(['customer', 'ops'])

/** 已知字段；其他字段只警告不拒绝。 */
const KNOWN_FIELDS = new Set([
  'id', 'title', 'status', 'audience', 'errorSignatures', 'services', 'environments',
  'symptom', 'customerReply', 'rootCause', 'resolution', 'verification', 'tags', 'updated',
])

/** 冲突策略。 */
const CONFLICTS = new Set(['skip', 'overwrite', 'rename'])

/**
 * 读取来源，返回 `{ file, entries }[]`。
 * @param {string} from 目录或文件路径
 */
export async function readSource(from) {
  const stat = await fs.stat(from)
  if (stat.isDirectory()) {
    const names = (await fs.readdir(from)).filter(name => name.endsWith('.json') && !name.startsWith('_')).sort()
    const out = []
    for (const name of names) {
      const file = path.join(from, name)
      out.push({ file, entries: expand(await readJson(file), file) })
    }
    return out
  }
  return [{ file: from, entries: expand(await readJson(from), from) }]
}

/** 单个文件可以是条目、条目数组或有 entries 字段的对象。 */
function expand(value, file) {
  if (Array.isArray(value)) return value
  if (value !== null && typeof value === 'object' && Array.isArray(value.entries)) return value.entries
  if (value !== null && typeof value === 'object') return [value]
  throw new Error(`${file}: JSON must be an entry, an array, or { "entries": [...] }`)
}

/** 读一个 JSON 文件，给出可读的失败信息。 */
async function readJson(file) {
  let raw
  try {
    raw = await fs.readFile(file, 'utf8')
  } catch (error) {
    throw new Error(`${file}: cannot read (${error.code ?? error.message})`)
  }
  try {
    return JSON.parse(raw)
  } catch (error) {
    throw new Error(`${file}: invalid JSON (${error.message})`)
  }
}

/**
 * 校验并规划导入，不写文件。
 * @param {object} options
 * @param {string} options.from 来源
 * @param {string} options.to 目标知识库目录
 * @param {'skip'|'overwrite'|'rename'} [options.onConflict]
 */
export async function plan(options) {
  const onConflict = options.onConflict ?? 'skip'
  if (!CONFLICTS.has(onConflict)) throw new Error(`--on-conflict must be one of: ${[...CONFLICTS].join(', ')}`)

  const sources = await readSource(options.from)
  const existing = await loadExisting(options.to)

  const errors = []
  const warnings = []
  const accepted = []
  const seenIds = new Set()
  const signatureOwner = new Map()

  for (const [signature, owner] of existing.signatures) signatureOwner.set(signature, owner)

  for (const source of sources) {
    for (const [index, raw] of source.entries.entries()) {
      const label = source.entries.length > 1 ? `${source.file}[${index}]` : source.file
      const checked = validate(raw, label)
      errors.push(...checked.errors)
      warnings.push(...checked.warnings)
      if (checked.entry === undefined) continue

      const entry = checked.entry
      if (seenIds.has(entry.id)) {
        errors.push(`${label}: duplicate id "${entry.id}" inside the import`)
        continue
      }
      seenIds.add(entry.id)

      for (const signature of entry.errorSignatures) {
        const lowered = signature.toLowerCase()
        const owner = signatureOwner.get(lowered)
        if (owner !== undefined && owner !== entry.id) {
          warnings.push(`${label}: error signature "${signature}" also appears in "${owner}"`)
        }
        signatureOwner.set(lowered, entry.id)
      }

      if (existing.ids.has(entry.id)) {
        if (onConflict === 'skip') {
          warnings.push(`${label}: id "${entry.id}" already exists, skipped`)
          continue
        }
        if (onConflict === 'rename') {
          let suffix = 2
          while (existing.ids.has(`${entry.id}-${suffix}`)) suffix += 1
          const renamed = `${entry.id}-${suffix}`
          warnings.push(`${label}: id "${entry.id}" exists, renamed to "${renamed}"`)
          entry.id = renamed
        }
      }
      accepted.push({ label, entry })
    }
  }

  return { onConflict, errors, warnings, accepted, existing }
}

/** 读取目标目录里已有的条目。 */
async function loadExisting(dir) {
  const ids = new Set()
  const signatures = new Map()
  let names = []
  try {
    names = await fs.readdir(dir)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    return { ids, signatures, dir }
  }
  for (const name of names) {
    if (!name.endsWith('.json') || name.startsWith('_')) continue
    try {
      const data = JSON.parse(await fs.readFile(path.join(dir, name), 'utf8'))
      if (typeof data?.id !== 'string') continue
      ids.add(data.id)
      for (const signature of Array.isArray(data.errorSignatures) ? data.errorSignatures : []) {
        if (typeof signature === 'string') signatures.set(signature.toLowerCase(), data.id)
      }
    } catch {
      // 目标库里的坏文件不阻塞导入，plan 会把它当作不存在
    }
  }
  return { ids, signatures, dir }
}

/** 校验一个条目。 */
function validate(raw, label) {
  const errors = []
  const warnings = []
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { errors: [`${label}: entry must be an object`], warnings }
  }

  const entry = {}
  const id = text(raw.id)
  if (id === '') errors.push(`${label}: "id" is required`)
  else if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) errors.push(`${label}: "id" must be lowercase letters, digits and hyphens`)
  entry.id = id

  for (const field of ['title', 'symptom', 'resolution']) {
    const value = text(raw[field])
    if (value === '') errors.push(`${label}: "${field}" is required`)
    entry[field] = value
  }

  const audience = text(raw.audience)
  if (!AUDIENCES.has(audience)) {
    errors.push(`${label}: "audience" must be "customer" or "ops"`)
  }
  entry.audience = audience

  const status = text(raw.status)
  if (status === '') {
    entry.status = 'unverified'
    warnings.push(`${label}: no "status", imported as unverified`)
  } else if (status !== 'verified' && status !== 'unverified') {
    errors.push(`${label}: "status" must be "verified" or "unverified"`)
  } else {
    entry.status = status
  }

  entry.errorSignatures = stringList(raw.errorSignatures, `${label}: errorSignatures`, errors, warnings)
  entry.services = stringList(raw.services, `${label}: services`, errors, warnings)
  entry.environments = stringList(raw.environments, `${label}: environments`, errors, warnings)
  entry.tags = stringList(raw.tags, `${label}: tags`, errors, warnings)
  if (entry.errorSignatures.length === 0) {
    warnings.push(`${label}: no errorSignatures, retrieval will be weak`)
  }

  entry.customerReply = text(raw.customerReply)
  entry.rootCause = text(raw.rootCause)
  entry.verification = text(raw.verification)
  entry.updated = text(raw.updated)

  for (const key of Object.keys(raw)) {
    if (!KNOWN_FIELDS.has(key)) warnings.push(`${label}: unknown field "${key}" ignored`)
  }

  return errors.length > 0 ? { errors, warnings } : { errors, warnings, entry }
}

/** 读一个字符串数组字段。 */
function stringList(value, label, errors, warnings) {
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    errors.push(`${label} must be an array`)
    return []
  }
  const out = []
  for (const item of value) {
    if (typeof item !== 'string' || item.trim() === '') {
      warnings.push(`${label} contains a non-string item, dropped`)
      continue
    }
    out.push(item.trim())
  }
  return out
}

/** 去空白字符串。 */
function text(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * 把 plan 的结果写进目标目录。
 * @param {Awaited<ReturnType<typeof plan>>} result
 */
export async function apply(result) {
  await fs.mkdir(result.existing.dir, { recursive: true })
  const written = []
  for (const item of result.accepted) {
    const file = path.join(result.existing.dir, `${item.entry.id}.json`)
    await fs.writeFile(file, `${JSON.stringify(item.entry, undefined, 2)}\n`, 'utf8')
    written.push(file)
  }
  return written
}

/** 打印报告。 */
export function report(result) {
  for (const message of result.errors) console.log(`ERROR ${message}`)
  for (const message of result.warnings) console.log(`WARN  ${message}`)
  console.log(`\naccepted ${result.accepted.length} · errors ${result.errors.length} · warnings ${result.warnings.length}`)
  console.log(`conflict policy: ${result.onConflict}`)
  return result.errors.length === 0
}

/** CLI 入口。 */
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2)
  const value = (name, fallback) => {
    const index = args.indexOf(`--${name}`)
    return index === -1 ? fallback : args[index + 1]
  }
  const from = value('from')
  if (from === undefined) {
    console.error('usage: kb-import.mjs --from <dir|file> [--to ./kb] [--write] [--on-conflict skip|overwrite|rename]')
    process.exit(2)
  }
  const to = value('to', path.join(process.cwd(), 'kb'))
  const onConflict = value('on-conflict', 'skip')
  const write = args.includes('--write')

  try {
    const result = await plan({ from: path.resolve(from), to: path.resolve(to), onConflict })
    const clean = report(result)
    if (write && clean) {
      const files = await apply(result)
      console.log(`wrote ${files.length} files to ${path.resolve(to)}`)
    } else if (write && !clean) {
      console.log('refused to write: fix the errors first')
    } else {
      console.log('(dry run) add --write to import')
    }
    process.exit(clean ? 0 : 1)
  } catch (error) {
    console.error(`kb-import: ${error.message}`)
    process.exit(1)
  }
}
