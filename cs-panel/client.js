// 客服控制面板：全部挂在 DSH 原生插槽上，不再单独做页面。
//
// - 设置 → 客服（左侧栏一级入口）：机器人状态、启停、控制面板入口
// - 会话标题栏：接管 / 交还 / 回复
// - 侧边栏会话行：人工接管时显示「人」
//
// 只调用网关的 HTTP 接口，不持有任何凭证。
window.__ModuleLoader__.load({
  id: '@local/dsh-cs-panel',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useState } = React

    const button = {
      font: 'inherit',
      fontSize: 12,
      padding: '2px 8px',
      borderRadius: 6,
      border: '1px solid currentColor',
      background: 'transparent',
      color: 'inherit',
      cursor: 'pointer',
      opacity: 0.85,
    }
    const muted = { opacity: 0.65, fontSize: 13 }

    // sessionId → 网关记录，所有插槽共享；5 秒刷新一次。
    const store = { records: new Map(), listeners: new Set() }

    async function refresh() {
      try {
        const response = await fetch('/channel/sessions')
        if (!response.ok) return
        const body = await response.json()
        const next = new Map()
        for (const record of body.sessions ?? []) next.set(record.sessionId, record)
        store.records = next
        for (const listener of store.listeners) listener()
      } catch {
        // 网关不可用时保留上一份数据，不打断界面。
      }
    }

    async function post(path, body) {
      const response = await fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!response.ok) {
        const detail = await response.json().catch(() => ({}))
        throw new Error(detail.error ?? String(response.status))
      }
      return response.json().catch(() => ({}))
    }

    /** 订阅某条会话的网关状态。 */
    function useRecord(sessionId) {
      const [, bump] = useState(0)
      useEffect(() => {
        const listener = () => bump(value => value + 1)
        store.listeners.add(listener)
        return () => { store.listeners.delete(listener) }
      }, [sessionId])
      return store.records.get(sessionId)
    }

    /** 会话标题栏：接管 / 交还 / 回复。只在客服会话上出现。 */
    function HeaderActions(props) {
      const record = useRecord(props.sessionId)
      const [busy, setBusy] = useState(false)
      if (record === undefined) return null

      const run = async (action) => {
        setBusy(true)
        try {
          await action()
          await refresh()
        } catch (error) {
          window.alert(error.message)
        } finally {
          setBusy(false)
        }
      }

      const human = record.mode === 'human'
      return h('div', { style: { display: 'flex', gap: 6, alignItems: 'center' } },
        h('button', {
          style: { ...button, opacity: busy ? 0.4 : 0.85 },
          disabled: busy,
          title: human ? '把对话交还给 AI' : '暂停 AI，由你直接回复',
          onClick: () => run(() => post('/channel/mode', { key: record.key, mode: human ? 'ai' : 'human' })),
        }, human ? '交还 AI' : '接管'),
        h('button', {
          style: button,
          disabled: busy,
          title: '直接把这句话发给客户',
          onClick: () => {
            const text = window.prompt('发给客户的回复：')
            if (text === null || text.trim() === '') return
            void run(() => post('/channel/reply', { key: record.key, text }))
          },
        }, '回复'),
      )
    }

    /** 侧边栏行首：人工接管时显示一个「人」字。 */
    function RowBadge(props) {
      const record = useRecord(props.sessionId)
      if (record === undefined || record.mode !== 'human') return null
      return h('span', { title: '人工接管中', style: { fontSize: 10, lineHeight: '16px', opacity: 0.8 } }, '人')
    }

    /** 设置 → 客服：状态条 + 控制面板入口。 */
    function SettingsPanel() {
      const [status, setStatus] = useState(null)
      const [bot, setBot] = useState(null)
      const [error, setError] = useState('')
      const [busy, setBusy] = useState(false)

      const load = useCallback(async () => {
        try {
          const [nextStatus, nextBot] = await Promise.all([
            fetch('/channel/status').then(response => response.json()),
            fetch('/channel/adapter').then(response => response.json()),
          ])
          setStatus(nextStatus)
          setBot(nextBot)
          setError('')
        } catch (caught) {
          setError(caught.message)
        }
      }, [])

      useEffect(() => {
        void load()
        const timer = setInterval(() => { void load() }, 5000)
        return () => clearInterval(timer)
      }, [load])

      const act = async (action) => {
        setBusy(true)
        try {
          await post(`/channel/adapter/${action}`, {})
          await load()
        } catch (caught) {
          setError(caught.message)
        } finally {
          setBusy(false)
        }
      }

      const running = bot?.running === true
      const openPanel = () => { window.open('/channel/panel', '_blank', 'noopener') }
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 560, padding: '4px 0' } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' } },
          h('strong', null, '客服机器人'),
          h('span', { style: muted }, running ? '● 运行中' : '○ 已停止'),
          h('button', {
            style: { ...button, opacity: busy ? 0.4 : 1 },
            disabled: busy,
            onClick: () => act(running ? 'stop' : 'start'),
          }, running ? '停止' : '启动'),
        ),
        error === '' ? null : h('div', { style: { color: '#c33', fontSize: 13 } }, `网关不可用：${error}`),
        h('div', { style: muted },
          `对话 ${status?.conversations ?? '—'} · 自动 ${status?.ai ?? '—'} · 人工 ${status?.human ?? '—'}`),
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' } },
          h('button', {
            style: { ...button, fontSize: 13, padding: '6px 14px' },
            onClick: openPanel,
          }, '打开控制面板'),
        ),
        h('div', { style: muted },
          '点「打开控制面板」会在新标签页打开：会话列表、人工接管、备注、归档、QQ 凭证配置都在那里。'),
        h('div', { style: muted },
          '接管和回复也可以直接在会话标题栏操作：打开任意客服会话，右上角有「接管 / 回复」。'),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.effect(() => {
          let stopped = false
          const tick = () => { if (!stopped) void refresh() }
          tick()
          const timer = setInterval(tick, 5000)
          return () => {
            stopped = true
            clearInterval(timer)
          }
        }, 'cs-panel: session poll')

        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'cs-agent',
          order: 26,
          label: '客服',
        }, SettingsPanel))

        ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
          name: 'conversation.session.header.actions',
          id: 'cs-takeover',
          order: 5,
        }, HeaderActions))

        ctx.slots.inject('sidebar.session.row.leading', () => ctx.slots.register({
          name: 'sidebar.session.row.leading',
          id: 'cs-human-mark',
          order: 5,
        }, RowBadge))

      },
    }
  },
})
