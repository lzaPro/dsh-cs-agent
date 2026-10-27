# P16：保留期自动跑（默认关闭，要显式打开）

## 一、为什么要做

P10 把"删数据"这件事做出来了，但只做成了**一个端点**：

```
GET  /channel/retention          → 看计划
POST /channel/retention {dryRun:false} → 真删
```

端点的问题不是能力不够，是**没人会记得点**。合规要的是"数据到期真的被删了"，
而一个需要人每周手动触发的清理，等于把这项义务又推回给人的记忆。三个月后有人
问"客户会话保留多久、真的删了吗"，答案只能是一个尴尬的"接口是有的"。

这一阶段加的不是新能力，是**把已有的能力接上电**。

## 二、默认开着还是关着

**默认关闭**，要显式打开。

我最初实现成默认开启，理由是"合规要的不是接口，是真的会删；一个默认关闭的定时器
在真实部署里通常就是永不开启"。但这条理由站不住：它默认了"运维不会读文档"，同时
默认了"可以替别人决定删他的数据"。删数据是不可逆的，这类动作必须由人明确同意一次。

所以现在是：

```yaml
retentionAuto:
  enabled: true          # 默认 false
  everyMs: 21600000      # 默认 6 小时
  initialDelayMs: 60000  # 默认启动后等 60 秒再扫第一遍
  dryRun: false          # 想先观察就写 true
```

关着的时候端点仍然可用（`GET|POST /channel/retention`，手动触发随时可以），
只是没有定时器、`/health.retention.enabled` 报 `false`。

打开之后请确认 `/health` 的 `retention.lastRunAt` 会更新——这是"定时器还活着"
的唯一证据。如果它一直不变，说明进程挂了、租约丢了、或者配置没生效。

## 三、交付物

| 文件 | 改动 |
| --- | --- |
| `cs-agent/retention.js` | 新增 `resolveRetentionAuto(option)`：配置解析与默认值，纯函数 |
| `cs-agent/gateway.js` | 新增 `retentionState` / `runRetentionSweep` / `startRetentionWorker` / `stopRetentionWorker`；`/health` 上报；`install()` 注册 `ctx.effect` |
| `cs-agent/panel.js` | 运维视图"数据保留"卡增加"自动清理"一行（运行中 / 已关闭 / 等待首次检查 + 上次运行时间）与失败原因 |
| `scripts/check-panel.mjs` | 钉住 `自动清理` 这个标记，UI 丢了会 FAIL |
| `cs-agent/retention-auto-smoke.mjs` | 新增，44 条断言 |
| `scripts/verify-all.sh` | 新增 `== retention auto` |

## 四、配置

```yaml
# cs-agent/cordis.patch.yml 的插件配置里
retentionAuto:
  enabled: true          # 默认 false —— 必须显式打开
  everyMs: 21600000      # 默认 6 小时
  initialDelayMs: 60000  # 默认启动后等 60 秒
  dryRun: false          # 默认 false（真删）
retention:               # 保留期本身（P10 已有），与上面正交
  groupArchiveDays: 3
  groupPurgeDays: 30
  privateArchiveDays: 30
  privatePurgeDays: 90
```

`resolveRetentionAuto` 对坏值的处理：非正数的 `everyMs` 回落到 6 小时，负数的
`initialDelayMs` 回落到 60 秒，整个配置块不是对象则按默认（**默认即关闭**）。
也就是说配置写错只会让清理不跑，不会让它按意外的节奏删数据。

## 五、运行语义

- **串行**：`retentionState.running` 为真时，新的一轮直接返回 `{ skipped: 'busy' }`。
  两轮同时删同一批会话没有意义，而且会重复写审计。
- **租约优先**：每轮 tick 先查 `lease.lost`。租约已被别的实例接管时立刻停表并告警
  `channel-gateway: write lease lost; stopping the retention worker`——休眠后醒来
  的旧实例绝不能拿着过期判断去删别人的数据。
- **失败不致命**：`runRetentionSweep` 内部 catch 一切错误，写进 `lastError` 并
  `warn('channel-gateway: scheduled retention failed: ...')`，返回 `{ error }`。
  清理失败不该让网关挂掉。
- **可观测**：`/health` 的 `retention` 字段就是全部状态：

```json
{
  "retention": {
    "enabled": true,
    "everyMs": 21600000,
    "dryRun": false,
    "running": false,
    "lastRunAt": "2026-10-27T02:54:04.529Z",
    "lastResult": { "dryRun": false, "archived": 0, "purged": 0 },
    "lastError": null
  }
}
```

判断"数据真的删了吗"只需要看 `lastRunAt`：它即使一直空转也会更新，所以"这个字段
是旧的"就意味着**定时器停了**（进程挂了、租约丢了、或者被配置关掉了），比只报
"这轮删了 0 条"有用得多。

`lastResult` 是**最后一轮**的计数。绝大多数轮次什么都不用做，所以它通常是
`archived: 0, purged: 0`——这是正确的，不是没生效。真要查删了什么，看审计：

```
GET /channel/audit?limit=50
→ { "action": "purge", "actor": "schedule:tick", "role": "system", "detail": { ... } }
```

## 六、验收

```
node cs-agent/retention-auto-smoke.mjs     # 44 条
```

覆盖：

- 配置解析：默认**关闭** / 打开后 6 小时 / 60 秒 / 非 dry run；可设间隔；坏间隔回落；
  延迟可为 0；可 dry run；畸形入参按默认（关闭）；连 `retentionAuto` 都不写的网关也必须是关的。
- 定时器真的会跑：把会话时间戳改到 40 天前，启动定时器（间隔 20ms），120ms 后
  会话已被归档，`lastRunAt` 有值，审计里出现 `action: 'archive'`、
  `actor: 'schedule:tick'`、`role: 'system'`，`/health.retention` 能读到。
- 清除：200 天前 + 已归档 150 天 → 会话、消息一起消失，审计有 `purge`；
  刚来过的会话不受影响（这条防的是"保留期算错把活客户删了"）。
- dry run：`result.dryRun === true`，数据一条没删。
- 租约丢失：`createGateway(..., { lease: { kind: 'postgres', lost: true } })` 之后
  清理返回 `{ error: '... write lease was taken over ...' }`，数据没被删，`lastError`
  有值，日志有 `scheduled retention failed`。
- 串行：把 `store.flush` 拖慢 80ms，第二轮 sweep 返回 `{ skipped: 'busy' }`。
- 关闭：`startRetentionWorker()` 返回 `false`，等 120ms 也没有任何动作，`lastRunAt`
  保持 `undefined`。

全量回归：

```
bash scripts/verify-all.sh                 # 38 步
DSH_DB=1 bash scripts/verify-all.sh        # 38 步，连库
```

## 七、已知限制

1. **单实例各自跑**：多副本部署时每个实例都会跑自己的定时器。写操作有租约保护
   （丢锁的实例会停表），但**没丢锁的两个实例会各跑一轮**——清理是幂等的
   （会话已被删就找不到、归档已归档的不重复），所以结果正确，只是审计里会有
   重复记录。要彻底只有一轮，得让"谁是清理主"也走租约，这留到需要时再做。
2. **没有"上次清理到哪"的游标**：每轮都是全量扫描 `sessions`。当前量级（内存里
   几千条）无所谓，十万级需要改成按 `lastSeenAt` 索引分批。
3. **`lastResult` 会被空转轮次覆盖**：见上文，这是有意的（它表达"上一轮做了什么"），
   历史动作在审计里。
4. **定时器只在进程活着时跑**：进程停 10 天再起来，那 10 天该删的会在启动 60 秒
   后的第一轮一起删掉，不会漏，但会集中。
5. **`scripts/retention.mjs` 仍在**：它管的是运行时目录（DSH 会话目录、workspace），
   与这里的业务数据清理是两件事，两者都保留。

## 八、回滚

任何一步都可以单独退：

- 只想停自动清理：去掉 `retentionAuto.enabled: true`（或写 `false`）即可，不需要改代码。
- 想先观察：打开的同时加 `retentionAuto.dryRun: true`，扫描照跑、审计照写、数据不动。
- 整体回退：`git revert <P16 commit>`。回退后端点仍然可用，行为回到 P15。

## 九、下一步

候选（按"真实落地还差什么"排序）：

1. **面板权限分级**：现在拿到面板就等于能做删除。需要有"只读"角色。
2. **多租户 / 账户作用域强制**：`handoff` 的 `account` 目前靠 Prompt 约束，
   服务端不强制，A 客户工单理论上能查到 B 客户日志。
3. **告警接线**：`/health` 返回 503 了，但没人收到通知。需要钉一个外部探针或
   webhook。
4. **端到端安装测试**：从 `npm install` 到"发一条消息收到回复"的完整链路还没
   自动化过。
