// 安装脚本自测：在临时目录里跑一遍，确认目录、适配器、凭证、知识库都到位。
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

let failed = 0
const check = (ok, label, detail = '') => {
  if (!ok) failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail === '' ? '' : `: ${detail}`}`)
}

const temp = mkdtempSync(path.join(tmpdir(), 'setup-'))
const home = path.join(temp, 'dsh')
const root = path.join(home, 'cs-runtime')
const script = path.join(import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname), '..', 'cs-agent/install/setup.mjs')

const output = execFileSync(process.execPath, [script, '--home', home, '--app-id', '12345', '--app-secret', 'secret-value'], { encoding: 'utf8' })

check(output.includes('完成'), 'setup prints the next steps')
for (const dir of ['customer', 'eval', 'ops', 'data', 'adapter', 'kb']) {
  check(existsSync(path.join(root, dir)), `creates ${dir}/`)
}
check(existsSync(path.join(root, 'adapter', 'qq-ws-cli.js')), 'copies the adapter')
check(existsSync(path.join(root, 'adapter', 'qq.sh')), 'copies the launcher')

const envFile = path.join(root, 'adapter', '.env.local')
check(existsSync(envFile), 'writes the env file')
if (existsSync(envFile)) {
  const content = readFileSync(envFile, 'utf8')
  check(content.includes('QQ_APP_ID=12345') && content.includes('QQ_APP_SECRET=secret-value'), 'env content is complete')
  check((statSync(envFile).mode & 0o777) === 0o600, 'env file is 0600', (statSync(envFile).mode & 0o777).toString(8))
}
check(existsSync(path.join(root, 'kb', '_template.json')), 'copies the knowledge base starter')

// 二次运行不覆盖已有凭证
const second = execFileSync(process.execPath, [script, '--home', home, '--app-id', '999', '--app-secret', 'other'], { encoding: 'utf8' })
check(second.includes('跳过'), 're-running keeps existing files')
check(readFileSync(envFile, 'utf8').includes('QQ_APP_ID=12345'), 'existing credentials are preserved')

rmSync(temp, { recursive: true, force: true })
process.exit(failed === 0 ? 0 : 1)
