# 基于 DeepSeek Harness 的故障处理系统：实施方案

> 目标：客户报错 → 客服 Agent 查知识库 → 需要时转运维 Agent → 运维不行转值班人 → 全程留痕 → 新问题沉淀进知识库。

## 当前进度

| 阶段 | 状态 | 产物 |
|---|---|---|
| 客服 Agent + 知识库 v0 | ✅ 已实现 | [`cs-agent/`](../cs-agent/README.md)、[`kb-core/`](../kb-core/README.md)（已抽成 `@local/dsh-kb` 共享包） |
| 渠道网关（会话路由/去重/限流/附件） | ✅ 已实现并线上验证 | [`cs-agent/gateway.js`](../cs-agent/gateway.js)、[渠道契约](channel-contract.md) |
| 平台适配器 | ✅ 已实现并线上验证 | [`cs-agent/adapter/`](../cs-agent/adapter/README.md) |
| 运维 Agent + 交接协议 | ✅ 已实现（运行时待重启验证） | [`ops-agent/`](../ops-agent/README.md)、[交接说明](ops-agent-handoff.md) |
| 运维只读工具（kubectl / 日志 / 指标） | ✅ 已实现（缺只读 kubeconfig 才能真用） | [`ops-agent/cluster.js`](../ops-agent/cluster.js)、[`ops-agent/metrics.js`](../ops-agent/metrics.js) |
| 变更提案 + 人工审批 | ✅ 已实现（v1 不自动执行） | [`ops-agent/dispatcher.js`](../ops-agent/dispatcher.js)、`/ops/panel` |
| 内部 runbook（ops-kb） | ✅ 已实现 | [`ops-kb/`](../ops-kb/README.md) |
| 值班升级 / 工单索引 | 设计完成，未实现 | 本文第 6、9 节 |

## 0. 一句话结论

不要把「编排器」写成第三个 Agent，也不要把两个 Agent 接成自由聊天。
在 DSH 里，**一个客户（当天）= 一个 root Session**，**一次故障 = 这个会话里的 `incident/*` 事件实体**，**两个角色 = 两个 preset**，**运维 = 故障的 continuable subagent**，**值班兜底 = 同一个人接管同一个 Session**。你要写的代码只有一个 workspace bundle。

## 1. 先纠正三个前提

| 你的原始设计 | 在 DSH 上的正确形态 | 原因 |
|---|---|---|
| 第三个「工作流编排器」模块 | 不需要独立进程/服务；编排是 Session 事件 + 工具调用顺序 | Session 日志本身就是持久化、可回放、可恢复的状态机 |
| 客服 Agent 和运维 Agent 互相发消息 | 客服 `ops_handoff` 派生子 Agent；子 Agent 结果以 completion notice 回到父会话 | 子 Agent 有独立 Session，证据链完整；进程重启可 cold resume |
| 工单状态存在数据库里 | 状态存 Session 事件，由 `ctx.sessionProjections` 折叠出当前视图 | 「模型可见 ⟺ 已记录」；重放、审计、UI 三者同源 |

真正需要落库的只有两类：**跨会话的索引**（工单队列、知识库）和**需要人审的内容**（知识候选）。单次故障的流转全部在会话日志里。

## 2. 能力映射

| 需求 | DSH 能力 | 你要不要写 |
|---|---|---|
| 客户入口（Web） | 原生会话 | 不写 |
| 客户入口（IM / 工单系统） | `ctx.webhookRuntime.register()` + `ctx.webServer.register()` | 写一个 adapter（约 100 行） |
| 客服角色 | `@deepseek-ai/dsh-agent-preset` 声明 | 写 YAML |
| 运维角色 | 同上，工具集不同 | 写 YAML |
| 客服 → 运维交接 | `@deepseek-ai/dsh-tool-subagent`（`provider: spawn`，`agentPreset: ops`，`outputSchema`） | 写 YAML + 交接 JSON schema |
| 运维 → 客服回传 | 子 Agent 结束自动产生父会话 notice；中途可用 `send_message` | 不写 |
| 截图理解 | `@deepseek-ai/dsh-tool-fs` 的 `read_image` | 不写 |
| 知识库检索 | 自定义工具 `kb_search` | 写 |
| 状态机 | 自定义 `incident/*` Session 事件 + projection | 写 |
| 高风险操作审批 | `@deepseek-ai/dsh-user-approval`（`ctx.approval`） | 配置 + 工具里发起 |
| 值班兜底 | 同一 Session 人工接管 + `ask_user_question` | 写一个 `escalate` 工具 |
| SLA 超时 | `ctx.schedule` | 写 |
| 工单队列 / 看板 | 自定义 storage domain + client plugin | 二期 |

## 3. 系统结构

```
客户（Web 会话 / IM webhook）
   │
   ▼
root Session（路由键：tenant + user + day）  ← preset: service-desk
   │  ├─ 事件：incident/opened, incident/triaged, incident/closed …
   │  ├─ 工具：kb_search / incident_note / escalate_to_oncall / ops_handoff
   │  └─ 人工可随时在同一会话插话接管
   │
   ├─ subagent Session  ← preset: ops（独立日志、独立工具、可 cold resume）
   │     ├─ 工具：k8s_read / k8s_apply(审批) / send_message
   │     └─ 结束 → 父会话收到 Structured result
   │
   └─ 知识沉淀：incident/closed 后生成 KB 候选 → 人审 → kb_publish
```

## 4. 代码结构

一个 bundle，装在当前 profile：

```
incident-desk/
  package.json
  cordis.patch.yml
  src/index.ts        # host：incident 服务（工单索引 + 知识库）
  src/tools.ts        # preset：模型工具
  kb/                 # 知识库 v0：markdown 文件
    payment-5xx.md
```

`package.json`：

```json
{
  "name": "@local/dsh-incident-desk",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

`cordis.patch.yml`（结构示意，字段以实际 API 为准）：

```yaml
# 1) host：工单索引 + 知识库服务（全局唯一，跨会话）
- insert:
    - id: incident-store
      name: '@local/dsh-incident-desk'
      config:
        kbDir: ./kb
        dataFile: !!js dshHomePath('incident-desk.json')

    # 2) 客服角色
    - id: preset-service-desk
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: service-desk
        name: 客服
        description: 受理客户报错，检索知识库，必要时转交运维或值班
        order: 10
        plugins:
          - id: persona
            name: '@deepseek-ai/dsh-persona'
            config:
              prefix: |
                你是客户支持工程师。客户会发来报错截图和描述。
                1. 先用 kb_search 检索历史故障；命中的方案必须核对适用环境与版本。
                2. 能安全解决就直接给步骤，并让客户确认结果。
                3. 需要看 Pod/日志，或方案执行失败，用 ops_handoff 转运维。
                4. 运维失败或超时，用 escalate_to_oncall 升级值班。
                5. 永远不要建议客户执行破坏性操作。
          - id: time-context
            name: '@deepseek-ai/dsh-time-context'
          - id: tool-fs
            name: '@deepseek-ai/dsh-tool-fs'
            config: { read: true, readImage: true, write: false, edit: false }
          - id: tool-todo
            name: '@deepseek-ai/dsh-tool-todo'
            config: { allowParallelInProgress: false }
          - id: tool-ask-user
            name: '@deepseek-ai/dsh-tool-ask-user'
          - id: incident-tools
            name: '@local/dsh-incident-desk/tools'
          - id: send-message
            name: '@deepseek-ai/dsh-tool-subagent-control'
          - id: ops-handoff
            name: '@deepseek-ai/dsh-tool-subagent'
            config:
              provider: spawn
              toolName: ops_handoff
              agentPreset: ops
              maxDepth: 0        # 运维不能再往下派生
          - id: compaction
            name: cordis:group
            group: true
            isolate: { compaction: true }
            config:
              - id: compaction-basic
                name: '@deepseek-ai/dsh-compaction-basic'

    # 3) 运维角色
    - id: preset-ops
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: ops
        name: 运维
        description: 只读诊断为主，高风险操作需审批
        order: 11
        plugins:
          - id: persona
            name: '@deepseek-ai/dsh-persona'
            config:
              prefix: |
                你是 SRE。只做有证据支撑的诊断。
                先看 Pod 状态/事件/日志/指标，再下结论。
                区分「已执行」「建议执行」「已验证恢复」。
                结论必须带证据引用；无法解决时明确说 needs_human。
          - id: k8s
            name: '@local/dsh-incident-desk/k8s'   # 见第 8 节：不要给裸 bash
          - id: incident-tools
            name: '@local/dsh-incident-desk/tools'
          - id: send-message
            name: '@deepseek-ai/dsh-tool-subagent-control'
          - id: compaction
            name: cordis:group
            group: true
            isolate: { compaction: true }
            config:
              - id: compaction-basic
                name: '@deepseek-ai/dsh-compaction-basic'
```

要点：
- 客服 preset **不给 bash**，运维 preset **不给 write/edit/web**，能力集就是权限边界。
- `maxDepth: 0` 让 `ops` 不能再派生，避免递归失控。
- `tool-subagent-control` 让子 Agent 能 `send_message` 给父 Agent（中途汇报）。
- 两个 preset 都要挂 `compaction`：一个故障可能几十轮。

## 5. 端到端时序

| 步 | 发生什么 | 用到的 API |
|---|---|---|
| 1 | 客户发消息（截图 + 文本） | Web 会话；或 webhook 触发建会话，`preset: service-desk` |
| 2 | 客服读图、抽取错误码/服务名 | `read_image` + persona 约束 |
| 3 | 检索知识库 | `kb_search({ error, service, env })` → 返回命中 + 置信度 + 证据 |
| 4a | 高置信度且低风险 | 直接回复客户，`incident/answered` |
| 4b | 需要看运行时 | `ops_handoff({ incident_id, symptom, evidence, allowed_actions, success_criteria })` |
| 5 | 运维子会话启动，查 Pod/日志 | `spawn` + 只读 k8s 工具；变更走 `ctx.approval.request()` |
| 6 | 运维结束 | 父会话收到 completion notice（含 `Structured result: {...}`），客服组织回复 |
| 7 | 运维失败/超时 | `escalate_to_oncall` → `incident/escalated` + 通知；人在同一会话接管 |
| 8 | 关闭 | `incident_close` → `incident/closed`；新问题生成 KB 候选，人审后 `kb_publish` |

第 6 步有个必须理解的语义：**父 Agent 派发子 Agent 后，那个 turn 就结束了**。子 Agent 完成时是**新的一轮**把结果送进父会话。所以「客服等运维」不是同步阻塞，而是「先告诉客户已转技术处理，结果回来再回复」。

## 6. 数据模型与状态机

### 6.1 Session 事件（写在 root 会话里）

```ts
declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'incident/opened': { incidentId: string; channel: string; symptom: string }
    'incident/triaged': { kbHits: number; decision: 'answer' | 'ops' | 'escalate' }
    'incident/handed_off': { childSessionId: string; task: OpsTask }
    'incident/ops_result': { status: OpsStatus; diagnosis: string; evidence: string[] }
    'incident/escalated': { reason: string; oncall: string }
    'incident/closed': { resolution: string; kbCandidateId?: string }
  }
}
```

`ctx.sessionProjections.register({ key: 'incident', ... })` 折叠出当前状态，UI 和工具都读它，不读对话历史。这样换会话、重启、人工接管都不会丢上下文。

### 6.2 客服 → 运维 交接协议（`outputSchema` 同时约束返回值）

```json
{
  "incident_id": "INC-2026-00123",
  "task_type": "diagnose",
  "application": "payment-service",
  "environment": "production",
  "symptom": "请求持续返回 5xx",
  "error_signatures": ["upstream timeout"],
  "evidence_refs": ["attachment-001"],
  "previous_attempts": ["kb_search 无高置信度命中"],
  "allowed_actions": ["read_pod", "query_logs", "query_metrics"],
  "success_criteria": ["给出有证据的根因，或明确 needs_human"]
}
```

运维返回：

```json
{
  "status": "resolved | needs_human | need_customer_info | in_progress",
  "diagnosis": "...",
  "evidence": ["pod payment-7f9c CrashLoopBackOff", "log: OOMKilled"],
  "actions_taken": [],
  "verification": { "checked": ["pod ready"], "result": "healthy" },
  "customer_summary": "给客户看的非技术描述",
  "knowledge_candidate": { "suggested": true, "title": "..." }
}
```

用 `outputSchema` 而不是靠自然语言约定，编排逻辑才能稳定判断下一步。

### 6.3 状态迁移

```
NEW → TRIAGED → (ANSWERED | HANDED_OFF | ESCALATED)
HANDED_OFF → (OPS_RUNNING) → (RESOLVED | NEED_INFO | ESCALATED)
NEED_INFO → TRIAGED
ESCALATED → RESOLVED（人工处理完，同会话）
RESOLVED → CLOSED
```

非法迁移在工具里直接抛错，不做静默兜底。

## 7. 知识库

| 阶段 | 方案 | 成本 |
|---|---|---|
| v0 | `kb/*.md`，frontmatter 存 `error_signature/service/env/version`，`kb_search` 做关键词 + 结构化过滤 | 1 天 |
| v1 | 向量检索（本地 embedding 或外部 API），召回 top-k 后让模型判定是否同一问题 | 3–5 天 |
| v2 | 候选 → 人审 → 发布，带版本和失效标记 | 1 周 |

**关键规则**：只有 `incident/closed` 且 `verification.result === 'healthy'` 的故障才能生成候选；候选必须人审才能进正式库；未验证的方案永远标 `unverified`。

## 8. 安全

| 风险 | 对策 |
|---|---|
| 模型乱跑命令 | 运维 preset 不给 `bash`，只给自研 `k8s_*` 工具，服务端强制 namespace/label 范围 |
| 模型自己拼 kubeconfig | 凭证只存在 `ctx.credentials`，工具内部取，不进 prompt |
| 高风险变更 | `ctx.approval.request()`，被拒就 fail closed |
| 多租户越权 | 工具入参不接受任意 namespace，从会话的 workspace 元数据派生 |
| 知识库被污染 | 候选与正式库分离，发布需要人审 |

## 9. 里程碑

| 阶段 | 交付 | 验收 |
|---|---|---|
| M0 | bundle + 两个 preset | Web 里能切到「客服」「运维」两个角色，工具集不同 |
| M1 | `kb_search` + `incident_*` 事件 | 报错 → 命中历史方案 → 回复客户 → 标记解决 |
| M2 | `ops_handoff` + 只读 k8s 工具 | 未命中 → 自动开运维子会话 → 结果回到客服会话 |
| M3 | `escalate_to_oncall` + 超时 | 运维失败或超时 → 标记 escalated → 人接管同一会话 |
| M4 | KB 候选 + 审核发布 | 新问题解决后生成候选，人审后能再次被检索到 |

建议先做 M0–M1：闭环最短，能立刻验证「会话即工单」这个前提成不成立。

## 10. DSH 特有的坑

1. **preset 是能力集，不是人设**。改 preset 要重装 bundle；已存在的会话保留旧 revision，验证必须开新会话。
2. **subagent 不是同步函数**。父 turn 会结束，结果以新 turn 回来；别在工具里 `await` 一个「等运维处理完」。
3. **会话日志是唯一事实来源**。任何给模型看的内容都必须能 replay；不要用内存 Map 存状态。
4. **上下文会膨胀**。一次故障几十轮，靠 compaction + 子会话隔离，别把所有证据塞进父会话。
5. **工具名全局唯一**。`send_message`、`ops_handoff` 这类名字一个 profile 内只能注册一次。
6. **webhook 是 fire-and-forget**。不重试、不去重、无完成状态；重复投递会建重复会话，需要自己在 adapter 里做幂等。

## 11. 需要你拍板的 5 件事

1. 客户入口：先做 Web 会话，还是直接对接 IM/工单系统？
2. 运维工具：只读诊断起步，还是一开始就开放审批后的变更操作？
3. 知识库：先用 markdown 文件，还是直接接向量库？
4. 「值班人员」是同一个 Web UI 里的人，还是需要独立通知渠道（企微/飞书/电话）？
5. 是否多租户/多集群？这决定工具入参和隔离模型。
