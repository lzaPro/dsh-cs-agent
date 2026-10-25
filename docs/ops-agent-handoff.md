# 运维 agent：交接说明

给新会话用。读完这份就能接着干，不需要翻客服那摊历史。

**状态（2026-10-24 16:50）**：运维插件已从「只有骨架」升级为「有手也有门」，并且**已在一个真实运行的 dsh 进程里端到端跑通**：只读集群工具、内部 runbook、变更提案审批、控制面板全部在线上加载；`check-ops-live` 10 项全 PASS；真实派单 `INC-20261024085018-d5qa` 让运维 agent 依次调用 `ops_env`/`ops_k8s`/`ops_metrics`/`kb_search`，在缺 kubeconfig 时按协议返回 `needs_human` + 四条 evidence + 两个 `need_from_customer`，台账完整落库。

仍然缺的是**输入**而不是代码：只读 kubeconfig（没有它只能靠知识库）、指标数据源（`prometheusUrl` 或 grafana）。另外 `scripts/restart-dsh.sh` 的三处缺陷（nohup 不换进程组、脚本自身未脱离、pnpm 靠 PATH）已修，机制层验证过，但**还没有再跑一次真实重启来实测它**。

## 链路与边界

- 客户 → 客服 agent →（可选）运维 agent → 客服 → 客户。
- 运维 agent **只和管理员、客服 agent 对话**，禁止用户直连。
- 客服不确定时调 `ops_handoff` 派单；运维给出结论后回传给客服，客服再回用户。
- 运维**只读**诊断；要改配置只能提提案，由管理员批准后人工执行。

**这条边界靠组合实现，不是运行期 ACL**：`ops_handoff` 只注册在 `service-desk` 预设里，所以只有客服能派单；运维会话没有渠道工具，也没有回复客户的工具，唯一外发路径是派单器回执给客服 + `notify_admin`。管理员有两个入口：面板 `POST /ops/dispatch`（只监听 127.0.0.1），或直接在 GUI 打开「运维」会话插话。

管理员插话会引出一个取舍：运维每回合结束默认都会回执（`relayEveryTurn: true`），管理员随口一问也会被当成结论。配 `relayEveryTurn: false` 后改成只认结论 JSON 块，没块的回合只记台账 `kind:"turn"`，工单维持 running。

## 包结构（四个包，各自独立）

| 包 | 目录 | 内容 |
| --- | --- | --- |
| `@local/dsh-kb` | `kb-core/` | 共享知识库服务 `kbStore` + `kb_search`/`kb_get`/`kb_propose`；客服与运维共用 |
| `@local/dsh-ops-agent` | `ops-agent/` | 派单器、只读集群工具、运维预设、控制面板、Web UI 插件 |
| `@local/dsh-cs-agent` | `cs-agent/` | 渠道网关、OCR、客服预设、`ops_handoff` |
| `@local/dsh-cs-panel` | `cs-panel/` | 客服设置页与侧栏标记 |

`cs-ops/` 已退役（移到 `/tmp`），不要复活它——会形成两套运维实现。

## 两个契约（改了一边必须改另一边）

```js
// 客服 → 运维：派单（cs-agent/handoff.js）
const dispatcher = ctx.get?.('opsDispatch')        // 未装 → 工具报「运维插件未安装：请先安装 @local/dsh-ops-agent」
await dispatcher.dispatch({ requesterSessionId, task })

// 运维 → 客服：派单器把回执作为新消息投进发起会话
agent.followup({ ... source: { kind: 'ops-result', form: 'relay' } })
```

`requesterSessionId` 必须取 `exec.agent?.session?.id`——**Agent 上没有 `id`**（旧代码这里是 bug，已修）。

## 文件地图

| 文件 | 作用 |
| --- | --- |
| `ops-agent/dispatcher.js` | `dispatch` / `resume` / `askRequester` / `proposeChange` / `approveChange` / `rejectChange` / `snapshot`；台账 `data/ops-ledger.jsonl` |
| `ops-agent/cluster.js` | `ops_env` / `ops_k8s` / `ops_logs`；动词白名单、`secrets` 永久拒绝、命名空间白名单、无 shell |
| `ops-agent/metrics.js` | `ops_metrics`；只打两个固定端点，未配置时明确返回「未配置」 |
| `ops-agent/task-tools.js` | `ops_task`：`set_status` / `ask_requester` / `escalate` / `propose_change` |
| `ops-agent/panel.js` | `/ops/panel` 页面与 `/ops/*` JSON 接口 |
| `ops-agent/client.js` | Web UI：设置页「运维」、会话标题栏「待批 N」、侧栏「运」 |
| `ops-agent/cordis.patch.yml` | `ops-dispatch`、`ops-panel`、`preset-ops` 三行 |
| `kb-core/index.js` | `kbStore`：两级门控（`ops-kb/` 目录 + 条目 `audience`） |
| `kb-core/tools.js` | 三个 KB 工具的装配（`config.role` 固定身份，不信任调用方自报） |
| `ops-kb/` | 内部 runbook：`evidence-checklist-crashloop`、`change-approval-workflow` |

## 结论协议（运维最后一条消息的 json 代码块）

```json
{ "status": "resolved | needs_human | need_info | not_found", "severity": "P0-P3", "confidence": "high|medium|low",
  "diagnosis": "", "evidence": [{ "source": "k8s|log|metric|kb", "detail": "查了什么看到什么" }],
  "actions_taken": [], "verification": "", "customer_summary": "", "need_from_customer": [],
  "proposed_change": { "action": "", "target": "", "command": "", "impact": "", "rollback": "", "verify": "" } }
```

- 没有代码块 / JSON 坏 / status 不认识 → 一律 `needs_human`，原文截断交给管理员。
- `need_info` 不结束工单：客服调 `dispatcher.resume(incidentId, note)`，答案回到**同一个**运维会话。
- `needs_human` / `not_found` / 超时 / 待批准提案 → 通知管理员（`adminId` 为空时只写台账）。

## 关键决策与理由

1. **运维单独一个包**：客服进程里根本没有 `ops_k8s`，比在提示词里写十遍「不要查集群」可靠。
2. **拿掉 bash**：有 bash 就能用一条 `kubectl delete` 绕过白名单和审批。
3. **v1 不自动执行写操作**：批准只代表同意方案，命令由管理员手动跑；自动执行需要「执行器 + 回滚 + 审计」，不能草率加。
4. **审批不复用 `ctx.approval`**：那个服务要求请求发生在打开的 turn 内，而工单是跨会话、由面板批的；自己用 ledger 记 `decidedAt`/`decidedBy`。
5. **共享 kb + 独立 ops-kb**：客服要「怎么答客户」，运维要「内部怎么修」；用目录 + `audience` 两级门控，而不是靠自觉。
6. **候选必须人工审核**：一个 agent 的猜测不能变成另一个 agent 的「事实」。

## 验证

```bash
./scripts/verify-all.sh             # 16 段：静态 + apply 装配 + 全部 smoke，最后 all checks passed
node ops-agent/smoke.mjs            # 47 项：派单/回执/台账/提案/续接/脱敏/白名单/面板路由
node scripts/check-plugin-apply.mjs # 真调 apply()：服务 provide、工具 register、路由前缀、effect 清理
node scripts/check-ops-live.mjs     # 打运行中进程的真实接口；404 = 这个进程没重启
./scripts/restart-dsh.sh --yes      # 重启 dsh（pgrep 找旧进程 → nohup 重启 → 等 /ops/status 变 200）
```

`verify-all.sh` 只证明代码没问题；**「装好了」和「这个进程里装好了」是两件事**，后者只能靠 `check-ops-live.mjs`。

## 现在的缺口（下一步）

1. **只读 kubeconfig 还没有**（`~/.kube` 不存在）。`ops_env` 会如实报错，运维只能靠知识库 + 工单描述工作。
   支持多集群：`ops_env` 会列出 kubeconfig 里的 context，`ops_k8s`/`ops_logs` 用 `context` 参数切换（可用 `contexts` 配白名单，例如只允许 prod）。
   - 选项 A：用户提供只读 kubeconfig，放 `~/.kube/config` 或改 `ops-cluster.kubeconfig`
   - 选项 B：改用 Rancher API 的只读 token 实现 `ops_k8s`（工作量更大）
2. ~~预设挂载未验证~~ **已端到端跑通**（2026-10-24 16:50）：`POST /ops/dispatch` → `preset-ops` 挂载成功 → 运维 agent 真实调用 `ops_env`/`ops_k8s`/`ops_metrics`/`kb_search` 四个工具 → 按协议返回 `needs_human` + `severity P2` + 四条 evidence + 两个 `need_from_customer` + 去内部化的 `customer_summary` → 台账写入 `result`/`notify`。它没有因为看到 `-122` 就套用知识库结论，而是明确写「证据不足，不下根因结论」，这是设计要的行为。

   之前真实派单 500 的原因是 harness 的 JSON Schema 方言不接受 `type: ['string','null']`（只接受单值 type），`preset-ops` 在挂载时被判非法。已改成单值 type + `oneOf`（`ops-agent/cluster.js`、`ops-agent/metrics.js`），并把「方言子集校验」加进 `scripts/check-plugin-apply.mjs`（能抓住 type 数组、required 不在 properties、未知关键字）。剩下的只是**再重启一次**：ESM 缓存里还是旧模块。重启后跑 `node scripts/check-ops-live.mjs`，再 `POST /ops/dispatch` 派一个真实工单（症状可用知识库里的 `-122`/PVC 满）。
3. Rancher / Grafana 在这台机器连不通（fake-IP 代理 ECONNRESET），要真排障得先上 VPN。
4. `ops_metrics` 未配置数据源；填 `prometheusUrl` 或 `grafanaUrl` + `datasourceUid` 才有指标信号。
5. 一次派单一个工单；`need_info` 续接是同一会话的追加回合，不是无限对话。

## 环境事实

- 形象：Rancher `rancher-sophgo-prod.appia.cn` / `-dev`；Grafana `grafana-cn-c6k4gh5ju01-vpc.grafana.aliyuncs.com`。
- 凭据：`ops-agent/.env.local`（600，不进仓库）；`ops-agent/probe.mjs` 探活。
- 运行目录：`~/.dsh/cs-runtime/{kb,kb/_candidates,ops-kb,ops,data}`，台账 `data/ops-ledger.jsonl`。
- 改宿主插件必须重启 dsh（模块不热替换）；客户端插件（`client.js`）在 `pnpm run dev:web` 下可热更。

## 协同开关与会话定位（2026-10-24 晚上）

- **开关**：`ops-dispatch` 加了一个落盘状态 `data/ops-state.json`（`{enabled, changedAt, changedBy, note}`，文件不存在 = 开启）。
  接口是 `POST /ops/enable` / `POST /ops/disable`，设置页和面板页头各有一个按钮。
  关掉后 `dispatch()` 直接拒绝，`ops_handoff` 先查 `dispatcher.isEnabled()` 并返回 `state:'disabled'`（**不抛错**——抛错会让客服把「管理员关了」当成故障去盘查），客服按知识库独立处理。已派出工单不受影响。
- **为什么状态要落盘**：开关是管理员的运营决定，重启 dsh 不该悄悄改回来。默认开启保证「文件丢了」不会变成一次静默的运维中断。
- **会话定位**：面板是独立窗口，没法直接切 Web UI 的当前会话，所以用深链 `/?opsSession=<id>`；`ops-agent/client.js` 在 `apply` 里轮询会话列表（最多 30s），出现后调用 `ctx.uiWorkspace.openSession(id)` 并 `history.replaceState` 抹掉参数。注意 `SessionTarget = SessionId | SubagentAddress`，直接传字符串 ID 即可。
  工单要有 `requesterSessionId` 才会显示「客服对话」按钮——`POST /ops/dispatch` 手开单时用假 ID 就不会有。
- **面板配色改成白底**（`color-scheme: light`）。排障面板经常在副屏常驻，浅色更耐看；不跟随宿主主题是有意的。

## 整理工单：搜索 / 归档 / 删除（2026-10-25）

- **搜索**：`GET /ops/incidents?q=`，服务端过滤，命中字段是工单号、两个会话 id、状态、现象、账号、
  错误特征、诊断、对客说明、证据；空格分隔的多个词是「与」。刻意不搜对话全文——那要宿主的
  `sessionQuery` 服务（还被 `optional-session-search` 的 isolate 组隔开），而且慢。要读全文点「打开对话」。
- **归档**：台账写 `{kind:'archive', archived}`，看板默认隐藏，`archived=1` 可见，可取消。
- **删除**：台账写 `{kind:'delete'}`，看板移除 + 把客服/运维两个会话从工作区摘掉；**不删会话文件**
  （宿主可能还握着引用，删文件会 ENOENT，清除交给 `scripts/retention.mjs`）。运行中的工单拒绝删除。
- 面板左栏顶部是搜索框 + 「含归档」；**每条工单行右侧两个小按钮**（归档 / 删除），详情页「整理」里也有一份。
  搜索和归档只在控制台，设置页只保留「最近工单」的跳转按钮——两个地方各放一套入口只会让人猜哪个生效。
- 坑：往面板模板字符串里写 `\n` 只会得到一个真换行，把内联脚本写坏；必须写 `\\n`。
  `scripts/check-panel.mjs` 现在会 `node --check` 内联脚本并断言 `id="q"`、`id="showArchived"`。

## 装配层的三个坑（2026-10-24 下午修复）

这三条都属于「代码对、静态检查绿、但线上就是不对」，共同点是被装配语义卡住：

1. **JSON Schema 方言只收单值 type**。`type: ['string','null']` 会让工具注册整体失败，
   `POST /ops/dispatch` 直接 500。可空字段统一写成 `{type:'string'}`，用空串代替 null。
   现在 `scripts/check-plugin-apply.mjs` 的 `schemaViolations()` 会静态拦下。
2. **客户端 UI 只认「行名 == 包名」**。`@local/dsh-ops-agent/client.js` 只有在 Loader 里有
   一行 `name: '@local/dsh-ops-agent'` 时才会被浏览器加载；写成 `/panel` 子路径就静默消失
   （面板找不到、设置页没有「运维」、侧栏没有「运」）。修法是加 `ops-panel-ui` 行 +
   宿主侧空占位 `index.js`。`scripts/check-client-plugins.mjs` 现在会断言。
3. **技能得由预设自己挂**。web-app bundle 把 `skill-filesystem` 和 `tool-skill` 显式
   `disabled: true`，改成「谁要谁挂」。两个预设现在都挂了；运维内置技能在
   `ops-agent/skills/`，路径从包自身解析，不依赖安装目录。

## 并发：同一进程里两个 agent 能并行

实测：两个工单相隔 2 秒派发，`INC-...y746` 跑 09:38:39.589→09:38:56.389，
`INC-...ukwe` 跑 09:38:41.459→09:38:59.232，两个运维 agent 同时在线。

机制上：每个会话是独立 agent，`dispatch()` 在投递任务卡后立即返回（不阻塞客服回合），
宿主的模型调用没有全局并发闸门；同一会话内的 followup 会排队（一个 turn 一次一个），
跨会话互不影响。所以「客服和运维、多个工单」都是并行的，瓶颈只在模型侧的速率限制。

## 重启脚本的教训（2026-10-24）

`scripts/restart-dsh.sh` 第一版用 `nohup pnpm dsh web &` 重启，结果：旧进程被杀掉后，新进程也没起来，GUI 停了约 8 分钟，最后是人手动重启的。

原因：**`nohup` 只挡 SIGHUP，不换进程组**。脚本本身是在 dsh 进程里起来的，它拉起的子进程仍在同一个进程组；旧 dsh 一退出，整组被带走，脚本执行到 "== stopping" 之后就死了（日志停在那里）。

修法：用 `node -e 'spawn("pnpm", ["dsh", profile], { detached: true, stdio: [...] })'` + `child.unref()`，新进程开独立会话，父进程死光也不影响。已用 `sleep 45` 探针验证：杀掉父 shell 后 detached 子进程仍存活。

副作用提醒：`restart-dsh.sh --yes` 会打断正在跑的 agent 回合。如果是在 agent 自己的回合里调用它，这一轮的回复可能来不及落盘——用 `sleep 20` 之类的延迟包一层再调，让当前回合先结束。
