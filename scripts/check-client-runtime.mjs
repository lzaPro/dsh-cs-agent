#!/usr/bin/env node
/**
 * 客户端插件的运行时冒烟：在 Node 里用假的 window/React 执行 factory 和 apply。
 *
 * 捕获的是"注册了但 apply 抛错"这类问题——模块 id 对了、语法也对了，
 * 但插槽注册写错，浏览器里表现为整块 UI 不出现。
 *
 *   node scripts/check-client-runtime.mjs
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const EXPECTED = {
  'cs-panel/client.js': {
    id: '@local/dsh-cs-panel',
    slots: [
      'settings.section',
      'conversation.session.header.actions',
      'sidebar.session.row.leading',
    ],
  },
  'ops-agent/client.js': {
    id: '@local/dsh-ops-agent',
    slots: [
      'settings.section',
      'conversation.session.header.actions',
      'sidebar.session.row.leading',
    ],
  },
}

let failed = 0
const check = (ok, label, detail = '') => {
  if (!ok) failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail === '' ? '' : `: ${detail}`}`)
}

/** 极简 React 替身：只够让组件返回元素树。 */
function fakeReact() {
  const h = (type, props, ...children) => ({ type, props: props ?? {}, children })
  return {
    createElement: h,
    useState: value => [typeof value === 'function' ? value() : value, () => {}],
    useEffect: () => {},
    useCallback: fn => fn,
    useMemo: fn => fn(),
  }
}

for (const [file, expected] of Object.entries(EXPECTED)) {
  let loaded
  const window = { __ModuleLoader__: { load: definition => { loaded = definition } } }
  const source = readFileSync(join(root, file), 'utf8')
  try {
    new Function('window', source)(window)
  } catch (error) {
    check(false, `${file}: evaluates`, error.message)
    continue
  }
  check(loaded !== undefined, `${file}: registers a module`)
  if (loaded === undefined) continue
  check(loaded.id === expected.id, `${file}: module id`, loaded.id)

  const module = loaded.factory(specifier => {
    if (specifier === 'react') return fakeReact()
    throw new Error(`unexpected require(${specifier})`)
  })

  const registered = []
  const ctx = {
    effect: execute => { execute() },
    slots: {
      inject: (name, factory) => { factory() },
      register: (options, component) => {
        registered.push({ name: options.name, id: options.id, component })
        return () => {}
      },
    },
  }
  try {
    module.apply(ctx)
  } catch (error) {
    check(false, `${file}: apply runs`, error.message)
    continue
  }
  check(registered.length === expected.slots.length, `${file}: registers ${expected.slots.length} slots`, String(registered.length))

  for (const slot of expected.slots) {
    check(registered.some(item => item.name === slot), `${file}: mounts ${slot}`)
  }

  // 组件至少要能在没有网关数据时渲染（返回 null 或元素），不能抛错。
  for (const item of registered) {
    try {
      const rendered = item.component({ sessionId: 'session-x' })
      check(rendered === null || typeof rendered === 'object', `${file}: ${item.name} renders without data`)
    } catch (error) {
      check(false, `${file}: ${item.name} renders`, error.message)
    }
  }
}

process.exit(failed === 0 ? 0 : 1)
