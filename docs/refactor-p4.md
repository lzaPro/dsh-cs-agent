# P4：写入域租约（多机安全）

## 目标

重构前 `cs-agent/gateway.js` 的 `acquireDataLock()` 用 `<dataFile>.lock` 里记一个 pid 来保证
"同一份数据只有一个写者"。单机够用，但有两个真实缺陷：

1. **多机无效**。锁文件在本地磁盘上。把同一个数据目录挂到两台机器（NFS、或两个容器共享卷）后，
   两个进程各自写自己的锁文件，都以为自己独占，然后互相覆盖会话映射。
2. **"活着但卡死"检测不出来**。pid 只能证明进程存在，不能证明它在推进。进程挂起（死锁、GC 停顿、
   被 SIGSTOP、VM 冻结）时锁永远不释放，重启一个新实例只会被判"已被 pid N 占用"。

目标：让"谁是写者"这件事在**多机**和**进程假死**两种情况下都有确定答案，且失效能自动恢复。

## 为什么排在这里

P1 建表、P2 有了 `store.kind`（json / postgres）、P3 有了 outbox 的后台工作线程。P4 是"多实例"
的前置条件：没有租约，P5 之后任何多实例尝试都会静默丢数据。而它又依赖 P1/P2 已有数据库和
存储选择，所以只能在 P2 之后。

## 交付物

| 文件 | 内容 |
| --- | --- |
| `cs-agent/db/migrations/0003_gateway_lease.sql` | `gateway_leases` 表（`scope` 主键、`holder`、`host`、`pid`、`heartbeat_at`、`expires_at`）+ `expires_at` 索引 |
| `cs-agent/lease.js` | `createFileLease()`（原行为）、`acquirePgLease()`（数据库租约）、`acquireLease()`（按存储类型分派）、`leaseKind()`、`DEFAULT_LEASE` |
| `cs-agent/gateway.js` | `apply()` 按存储类型选租约；抽出 `install()`；`acquireDataLock()` 保留为薄封装 |
| `cs-agent/lease-smoke.mjs` | 文件锁 8 条 + 数据库租约 17 条，含网关接线 |
| `scripts/verify-all.sh` | 新增 `== write lease` 步骤（现 25 步） |

## 接口

```js
import { acquireLease, createFileLease, leaseKind, DEFAULT_LEASE } from './lease.js'

// 按存储类型分派：json → 同步文件锁，postgres → 异步数据库租约
const lease = await acquireLease({
  storeKind: 'postgres',   // 'json' | 'postgres'
  dataFile,                // json 模式的锁文件位置
  scope: 'cs-gateway',     // 逻辑写入域，同一份数据的所有实例用同一个值
  ttlMs: 30_000,           // 租约有效期
  heartbeatMs: 10_000,     // 续期间隔
  logger,
})
lease.kind            // 'file' | 'postgres'
lease.lost            // postgres 专有：被接管后变 true，实例应停止写入
await lease.release() // 释放
```

`DEFAULT_LEASE = { ttlMs: 30_000, heartbeatMs: 10_000 }`。

## 八条关键决策

1. **两套实现并存，按存储类型选，而不是一律上数据库。**
   `store.kind === 'json'` 时继续用 pid 文件锁，行为与重构前逐字节一致 —— 这是 `gateway-smoke.mjs`
   109 条断言一条不改的前提，也保住"不装数据库就能跑"。

2. **文件锁分支保持同步。** `apply()` 在 json 模式下同步返回，在 postgres 模式下返回 Promise。
   Cordis 两种都接受（`await` 一个非 Promise 是安全的），但既有测试里"调用 `apply()` 后立刻断言
   路由已注册"的写法必须仍然成立。

3. **租约有有效期，靠心跳续期，而不是靠 pid 存活判断。**
   `expires_at = now() + ttl`，每 `heartbeatMs` 续一次。进程崩了、卡死了、机器断电了，租约自然过期，
   别的实例 `on conflict ... where expires_at <= now()` 直接接管。不需要人工删锁文件。

4. **接管后原持有者必须知道自己丢了。** 心跳的 `update` 返回 0 行就说明行已被别人接管 →
   `lost = true` + 一条 warn。这样上层将来可以据此停止写入，而不是继续双写。
   注意：网络错误**不**立刻判定丢锁（否则一次抖动就把健康实例踢下线），只 warn 后等下一轮。

5. **`holder` 由 `hostname:pid:随机8位` 组成。** 同一个进程重复 claim 自己已有的租约是幂等的
   （`where ... or gateway_leases.holder = excluded.holder` 分支），避免进程内重复 assemby 时自锁。

6. **`scope` 是逻辑写入域，不是数据文件路径。** 多机部署时各机器路径不同（如容器内都是 `/data/sessions.json`），
   用路径做键会让两台机器各拿一个租约。`scope` 默认 `'cs-gateway'`，可用 `leaseScope` 配置区分
   同一数据库上的多套部署。

7. **`acquireDataLock()` 保留为薄封装，不删。** 它是 `cs-agent` 的公开导出（`package.json` exports 间接
   暴露、`gateway-smoke.mjs` 直接调用测"第二个实例被拒"），删掉是破坏性变更。现在它内部就是
   `createFileLease(dataFile).release`。

8. **`install()` 里用 `ctx.effect` 注册租约释放。** 与 route / observe / outbox worker 同一套生命周期，
   Host 卸载插件时自动放锁。`createGateway` 抛错时也要放（`void lease.release()`），否则一次配置错误
   会把数据目录锁死到 ttl 超时。

## 验收

```bash
node cs-agent/lease-smoke.mjs            # 文件锁 8 条
DSH_DB=1 node cs-agent/lease-smoke.mjs   # 文件锁 8 条 + 数据库租约 17 条

cd cs-agent && node gateway-smoke.mjs    # 109 条，必须与基线逐条一致
bash scripts/verify-all.sh               # 25 步
DSH_DB=1 bash scripts/verify-all.sh      # 25 步（含数据库段）
```

数据库租约段覆盖：

- 拿到租约后表里有且只有一行，`holder` 对得上；
- 第二个实例被拒（错误信息含 `already in use`）；
- 同一个 holder 重复 claim 幂等；
- 心跳把 `expires_at` 往后推；
- **把 `expires_at` 推到过去 → 别的实例接管成功**（模拟"持有者活着但卡死"）；
- 原持有者下一次心跳发现 `lost === true`；
- `release()` 删掉行；释放后别人能拿到；
- `apply()` 在 postgres 存储下真的抢到租约、第二个 `apply()` 被拒、走 `ctx.effect` 的 disposer
  能释放租约、释放后另一实例能起。

## 已知限制

- **`lease.lost` 目前只是信号，没有强制停止写入。** 网关各写入路径尚未检查它。真正"丢锁即停写"需要
  在所有写点判定，属于 P5/P6（写入路径收口）的活。当前依赖 ttl 足够长（30s）+ 心跳足够密（10s），
  且接管方拿到租约后写入是串行的。
- **租约不覆盖"同一实例内的并发"。** 它解决的是进程/机器之间。实例内并发仍靠 P2 存储层的写链。
- **json 模式仍是单机。** 文件锁没有有效期，无法接管"活着但卡死"的进程 —— 这是刻意的：文件模式下
  没有共享时钟，做租约只会引入新的失效模式。要多机就切 postgres。
- **`gateway_leases` 行不会自动清理。** 正常 `release()` 会删；进程被 kill -9 时留下过期行，
  下次有人 claim 同一 `scope` 时被覆盖。不积累。

## 回滚

```bash
git revert <this-commit>
```

回滚后 `apply()` 回到无条件用 `acquireDataLock()`，`lease.js` 与 0003 迁移留在仓库里但不被调用。
已应用的 0003 迁移不用撤（`gateway_leases` 空表，不影响其它功能）。

## 下一步

P5：入站"先收下再落库"。当前 `inbound()` 一个函数串了归一化、去重、限流、附件下载、建会话、
落盘、投递 —— 附件下载失败或 OCR 超时会整条消息丢掉，而平台不一定重投。要拆成"先确认收到"
（写 `inbound_dedupe` + `messages`）再异步处理。
