// 知识库导入器自测：校验、冲突策略、dry-run。
// Run with: node scripts/kb-import-smoke.mjs
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply, plan } from './kb-import.mjs'

let failed = 0
const check = (ok, label, detail = '') => {
  if (!ok) failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail === '' ? '' : `: ${detail}`}`)
}

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-import-'))
const source = path.join(temp, 'source')
const target = path.join(temp, 'kb')
await fs.mkdir(source, { recursive: true })
await fs.mkdir(target, { recursive: true })

const good = (id, extra = {}) => ({
  id,
  title: `${id} 标题`,
  audience: 'customer',
  symptom: '现象',
  resolution: '步骤',
  errorSignatures: [`${id}-sig`],
  ...extra,
})

// 1) 正常导入
await fs.writeFile(path.join(source, 'a.json'), JSON.stringify(good('alpha')))
await fs.writeFile(path.join(source, 'b.json'), JSON.stringify(good('beta', { status: 'verified' })))
{
  const result = await plan({ from: source, to: target })
  check(result.accepted.length === 2 && result.errors.length === 0, 'imports a clean directory')
  check(result.accepted.every(item => item.entry.status !== undefined), 'status is normalized')
}

// 2) dry-run 不写文件
check((await fs.readdir(target)).length === 0, 'plan writes nothing')

// 3) 缺 audience
{
  const bad = path.join(temp, 'bad-audience.json')
  await fs.writeFile(bad, JSON.stringify({ ...good('gamma'), audience: undefined }))
  const result = await plan({ from: bad, to: target })
  check(result.errors.some(message => message.includes('audience')), 'rejects a missing audience')
}

// 4) 缺 resolution
{
  const bad = path.join(temp, 'bad-resolution.json')
  await fs.writeFile(bad, JSON.stringify({ ...good('delta'), resolution: '' }))
  const result = await plan({ from: bad, to: target })
  check(result.errors.some(message => message.includes('resolution')), 'rejects an empty resolution')
}

// 5) 导入内部重复 id
{
  const bad = path.join(temp, 'dupes.json')
  await fs.writeFile(bad, JSON.stringify([good('dup'), good('dup')]))
  const result = await plan({ from: bad, to: target })
  check(result.errors.some(message => message.includes('duplicate id')), 'rejects duplicate ids inside one import')
}

// 6) 数组文件
{
  const arrayFile = path.join(temp, 'array.json')
  await fs.writeFile(arrayFile, JSON.stringify([good('one'), good('two')]))
  const result = await plan({ from: arrayFile, to: target })
  check(result.accepted.length === 2, 'accepts an array file')
}

// 7) 冲突策略
{
  await fs.writeFile(path.join(target, 'alpha.json'), JSON.stringify(good('alpha', { title: '旧标题' })))
  const skip = await plan({ from: source, to: target, onConflict: 'skip' })
  check(skip.accepted.length === 1 && skip.warnings.some(w => w.includes('skipped')), 'skip keeps the existing entry')

  const overwrite = await plan({ from: source, to: target, onConflict: 'overwrite' })
  check(overwrite.accepted.length === 2, 'overwrite replaces the existing entry')

  const rename = await plan({ from: source, to: target, onConflict: 'rename' })
  check(rename.accepted.some(item => item.entry.id === 'alpha-2'), 'rename appends a suffix')
}

// 8) 写入后能被再次读取（id 冲突检测生效）
{
  const result = await plan({ from: source, to: target })
  const files = await apply(result)
  check(files.length === 1, 'apply writes only accepted entries')
  const again = await plan({ from: source, to: target })
  check(again.warnings.some(w => w.includes('beta') && w.includes('skipped')), 're-import detects the existing entry')
}

// 9) 未知字段只警告
{
  const extra = path.join(temp, 'extra.json')
  await fs.writeFile(extra, JSON.stringify({ ...good('epsilon'), legacyField: 1 }))
  const result = await plan({ from: extra, to: target })
  check(result.errors.length === 0 && result.warnings.some(w => w.includes('unknown field')), 'unknown fields warn only')
}

await fs.rm(temp, { recursive: true, force: true })
process.exit(failed === 0 ? 0 : 1)
