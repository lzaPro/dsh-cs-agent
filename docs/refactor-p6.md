# P6：可观测性与健康检查

## 目标

重构前整条链路的日志只有 `ctx.logger.warn`，没有 traceId、没有健康检查端点、没有队列积压。
真实部署下会卡在两件小事上：

- 客户说"刚才那条消息没回"，运维翻日志只见一堆 `channel-gateway: xxx`，**分不清哪行属于哪条消息**。
  一条消息要跨"受理 → 建会话 → 唤醒模型 → 模型回复 → 投递适配器"五段异步流程，中间还可能重试。
- 编排系统（systemd / K8s / 宝塔）无法判断"这个网关现在能不能干活"。进程活着不等于能用：
  租约可能被别的实例接管了，数据库可能连不上，队列可能读不出来。

## 交付物

| 文件 | 内容 |
| --- | --- |
| `cs-agent/trace.js` | `newTraceId()` / `currentTraceId()` / `withTrace()` / `tracePrefix()`，基于 `AsyncLocalStorage` |
| `cs-agent/gateway.js` | 入站生成 traceId 并全程传递；`warn()` 统一前缀；新增 `GET <route>/health`；`createGateway` 接收 `{lease}` |
| `cs-agent/health-smoke.mjs` | 22 条（json）/ 28 条（连库） |
| `scripts/verify-all.sh` | 新增 `== health`（现 27 步） |

## 追踪 id 怎么走

```
POST /channel
  └─ inbound()            生成 12 位 traceId，withTrace() 包住整个受理链
      ├─ envelope.traceId        → 进队列 payload（后台重试时用它重建上下文）
      ├─ 审计 jsonl 行            → 每行带 traceId
      ├─ 模型消息 source.traceId  → 模型侧也能看到这条消息的来源 id
      └─ 回复信封 traceId         → 适配器侧日志能对上
```

日志侧不需要传参：`warn()` 直接读 `tracePrefix()`，凡在 trace 上下文里打的日志自动变成
`[a1b2c3d4e5f6] channel-gateway: ...`。

后台重试走 `drainInbox`，那里没有请求上下文，所以 `processInbound` 用信封里的 `traceId`
重建 —— 一条消息的首次处理和后续重试可以用同一个 id 串起来。

## `/health` 返回什么

```json
{
  "ok": true,
  "uptimeMs": 123456,
  "route": "/channel",
  "store": { "kind": "postgres" },
  "lease": { "kind": "postgres", "lost": false },
  "queues": { "inbox": { "pending": 0, "sent": 42, "dead": 0 }, "outbox": null },
  "database": { "ok": true, "version": "PostgreSQL 18.4 ...", "target": "postgres://cs_agent@127.0.0.1:55432/cs_agent" },
  "checks": [
    { "name": "lease", "ok": true, "detail": "postgres" },
    { "name": "inbox", "ok": true, "detail": "0 pending, 0 dead" },
    { "name": "database", "ok": true, "detail": "PostgreSQL 18.4 ..." }
  ]
}
```

- `ok` 全部为真返回 **200**，否则 **503**（探针直接用状态码即可）。
- `checks` 是判定的明细，出问题时能一眼看出是哪一项。
- 没有配置 `replyWebhook` 时没有 `outbox` 检查；json 模式下 `database` 是 `null`。

## 五条关键决策

1. **用 `AsyncLocalStorage` 而不是给每个函数加 traceId 参数。**
   受理链路有十几层调用，加参数要改二十多个函数签名，且新代码漏传就是静默丢 id。
   `AsyncLocalStorage` 一次 `withTrace()` 全覆盖，日志工具直接读上下文。

2. **traceId 同时走两条路：上下文（进程内）和信封（跨重试）。**
   只靠上下文的话，后台重试没有请求上下文，重试日志的 id 会断；只靠信封的话，
   函数内部打日志还得手动拼。两者都做，代价是一个字段。

3. **`traceByKey` 只在内存里，重启后为空。**
   把 traceId 持久化到会话表得不偿失（每条消息都写一列，只为日志）。
   重启后新消息有 id，旧消息的回复没有 —— 文档里写明，不假装完美。

4. **健康检查绝不因为探测失败而抛错。**
   `/health` 里每一段都套了 `statSafely` / try-catch。探针拿到 500 只会让编排系统
   误判"整机故障"，而真实原因往往只是数据库暂时连不上；返回 503 + 具体 checks 才有用。

5. **`lease` 从 `apply()` 传进 `createGateway()`，而不是让网关自己去抢。**
   抢租约是插件激活的一部分（P4 的职责），网关只报告状态。这样 `/health` 能答出
   "这个实例是文件锁还是数据库租约、有没有被接管"，而不用重复实现一遍抢锁逻辑。

## 验收

```bash
node cs-agent/health-smoke.mjs                                  # 22 条
DSH_DB=1 DSH_CS_STORE=postgres node cs-agent/health-smoke.mjs   # 28 条
node cs-agent/gateway-smoke.mjs                                 # 109 条，与基线逐条一致
bash scripts/verify-all.sh                                      # 27 步
DSH_DB=1 bash scripts/verify-all.sh                             # 27 步
```

覆盖：12 位 traceId、health 200/503、store/lease/queue 字段、json 模式无 database、
每次入站 id 不同、**回复信封带触发它的那条消息的 traceId**、租约被接管时 503 且
`lease` 检查项为 false、没有挂租约时报告 `not attached` 而不抛错、连库模式带上
数据库探针与版本号。

## 顺带修掉的真 bug

`inboxKey()` 的内容指纹用 `\u0000` 拼接后直接当幂等键，`DSH_CS_STORE=postgres` 时
写进 `jsonb` payload 会报 `22P05: \u0000 cannot be converted to text` ——
**没有 messageId 的入站消息在数据库模式下会直接崩**。改成对指纹取 sha256 前 32 位。

这个 bug 是 `health-smoke` 的连库模式暴露出来的，之前的测试都只跑 json 路径或者带
messageId，正好漏掉了。

## 已知限制

- **重启后旧消息的回复没有 traceId。** 见决策 3。
- **`/health` 每次都会查一次数据库和队列统计。** 探针频率高（<5s）时开销可见，
  后续可以加缓存或把数据库探针改成可选的 `?deep=1`。
- **没有指标（Prometheus / OpenTelemetry）。** 当前是"能回答能不能干活"，还不是
  "能画趋势图"。真实规模上来之前不值得引入这套依赖。
- **审计只写 jsonl 文件，没写 `audit_log` 表。** 表结构在 P1 就建好了，但面板操作
  还没有接进去；下一步再做。

## 回滚

```bash
git revert <this-commit>
```

`trace.js` 与 `/health` 是纯增量：回滚后 `warn()` 回到裸 `ctx.logger.warn`，
`/health` 消失，其余行为不变。

## 下一步

P7：写入路径收口 —— `lease.lost` 现在只是置了标志位，还没有真正拦住写入。
租约被别的实例接管后，这个实例继续写就是数据竞争。要做的是在
`persist()` / `emit()` / 队列写入前检查 `lease.lost` 并拒绝，同时把这类拒绝
记成明确的错误而不是静默丢。
