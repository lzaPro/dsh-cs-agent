# DSH 客服台

在 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 上跑一套**接真实渠道（QQ）的客服系统**：
客户消息进来自动答，答不了带着取证材料转给运维 agent，人工随时可以接管；消息不会因为一次超时丢掉，
回复不会因为适配器抖一下就没了，出事了有人知道。

四个 npm 包 + 一层渠道网关，全部挂在 DSH 原生插槽上，不改 DSH 源码。

```
客户 QQ ──► 适配器 ──► 渠道网关 ──────────────────────────────► 客服 agent ──► 知识库
                      │  入站队列（先收下再处理）              （预设 + 工具）   BM25 + 向量
                      │  会话映射 / 去重 / 限流                             三级置信判定
                      │  出站队列（重试 + 死信 + 人工重放）
                      └──► 运维 agent（可选）：一张工单一个会话，账号作用域内取证
```

这套代码的取舍是「能落地」而不是「能演示」：默认零依赖、单机跑得起来，
但每个会在生产里咬人的地方（重复投递、双写、越权取证、静默失效、成本不清）都有对应的机制和测试。

---

## 一、它要解决的六个真实问题

| 现象 | 根因 | 现在的做法 |
|---|---|---|
| 客户说"发了没反应"，日志里查不到 | 入站处理一步到底，中间任一超时整条消息丢弃 | 入站先落队列入库再处理，202 受理，失败重试，可查积压 |
| 客服答了，客户没收到 | 回复只 POST 一次，失败只打一行 warn | 出站队列：幂等键 + 租约领取 + 退避重试 + 死信 + 人工重放 |
| 客户收到两条一样的回复 | 平台重投 + 幂等键里混了时间戳 | 幂等键由内容/消息 id 派生，重投不重复入队 |
| 运维 A 客户的工单查到 B 客户的 pod | `account` 只是给模型看的一句话 | 账号作用域在工具层强制：namespace/context 取交集，必须显式写 namespace |
| 半夜数据库连不上，早上才知道 | 健康检查要人主动去查 | `/health` 探针 + 告警推送（去重/重复提醒/恢复通知） |
| 这个月花了多少钱说不清 | token 只在日志里 | 成本在写的时候按模型单价算成整数存库，读时只查不乘 |

---

## 二、结构设计

### 2.1 包与职责

| 包 | 依赖 | 作用 |
|---|---|---|
| `cs-agent` | 零运行时依赖（`pg` 可选） | 渠道网关、会话存储、入站/出站队列、写入租约、鉴权、告警、保留期、成本、面板、OCR、QQ 适配器、安装脚本 |
| `kb-core` | 零 | 知识库：按字段语义切块、BM25 + 向量双路召回、RRF 融合、三级判定、候选/审核/失效闭环与三个工具 |
| `ops-agent` | 零 | 运维预设 + 派单调度器 + 只读取证工具（k8s / 日志 / 指标），账号作用域与 PromQL 边界 |
| `cs-panel` | 零 | DSH 客户端插槽：设置入口、会话标题栏接管按钮、侧栏人工标记 |

「零依赖」是刻意的：装进 profile 只要链一下目录，不用 `npm install`，也不用担心依赖树里混进别的东西。
数据库是唯一的例外，而且是**可选**的（见 2.4）。

### 2.2 一条客户消息的完整路径

1. **适配器**收到 QQ 事件，验签、归一化（senderId / groupId / 图片），`POST {route}` 到网关。
2. **受理**：网关规范化后算幂等键（有 `messageId` 用消息 id，没有就用内容指纹），
   入站队列 `enqueue`，然后**先返回 202**。这一步只碰磁盘/数据库，不做网络请求。
3. **处理**（同进程内联尝试一次，失败留给 worker）：去重 → 限流 → 下载附件 → 建/恢复 DSH 会话 →
   落盘 → 拼 `userMessage`（含图片提示与 traceId）→ 唤醒模型。
4. **模型**调 `kb_search`：结构化条目 + 双路召回 + 三级判定；`direct` 直答，`reference` 只当线索，
   `miss` 强制追问。
5. **回复**：`assistant/message` 片段缓冲（按轮聚合，不按片段切碎），`turn/end` 时整轮出站。
6. **出站队列**：入队拿幂等键 → 内联首发 → 失败按 2s→8s→32s→2m 退避，5 次后标 `dead`。
7. **适配器**把回复发给客户；`data/outbox.jsonl` 同时留底（审计底稿，库挂了也能查）。
8. **旁路**：消息归档进 `messages`、用量累计进 `usage_daily`、`audit_log` 记人做的每个动作。
   归档失败只 warn，绝不让它拖垮主流程。

答不了时，客服 agent 调 `ops_handoff`（症状、账号、错误特征、证据、成功标准、工单号），
派遣器为这张工单开一个**独立运维会话**，结论回来由客服转述——两侧不共享会话，避免上下文串味。

### 2.3 网关内部模块

`cs-agent/gateway.js` 是编排层，真正的逻辑在下面这些模块里：

| 模块 | 职责 |
|---|---|
| `gateway.js` | 路由、会话生命周期、入站/出站编排、面板 API |
| `store.js` / `store-pg.js` | 会话映射存储（文件 / PostgreSQL 两套实现，同一契约） |
| `inbox.js` | 入站受理队列（幂等键 + 租约领取） |
| `outbox.js` / `outbox-pg.js` / `outbox-retry.js` | 出站投递队列、退避策略、幂等键派生 |
| `lease.js` | 写入域租约：文件锁（单机）/ 数据库租约（多实例，可接管假死） |
| `auth.js` | 三角色访问控制（admin / viewer / inbound）、cookie 登录、常量时间比较 |
| `trace.js` | traceId（`AsyncLocalStorage` 贯穿入站、模型、出站、归档） |
| `alerts.js` | 告警判据（去重、重复提醒、恢复）、webhook 推送 |
| `retention.js` | 保留期与按客户删除的**纯函数**规划（可干跑） |
| `audit.js` | 审计（写 JSONL 底稿 + 可选写数据库表，append-only） |
| `pricing.js` | 模型单价解析与成本计算（micro-USD 整数） |
| `panel.js` | 运维面板（自包含 HTML/CSS/JS，含健康、死信、保留、用量、审计五张卡） |
| `time.js` / `paths.js` | 本地日历日、运行目录解析 |

### 2.4 存储分层：什么在文件里，什么在数据库里

| 数据 | 默认（文件） | `DSH_CS_STORE=postgres` | 为什么 |
|---|---|---|---|
| 知识条目正文 | `kb/*.json` + git | 同左（不搬） | 人审、diff、回滚是特性，不是负担 |
| 检索索引 | 进程内 + 磁盘向量缓存 | 可由条目重建 | 派生数据，丢了能重算 |
| 会话映射 | `data/sessions.json` | `conversations` | 需要跨实例可见、可查询 |
| 消息 / 用量 | `data/*-messages.jsonl`、`*-usage.json` | `messages` / `usage_daily` | 需要按客户查、需要聚合 |
| 入站/出站队列 | `data/*-inbox.json`、`*-outbox.jsonl` | `inbox` / `outbox` | 需要租约领取与多实例可见 |
| 审计 | `data/*-audit.jsonl` | `audit_log`（两处都写） | 表用于查询，文件是库挂了也能看的底稿 |
| 写入租约 | `sessions.json.lock` | `gateway_leases` | 多机时必须有统一裁判 |

**两套实现共用同一份契约测试**（`store-smoke` / `inbox-smoke` / `outbox-smoke` / `message-smoke` /
`purge-smoke` / `usage-smoke` 对两个实现各跑一遍），所以"换存储"不是换一套行为。

不替换 DSH 自己的 session store：compaction、会话搜索、面板都依赖它。数据库只存业务视图，
用 `dsh_session_id` 关联。

### 2.5 可选能力与默认值

全部默认关闭或零依赖，需要时逐个打开——装完就能跑，不配也能用。

| 开关 | 默认 | 打开后的效果 |
|---|---|---|
| `DSH_DB=1` | 关 | 启用数据库能力（`pg` 是 `optionalDependencies`，只在打开时动态载入） |
| `DSH_CS_STORE=postgres` | `json` | 会话/队列/审计进库，多实例共享状态 |
| `token` / `tokenFile` | 无 | 管理接口要令牌；面板走 cookie 登录 |
| `viewerToken` | 无 | 只读令牌：能看，不能删/不能重放 |
| `alertWebhook` + `alertTo` | 关 | 健康检查出问题时主动推送（两者都配才生效） |
| `retentionAuto` | 关 | 定时清理（默认关闭，合规场景显式打开） |
| `pricing` | 空 | 按模型单价算成本 |
| `accounts`（ops） | 空 | 账号作用域强制 |
| `replyWebhook` | 无 | 未配时出站不启用队列，行为与最简版一致 |

---

## 三、技术亮点

### 1. 知识库是「结构化故障条目」，不是文档切片

一条经验是 `id / title / errorSignatures / services / environments / symptom / customerReply /
rootCause / resolution / verification / tags / status` 的结构化条目，不是一段长文本。

按字段语义切块并给不同权重（错误特征 1.5、标题 1.3、现象 1.2、客户话术 1.1、处置 1.0），
所以"报错 -122"能精确命中"PVC 已满"，而不是命中一篇提到 122 的排查文章。

**为什么重要**：文档切片召回的是"相关段落"，条目检索回答的是"这个问题怎么处理"，后者才能直接变成客服回复。

### 2. 双路召回 + RRF 融合 + 三级判定

BM25（词面）与向量（语义）各召回一路，用 RRF 融合（`k=60`），再按阈值表判三档：

- `direct`：置信度够、领先第二名有 margin → 直接作答；
- `reference`：沾边但不够 → 只当线索，要求模型继续追问或核实；
- `miss`：没有 → 强制追问，**不许编**。

检索默认用 512 维 hash 向量（离线、确定性、零成本），可切 OpenAI 兼容的 embedding 服务。

### 3. 人审在环的候选闭环

`kb_propose` 写入 `kb/_candidates/`，`unverified → verified/candidate → deprecated/retired`，
去重按错误特征比对，`scripts/kb-review.mjs` 做批量审核。**模型不能直接改知识库**，
它只能提候选；能不能进生产由人决定。

### 4. 入站：先收下，再处理

`POST {route}` 先算幂等键入队再返回 202，处理失败留在队列里重试。
所以"第 3 张截图下载超时"不会让整条消息消失——客户不必重发，运维还能在 `/inbox` 看到它欠着。

### 5. 出站：幂等键 + 租约领取 + 退避 + 死信重放

- 幂等键由内容派生（不是随机 UUID），同一句话重发不会排两条；
- 领取用租约（`next_attempt_at` 推到 now+lease），两个 worker 不会同时发同一条；
- 5 次退避后标 `dead`，面板里能看到正文预览与最后错误，可以一键重放（重放留审计，谁推的、什么时候）。

### 6. 单写者租约：多实例安全，假死能接管

文件锁只够单机；数据库租约（30s TTL、10s 心跳）才能回答"那台机器是真活着还是卡死了"。
租约被接管后，**原实例立刻拒绝一切写入**（HTTP 503 `LEASE_LOST`），而不是继续双写。

### 7. 权限：能看 ≠ 能删

三角色：`admin`（全部）、`viewer`（只读，写操作 403）、`inbound`（只允许投递入站消息）。
规则是从方法推的（`GET` → viewer，`POST {route}` → inbound，其余 → admin），
**新增接口默认按"写"处理**——忘了归类只会更严，不会更松。
面板打开先问 `/whoami`，只读令牌下删除/重放/清除按钮不渲染。

### 8. 可观测：traceId 贯穿，探针能判"现在能不能干活"

一条入站消息带一个 12 位 traceId，贯穿模型调用、出站投递、归档与审计，日志行带 `[traceId]` 前缀。

`/health` 不是"进程活着"：它检查租约是否还在、队列能否读、数据库能不能连，
任何一项不成立返回 **503** 并列出失败的项。配置告警后，同一问题只报一次，
长期不恢复按 `repeatMs` 重复提醒，恢复时发一条"恢复"。

### 9. 运维取证不越界

- k8s：工单绑定账号后，namespace/context 取账号白名单与全局白名单的**交集**；省略 namespace 直接拒绝
  （否则会退化成扫全集群）；
- 指标：**不解析 PromQL**（子查询、`by`、`label_replace` 让静态判定不可靠），反过来只接受能穷举边界的
  写法——必须显式写 `namespace=` 且值在白名单里，`!=`/`!~`/`.*` 一律拒绝。

"看起来不像客户数据"恰恰是最容易泄漏的地方，所以宁可拒绝，不做猜测。

### 10. 成本在写的时候算

价格按模型 id 匹配（精确 → 最长前缀 → `*`），乘出 micro-USD 整数入库；缓存读写价格缺省按输入价
（**宁可高估**）。读的时候只查不乘，报表和面板不会因为改了价目表而让历史数字漂移。

### 11. 评测门禁按用例逐条比

不是"recall 从 90% 掉到 88%"，而是点名"`sig-9-9` 以前命中 `subscription-fee-9-9-19-9`，现在返回 `null`"。
同时校验用例引用的条目真的存在（否则条目改名后门禁会静默失效）、知识库指纹变了会提示、
embedding 换了会要求重录基线。门禁自检会故意改坏一份知识库，验证"该挂的时候真的挂"。

### 12. 发布包自检

`npm pack` 清单逐条检查：不能含凭证（`.env*` / `*.key` / `*.pem` / `*.token`）、不能含测试文件、
`exports` 里每个入口都要真的在包里并且能 `import()` 成功。

这条检查抓到过两个真事故：`cs-agent` 把 `adapter/.env.local`（真实 QQ 凭证）打进了包里；
`kb-core` 的发布包缺 5 个模块，装出来直接 `Cannot find module`。

---

## 四、运维面

面板 `/channel/panel` 是自包含页面，五张卡：健康、死信、保留期、用量成本、最近审计。

| 端点 | 权限 | 用途 |
|---|---|---|
| `GET /health` | 公开 | 探针：租约、队列、数据库，失败 503 |
| `GET /whoami` | viewer | 当前令牌角色 |
| `GET /sessions` `/history` `/messages` `/status` | viewer | 会话、历史、归档消息、积压 |
| `GET /dead` `/audit` `/usage` `/retention` `/alerts` | viewer | 死信、审计、成本、保留计划（干跑）、告警状态 |
| `POST /replay` | admin | 重放死信（留审计） |
| `POST /retention` | admin | 执行归档/清除 |
| `POST /mode` `/label` `/archive` `/delete` `/reply` `/reset` | admin | 接管与整理 |
| `POST /config` `/config/test` `/adapter/*` | admin | QQ 凭证、连通性、适配器进程 |
| `POST {route}` | inbound | 接收入站消息（202） |

需要 `POST /image`、`GET /outbox`、`GET /inbox`、`GET /orphans` 等其余端点见
[docs/channel-contract.md](docs/channel-contract.md)。

---

## 五、快速开始

```bash
# 1. 链进 profile（四个包都没有运行时依赖）
#    用 plugin_manager 装这四个目录，或复制到 profile 的 node_modules

# 2. 初始化运行目录（问 AppID / Secret，建目录，写 600 的 .env.local）
node cs-agent/install/setup.mjs

# 3. 启动 QQ 适配器
cs-agent/adapter/qq.sh start

# 4. 打开 DSH 工作台
#    设置 → 客服 → 打开工作台   （默认 /channel/panel）
```

完整步骤（QQ 开放平台、OCR、令牌、多实例）见 [INSTALL.md](INSTALL.md)。

### 要不要用数据库

单机、几十个客户：默认的 JSON 存储够用，一条命令都不多敲。

多实例、要跨实例共享会话、要合规审计：起库并切换（端口 55432 是示例，避开了常见占用）。

```bash
cp .env.db.example .env.db
./scripts/db-up.sh                      # docker compose 起库 + 装 pg + 跑迁移
export DSH_DB=1 DSH_CS_STORE=postgres
```

迁移器记住每个文件的 sha256，改历史迁移会直接报错（"加新迁移，别改旧的"）。

---

## 六、部署形态

| 形态 | 存储 | 写入租约 | 适用 |
|---|---|---|---|
| 单机 | JSON 文件 | 文件锁（PID） | 一条命令跑起来，客户量小 |
| 单机 + 数据库 | PostgreSQL | 数据库租约 | 要查询、要审计、要成本报表 |
| 多实例 | PostgreSQL | 数据库租约（心跳 + 接管） | 高可用；同一个 scope 只允许一个写入者 |

三种形态共用同一份代码路径与同一套测试，切换只改环境变量。

---

## 七、测试

```bash
./scripts/verify-all.sh            # 41 步：1279 条断言，全离线，约 45 秒
DSH_DB=1 ./scripts/verify-all.sh   # 加上数据库：1443 条
```

覆盖四个包、数据库迁移与约束、两套存储实现、队列与租约、鉴权三角色、告警、保留期、
成本、评测门禁、发布包清单、端到端安装（从空目录装一遍再真跑一条消息）。

公开仓库里跑是 **1235 条**：`kb/` 与 `eval/` 是部署自己的数据（含真实客服话术与退款政策），
不随插件发布，所以「检索质量」与「检索门禁」两步会**显式打印 skip**——"没跑"和"跑过通过"必须能分辨。

单看检索质量：

```bash
node scripts/eval-rag.mjs --strict     # recall@1 / recall@3 / miss-precision / tier-agreement
node scripts/eval-gate.mjs             # 逐条与基线比较，回退就点名
```

这套测试的价值不在条数，在于它抓出过 13 个真 bug——包括 `load()` 竞态导致重复建会话、
`groupId` 的 `null`/`undefined` 让私聊走进群聊分支、幂等键混入时间戳导致客户收两条、
`inboxKey` 里的 `\u0000` 让数据库模式直接崩、模板字符串多吃一层反斜杠让面板脚本语法错误。

---

## 八、目录

```
cs-agent/      渠道网关：编排、存储、队列、租约、鉴权、告警、保留期、成本、面板、db/ 迁移
kb-core/       知识库：切块、BM25、向量、融合、三级判定、审核闭环、三个工具
ops-agent/     运维：派单调度、k8s/日志/指标只读工具、账号作用域、PromQL 边界
cs-panel/      DSH 客户端插槽
scripts/       验证套件、评测门禁、迁移、保留策略、发布同步
docs/          渠道契约、检索设计、部署形态、事故台设计、逐阶段重构记录
tools/         macOS Vision OCR 的 Swift 源码（可选）
eval/          评测用例与基线（仅部署内使用，不随发布）
```

---

## 九、已知限制

- **OCR**：macOS 走自带 Vision（`tools/build-ocr.sh` 编译），其它平台用 tesseract（配置里改 `backend`）。
- **QQ 主动消息**：需要开放平台授权；超过 5 分钟被动回复窗口的回复会失败，错误显示在工作台。
- **群消息**：默认只推 @ 机器人的消息；要收全部图片需在开放平台开启「接收所有消息」。
- **运维只读**：运维工具只读，写操作要人批准（结论里写清动作、影响、回滚）。
- **面板没有独立账号体系**：靠渠道网关的令牌与 cookie 保护，不要直接暴露到公网。
- **出站重试依赖进程存活**：进程退出后未投递的回复要等下次启动由 worker 接着发；`dead` 项需人工重放。
- **成本是估算**：按配置的单价与上报的 token 计数算，账单以供应商为准。

## 许可

MIT，见 [LICENSE](LICENSE)。四个包各自也带一份。
