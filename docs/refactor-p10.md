# P10：数据生命周期（保留期 + 按客户删除）

## 目标

一个真实客服系统迟早要回答两类问题，而且都是**别人替我们定的期限**：

- "聊天记录留多久？" —— 合规或内部制度给一个数字，到期就该消失；
- "客户要求删掉他的数据" —— 不是"隐藏"，是**真的不能留**。

重构前 `scripts/retention.mjs` 已经能做"归档 / 清除"，但它有两个硬约束：
只能改 json 文件、只处理运行时目录。一旦切到 `DSH_CS_STORE=postgres`，
`conversations` / `messages` / `usage_daily` 三张表里的数据就没人管了。

这一阶段把生命周期做成两套存储都认的能力，并且**每一次删除都留痕**。

## 三种删除，别混

| 动作 | 含义 | 可逆 | 影响范围 |
| --- | --- | --- | --- |
| 归档 | 打 `archivedAt`、从工作区摘下 | 是（客户再来消息自动恢复） | 侧边栏可见性 |
| 清除 | 删映射 + 消息 + 用量 | 否 | 业务数据 |
| 停用 | 知识条目 `retired` | 是 | 知识库，与本流程无关 |

混用的后果很具体：把"归档"当"删除"用，客户投诉时就找不回上下文；
把"删除"当"归档"用，就是把该销毁的数据留在了库里。

## 交付物

| 文件 | 内容 |
| --- | --- |
| `cs-agent/retention.js` | `DEFAULT_RETENTION`、`retentionLimits()`、`scopeOf()`、`planRetention()`、`planPurgeByOwner()`、`describePlan()` |
| `cs-agent/store.js` | `purgeConversation(key)`：删映射 + 重写消息 jsonl + 清用量行 |
| `cs-agent/store-pg.js` | `purgeConversation(key)`：删会话行，`messages` / `usage_daily` 靠 `on delete cascade` |
| `cs-agent/gateway.js` | `runRetention(body)`、`GET {route}/retention`、`POST {route}/retention` |
| `cs-agent/purge-smoke.mjs` | 37 条（json）/ 41 条（连库） |
| `scripts/retention.mjs` | 头部补分工说明（运行时目录 vs 业务数据） |
| `scripts/verify-all.sh` | 新增 `== retention`（现 39 步） |

## 接口

### `GET {route}/retention`

只读，永远算一遍计划不写：

```json
{
  "dryRun": true,
  "mode": "retention",
  "archive": [ { "key": "qq:group:123", "scope": "group", "ageDays": 5 } ],
  "purge": [ { "key": "qq:group:456", "scope": "group", "ageDays": 41, "archivedAt": "..." } ],
  "limits": { "groupArchiveDays": 3, "groupPurgeDays": 30, "privateArchiveDays": 30, "privatePurgeDays": 90 },
  "at": "2026-10-27T01:30:00.000Z"
}
```

### `POST {route}/retention`

```jsonc
{
  "dryRun": false,                       // 默认 true，必须显式写 false 才真删
  "limits": { "groupPurgeDays": 15 },    // 可选：这一轮临时保留期
  "owner": { "senderId": "u123" },       // 可选：按客户清除（key / senderId / groupId）
  "actor": "dpo-carol"                   // 写进审计
}
```

真删时返回 `{ dryRun: false, archived: [...], purged: [...], summary: "2 to archive, 1 to purge" }`；
按客户清除时返回 `{ mode: "owner", purged: [...] }`。

## 关键决策

### 1. 默认 dry-run，且只认字面 `false`

会删数据的接口不该在 curl 一发下去就生效。`body.dryRun !== false` 才算 dry-run，
所以 `"false"`（字符串）、`0`、`null` 全都是干跑。写错一个引号删掉客户数据，
这种事故不值得用"少写一个字段"来换。

### 2. 先归档后清除，同一轮不重叠

`planRetention` 对每个会话只会进其中一个列表：已归档且超清除期的进 `purge`，
未归档且超归档期的进 `archive`。否则审计里会出现"刚归档就被删"的记录，
运维会怀疑系统是不是算错了。

### 3. 配置写反时抬清除日，而不是照字面执行

`groupPurgeDays: 3` + `groupArchiveDays: 30` 明显是写反了。照字面执行的结果是
**每次跑都直接清掉本该先归档的会话**。所以 `retentionLimits()` 把清除日钳到归档日之后。

### 4. `eval` 通道不参与自动处理

评测会话的时间戳是测试自己造的，跑一轮评测就可能全部"过期"。
自动清理把它们删掉会让评测结果不可复现，所以直接跳过。

### 5. 按客户清除只认真实存在的维度

`owner` 支持 `key` / `senderId` / `groupId`——这些是记录里真有的字段。
**没有 `tenantId`**：多租户还没做，提供一个匹配不到任何东西的 `tenantId` 参数
只会让人以为隔离已经生效。三个都不给时直接抛错，而不是"匹配全部"。

### 6. 清除必须连消息和用量一起删

只删映射等于"假装删了"：`messages` 里客户的原文还在。
- json：重写 `-messages.jsonl` 过滤该 key，清掉 `-usage.json` 里 `|<key>` 结尾的行；
- pg：删 `conversations` 行，`messages` 与 `usage_daily` 靠外键 `on delete cascade` 一起走。

`inbound_dedupe` **故意保留**：它按平台消息 id 存在，删掉会让平台重投的老消息
被当成新消息再处理一遍。里面没有客户内容，只有 id 和时间。

### 7. 删除动作一律写审计

| action | 触发 |
| --- | --- |
| `archive` | 保留期归档 |
| `purge` + `detail.reason = 'retention'` | 保留期清除 |
| `purge` + `detail.reason = 'owner-request'` | 按客户删除 |

审计记录里保留了被删会话的 key 和删除原因——数据没了，但"删过什么、谁要求删的"
必须查得到。这是合规审计和"删干净了"之间的取舍，写进文档而不是藏着。

### 8. 租约丢了就不能删

清除走 `assertWritable()`：租约已被别的实例接管时返回 503 `LEASE_LOST`。
读计划（`GET`）不受影响——看计划是只读操作。

## 与 `scripts/retention.mjs` 的分工

| 数据 | 归属 | 工具 |
| --- | --- | --- |
| `<dsh>/sessions/<id>` 目录、workspace.json | 运行时存储布局 | `scripts/retention.mjs` |
| `conversations` / `messages` / `usage_daily` | 业务数据 | `GET|POST {route}/retention` |

网关不该去动运行时的目录布局（那是 DSH 自己的事），脚本也不该去写业务表
（它不知道队列、租约、归档旁路这些语义）。用 postgres 部署时两边都要跑，
`scripts/retention.mjs` 的头部已经写清楚了。

## 验收

```bash
node cs-agent/purge-smoke.mjs            # 37 条
DSH_DB=1 node cs-agent/purge-smoke.mjs   # 41 条
bash scripts/verify-all.sh                # 39 步
DSH_DB=1 bash scripts/verify-all.sh       # 39 步
```

`purge-smoke.mjs` 覆盖：

- 规划函数：默认 3/30、30/90；归档与清除互斥；`eval` 跳过；写反的配置被钳住；
  按客户匹配（`senderId` 不匹配群会话、`groupId` 匹配群会话、无过滤条件报错）；
- 存储层：清除后重建实例读同一份存储看不到该会话，**但别的会话和它的消息都还在**；
- 数据库：会话行消失、消息级联消失、`usage_daily` 不留下孤儿行；
- 网关：`GET` 永远是干跑、`dryRun:"false"` 字符串不算真删、真删后归档/清除各就各位、
  消息一起没了、审计记下 `actor` 与 `reason`、按客户删除只删那一个人、
  租约丢失后拒绝删除（503）但读计划仍然可用。

## 已知限制

- 没有自动调度：保留期需要外部 cron 定时 `POST {route}/retention {"dryRun":false}`。
- 清除是同步逐条执行的，上千个会话时这个请求会慢；量大要改成后台任务。
- 消息按会话整体清，没有"只删 90 天前的消息"这种粒度。
- `eval` 会话只能手工清除。
- 审计里的 key 没有做哈希脱敏（要能对上被删的是哪个会话）。真要脱敏得同时保留可逆映射，
  那是另一个决定。

## 回滚

删掉 `cs-agent/retention.js` 与 `purge-smoke.mjs`，回退 `gateway.js` 里 `runRetention`
与两个端点、两个 store 的 `purgeConversation`，从 `verify-all.sh` 移除 `== retention`。
`scripts/retention.mjs` 只是加了注释，行为未变。数据库无需回滚。

## 下一步

- 面板上的"数据管理"页：看计划、确认删除（现在只能 curl）。
- 定时任务：`cron` 每天跑一次保留期，`actor` 记 `cron`。
- `usage_daily` 加单价，把 token 换算成钱。
