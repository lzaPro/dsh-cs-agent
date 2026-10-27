# P3：回复投递从"只记账"升级成"会重发"

P3 的目标只有一句话：**适配器抖一下，客户的回复不能丢。**

重构前 `emit()` 的顺序是"追加 outbox.jsonl → 单次 POST 回复 webhook"，失败只
`ctx.logger?.warn?.()` 一句然后返回 `{delivered:false}`。那条回复就永久没了，而客户
还在等。P1 建的 `outbox` 表当时只是把结构准备好，P3 才把语义接上。

## 交付物

| 文件 | 作用 |
| --- | --- |
| `cs-agent/outbox-retry.js` | 重试策略与幂等键（两套实现共用，单独成文件避免循环依赖） |
| `cs-agent/outbox.js` | 投递队列接口 + JSON 实现（默认部署用） |
| `cs-agent/outbox-pg.js` | 投递队列的数据库实现（多实例用，`for update skip locked` 领任务） |
| `cs-agent/outbox-smoke.mjs` | 队列契约（两套实现各跑一遍）+ 网关端到端重发链路 |
| `cs-agent/gateway.js` | `emit()` 改成先入队再首发；新增 `drainOutbox`/`startOutboxWorker`；`/outbox` 端点加投递统计 |
| `scripts/verify-all.sh` | 新增 `== reply delivery` 一步 |

无新迁移：`0001_init.sql` 的 `outbox` 表结构（幂等键唯一、五态、attempts、
next_attempt_at、sent_at）当时就是照着重投语义设计的，P3 直接可用。

## 接口

```js
const outbox = createOutbox({ kind: 'json' | 'postgres', file, retry, logger })

await outbox.enqueue(envelope, { notBefore })  // -> { record, duplicate }
await outbox.claim(limit)                      // -> 租约内的到期条目（标 sending）
await outbox.markSent(idempotencyKey)          // -> record
await outbox.markFailed(idempotencyKey, error) // -> record（attempts+1，到上限转 dead）
await outbox.stats()                           // -> { kind, total, pending, sending, sent, failed, dead, due }
await outbox.list(limit)                       // -> 最近若干条
```

`record` 形状两套实现一致：`{ id, idempotencyKey, payload, state, attempts,
lastError, nextAttemptAt, createdAt, sentAt }`。

## 关键决策

### 1. 只有配了 `replyWebhook` 才启用队列

没有 webhook 的部署（本地评测、只写审计日志的场景）`emit()` 的行为与重构前**逐字节
一致**：追加 jsonl、返回 `{delivered:true}`、不创建任何状态文件。这样
`gateway-smoke.mjs` 的 109 条断言一条都不用改——它们正是这么跑的。

### 2. 队列的 kind 跟着会话存储走

`store.kind === 'postgres'` 时才用数据库队列。理由：要么全在文件、要么全在库，
不会出现"会话在库里、待发消息在某个节点的本地文件里、那个节点还挂了"。

### 3. 幂等键由内容决定，不是随机 UUID

```
idempotency_key = sha256(key | channel | at | text | mention)[0:32]
```

- 同一条回复被重复入队（进程重启后回放）→ 命中同一个键，数据库唯一约束拦住，不发两遍；
- 客户先后两条一样的"好的"因为 `at` 不同 → 仍然是两条，不会被误合并。

### 4. 入队后先给一个宽限期，再去抢

`emit()` 先 `enqueue({ notBefore: now + graceMs })` 再内联发第一次。宽限期内后台
扫描不会领走这条，避免"内联首发"和"后台重试"同时发同一条。首发成功立刻
`markSent`，宽限期就作废了。

### 5. 领取用租约，而不是简单标记

`claim()` 把条目状态改成 `sending` 并把 `next_attempt_at` 推到 `now + leaseMs`。
发送者崩在半路时，这条会在租约到期后重新变成"到期可领"，不会永远卡在 `sending`。
数据库实现用 `for update skip locked`，两个实例不会领到同一条。

### 6. 退避 2s → 8s → 32s → 2m，5 次机会后标死

QQ 被动回复窗口是 5 分钟，这套退避全部落在窗口内，来得及。第 5 次仍失败说明适配器
不是抖动而是坏了，继续重试只是把队列撑爆，所以转 `dead` 并打一条 warn。抖动默认开
（±20%），避免多实例同一毫秒重发；测试里关掉以保证断言稳定。

### 7. 首发送失败仍然返回 `{delivered:false}`

调用方（面板、`/reply`、测试）看到的语义不变，但多两个字段：

```js
{ delivered: false, error: 'HTTP 503', queued: true, attempts: 1 }
```

`queued: false` 只在"已经重试到上限、转 dead"时出现。这让"发送失败"和"彻底放弃"
在返回值上可区分。

### 8. `/outbox` 端点补上投递统计

原来只返回 jsonl 审计流水（`messages`），看不出有没有回复没发出去。现在多一个
`delivery` 字段（`stats()` 的结果）。没有队列时该字段不出现，旧客户端的解析不受影响。

## 验收

```bash
# 队列契约 + 网关重发链路（不连库）
node cs-agent/outbox-smoke.mjs                    # 30 条断言

# 连库：两套实现跑同一份契约
DSH_DB=1 node cs-agent/outbox-smoke.mjs           # 52 条断言

# 全量回归（109 条网关断言必须与基线逐条一致）
bash scripts/verify-all.sh
DSH_DB=1 bash scripts/verify-all.sh
```

实测结果：

| 场景 | 结果 |
| --- | --- |
| `node cs-agent/outbox-smoke.mjs` | 30/30 PASS，未连库时段打印 `SKIP database outbox checks` |
| `DSH_DB=1 node cs-agent/outbox-smoke.mjs` | 52/52 PASS，收尾把测试行清空（`count = 0`） |
| `node cs-agent/gateway-smoke.mjs` | 109/109 PASS，与 P0 基线逐条一致 |
| `bash scripts/verify-all.sh` | 24 步全绿，`all checks passed` |
| `DSH_DB=1 bash scripts/verify-all.sh` | 24 步全绿，`all checks passed` |

最关键的端到端断言（`outbox-smoke.mjs` 里那个本地 HTTP 服务前两次返回 503）：

- 首发返回 `{delivered:false, queued:true, attempts:1}`，队列里那条仍是"欠着"；
- 后台 worker 自动重发，第 3 次成功，最终 `stats().sent === 1`、`dead === 0`；
- 服务器一共收到 3 次请求，且**三次请求体完全相同**（同一个信封）；
- 之后再次 `drainOutbox()` 不会多收一次——已送达的不会被发第二遍。

## 已知限制

- **重试只在进程活着时进行**。进程退出后待发消息留在文件/库里，重启后由
  `startOutboxWorker()` 的首次 tick 领走，但重启本身不会被自动拉起——那是进程
  管理器（systemd/launchd/容器）的职责，不在插件范围内。
- **`acquireDataLock` 仍然限制单进程单数据目录**，所以 JSON 队列的多实例场景实际
  不存在；数据库队列的多实例能力要等 P4 把数据锁换成数据库租约才真正用得上。
- **dead 之后没有人工重放入口**：`stats()` 能看到 `dead > 0`，但目前只能手工改库。
  面板上的"重放死信"按钮属于后续工作。
- `attempts` 只统计发送失败，不统计"进程崩溃时正在发"的那次（那条走租约回收，
  计一次新的发送）。

## 回滚

```bash
# 队列是可选能力：去掉 replyWebhook 就不会创建队列，emit 回到旧行为
# （仍然写审计 jsonl，只是不重试）

# 回滚代码
git revert <P3 commit>
```

数据层无需迁移：JSON 模式的状态文件（`outbox-state.json`）删掉即可，数据库模式的
`outbox` 表本来就是 P1 建的，`truncate outbox` 就能清空积压。

## 下一步（P4）

`acquireDataLock` 仍是 PID 文件锁，所以**同一数据目录只允许一个 dsh 进程**，这是
"能落地真实使用"最大的结构性限制。P4 把它换成数据库租约/心跳，让多实例真正可行；
同时把入站改成"先收下再落库"（当前数据库抖动时入站会直接失败）。
