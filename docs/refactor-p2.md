# P2：会话状态抽象成存储层（双实现 + 可选）

**目标**：把「会话映射存在哪儿」从网关里剥出来，让同一份网关代码既能跑在原来的
JSON 文件上（默认，行为不变），也能跑在 Postgres 上（多实例共享一份真相）。

**边界**：只动会话映射和入站去重这两件事。消息正文、工单、投递记录仍留在 P3/P4
做。**默认配置下行为与重构前完全一致**——这一点由 `gateway-smoke.mjs` 的 109 条
断言逐条把关。

## 为什么先做这一步

重构前有三个具体故障，都出在「存储」这一层，而不是业务流程：

| 故障 | 代码位置 | 后果 |
| --- | --- | --- |
| 每次变化全量重写 `sessions.json` | 原 `persist()` | 两条消息同时进来，后写覆盖前写，会话丢失 |
| `load()` 先置 `loaded = true` 再 `await` | 原 `load()` | 并发首条消息读到空表，**给同一个客户建出两个会话** |
| `writeJsonFile` 无 fsync | 原文件尾部 | rename 成功但内容没落盘，断电后文件截断/损坏 |

先把这三件事修对，再谈数据库才有意义——否则换成数据库只是把丢更新的问题搬到
另一个地方。

## 交付物

| 文件 | 作用 |
| --- | --- |
| `cs-agent/store.js` | 存储接口 + JSON 实现（约 190 行） |
| `cs-agent/store-pg.js` | Postgres 实现（约 200 行） |
| `cs-agent/store-smoke.mjs` | 两套实现跑同一份约定测试（28 条 / 有库时 56 条） |
| `cs-agent/db/migrations/0002_conversation_last_sender.sql` | 补 `last_sender_id` 列 |
| `scripts/verify-all.sh` | 新增 `== session store` 一步 |

改动集中在 `cs-agent/gateway.js`：净减 59 行、增 61 行（删掉两个已无用的文件读写
helper，替换 `load`/`persist`/`persistSeen`，11 个调用点改成只写变化的那一条）。

## 接口

```js
const store = createStore({ kind, dataFile, seenFile, dedupeLimit, logger })

store.kind              // 'json' | 'postgres'
store.records           // Map<key, record> —— 网关直接持有这个引用并就地改
store.seen              // Map<messageId, ISO> —— 去重窗口
await store.load()      // 幂等；并发调用只真正读一次
await store.save(record)// 写一条（json：合并后重写；pg：单行 upsert）
await store.remove(key) // 删一条
await store.rememberSeen(messageId, at) // 记去重并把窗口裁到上限
await store.flush()     // 等所有在途写入落地
await store.close()     // 释放资源
```

**关键取舍：网关继续直接改 `records` 里的对象，而不是每次读/写都走 store。**
理由是 `record.archivedAt = ...`、`record.mode = ...` 这类就地修改遍布 900 行
的 `createGateway`，包成 repository 要重写整个文件，而收益只是"更面向对象"。
存储层只对「变化怎么落地」负责——这已经够修掉上面三个故障。

## 关键决策

**1. 开关是独立的 `DSH_CS_STORE`，不看 `DSH_DB`。**
`DSH_DB=1` 表示"数据库这层能力打开了"，不该顺手改变会话存在哪儿。分开之后：
开发者 `export DSH_DB=1` 跑 `verify-all.sh`，网关仍然用 JSON，不会意外连库。

```bash
# 默认（不设任何变量）：JSON 文件，与重构前一致
# 用数据库：
DSH_DB=1 DSH_CS_STORE=postgres node cs-agent/gateway.js  # 或在插件配置里写 store: postgres
```

非法值直接报错，不静默回退：`store must be "json" or "postgres", got: mysql`。

**2. JSON 实现保持在原文件格式上，但写入方式改了。**
文件仍是 `{ key: record }` 对象、`seen` 仍是 `[[id, at], ...]` 数组、仍是
`JSON.stringify(value, undefined, 2)` + 换行——老数据文件可以直接读，回退时也能
被老版本读。变的是：写链串行化（`chain = chain.then(...)`）、用 dirty 标志合并
同一轮的多次变化、`open(0o600)` + `writeFile` + **`sync()`** + `rename`。

**3. `load()` 改成先 await 再置标志。**
`loading ??= doLoad()` 让并发调用共享同一次读取；网关侧 `loaded` 也挪到 await
之后。修掉「同一客户两个会话」的竞态。

**4. Postgres 侧的 `groupId` 必须还原成 `null`。**
网关用 `record.groupId !== undefined` 判断「是不是群聊」。数据库里是 `NULL`，
如果映射成 `undefined`，私有会话会走进群聊分支、给单聊客户加 `@昵称`。同一道理
适用于 `archivedAt` / `lastSenderId`：**有值才挂字段，没有就不出现**，与原来的
文件格式语义一致。

**5. 去重窗口进了库，成为跨实例语义。**
`inbound_dedupe(platform_msg_id, channel)` 是持久化的，所以第二个进程也认得出
「这条消息处理过了」。运行时窗口仍在内存（`seen` Map）里裁到 `dedupeLimit`，
库里每 64 条插入才裁剪一次，避免每条消息都跑一次 `delete`。裁剪失败只 warn，
不影响消息处理。

**6. PG 的 `close()` 不关连接池。**
连接池是进程级单例（`db/pool.mjs`），关它等于把别人的连接一起关了。真正关闭由
进程收尾统一调 `closePool()`。

**7. `persist()` 带参数只写一条。**
11 个调用点逐个改成 `persist(record)`；删除路径改用 `store.remove(key)`。
`persist()` 不带参数仍写全部，作为兜底，但正常路径不再走到。

## 验收

```bash
# 存储层自测（不连库）
node cs-agent/store-smoke.mjs            # 28/28

# 连库：两套实现跑同一份约定 + 网关跑在库上的集成测试
DSH_DB=1 node cs-agent/store-smoke.mjs   # 56/56

# 全量回归（默认 JSON，109 条网关断言必须与基线一致）
bash scripts/verify-all.sh
DSH_DB=1 bash scripts/verify-all.sh
```

`store-smoke.mjs` 覆盖的约定（两套实现各跑一遍）：字段往返（含 `groupId` 为
`null`）、并发 `load` 共享一次读取、同 key 重复保存不产生新行、**并发写 8 条
一条都不丢**、`remove` 后重新加载不再出现、去重窗口裁到上限且保留最新。

集成部分验证三件只有真库才能验的事：入站消息写进 `conversations` 表、
**第二个网关实例不重启就能看到第一个实例建的会话**、跨实例去重生效。

## 已知限制

- **`gateway-smoke.mjs` 不能跑数据库模式**：它靠"一个独立数据文件"隔离每条用例，
  换成数据库后所有实例共享一张表，用例互相串。已在文件头加硬拦截（`DSH_CS_STORE`
  非 json 时 exit 2）并指向 `store-smoke.mjs`。数据库路径的回归由 store-smoke 承担。
- 消息正文、工单、投递记录仍未落库（P3/P4）。
- `store` 层没有重试/退避：数据库抖动时入站会失败并返回 400。真实系统需要的是
  「先收下、再落库」+ 指数退避重试，属于 P4。
- `acquireDataLock` 仍然存在，所以**同一数据目录仍只允许一个 dsh 进程**。数据库
  模式的价值目前是「数据不丢、可共享读到」，多实例写入要等锁换成数据库租约。
- 迁移 0002 只加了一列，没有回填历史（历史 JSON 文件本来就没有 `last_sender_id`
  以外的差别）。

## 回滚

```bash
# 只回滚存储选择：不设 DSH_CS_STORE 就是 JSON，数据文件格式没变，直接可用
unset DSH_CS_STORE

# 回滚代码
git revert <P2 commit>
```

## 下一步（P3）

`emit()` 现在先写 outbox 再 POST，失败只 `warn` 一条就返回 `{delivered:false}`
——**没有重试、没有回放**。P3 把它升级成真正的投递：`outbox` 表 + 幂等键 +
指数退避重投，并让 `/outbox` 面板能看到积压。
