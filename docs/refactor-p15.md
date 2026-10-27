# P15：用量与成本（"这个月花了多少"要能答）

## 起因

P8 把消息与用量落了库：`messages` 存正文，`usage_daily` 按天累计轮数与 token
（输入/输出/缓存读/缓存写都分开记）。表建好了，数据也在往里写。

但真实场景里老板问的第一个问题不是"用了多少 token"，是**"这个月花了多少钱"**。

而当时系统里没有任何地方能回答它：token 数有了，单价不知道；模型换了也没记录，
所以连"按哪个价算"都定不下来。

更要紧的是**成本必须写时计算，不能读时乘**：

- 读时乘：一调价，历史报表全变。上个月的对账单和这个月对不上，没法跟财务解释。
- 写时算：每条记录当时的成本，调价只影响以后。对账单永远一致。

所以这一阶段的核心决定是：**成本在写入时按当时的价格算好、以整数存下来**。

## 关键事实（先确认能不能拿到模型）

钱 = token × 单价，单价是**按模型**定的。所以第一个问题是：事件里有没有模型 id？

查 DSH 的类型定义：

- `packages/core/session/lib/types/types.d.ts` 的 `SessionEventMap['assistant/message']`
  带 `usage?: TokenUsage`；
- `packages/llm/llm/lib/types/types.d.ts:160` 的 `TokenUsage` 字段是
  `inputTokens` / `outputTokens` / `totalTokens?` / `cacheReadTokens?` /
  `cacheWriteTokens?`，注释明确写 counts 是 **DISJOINT**（`inputTokens` 只含未命中缓存的输入）；
- `packages/llm/llm/lib/types/message.d.ts:5-20` 的 `AssistantProviderMetadata`：
  `message.source = { kind: 'model', provider, model }`。

结论：**能拿到 `model` 和 `provider`**，成本可以精确到片段。

这点很关键，因为一轮对话里模型可能变（重试换供应商、超时降级、主模型不可用）。
用"整轮总 token × 一个平均单价"是错的。

## 交付物

| 文件 | 作用 |
|---|---|
| `cs-agent/pricing.js`（新） | 价格配置解析、单价匹配、micro-USD 换算、格式化。纯函数，无 IO |
| `cs-agent/db/migrations/0006_usage_cost.sql`（新） | `messages` 加 `model`/`provider`/`cost_micros`；`usage_daily` 加 `cost_micros` |
| `cs-agent/store.js` | `bumpUsage` 累加 `costMicros`；新增 `listUsage(query)` |
| `cs-agent/store-pg.js` | 同上；`BUMP_USAGE_SQL` 加 `cost_micros`；新增 `LIST_USAGE_SQL` |
| `cs-agent/time.js` | 新增 `usageWindowStart(days, now)`（"最近 N 天"的起始日期） |
| `cs-agent/gateway.js` | 解析 `pricing` 配置；逐片段按模型算钱；`GET {route}/usage` |
| `cs-agent/panel.js` | 运维视图加「用量」卡片 |
| `cs-agent/usage-smoke.mjs`（新） | 价格函数 + 两套存储契约 + 网关集成 |
| `scripts/check-panel.mjs` | 补用量卡片的标记与 `/usage` 字段契约 |

## 单位：为什么存整数

配置里写的是**每 100 万 token 的美元价**——模型报价单就是这么写的，运营商直接抄，不用换算。

存进数据库的是 **micro-USD 整数**（1e-6 美元）。两个理由：

1. **浮点会漂**。一千次 `0.0000004` 累加，误差足够让月度对账差出几分钱。整数不会。
2. **换算恰好整齐**：`tokens × (USD / 1e6) × 1e6 = tokens × USD`，
   所以 `micros = round(tokens × pricePerMillion)`，连除法都不需要。

## 配置形状

```yaml
pricing:
  currency: USD
  models:
    "deepseek-chat": { input: 0.27, output: 1.10 }
    "deepseek-reasoner": { input: 0.55, output: 2.19, cacheRead: 0.055 }
    "*": { input: 0.5, output: 1.5 }
```

四条规则：

1. **`input` / `output` 至少写一个**，另一个缺省时取已有的那个。都没写就直接报错——
   空价格行等于悄悄算 0，比崩更危险。
2. **`cacheRead` / `cacheWrite` 没写就按输入价**。这是**偏保守**的假设
   （缓存读实际比输入便宜很多），宁可高估成本，也不要给老板一个偏低的数字。
3. **匹配顺序：精确 → 最长前缀 → `*`**。供应商常给 `deepseek-chat-2024-08` 这种带日期
   的号，前缀匹配让它自动命中 `deepseek-chat` 那行，不用每次上新版本都改配置。
4. **价格写错在启动时抛**。负价、字符串、拼错字段名，全部当场报
   `pricing: "input" for model "x" must be a non-negative number, got -1`。
   这类错误如果放过，报表会长期偏小，而没人会发现。

## 三个容易做错的地方

### 一、成本要按片段算，不能按整轮算

`assistant/message` 事件是逐片段来的，每个片段自带 `usage` 和自己的 `source.model`。
所以在 `assistant/message` 里就地算好这一段的花费并累加：

```js
const source = event.data?.message?.source
const model = typeof source?.model === 'string' ? source.model : undefined
const fragmentCost = usage === undefined ? 0 : costMicros(usage, priceFor(pricing, model))
```

`turn/end` 时把累加的 `costMicros` 一次性写进 `usage_daily`。

集成测试就是照这个场景写的：一轮里两个片段分别用 `alpha`（2200 micros）和
`beta`（2000 micros），断言当天合计 4200。如果实现成"整轮乘一个价"，这个断言必挂。

### 二、逐条外发模式不能重复计费

`forward: 'all'` 时每个片段是一条独立消息，token 已经挂在各条消息上。
这时日报只计轮数，成本和 token 都不能再进日报——否则同一批 token 算两遍。

这和 P8 处理 token 的口径完全一致，`costMicros` 跟着同一条分支走：

```js
...(forward === 'all'
  ? {}
  : { inputTokens: ..., outputTokens: ..., costMicros: accumulated?.costMicros ?? 0 })
```

### 三、"没配价格"和"用量是 0"必须能区分

两种情况下 `costMicros` 都是 0，报表上都是 `$0.00`——但含义完全不同：
一个是"这个月没花钱"，另一个是"我不知道花了多少"。

所以 `/usage` 明确返回 `pricing.configured`（由 `pricingReady()` 算，全 0 的价格表算没配），
面板看到 false 就显示「未配置价格」而不是 `$0.00`，并提示去哪儿配：

```
成本        未配置价格
在插件配置里写 pricing.models 才能算钱；现在只统计 token。
```

## `GET {route}/usage`

```
GET /channel/usage?days=30&key=qq:u1
```

```json
{
  "days": 30,
  "pricing": { "configured": true, "currency": "USD" },
  "totals": {
    "turns": 2, "inputTokens": 1100, "outputTokens": 550,
    "cacheReadTokens": 200, "cacheWriteTokens": 0,
    "costMicros": 4700, "cost": "$0.0047"
  },
  "rows": [
    { "day": "2026-10-27", "key": "qq:u1", "turns": 1,
      "inputTokens": 1100, "outputTokens": 550, "costMicros": 4200, "cost": "$0.0042" }
  ]
}
```

- `days` 缺省 30，上限 365；非法值（`?days=abc`）回落到 30，不报错——
  这是个看报表的接口，因为手滑参数就 400 不合适。
- `key` 可选：给了就是单个客户，不给就是全站。
- 每行都带格式化好的 `cost`：面板不该自己再实现一遍换算。
- `totals.costMicros` 是精确值，`totals.cost` 是给人看的；对账用前者。

## 面板

运维视图新增「用量」卡片（插在健康与数据保留之间）：

- 最近 7 天的轮数、输入/输出/缓存读 token、成本；
- 逐日明细，每天一行；
- 没配价格时显示「未配置价格」并提示怎么配；
- 「刷新」按钮单独拉一次 `/usage?days=7`。

## 验收

```bash
node cs-agent/usage-smoke.mjs              # 48 条断言
DSH_DB=1 node cs-agent/usage-smoke.mjs     # 63 条断言（多 15 条数据库断言）
node scripts/check-panel.mjs               # 7 条
node cs-agent/gateway-smoke.mjs            # 109 条，与基线逐条一致
bash scripts/verify-all.sh                 # 37 步，993 条断言
DSH_DB=1 bash scripts/verify-all.sh        # 37 步，1142 条断言
```

`usage-smoke` 覆盖：

- 价格函数：空配置、缓存价缺省、只给一个价、负价/字符串/空行/数组全部报错、
  精确与前缀与 `*` 三种匹配、百万 token 等于报价、分数价取整、全 0 算没配、
  三种格式化；
- 两套存储同一份契约：成本累加、报表按天一行、按会话过滤、窗口过滤、消息带模型与成本；
- 网关集成：一轮两模型分开计价、未知模型走 `*`、`/usage` 总数与格式化、
  按会话过滤、非法 `days` 回落、没配价格明说未配置、逐条外发模式不重复计费；
- 数据库断言：`usage_daily.cost_micros` 真落行、`messages.model`/`cost_micros` 真落行、
  删会话时用量行跟着走。

## 已知限制

1. **价格变了，历史成本不变**——这是刻意的（见"起因"）。想知道"如果按新价会多少"，
   得另写一个换算，不该改历史行。
2. **JSON 模式的 `listUsage` 整份读文件**。用量文件是"每天每会话一行"，一年也
   就几千行，还能接受；真到几十万行要换数据库。
3. **没有预算与告警**。现在只能事后查，不能"超过 X 就通知"。
4. **`currency` 只是标记，不做汇率换算**。写 USD 就按 USD 显示。
5. **没有按模型拆分报表**。一个客户一天用了两个模型，日行只有合计。
   要看模型维度得查 `messages`（那里每条都记了 `model`）。

## 回滚

```bash
git revert --no-commit <p15 提交>
# 0006 迁移只加列，回滚代码不会让数据库不可用；要干净回退：
DSH_DB=1 node -e "…drop column…"   # 或 ./scripts/db-down.sh --purge 重来
```

代码回滚后 `pricing` 配置项会被忽略（未知配置不报错），`/usage` 端点消失，
`usage_daily` 里已有的 `cost_micros` 列留着不影响任何旧代码。

## 下一步

- **P16：保留期自动跑**。`runRetention` 现在只能手动点或 curl；加个内置定时器，
  让它按配置每天跑一次并写审计。
- 之后候选：预算告警（超过阈值写审计 + 面板高亮）、按模型拆分的报表、
  `usage_daily` 加单价快照（便于解释历史金额）。
