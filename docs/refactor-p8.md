# P8：消息与用量落库

## 目标

客户问"上周那个人跟我说了什么"、主管问"这个月用了多少 token"，目前都答不上来。
原因很具体：`conversations` 表只存了会话映射，**消息正文只活在 DSH 自己的会话目录里**，
既不能按客户查，也不能聚合统计。`messages` 和 `usage_daily` 两张表在建库时就画好了，
一直空着。

这一阶段把这两张表真正用起来。

## 为什么现在做

P1～P7 解决的是"消息不丢、多实例不打架、能观察"。这些都是**平台**能力。
但用户最初的诉求是"能做到落地真实使用场景"，而真实客服团队每天要做的事是：

- 交接班时看"这个客户昨天说了什么"；
- 客户投诉时回溯"我们的机器人到底怎么回的"；
- 月底算"这个月消耗了多少 token，够不够用"。

这些都需要**业务数据留下来**。没有这一层，系统再可靠也只是个转发的管道。

## 交付物

| 文件 | 内容 |
| --- | --- |
| `cs-agent/db/migrations/0005_message_tokens.sql` | `messages` 加 `total_tokens`/`cache_read_tokens`/`cache_write_tokens`；`usage_daily` 加两个缓存列 |
| `cs-agent/time.js` | `localDay(date)` —— 本地日历日 |
| `cs-agent/store.js` | json 实现：`saveMessage`（追加 `-messages.jsonl`）、`listMessages`、`bumpUsage`（`-usage.json`） |
| `cs-agent/store-pg.js` | pg 实现：`INSERT_MESSAGE_SQL`、`LIST_MESSAGES_SQL`、`BUMP_USAGE_SQL` 与三个方法 |
| `cs-agent/gateway.js` | `archiveMessage`/`archiveUsage`/`trackArchive`/`flushArchives`；入站与回合结束处接线；`GET {route}/messages` |
| `cs-agent/message-smoke.mjs` | 26 条（json）/ 41 条（连库） |
| `scripts/verify-all.sh` | 新增 `== message archive`（现 37 步） |

## 数据从哪来

| 事实 | 来源 |
| --- | --- |
| 客户说了什么 | `runProcessInbound` 里已经拼好的 `userMessage` 的文本部分（含 `[群成员 xxx]` 前缀） |
| 平台消息 id | 入站 body 的 `messageId` |
| 机器人回了什么 | `observe` 缓冲到 `turn/end` 的那段文本 —— **与真正发给客户的那条完全一致**（包括兜底回复） |
| token 用量 | `assistant/message` 事件的 `data.usage`，一轮内多条消息累加 |

`usage` 的字段是 `inputTokens`/`outputTokens`/`totalTokens?`/`cacheReadTokens?`/`cacheWriteTokens?`，
注释里明确 **counts 是互斥的**：`inputTokens` 只含未命中缓存的输入。所以缓存读写必须单独记一列
——混进 `input_tokens` 算出来的成本会差一到两个数量级。

## 六条关键决策

1. **归档是旁路，不是主流程。**
   `archiveMessage` 自己吞掉异常、只记 `warn`。磁盘满、库挂了不能让客户的对话失败 ——
   历史是"事后要看"，不是"现在必须"。测试里专门注入了一个会抛错的 `saveMessage`，
   断言消息照样交给模型。

2. **落库用 `insert ... select from conversations`，不在内存里缓存 id。**
   维护一张 `external_key → id` 的映射，就得在删除、重建、自愈时同步，很容易脏。
   一条 SQL 直接从会话表取 id，代价是多一次索引命中，换来的是没有可失效的缓存。
   会话不存在时影响 0 行，方法返回 `false`，网关记一条 `message archive skipped`。

3. **`flushArchives()` 让"在飞的归档"可等待。**
   归档用 `void` 发起（不阻塞回复），但测试和优雅关闭需要知道"写完了没有"。
   用 `pendingArchives` 集合跟踪，`while (size > 0) await Promise.all(...)` ——
   循环而不是只等一次，因为等待期间可能又有新的归档被发起。

4. **按本地日历日统计，不按 UTC。**
   `toISOString().slice(0,10)` 是 UTC 日：东八区凌晨 0–8 点的用量会记到前一天，
   日报永远差一截。`localDay()` 按服务器本地时区算；pg 侧同时用 `to_char(day,'YYYY-MM-DD')`
   读回来，避免 `date` 被驱动转成 `Date` 再 `toISOString` 又偏一天。

5. **pg 返回值统一成 camelCase + number。**
   驱动把 `bigint` 读成字符串、`date` 读成 `Date`。不做归一化，调用方就得记住
   "这个字段是 string、那个字段是 Date"，两边实现也就没法共用一份契约测试。

6. **`forward: all` 模式下不重复计算 token。**
   逐条外发时每条回复是独立消息，token 直接挂在消息行上；`turn/end` 只累加轮数。
   否则同一批 token 会被记两遍。

## 顺带修掉的问题

- **`localDay` 的循环依赖**：一开始把 `localDay` 写在 `store.js` 并让 `store-pg.js` 反向 import，
  形成 `store.js ↔ store-pg.js` 循环。抽到 `cs-agent/time.js` 解决。**`time.js` 必须进
  `package.json` 的 `files`**，否则发布出去的包会在 import 阶段就崩。

## 验收

```bash
node cs-agent/message-smoke.mjs            # 26 条
DSH_DB=1 node cs-agent/message-smoke.mjs   # 41 条
bash scripts/verify-all.sh                 # 37 步
DSH_DB=1 bash scripts/verify-all.sh        # 37 步
```

`message-smoke.mjs` 覆盖：

- 两套实现的同一份契约：存得进、读得出、按时间正序、limit 取最新、会话之间不串、
  用量同一天累加、会话不存在时不炸；
- json：半行 JSON（写到一半崩了）不会让整份历史读不出来；
- pg：`messages`/`usage_daily` 真的落成了行，`platform_msg_id`/`trace_id`/缓存列都对得上；
- 网关：客户消息进档（含 `platformMsgId` 与 12 位 `traceId`）、一轮一条回复而不是按片段、
  用量跨片段累加、`GET /messages` 返回历史、缺 key 返回 400、人工接管的消息也进档、
  归档炸了不影响消息处理且会记日志。

## 已知限制

- **json 模式的 `listMessages` 会整份读文件。** 单机会话量小的时候无所谓；量大了就该用
  pg（或给 json 实现加索引文件）。这是有意的取舍：json 模式是"零依赖能跑"的兜底，
  不是生产形态。
- **没有保留期。** `messages` 会一直长。合规要求的"删除某个客户的数据"目前只能手工 SQL，
  下一步应做成受控的 purge 接口（`audit_log` 的 append-only 触发器已经为此留了
  `app.allow_purge` 开关）。
- **重试导致重复归档。** 入站重试（P5）若在归档之后失败，重投会再写一条 user 消息。
  `messages` 上的 `platform_msg_id` 唯一索引（partial）会让第二次插入失败并记 warn，
  不会脏数据，但日志里会有噪音。要彻底消除得把归档挪进同一事务，等 pg 模式成为唯一形态再说。
- **`usage_daily` 没有单价。** 现在是纯计数，算成钱需要模型侧的价目表。

## 回滚

```bash
git revert <this-commit>
```

回滚后归档调用点与 `/messages` 端点消失；`0005` 加的列留着不影响旧代码（全部可空或有默认值），
`message-smoke.mjs` 留在仓库里但不再被 verify-all 调用。

## 下一步

- **dead 项的人工重放入口**：队列里已经有死信，但运维只能看，不能点"再试一次"。
- **数据生命周期**：保留期 + 客户数据删除（hash 化的 purge 接口 + 审计）。
- **面板拆分**：`panelHtml` 仍是 517 行模板字符串，21 条路由靠字面量对齐。
- **审计写 `audit_log` 表**：目前审计只落 jsonl。
