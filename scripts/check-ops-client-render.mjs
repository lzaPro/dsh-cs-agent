/**
 * 运维客户端的渲染冒烟：用假 React 真跑三个插槽组件。
 *
 * 为什么需要它：`check-client-runtime.mjs` 只执行 `apply()`，证明不了组件能渲染；
 * 一个 `props` 取错、一个空对象解构，都要等浏览器里点开设置页才炸。
 *
 * Run with: node scripts/check-ops-client-render.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const source = fs.readFileSync(path.join(here, '..', 'ops-agent', 'client.js'), 'utf8')

let failed = 0
const check = (ok, label, detail = '') => {
  if (!ok) failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail === '' ? '' : `: ${detail}`}`)
}

// 最小 React：组件只用到 createElement / useState / useEffect / useCallback。
const React = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useCallback: fn => fn,
  Fragment: 'Fragment',
}

let loaded
const window = {
  __ModuleLoader__: { load: definition => { loaded = definition } },
  location: { search: '' },
  open: () => {},
}
new Function('window', source)(window)
check(loaded?.id === '@local/dsh-ops-agent', 'client bundle registers under the package name')

const mod = loaded.factory(name => (name === 'react' ? React : undefined))

// 宿主替身：effect 立即执行，slots 收集注册项。
const slots = []
const ctx = {
  effect: fn => fn(),
  get: () => undefined,
  slots: {
    inject: (_name, register) => register(),
    register: (meta, component) => { slots.push({ meta, component }); return () => {} },
  },
}

try {
  mod.apply(ctx)
  check(true, 'apply runs against the host double')
} catch (error) {
  check(false, 'apply runs against the host double', String(error?.message ?? error))
}

const expected = [
  'settings.section#ops-agent',
  'conversation.session.header.actions#ops-approvals',
  'sidebar.session.row.leading#ops-mark',
]
const registered = slots.map(slot => `${slot.meta.name}#${slot.meta.id}`)
for (const id of expected) check(registered.includes(id), `slot registered: ${id}`, registered.join(', '))

/** 渲染一个插槽：外层包装组件返回元素，内层才是真正的组件。 */
function render(id, props) {
  const slot = slots.find(entry => `${entry.meta.name}#${entry.meta.id}` === id)
  if (slot === undefined) return undefined
  const outer = slot.component(props)
  return typeof outer?.type === 'function' ? outer.type(outer.props) : outer
}

try {
  const settings = JSON.stringify(render('settings.section#ops-agent', { ctx }))
  check(settings.includes('运维协同'), 'settings section renders the collaboration switch')
  check(settings.includes('最近工单'), 'settings section renders the recent-incident list')
  // 搜索归控制台；设置页只保留跳转入口，不放重复的搜索框。
  check(!settings.includes('搜索工单号'), 'settings section carries no duplicate search box')
  check(settings.includes('开启协同') || settings.includes('关闭协同'), 'settings section renders the toggle button')
} catch (error) {
  check(false, 'settings section renders', String(error?.message ?? error))
}

try {
  const header = JSON.stringify(render('conversation.session.header.actions#ops-approvals', { sessionId: 'ops-abc', ctx }))
  check(header.includes('运维'), 'header renders for an ops session')
  const badge = JSON.stringify(render('sidebar.session.row.leading#ops-mark', { sessionId: 'ops-abc' }))
  check(badge.includes('运'), 'sidebar badge renders for an ops session')
  const ordinary = render('sidebar.session.row.leading#ops-mark', { sessionId: 'session-1' })
  check(ordinary === null, 'sidebar badge stays out of ordinary sessions')
} catch (error) {
  check(false, 'header and badge render', String(error?.message ?? error))
}

console.log(failed === 0 ? '\nops client render: all checks passed' : `\nops client render: ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
