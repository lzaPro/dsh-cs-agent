#!/usr/bin/env node
/**
 * 运行中的 dsh 是否真的加载了运维包。
 *
 * `verify-all.sh` 只证明模块本身没问题；宿主进程不热替换，所以"装好了"和
 * "这个进程里装好了"是两件事。这个脚本打真实 HTTP 接口，回答后者。
 *
 *   node scripts/check-ops-live.mjs                  # 默认 http://127.0.0.1:3080
 *   node scripts/check-ops-live.mjs http://host:port
 *
 * 退码 1 = 有检查失败（最常见的原因：改完插件没重启 dsh）。
 */
const base = (process.argv[2] ?? 'http://127.0.0.1:3080').replace(/\/+$/, '')

let failed = 0
const check = (ok, label, detail = '') => {
  if (!ok) failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail === '' ? '' : `: ${detail}`}`)
}

/** 请求一个接口，返回 {status, text, json}；连不上时 status = 0。 */
async function get(path, init) {
  try {
    const response = await fetch(`${base}${path}`, init)
    const text = await response.text()
    let json
    try {
      json = JSON.parse(text)
    } catch {
      json = undefined
    }
    return { status: response.status, text, json }
  } catch (error) {
    return { status: 0, text: String(error?.message ?? error), json: undefined }
  }
}

const page = await get('/ops/panel')
check(page.status === 200, 'GET /ops/panel', `HTTP ${page.status}`)
check(page.text.includes('运维控制台'), 'panel page renders the console')
check(page.text.includes('color-scheme: light'), 'panel page uses the light theme')
check(page.text.includes('id="toggle"'), 'panel page carries the collaboration toggle')

const status = await get('/ops/status')
check(status.status === 200, 'GET /ops/status', `HTTP ${status.status}`)
if (status.json !== undefined) {
  check(status.json.ok === true, 'status reports ok')
  check(typeof status.json.counts?.live === 'number', 'status carries counts')
  check(Array.isArray(status.json.env?.checks), 'status carries the access self-check')
  check(typeof status.json.enabled === 'boolean', 'status carries the collaboration switch')
  const broken = (status.json.env?.checks ?? []).filter(item => item.ok !== true)
  console.log(broken.length === 0
    ? 'INFO read-only cluster access: usable'
    : `INFO read-only cluster access: ${broken.map(item => item.name).join(', ')} unavailable (expected without a kubeconfig)`)
}

const incidents = await get('/ops/incidents')
check(incidents.status === 200 && incidents.json?.ok === true, 'GET /ops/incidents')
const searched = await get('/ops/incidents?q=' + encodeURIComponent('不存在的搜索词'))
check(searched.status === 200 && searched.json?.ok === true && searched.json?.live?.length === 0,
  'GET /ops/incidents?q= filters the board')
const archivedView = await get('/ops/incidents?archived=1')
check(archivedView.status === 200 && typeof archivedView.json?.archivedCount === 'number',
  'GET /ops/incidents?archived=1 reports archived incidents')

const proposals = await get('/ops/proposals')
check(proposals.status === 200 && proposals.json?.ok === true, 'GET /ops/proposals')

const kb = await get('/ops/kb/candidates')
check(kb.status === 200 && kb.json?.ok === true, 'GET /ops/kb/candidates (shared kb loaded)')
if (kb.json?.stats !== undefined) {
  console.log(`INFO knowledge base: ${kb.json.stats.shared} shared, ${kb.json.stats.internal} internal, ${kb.json.stats.candidates} candidates`)
}

const badDispatch = await get('/ops/dispatch', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ task: { symptom: 'x' } }),
})
check(badDispatch.status === 400, 'POST /ops/dispatch rejects a missing requester', `HTTP ${badDispatch.status}`)

const channel = await get('/channel/sessions')
check(channel.status === 200, 'customer-service gateway still mounted', `HTTP ${channel.status}`)

console.log(failed === 0
  ? '\nops live: all checks passed'
  : `\nops live: ${failed} check(s) failed — 最常见的原因是这个 dsh 进程还没重启`)
process.exit(failed === 0 ? 0 : 1)
