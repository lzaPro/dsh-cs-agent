#!/usr/bin/env node
/**
 * 运维系统连通性探测。
 *
 * 在**内网 / VPN 环境**下运行：
 *   node ops-agent/probe.mjs
 *
 * 它只读，不创建资源（除了必要时的 Rancher token，会明确提示）。
 * 输出里不会打印任何密码或 token 值。
 */
import '../platform-adapter/env.js'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// env.js 只加载 platform-adapter/.env.local；这里再补加载本目录的。
const here = dirname(fileURLToPath(import.meta.url))
for (const line of readFileSync(join(here, '.env.local'), 'utf8').split('\n')) {
  const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line.trim())
  if (match === null || line.trim().startsWith('#')) continue
  if (process.env[match[1]] === undefined) process.env[match[1]] = match[2].trim()
}

const env = process.env
const timeout = 10_000
const results = []

const say = (ok, label, detail = '') => {
  results.push({ ok, label, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail === '' ? '' : ` — ${detail}`}`)
}

async function get(url, headers = {}) {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(timeout) })
  return { status: response.status, headers: response.headers, text: await response.text() }
}

const grafana = env.GRAFANA_URL
const rancher = env.RANCHER_PROD_URL
const basic = (user, pass) => `Basic ${Buffer.from(`${user}:${pass}`, 'utf8').toString('base64')}`

// 1. Grafana 可达性
if (grafana === undefined) {
  say(false, 'grafana env missing')
} else {
  try {
    const health = await get(`${grafana}/api/health`)
    say(health.status === 200, 'grafana /api/health', `HTTP ${health.status}`)
  } catch (error) {
    say(false, 'grafana /api/health', error.cause?.code ?? error.name)
  }

  // 2. Grafana 基础认证
  try {
    const response = await get(`${grafana}/api/datasources`, {
      authorization: basic(env.GRAFANA_USERNAME, env.GRAFANA_PASSWORD),
    })
    if (response.status === 200) {
      const list = JSON.parse(response.text)
      const names = list.map(item => `${item.name}(${item.type},uid=${item.uid})`).join(', ')
      say(true, 'grafana basic auth', `${list.length} datasources: ${names}`)
    } else {
      say(false, 'grafana basic auth', `HTTP ${response.status}`)
    }
  } catch (error) {
    say(false, 'grafana basic auth', error.cause?.code ?? error.name)
  }
}

// 3. Rancher 可达性 + 认证
if (rancher === undefined) {
  say(false, 'rancher env missing')
} else {
  try {
    const response = await get(`${rancher}/v3`, {
      authorization: basic(env.RANCHER_USERNAME, env.RANCHER_PASSWORD),
    })
    say(response.status === 200, 'rancher /v3 with basic auth', `HTTP ${response.status}`)
  } catch (error) {
    say(false, 'rancher /v3', error.cause?.code ?? error.name)
  }

  // 4. 能否列出集群（需要 token 或 basic auth 被接受）
  try {
    const response = await get(`${rancher}/v3/clusters`, {
      authorization: basic(env.RANCHER_USERNAME, env.RANCHER_PASSWORD),
    })
    if (response.status === 200) {
      const body = JSON.parse(response.text)
      const clusters = (body.data ?? []).map(item => `${item.name}(${item.id})`).join(', ')
      say(true, 'rancher clusters', clusters)
    } else {
      say(false, 'rancher clusters', `HTTP ${response.status}`)
    }
  } catch (error) {
    say(false, 'rancher clusters', error.cause?.code ?? error.name)
  }
}

const passed = results.filter(item => item.ok).length
console.log(`\n${passed}/${results.length} checks passed`)
if (passed === 0) {
  console.log('\n全部失败通常意味着：不在内网 / VPN 未连 / 代理规则把这些域名指向了不可达出口。')
}
process.exit(passed === results.length ? 0 : 1)
