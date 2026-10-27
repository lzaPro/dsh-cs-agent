# P7：写入路径收口（丢锁就停写）

## 目标

P4 做了写入域租约：多实例部署时，只有一个实例能写。但租约被接管之后，
**原实例只是把 `lost` 标记置为 true，并没有真的停手** —— 它收到客户消息照样建会话、
照样唤醒模型、照样往数据库写。两个实例同时写同一份状态，结果是互相覆盖，
而且过程完全静默。

这一阶段把 `lost` 从"一个状态位"变成"一道门"。

## 为什么这一步必须做

P4 的内核是"谁持有租约谁才能写"，而 P7 之前这个不变式**只在启动时成立**。
真实的接管场景有：

- 这台机器卡住（GC 停顿、磁盘 hang），心跳发不出去，30 秒后 TTL 到期，另一台接管；
- 运维在 A 机 `systemctl stop`，进程还没来得及退出，B 机已经起来接客；
- 容器被 `SIGKILL` 后重启，新进程抢到租约，旧进程其实还在跑（僵尸状态）。

这三种情况下旧实例都还活着，都还能响应 HTTP。如果它继续写，客户可能收到**两条回复**
（两个实例各发一遍），或者会话映射被覆盖成指向已经失效的 session。

## 交付物

| 文件 | 内容 |
| --- | --- |
| `cs-agent/gateway.js` | `assertWritable()` 守门；`persist`/`deleteConversation`/`inbound`/`emit` 全部经过它；`observe` 里三处 `void emit()` 补 `.catch`；`LEASE_LOST` 映射成 HTTP 503；`stopWorker()` 返回布尔值；worker 丢锁自停 |
| `cs-agent/lease-guard-smoke.mjs` | 18 条：持锁可用、丢锁拒写、读路径不受影响、worker 自停 |
| `scripts/verify-all.sh` | 新增 `== lease guard`（现 29 步） |

## 守门放在哪

```
inbound()        ← assertWritable()  受理前：别把条目录进别人的库
persist()        ← assertWritable()  会话映射
deleteConversation() ← assertWritable()
emit()           ← assertWritable()  回复投递
worker tick      ← lease.lost ? 自停 : 继续重试
```

读取路径一律不拦：`/status`、`/health`、`/sessions`、`/history` 在丢锁后仍然可用
—— 运维正需要在这时候看"刚才发生了什么"。

错误是显式的：

```
channel-gateway: write refused, the write lease was taken over (postgres);
this instance must stop and restart
```

带 `code: 'LEASE_LOST'`，HTTP 层映射成 **503**（不是 400）：这个实例现在不能服务，
但问题不在请求本身。

## 四条关键决策

1. **拒绝写入，而不是降级成只读。**
   只读模式听起来温和，实际会让"客户发了消息但没有任何反应"变成静默故障。
   明确报错 + 让编排系统重启实例，比一个假装活着的网关好。

2. **守门放在 `persist()` 而不是 `store.save()`。**
   存储层是纯机制，不该知道租约；租约是插件激活期的事。放网关层，测试也好写
   （注入一个可变 `lease` 对象即可，不需要真的抢两次锁）。

3. **`void emit()` 必须补 `.catch`。**
   这是顺手发现的一个真 bug：`observe` 里三处 `void emit(...)` 原本安全，
   因为 `emit` 内部把所有失败都吞掉只返回 `{delivered:false}`。P7 之后 `emit`
   在丢锁时会**抛错**，而 `void` 让这个 rejection 没人接 —— Node 15+ 默认
   `--unhandled-rejections=throw`，**整个网关进程会崩**。所以补了 `.catch` 并记日志：
   "回复没发出去"是告警，不该是崩溃。

4. **worker 丢锁后自停，且只告警一次。**
   继续 tick 只会反复撞 `assertWritable` 刷日志，还会一直占着 `setInterval`。
   `stopWorker()` 让定时器彻底停掉，日志里留一行"已停止重试"。

## 验收

```bash
node cs-agent/lease-guard-smoke.mjs   # 18 条
node cs-agent/gateway-smoke.mjs       # 109 条，与基线逐条一致
bash scripts/verify-all.sh            # 29 步
DSH_DB=1 bash scripts/verify-all.sh   # 29 步
```

`lease-guard-smoke` 覆盖：

- 持锁时入站/回复/改模式/删会话都正常；
- 丢锁后这四类写入全部抛 `LEASE_LOST`，且错误信息说明"租约已被接管"；
- 丢锁后被拒的入站**不会**唤醒模型（`ctx.followed.length` 不变）；
- 丢锁后被拒的回复**不会**写进审计 jsonl；
- 通过 HTTP 的写入返回 503 + `code: LEASE_LOST`；
- 读路径（`/status` 200、`/health` 503）不受影响；
- worker 启动后丢锁会告警并自停，重复 `stopWorker()` 不报错。

## 已知限制

- **丢锁后进程不会自动退出。** 现在只是"拒绝写入 + 健康检查 503"，靠编排系统
  重启。做成 `process.exit()` 太激进（可能正在 flush 日志/SIGTERM 处理），
  后续可以接一个显式的 shutdown 钩子。
- **`/health` 的 503 与"数据库连不上"共用状态码。** 探针只能看 `checks` 才知道
  是哪一项坏，需要区分时可以加专门的 reason code。
- **内存里的 `sessions` Map 在丢锁后仍保留旧内容。** 只是不再写回，读出来的是
  接管前的快照。这符合预期（它确实是这个实例最后看到的状态）。

## 回滚

```bash
git revert <this-commit>
```

回滚后 `lease.lost` 回到"只看不用"的状态，写入门禁消失，其余行为不变。
`lease-guard-smoke.mjs` 留在仓库里但不再被 verify-all 调用。

## 下一步

P8 候选：

- **dead 项的人工重放入口**：面板上能看到死信，但没有"再试一次"的按钮。
- **`messages` / `usage_daily` 真正落库**：表现在建好了，但网关还没写消息正文与用量。
- **面板拆分**：`panelHtml` 仍是 517 行的模板字符串，与 21 条路由靠字面量对齐。
- **审计写 `audit_log` 表**：目前审计只落 jsonl 文件。
