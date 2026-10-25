/**
 * Ops control panel: the HTTP surface behind `/ops/panel` and the admin UI.
 *
 * The page is a single self-contained document that polls the JSON endpoints —
 * no bundler, no client framework — because it has to work even when the ops
 * agent itself is broken, which is exactly when an administrator needs it.
 *
 * Endpoints:
 *   GET  /ops/panel                      the page
 *   GET  /ops/status                     counters + access self-check + collaboration switch
 *   POST /ops/enable | /ops/disable      flip customer-service ⇄ ops collaboration
 *   POST /ops/dispatch                   open an incident by hand
 *   GET  /ops/incidents?q=&archived=1    live and historic incidents, filterable
 *   POST /ops/incidents/<id>/resume      answer a need_info question
 *   POST /ops/incidents/<id>/archive     hide from the board (ledger + session stay)
 *   POST /ops/incidents/<id>/delete      drop from the board and the workspace
 *   GET  /ops/sessions?q=                search sessions by incident, id, or symptom
 *   GET  /ops/proposals                  change proposals
 *   POST /ops/proposals/<id>/approve     approve one
 *   POST /ops/proposals/<id>/reject      reject one
 *   GET  /ops/kb/candidates              knowledge-base candidates
 *   POST /ops/kb/candidates/<id>/verify  promote one
 *   POST /ops/kb/candidates/<id>/reject  drop one
 *
 * @module @local/dsh-ops-agent/panel
 */

import { incidentMatches } from './dispatcher.js'
import { createCluster } from './cluster.js'

/** Cordis function-plugin name. */
export const name = 'ops-panel'

/** Host services the panel needs. */
export const inject = ['webServer']

/** Default route prefix. */
const DEFAULT_ROUTE = '/ops'

/**
 * Register the panel route.
 *
 * @param ctx - host context with a web server.
 * @param config - `route`, `cluster`, and `kubeconfig` passthrough.
 */
export function apply(ctx, config) {
  const route = normalizeRoute(config?.route ?? DEFAULT_ROUTE)
  const panel = { route, cluster: createCluster(config?.cluster ?? config ?? {}) }

  const dispose = ctx.webServer.register({
    kind: 'prefix',
    path: route,
    handler: (req, res) => handleHttp(ctx, panel, req, res),
  })
  ctx.effect(() => dispose, 'ops-panel: route')
}

/**
 * Route one request. Exported for tests.
 *
 * @param ctx - host context.
 * @param panel - `{route, cluster}`.
 * @param req - node request.
 * @param res - node response.
 */
export async function handleHttp(ctx, panel, req, res) {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const suffix = url.pathname.slice(panel.route.length) || '/'
  const method = (req.method ?? 'GET').toUpperCase()

  try {
    if (method === 'GET' && (suffix === '/' || suffix === '/panel')) {
      send(res, 200, html(panel.route), 'text/html; charset=utf-8')
      return
    }
    // 协同开关：关掉之后客服独立运行，已派出的工单不受影响。
    if (method === 'POST' && (suffix === '/enable' || suffix === '/disable')) {
      const dispatcher = dispatcherOf(ctx)
      if (dispatcher === undefined) return sendJson(res, 503, { ok: false, error: '运维调度器未加载' })
      if (typeof dispatcher.setEnabled !== 'function') return sendJson(res, 501, { ok: false, error: '这个调度器版本没有协同开关' })
      const body = await readJson(req)
      const result = await dispatcher.setEnabled(suffix === '/enable', {
        by: body?.by ?? 'admin',
        note: body?.note ?? '',
      })
      return sendJson(res, 200, result)
    }
    if (method === 'GET' && suffix === '/status') {
      const dispatcher = dispatcherOf(ctx)
      const [snapshot, kb] = await Promise.all([
        dispatcher?.snapshot() ?? { live: [], historic: [], proposals: [] },
        kbStats(ctx),
      ])
      sendJson(res, 200, {
        ok: true,
        route: panel.route,
        enabled: snapshot.enabled !== false,
        state: snapshot.state ?? null,
        counts: {
          live: snapshot.live.length,
          historic: snapshot.historic.length,
          pendingProposals: (snapshot.proposals ?? []).filter(item => item.status === 'pending').length,
          candidates: kb.candidates,
        },
        kb,
        env: await panel.cluster.env(),
      })
      return
    }
    // 手动开单：管理员在没有客服会话时也能建一个工单自测或补录。
    if (method === 'POST' && suffix === '/dispatch') {
      const dispatcher = dispatcherOf(ctx)
      if (dispatcher === undefined) return sendJson(res, 503, { ok: false, error: '运维调度器未加载' })
      const body = await readJson(req)
      if (typeof body?.requesterSessionId !== 'string' || body.requesterSessionId === '') {
        return sendJson(res, 400, { ok: false, error: '需要 requesterSessionId：结论会回执到这个会话' })
      }
      return sendJson(res, 202, { ok: true, ...(await dispatcher.dispatch({ requesterSessionId: body.requesterSessionId, task: body.task ?? {} })) })
    }
    if (method === 'GET' && (suffix === '/incidents' || suffix === '/sessions')) {
      const dispatcher = dispatcherOf(ctx)
      if (dispatcher === undefined) return sendJson(res, 503, { ok: false, error: '运维调度器未加载' })
      const query = url.searchParams.get('q') ?? ''
      const withArchived = url.searchParams.get('archived') === '1'
      const snapshot = await dispatcher.snapshot()
      // 同一个工单可能同时在内存（刚跑完）和台账里，按 id 去重，内存优先。
      const liveAll = snapshot.live ?? []
      const seen = new Set(liveAll.map(item => item.incidentId))
      const merged = [...liveAll, ...(snapshot.historic ?? []).filter(item => !seen.has(item.incidentId))]
      const matched = merged.filter(item => incidentMatches(item, query))
      const visible = matched.filter(item => withArchived || item.archived !== true)
      const live = visible.filter(item => liveAll.some(record => record.incidentId === item.incidentId))
      const historic = visible.filter(item => !liveAll.some(record => record.incidentId === item.incidentId))
      sendJson(res, 200, {
        ok: true,
        query,
        live,
        historic,
        archivedCount: matched.filter(item => item.archived === true).length,
        counts: {
          live: live.length,
          historic: historic.length,
          archived: matched.filter(item => item.archived === true).length,
          total: merged.length,
        },
        proposals: snapshot.proposals,
        enabled: snapshot.enabled,
        state: snapshot.state,
        timeoutMs: snapshot.timeoutMs,
        ledger: snapshot.ledger,
      })
      return
    }
    if (method === 'GET' && suffix === '/proposals') {
      const dispatcher = dispatcherOf(ctx)
      if (dispatcher === undefined) return sendJson(res, 503, { ok: false, error: '运维调度器未加载' })
      sendJson(res, 200, { ok: true, proposals: dispatcher.listProposals() })
      return
    }
    const archive = /^\/incidents\/([^/]+)\/archive$/.exec(suffix)
    if (method === 'POST' && archive !== null) {
      const dispatcher = dispatcherOf(ctx)
      if (dispatcher === undefined) return sendJson(res, 503, { ok: false, error: '运维调度器未加载' })
      if (typeof dispatcher.setArchived !== 'function') return sendJson(res, 501, { ok: false, error: '这个调度器版本没有归档接口' })
      const body = await readJson(req)
      const result = await dispatcher.setArchived(decodeURIComponent(archive[1]), body?.archived !== false, {
        by: body?.by ?? 'admin',
        note: body?.note ?? '',
      })
      return sendJson(res, result.ok ? 200 : 400, result)
    }
    const remove = /^\/incidents\/([^/]+)\/delete$/.exec(suffix)
    if (method === 'POST' && remove !== null) {
      const dispatcher = dispatcherOf(ctx)
      if (dispatcher === undefined) return sendJson(res, 503, { ok: false, error: '运维调度器未加载' })
      if (typeof dispatcher.removeIncident !== 'function') return sendJson(res, 501, { ok: false, error: '这个调度器版本没有删除接口' })
      const body = await readJson(req)
      const result = await dispatcher.removeIncident(decodeURIComponent(remove[1]), { by: body?.by ?? 'admin' })
      return sendJson(res, result.ok ? 200 : 400, result)
    }
    const resume = /^\/incidents\/([^/]+)\/resume$/.exec(suffix)
    if (method === 'POST' && resume !== null) {
      const dispatcher = dispatcherOf(ctx)
      if (dispatcher === undefined) return sendJson(res, 503, { ok: false, error: '运维调度器未加载' })
      const body = await readJson(req)
      const result = await dispatcher.resume(decodeURIComponent(resume[1]), body?.note)
      return sendJson(res, result.ok ? 200 : 400, result)
    }
    const decide = /^\/proposals\/([^/]+)\/(approve|reject)$/.exec(suffix)
    if (method === 'POST' && decide !== null) {
      const dispatcher = dispatcherOf(ctx)
      if (dispatcher === undefined) return sendJson(res, 503, { ok: false, error: '运维调度器未加载' })
      const body = await readJson(req)
      const id = decodeURIComponent(decide[1])
      const result = decide[2] === 'approve'
        ? await dispatcher.approveChange(id, { by: body?.by ?? 'admin', note: body?.note ?? '' })
        : await dispatcher.rejectChange(id, { by: body?.by ?? 'admin', note: body?.note ?? '' })
      return sendJson(res, result.ok ? 200 : 400, result)
    }
    if (method === 'GET' && suffix === '/kb/candidates') {
      const store = kbStoreOf(ctx)
      if (store === undefined) return sendJson(res, 503, { ok: false, error: '知识库服务未加载' })
      const [candidates, stats] = await Promise.all([store.candidates(), store.stats()])
      return sendJson(res, 200, { ok: true, candidates, stats })
    }
    const kbReview = /^\/kb\/candidates\/([^/]+)\/(verify|reject)$/.exec(suffix)
    if (method === 'POST' && kbReview !== null) {
      const store = kbStoreOf(ctx)
      if (store === undefined) return sendJson(res, 503, { ok: false, error: '知识库服务未加载' })
      const body = await readJson(req)
      const id = decodeURIComponent(kbReview[1])
      const result = kbReview[2] === 'verify'
        ? await store.verify(id, { audience: body?.audience, reviewer: body?.by ?? 'admin' })
        : await store.reject(id, { reason: body?.note ?? '' })
      return sendJson(res, result.ok ? 200 : 400, result)
    }
    sendJson(res, 404, { ok: false, error: `没有这个接口：${method} ${suffix}` })
  } catch (error) {
    sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
  }
}

/** Resolve the dispatcher, tolerating a composition without the ops package. */
function dispatcherOf(ctx) {
  return ctx.get?.('opsDispatch')
}

/** Resolve the knowledge base. */
function kbStoreOf(ctx) {
  return ctx.get?.('kbStore')
}

/** Candidate count, or zero when the shared package is absent. */
async function kbStats(ctx) {
  const store = kbStoreOf(ctx)
  if (store === undefined) return { shared: 0, internal: 0, candidates: 0 }
  try {
    return await store.stats()
  } catch {
    return { shared: 0, internal: 0, candidates: 0 }
  }
}

/** Normalize the route prefix. */
function normalizeRoute(value) {
  const text = String(value).trim()
  if (!text.startsWith('/')) throw new Error('ops-panel: route must start with "/"')
  return text.replace(/\/+$/, '')
}

/** Read and parse a JSON body. */
async function readJson(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 64 * 1024) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text === '') return {}
  return JSON.parse(text)
}

/** Send a JSON response. */
function sendJson(res, status, body) {
  send(res, status, JSON.stringify(body), 'application/json; charset=utf-8')
}

/** Send a full response. */
function send(res, status, body, contentType) {
  res.writeHead(status, { 'content-type': contentType, 'cache-control': 'no-store' })
  res.end(body)
}

/** The panel document. */
function html(route) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>运维控制台</title>
<style>
  :root { color-scheme: light; --bg:#ffffff; --panel:#f6f8fa; --line:#e2e6ec; --text:#1b1f24; --dim:#68707d;
          --ok:#1a7f4b; --warn:#a86200; --bad:#c62839; --accent:#1f6feb; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font:14px/1.55 -apple-system,"SF Pro Text",Segoe UI,sans-serif; }
  header { display:flex; gap:16px; align-items:baseline; padding:18px 24px; border-bottom:1px solid var(--line); }
  h1 { font-size:16px; margin:0; font-weight:600; }
  .muted { color:var(--dim); }
  .stats { display:flex; gap:22px; padding:14px 24px; border-bottom:1px solid var(--line); flex-wrap:wrap; }
  .stat b { display:block; font-size:20px; }
  .layout { display:grid; grid-template-columns: 420px 1fr; min-height: calc(100vh - 120px); }
  .sidebar { border-right:1px solid var(--line); display:flex; flex-direction:column; min-height:0; }
  .listbar { display:flex; gap:8px; align-items:center; padding:10px 12px; border-bottom:1px solid var(--line); background:var(--panel); }
  .listbar input[type=text] { flex:1; width:auto; padding:6px 9px; font-size:13px; }
  .listbar label { display:flex; align-items:center; gap:4px; font-size:12px; color:var(--dim); white-space:nowrap; }
  .listbar input[type=checkbox] { width:auto; }
  .list { overflow:auto; flex:1; }
  .row.archived { opacity:.62; }
  .detail { padding:20px 24px; overflow:auto; }
  .row { padding:12px 16px; border-bottom:1px solid var(--line); cursor:pointer; display:flex; gap:10px; align-items:flex-start; }
  .row .main { flex:1; min-width:0; }
  .row .ops-actions { flex:none; display:flex; flex-direction:column; gap:4px; }
  button.mini { padding:2px 8px; font-size:11px; border-radius:6px; line-height:1.5; }
  .row:hover, .row.active { background:var(--panel); }
  .row .id { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px; color:var(--dim); }
  .row .sym { margin:2px 0; }
  .pill { display:inline-block; padding:1px 8px; border-radius:999px; font-size:11px; border:1px solid var(--line); }
  .running,.diagnosing { color:var(--accent); border-color:var(--accent); }
  .resolved { color:var(--ok); border-color:var(--ok); }
  .needs_human,.not_found,.blocked,.timeout { color:var(--bad); border-color:var(--bad); }
  .need_info,.waiting_info,.pending,.mitigated { color:var(--warn); border-color:var(--warn); }
  section { margin-bottom:26px; }
  h2 { font-size:13px; text-transform:uppercase; letter-spacing:.06em; color:var(--dim); margin:0 0 10px; }
  pre { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:12px; overflow:auto; white-space:pre-wrap; }
  button { background:var(--panel); color:var(--text); border:1px solid var(--line); border-radius:8px; padding:6px 12px; cursor:pointer; font-size:13px; }
  button.primary { border-color:var(--ok); color:var(--ok); }
  button.danger { border-color:var(--bad); color:var(--bad); }
  button:hover:not(:disabled) { background:#eef1f5; }
  button:disabled { opacity:.45; cursor:not-allowed; }
  a.link { color:var(--accent); text-decoration:none; }
  a.link:hover { text-decoration:underline; }
  .switch { display:flex; align-items:center; gap:10px; margin-left:auto; }
  .badge-on { color:var(--ok); border-color:var(--ok); }
  .badge-off { color:var(--bad); border-color:var(--bad); }
  input, textarea { width:100%; background:var(--panel); color:var(--text); border:1px solid var(--line); border-radius:8px; padding:8px 10px; font:inherit; }
  .actions { display:flex; gap:8px; margin-top:10px; flex-wrap:wrap; }
  .card { border:1px solid var(--line); border-radius:10px; padding:14px; margin-bottom:12px; background:var(--panel); }
  .empty { padding:24px; color:var(--dim); }
  .tabs { display:flex; gap:8px; padding:12px 24px; border-bottom:1px solid var(--line); }
  .tabs button.on { border-color:var(--accent); color:var(--accent); }
</style>
</head>
<body>
<header>
  <h1>运维控制台</h1>
  <span class="muted" id="env">自检中…</span>
  <span class="switch">
    <span class="pill" id="state">—</span>
    <button id="toggle">切换</button>
  </span>
</header>
<div class="tabs">
  <button data-tab="incidents" class="on">工单</button>
  <button data-tab="proposals">变更审批</button>
  <button data-tab="kb">知识库候选</button>
</div>
<div class="stats" id="stats"></div>
<div class="layout">
  <div class="sidebar">
    <div class="listbar">
      <input id="q" type="text" placeholder="搜索工单号 / 会话 id / 现象" autocomplete="off">
      <label><input id="showArchived" type="checkbox"> 含归档</label>
      <span class="muted" id="hits"></span>
    </div>
    <div class="list" id="list"></div>
  </div>
  <div class="detail" id="detail"><div class="empty">选择左侧一项。</div></div>
</div>
<script>
const ROUTE = ${JSON.stringify(route)};
let tab = 'incidents';
let selected = null;
let cache = { incidents: null, proposals: null, board: null };
let enabled = true;
let stateInfo = null;

// 面板是独立窗口，本身不能切换 Web UI 的当前会话；深链交给客户端插件处理：
// /?opsSession=<id> 会被 @local/dsh-ops-agent/client.js 捕获并打开对应会话。
function sessionUrl(sessionId) {
  return '/?opsSession=' + encodeURIComponent(sessionId);
}
function openSession(sessionId) {
  if (!sessionId) return;
  window.open(sessionUrl(sessionId), '_blank', 'noopener');
}

const el = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"]/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[ch]));

async function api(path, body) {
  const response = await fetch(ROUTE + path, body === undefined ? {} : {
    method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify(body),
  });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { ok:false, error:text.slice(0,300) }; }
  if (!response.ok && data.ok !== false) data = { ok:false, error:'HTTP ' + response.status };
  return data;
}

function pill(state) { return '<span class="pill ' + esc(state) + '">' + esc(state) + '</span>'; }

function renderSwitch() {
  const node = el('state');
  if (node === null) return;
  node.textContent = enabled ? '协同开启' : '协同关闭·客服独立';
  node.className = 'pill ' + (enabled ? 'badge-on' : 'badge-off');
  node.title = stateInfo?.changedAt ? esc(stateInfo.changedBy || '') + ' ' + esc(stateInfo.changedAt) : '';
  const button = el('toggle');
  if (button !== null) {
    button.textContent = enabled ? '关闭协同' : '开启协同';
    button.className = enabled ? 'danger' : 'primary';
    button.disabled = false;
  }
}

async function toggleEnabled() {
  const button = el('toggle');
  const next = !enabled;
  const question = next
    ? '开启运维协同？客服遇到需要查集群的问题可以直接转运维。'
    : '关闭运维协同？客服将独立处理所有工单，已在运行的运维工单不受影响。';
  if (!window.confirm(question)) return;
  if (button !== null) button.disabled = true;
  const data = await api(next ? '/enable' : '/disable', { by: 'admin' });
  if (data.ok !== true) alert(data.error ?? '切换失败');
  await refresh();
}

async function refresh() {
  const status = await api('/status');
  if (status.ok) {
    enabled = status.enabled !== false;
    stateInfo = status.state ?? null;
    renderSwitch();
    el('env').textContent = status.env.ok ? '只读通道正常' : '只读通道不可用：' + (status.env.checks.find(c => !c.ok)?.detail ?? '');
    const counts = status.counts ?? {};
    el('stats').innerHTML = [
      ['进行中', counts.live ?? 0], ['历史', counts.historic ?? 0],
      ['待批准变更', counts.pendingProposals ?? 0], ['知识库候选', counts.candidates ?? 0],
      ['知识库条目', (status.kb.shared ?? 0) + ' + ' + (status.kb.internal ?? 0) + ' 内部'],
    ].map(([label, value]) => '<div class="stat"><b>' + esc(value) + '</b><span class="muted">' + esc(label) + '</span></div>').join('');
  }
  if (tab === 'incidents') {
    const q = el('q').value.trim();
    const data = await api('/incidents?q=' + encodeURIComponent(q) + (el('showArchived').checked ? '&archived=1' : ''));
    cache.incidents = data;
    cache.board = data.ok ? [...(data.live ?? []), ...(data.historic ?? []).filter(h => !(data.live ?? []).some(l => l.incidentId === h.incidentId))] : [];
    if (data.ok) {
      const shown = cache.board.length;
      const total = data.counts?.total ?? shown;
      el('hits').textContent = q === '' ? shown + ' / ' + total : shown + ' 命中 / ' + total;
    }
    renderList();
  } else if (tab === 'proposals') {
    const data = await api('/proposals');
    cache.proposals = data.proposals ?? [];
    renderProposals();
  } else {
    const data = await api('/kb/candidates');
    cache.candidates = data.candidates ?? [];
    cache.kbStats = data.stats;
    renderCandidates();
  }
}

async function archiveIncident(incidentId, archived) {
  const data = await api('/incidents/' + encodeURIComponent(incidentId) + '/archive', { archived, by: 'admin' });
  if (!data.ok) { alert(data.reason ?? data.error ?? '失败'); return; }
  // 归档后默认看板里就看不到它了：别把详情留在一条已经消失的工单上。
  if (archived && !el('showArchived').checked && selected === incidentId) selected = null;
  await refresh();
}

async function deleteIncident(incidentId) {
  if (!window.confirm('删除工单 ' + incidentId + '？\\n\\n看板记录会消失，两个会话会从工作区摘掉；对话内容本身不删。')) return;
  const data = await api('/incidents/' + encodeURIComponent(incidentId) + '/delete', { by: 'admin' });
  if (!data.ok) { alert(data.reason ?? data.error ?? '失败'); return; }
  if (selected === incidentId) selected = null;
  await refresh();
}

function renderList() {
  const items = cache.board ?? [];
  if (items.length === 0) { el('list').innerHTML = '<div class="empty">还没有工单。</div>'; return; }
  el('list').innerHTML = items.map(item => {
    const sym = item.task?.symptom ?? item.result?.diagnosis ?? '';
    return '<div class="row' + (selected === item.incidentId ? ' active' : '') + (item.archived ? ' archived' : '') + '" data-id="' + esc(item.incidentId) + '">'
      + '<div class="main">'
      + '<div class="id">' + esc(item.incidentId) + ' ' + pill(item.state ?? 'unknown')
      + (item.archived ? ' <span class="pill">已归档</span>' : '') + '</div>'
      + '<div class="sym">' + esc(sym).slice(0, 140) + '</div>'
      + '<div class="muted">' + esc(item.startedAt ?? '') + '</div>'
      + '<div style="margin-top:4px;font-size:12px">'
      + (item.requesterSessionId ? '<a class="link" href="#" data-open="' + esc(item.requesterSessionId) + '">客服对话</a> ' : '')
      + (item.opsSessionId ? '<a class="link" href="#" data-open="' + esc(item.opsSessionId) + '">运维对话</a>' : '')
      + '</div></div>'
      + '<div class="ops-actions">'
      + '<button class="mini" data-archive="' + esc(item.incidentId) + '" data-next="' + (item.archived ? '0' : '1') + '">'
      + (item.archived ? '取消归档' : '归档') + '</button>'
      + '<button class="mini danger" data-del="' + esc(item.incidentId) + '">删除</button>'
      + '</div></div>';
  }).join('');
  for (const row of el('list').querySelectorAll('.row')) {
    row.onclick = () => { selected = row.dataset.id; renderList(); renderIncident(); };
  }
  // 行内的跳转链接不能同时触发选中。
  for (const node of el('list').querySelectorAll('[data-open]')) {
    node.onclick = event => { event.preventDefault(); event.stopPropagation(); openSession(node.dataset.open); };
  }
  // 行内的归档/删除同理：点按钮不要顺手把这一行选中。
  for (const node of el('list').querySelectorAll('[data-archive]')) {
    node.onclick = event => {
      event.preventDefault();
      event.stopPropagation();
      void archiveIncident(node.dataset.archive, node.dataset.next === '1');
    };
  }
  for (const node of el('list').querySelectorAll('[data-del]')) {
    node.onclick = event => {
      event.preventDefault();
      event.stopPropagation();
      void deleteIncident(node.dataset.del);
    };
  }
  if (selected !== null) renderIncident();
}

function renderIncident() {
  const item = (cache.board ?? []).find(entry => entry.incidentId === selected);
  if (item === undefined) { el('detail').innerHTML = '<div class="empty">选择左侧一项。</div>'; return; }
  const result = item.result;
  const evidence = (result?.evidence ?? []).map(e => typeof e === 'string' ? e : '[' + (e.source ?? '?') + '] ' + (e.detail ?? ''));
  el('detail').innerHTML =
    '<section><h2>工单</h2>'
    + '<div class="card"><b>' + esc(item.incidentId) + '</b> ' + pill(item.state ?? 'unknown')
    + '<div class="muted" style="margin-top:6px">现象：' + esc(item.task?.symptom ?? '') + '</div>'
    + '<div class="muted">开始：' + esc(item.startedAt ?? '') + (item.finishedAt ? ' · 结束：' + esc(item.finishedAt) : '') + '</div>'
    + '</div></section>'
    + '<section><h2>会话定位</h2><div class="card">'
    + '<div class="muted">客服会话：' + esc(item.requesterSessionId || '（未记录）') + '</div>'
    + '<div class="actions">'
    + (item.requesterSessionId
        ? '<button class="primary" data-open="' + esc(item.requesterSessionId) + '">打开客服会话</button>'
          + '<button data-copy="' + esc(item.requesterSessionId) + '">复制 ID</button>'
        : '')
    + '</div>'
    + '<div class="muted" style="margin-top:10px">运维会话：' + esc(item.opsSessionId || '（未记录）') + '</div>'
    + '<div class="actions">'
    + (item.opsSessionId
        ? '<button class="primary" data-open="' + esc(item.opsSessionId) + '">打开运维会话</button>'
          + '<button data-copy="' + esc(item.opsSessionId) + '">复制 ID</button>'
        : '')
    + '</div>'
    + '<div class="muted" style="margin-top:8px">「打开」会在新标签页里定位到那个对话（需要 Web UI 里装了本插件）。</div>'
    + '</div></section>'
    + (result === null || result === undefined ? '' :
      '<section><h2>结论</h2><div class="card">'
      + '<div>诊断：' + esc(result.diagnosis ?? '') + '</div>'
      + (result.severity ? '<div class="muted">级别：' + esc(result.severity) + ' · 置信度：' + esc(result.confidence ?? '') + '</div>' : '')
      + (evidence.length ? '<div style="margin-top:8px">证据：</div><pre>' + esc(evidence.join('\\n')) + '</pre>' : '')
      + (result.verification ? '<div class="muted">验证：' + esc(result.verification) + '</div>' : '')
      + (result.customer_summary ? '<div style="margin-top:8px">对客说明：' + esc(result.customer_summary) + '</div>' : '')
      + '</div></section>')
    + '<section><h2>补充信息</h2><div class="card"><textarea id="note" rows="3" placeholder="客户补充的信息…"></textarea>'
    + '<div class="actions"><button class="primary" id="resume">补发给运维</button></div></div></section>'
    + '<section><h2>整理</h2><div class="card">'
    + '<div class="muted">归档只是从看板收起来，台账和对话都留着；删除会把两个会话从工作区摘掉，并让这张单离开看板（会话文件交给 retention 脚本清理）。</div>'
    + '<div class="actions">'
    + '<button id="archive">' + (item.archived ? '取消归档' : '归档') + '</button>'
    + '<button class="danger" id="del">删除</button>'
    + '</div></div></section>';
  for (const node of el('detail').querySelectorAll('[data-open]')) {
    node.onclick = () => openSession(node.dataset.open);
  }
  for (const node of el('detail').querySelectorAll('[data-copy]')) {
    node.onclick = async () => {
      const text = node.dataset.copy;
      try {
        await navigator.clipboard.writeText(text);
        const label = node.textContent;
        node.textContent = '已复制';
        setTimeout(() => { node.textContent = label; }, 1200);
      } catch { window.prompt('复制这个 ID：', text); }
    };
  }
  const resume = el('resume');
  if (resume !== null) {
    resume.onclick = async () => {
      const note = el('note').value.trim();
      if (note === '') return;
      resume.disabled = true;
      const data = await api('/incidents/' + encodeURIComponent(selected) + '/resume', { note });
      resume.disabled = false;
      if (!data.ok) alert(data.reason ?? data.error ?? '失败');
      refresh();
    };
  }
  const archive = el('archive');
  if (archive !== null) {
    archive.onclick = () => { void archiveIncident(item.incidentId, !item.archived); };
  }
  const del = el('del');
  if (del !== null) {
    del.onclick = () => { void deleteIncident(item.incidentId); };
  }
}

function renderProposals() {
  const items = cache.proposals ?? [];
  if (items.length === 0) { el('list').innerHTML = '<div class="empty">没有变更提案。</div>'; el('detail').innerHTML = ''; return; }
  el('list').innerHTML = items.map(item => '<div class="row' + (selected === item.id ? ' active' : '') + '" data-id="' + esc(item.id) + '">'
    + '<div class="id">' + esc(item.id) + ' ' + pill(item.status) + '</div>'
    + '<div class="sym">' + esc(item.action) + '</div>'
    + '<div class="muted">' + esc(item.incidentId) + '</div></div>').join('');
  for (const row of el('list').querySelectorAll('.row')) {
    row.onclick = () => { selected = row.dataset.id; renderProposals(); renderProposal(); };
  }
  renderProposal();
}

function renderProposal() {
  const item = (cache.proposals ?? []).find(entry => entry.id === selected);
  if (item === undefined) { el('detail').innerHTML = '<div class="empty">选择左侧一项。</div>'; return; }
  const pending = item.status === 'pending';
  el('detail').innerHTML = '<section><h2>变更提案</h2><div class="card">'
    + '<div><b>' + esc(item.id) + '</b> ' + pill(item.status) + '</div>'
    + '<div class="muted">工单 ' + esc(item.incidentId) + ' · 发起 ' + esc(item.requestedAt) + '</div>'
    + '<div style="margin-top:10px"><b>动作</b>：' + esc(item.action) + '</div>'
    + '<div><b>对象</b>：' + esc(item.target) + '</div>'
    + (item.command ? '<div style="margin-top:8px"><b>命令</b></div><pre>' + esc(item.command) + '</pre>' : '')
    + '<div><b>影响</b>：' + esc(item.impact) + '</div>'
    + '<div><b>回滚</b>：' + esc(item.rollback) + '</div>'
    + '<div><b>验证</b>：' + esc(item.verify) + '</div>'
    + (item.decidedAt ? '<div class="muted" style="margin-top:6px">' + esc(item.status) + ' 于 ' + esc(item.decidedAt) + ' by ' + esc(item.decidedBy) + '</div>' : '')
    + '</div></section>'
    + '<section><h2>审批</h2><div class="card"><input id="decider" placeholder="审批人（默认 admin）">'
    + '<textarea id="decision-note" rows="2" style="margin-top:8px" placeholder="备注（可选）"></textarea>'
    + '<div class="actions"><button class="primary" id="approve"' + (pending ? '' : ' disabled') + '>批准</button>'
    + '<button class="danger" id="reject"' + (pending ? '' : ' disabled') + '>拒绝</button></div>'
    + '<div class="muted" style="margin-top:8px">批准只代表同意方案；本版本不会自动执行，管理员按命令手动操作。</div>'
    + '</div></section>';
  const decide = async (action) => {
    const by = el('decider').value.trim() || 'admin';
    const note = el('decision-note').value.trim();
    const data = await api('/proposals/' + encodeURIComponent(selected) + '/' + action, { by, note });
    if (!data.ok) alert(data.reason ?? data.error ?? '失败');
    await refresh();
  };
  el('approve').onclick = () => decide('approve');
  el('reject').onclick = () => decide('reject');
}

function renderCandidates() {
  const items = cache.candidates ?? [];
  if (items.length === 0) { el('list').innerHTML = '<div class="empty">没有待审核的候选条目。</div>'; el('detail').innerHTML = ''; return; }
  el('list').innerHTML = items.map(item => '<div class="row' + (selected === item.id ? ' active' : '') + '" data-id="' + esc(item.id) + '">'
    + '<div class="id">' + esc(item.id) + ' ' + pill(item.audience) + '</div>'
    + '<div class="sym">' + esc(item.title) + '</div>'
    + '<div class="muted">' + esc(item.proposedAt ?? '') + '</div></div>').join('');
  for (const row of el('list').querySelectorAll('.row')) {
    row.onclick = () => { selected = row.dataset.id; renderCandidates(); renderCandidate(); };
  }
  renderCandidate();
}

function renderCandidate() {
  const item = (cache.candidates ?? []).find(entry => entry.id === selected);
  if (item === undefined) { el('detail').innerHTML = '<div class="empty">选择左侧一项。</div>'; return; }
  el('detail').innerHTML = '<section><h2>候选条目</h2><div class="card">'
    + '<div><b>' + esc(item.title) + '</b> ' + pill(item.audience) + '</div>'
    + '<div class="muted">来源：' + esc(item.source ?? '') + (item.incidentId ? ' · 工单 ' + esc(item.incidentId) : '') + '</div>'
    + '<div style="margin-top:10px"><b>现象</b>：' + esc(item.symptom) + '</div>'
    + '<div><b>根因</b>：' + esc(item.rootCause) + '</div>'
    + '<div><b>处置</b>：</div><pre>' + esc(item.resolution) + '</pre>'
    + '<div><b>验证</b>：' + esc(item.verification) + '</div>'
    + '<div><b>错误特征</b>：' + esc((item.errorSignatures ?? []).join(' | ')) + '</div>'
    + (item.customerReply ? '<div style="margin-top:8px"><b>对客回复</b>：' + esc(item.customerReply) + '</div>' : '')
    + '</div></section>'
    + '<section><h2>审核</h2><div class="card">'
    + '<div class="actions"><button class="primary" id="verify">通过（进入检索）</button>'
    + '<button class="danger" id="drop">丢弃</button></div></div></section>';
  el('verify').onclick = async () => {
    const data = await api('/kb/candidates/' + encodeURIComponent(selected) + '/verify', { audience: item.audience });
    if (!data.ok) alert(data.reason ?? data.error ?? '失败');
    selected = null;
    await refresh();
  };
  el('drop').onclick = async () => {
    const data = await api('/kb/candidates/' + encodeURIComponent(selected) + '/reject', { note: '面板丢弃' });
    if (!data.ok) alert(data.reason ?? data.error ?? '失败');
    selected = null;
    await refresh();
  };
}

el('toggle').onclick = toggleEnabled;

// 搜索是本地输入 + 服务端过滤：输入停下 250ms 再查，避免每敲一个字打一次接口。
let searchTimer = null;
function scheduleSearch() {
  if (searchTimer !== null) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { if (tab === 'incidents') refresh(); }, 250);
}
el('q').oninput = scheduleSearch;
el('q').onkeydown = event => {
  if (event.key === 'Escape') { el('q').value = ''; refresh(); }
};
el('showArchived').onchange = () => { if (tab === 'incidents') refresh(); };

for (const button of document.querySelectorAll('.tabs button')) {
  button.onclick = () => {
    tab = button.dataset.tab;
    selected = null;
    for (const other of document.querySelectorAll('.tabs button')) other.classList.toggle('on', other === button);
    el('list').innerHTML = '';
    el('detail').innerHTML = '<div class="empty">加载中…</div>';
    refresh();
  };
}

refresh();
setInterval(refresh, 5000);
</script>
</body>
</html>`
}
