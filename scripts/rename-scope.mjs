#!/usr/bin/env node
/**
 * 把 @local/... 改成你自己的 npm scope。
 *
 *   node scripts/rename-scope.mjs --to @yourscope          # 预览
 *   node scripts/rename-scope.mjs --to @yourscope --yes    # 执行
 *
 * 会改：三个包名、所有源码/配置/文档里的引用、客户端模块 id。
 * 改完务必跑 node scripts/check-client-plugins.mjs。
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const to = args[args.indexOf('--to') + 1]
const yes = args.includes('--yes')

if (typeof to !== 'string' || !/^@[a-z0-9][a-z0-9._-]*$/i.test(to)) {
  console.error('usage: rename-scope.mjs --to @yourscope [--yes]')
  process.exit(2)
}

const OLD = ['@local/dsh-cs-agent', '@local/dsh-cs-ops', '@local/dsh-cs-panel']
const NEW = OLD.map(name => `${to}/${name.split('/')[1]}`)
const EXTENSIONS = new Set(['.js', '.mjs', '.json', '.yml', '.yaml', '.md'])
const SKIP = new Set(['node_modules', '.git', '.build', 'dist'])
const changed = []

function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP.has(entry.name)) walk(join(dir, entry.name))
      continue
    }
    const file = join(dir, entry.name)
    const extension = file.slice(file.lastIndexOf('.'))
    if (!EXTENSIONS.has(extension)) continue
    const text = readFileSync(file, 'utf8')
    let next = text
    for (let i = 0; i < OLD.length; i += 1) next = next.split(OLD[i]).join(NEW[i])
    if (next !== text) {
      changed.push({ file, count: OLD.reduce((sum, name) => sum + text.split(name).length - 1, 0) })
      if (yes) writeFileSync(file, next)
    }
  }
}

// 发布前还要去掉 private 标记
if (yes) {
  for (const name of ['cs-agent', 'cs-ops', 'cs-panel']) {
    const manifest = join(root, name, 'package.json')
    const pkg = JSON.parse(readFileSync(manifest, 'utf8'))
    if (pkg.private === true) {
      delete pkg.private
      writeFileSync(manifest, `${JSON.stringify(pkg, undefined, 2)}\n`)
      changed.push({ file: manifest, count: 1 })
    }
  }
}

walk(root)
for (const item of changed) console.log(`${item.file.replace(`${root}/`, '')}  (${item.count} 处)`)
console.log(`\n${changed.length} 个文件，共 ${changed.reduce((sum, item) => sum + item.count, 0)} 处引用`)
if (!yes) console.log('(dry run) 加 --yes 执行')
