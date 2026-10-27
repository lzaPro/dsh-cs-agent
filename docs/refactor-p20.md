# P20：端到端安装自检

## 为什么做这一步

前面十九个阶段都在各自的层面上证明"这是对的"：

- `scripts/setup-smoke.mjs` —— 装完之后**目录和文件到位了**；
- `scripts/check-plugin-apply.mjs` —— 每个插件的 `apply()` **不抛**、服务 provide 了、工具 register 了；
- `scripts/packaging-smoke.mjs` —— `npm pack` 发出去的包里**没有凭证、没有漏模块**；
- 各模块的 smoke —— 各自的纯函数与契约。

它们全绿，仍然不回答装完之后的第一个真实问题：

> 我按 INSTALL.md 装完，QQ 上给这个机器人发一句话，它会不会回？重启一次，它还认得这个人吗？

这个问题落在前面几步的**缝**里。历史上这类事故的样子：

| 症状 | 真实原因 |
| --- | --- |
| 装完面板能开，但 `/config` 里 AppID 是空的 | 网关自己拼了 `~/.dsh/cs-runtime`，而不是走 `paths.js` |
| `kb_search` 永远返回 miss | 安装脚本 copy 了 `kb/` 目录但没带 `example-*.json`，目录存在且为空 |
| 回复发不出去，日志里一个 warn 都没有 | 适配器地址读到了默认值，但 `.env.local` 在另一个路径下 |
| 重启后客户被当成新会话，模型什么都不记得 | 会话落盘位置和下次读的位置不一致 |
| 装完第一句话就报 500 | 路由前缀 `/channel` 与面板里写死的 `BASE` 不一致 |

共同点：**每个组件单独看都是对的，接起来是错的。** 单元测试看不见接缝，
所以需要一条穿过所有层的路径。

## 它怎么跑

```
临时 DSH_HOME
  ↓
node cs-agent/install/setup.mjs --home <tmp> --app-id 1024 --app-secret ...   （cwd 在别处）
  ↓
process.env.DSH_HOME = <tmp>            ← 只在"装完之后"设，证明先装后启动的顺序可行
  ↓
真实模块 import：cs-agent/paths.js · kb-core/index.js · kb-core/tools.js · cs-agent/gateway.js
  ↓
假 Host（fakeCtx）+ 假适配器（本地 http server）+ 假模型（注入 assistant/message 事件）
  ↓
一条客户消息 → 回复 → 关停 → 重启 → 同一个客户再发一条
```

全程不联网：适配器是本地 `http.createServer`，模型回包是手工注入的 `session/event`，
QQ 凭证是假的（`--app-id 1024 --app-secret a-secret`）。

## 断言分七组（共 48 条）

### 1. 按文档初始化

- 从**别的目录**（`cwd: tmp`）执行安装脚本 —— 用户不会 `cd` 进包目录再跑 `npx`；
- 安装脚本报告成功、`adapter/.env.local` 落在装好的 runtime 根下。

### 2. 装完的布局够插件用

- `defaultPaths().root` **就是**那个临时 home（这一条错了，后面所有写入都会跑到真实 `~/.dsh`）；
- `customer/` `eval/` `ops/` `data/` `kb/` `adapter/` 六个子目录都在；
- `kb/` 里除 `_template.json` 外**至少一条真实条目**（空目录是"装了但没内容"的典型形态）；
- `kb/_candidates/` 存在（审核闭环的入口）。

### 3. kb-core 真的加载了装好的知识库

- `apply()` 之后 `ctx.get('kbStore')` 拿得到服务；
- `store.stats().shared >= 1`；
- 真调 `kb_search`，命中自带的 `example-disk-full`，且 `verdict === 'direct'`。

第 3 组是"知识库装对了"的唯一可信证据：目录存在、文件存在、能读出来、能搜到、判定够强，
少一层都不算。

### 4. 网关在装好的 home 上起来

- `apply()` 返回 gateway、注册了 `/channel` 路由、至少 5 个 effect 带着 disposer；
- `GET /config` 读得到安装脚本写的 `appId === '1024'`、`hasSecret === true`，
  且响应体里**搜不到明文 secret**，`envFile` 指向装好的那份；
- 新装默认 `auth.mode === 'open'`，日志里有 `no access token configured` 告警；
- `GET /panel` 返回 HTML 且引用的是注册的路由；
- `GET /health` 200、`database === null`（数据库默认关）、`store.kind === 'json'`。

### 5. 一条客户消息走完全程

- `inbound()` 派生出的 key 是 `qq:customer-1`，创建了 session；
- 注入 `assistant/message` + `turn/end`，`flushArchives()` 之后适配器收到**恰好一条**回复，
  文本是模型的原话（不是兜底话术 —— 兜底会把事件形状错误藏起来）；
- `data/outbox.jsonl` 里也有一行，内容与发出的一致；
- `GET /history?key=...` 200。

### 6. 重启后还认得这个客户

- `store.flush()` + 逐个跑 disposer（模拟 dsh 重启）；
- 新 `apply()` 之后同一 `senderId` 发一条新消息，拿回**同一个 `sessionId`**、同一个 key；
- `GET /sessions` 里该会话**只出现一次**（出现两次说明写了两份记录，或者 Map 重建漏了）。

### 7. 装好的 home 之外没有东西被写

- `data/` 下有 `sessions.json`，里面**恰好一条**记录，`key` 与 `senderName` 都对得上；
- `.env.local` 权限仍是 `0600`。

## 三个决策

### 1. 用真模块，不用被测替身

`install-e2e-smoke.mjs` import 的是 `cs-agent/gateway.js`、`cs-agent/paths.js`、
`kb-core/index.js` 本体。替身只出现在"HOST 能力"这一侧（`ctx.*` 与适配器 HTTP 服务器），
因为那些是 DSH 内核提供的东西，不归本仓库维护。

理由：`apply()` 里的 bug（服务名写错、effect 没返回清理函数、路由前缀拼错）
只有跑真代码才看得见，而这些正是本阶段要抓的。

### 2. `DSH_HOME` 在装完之后才设

如果一开始就设好，那么"安装脚本写到了 A、插件读的是 B"这种事故会被掩盖 ——
两边恰好都指向同一个临时目录，测试就绿了。设晚一步，等于强制走一遍
"装到一个位置、再从环境变量读回来"的真实流程。

同理，安装脚本用 `cwd: tmp` 执行：在包目录里跑会让 `process.cwd()` 成为隐式的路径来源，
而用户机器上不是这么用的。

### 3. 断言"没写到别处"，而不只是"写到了这里"

第 7 组检查 `data/`、`sessions.json`、`.env.local` 权限。真正要防的是：
某处代码硬编码了一个路径（比如直接拼 `~/.dsh/cs-runtime`），在开发者机器上"看起来正常"
（因为那个目录已经存在、有旧数据），到了新用户机器上要么报权限错，要么写进别人的 home。

`paths.js` 的设计本来就是"所有路径从这里出"，这条断言是它的回归门禁。

## 踩坑记录

1. **`ctx.tools` 被 Map 覆盖。** 初版 `fakeCtx` 写的是
   `tools: new Map()` 加一个 `tools.get()`，但 `kb-core/tools.js:30` 调的是
   `ctx.tools.register(...)` → `TypeError: ctx.tools.register is not a function`。
   修法：`tools: { register: tool => map.set(tool.name, tool) }`，另留 `toolMap` 给测试取用。
2. **`kbStore.stats()` 不接受 role 参数。** 我按 `search(query, role)` 的形状写成
   `store.stats('customer-service')`，返回的对象里没有 `total` 字段 → 断言报
   `FAIL ... undefined entries`。实际签名是 `async stats()`，返回
   `{shared, internal, candidates, deprecated, recurring, served, embedding}`。
3. **`kb_search` 的返回没有 `results` 字段。** 它的 `execute()` 返回
   `{verdict, confidence, hits, total, margin, clarify, hint}`（输出 schema 是封闭的，
   多一个字段宿主会拒整个结果）。断言要用 `result.hits`。

三个坑都在"测试写错了"，但前两个能犯，恰恰说明**接口没有单一真源可查**：
`stats()` 与 `search()` 的形状不一致，只能靠读实现。这也是本阶段的副产品价值。

## 验收

```bash
node scripts/install-e2e-smoke.mjs     # 48 条，exit 0
bash scripts/verify-all.sh             # 41 步，全绿
DSH_DB=1 bash scripts/verify-all.sh    # 全绿
```

耗时约 1 秒（安装脚本 copy 知识库模板是主要开销），不联网、不占端口（适配器用 `listen(0)`）、
不碰真实 `~/.dsh`。

## 已知限制

1. **没有覆盖真实 QQ 适配器。** 假适配器只验"网关发出的 HTTP 载荷对不对"，
   不验 QQ 开放平台的实际行为（重投频率、消息去重 id 的稳定性）。
2. **没有覆盖 dsh 进程本身。** 这里自己 `apply()` 再 `disposers()`，
   等价于插件生命周期，但不是真的起一个 dsh 进程、走 `ctx.effect` 的真实销毁顺序。
3. **没有覆盖多实例。** 两个进程共用一份存储的情况由 `store-smoke.mjs`
   （跨实例可见）与 `lease-smoke.mjs`（租约互斥）分别覆盖，端到端这条只跑单进程。
4. **知识库只验了一条内置条目。** 真实知识库有几十上百条，检索质量由
   `eval-rag.mjs` + `eval-gate.mjs` 负责，两者不重叠。
5. **没有验 `cs-panel` 的浏览器行为。** 面板 DOM 行为由 `panel-dom-smoke.mjs` 覆盖。

## 回滚

删除 `scripts/install-e2e-smoke.mjs`，并把 `scripts/verify-all.sh` 里的
`== install e2e` 三步删掉即可。没有产品代码改动，回滚零风险。

## 下一步

报告第 9 节的剩余项已经基本清空。接下来可以作为下一阶段的候选：

- `ops_metrics` 的作用域过滤（P18 只覆盖了 k8s 与 logs，指标查询仍按全局配置）；
- 整体验收报告 v2（把 P15–P20 补进去，重新出一次数字）；
- 真实 QQ 沙箱联调清单（把"没覆盖真实适配器"这条变成可执行的人工核对表）。
