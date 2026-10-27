# P9：死信的人工重放入口

## 目标

P3 让回复"发不出去会重试"，但重试用尽之后呢？条目变成 `dead`，躺在队列里没人管：
客户那边没收到回复，运维这边也看不见——除非有人直接去翻数据库。

这一阶段补上出口：**看得见死信、能把它们推回队列、并且知道是谁推的**。

## 什么问题必须避免

重放本身很简单（`state = 'pending'`），难的是三个副作用：

1. **已经发出去的绝不能重放**。客户会收到两条一模一样的回复，比一条都没收到更糟。
2. **正在被别的进程处理的不能动**。条目处于 `sending` 说明另一个实例已经领走了它，
   这时改状态会导致同一句话发两遍（或者是两个进程各发一遍）。
3. **"谁重放的"必须留痕**。重放是绕过自动退避的人为干预，事后要能回答
   "周五晚上是谁把这三条又推了一遍"。

## 交付物

| 文件 | 内容 |
| --- | --- |
| `cs-agent/audit.js` | `auditFileFor(dataFile)`、`createAudit({kind,file,logger})`：`record(entry)` / `list(limit)` |
| `cs-agent/outbox.js` | json 队列新增 `listDead(limit)`、`replay(idempotencyKey)` |
| `cs-agent/outbox-pg.js` | pg 队列同样两个方法；`getRecord()` 提成内部函数，避免解构调用丢 `this` |
| `cs-agent/gateway.js` | `audit` 实例、`queueByName`、`replayDead`；`GET {route}/dead`、`POST {route}/replay`、`GET {route}/audit` |
| `cs-agent/dead-smoke.mjs` | 23 条（json）/ 35 条（连库） |
| `scripts/verify-all.sh` | 新增 `== dead letters`（现 38 步） |

## 三个端点

### `GET {route}/dead?limit=50`

```json
{
  "inbox": [ { "idempotencyKey": "...", "state": "dead", "attempts": 5, "lastError": "HTTP 503", "payload": { ... } } ],
  "outbox": [ ... ]
}
```

两个队列一起列，运维不用记参数。没配 webhook 时没有 `outbox` 字段（队列根本没建）。

### `POST {route}/replay`

```json
{ "queue": "outbox", "ids": ["<idempotencyKey>"], "actor": "ops-alice" }
```

- `queue`：`inbox` 或 `outbox`，其他值返回 **400**（不是 500 —— 这是调用方的错误）。
- `ids`：省略时重放**当前全部死信**（上限 100 条）。
- `actor`：写进审计。面板调用时默认 `panel`。

返回：

```json
{
  "queue": "outbox",
  "replayed": ["<key>"],
  "skipped": [ { "idempotencyKey": "<key>", "reason": "state is sent" } ]
}
```

### `GET {route}/audit?limit=50`

```json
{ "entries": [ { "actor": "ops-alice", "role": "operator", "action": "replay", "targetType": "outbox", "targetId": "<key>", "detail": { "attempts": 0, "externalKey": "qq:u1" }, "at": "..." } ] }
```

## 关键决策

### 1. 重放只接受 `dead` 和 `failed`

`sent` 重放会让客户收到两条；`sending` 重放会和别的进程抢同一条；
`pending` 本来就会自己发，不需要人管。三种都在 `skipped` 里给出原因，
而不是静默忽略——运维点了没反应比点了报错更让人困惑。

### 2. 数据库模式下用"带条件的单条 update"，不是先查再改

```sql
update outbox set state = 'pending', attempts = 0, last_error = null,
       next_attempt_at = now(), sent_at = null
 where idempotency_key = $1 and state in ('dead', 'failed')
returning ...
```

两个运维同时点重放、或者一个人在两个标签页里点两次，只有一个能改到行。
先 `select` 再 `update` 的写法在这个场景下必定出现"两边都以为成功"。

json 实现是单进程内存态，没有这个问题，但保持同样的语义（`replayed: false` 表示没动）。

### 3. 重放要经过 `assertWritable()`

租约已经被别的实例接管时，本进程不许写——重放也是写。此时抛 `LEASE_LOST`，
HTTP 层返回 503。否则会出现"已经交权的实例把死信又推进队列"的怪事。

### 4. 审计两处都写

| 落点 | 用途 |
| --- | --- |
| `audit_log` 表（append-only 触发器保护） | 能按条件查：谁在什么时候重放了哪个队列的哪条 |
| `<dataFile>-audit.jsonl` | 数据库挂了也能查的底稿；也是一份可以 `grep` 的流水 |

表写失败时退回只写文件（底稿比索引重要），两处都失败只告警——**操作已经生效了，
因为"记不上账"就把重放回滚掉更糟**。

### 5. `audit_log` 的删除需要显式开闸

建库时就加了触发器：`delete` 必须 `set local app.allow_purge = 'on'`。
所以连测试清理都要显式开闸（`dead-smoke.mjs` 里就是这么做的）。这条在真实场景里
意味着"审计记录不会被误删"——想删必须有人明确写下一行 purge 语句。

### 6. 顺带修掉的两个真问题

- **审计文件写失败会连累回复投递**：`emit()` 原来先 append jsonl 再入队，磁盘满或者
  目录不可写时整条回复直接抛错、客户什么都收不到。现在 jsonl 写入失败只告警，
  投递路径照常（丢的是可查性，不是客户的消息）。
- **在飞的回复没人等**：`observe()` 是事件回调，不能阻塞模型回合，所以回复是
  `void emit(...)` 发出的。进程优雅关停、或者测试想"等回复发完再断言"时没有抓手。
  现在有 `trackReply(promise)` 收集在飞投递，`flushArchives()` 会一并等它们落定。

## 验收

```bash
node cs-agent/dead-smoke.mjs            # 23 条
DSH_DB=1 node cs-agent/dead-smoke.mjs   # 35 条
bash scripts/verify-all.sh                # 38 步
DSH_DB=1 bash scripts/verify-all.sh       # 38 步
```

`dead-smoke.mjs` 覆盖：

- 队列契约（两种实现同一份）：死信可见、重放回 `pending` 且计数清零、已送达不可重放、未知 id 是 no-op；
- 数据库侧：审计落进 `audit_log`、**修改审计行被触发器拒绝**、审计可读、清理需开 purge 闸；
- 网关端到端：503 两次 → 死信 → `GET /dead` 看得见 → `POST /replay` → 第三次请求成功送达 →
  再重放同一条被 `skipped` 且不重复发送 → 审计记录了 `actor`/`targetId`/`externalKey` →
  未知队列 400 → 不带 `ids` 时重放全部死信 → **重放后又失败时重新变回死信**。

## 已知限制

- 死信不会自动恢复：端点持续故障时条目会一直留在 `dead`，需要人或外部定时任务触发重放。
- 重放是同步的：`POST /replay` 只把条目放回队列，真正投递由后台 worker 完成，
  所以返回"已重放"不等于"已送达"。
- 审计目前只记重放。后续的数据清理（保留期、按客户删除）也要走同一个 `audit` 实例。
- json 模式的 `listDead` / `list` 都是整份读文件；量大了要换数据库模式。

## 回滚

删掉 `cs-agent/audit.js` 与 `dead-smoke.mjs`，回退 `gateway.js` 里 `audit`/`replayDead`/
三个端点/`trackReply` 的改动，回退两个队列的 `listDead`/`replay`，从 `verify-all.sh`
移除 `== dead letters`。数据库不需要回滚（`audit_log` 表 P1 就有）。

## 下一步

- 把 `/dead` 和 `/replay` 接到面板 UI（现在只能 curl）。
- 数据生命周期：保留期到期清理、按客户删除，复用同一个审计实例。
- `usage_daily` 加单价，把 token 换成钱。
