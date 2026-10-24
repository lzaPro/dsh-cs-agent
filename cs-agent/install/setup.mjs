#!/usr/bin/env node
/**
 * 客服插件安装脚本：把运行目录、适配器、知识库模板准备好。
 *
 *   npx dsh-cs-setup                    # 交互式
 *   npx dsh-cs-setup --app-id 123 --app-secret xxx
 *   npx dsh-cs-setup --home /tmp/test  # 装到临时目录（测试用）
 *
 * 不会覆盖已有的知识库和凭证，除非加 --force。
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = join(here, '..')

const args = process.argv.slice(2)
const flag = name => {
  const index = args.indexOf(`--${name}`)
  return index === -1 ? undefined : args[index + 1]
}
const force = args.includes('--force')
const dshHome = flag('home') ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')
const root = flag('root') ?? process.env.DSH_CS_ROOT ?? join(dshHome, 'cs-runtime')

const step = message => console.log(`\n▸ ${message}`)

/** 复制目录内容（不递归子目录之外的复杂结构就够用）。 */
function copyTree(source, target, options = {}) {
  mkdirSync(target, { recursive: true })
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const src = join(source, entry.name)
    const dst = join(target, entry.name)
    if (entry.isDirectory()) {
      copyTree(src, dst, options)
      continue
    }
    if (options.skip?.some(name => entry.name === name)) continue
    if (options.skipExisting && existsSync(dst)) continue
    copyFileSync(src, dst)
  }
}

// ── 目录 ────────────────────────────────────────────────────────────────
step(`运行目录：${root}`)
for (const name of ['customer', 'eval', 'ops', 'data', 'data/images', 'bin', 'adapter', 'kb']) {
  mkdirSync(join(root, name), { recursive: true })
}
console.log('  已创建 customer / eval / ops / data / bin / adapter / kb')

// ── 适配器 ──────────────────────────────────────────────────────────────
step('安装 QQ 适配器')
const adapterSource = join(packageRoot, 'adapter')
const adapterTarget = join(root, 'adapter')
copyTree(adapterSource, adapterTarget, {
  skip: ['.env.local', '.env', 'node_modules'],
  skipExisting: !force,
})
console.log(`  ${adapterSource} → ${adapterTarget}`)

// ── 知识库模板 ──────────────────────────────────────────────────────────
step('准备知识库')
const kbSource = join(packageRoot, 'kb-starter')
const kbTarget = join(root, 'kb')
const existing = existsSync(kbTarget) ? readdirSync(kbTarget).filter(name => name.endsWith('.json')) : []
if (existing.length > 0 && !force) {
  console.log(`  已存在 ${existing.length} 条，跳过（要覆盖加 --force）`)
} else {
  copyTree(kbSource, kbTarget)
  console.log(`  ${kbSource} → ${kbTarget}`)
}

// ── 凭证 ────────────────────────────────────────────────────────────────
const envFile = join(adapterTarget, '.env.local')
let appId = flag('app-id') ?? process.env.QQ_APP_ID
let appSecret = flag('app-secret') ?? process.env.QQ_APP_SECRET

if ((appId === undefined || appSecret === undefined) && process.stdin.isTTY) {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    appId ??= await rl.question('\nQQ 机器人 AppID: ')
    appSecret ??= await rl.question('QQ 机器人 AppSecret: ')
  } finally {
    rl.close()
  }
}

if (appId !== undefined && appSecret !== undefined) {
  step('写入凭证')
  const existingEnv = existsSync(envFile) ? readFileSync(envFile, 'utf8') : ''
  if (existingEnv !== '' && !force) {
    console.log(`  ${envFile} 已存在，跳过（要覆盖加 --force）`)
  } else {
    writeFileSync(envFile, [
      `QQ_APP_ID=${appId}`,
      `QQ_APP_SECRET=${appSecret}`,
      'QQ_GATEWAY=http://127.0.0.1:3080',
      'QQ_HEALTH_PORT=8080',
      '',
    ].join('\n'), { mode: 0o600 })
    console.log(`  ${envFile}（权限 600）`)
  }
} else {
  console.log(`\n  没拿到 AppID/AppSecret，稍后手动写 ${envFile}`)
}

// ── 下一步 ──────────────────────────────────────────────────────────────
console.log(`
完成。接下来：

1. 安装插件包（在 dsh 的「设置 → 插件」里选择目录）：
     ${join(packageRoot)}
     ${join(packageRoot, '..', 'cs-ops')}
     ${join(packageRoot, '..', 'cs-panel')}

2. 重启 dsh，然后在「设置 → 插件 → 客服」里启动机器人

3. 打开控制面板：http://127.0.0.1:3080/channel/panel

4. OCR：macOS 可运行 tools/build-ocr.sh；或安装 tesseract 后
   在插件配置里把 ocr 的 backend 改成 tesseract
`)
