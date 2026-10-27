# P5：入站先收下再处理

## 目标

重构前 `cs-agent/gateway.js` 的 `inbound()` 是**一个同步函数做完所有事**：

```
归一化 → 去重 → 限流 → 下载附件 → 建/恢复 DSH 会话 → 落盘会话映射
       → 拼 userMessage → agent.followup（唤醒模型）→ 记去重窗口
```

中间任何一步抛错，这条客户消息就**没了**：HTTP 层把错误回给适配器，而适配器不保证重投。
真实会踩的场景：

- 客户发了 4 张截图，第 3 张下载超时（`AbortSignal.timeout(8000)`）→ 整条消息丢弃；
- DSH 那边 `resume` 卡住 15 秒超时 → 消息丢弃；
- 会话映射写入磁盘时磁盘满 / 权限错 → 消息丢弃，且去重窗口没记，平台若重投会再炸一次。

目标：**收下了就一定要处理，处理不了就还在队列里**。

## 为什么排在这里

P2 有了存储层（决定队列落文件还是落库）、P3 已经把"持久队列 + 幂等 + 领取租约 + 指数退避 +
死信"这套机制做完并测过（`outbox.js` / `outbox-pg.js`）。入站队列与投递队列是同构的，
所以 P5 主要是**接线**，不是重写机制。

## 交付物

| 文件 | 内容 |
| --- | --- |
| `cs-agent/inbox.js` | `createInbox()`：按存储类型建入站队列；`inboxKey()`：消息身份派生的幂等键 |
| `cs-agent/db/migrations/0004_inbox.sql` | `inbox` 表（形状同 `outbox`，`sent_at` 表示处理完成时间） |
| `cs-agent/outbox.js` | 支持 `options.stateFile`（入站队列没有审计 jsonl）；入队支持调用方指定幂等键 |
| `cs-agent/outbox-pg.js` | 表名参数化（`outbox` / `inbox` 白名单），两个队列共用一份并发逻辑 |
| `cs-agent/gateway.js` | `inbound()` 拆成受理 + `processInbound()`；新增 `drainInbox()`；worker 同时扫两个队列；`/status` 带队列积压；新增 `GET <route>/inbox` |
| `cs-agent/inbox-smoke.mjs` | 两套实现的契约 + 网关"收下即受理"的 6 个场景 |
| `scripts/verify-all.sh` | 新增 `== inbound accept`（现 26 步） |

## 接口

```js
const inbox = createInbox({ kind: 'json' | 'postgres', file, retry, logger })
await inbox.enqueue(envelope, { notBefore })   // 幂等入队
await inbox.claim(limit)                       // 领取（加租约）
await inbox.markSent(key) / markFailed(key, error)
await inbox.stats() / list(limit) / get(key)
```

`envelope` 的形状：

```js
{
  key,               // 会话 key（私聊按人 / 群聊按群）
  channel, at, messageId,
  idempotencyKey,    // 消息身份派生，不含时间戳
  message,           // 归一化后的完整消息
}
```

## 七条关键决策

1. **入队即受理，首投在同一请求里做。**
   落库成功就算收下，然后立刻试一次真正的处理。成功就直接返回，调用方和用户都感知不到队列
   存在；失败才退回"后台重试"。这样既保证了可靠性，又不改变正常路径的时延与返回值形状
   —— `gateway-smoke.mjs` 的 109 条断言一条不改。

2. **幂等键只由消息身份决定，绝不含时间戳。**
   初版复用了投递队列的 `outboxKey(envelope)`，而信封里有 `at: new Date().toISOString()`，
   同一个 `messageId` 每次重投都算出不同的键 —— 平台重投会排两条、客户被回两遍。
   现在 `inboxKey()` 优先用 `channel:msg:<messageId>`，没有 id 时才退化成内容指纹。

3. **去重窗口在受理时记，而不是处理完才记。**
   消息一旦进了队列，后续重投必须被挡住（否则队列里和直接处理两边都跑）；
   队列里那份由后台重试保证送达，不会被去重误伤 —— 重试走的是 `processInbound()`，
   不经过 `inbound()` 的判重。

4. **入站队列永远启用，不受 `replyWebhook` 影响。**
   投递队列（P3）只在配了 webhook 时才建，因为没有 webhook 就没有"重发"这回事。
   但入站消息必须处理，与有没有 webhook 无关。

5. **限制类错误仍然在受理前抛。**
   限流（`RATE_LIMITED`）、字段校验失败都发生在入队之前，语义与重构前一致：
   这类请求不该进队列，进了也只是排队等失败。`gateway-smoke` 的 429 断言因此仍然成立。

6. **两套队列共用一份实现。**
   `outbox-pg.js` 的表名走白名单（`outbox` / `inbox`），任何外部字符串都不拼进 SQL。
   JSON 实现通过 `options.stateFile` 支持"没有审计 jsonl 的队列"。避免为入站再写一遍
   `for update skip locked`、租约、退避 —— 那是最容易写出并发 bug 的一段。

7. **处理失败不抛给调用方，返回 `accepted: true` + 原因。**
   HTTP 层沿用原来的 202（`duplicate === true` 时 200）。适配器看到 202 就不会重投，
   重试责任在网关这边，避免"网关在重试 + 平台也在重试"造成重复唤醒。

## 验收

```bash
node cs-agent/inbox-smoke.mjs            # 26 条（json + 网关集成）
DSH_DB=1 node cs-agent/inbox-smoke.mjs   # 38 条（加 postgres 契约）
node cs-agent/gateway-smoke.mjs          # 109 条，必须与基线逐条一致
bash scripts/verify-all.sh               # 26 步
DSH_DB=1 bash scripts/verify-all.sh      # 26 步
```

入站队列段覆盖：

- 入队产生 pending；平台重投同一条不排第二次（幂等键 = 消息身份）；
- 领取加租约，同一批不会被领两次；已处理的永不重领；
- 失败自动累加 attempts、保留原因、按退避重排；重启后未处理项仍在；
- **网关：建会话失败时消息仍被受理（不抛错）并留在队列，环境恢复后由后台扫描补上**；
- 重试用尽标 `dead`，且 dead 项永不唤醒模型；
- 限流在受理前拒绝，被拒的消息不进入队列。

## 已知限制

- **`agent.followup` 之后、`markSent` 之前崩溃会重复喂一遍。** 属于 at-least-once，
  窗口是一次函数返回的时间。要做到 exactly-once 需要模型侧支持消息去重，成本远大于收益。
- **没有 messageId 的消息靠内容指纹去重。** 用户真的连发两遍一模一样的话会被合并成一条。
  需要区分时把 `dedupeByContent` 设成 `false`。
- **dead 项没有人工重放入口。** 目前只能从 `GET <route>/inbox` 看到，或直接改库。
  运维面板上的重放按钮属于后续阶段。
- **JSON 模式下队列状态文件会积累已处理记录。** 与其他队列一样只保留最近 500 条。
- **`/status` 每次都读队列统计。** 数据库模式下会查一次 `group by`，被面板轮询时开销可见；
  后续可以加缓存或改成只在展开时查。

## 回滚

```bash
git revert <this-commit>
```

回滚后 `inbound()` 回到同步一路做完，`inbox.js` / 0004 迁移留在仓库里不被调用。
已应用的 0004 不影响其它功能（`inbox` 空表）。

## 下一步

P6：可观测与运维面。目前只有 `ctx.logger.warn`，没有 traceId 贯穿、没有指标、没有
`/health`。真实部署里"为什么这条消息没回"需要能顺着一个 id 查完全链路。
