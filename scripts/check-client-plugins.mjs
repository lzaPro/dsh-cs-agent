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
    if (!(await fs.access(path.join(dir, pkg?.dsh?.bundle?.patch ?? 'cordis.patch.yml')).then(() => true, () => false))) {
      localProblems.push(`${pkg.name}: dsh.bundle.patch file is missing`)
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
