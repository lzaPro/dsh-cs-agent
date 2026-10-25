#!/usr/bin/env node
/**
 * 客户端插件静态检查。
 *
 * 浏览器模块用 `window.__ModuleLoader__.load({ id })` 注册自己，id 必须等于包名。
 * 写错不会在 `node --check` 时暴露，但会让整组 Web 插件加载失败——2026-10-23 就这么崩过一次。
 *
 *   node scripts/check-client-plugins.mjs
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const problems = []
const checked = []

/** 递归找 package.json，跳过依赖和构建产物。 */
async function findPackages(dir, depth = 0) {
  if (depth > 2) return []
  const entries = await fs.readdir(dir, { withFileTypes: true })
  const found = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (entry.name === 'node_modules' || entry.name === '.build' || entry.name === '.git') continue
    const full = path.join(dir, entry.name)
    const manifest = path.join(full, 'package.json')
    try {
      await fs.access(manifest)
      found.push(manifest)
    } catch {
      found.push(...await findPackages(full, depth + 1))
    }
  }
  return found
}

/** 从 client.js 里读注册 id。 */
function readRegisteredId(source) {
  const match = /__ModuleLoader__\s*\.\s*load\s*\(\s*\{[\s\S]{0,200}?id\s*:\s*['"]([^'"]+)['"]/.exec(source)
  return match?.[1]
}

const results = []

for (const manifestPath of await findPackages(root)) {
  const dir = path.dirname(manifestPath)
  const pkg = JSON.parse(await fs.readFile(manifestPath, 'utf8'))
  const client = pkg?.dsh?.client
  const hasClientFile = await fs.access(path.join(dir, 'client.js')).then(() => true, () => false)

  if (client === undefined) {
    if (hasClientFile) {
      problems.push(`${pkg.name ?? dir}: has client.js but no dsh.client declaration`)
      results.push({ name: pkg.name ?? dir, localProblems: problems.slice(-1) })
    }
    continue
  }

  const localProblems = []
  const exportPath = pkg?.exports?.['./client']
  if (typeof exportPath !== 'string') {
    localProblems.push(`${pkg.name}: dsh.client declared but exports["./client"] is missing`)
  } else {
    const bundle = path.join(dir, exportPath)
    if (!(await fs.access(bundle).then(() => true, () => false))) {
      localProblems.push(`${pkg.name}: exports["./client"] points at a missing file (${exportPath})`)
    } else {
      const source = await fs.readFile(bundle, 'utf8')
      const registered = readRegisteredId(source)
      if (registered === undefined) {
        localProblems.push(`${pkg.name}: ${exportPath} never calls __ModuleLoader__.load`)
      } else if (registered !== pkg.name) {
        localProblems.push(`${pkg.name}: client registers id "${registered}" but the package is "${pkg.name}"`)
      }
    }
    const patchFile = path.join(dir, pkg?.dsh?.bundle?.patch ?? 'cordis.patch.yml')
    const hasPatch = await fs.access(patchFile).then(() => true, () => false)
    if (!hasPatch) {
      localProblems.push(`${pkg.name}: dsh.bundle.patch file is missing`)
    } else {
      // 浏览器侧只认「Loader 行名 == 包名」的入口（client-modules/src/client/manifest.ts 的
      // exactPackageSpecifier）。如果 patch 里只有 @scope/pkg/xxx 这样的子路径行，
      // client.js 永远不会被加载，UI 在 Web 里静默消失——2026-10-24 运维面板就是这样不见的。
      const patchSource = await fs.readFile(patchFile, 'utf8')
      const bare = new RegExp(`name:\\s*['"]?${pkg.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]?\\s*$`, 'm')
      if (!bare.test(patchSource)) {
        localProblems.push(`${pkg.name}: patch has no Loader row named exactly "${pkg.name}" (client.js is only scanned for bare package rows)`)
      }
    }
  }

  problems.push(...localProblems)
  results.push({ name: pkg.name, localProblems })
}

for (const result of results) {
  if (result.localProblems.length === 0) console.log(`PASS ${result.name}: module id matches package name`)
  else for (const problem of result.localProblems) console.log(`FAIL ${problem}`)
}

console.log(`\n${results.length} client packages checked, ${problems.length} problems`)
process.exit(problems.length === 0 ? 0 : 1)
