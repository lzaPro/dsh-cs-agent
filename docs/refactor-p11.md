# P11：面板独立成文件 + 运维视图

## 目标

两件事，一件是结构债，一件是功能债。

**结构债**：`cs-agent/gateway.js` 里有一段 519 行的 `panelHtml(route)`，把整站
HTML / CSS / 浏览器端 JS 塞在一个模板字符串里。改一个按钮的颜色要先滚过一千行后端代码，
而且它和 HTTP 路由、会话状态、投递队列挤在同一个闭包里。文件 2425 行，其中五分之一是界面。

**功能债**：P9 的死信重放、P10 的数据保留、P6 的健康检查都做了端点，但**只能 curl**。
运维真正会用的时候是在浏览器里：看到哪条没发出去、点一下重发、看一眼保留期计划。
端点没人用等于没做。

## 交付物

| 文件 | 内容 |
| --- | --- |
| `cs-agent/panel.js`（新） | `export function panelHtml(route)`，532 行，原 1812-2329 行原样搬出 |
| `cs-agent/gateway.js` | 删掉 `panelHtml`，改成 `import { panelHtml } from './panel.js'`；2425 → 1906 行 |
| `cs-agent/panel.js` 运维视图 | 健康 / 死信 / 数据保留 / 审计四张卡 |
| `cs-agent/panel-dom-smoke.mjs`（新） | 23 条断言，用最小 DOM 替身真跑面板脚本 |
| `scripts/check-panel.mjs` | 新增 5 个端点标记、运维视图标记、端点字段契约 |
| `scripts/verify-all.sh` | 新增 `== panel view`（现 40 步） |
| `cs-agent/package.json` | exports 加 `./panel`；files 加 `panel.js` |

## 搬迁怎么保证没错

面板是纯字符串输出，**最容易的验证就是逐字节比较**：

```bash
# 改之前
node /tmp/dump-panel.mjs /tmp/panel-before.html    # 23163 字节
# 搬迁之后
node /tmp/dump-panel.mjs /tmp/panel-after.html
diff /tmp/panel-before.html /tmp/panel-after.html   # 无输出 = 一致
```

（`/tmp/dump-panel.mjs` 就是"建网关 → `GET /channel/panel` → 写文件"，一次性脚本，没入库。）

搬迁只做了三件事：加文件头注释、`function` → `export function`、`gateway.js` 换成 import。
模板字符串的内容一个字没动，所以 diff 为空。

## 运维视图

侧边栏工具栏多了第四个按钮「运维」。点开是一块独立的视图（`state.view === 'ops'`），
四张卡：

### 1. 健康

直接读 `GET {route}/health`：
- 正常 / 需要处理（`ok` 字段），
- 运行时长、存储类型（json / postgres）、写入租约（含"已被接管"的红色提示）、
  入站/出站积压（待处理 · 重试中 · 死信）、数据库版本或"未启用"，
- `checks` 里失败的项逐条列出来（`名称：detail`）。

这张卡的用处是回答"现在能不能干活"——不用登机器看日志。

### 2. 死信

`GET {route}/dead` 的两个队列各一个分区：
- 入站（客户消息没处理完）、出站（回复没送到客户）；
- 每条显示正文预览（`payload.text`）、试了几次、什么时候、最后一次的错误；
- 单条「重放」和「全部重放」两个入口，都走 `POST {route}/replay`。

### 3. 数据保留

- 显示当前保留期（群聊 / 私聊各一行"X 天归档 / Y 天清除"）；
- 「看计划」走 `GET {route}/retention`，列出将归档和将清除的会话数；
- 有计划时才出现「执行」按钮，点了先 `confirm` 说明"清除不可逆"，再
  `POST {route}/retention {dryRun:false, actor:'panel'}`。

**界面不做自动执行**：会删数据的事情必须有人按一下，且 confirm 里写清楚后果。

### 4. 最近审计

`GET {route}/audit` 最近 20 条：动作、目标、谁做的、什么时候、`detail` 摘要。
重放和清除都会出现在这里，所以"刚才谁删的"在同一个页面上就能查到。

## 关键决策

### 1. 搬迁而不是重写

面板能用、有人用、样式调过（深色模式、群聊 @、图片预览都做了）。重写等于把
这些细节重新踩一遍，收益只是"代码好看"。所以只搬不改，用 diff 保证行为不变，
新功能另外加。

### 2. `panel.js` 只导出函数，不碰网关状态

`panelHtml(route)` 只有一个参数（挂载路径，注入到 `BASE`），不接收 ctx、不读 store。
这样它连"误用"的机会都没有：界面通过 HTTP 拿数据，和浏览器里手动 curl 走同一套端点。
副作用是面板可以独立做快照测试——`panel-dom-smoke.mjs` 正是这么干的。

### 3. 用最小 DOM 替身测界面，而不是引 jsdom

面板的 bug 有个共同特征：语法没错、`node --check` 过、端点也在，
但浏览器里一点就炸（id 拼错、字段名和端点返回对不上、切视图读了 null）。
`scripts/check-panel.mjs` 只能查语法和字符串标记。

引 jsdom 要加依赖（四个包零依赖是本项目的底线），所以自己写了个 150 行的替身：
`getElementById` 返回带 `innerHTML` 的桩、`addEventListener` 收集监听器、
`fetch` 转发到**真实的** `gateway.handleHttp`。然后模拟点击，断言页面里真的出现了内容。

这抓到了两个真问题（见下），成本比想象的低。

### 4. 端点字段契约钉在测试里

运维视图读 `health.queues.inbox.pending`、`row.idempotencyKey`、`plan.limits.groupArchiveDays`
这些字段名。字段改名而 UI 不改，页面**不会报错**，只会显示"未启用 / 没有"——
这种 bug 静悄悄地存在，直到有人真的需要它。

所以 `check-panel.mjs` 里加了字段存在性断言，`panel-dom-smoke.mjs` 里加了真实数据流断言。

### 5. 有 webhook 才显示出站死信

`GET {route}/dead` 在没有 `replyWebhook` 时不返回 `outbox` 键（队列根本没启用）。
界面按"键存在才渲染"处理，健康卡里则显示"未启用"——避免让人以为"出站没有死信"
而不是"出站没开"。

## 这个阶段抓到的两个真问题

### 1. 模板字符串里的 `\n` 会被吃掉一层

`confirm('...。\n清除不可逆...')` 写在**外层模板字符串**里，Node 先解析这一层转义，
把 `\n` 变成真正的换行，生成的浏览器端 JS 就变成了跨行的字符串字面量：

```
SyntaxError: Invalid or unexpected token
```

`node --check cs-agent/panel.js` 通过，因为面板文件本身语法没错；错的是**生成的**脚本。
修法是在源文件里写 `\\n`（两层转义），日志和 `check-panel.mjs` 才抓得住。

这个问题以前就埋在面板里，只是没人在模板里写转义字符。**改界面代码时要记住：面板源文件里的
任何反斜杠都会被 Node 多吃一层。**

### 2. 事件形状写错会静默降级成兜底回复

`panel-dom-smoke.mjs` 最初断言"死信里能看到模型回复的原文"，结果拿到的是
`抱歉，我这边刚才没处理成功，能再说一次吗？`（`FALLBACK_REPLY`）。
原因是测试里喂的 `assistant/message` 事件形状写错了——真正的形状是
`{ data: { message: { content: [{ type: 'text', text }] } } }`，我写成了 `{ data: { text } }`，
`textOf()` 拿不到文本，这一轮就被当成"模型没输出"走了兜底。

这不是面板的 bug，但它说明**兜底回复会掩盖事件形状错误**。测试里必须断言具体文本，
不能只断言"有东西渲染出来了"。

## 验收

```bash
node scripts/check-panel.mjs               # 7 条：语法、端点标记、运维视图、端点字段
node cs-agent/panel-dom-smoke.mjs          # 23 条：两个场景真跑面板脚本
node cs-agent/gateway-smoke.mjs            # 109 条不变
bash scripts/verify-all.sh                # 40 步
DSH_DB=1 bash scripts/verify-all.sh       # 40 步
```

`panel-dom-smoke.mjs` 覆盖：

- 空库：脚本不抛错、空状态文案、运维视图四张卡都在、无 webhook 时出站显示"未启用"、
  看计划能渲染出归档/清除计数、空计划不给"执行"按钮、返回按钮回到列表；
- 有死信：造一条投递失败到上限的记录，断言正文预览、重放按钮、尝试次数都在，
  点击重放后消息真的送达（`sent=1 dead=0`、端点共收到 3 次）、审计卡能看到这次重放；
- 全程 `dom.errors.length === 0`：任何一个请求 4xx/5xx 都会让断言失败。

## 已知限制

- DOM 替身不是浏览器：不测 CSS 布局、不测真实事件冒泡/委托、不测 `confirm` 的真实交互。
  它对"字段/判空/接线"有效，对"样式错位"无效。
- 运维视图没有权限控制，和面板其余部分一样**不要暴露到公网**。
- 重放和清除都是手点，没有批量提交审核、没有二次确认输入。
- 面板轮询仍是 5 秒固定间隔（`setInterval`），运维视图不参与轮询，靠「重新检查」手动刷新。
- `panel.js` 仍是一个大模板字符串，只是搬了家；真要模块化得上前端构建，那是另一个决定。

## 回滚

删掉 `cs-agent/panel.js`，把 `panelHtml` 搬回 `gateway.js`，回退 `check-panel.mjs`、
`verify-all.sh`、`package.json` 的改动，删掉 `panel-dom-smoke.mjs`。
功能上没有任何数据变更，回滚只影响界面。

## 下一步

- 面板加登录（至少是 Basic Auth 或反代白名单），现在默认只能绑 127.0.0.1。
- 把「看用量」也搬上面板（`usage_daily` 已落库，缺一个按天的图表）。
- 评测门禁：`eval-rag.mjs` 有结果但没进 CI，缺一条"低于基线就红"的判断。
