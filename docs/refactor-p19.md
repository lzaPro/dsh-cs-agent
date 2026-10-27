# P19：告警接线（出事了有人知道，而不是等人来查）

## 起因

P6 加了 `/health`，返回 503 表示"这个网关现在不能干活"。但它只是**能查**——没人查就没有意义。

真实的失效方式是安静的：

- 数据库连不上 → 队列写不进，客户消息堆在内存里，`/health` 一直 503，但客户只是觉得"客服不回话"
- 写入租约被别的实例接管 → 这个实例已经不能写了，`/health` 503，但进程还活着，`systemctl status` 显示 running
- 回复重试用尽变 dead → `/health` 仍是 200（这是故意的，见下），客户在等一条永远不会来的回复
- 自动清理失败 → 数据没删，`/health` 也正常，等到合规审计时才发现

监控系统能配 `/health` 探针，但"接到告警之后是谁的手机响"往往是空白。所以 P19 把
`/health` 的判断接到一条推送通道上，复用适配器现成的 `/reply` 接口——运维派单器
（`ops-agent/dispatcher.js` 的 `notifyAdmin`）已经在用这条路径发管理员私聊，载荷形状一致。

## 做了什么

```
每分钟 → health() → collectIssues() → evaluateAlerts() → formatAlert() → POST 适配器 /reply
                      ↓ 纯函数，可断言   ↓ 去重/重复/恢复     ↓ 一条人话
```

### 1. 什么时候算"有问题"

`collectIssues(health)` 把 health 报告翻成一组问题，每条带**稳定的 key**：

| key | 来源 | severity |
| --- | --- | --- |
| `check:lease` | 租约被接管 | **critical** |
| `check:database` | 数据库连不上 | **critical** |
| `check:inbox` / `check:outbox` | 队列读不出来 | warning |
| `dead:inbox` / `dead:outbox` | 死信 > 0 | warning |
| `retention` | 自动清理失败 | warning |

用检查项名字（而不是消息文本）当 key，是因为 key 同时用于去重、重复提醒计时和恢复
通知。文本改了不该被当成新故障重新报一遍。

死信不算"网关挂了"（`health.ok` 仍是 true），但仍然会报——它们是处理过又放弃的客户
消息或回复，客户在等。这两件事的区别是"要不要重启"和"要不要人看一眼"。

### 2. 什么时候该发

`evaluateAlerts({issues, state, now, repeatMs})` 是纯函数，给同样的输入必得同样的输出，
所以每条边界都能断言：

- **新出现** → 立刻报（`reason: 'new'`）
- **持续未恢复** → 隔 `repeatMs`（默认 1 小时）再提醒一次（`reason: 'repeat'`，保留首次时间）
- **恢复了** → 报一条"已恢复，持续 N 秒"，从活跃列表摘掉

不每轮都报的原因是手机一直响会让人关掉通知，那比不接告警更糟。恢复通知同样重要：
没有它，值班的人不知道能不能下班。

### 3. 发给谁

必须**同时**配 `alertWebhook` 和 `alertTo`：

```yaml
# cs-agent/cordis.patch.yml → channel-gateway
alertWebhook: http://127.0.0.1:8080/reply
alertTo: '管理员 QQ openid'
alertIntervalMs: 60000      # 多久自检一次
alertRepeatMs: 3600000      # 没恢复时多久再提醒
alertGraceMs: 15000         # 启动后多久内不报
```

只配一个就**整条链关闭**（`missing` 会指出缺哪个）。理由：只配 webhook 不知道该发给谁，
发到默认地址比不发危险；只配收件人没有通道，配了也没用。两个都不配时，`/alerts` 仍然
记录"本来要报什么"，配好之后立刻能用。

### 4. 发送失败怎么办

只记 `lastError`，不重试。

告警是有时效的——"十分钟后补发一条旧的"没有意义，还会让人以为问题还在。下一轮自检会
重新判断，真没恢复会再报一次。适配器返回 503 也算失败（网络通但消息没送出去），这一点
和 `emit` 的 `postReply` 同一处理方式。

### 5. 接入点

- `install()` 里第五个 `ctx.effect`（`'channel-gateway: alert worker'`），卸载时停表
- 定时器 `unref()` —— 否则测试与 CLI 进程退不出去
- 启动宽限期 `alertGraceMs`（默认 15 秒）：刚起来时数据库/队列可能还在握手，这段先不报，
  避免重启就刷屏
- `GET {route}/alerts`：状态 + 最近 50 条记录（只读令牌也能看，值班的人需要它）
- `GET {route}/health` 多一个 `alerts` 字段（enabled / active / lastSentAt / lastError）

## 交付物

| 文件 | 改动 |
| --- | --- |
| `cs-agent/alerts.js` | 新建：`parseAlertConfig` / `collectIssues` / `evaluateAlerts` / `formatAlert` / `createAlerter` |
| `cs-agent/gateway.js` | 配置与发送器、`checkAlerts()`、`startAlertWorker` / `stopAlertWorker`、`/alerts` 端点、`/health.alerts`、`install()` 里第五个 effect |
| `cs-agent/panel.js` | 健康卡多一行"告警"，`alertText()` 显示未恢复项数或配置缺口 |
| `cs-agent/alerts-smoke.mjs` | 新建：**80 条**（配置 9 + 问题收集 12 + 去重恢复 12 + 格式 8 + 发送器 15 + 网关集成 18 + 宽限期 6） |
| `scripts/check-panel.mjs` | 端点标记加 `/alerts`、运维标记加"告警"、契约断言加 alert feed |
| `cs-agent/package.json` | exports `./alerts`、files 加 `alerts.js` |
| `cs-agent/cordis.patch.yml` | 告警配置注释块 |
| `scripts/verify-all.sh` | `== alerts` 一步 |
| `docs/refactor-p19.md`、`INSTALL.md` | 本文与「### 4.15 告警推送」 |

## 关键决策

1. **复用适配器 `/reply` 而不是自建 webhook**。运维派单器已经在用这条路径发管理员
   私聊，形状一致（`{senderId, groupId: null, text}`），不用为了告警再拉一个服务。
2. **必须两个字段都配才生效**。见上，宁可静默也不发错人。
3. **纯函数判断 + 独立发送**。判断逻辑能逐条断言（新出现/持续/恢复/多问题交叉/零间隔）；
   直接写进定时器就只能"跑一遍看看有没有发"。
4. **重复提醒而不是每轮都报**。手机一直响 = 通知被关掉。
5. **恢复也要报**。只说"坏了"不说"好了"，值班的人不知道该不该继续盯着。
6. **发送失败不重试**。告警的时效性使它不适合排队重试；下一轮自检自然重报。
7. **响应非 2xx 算失败**。只看"没抛异常"会把 503 记成成功，然后停止重报——这是真 bug
   （测试里抓到过，见下）。
8. **启动宽限期**。宁可晚 15 秒报，也不要每次重启都刷一轮假警报。
9. **死信单独报，且不算 health 失败**。两件事的处理方式不同。

## 验收

```bash
node cs-agent/alerts-smoke.mjs       # 80 PASS
node cs-agent/gateway-smoke.mjs      # 109 PASS（无回归）
node cs-agent/panel-dom-smoke.mjs    # 23 PASS
node scripts/check-panel.mjs         # 7 PASS
bash scripts/verify-all.sh
DSH_DB=1 bash scripts/verify-all.sh
```

测试里起一个假适配器（`http.createServer`），可以指定"前 N 次返回 503"，因此能验：

- 配好之后真的 POST，载荷形状与运维通知一致（`senderId` / `groupId: null` / `text` / `source`）
- 同一个问题不重复发；恢复时发一条"已恢复"
- 发送失败（503）→ `sent: false` + `lastError`，下一轮能成功
- 没配通道 → 照样判断，历史里留下"本来要报什么"
- 网关集成：造一条真死信（回复投递失败到上限）→ 报警 → 不重发 → 重放死信 → 报恢复
- 租约被接管 → `【严重】` + `/health` 503 + active 列表有 `check:lease`
- 宽限期内不发
- `/alerts` 端点可读、最新在前，`/health.alerts` 摘要正确

### 测试抓到的真 bug

`createAlerter` 初版只 `try { await fetch(...) }`，不看 `response.ok`。适配器返回 503 时
网络是通的、fetch 不抛，于是 `sent` 被记成 true、`lastError` 清空、下一轮不再重报——
**告警系统在最需要它的时候静默失效**。测试 "a refused delivery is reported as not sent"
一条就露了。修法：`response.ok === false` 时 throw（与 `postReply` 的处理一致）。

另外 `repeatMs: 0` 原本被当成非法值回落到 1 小时，导致"每轮都重报"配不出来。改成
`repeatMs` 用非负校验（0 合法，intervalMs 仍要求正数）。

## 已知限制

- **状态只在内存**。进程重启后未恢复的问题会当作"新出现"再报一次（多一条噪音，不会漏报）。
  多实例部署时每个实例各自报自己的判断，同一个数据库故障可能收到 N 条。
- **只有一条通道**。没有分级路由（critical 发电话、warning 发群）、没有静默窗口、
  没有升级策略。这些属于"接进现成值班系统"（PagerDuty / 飞书 / 钉钉）时在那边做的。
- **告警文本是中文固定模板**。没有 i18n。
- **`/alerts` 历史也在内存**，最多 50 条，重启清空。
- **探测不到"回复没送到客户"以外的业务异常**（例如模型答非所问），那属于评测（P12）。

## 回滚

不配 `alertWebhook` / `alertTo` 就回到 P18 的行为（只有 `/health`，没有推送）。
要整体回退：`git revert <this commit>`。

## 下一步

报告第 9 节剩下的最后一项：端到端安装测试（从干净环境跑一遍 INSTALL.md）。
