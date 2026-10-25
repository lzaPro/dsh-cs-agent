# 运维 Agent（ops-agent）

一个 DSH bundle：**运维预设 + 派单器 + 只读集群工具 + 内部 runbook + 控制面板**。

它接客服转来的故障工单，自己取证、自己判断，给出一份结构化结论；需要改配置时只能提提案，由人在面板批准后执行。

```
客户 ──▶ 客服 agent ──ops_handoff──▶ 派单器 ──▶ 运维会话（ops-<uuid>）
                                        │              │
                                        │              ├─ ops_env / ops_k8s / ops_logs / ops_metrics
                                        │              ├─ kb_search / kb_get（共享 kb + 内部 ops-kb）
                                        │              └─ ops_task（状态、追问、升级、提案）
                                        ▼
                              【运维回执】回到客服会话 ──▶ 客户
```

## 为什么单独一个包

运维要的工具（kubectl、日志、指标）跟客服完全不同，两个 agent 混在一个包里会让「客服能不能查集群」变成一个靠自觉回答的问题。
拆开之后，**客服进程里根本没有 ops_k8s 这个工具**，这比在提示词里写十遍「不要查集群」都可靠。

两个包之间只有两个契约：

| 方向 | 契约 |
|---|---|
| 客服 → 运维 | `ctx.get('opsDispatch').dispatch({ requesterSessionId, task })` |
| 运维 → 客服 | 派单器把回执作为新消息投递到发起会话（`source.kind: 'ops-result'`） |

## 谁能跟运维对话

| 角色 | 能否 | 走哪条路 | 怎么被限制住 |
|---|---|---|---|
| 客服 agent | 能 | `ops_handoff` 工具，参数是结构化任务单 | 这个工具**只注册在 `service-desk` 预设里**，别的 agent 拿不到 |
| 管理员 | 能 | ① 面板 `POST /ops/dispatch` 手动开单；② 直接在 GUI 打开「运维」工作区那个会话插话 | 面板只监听 `127.0.0.1`；运维会话就是普通 root session |
| 客户 | 不能 | —— | 渠道网关只把外部消息路由给 `service-desk`；运维会话没有网关，`preset-ops` 里也没有任何渠道/回复工具 |
| 运维 → 客户 | 不能 | —— | 运维没有回复客户的工具，唯一外发路径是派单器回执给客服 + `notify_admin`；persona 明确禁止自称已回复客户 |

边界靠**组合**保证（谁装了哪些工具），不是靠运行期 ACL。想再收紧，可以在网关侧只允许服务台预设对话，或在 `/ops/dispatch` 前面加一层 token。

`relayEveryTurn: false` 解决一个具体场景：管理员在运维会话里随口问一句，那一轮没有结论块，默认会被当成「运维没有按协议返回结果」回执给客服。设为 `false` 后，这类回合只记进台账的 `kind:"turn"`，工单维持 running，等真正的结论块或超时。

## 工具

| 工具 | 作用 | 边界 |
|---|---|---|
| `ops_env` | 自检：kubeconfig、kubectl、集群连通性、命名空间白名单 | 只读；缺通道时明确报错，让 agent 别编 |
| `ops_k8s` | `get` / `describe` / `events` / `top` / `api-resources` / `version` / `explain` | 动词白名单；`secrets` 永久拒绝；命名空间白名单；无 shell |
| `ops_logs` | Pod 日志，`tailLines` 上限、`previous`、`sinceSeconds`、客户端 `grep` | 行数上限 + 脱敏 + 长度上限 |
| `ops_metrics` | PromQL 瞬时/范围查询 | 只打两个固定端点；范围查询必须给 `minutes` |
| `ops_task` | `set_status` / `ask_requester` / `escalate` / `propose_change` | 不改集群；提案必经人工批准 |
| `kb_search` `kb_get` `kb_propose` | 共享知识库 + 内部 runbook（来自 `@local/dsh-kb`，`role: ops`） | 内部条目只有运维看得到 |

**没有 bash。** 有 bash 的话 `ops_k8s` 的白名单和变更审批都能被一条 `kubectl delete` 绕过。

## 结论协议

运维最后一条消息必须是一个 `json` 代码块：

```json
{
  "status": "resolved | needs_human | need_info | not_found",
  "severity": "P0 | P1 | P2 | P3",
  "confidence": "high | medium | low",
  "diagnosis": "一句话根因",
  "evidence": [{ "source": "k8s | log | metric | kb", "detail": "查了什么 + 看到什么" }],
  "actions_taken": ["实际执行过的只读操作"],
  "verification": "怎么确认恢复",
  "customer_summary": "给客服转译的一句话",
  "need_from_customer": ["还需要客户补充什么"],
  "proposed_change": {
    "action": "要做什么", "target": "对象", "command": "可复制的命令",
    "impact": "影响面", "rollback": "怎么回滚", "verify": "怎么验证"
  }
}
```

- 没有代码块、JSON 坏了、`status` 不认识 → 一律按 `needs_human` 处理，并把原文截断后交给管理员。
- `need_info` 不会结束工单：客服拿到问题后可以调用派单器的 `resume(incidentId, note)`，把答案送回**同一个**运维会话。
- `needs_human` / `not_found` / 超时 / 待批准提案都会写给管理员。

## 变更：提案 → 审批 → 人工执行

v1 明确**不自动执行**写操作：

1. 运维用 `ops_task propose_change` 提交 `action / target / command / impact / rollback / verify`；
2. 提案进 `ops-ledger.jsonl`，面板「变更审批」里是 `pending`；
3. 管理员在面板批准或拒绝，记录 `decidedAt` / `decidedBy`；
4. 批准后由管理员按 `command` 手动执行，回填验证结果。

自动执行留到以后——那需要「执行器 + 回滚 + 审计」三件套，不是这一版能草率加进来的。

## 控制面板

`http://127.0.0.1:3080/ops/panel`（装了本包才有）

页面是白底浅色的（`color-scheme: light`），干净、适合长时间看；不跟随宿主深色主题是故意的——排障面板常在副屏常驻。

| 区域 | 内容 |
|---|---|
| 页头开关 | 「协同开启 / 协同关闭·客服独立」+ 一键切换（`POST /ops/enable` / `POST /ops/disable`） |
| 工单 | 进行中 + 历史，含现象、状态、证据、对客说明；可对 `need_info` 工单补发信息 |
| 搜索 | 左栏顶部输入框：按工单号、两个会话 id、现象、账号、错误特征、诊断、对客说明、证据搜；空格分隔的多个词是「与」 |
| 归档 / 删除 | 每条工单行右侧两个小按钮（归档 / 删除），详情页「整理」里也有一份；归档只是从看板收起来（台账和对话都留着，勾上「含归档」还能看到），删除会把两个会话从工作区摘掉并让这张单离开看板 |
| 会话定位 | 每条工单都带客服会话与运维会话的 ID，行内和详情里都能一键「打开对话」（深链 `/?opsSession=<id>`） |
| 变更审批 | 提案详情、批准 / 拒绝 |
| 知识库候选 | `kb_propose` 提交的候选，通过后进入检索 |

设置页「运维」一栏有同一个协同开关、只读通道自检、计数，以及最近工单的「客服对话 / 运维对话」按钮（搜索和归档不在这里，都在控制台）；运维会话的标题栏有「待批 N」和「回客服」，侧栏行首标「运」。

### 协同开关：关掉之后客服独立运行

- **开**（默认）：客服遇到需要查集群的问题，`ops_handoff` 把工单交给运维。
- **关**：客服照常接单，只是不再转运维。`ops_handoff` 返回一个 `state: 'disabled'` 的结构化结果（不抛错），客服按知识库独立处理，也不会向客户暴露「系统限制」。
- 已经派出去的运维工单不受影响，照常跑完、照常回执。
- 状态落在 `~/.dsh/cs-runtime/data/ops-state.json`，**重启 dsh 不会自己又打开**。文件不存在 = 开启。

### 整理工单：搜索、归档、删除

三种动作的边界是刻意分开的：

| 动作 | 影响范围 | 留痕 |
|---|---|---|
| 搜索 | 只过滤看板 | 无 |
| 归档 | 从默认看板隐藏（`archived=1` 可见） | 台账 `kind: "archive"`（可取消归档） |
| 删除 | 看板移除 + 两个会话从工作区摘掉 | 台账 `kind: "delete"` |

- **删除不删会话文件**：宿主可能还握着引用，删文件会让它报 ENOENT；真正的清除交给 `scripts/retention.mjs`，那时映射已经不存在了。这和客服面板的做法一致。
- **运行中的工单不能删**，只能等它结束或超时——删了就看不出它跑过。
- 搜索走服务端过滤（`GET /ops/incidents?q=...`），因为台账可能很长。**搜索只在控制台里**：设置页只留「最近工单」的跳转按钮，不放重复入口。
- 搜索刻意不搜对话全文：那需要宿主的 `sessionQuery` 服务（且被 `optional-session-search` 的 isolate 组隔开），也慢。要读全文直接点「打开对话」。

### 会话定位：从工单直接跳进对话

面板是独立窗口，本身不能切换 Web UI 的当前会话，所以「打开对话」走深链：`/?opsSession=<sessionId>`，由客户端插件（`ops-agent/client.js`）捕获后调用 `ctx.uiWorkspace.openSession()`，再把参数从地址栏抹掉。

- 工单必须记录 `requesterSessionId`（派单时的客服会话）才会出现「客服对话」按钮；用 `POST /ops/dispatch` 手开单时给的是假 ID 就会没有。
- 从运维会话点「回客服」是同一个机制的原地版本，不用开新标签页。

### 浏览器侧 UI 的装配前提（踩过）

客户端模块只认**行名恰好等于包名**的 Loader 行（`client-modules` 的 `exactPackageSpecifier`）。
所以 `cordis.patch.yml` 里必须有这一行：

```yaml
- id: ops-panel-ui
  name: '@local/dsh-ops-agent'
```

写成 `@local/dsh-ops-agent/panel` 这类子路径，`client.js` 永远不会被浏览器加载，
看起来就是「插件装了但 UI 找不到」，且没有任何报错。`scripts/check-client-plugins.mjs`
现在会断言这条规则。`index.js` 是这一行的宿主侧占位（`apply()` 为空）。

### 技能

运维预设自己挂了 `skill-filesystem` + `tool-skill`（宿主在 web-app 层把这两行关了，
每个预设得自己挂）。技能来源：

| 来源 | 路径 |
|---|---|
| 本包内置 | `ops-agent/skills/`（随包发，`customSkillDirs` 从包自身解析） |
| 用户级 | `~/.dsh/skills/`、`~/.agents/skills/` |
| 项目级 | `<agent cwd>/.dsh/skills/`、`<agent cwd>/.agents/skills/` |

内置的 `cte-rancher-support` 是 Rancher 排障 runbook（环境、错误模式、Grafana 查询）。
要加新技能，放进 `ops-agent/skills/<name>/SKILL.md` 即可。

HTTP 接口（面板自己用的，也可脚本调用）：

```
POST /ops/dispatch                   {"requesterSessionId": "...", "task": {"symptom": "..."}}  # 手动开单/自测
GET  /ops/status
GET  /ops/incidents                  ?q=<搜索词>&archived=1
GET  /ops/sessions                   ?q=<搜索词>&archived=1   # 同 /ops/incidents，给脚本用
POST /ops/incidents/<id>/resume      {"note": "..."}
POST /ops/incidents/<id>/archive     {"archived": true}        # false 就是取消归档
POST /ops/incidents/<id>/delete      {"by": "admin"}
GET  /ops/proposals
POST /ops/proposals/<id>/approve     {"by": "...", "note": "..."}
POST /ops/proposals/<id>/reject
GET  /ops/kb/candidates
POST /ops/kb/candidates/<id>/verify
POST /ops/kb/candidates/<id>/reject
```

## 配置

`cordis.patch.yml` 里三段，装完通常只需要动 `kubeconfig`：

| 行 | 配置 | 说明 |
|---|---|---|
| `ops-dispatch` | `timeoutMs` | 单个工单的截止时间，默认 600000（10 分钟） |
| | `notifyWebhook` / `adminId` | 管理员通知（复用 QQ 回推接口）；`adminId` 留空则只写台账 |
| | `ledger` | 台账文件，默认 `~/.dsh/cs-runtime/data/ops-ledger.jsonl` |
| | `relayEveryTurn` | 默认 `true`：运维每回合结束就回执给客服。设 `false` 时只认结论 JSON 块，没有块的回合只记账并继续跑——适合「管理员会中途进运维会话插话」的用法 |
| `preset-ops` → `ops-cluster` | `kubeconfig` | **只读** kubeconfig 的绝对路径；留空用 `KUBECONFIG` 或 `~/.kube/config` |
| | `namespaces` | 允许访问的命名空间；`*` 表示全部；留空等于拒绝一切带命名空间的调用 |
| | `logLineLimit` | 单次日志行数上限，默认 300 |
| `preset-ops` → `ops-metrics` | `prometheusUrl` 或 `grafanaUrl` + `datasourceUid` | 都不配时 `ops_metrics` 明确返回「未配置」，agent 不会假装看过指标 |
| | `stateFile` | 协同开关的状态文件，默认 `~/.dsh/cs-runtime/data/ops-state.json`；不存在等于开启 |
| `ops-panel` | `route` | 面板前缀，默认 `/ops` |

## 运行目录

```
~/.dsh/cs-runtime/
  kb/                 共享知识库（客服 + 运维）
  kb/_candidates/     候选条目，等审核
  ops-kb/             运维内部 runbook（只有 ops 预设读得到）
  ops/                运维会话工作区
  data/ops-ledger.jsonl   工单 / 提案 / 通知台账
  data/ops-state.json     协同开关（不存 = 开启）
```

## 自测

```bash
node ops-agent/smoke.mjs        # 78 项：派单、回执、台账、提案、续接、脱敏、白名单、面板路由、协同开关、归档/删除/搜索
./scripts/verify-all.sh         # 全仓库：静态检查 + 所有包的 smoke
node scripts/check-ops-live.mjs # 打运行中进程的真实接口（不重启就看不到新插件）
./scripts/restart-dsh.sh --yes  # 重启本机 dsh 并自检 /ops/status（会中断在跑的回合）

# 实测一次真实派单（requesterSessionId 用真实客服会话才能看到回执）
curl -s -X POST http://127.0.0.1:3080/ops/dispatch -H 'content-type: application/json' \
  -d '{"requesterSessionId":"<客服会话 id>","task":{"symptom":"客户侧 -122 报错","errorSignatures":["-122"]}}'
```

前两个用假 ctx 和假 kubectl 跑，不需要真集群；`check-ops-live.mjs` 检查的是**当前这个 dsh 进程**有没有加载运维包——
宿主模块不热替换，所以改完插件必须重启 dsh，否则会看到一堆 404。

## 已知限制

- **没有只读 kubeconfig 时只能看知识库**：`ops_env` 会如实报错，此时 agent 的正确行为是 `needs_human`，不是猜。
- 访问 Rancher / Grafana 需要 VPN；连不通时 `ops_env` 的 `reachability` 检查会失败。
- 一次派单 = 一个工单；`need_info` 后的续接是同一会话的追加回合，不是无限对话。
- 审批只到「批准」为止，执行靠人。
