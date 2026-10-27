#!/usr/bin/env node
/**
 * 发布包自检：`npm pack` 到底会发出去什么。
 *
 * 这个检查存在的原因是一次真实事故（P14 之前发现的）：`cs-agent` 的 `files[]`
 * 里写了目录 `adapter`，而 `adapter/.env.local` 放着真实的 QQ_APP_SECRET。
 * `npm pack --dry-run` 把它算了进去——从 npm 装这个包的人会拿到我们的凭证。
 *
 * 更麻烦的是 npm 的规则：**包根的 `.npmignore` 不能覆盖 `files[]`**，只有子目录里的
 * `.npmignore` 才能排除子目录内的文件。所以"我在根上加了 .npmignore"是无效的，
 * 而且看起来像是修好了。
 *
 * 这里不自己实现 npm 的打包规则（一定会漂移），而是直接问 npm：
 *
 *   1. 每个包跑 `npm pack --dry-run --json`，拿到真实文件清单；
 *   2. 清单里不能有凭证、测试、日志；
 *   3. `exports` 指向的每个文件都必须在清单里（漏了就是装出来的包 import 就崩）；
 *      files[] 里的目录必须真实存在；
 *   4. 把清单里的文件复制到临时目录，真的 `import()` 每个入口——这一步能抓到
 *      "files[] 漏了 time.js" 这种只在安装后才炸的问题。
 *
 * 退出码：0 通过 / 1 有问题 / 2 环境不对（没有 npm、找不到包）。
 */

import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const workspace = path.resolve(here, '..')
const build = path.join(workspace, '.build')

let passed = 0
let failed = 0

/** 断言一条结论。 */
function check(ok, label, detail) {
  if (ok) {
    passed += 1
    console.log(`PASS ${label}`)
    return
  }
  failed += 1
  console.log(`FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`)
}

/**
 * 跑一个命令，收退出码与输出。
 *
 * @param {string} command - 可执行文件。
 * @param {string[]} args - 参数。
 * @param {string} cwd - 工作目录。
 * @returns {Promise<{code: number, out: string, stdout: string, stderr: string}>} 结果。
 */
function run(command, args, cwd) {
  return new Promise(resolve => {
    execFile(command, args, { cwd, maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ code: error?.code ?? 0, out: `${stdout}${stderr}`, stdout, stderr })
    })
  })
}

/**
 * 问 npm 这个包会发哪些文件。
 *
 * @param {string} dir - 包目录。
 * @returns {Promise<string[]>} 相对路径清单。
 */
async function packedFiles(dir) {
  const result = await run('npm', ['pack', '--dry-run', '--json',
    '--cache', path.join(build, 'npm-cache'),
    '--logs-dir', path.join(build, 'npm-logs')], dir)
  if (result.code !== 0) throw new Error(`npm pack failed in ${dir}: ${result.stderr.slice(0, 400)}`)
  const parsed = JSON.parse(result.stdout)
  return parsed[0].files.map(file => file.path).sort()
}

/**
 * 把 `files`/`exports` 里的条目按 npm 的语义展开：目录算整目录。
 *
 * @param {string} dir - 包目录。
 * @param {string[]} entries - files[] 里的条目。
 * @returns {Set<string>} 应当存在的相对路径。
 */
async function expandEntries(dir, entries) {
  const found = new Set()
  for (const entry of entries) {
    const abs = path.join(dir, entry)
    const stat = await fs.stat(abs).catch(() => undefined)
    if (stat === undefined) {
      found.add(`${entry}\u0000missing`)
      continue
    }
    if (stat.isDirectory()) {
      const walk = async (current, prefix) => {
        for (const item of await fs.readdir(current, { withFileTypes: true })) {
          const rel = prefix === '' ? item.name : `${prefix}/${item.name}`
          if (item.isDirectory()) await walk(path.join(current, item.name), rel)
          else found.add(rel)
        }
      }
      await walk(abs, entry)
    } else {
      found.add(entry.replace(/^\.\//, ''))
    }
  }
  return found
}

/** 凭证、测试、日志一律不该出现在发布包里。 */
const FORBIDDEN = [
  { label: '凭证文件', test: file => /(^|\/)\.env(\.|$)/.test(file) },
  { label: '密钥/证书', test: file => /\.(token|key|pem|p12|p8)$/i.test(file) },
  { label: 'npm 凭证', test: file => /(^|\/)\.npmrc$/.test(file) },
  { label: '测试脚本', test: file => /smoke.*\.(mjs|js)$/i.test(file) },
  { label: '日志/缓存', test: file => /\.(log|tmp)$/i.test(file) || /(^|\/)(node_modules|\.build|\.git)\//.test(file) },
  { label: '系统垃圾', test: file => /(^|\/)(\.DS_Store|Thumbs\.db)$/.test(file) },
]

/** 从 exports 里取出静态目标（通配符单独处理）。 */
function staticTargets(exports) {
  const targets = []
  for (const [key, value] of Object.entries(exports ?? {})) {
    if (typeof value !== 'string') continue
    if (value.includes('*')) continue
    targets.push({ key, file: value.replace(/^\.\//, '') })
  }
  return targets
}

const packages = (await fs.readdir(workspace, { withFileTypes: true }))
  .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
  .map(entry => entry.name)
const found = []
for (const name of packages) {
  if (await fs.stat(path.join(workspace, name, 'package.json')).catch(() => undefined) === undefined) continue
  found.push(name)
}
if (found.length === 0) {
  console.error(`no package directories found in ${workspace}`)
  process.exit(2)
}

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'packaging-smoke-'))

for (const name of found) {
  const dir = path.join(workspace, name)
  console.log('')
  console.log(`== ${name}`)
  const manifest = JSON.parse(await fs.readFile(path.join(dir, 'package.json'), 'utf8'))

  let files
  try {
    files = await packedFiles(dir)
  } catch (error) {
    console.error(`SKIP ${name}: ${error.message}`)
    process.exit(2)
  }
  const set = new Set(files)

  // 1. 不该发的东西
  for (const rule of FORBIDDEN) {
    const offenders = files.filter(rule.test)
    check(offenders.length === 0, `${name}: the pack contains no ${rule.label}`, offenders.join(', '))
  }

  // 2. 入口都在包里
  const targets = staticTargets(manifest.exports)
  const missingEntries = targets.filter(target => !set.has(target.file))
  check(
    missingEntries.length === 0,
    `${name}: every export target is in the pack`,
    missingEntries.map(target => `${target.key} → ${target.file}`).join(', '),
  )

  const wildcards = Object.entries(manifest.exports ?? {}).filter(([, value]) => typeof value === 'string' && value.includes('*'))
  for (const [key, value] of wildcards) {
    const prefix = value.replace(/^\.\//, '').split('*')[0]
    const matches = files.filter(file => file.startsWith(prefix))
    check(matches.length > 0, `${name}: wildcard export ${key} matches at least one shipped file`, prefix)
  }

  // 3. files[] 里的路径必须真实存在
  const declared = await expandEntries(dir, manifest.files ?? [])
  const brokenDeclarations = [...declared].filter(entry => entry.endsWith('\u0000missing')).map(entry => entry.replace('\u0000missing', ''))
  check(brokenDeclarations.length === 0, `${name}: every files[] entry exists on disk`, brokenDeclarations.join(', '))

  // 4. bundle 的 patch 要跟着走
  const patch = manifest.dsh?.bundle?.patch
  if (typeof patch === 'string') {
    check(set.has(patch.replace(/^\.\//, '')), `${name}: the bundle patch ships with the package`, patch)
  }

  // 5. 至少带上 package.json / README / LICENSE（npm 强制带 package.json，另两个是惯例）
  for (const expected of ['package.json', 'README.md']) {
    check(set.has(expected), `${name}: the pack contains ${expected}`)
  }

  // 6. 真的装一次：把清单里的文件复制到临时目录，import 每个入口。
  const sandbox = path.join(temp, name)
  await fs.mkdir(sandbox, { recursive: true })
  for (const file of files) {
    const target = path.join(sandbox, file)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.copyFile(path.join(dir, file), target)
  }
  // 声明了 dsh.client 的包，其 client 入口是浏览器模块（模块作用域里就有 window/document），
  // 在 node 里 import 必然抛错。它仍然要"在包里"，只是不能这样验；其它入口照常 import。
  const clientKeys = new Set(manifest.dsh?.client === undefined ? [] : ['./client'])
  const importable = targets.filter(target => /\.(mjs|js)$/.test(target.file) && !clientKeys.has(target.key))
  for (const key of clientKeys) {
    if (!targets.some(target => target.key === key)) continue
    check(true, `${name}: the browser entry ${key} is shipped (not imported: it needs a DOM)`)
  }
  const script = importable.map(target => `
try {
  const mod = await import(${JSON.stringify(`./${target.file}`)})
  const keys = Object.keys(mod)
  console.log('OK ${target.key} ' + keys.length)
} catch (error) {
  console.log('ERR ${target.key} ' + String(error && error.message).replace(/\\n/g, ' ').slice(0, 200))
}`).join('\n')
  const loaded = await run(process.execPath, ['--input-type=module', '-e', script], sandbox)
  for (const line of loaded.stdout.split('\n').filter(item => item.startsWith('OK ') || item.startsWith('ERR '))) {
    const [state, key, detail] = line.split(' ')
    check(
      state === 'OK' && Number(detail) > 0,
      `${name}: the packed ${key} imports and exports something`,
      state === 'ERR' ? line.slice(4) : `exports ${detail}`,
    )
  }
  if (loaded.stdout.trim() === '') {
    check(false, `${name}: importing the packed entries produced no output`, loaded.stderr.slice(0, 300))
  }
}

await fs.rm(temp, { recursive: true, force: true })
console.log('')
if (failed === 0) {
  console.log(`${passed} packaging checks passed`)
  process.exit(0)
}
console.log(`${failed} of ${passed + failed} packaging checks failed`)
process.exit(1)
