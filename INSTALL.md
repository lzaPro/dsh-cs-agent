# 安装客服插件

四个包，装完就能用。运行目录默认在 `~/.dsh/cs-runtime`，可用 `DSH_CS_ROOT` 改。

| 包 | 必需 | 作用 |
|---|---|---|
| `dsh-kb` | ✅ | 共享知识库服务 + `kb_search`/`kb_get`/`kb_propose` 工具（客服与运维共用） |
| `dsh-cs-agent` | ✅ | 渠道网关、OCR、客服预设、QQ 适配器 |
| `dsh-ops-agent` | 可选 | 运维预设 + 派单器 + 只读集群/日志/指标工具 + 控制面板 |
| `dsh-cs-panel` | 建议 | 控制台里的「客服」页和会话标题栏按钮 |

## 1. 初始化

```bash
npx dsh-cs-setup
```

它会问你要 QQ 机器人的 AppID 和 AppSecret，然后：

- 创建运行目录：`customer`、`eval`、`ops`、`data`、`adapter`、`kb`、`kb/_candidates`、`ops-kb`
- 技能目录不用手工建：运维技能随 `@local/dsh-ops-agent` 包发（`ops-agent/skills/`），
  用户级技能放 `~/.agents/skills/` 或 `~/.dsh/skills/`，两个预设都会读
- 把 QQ 适配器复制到 `~/.dsh/cs-runtime/adapter`
- 写入 `~/.dsh/cs-runtime/adapter/.env.local`（权限 600）
- 复制知识库模板（已有内容不会被覆盖）

非交互方式：

```bash
npx dsh-cs-setup --app-id 123456 --app-secret xxxxx
```

## 2. 安装插件

在 DSH 的「设置 → 插件」里，把这两个/三个目录作为本地插件装上：

```
<包目录>/kb-core         # 必需：知识库服务
<包目录>/cs-agent
<包目录>/cs-panel        # 建议
<包目录>/ops-agent       # 可选：运维 agent
```

装完重启 dsh。

## 3. 启动

- 打开「设置 → 客服」（左侧栏一级入口），点「启动」
- 或者命令行：`~/.dsh/cs-runtime/adapter/qq.sh start`

工作台：`http://127.0.0.1:3080/channel/panel`
运维控制台（装了 `ops-agent` 才有）：`http://127.0.0.1:3080/ops/panel`

## 4. 配置（一般不需要）

所有路径都有默认值。要覆盖时改插件配置：

| 配置 | 默认值 |
|---|---|
| `privateWorkspace` / `groupWorkspace` | `<运行根>/customer` |
| `evalWorkspace` | `<运行根>/eval` |
| `dataFile` | `<运行根>/data/sessions.json` |
| `outbox` | `<运行根>/data/outbox.jsonl` |
| `imageDir` | `<运行根>/data/images` |
| `adapterCommand` | `<运行根>/adapter/qq.sh` |
| `sessionsRoot` | `~/.dsh/sessions` |
| `kbDir`（预设内） | `<运行根>/kb` |
| 运维 workspace | `<运行根>/ops` |

换整个根目录只需要一个环境变量：

```bash
export DSH_CS_ROOT=/data/cs-runtime
```

## 4.1 知识库维护

日常只有三件事，都在 `scripts/` 里：

```bash
node scripts/kb-import.mjs --from ./导出 --to ~/.dsh/cs-runtime/kb --write   # 批量导入（默认 dry-run）
node scripts/kb-review.mjs list                                            # 看 agent 提交的候选
node scripts/kb-review.mjs verify <id>       # 入库；加 --ops 进运维 runbook
node scripts/kb-review.mjs expire <id> --reason "已被新版本修复"             # 标记失效，不再参与检索
node scripts/kb-review.mjs stats             # 各目录条目数、出现次数排行
node scripts/eval-rag.mjs                    # 改完条目跑一遍检索质量
```

候选条目在人工 `verify` 之前**不参与检索**。检索的打分权重、阈值、向量后端都在 `kb-core/cordis.patch.yml` 的 `tuning` 与 `embedding` 段，留空即默认值。

## 4.2 数据库（可选）

会话、消息、工单、投递、审计可以落到 Postgres。**不装也能用**：没设 `DSH_DB` 时
所有数据库相关代码都不执行，四个包仍然零运行时依赖。

```bash
cp .env.db.example .env.db   # 可选，不建也能用默认值
./scripts/db-up.sh           # 起容器 + 装驱动 + 跑迁移，幂等
./scripts/db-down.sh         # 停容器，保数据
./scripts/db-down.sh --purge # 连数据卷一起删
```

需要连库的地方显式打开：

```bash
export DSH_DB=1
node cs-agent/db-smoke.mjs   # 数据库层自测，60 条断言
```

数据库装好之后，可以把**会话状态**也搬进去（多进程共享一份真相）：

```bash
export DSH_DB=1
export DSH_CS_STORE=postgres   # 默认 json，不设就还是原来的 sessions.json
node cs-agent/store-smoke.mjs  # 存储层自测，56 条断言
```

`DSH_CS_STORE` 与 `DSH_DB` 是分开的：前者决定会话存哪儿，后者只表示数据库能力
是否可用。不设 `DSH_CS_STORE` 时行为与重构前完全一致，回退只要 unset。

回复投递队列跟着会话存储走：配了 `replyWebhook` 时，发不出去的回复会入队并按
2s → 8s → 32s → 2m 退避重发，5 次仍失败转 `dead` 并打 warn。`GET <route>/outbox`
的 `delivery` 字段能看到积压（pending/failed/dead 条数）。

```bash
node cs-agent/outbox-smoke.mjs        # 投递队列自测，30 条断言
DSH_DB=1 node cs-agent/outbox-smoke.mjs  # 连库跑两套实现，52 条断言
```

表结构、设计取舍和回滚方式见 [docs/refactor-p1.md](docs/refactor-p1.md)，
会话存储层见 [docs/refactor-p2.md](docs/refactor-p2.md)，
回复投递见 [docs/refactor-p3.md](docs/refactor-p3.md)。

### 4.3 多实例部署

切到 `DSH_CS_STORE=postgres` 之后，"谁是写者"由 `gateway_leases` 表决定，而不是本地 pid 锁：

- 租约默认 30 秒过期、每 10 秒心跳续期；进程崩溃或卡死后租约自然过期，别的实例直接接管，
  不需要人工删锁文件。
- 多机部署时所有实例必须用**同一个 `leaseScope`**（默认 `cs-gateway`）。不要拿数据文件路径
  当 scope —— 容器里各机器路径相同但数据不同。
- 被接管后原实例的 `lease.lost` 会变 `true` 并打 warn；当前版本只报警不强制停写，
  ttl 内仍是串行写入。
- 仍留在 JSON 存储时是单机独占：文件锁没有有效期，别把同一个数据目录挂到两台机器上。

```bash
node cs-agent/lease-smoke.mjs            # 文件锁 8 条
DSH_DB=1 node cs-agent/lease-smoke.mjs   # 加上数据库租约共 25 条
```

细节见 [docs/refactor-p4.md](docs/refactor-p4.md)。

### 4.4 入站受理队列

客户消息不再"一路做完才算收到"：校验、去重、限流之后先落进入站队列（数据库模式下是
`inbox` 表），落进去就算受理，然后立刻在同一请求里试一次处理。附件下载失败、建会话超时
这类临时故障不会再让消息消失，而是留在队列里按 2s → 8s → 32s → 2m 退避重试，
5 次仍失败标 `dead`。

这条队列**永远启用**，与是否配置 `replyWebhook` 无关（投递队列才需要 webhook）。

```bash
node cs-agent/inbox-smoke.mjs            # 入站队列自测，26 条断言
DSH_DB=1 node cs-agent/inbox-smoke.mjs   # 连库跑两套实现，38 条断言
```

`GET <route>/status` 的 `inbox` 字段给出积压（pending/failed/dead）；
`GET <route>/inbox?limit=50` 能看到具体哪些消息还没处理完。

细节见 [docs/refactor-p5.md](docs/refactor-p5.md)。

### 4.5 健康检查与追踪 id

网关自带健康检查端点，编排系统（systemd / K8s / 宝塔）可以直接拿它做探针：

```bash
curl -s http://127.0.0.1:3080/channel/health | jq
```

- 一切正常返回 **200**，任一检查失败返回 **503**（探针看状态码即可）。
- 返回里带 `store.kind`、`lease.kind`/`lost`、队列积压、数据库版本，以及逐项
  `checks`，出问题时能直接看出坏在哪一环。

每条入站消息会生成一个 12 位追踪 id，日志自动带 `[traceId]` 前缀，并且会写进审计
jsonl、投递信封和模型消息的 `source`。客户说"刚才那条没回"时，用这个 id 就能把
"受理 → 建会话 → 模型回复 → 投递"整条链路的日志串起来。

```bash
node cs-agent/health-smoke.mjs                                  # 22 条断言
DSH_DB=1 DSH_CS_STORE=postgres node cs-agent/health-smoke.mjs   # 28 条断言
```

细节见 [docs/refactor-p6.md](docs/refactor-p6.md)。

### 4.6 租约被接管之后

多实例部署时，写入租约被别的实例接管后，这个实例会**拒绝所有写入**并让健康检查返回 503：

- 入站消息：返回 `503` + `code: LEASE_LOST`，不会唤醒模型、不会入队；
- 模型回复：发不出去，日志里记 `reply not sent: ... write lease was taken over`；
- 读路径（`/status`、`/sessions`、`/history`）仍然可用，方便排查"刚才发生了什么"。

此时应当重启实例，让它在启动时重新抢租约。后台重试的定时器会自己停掉，不会一直刷日志。

```bash
node cs-agent/lease-guard-smoke.mjs   # 18 条断言
```

细节见 [docs/refactor-p7.md](docs/refactor-p7.md)。

### 4.7 会话历史与用量

消息正文与 token 用量会落库（`messages` / `usage_daily`），所以「这个客户昨天说了什么」
「这个月用了多少 token」都能查：

```bash
curl -s 'http://127.0.0.1:3080/channel/messages?key=qq:12345&limit=20' | jq
```

- 用 `json` 存储时，消息追加在 `<dataFile 去 .json>-messages.jsonl`，用量在 `-usage.json`；
- 用 `DSH_CS_STORE=postgres` 时，直接写 `messages` / `usage_daily` 两张表；
- 记录的是**实际发给客户的那条文本**（含兜底回复）和**真实 token 用量**（缓存读写分列记账）；
- 按天统计用服务器本地日历日，不是 UTC（否则东八区凌晨的用量会记到前一天）。

归档是旁路：写历史失败只会记 `warn`，不会让客户的消息处理失败。

```bash
node cs-agent/message-smoke.mjs                                  # 26 条断言
DSH_DB=1 DSH_CS_STORE=postgres node cs-agent/message-smoke.mjs   # 41 条断言
```

细节见 [docs/refactor-p8.md](docs/refactor-p8.md)。

### 4.7.1 成本（可选）

token 不一定等于钱：要算钱得告诉它**每个模型多少钱**。价格写在插件配置的 `pricing` 里，
单位是**每 100 万 token 的美元价**（直接抄报价单）：

```yaml
pricing:
  models:
    "deepseek-chat": { input: 0.27, output: 1.10 }
    "deepseek-reasoner": { input: 0.55, output: 2.19, cacheRead: 0.055 }
    "*": { input: 0.5, output: 1.5 }
```

- `input` / `output` 至少写一个；`cacheRead` / `cacheWrite` 没写就按输入价算
  （**宁可高估**，不给偏低的数字）；
- 匹配顺序：精确 → 最长前缀（`deepseek-chat-2024-08` 会命中 `deepseek-chat`）→ `*`；
- 价格写错（负价、字符串、空行）会在启动时直接报错，不会悄悄算成 0。

```bash
curl -s 'http://127.0.0.1:3080/channel/usage?days=30' | jq
curl -s 'http://127.0.0.1:3080/channel/usage?days=7&key=qq:12345' | jq
```

返回总数与逐日明细。**成本是写入时按当时的价格算好存的**，所以调价不会改写历史金额。
没配 `pricing` 时 `pricing.configured` 为 `false`，面板会显示「未配置价格」而不是 `$0.00`。

面板「运维」视图里有「用量」卡片（最近 7 天，含成本）。

```bash
node cs-agent/usage-smoke.mjs                                  # 48 条断言
DSH_DB=1 DSH_CS_STORE=postgres node cs-agent/usage-smoke.mjs   # 63 条断言
```

细节见 [docs/refactor-p15.md](docs/refactor-p15.md)。

### 4.8 死信与人工重放

回复重试用尽（默认 5 次，退避 2s→8s→32s→2m）之后条目变成 `dead`：客户没收到，
但也不会再自动重发。这时候需要人看一眼：

```bash
# 现在有哪些死信
curl -s 'http://127.0.0.1:3080/channel/dead?limit=20' | jq

# 把某几条推回队列（不给 ids 就是全部重放）
curl -s -X POST 'http://127.0.0.1:3080/channel/replay' \
  -H 'content-type: application/json' \
  -d '{"queue":"outbox","ids":["<idempotencyKey>"],"actor":"ops-alice"}' | jq

# 谁重放过什么
curl -s 'http://127.0.0.1:3080/channel/audit?limit=20' | jq
```

规则：

- 只有 `dead` / `failed` 能被重放；`sent` 会被 `skipped`（客户不能收到两条一样的回复），
  `sending` 也会 `skipped`（那是别的实例手里的租约）；
- 重放 = 放回队列，真正投递由后台 worker 完成，**返回"已重放"不等于"已送达"**；
- 每次重放都写审计：`actor` / `targetId` / 目标会话 / 原投递次数；
- 审计落在两处：`audit_log` 表（append-only，改不了删不了，`delete` 需显式 `set local app.allow_purge = 'on'`）
  与 `<dataFile 去 .json>-audit.jsonl`（库挂了也能查的底稿）；
- 租约被别的实例接管后，本进程的重放会被拒绝（503 `LEASE_LOST`）。

```bash
node cs-agent/dead-smoke.mjs            # 23 条断言
DSH_DB=1 node cs-agent/dead-smoke.mjs   # 35 条断言
```

细节见 [docs/refactor-p9.md](docs/refactor-p9.md)。

### 4.9 数据保留与按客户删除

聊天记录不能无限期留着，客户也可能要求"把我的数据删掉"。两种情况都走同一个接口：

```bash
# 先看计划（只读，永远不删）
curl -s 'http://127.0.0.1:3080/channel/retention' | jq

# 确认后执行（必须显式 dryRun:false）
curl -s -X POST 'http://127.0.0.1:3080/channel/retention' \
  -H 'content-type: application/json' \
  -d '{"dryRun":false,"actor":"cron"}' | jq

# 按客户删除（key / senderId / groupId 三选一）
curl -s -X POST 'http://127.0.0.1:3080/channel/retention' \
  -H 'content-type: application/json' \
  -d '{"dryRun":false,"owner":{"senderId":"u123"},"actor":"dpo-carol"}' | jq
```

- 默认保留期：群聊 3 天归档 / 30 天清除；私聊 30 天归档 / 90 天清除
  （可用 `retention` 配置项或请求里的 `limits` 改）；
- **归档**只是打标记、从侧边栏摘下，客户再来消息自动恢复；**清除**是删映射 + 消息 + 用量，不可逆；
- `dryRun` 只认字面 `false`，写 `"false"` 字符串不会删东西；
- 每次归档/清除都写审计（`GET {route}/audit`），`detail.reason` 区分 `retention` 与 `owner-request`；
- `eval` 通道的会话不参与自动清理；
- `scripts/retention.mjs` 仍然负责运行时目录（`<dsh>/sessions/<id>`）。

```bash
node cs-agent/purge-smoke.mjs            # 37 条断言
DSH_DB=1 node cs-agent/purge-smoke.mjs   # 41 条断言
```

细节见 [docs/refactor-p10.md](docs/refactor-p10.md)。

### 4.9.1 自动清理（默认关闭，需显式开启）

上面那个接口可以改成**每 6 小时自动跑一次**。默认**不开**：删数据不可逆，得由人
明确同意一次。

```yaml
retentionAuto:
  enabled: true          # 默认 false；打开后才会定时清理
  everyMs: 21600000      # 默认 6 小时
  initialDelayMs: 60000  # 默认启动后等 60 秒再扫第一遍
  dryRun: false          # 想先观察就写 true（只扫描不删）
```

- 启动后先等 60 秒，避免刚起来就删一波；之后按 `everyMs` 周期跑，卸载插件时定时器会停。
- 每轮串行：上一轮没跑完就跳过这一轮，不会并发删同一批会话。
- 租约被别的实例接管时立刻停表并告警（休眠醒来的旧实例不能删别人的数据）。
- 失败不影响网关运行，只写 `lastError` + 一条 warn。
- 每次归档/清除都写审计，`actor` 是 `schedule:tick`、`role` 是 `system`。

看它到底跑没跑：

```bash
curl -s 'http://127.0.0.1:3080/channel/health' | jq '.retention'
# { "enabled": true, "everyMs": 21600000, "running": false,
#   "lastRunAt": "2026-10-27T02:54:04.529Z",
#   "lastResult": { "dryRun": false, "archived": 0, "purged": 0 },
#   "lastError": null }
```

`lastRunAt` 只要停止更新，就说明定时器停了（进程挂了 / 租约丢了 / 被配置关了）。
`lastResult` 是**最后一轮**的计数，绝大多数轮次本来就是 0——这不是没生效，
查删了什么请看 `GET /channel/audit`。运维面板的"数据保留"卡也会显示这行状态。

```bash
node cs-agent/retention-auto-smoke.mjs   # 44 条断言
```

细节见 [docs/refactor-p16.md](docs/refactor-p16.md)。

### 4.10 运维面板

浏览器打开 `http://127.0.0.1:3080/channel/panel`，侧边栏工具栏第四个按钮「运维」，
四张卡对应 P9/P10/P6 的能力，不用再 curl：

| 卡片 | 端点 | 能做什么 |
| --- | --- | --- |
| 健康 | `GET {route}/health` | 看租约是否被接管、两队列积压、数据库是否连得上、哪项检查失败 |
| 死信 | `GET {route}/dead` + `POST {route}/replay` | 看发不出去的消息并重放（单条 / 全部） |
| 数据保留 | `GET|POST {route}/retention` | 看保留期计划、确认后执行（清除不可逆） |
| 最近审计 | `GET {route}/audit` | 谁在什么时候重放/删除了什么 |

> **面板没有登录态。** 默认监听 127.0.0.1 没问题；要放到内网给多个同事用，
> 请在前面挡一层反向代理的认证，不要把 `{route}/panel` 直接暴露到公网。

界面代码在 `cs-agent/panel.js`（一个返回整页 HTML 的函数）。改它的时候注意：
面板是**模板字符串**，源文件里写的 `\n` 会被 Node 解析成真换行，要生成
浏览器端的 `
` 必须写 `\\n`。

```bash
node scripts/check-panel.mjs            # 语法 + 端点接线 + 字段契约
node cs-agent/panel-dom-smoke.mjs       # 用最小 DOM 替身真跑面板脚本（23 条）
```

细节见 [docs/refactor-p11.md](docs/refactor-p11.md)。

### 4.11 评测门禁

改知识库或检索权重之后，用门禁确认没变差。它和 `eval-rag.mjs`（打印指标，给人看）
分工不同：门禁**逐条**比基线，报"哪一条以前命中现在不中"。

```bash
node scripts/eval-gate.mjs              # 和 eval/rag-baseline.json 逐条比，回退则退出码 1
node scripts/eval-gate.mjs --update     # 确认新结果是对的之后，重记基线
node scripts/eval-gate.mjs --json       # 机器可读，交给 CI
node scripts/eval-gate.mjs --replies    # 比回复质量（先跑 scripts/eval-cs.mjs）
```

退出码：`0` 一致 / `1` 有回退 / `2` 数据不全（没基线、用例引用的条目不存在、id 重复）。

`--replies` 比三件可判定的事：以前答出来的现在空了吗、以前没兜底的现在兜底了吗、
以前没泄漏的现在泄漏了吗。措辞变化不算回退。泄漏规则在 `scripts/reply-leaks.mjs`，
`eval-cs.mjs` 与门禁共用一份。

> 基线是代码的一部分。改了知识库并确认新结果正确后必须 `--update`，否则门禁会拿旧事实
> 判新代码。`--update` 只能在人确认后手动跑，不进 `verify-all.sh`。

细节见 [docs/refactor-p12.md](docs/refactor-p12.md)。

### 4.12 访问控制

网关有三类端点，权限不同：

| 端点 | 谁能调 | 凭证 |
| --- | --- | --- |
| `GET {route}/health` | 探针、编排系统 | 默认免凭证（`healthPublic: false` 可关） |
| `POST {route}` | 平台适配器 | `inboundTokenFile`（没配则用主令牌） |
| 其余（面板/会话/配置/死信/保留期/审计） | 运维 | `tokenFile` |

不配令牌时保持全开（开发机方便），但启动日志会警告。**内网部署或前面有反向代理时
必须配**，否则任何人都能改 QQ 凭证、重放死信、清除客户数据。

```yaml
config:
  route: /channel
  tokenFile: ~/.dsh/cs-runtime/data/admin.token         # chmod 600
  inboundTokenFile: ~/.dsh/cs-runtime/data/adapter.token # 可不配，退化用主令牌
```

```bash
printf '%s\n' "$(openssl rand -hex 24)" > ~/.dsh/cs-runtime/data/admin.token
chmod 600 ~/.dsh/cs-runtime/data/admin.token
```

浏览器打开 `{route}/panel`，会看到登录页；填入令牌后换成一个 HttpOnly cookie，
之后正常使用（令牌不留在地址栏）。命令行调接口用 `-H "authorization: Bearer <令牌>"`。

> `tokenFile` 存在但读不到会**启动失败**，不会静默退化成全开——路径写错时要立刻知道。

细节见 [docs/refactor-p13.md](docs/refactor-p13.md)。

#### 4.12.1 只读令牌

值班同事要能查"客户昨天说了什么"，但不该能删会话、重放死信、改 QQ 凭证。
再配一个只读令牌就能把这两件事分开：

```yaml
config:
  tokenFile: ~/.dsh/cs-runtime/data/admin.token          # 能读能写
  viewerTokenFile: ~/.dsh/cs-runtime/data/viewer.token   # 只能读
```

```bash
printf '%s\n' "$(openssl rand -hex 24)" > ~/.dsh/cs-runtime/data/viewer.token
chmod 600 ~/.dsh/cs-runtime/data/viewer.token
```

| 角色 | 能做什么 |
| --- | --- |
| 只读（`viewerToken`） | 全部 `GET`：面板、会话列表、历史、配置查看、死信列表、审计、用量、保留期**计划** |
| 读写（`tokenFile`） | 以上全部 + 接管/交还、回复、删除、启停机器人、改凭证、重放死信、执行清除 |

只读令牌调写接口一律 **403 `FORBIDDEN`**（不是 401——换令牌也没用，是权限不够）。
面板会用 `GET {route}/whoami` 认出只读身份，隐藏删除/重放/清除按钮，侧栏显示"只读"标签。

两条启动告警值得注意：

- 只配了只读令牌没配主令牌 → `nobody can use admin endpoints`：面板能打开但什么都改不了
- 两个令牌配成同一个值 → `read-only access is not actually restricted`：限制并没有生效

只读令牌**不会**退化成主令牌：没配就是没有这个角色。

细节见 [docs/refactor-p17.md](docs/refactor-p17.md)。

### 4.13 发布包自检

`files[]` 是手工维护的，漏一个模块，装出来的包 `import` 就崩；`files[]` 里写目录，
目录里的 `.env.local` 会被一起打包。两者本机都测不出来。所以每次改动都跑：

```bash
node scripts/packaging-smoke.mjs    # 79 条：npm pack 会发什么 + 真装一次 import
```

它问 `npm pack --dry-run` 要文件清单，然后查：凭证/测试没被打包、每个 `exports` 目标
都在包里、`files[]` 路径真实存在、`dsh.bundle.patch` 跟着走、每个 JS 入口真能 import。

> 注意 npm 的一个陷阱：**包根的 `.npmignore` 不能覆盖 `files[]`**，只有子目录里的
> `.npmignore` 有效。`files[]` 里列目录时，先给那个目录放一份 `.npmignore`。

已进 `verify-all.sh`。细节见 [docs/refactor-p14.md](docs/refactor-p14.md)。

### 4.14 账号作用域

运维工单里的 `account` 目前是唯一的客户边界。不配 `accounts` 时它只是一句说明——
运维的 `ops_k8s` / `ops_logs` 在全局 `namespaces` 白名单内不受限制（通常是 `*`，
也就是整台集群）。配了之后，服务端会把它变成硬约束：

```yaml
# ops-agent/cordis.patch.yml → ops-dispatch
config:
  accounts:
    acme:
      namespaces: [acme-prod, acme-staging]
      contexts: [prod]           # 可选
      aliases: ['Acme Inc']      # 可选：客服写中文名/域名也能对上
    globex:
      namespaces: [globex]
```

生效后的三条规则：

1. **只能读本账号的命名空间**——取账号表与全局白名单的**交集**。全局写 `*` 时仍按账号收窄。
2. **必须显式写 namespace**——不写就拒绝。否则 `kubectl get pods -A` 一次扫全集群，
   输出里混进别的客户的 pod 名和报错，运维照着念给客户就成了泄漏。
3. **没写账号 / 账号不在表里 → 全部拒绝**。前者让客服补，后者让管理员补表；不猜。

拒绝信息里带着该怎么改（"让客服在 ops_handoff 里补 account"），模型不会卡死。
`ops_env` 会先报出这张工单绑定的账号和允许的命名空间，让模型提前知道边界。

**`ops_metrics` 同样受这条边界约束。** 任意 PromQL 是一个比 `kubectl` 更隐蔽的出口：

- `sum(rate(http_requests_total[5m]))` 没有标签选择器，跨全部命名空间聚合；
- `{namespace="globex-prod"}` 直接读别人的指标。

所以作用域生效时，指标查询必须显式写 `namespace` 匹配器，且值必须落在本账号的命名空间里：

```promql
{namespace="acme-prod"} rate(http_requests_total{code=~"5.."}[5m])
{namespace=~"acme-prod|acme-staging"} up        # 枚举可以，逐个列出来
```

通配正则（`namespace=~"acme-.*"`）与排除式（`namespace!="globex-prod"`）一律拒绝——
前者无法证明不会匹配到 `acme-secret-project`，后者排除掉一个客户、剩下的还是所有人。
判定发生在**发请求之前**，不是查回来再过滤。

```bash
node ops-agent/scope-smoke.mjs   # 86 条：解析、交集、强制、派单绑定、工具链路、PromQL 边界
```

细节见 [docs/refactor-p18.md](docs/refactor-p18.md) 与 [docs/refactor-p21.md](docs/refactor-p21.md)。

### 4.15 告警推送

`/health` 能查不等于有人会看。配了下面两项之后，网关每分钟自检一次，不健康时推到管理员私聊：

```yaml
# cs-agent/cordis.patch.yml → channel-gateway
alertWebhook: http://127.0.0.1:8080/reply   # 适配器的回复接口
alertTo: '管理员 QQ openid'                  # 推到这个人私聊
# alertIntervalMs: 60000     # 多久自检一次（默认 1 分钟）
# alertRepeatMs: 3600000     # 没恢复时多久再提醒（默认 1 小时）
# alertGraceMs: 15000        # 启动后多久内不报（默认 15 秒）
```

**两个都要配才生效**——只配 webhook 不知道该发给谁，只配收件人没有通道。缺一个整条链关闭，
启动日志会说缺哪个。

会报的情况：写入租约被接管、数据库连不上（严重）；队列读写失败、有死信、自动清理失败（注意）。
死信不算"网关挂了"（`/health` 仍 200），但仍然会报——客户在等一条永远不来的回复。

同一个问题只报一次，之后每小时提醒一次；恢复了会发一条"已恢复（持续 N 秒）"。

```bash
curl http://127.0.0.1:3080/channel/alerts?limit=20   # 状态 + 最近告警（只读令牌也能看）
curl http://127.0.0.1:3080/channel/health | jq .alerts
node cs-agent/alerts-smoke.mjs                       # 80 条
```

细节见 [docs/refactor-p19.md](docs/refactor-p19.md)。

### 4.16 端到端安装自检

装完之后"能不能用"不该靠人肉试。这条检查从空目录按本文档装一遍，然后让**真插件代码**
在那个 home 上跑起来，走完一条客户消息的全程：

```bash
node scripts/install-e2e-smoke.mjs   # 48 条，约 1 秒，不联网
```

它验证的是一条链，而不是一个点：

1. `setup.mjs --home <临时目录>` 在一个空 home 上装好，且从**别的目录**执行（用户不会在包目录里跑）；
2. 装完之后 `paths.js` 解析出来的 root 就是那个临时目录，`kb/` 里不只是空目录；
3. `kb-core` 加载装好的知识库，`kb_search` 能命中自带的 `example-disk-full`，判定为 `direct`；
4. 网关启动后 `/config` 读得到安装脚本写的 `QQ_APP_ID`、**不回传 secret**、`envFile` 指向装好的那份；
5. 新装默认无令牌（`auth.mode === 'open'`）并在日志里明确告警；面板 HTML 打开、`/health` 200；
6. 发一条客户消息 → 假适配器收到回复 → `data/outbox.jsonl` 留底 → `/history` 可查；
7. 关停后重新启动，同一客户拿到**同一个 session**，`/sessions` 里只有一条；
8. 全程写入都发生在装好的 home 里，凭证文件保持 `0600`。

`setup-smoke.mjs` 只证明"文件到位"，`check-plugin-apply.mjs` 只证明"`apply()` 不抛"，
两者之间的缝（路径没走 `defaultPaths()`、凭证没读到、知识库是空的、路由前缀写错）
就是这个脚本要堵的。已进 `verify-all.sh`。

细节见 [docs/refactor-p20.md](docs/refactor-p20.md)。

## 5. OCR

图片消息默认落盘成路径，模型用 `ocr_image` 读文字。

- **macOS**：运行 `tools/build-ocr.sh` 生成 Vision 二进制，装到 `<运行根>/bin/ocr`；或装 tesseract
- **Linux/Windows**：装 tesseract，然后在预设里把 `ocr` 的 `backend` 改成 `tesseract`

没有可用的 OCR 后端时，工具会告诉你缺什么，不会静默失败。

## 6. QQ 平台设置

- 机器人类型：群聊/单聊
- 群聊要能收到消息：用户必须 **@机器人**；想接收群里所有消息（含未 @ 的图片），需要在开放平台开启「接收所有消息」
- 被动回复窗口：客户最后一条消息后 **5 分钟**，同一消息最多 5 条。超时会转主动消息，需要单独申请权限

## 7. 升级

```bash
# 重新拉取包后
npx dsh-cs-setup --force     # 只更新适配器，不动知识库和凭证
# 重启 dsh
```

预设改动只对新会话生效；旧会话如果出现装配错误，网关会自动丢弃映射并重建。

## 8. 卸载

```bash
~/.dsh/cs-runtime/adapter/qq.sh stop
# 在「设置 → 插件」里移除全部本地包
rm -rf ~/.dsh/cs-runtime
```

会话日志在 `~/.dsh/sessions` 下，不会随插件删除。

## 发布到 npm

包名现在是 `@local/...`，发布前改成你自己的 scope：

```bash
node scripts/rename-scope.mjs --to @yourscope
node scripts/check-client-plugins.mjs   # 客户端模块 id 必须和包名一致
cd kb-core && npm publish --access public
cd ../cs-agent && npm publish --access public
cd ../ops-agent && npm publish --access public
cd ../cs-panel && npm publish --access public
```
