// 客服控制面板的整页 HTML。
//
// 为什么单独一个文件：这五百多行是**界面**，不是网关逻辑。它以前和 HTTP 路由、
// 会话状态、投递队列一起挤在 gateway.js 里，改一个按钮的样式要先滚过一千行后端代码。
//
// 这里只有一个导出的函数 `panelHtml(route)`，返回一整页 HTML 字符串：内联样式 +
// 内联脚本，不依赖任何前端构建。页面里的 JS 通过 `fetch(BASE + ...)` 调
// `{route}` 下的各个端点，所以 `BASE` 由参数注入 —— 换挂载路径不用改代码。
//
// 面板能做的事就是运维日常做的事：看会话、接管/交还、发消息、慢放死信、
// 看健康状态。它没有登录态，**不要把它暴露到公网**（见 INSTALL.md）。

export function panelHtml(route) {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>客服控制面板</title>
<style>
  :root {
    color-scheme: light dark;
    --bg:#fff; --panel:#fafafa; --line:#e6e6e6; --text:#1a1a1a; --muted:#8a8a8a;
    --accent:#2563eb; --sel:#eef2ff; --in:#f2f2f2; --ai:#e8f0fe; --admin:#e6f7ec; --danger:#c33;
  }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#101010; --panel:#171717; --line:#2a2a2a; --text:#e9e9e9; --muted:#8f8f8f;
      --accent:#60a5fa; --sel:#1e293b; --in:#1f1f1f; --ai:#1c2b45; --admin:#15301f; }
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body { margin:0; height:100vh; overflow:hidden; background:var(--bg); color:var(--text);
    font: 14px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  .app { display:flex; height:100vh; }
  .side { width:320px; min-width:240px; border-right:1px solid var(--line); display:flex; flex-direction:column; background:var(--panel); }
  .side-top { padding:14px 16px 10px; border-bottom:1px solid var(--line); }
  .title { font-size:15px; font-weight:600; display:flex; align-items:center; gap:8px; }
  .dot { width:8px; height:8px; border-radius:50%; background:var(--muted); }
  .dot.on { background:#22c55e; }
  .side-actions { display:flex; gap:6px; margin-top:10px; }
  .filters { display:flex; gap:6px; padding:10px 16px; border-bottom:1px solid var(--line); align-items:center; }
  .search { flex:1; font:inherit; font-size:12.5px; padding:5px 9px; border-radius:7px;
    border:1px solid var(--line); background:var(--bg); color:inherit; outline:none; }
  .search:focus { border-color:var(--accent); }
  .bulk[hidden] { display:none; }
  .bulk { display:flex; gap:6px; align-items:center; padding:8px 16px; border-bottom:1px solid var(--line);
    font-size:12px; color:var(--muted); background:var(--sel); }
  .pick { margin:2px 0 0; accent-color:var(--accent); }
  .item.archived { opacity:.55; }
  .chip { font:inherit; font-size:12px; padding:3px 10px; border-radius:999px; border:1px solid var(--line);
    background:transparent; color:inherit; cursor:pointer; opacity:.75; }
  .chip.active { background:var(--sel); border-color:transparent; opacity:1; }
  .list { flex:1; overflow:auto; }
  .item { display:flex; gap:10px; padding:11px 16px; cursor:pointer; border-bottom:1px solid var(--line); }
  .item:hover { background:var(--sel); }
  .item.active { background:var(--sel); }
  .avatar { width:34px; height:34px; border-radius:50%; flex:none; display:flex; align-items:center; justify-content:center;
    font-size:13px; font-weight:600; color:#fff; }
  .item-body { min-width:0; flex:1; }
  .item-name { display:flex; justify-content:space-between; gap:8px; align-items:baseline; }
  .item-name b { font-weight:600; font-size:13.5px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .item-name time { font-size:11px; color:var(--muted); flex:none; }
  .item-sub { font-size:12px; color:var(--muted); display:flex; gap:6px; align-items:center; margin-top:2px; }
  .tag { font-size:11px; padding:0 7px; border-radius:999px; border:1px solid var(--line); }
  .tag.human { color:#b45309; border-color:#f59e0b55; background:#f59e0b14; }
  .side-foot { padding:10px 16px; border-top:1px solid var(--line); font-size:12px; color:var(--muted);
    display:flex; justify-content:space-between; align-items:center; gap:8px; }
  main { flex:1; display:flex; flex-direction:column; min-width:0; min-height:0; }
  /* 嵌在设置面板里时列宽会变窄：会话列表收成上半屏，对话留出空间。 */
  @media (max-width: 700px) {
    .app { flex-direction:column; }
    .side { width:auto; min-width:0; max-height:42vh; border-right:0; border-bottom:1px solid var(--line); }
  }
  #pane { flex:1; display:flex; flex-direction:column; min-height:0; }
  .thread-top { padding:12px 20px; border-bottom:1px solid var(--line); display:flex; align-items:center; gap:10px;
    position:sticky; top:0; z-index:3; background:var(--bg); }
  .thread-top .who { font-weight:600; }
  .thread-top .sub { font-size:12px; color:var(--muted); }
  .spacer { flex:1; }
  .btn { font:inherit; font-size:12px; padding:4px 12px; border-radius:7px; border:1px solid var(--line);
    background:transparent; color:inherit; cursor:pointer; }
  .btn:hover { background:var(--sel); }
  .btn.primary { background:var(--accent); border-color:transparent; color:#fff; }
  .btn:disabled { opacity:.45; cursor:default; }
  .messages { flex:1; min-height:0; overflow:auto; padding:22px 24px; display:flex; flex-direction:column; gap:10px; }
  .bubble { max-width:72%; padding:9px 13px; border-radius:14px; white-space:pre-wrap; word-break:break-word; }
  .bubble.customer { align-self:flex-start; background:var(--in); border-bottom-left-radius:4px; }
  .bubble.ai { align-self:flex-end; background:var(--ai); border-bottom-right-radius:4px; }
  .bubble.admin { align-self:flex-end; background:var(--admin); border-bottom-right-radius:4px; }
  .bubble .meta { font-size:10.5px; color:var(--muted); margin-top:4px; }
  .bubble .shot { display:block; max-width:320px; max-height:240px; border-radius:8px; margin-top:6px; cursor:zoom-in; }
  .composer { display:flex; gap:8px; padding:14px 20px; border-top:1px solid var(--line); }
  .composer input { flex:1; font:inherit; padding:9px 13px; border-radius:9px; border:1px solid var(--line);
    background:var(--bg); color:inherit; outline:none; }
  .composer input:focus { border-color:var(--accent); }
  .empty { margin:auto; text-align:center; color:var(--muted); font-size:13px; line-height:1.9; }
  .empty b { display:block; color:var(--text); font-size:14px; margin-bottom:4px; }
  .hint { font-size:12px; color:var(--muted); padding:0 20px 12px; }
  .btn.mini { font-size:10.5px; padding:0 6px; margin-left:6px; border-radius:5px; }
  .mention { align-self:center; font-size:12px; color:var(--muted); display:flex; align-items:center; gap:6px; }
  .card { margin:24px auto; width:min(520px, 100%); display:flex; flex-direction:column; gap:14px; }
  .field { display:flex; flex-direction:column; gap:6px; font-size:12px; color:var(--muted); }
  .field input { font:inherit; font-size:13px; padding:8px 11px; border-radius:8px; border:1px solid var(--line);
    background:var(--bg); color:var(--text); outline:none; }
  .field input:focus { border-color:var(--accent); }
  .card .row { display:flex; gap:8px; align-items:center; }
  .kv { font-size:12px; color:var(--muted); display:grid; grid-template-columns: 92px 1fr; gap:4px 10px; }
  .kv code { font-size:11.5px; word-break:break-all; }
  a { color:var(--accent); }
</style></head>
<body>
<div class="app">
  <aside class="side">
    <div class="side-top">
      <div class="title"><span class="dot" id="bot-dot"></span>客服控制面板</div>
      <div class="side-actions">
        <button class="btn" id="bot-toggle">启动</button>
        <button class="btn" id="refresh">刷新</button>
        <button class="btn" id="config-open" title="QQ 凭证">配置</button>
        <button class="btn" id="ops-open" title="健康 / 死信 / 数据保留 / 审计">运维</button>
        <span class="tag" id="role-tag" hidden></span>
      </div>
    </div>
    <div class="filters">
      <input id="search" class="search" placeholder="搜索群名 / 客户 id / 备注">
    </div>
    <div class="filters">
      <button class="chip active" data-filter="all">全部</button>
      <button class="chip" data-filter="human">人工</button>
      <button class="chip" data-filter="ai">自动</button>
      <span class="spacer"></span>
      <label class="chip"><input type="checkbox" id="show-archived"> 归档</label>
    </div>
    <div class="bulk" id="bulk" hidden></div>
    <div class="list" id="list"></div>
    <div class="side-foot">
      <span id="summary">—</span>
      <a href="#" id="orphan-link">孤儿 0</a>
    </div>
  </aside>
  <main>
    <div id="pane"></div>
  </main>
</div>
<script>
const BASE = ${JSON.stringify(route)}
const state = { records: [], selected: null, messages: [], filter: 'all', bot: null, status: null, orphans: [], view: 'thread',
  query: '', showArchived: false, picked: new Set(), config: null, ops: null,
  // 角色由 GET {route}/whoami 决定；服务端已经拦了写操作，这里只是别把不该点的按钮
  // 摆在人眼前。默认给 admin，等 whoami 回来再关——先渲染后禁用比先禁后放开安全，
  // 因为误点一次就够造成后果。
  role: 'admin', readonly: false }
// "能不能写"的唯一判据。写操作一律先问它，再发请求。
const canWrite = () => state.readonly !== true
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]))
const el = id => document.getElementById(id)

async function api(path, body) {
  const res = await fetch(BASE + path, body === undefined ? {} : {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? res.status)
  return res.json().catch(() => ({}))
}

function ago(iso) {
  if (!iso) return ''
  const diff = Date.now() - new Date(iso).getTime()
  const m = Math.floor(diff / 60000)
  if (m < 1) return '刚刚'
  if (m < 60) return m + ' 分钟前'
  const h = Math.floor(m / 60)
  if (h < 24) return h + ' 小时前'
  return Math.floor(h / 24) + ' 天前'
}

function color(name) {
  let hash = 0
  for (const ch of String(name)) hash = (hash * 31 + ch.codePointAt(0)) % 360
  return 'hsl(' + hash + ', 52%, 48%)'
}

function displayName(record) {
  if (record.label) return record.label
  if (record.groupId) return record.groupName || '群 ' + record.groupId.slice(0, 6)
  if (record.senderName) return record.senderName
  return '客户 ' + String(record.key).split(':').pop().slice(0, 6)
}

function visible() {
  const query = state.query.trim().toLowerCase()
  return state.records.filter(r => {
    if (!state.showArchived && r.archivedAt) return false
    if (state.filter === 'human' && r.mode !== 'human') return false
    if (state.filter === 'ai' && r.mode === 'human') return false
    if (query === '') return true
    const haystack = [displayName(r), r.key, r.senderId, r.groupId, r.groupName, r.label]
      .filter(Boolean).join(' ').toLowerCase()
    return haystack.includes(query)
  })
}

function renderList() {
  const rows = visible()
  el('list').innerHTML = rows.length === 0
    ? '<div class="empty" style="padding:32px 16px">还没有客户会话</div>'
    : rows.map(r => {
        const name = displayName(r)
        const human = r.mode === 'human'
        return '<div class="item' + (r.key === state.selected ? ' active' : '') + (r.archivedAt ? ' archived' : '')
          + '" data-key="' + esc(r.key) + '">'
          + '<input type="checkbox" class="pick" data-pick="' + esc(r.key) + '"' + (state.picked.has(r.key) ? ' checked' : '') + '>'
          + '<div class="avatar" style="background:' + color(name) + '">' + esc(name.slice(0, 1)) + '</div>'
          + '<div class="item-body"><div class="item-name"><b>' + esc(name) + '</b><time>' + ago(r.lastSeenAt) + '</time></div>'
          + '<div class="item-sub">' + (r.groupId ? '群聊' : '私聊')
          + ' <span class="tag ' + (human ? 'human' : '') + '">' + (human ? '人工' : '自动') + '</span>'
          + (r.token ? ' <span class="tag" title="点击复制完整标题，DSH 里搜它" data-copy="'
              + esc(r.title ?? '') + '">#' + esc(r.token) + '</span>' : '')
          + '</div>'
          + '</div></div>'
      }).join('')
}

function statLine(label, value, bad) {
  return '<div class="kv"><span>' + esc(label) + '</span><span style="'
    + (bad ? 'color:var(--danger);font-weight:600' : '') + '">' + esc(value) + '</span></div>'
}

function renderOps() {
  const pane = el('pane')
  const ops = state.ops
  const head = '<div class="thread-top"><span class="who">运维</span><span class="spacer"></span>'
    + '<button class="btn" id="ops-refresh">重新检查</button>'
    + '<button class="btn" id="back">返回</button></div>'
  if (ops === null) {
    pane.innerHTML = head + '<div class="messages"><div class="empty">正在检查…</div></div>'
    return
  }
  const health = ops.health ?? {}
  const failedChecks = (health.checks ?? []).filter(c => !c.ok)
  const ok = health.ok === true
  const healthCard = '<div class="card"><div class="row"><b>健康</b>'
    + '<span class="tag" style="' + (ok ? '' : 'color:var(--danger)') + '">'
    + (ok ? '正常' : '需要处理') + '</span></div>'
    + statLine('运行时长', uptimeText(health.uptimeMs))
    + statLine('存储', String(health.store?.kind ?? '?'), false)
    + statLine('写入租约', String(health.lease?.kind ?? '未持有'), health.lease?.lost === true)
    + statLine('入站积压', queueText(health.queues?.inbox), (health.queues?.inbox?.due ?? 0) > 0)
    + statLine('出站积压', queueText(health.queues?.outbox), (health.queues?.outbox?.due ?? 0) > 0)
    + statLine('数据库', health.database === null || health.database === undefined ? '未启用' : String(health.database.version ?? '已连接'),
        health.database !== null && health.database !== undefined && health.database.ok !== true)
    + statLine('告警', alertText(health.alerts), (health.alerts?.active ?? []).length > 0)
    + (failedChecks.length === 0 ? ''
      : '<div class="kv" style="color:var(--danger)"><span>异常项</span><span>'
        + failedChecks.map(c => esc(c.name + '：' + (c.detail ?? '失败'))).join('<br>') + '</span></div>')
    + '</div>'

  const deadCard = '<div class="card"><div class="row"><b>死信</b>'
    + '<span class="spacer"></span><span class="meta">重试到上限仍发不出去的消息</span></div>'
    + ['inbox', 'outbox'].filter(queue => ops.dead?.[queue] !== undefined).map(queue => {
        const rows = ops.dead[queue] ?? []
        const label = queue === 'inbox' ? '入站（客户消息没处理完）' : '出站（回复没送到客户）'
        return '<div class="kv" style="margin-top:10px"><span>' + esc(label) + '</span><span>'
          + (rows.length === 0 ? '没有' : rows.length + ' 条') + '</span></div>'
          + rows.map(row => '<div class="bubble ai" style="margin:6px 0">'
              + esc(previewOf(row)) 
              + '<div class="meta">' + esc(queue) + ' · 试了 ' + esc(row.attempts) + ' 次 · ' + ago(row.createdAt)
              + (row.lastError ? ' · ' + esc(String(row.lastError).slice(0, 160)) : '')
              + ' <button class="btn mini" data-replay="' + esc(queue + ':' + row.idempotencyKey) + '">重放</button></div>'
              + '</div>').join('')
          + (rows.length === 0 ? ''
            : '<div class="row" style="margin-top:6px"><button class="btn mini" data-replay-all="'
              + esc(queue) + '">全部重放</button></div>')
      }).join('')
    + '</div>'

  const plan = ops.plan
  const retentionCard = '<div class="card"><div class="row"><b>数据保留</b><span class="spacer"></span>'
    + '<button class="btn mini" id="ops-scan">看计划</button></div>'
    + '<div class="kv" style="margin-top:8px">'
    + '<span>群聊</span><span>' + esc(limitsText(plan?.limits ?? ops.limits, 'group')) + '</span>'
    + '<span>私聊</span><span>' + esc(limitsText(plan?.limits ?? ops.limits, 'private')) + '</span></div>'
    + '<div class="kv" style="margin-top:8px">'
    + '<span>自动清理</span><span>' + esc(autoSweepText(health.retention)) + '</span></div>'
    + (health.retention?.lastError === undefined || health.retention?.lastError === null ? ''
      : '<div class="meta" style="color:var(--danger)">上次失败：' + esc(String(health.retention.lastError)) + '</div>')
    + (plan === undefined || plan === null ? ''
      : '<div class="kv" style="margin-top:8px">'
        + statLine('将归档', String((plan.archive ?? []).length) + ' 个会话', false)
        + statLine('将清除', String((plan.purge ?? []).length) + ' 个会话', (plan.purge ?? []).length > 0)
        + '</div>'
        + ((plan.archive ?? []).length + (plan.purge ?? []).length === 0
          ? '<div class="meta" style="margin-top:6px">没有到期的会话。</div>'
          : (canWrite()
            ? '<div class="row" style="margin-top:8px"><button class="btn primary" id="ops-purge">执行</button>'
              + '<span class="meta">清除不可逆；每次操作都会写审计</span></div>'
            : '<div class="meta" style="margin-top:6px">只读令牌：可以看计划，不能执行清除。</div>')))
    + '</div>'

  const usage = ops.usage ?? {}
  const usageTotal = usage.totals ?? {}
  const usageRows = (usage.rows ?? []).slice(0, 7)
  const priced = usage.pricing?.configured === true
  const usageCard = '<div class="card"><div class="row"><b>用量</b>'
    + '<span class="meta">最近 ' + esc(String(usage.days ?? 7)) + ' 天</span>'
    + '<span class="spacer"></span>'
    + '<button class="btn mini" id="ops-usage">刷新</button></div>'
    + statLine('轮数', numberText(usageTotal.turns))
    + statLine('输入', numberText(usageTotal.inputTokens) + ' tok')
    + statLine('输出', numberText(usageTotal.outputTokens) + ' tok')
    + statLine('缓存读', numberText(usageTotal.cacheReadTokens) + ' tok')
    + statLine('成本', priced ? String(usageTotal.cost ?? '$0.00') : '未配置价格', !priced && (usageTotal.turns ?? 0) > 0)
    + (usageRows.length === 0
      ? '<div class="meta" style="margin-top:6px">这段时间还没有对话。</div>'
      : '<div style="margin-top:8px">' + usageRows.map(row => '<div class="kv">'
          + '<span>' + esc(String(row.day)) + '</span>'
          + '<span>' + esc(numberText(row.turns) + ' 轮 · ' + numberText(row.inputTokens) + '/' + numberText(row.outputTokens) + ' tok'
            + (priced ? ' · ' + String(row.cost ?? '$0.00') : '')) + '</span></div>').join('') + '</div>')
    + (priced ? '' : '<div class="meta" style="margin-top:6px">在插件配置里写 pricing.models 才能算钱；现在只统计 token。</div>')
    + '</div>'

  const auditCard = '<div class="card"><div class="row"><b>最近审计</b><span class="spacer"></span>'
    + '<button class="btn mini" id="ops-audit">刷新</button></div>'
    + ((ops.audit ?? []).length === 0
      ? '<div class="meta" style="margin-top:6px">没有记录。</div>'
      : (ops.audit ?? []).map(entry => '<div class="bubble" style="margin:6px 0">'
          + '<b>' + esc(entry.action) + '</b> ' + esc(entry.targetType ?? '') + ' '
          + esc(String(entry.targetId ?? '').slice(0, 60))
          + '<div class="meta">' + esc(entry.actor ?? '?') + ' · ' + ago(entry.at)
          + (entry.detail ? ' · ' + esc(JSON.stringify(entry.detail).slice(0, 120)) : '') + '</div>'
          + '</div>').join(''))
    + '</div>'

  pane.innerHTML = head + '<div class="messages">' + healthCard + deadCard + usageCard + retentionCard + auditCard + '</div>'
}

function numberText(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '0'
  return value.toLocaleString('en-US')
}

function uptimeText(ms) {
  if (typeof ms !== 'number') return '?'
  const minutes = Math.floor(ms / 60000)
  if (minutes < 1) return Math.floor(ms / 1000) + ' 秒'
  if (minutes < 60) return minutes + ' 分钟'
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return hours + ' 小时 ' + (minutes % 60) + ' 分'
  return Math.floor(hours / 24) + ' 天 ' + (hours % 24) + ' 小时'
}

function queueText(queue) {
  if (queue === null || queue === undefined) return '未启用'
  return '待处理 ' + (queue.pending ?? 0) + ' · 重试中 ' + (queue.failed ?? 0)
    + ' · 死信 ' + (queue.dead ?? 0)
}

function limitsText(limits, scope) {
  if (limits === null || limits === undefined) return '默认'
  const archive = limits[scope + 'ArchiveDays']
  const purge = limits[scope + 'PurgeDays']
  if (archive === undefined || purge === undefined) return '默认'
  return archive === 0 && purge === 0 ? '不自动处理' : archive + ' 天归档 / ' + purge + ' 天清除'
}

function previewOf(row) {
  const payload = row.payload ?? {}
  const text = payload.text ?? payload.message?.text ?? payload.key ?? ''
  return String(text).slice(0, 160) || '（无正文）'
}

// 保留期自动清理的状态。运维真正关心的是"它有没有在跑、上次跑是什么时候"，
// 而不是这一轮的计数（大多数轮次本来就什么都不用做）。
function autoSweepText(state) {
  if (state === null || state === undefined) return '未上报'
  if (state.enabled !== true) return '已关闭'
  if (state.lastRunAt === undefined || state.lastRunAt === null) return '等待首次检查'
  return '运行中 · 上次 ' + ago(String(state.lastRunAt))
}

function alertText(alerts) {
  if (alerts === undefined || alerts === null) return '未启用'
  if (alerts.enabled !== true) {
    return alerts.missing === null || alerts.missing === undefined ? '关闭' : '关闭（缺 ' + String(alerts.missing) + '）'
  }
  const active = (alerts.active ?? []).length
  return active === 0 ? '已开启 · 当前无告警' : '已开启 · ' + active + ' 项未恢复'
}

async function loadOps() {
  const [health, dead, plan, audit, usage, alerts] = await Promise.all([
    api('/health').catch(error => ({ ok: false, checks: [{ name: 'health', ok: false, detail: error.message }] })),
    api('/dead?limit=20').catch(() => ({})),
    api('/retention').catch(() => null),
    api('/audit?limit=20').catch(() => ({ entries: [] })),
    api('/usage?days=7').catch(() => ({ days: 7, totals: {}, rows: [], pricing: { configured: false } })),
    api('/alerts?limit=10').catch(() => null),
  ])
  state.ops = { health, dead, plan, audit: audit.entries ?? [], usage, alerts, limits: plan?.limits }
  renderOps()
}

function renderThread() {
  const pane = el('pane')
  const previous = el('reply')
  const draft = previous?.value ?? ''
  const focused = previous !== null && document.activeElement === previous
  const caret = previous?.selectionStart ?? draft.length
  if (state.view === 'ops') {
    renderOps()
    return
  }
  if (state.view === 'orphans') {
    pane.innerHTML = '<div class="thread-top"><span class="who">孤儿会话</span><span class="spacer"></span>'
      + '<button class="btn" id="back">返回</button></div>'
      + '<div class="messages">' + (state.orphans.length === 0
        ? '<div class="empty"><b>没有孤儿会话</b>磁盘上的会话都挂在某个工作区里</div>'
        : state.orphans.map(o => '<div class="bubble customer">' + esc(o.path) + '<div class="meta">' + o.sessions.length
            + ' 个会话 <button class="btn" data-restore="' + esc(o.path) + '">恢复工作区</button></div></div>').join(''))
      + '</div>'
    return
  }
  if (state.view === 'config') {
    const cfg = state.config
    pane.innerHTML = '<div class="thread-top"><span class="who">配置</span><span class="spacer"></span>'
      + '<button class="btn" id="back">返回</button></div>'
      + '<div class="messages"><div class="card">'
      + '<div class="field">QQ AppID<input id="cfg-appid" value="' + esc(cfg?.appId ?? '') + '" placeholder="填你的 AppID"></div>'
      + '<div class="field">QQ AppSecret<input id="cfg-secret" type="password" placeholder="'
      + (cfg?.hasSecret ? '已配置，留空不修改' : '首次配置必填') + '"></div>'
      + '<div class="row"><button class="btn primary" id="cfg-save">保存</button>'
      + '<button class="btn" id="cfg-test">测试连接</button>'
      + '<span class="meta">保存后需要重启机器人</span></div>'
      + '<div class="kv"><span>凭证文件</span><code>' + esc(cfg?.envFile ?? '') + '</code>'
      + '<span>数据目录</span><code>' + esc(cfg?.paths?.data ?? '') + '</code>'
      + '<span>知识库</span><code>' + esc(cfg?.paths?.kb ?? '') + '</code>'
      + '<span>适配器</span><code>' + esc(cfg?.paths?.adapter ?? '') + '</code></div>'
      + '</div></div>'
    return
  }
  const record = state.records.find(r => r.key === state.selected)
  if (record === undefined) {
    pane.innerHTML = '<div class="empty"><b>选择左侧会话</b>接管后可以直接回复客户</div>'
    return
  }
  const name = displayName(record)
  const human = record.mode === 'human'
  const bubbles = state.messages.length === 0
    ? '<div class="empty">还没有消息</div>'
    : state.messages.map(m => {
        const who = m.kind === 'customer' && record.groupId
          ? (m.senderName ? '客户 ' + m.senderName : '客户 ' + String(m.senderId ?? '').slice(0, 6))
          : ''
        const replyTo = m.kind === 'customer' && record.groupId && m.senderId
          ? '<button class="btn mini" data-reply-to="' + esc(m.senderId) + '">回复</button>'
          : ''
        const shots = (m.images ?? []).map(file =>
          '<img class="shot" loading="lazy" src="' + BASE + '/image?path=' + encodeURIComponent(file) + '">').join('')
        return '<div class="bubble ' + m.kind + '">' + (m.text === '' ? '' : esc(m.text)) + shots
          + (who === '' && replyTo === '' ? '' : '<div class="meta">' + esc(who) + replyTo + '</div>') + '</div>'
      }).join('')
  pane.innerHTML = '<div class="thread-top">'
    + '<div class="avatar" style="background:' + color(name) + '">' + esc(name.slice(0, 1)) + '</div>'
    + '<div><div class="who">' + esc(name) + '</div><div class="sub">'
    + '<span class="tag ' + (human ? 'human' : '') + '">' + (human ? '人工接管中' : 'AI 自动回复') + '</span></div></div>'
    + '<span class="spacer"></span>'
    + '<button class="btn" data-act="label">备注</button>'
    + '<button class="btn primary" data-act="mode">' + (human ? '交还 AI' : '接管') + '</button>'
    + '</div>'
    + '<div class="messages" id="messages">' + bubbles + '</div>'
    + (human
      ? '<div class="composer">'
        + (state.mention ? '<span class="mention">@' + esc(String(state.mention).slice(0, 6))
            + '<button class="btn mini" data-clear-mention>×</button></span>' : '')
        + '<input id="reply" placeholder="回复客户…"><button class="btn primary" id="send">发送</button></div>'
      : '<div class="hint">接管后才能直接回复。AI 自动回复期间，你的消息会被忽略。</div>')
  const next = el('reply')
  if (next !== null) {
    next.value = draft
    if (focused) {
      next.focus()
      try { next.setSelectionRange(caret, caret) } catch { /* 忽略 */ }
    }
  }
  const messages = el('messages')
  if (messages) messages.scrollTop = messages.scrollHeight
}

function renderBulk() {
  const bulk = el('bulk')
  if (state.picked.size === 0) {
    bulk.hidden = true
    bulk.innerHTML = ''
    return
  }
  bulk.hidden = false
  bulk.innerHTML = '<span>已选 ' + state.picked.size + '</span><span class="spacer"></span>'
    + '<button class="btn mini" data-bulk="archive">归档</button>'
    + '<button class="btn mini" data-bulk="restore">取消归档</button>'
    + (canWrite() ? '<button class="btn mini" data-bulk="delete">删除</button>' : '')
}

async function loadList() {
  const [list, status, bot] = await Promise.all([
    api('/sessions' + (state.showArchived ? '?all=1' : '')), api('/status'), api('/adapter'),
  ])
  state.records = list.sessions ?? []
  state.status = status
  state.bot = bot
  el('bot-dot').className = 'dot' + (bot.running ? ' on' : '')
  el('bot-toggle').textContent = bot.running ? '停止' : '启动'
  el('summary').textContent = (status.conversations ?? 0) + ' 个会话 · 人工 ' + (status.human ?? 0)
  renderList()
  renderBulk()
}

async function loadHistory() {
  if (state.selected === null) return
  const body = await api('/history?key=' + encodeURIComponent(state.selected))
  state.messages = body.messages ?? []
}

let lastSignature = ''
function signature() {
  const last = state.messages[state.messages.length - 1]
  const record = state.records.find(r => r.key === state.selected)
  return [state.selected, state.view, state.messages.length, last?.at ?? '',
    record?.mode ?? '', record?.label ?? '', record?.archivedAt ?? ''].join('|')
}

// 问一次"我是谁"。失败就保持默认的 admin：面板打不开比权限猜错更明显，
// 而真正的写权限由服务端 403 兜底。
async function loadWhoami() {
  try {
    const me = await api('/whoami')
    state.role = me.role ?? 'admin'
    state.readonly = me.readonly === true
  } catch {
    return
  }
  const tag = el('role-tag')
  if (tag === null) return
  if (state.readonly !== true) {
    tag.hidden = true
    return
  }
  tag.hidden = false
  tag.textContent = '只读'
  tag.title = '当前令牌只能查看：接管、回复、删除、重放、执行清除都会被拒绝'
}

async function refresh() {
  try {
    await loadList()
    if (state.selected !== null) await loadHistory()
    const next = signature()
    if (next !== lastSignature) {
      lastSignature = next
      renderThread()
    }
  } catch (error) {
    console.warn('refresh failed:', error.message)
  }
}

document.addEventListener('click', async event => {
  const copy = event.target.closest('[data-copy]')
  if (copy !== null) {
    const text = copy.dataset.copy
    if (text) {
      try { await navigator.clipboard.writeText(text); copy.textContent = '已复制' } catch { /* 忽略 */ }
      setTimeout(() => { copy.textContent = '#' + (text.match(/#(\w+)$/)?.[1] ?? '') }, 1200)
    }
    return
  }
  const pick = event.target.closest('[data-pick]')
  if (pick !== null) {
    const key = pick.dataset.pick
    if (state.picked.has(key)) state.picked.delete(key)
    else state.picked.add(key)
    renderList()
    renderBulk()
    return
  }
  const bulk = event.target.closest('[data-bulk]')
  if (bulk !== null) {
    const keys = [...state.picked]
    const action = bulk.dataset.bulk
    if (action === 'delete' && !confirm('删除 ' + keys.length + ' 个会话？会话记录会被永久删除。')) return
    const failedToDetach = []
    for (const key of keys) {
      try {
        if (action === 'delete') {
          const result = await api('/delete', { key })
          if (result.detached === false) failedToDetach.push(key)
        } else {
          await api('/archive', { key, archived: action === 'archive' })
        }
      } catch (error) { alert(error.message) }
    }
    if (failedToDetach.length > 0) {
      alert('已删除 ' + keys.length + ' 条，但 ' + failedToDetach.length + ' 条没能从侧边栏摘掉，刷新页面后再看。')
    }
    state.picked.clear()
    if (keys.includes(state.selected) && action === 'delete') state.selected = null
    await refresh()
    renderThread()
    return
  }
  const item = event.target.closest('.item')
  if (item !== null) {
    state.selected = item.dataset.key
    state.view = 'thread'
    state.messages = []
    state.mention = null
    renderList()
    renderThread()
    try { await loadHistory(); renderThread() } catch (error) { alert(error.message) }
    return
  }
  const replyTo = event.target.closest('[data-reply-to]')
  if (replyTo !== null) {
    state.mention = replyTo.dataset.replyTo
    renderThread()
    el('reply')?.focus()
    return
  }
  if (event.target.closest('[data-clear-mention]') !== null) {
    state.mention = null
    renderThread()
    return
  }
  const chip = event.target.closest('.chip')
  if (chip !== null) {
    state.filter = chip.dataset.filter
    for (const node of document.querySelectorAll('.chip')) node.classList.toggle('active', node === chip)
    renderList()
    return
  }
  const restore = event.target.closest('[data-restore]')
  if (restore !== null) {
    try { await api('/orphans/restore', { path: restore.dataset.restore }); alert('已登记为工作区，重启 dsh 后生效') }
    catch (error) { alert(error.message) }
    return
  }
  const act = event.target.closest('[data-act]')
  if (act !== null) {
    if (!canWrite()) { alert('当前是只读令牌，不能接管或改备注。'); return }
    const record = state.records.find(r => r.key === state.selected)
    if (record === undefined) return
    const human = record.mode === 'human'
    try {
      if (act.dataset.act === 'mode') await api('/mode', { key: record.key, mode: human ? 'ai' : 'human' })
      if (act.dataset.act === 'label') {
        const text = prompt('备注名（留空清除）：')
        if (text === null) return
        await api('/label', { key: record.key, label: text })
      }
      await refresh()
    } catch (error) { alert(error.message) }
    return
  }
  if (event.target.id === 'ops-open') {
    state.view = 'ops'
    state.ops = null
    renderOps()
    try { await loadOps() } catch (error) { alert(error.message) }
    return
  }
  if (event.target.id === 'ops-refresh' || event.target.id === 'ops-audit' || event.target.id === 'ops-usage') {
    try { await loadOps() } catch (error) { alert(error.message) }
    return
  }
  if (event.target.id === 'ops-scan') {
    try { state.ops.plan = await api('/retention'); renderOps() } catch (error) { alert(error.message) }
    return
  }
  if (event.target.id === 'ops-purge') {
    if (!canWrite()) { alert('当前是只读令牌，不能执行清除。'); return }
    const plan = state.ops?.plan
    const archive = (plan?.archive ?? []).length
    const purge = (plan?.purge ?? []).length
    if (!confirm('将归档 ' + archive + ' 个会话、清除 ' + purge + ' 个会话。\\n清除不可逆，消息和用量会一起删掉。继续？')) return
    try {
      const result = await api('/retention', { dryRun: false, actor: 'panel' })
      alert('完成：归档 ' + (result.archived ?? []).length + '，清除 ' + (result.purged ?? []).length)
      await loadOps()
    } catch (error) { alert(error.message) }
    return
  }
  const replay = event.target.closest('[data-replay]')
  if (replay !== null) {
    if (!canWrite()) { alert('当前是只读令牌，不能重放死信。'); return }
    const [queue, ...rest] = replay.dataset.replay.split(':')
    try {
      const result = await api('/replay', { queue, ids: [rest.join(':')], actor: 'panel' })
      alert(result.replayed?.length > 0 ? '已重新排队，稍后会自动重发' : '没有重放：' + JSON.stringify(result.skipped ?? []))
      await loadOps()
    } catch (error) { alert(error.message) }
    return
  }
  const replayAll = event.target.closest('[data-replay-all]')
  if (replayAll !== null) {
    if (!canWrite()) { alert('当前是只读令牌，不能重放死信。'); return }
    if (!confirm('把这批死信全部重新排队？')) return
    try {
      const result = await api('/replay', { queue: replayAll.dataset.replayAll, actor: 'panel' })
      alert('已重新排队 ' + (result.replayed?.length ?? 0) + ' 条')
      await loadOps()
    } catch (error) { alert(error.message) }
    return
  }
  if (event.target.id === 'back') { state.view = 'thread'; renderThread(); return }
  if (event.target.id === 'orphan-link') {
    event.preventDefault()
    try { const body = await api('/orphans'); state.orphans = body.orphans ?? []; state.view = 'orphans'; renderThread() }
    catch (error) { alert(error.message) }
    return
  }
  if (event.target.id === 'bot-toggle') {
    if (!canWrite()) { alert('当前是只读令牌，不能启停机器人。'); return }
    try { await api('/adapter/' + (state.bot.running ? 'stop' : 'start'), {}); await refresh() }
    catch (error) { alert(error.message) }
    return
  }
  if (event.target.id === 'refresh') { await refresh(); return }
  if (event.target.id === 'config-open') {
    try { state.config = await api('/config'); state.view = 'config'; renderThread() }
    catch (error) { alert(error.message) }
    return
  }
  if (event.target.id === 'cfg-save') {
    if (!canWrite()) { alert('当前是只读令牌，不能修改机器人配置。'); return }
    const appId = el('cfg-appid').value.trim()
    const appSecret = el('cfg-secret').value.trim()
    try {
      await api('/config', { appId, appSecret })
      alert('已保存。重启机器人后生效。')
      state.config = await api('/config')
      renderThread()
    } catch (error) { alert(error.message) }
    return
  }
  if (event.target.id === 'cfg-test') {
    try { const result = await api('/config/test', {}); alert('连接成功，token 有效期 ' + (result.expiresIn ?? '?') + ' 秒') }
    catch (error) { alert('连接失败：' + error.message) }
    return
  }
  if (event.target.id === 'send') {
    const input = el('reply')
    const text = input.value.trim()
    if (text === '') return
    const body = { key: state.selected, text }
    if (state.mention) body.mention = state.mention
    try {
      const result = await api('/reply', body)
      input.value = ''
      state.mention = null
      if (result.delivered === false) {
        alert('消息没送到客户：' + (result.error ?? '未知原因') + ' — QQ 只允许在客户最后一条消息后 5 分钟内被动回复。')
      }
      await refresh()
    } catch (error) { alert(error.message) }
  }
})

document.addEventListener('click', event => {
  if (event.target.classList?.contains('shot')) window.open(event.target.src, '_blank', 'noopener')
})
document.getElementById('search').addEventListener('input', event => {
  state.query = event.target.value
  renderList()
})
document.getElementById('show-archived').addEventListener('change', async event => {
  state.showArchived = event.target.checked
  await loadList()
  renderThread()
})
document.addEventListener('keydown', event => {
  if (event.key === 'Enter' && event.target.id === 'reply') {
    event.preventDefault()
    el('send')?.click()
  }
})

const preselect = new URLSearchParams(location.search).get('key')
if (preselect) { state.selected = preselect; state.view = 'thread' }
// 先问角色再画第一屏：只读用户不该先看到能点的删除按钮再眼看着它变灰。
loadWhoami().then(() => refresh()).then(async () => {
  if (preselect) {
    try { await loadHistory(); renderThread() } catch (error) { console.warn(error.message) }
  }
})
setInterval(() => { void refresh() }, 5000)
</script>
</body></html>`
}

/** Map a file extension to a response content type. */
