// 运维控制面板（Web UI 侧）：全部挂在 DSH 原生插槽上。
//
// - 设置 → 运维：协同开关、只读通道自检、工单计数、最近工单的会话跳转
// - 会话标题栏：运维会话显示「待批 N」与「回客服」
// - 侧边栏会话行：运维会话显示「运」
// - 深链：/?opsSession=<sessionId> 定位到那个会话（运维面板的「打开对话」用它）
//
// 只调用 /ops/* 的 HTTP 接口，不持有任何凭证。
window.__ModuleLoader__.load({
  id: '@local/dsh-ops-agent',
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

    // 所有插槽共享一份状态；5 秒刷新一次。
    const store = { status: null, proposals: [], incidents: [], listeners: new Set(), error: '' }

    function emit() {
      for (const listener of store.listeners) listener()
    }

    async function refresh() {
      try {
        const [statusResponse, incidentsResponse] = await Promise.all([
          fetch('/ops/status'),
          fetch('/ops/incidents'),
        ])
        if (!statusResponse.ok || !incidentsResponse.ok) {
          throw new Error(`HTTP ${statusResponse.status}/${incidentsResponse.status}`)
        }
        store.status = await statusResponse.json()
        store.incidents = board(await incidentsResponse.json())
        store.error = ''
      } catch (error) {
        store.error = error.message
      }
      emit()
    }

    /** 运行中的工单在前，其次是台账里的历史；同一个工单只保留一条。 */
    function board(payload) {
      const live = payload?.live ?? []
      const historic = payload?.historic ?? []
      const seen = new Set(live.map(item => item.incidentId))
      return [...live, ...historic.filter(item => !seen.has(item.incidentId))]
    }

    /** 订阅面板状态。 */
    function useOps() {
      const [, bump] = useState(0)
      useEffect(() => {
        const listener = () => bump(value => value + 1)
        store.listeners.add(listener)
        return () => { store.listeners.delete(listener) }
      }, [])
      return store
    }

    const isOpsSession = sessionId => typeof sessionId === 'string' && sessionId.startsWith('ops-')
    const openPanel = () => { window.open('/ops/panel', '_blank', 'noopener') }

    /** 某个运维会话对应的工单（用来跳回派单的客服会话）。 */
    function incidentOfOpsSession(sessionId) {
      return store.incidents.find(item => item.opsSessionId === sessionId)
    }

    /** 浏览器侧唯一的导航入口：选中一个会话并显示它的对话。 */
    function openSession(ctx, sessionId) {
      if (typeof sessionId !== 'string' || sessionId === '') return false
      const workspace = ctx.get?.('uiWorkspace') ?? ctx.uiWorkspace
      if (typeof workspace?.openSession !== 'function') return false
      try {
        workspace.openSession(sessionId)
        return true
      } catch {
        return false
      }
    }

    /** 会话列表里已经有它了吗（列表没加载完时 openSession 会静默失败）。 */
    function sessionKnown(ctx, sessionId) {
      const sessions = ctx.get?.('sessions') ?? ctx.sessions
      const list = sessions?.list?.getSnapshot?.()
      return Array.isArray(list?.ids) && list.ids.includes(sessionId)
    }

    /** 会话标题栏：运维会话显示待批数量，并提供回到工单来源的一步跳转。 */
    function HeaderActions(props) {
      const state = useOps()
      if (!isOpsSession(props.sessionId)) return null
      const pending = state.proposals.filter(item => item.status === 'pending').length
      const incident = incidentOfOpsSession(props.sessionId)
      const requester = incident?.requesterSessionId
      const ctx = props.ctx
      return h('div', { style: { display: 'inline-flex', gap: 6 } },
        typeof requester === 'string' && requester !== ''
          ? h('button', {
            style: button,
            title: `回到派单的客服会话：${requester}`,
            onClick: () => openSession(ctx, requester),
          }, '回客服')
          : null,
        h('button', {
          style: { ...button, opacity: pending > 0 ? 1 : 0.6 },
          title: pending > 0 ? `${pending} 个变更提案等待批准` : '运维控制台',
          onClick: openPanel,
        }, pending > 0 ? `待批 ${pending}` : '运维'))
    }

    /** 侧边栏行首：运维会话显示「运」。 */
    function RowBadge(props) {
      if (!isOpsSession(props.sessionId)) return null
      return h('span', { title: '运维会话', style: { fontSize: 10, lineHeight: '16px', opacity: 0.8 } }, '运')
    }

    /** 设置 → 运维。 */
    function SettingsPanel(props) {
      const state = useOps()
      const [error, setError] = useState('')
      const [busy, setBusy] = useState(false)

      const ctx = props.ctx

      const load = useCallback(async () => {
        await refresh()
        setError(store.error)
      }, [])

      useEffect(() => {
        void load()
        const timer = setInterval(() => { void load() }, 5000)
        return () => clearInterval(timer)
      }, [load])

      const status = state.status
      const pending = state.proposals.filter(item => item.status === 'pending')
      const env = status?.env
      const failing = env?.checks?.find(check => !check.ok)
      const enabled = status?.enabled !== false
      // 搜索只在控制台里（/ops/panel）：设置页保持轻量，最多列 8 条。
      const recent = state.incidents.slice(0, 8)

      const toggle = async () => {
        const next = !enabled
        const question = next
          ? '开启运维协同？客服遇到需要查集群的问题可以直接转运维。'
          : '关闭运维协同？客服将独立处理所有工单，已在运行的运维工单不受影响。'
        if (!window.confirm(question)) return
        setBusy(true)
        try {
          await fetch(next ? '/ops/enable' : '/ops/disable', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ by: 'admin' }),
          })
        } finally {
          setBusy(false)
          await load()
        }
      }

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 680, padding: '4px 0' } },
        // 协同开关
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' } },
          h('strong', null, '运维协同'),
          h('span', { style: { fontSize: 13, opacity: enabled ? 1 : 0.65 } },
            enabled ? '● 已开启（客服可转运维）' : '○ 已关闭（客服独立运行）'),
          h('button', {
            style: { ...button, fontSize: 13, padding: '6px 14px', opacity: busy ? 0.5 : 1 },
            disabled: busy,
            onClick: toggle,
          }, enabled ? '关闭协同' : '开启协同'),
        ),
        h('div', { style: muted },
          enabled
            ? '关掉之后客服仍然照常接单，只是不再把工单转给运维；已经派出去的运维工单不受影响。'
            : '现在客服独立处理所有工单。重新开启后，客服遇到需要查集群的问题会再次转运维。'),

        // 只读通道与计数
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' } },
          h('strong', null, '只读通道'),
          h('span', { style: muted }, env === undefined ? '—' : (env.ok ? '● 只读可用' : '○ 只读不可用')),
        ),
        error === '' ? null : h('div', { style: { color: '#c33', fontSize: 13 } },
          `控制台接口不可用：${error}`,
          error.includes('404') ? h('div', { style: { ...muted, marginTop: 4 } },
            '404 说明 ops-agent 插件没在当前 dsh 进程里加载：重启一次 dsh 就好。') : null),
        failing === undefined ? null : h('div', { style: { fontSize: 13, color: '#c96a00' } },
          `自检失败 · ${failing.name}：${failing.detail}`),
        h('div', { style: muted },
          `进行中 ${status?.counts?.live ?? '—'} · 历史 ${status?.counts?.historic ?? '—'}`
          + ` · 待批准 ${status?.counts?.pendingProposals ?? '—'}`
          + ` · 知识库 ${status?.kb?.shared ?? '—'} 条 + ${status?.kb?.internal ?? '—'} 条内部`
          + ` · 候选 ${status?.kb?.candidates ?? '—'}`),

        // 最近工单：一键跳到客服或运维的对话（搜索和归档在控制台里，这里不做重复入口）
        h('div', null,
          h('strong', null, '最近工单'),
          recent.length === 0
            ? h('div', { style: muted }, '还没有工单。')
            : h('div', { style: { marginTop: 6, display: 'flex', flexDirection: 'column', gap: 6 } },
              ...recent.map(item => h('div', {
                key: item.incidentId,
                style: { display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, flexWrap: 'wrap' },
              },
              h('span', { style: { fontFamily: 'ui-monospace, monospace', fontSize: 12 } }, item.incidentId),
              h('span', { style: muted }, item.state ?? ''),
              h('button', {
                style: button,
                disabled: !item.requesterSessionId,
                onClick: () => openSession(ctx, item.requesterSessionId),
              }, '客服对话'),
              h('button', {
                style: button,
                disabled: !item.opsSessionId,
                onClick: () => openSession(ctx, item.opsSessionId),
              }, '运维对话')))),
        ),

        h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' } },
          h('button', {
            style: { ...button, fontSize: 13, padding: '6px 14px' },
            onClick: openPanel,
          }, '打开运维控制台'),
        ),
        pending.length === 0 ? null : h('div', { style: { fontSize: 13 } },
          '待批准变更：',
          ...pending.slice(0, 3).map(item => h('div', { key: item.id, style: muted },
            `${item.id} · ${item.incidentId} · ${item.action} → ${item.target}`))),
        h('div', { style: muted },
          '控制台里有：工单看板（现象/证据/结论）、变更审批（批准后由管理员手动执行）、知识库候选审核、只读通道状态。'),
        h('div', { style: muted },
          '工单会话标题以「运维 INC-…」开头，侧边栏左侧有「运」标记；运维会话标题栏有「回客服」，可以直接跳回派单的那个对话。'),
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
        }, 'ops-panel: status poll')

        // 深链：运维面板的「打开对话」指向 /?opsSession=<id>。会话列表可能还没加载完，
        // 所以轮询到它出现为止（最多 30 秒），然后打开并把参数从地址栏抹掉。
        ctx.effect(() => {
          if (typeof window === 'undefined') return
          // 非浏览器宿主（自测、未来别的平台）没有 location：静默跳过即可。
          const search = typeof window.location?.search === 'string' ? window.location.search : ''
          if (search === '') return
          const params = new URLSearchParams(search)
          const target = params.get('opsSession')
          if (target === null || target === '') return
          const strip = () => {
            try {
              const url = new URL(window.location.href)
              url.searchParams.delete('opsSession')
              window.history.replaceState(null, '', url.toString())
            } catch { /* 地址栏不可写就算了 */ }
          }
          let attempts = 0
          const timer = setInterval(() => {
            attempts += 1
            if (sessionKnown(ctx, target) || attempts >= 20) {
              const opened = openSession(ctx, target)
              if (opened || attempts >= 60) {
                clearInterval(timer)
                strip()
              }
            }
            if (attempts >= 60) clearInterval(timer)
          }, 500)
          return () => clearInterval(timer)
        }, 'ops-panel: session deep link')

        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'ops-agent',
          order: 27,
          label: '运维',
        }, props => h(SettingsPanel, { ...props, ctx })))

        ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
          name: 'conversation.session.header.actions',
          id: 'ops-approvals',
          order: 6,
        }, props => h(HeaderActions, { ...props, ctx })))

        ctx.slots.inject('sidebar.session.row.leading', () => ctx.slots.register({
          name: 'sidebar.session.row.leading',
          id: 'ops-mark',
          order: 6,
        }, RowBadge))
      },
    }
  },
})
