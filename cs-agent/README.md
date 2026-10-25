# 客服 Agent（cs-agent）

一个 DSH bundle：一个「客服」预设 + 一个渠道网关 + OCR + 转运维工具。装进 profile 后，新建任务时可以在预设菜单里选「客服」。

知识库不在这个包里：条目和检索工具在 `@local/dsh-kb`（客服与运维共用一套数据，按 `audience` 门控）。

## 组成

```
cs-agent/
  package.json         bundle 声明，指向 cordis.patch.yml
  cordis.patch.yml     渠道网关 + 客服预设
  gateway.js           外部渠道 → 会话路由 → 回复回推
  handoff.js           ops_handoff：把工单交给运维插件
  gateway-smoke.mjs    网关自测（含 apply 的注册检查）
  handoff-smoke.mjs    转运维自测
kb/                    知识库数据（和工作区同级，不在 bundle 里）
channel/               会话映射和 outbox（运行时生成）
docs/channel-contract.md   适配器契约
```

## 渠道网关

`POST /channel` 收消息，按会话键路由到 DSH 会话，回复通过 `replyWebhook` 推回平台。

| 场景 | 会话键 |
|---|---|
| 私聊 | `<channel>:<senderId>` |
| 群聊 | `<channel>:<groupId>:<senderId>` |

群聊默认**按人分流**，不共享上下文。完整契约见 [channel-contract.md](../docs/channel-contract.md)。

```bash
# 本地试一条
curl -X POST http://127.0.0.1:3080/channel \
  -H 'content-type: application/json' \
  -d '{"channel":"qq","senderId":"u1","messageId":"m-1","text":"扣了9.9元怎么回事"}'

# 看回复（未配置 replyWebhook 时）
curl 'http://127.0.0.1:3080/channel/outbox?limit=5'

# 完整验收（含去重）
./cs-agent/verify.sh
```

### 配置项

| 字段 | 默认 | 说明 |
|---|---|---|
| `route` | `/channel` | 入站路径，prefix 路由 |
| `workspace` | 必填 | 新会话的工作目录 |
| `agentPreset` | 必填 | 新会话用的预设，这里是 `service-desk` |
| `dataFile` | 必填 | 会话键映射 |
| `outbox` | 无 | 回复落盘路径；配了 `replyWebhook` 时可省 |
| `replyWebhook` | 无 | 回复推送到平台适配器的地址 |
| `forward` | `final` | `final` 合并整轮，`all` 逐条发 |
| `token` | 无 | 配了就要求 `Authorization: Bearer` |
| `maxPerMinute` | 20 | 每个会话键每分钟上限 |
| `maxAttachments` | 4 | 单条消息图片数上限 |
| `maxAttachmentBytes` | 8MB | 单张图片大小上限 |
| `dedupeLimit` | 2000 | 记住多少个消息 id |

## 运维是可选的独立插件

`ops_handoff` 工具在客服包里，但调度器和运维预设都在 `@local/dsh-ops-agent` 里。

- 装了 `ops-agent`：转运维可用，多一个「运维」工作区和一个运维控制台
- 没装：客服一切正常，调用 `ops_handoff` 会报「运维插件未安装：请先安装 @local/dsh-ops-agent」

两个包可以分别安装和升级。详见 [ops-agent/README.md](../ops-agent/README.md)。

## 控制台里的「客服」页

装好插件后，**设置 → 客服** 是左侧栏的一级入口（不在「插件」里）：

- 机器人状态（运行中 / 已停止）
- 启动 / 停止按钮（执行 `cs-agent/adapter/qq.sh start|stop`）
- 对话数（自动 / 人工）
- 「打开运营面板」按钮

它只调用网关的 HTTP 接口，不持有任何凭证。

## 运营面板

网关自带一个页面，不用装客户端插件：

```
http://127.0.0.1:3080/channel/panel
```

| 区域 | 内容 |
|---|---|
| 机器人 | 运行状态 + 启动 / 停止 |
| 会话列表 | 群名或备注、渠道、当前模式、最近活动 |
| 搜索 | 按群名、备注、key、客户 id 过滤 |
| 筛选 | 全部 / 人工 / 自动，可切换显示已归档 |
| 批量 | 勾选多个会话，批量归档 / 取消归档 / 删除 |
| 操作 | 接管 / 交还 AI / 直接回复（群聊可 @ 指定人）/ 设置备注 |
| 配置（只读） | 客服预设、三个会话目录、图片模式 |
| 数据路径 | dataFile、imageDir |

**它不改配置文件。** 凭证走「设置 → 客服」里的配置页，提示词走 Agent 预设编辑器——
在网页表单里改运行中的启动参数风险太高。

页面每 5 秒自动刷新，数据来自 `GET /channel/status`、`GET /channel/sessions` 和 `GET /channel/adapter`。

**群名从 QQ 接口取**：`GET /v2/groups/{group_openid}/info` 返回 `group_name`，适配器在收到群消息时查一次并缓存。
取不到就退回显示 `group_openid`。管理员还可以在面板里点「备注」覆盖显示名。

## 会话保留策略

两段式：先归档（隐藏），再清除（删除）。

| 范围 | 归档 | 清除 |
|---|---|---|
| 群聊 | 3 天无活动 | 30 天 |
| 私聊 | 30 天 | 90 天 |

```bash
node scripts/retention.mjs          # dry-run，先看会处理哪些
node scripts/retention.mjs --yes    # 执行
```

- **归档**：打 `archivedAt` + 从工作区摘掉。映射保留，客户再来消息时自动恢复并重新挂载，上下文不丢。
- **清除**：删会话目录 + 映射 + 工作区引用，不可逆。
- 正在人工接管（`mode: human`）的会话永远跳过。

归档的会话不会出现在侧边栏，也不计入面板统计。想改成别的阈值：

```bash
node scripts/retention.mjs --group-archive 1 --group-purge 14 --private-archive 7 --private-purge 30 --yes
```

建议用 cron 每天跑一次 dry-run 加一次 `--yes`，或者先人工看一遍。

## 图片：OCR 而不是多模态

客服收到的截图**不进模型上下文**，而是落盘后给模型一个路径，由 `ocr_image` 读出文字。

原因：主模型是纯文本的，图片块会让请求失败；而且 OCR 结果可缓存、可审计。

### 后端是跨平台的

| 平台 | 后端 | 安装 |
|---|---|---|
| macOS | `vision` | 自带，运行 `tools/build-ocr.sh` 编译一次 |
| Linux | `tesseract` | `apt install tesseract-ocr tesseract-ocr-chi-sim` |
| Windows | `tesseract` | 安装 Tesseract，在配置里写 `tesseractBinary` |

配置（`preset` 里的 `ocr` 行）：

```yaml
backend: auto            # auto | vision | tesseract
visionBinary: /abs/path/tools/bin/ocr
tesseractBinary: tesseract
languages: chi_sim+eng
```

`auto` 的规则：macOS 上优先 Vision，其余平台用 tesseract。选不到后端时插件照常加载，
调用 `ocr_image` 才报错并给出安装指引。

### 安全边界

`ocr_image` 只允许读 `imageRoot` 目录下的文件，防止被诱导读 `/etc/passwd` 之类。

## 客服预设装了什么

| 组件 | 作用 |
|---|---|
| `persona` | 客服工作流程和硬性约束 |
| `tool-fs` | `read` + `read_image`，用来读客户发的报错截图；禁写 |
| `tool-ask-user` | 需要补充信息时结构化提问 |
| `knowledge-base` | 本插件，三个知识库工具 |
| `compaction` | 长对话自动压缩 |

刻意没装：bash、写文件、编辑文件、联网、todo。工具越少，模型选工具的负担越小。

## 三个工具

| 工具 | 什么时候用 |
|---|---|
| `kb_search` | 收到报错后第一件事。按错误特征、服务、环境检索 |
| `kb_get` | 命中后读完整条目：根因、步骤、验证方法 |
| `kb_propose` | 客户确认解决后，把这次的问题写成候选条目 |

`kb_propose` 写进 `kb/_candidates/`，**不参与检索**，等人审后移出并改成 `verified`。

## 改知识库

知识库是 `kb/*.json`，一个条目一个文件，格式见 [kb/README.md](../kb/README.md)。
改完不用重启，`kb_search` 每次调用都会重新读盘。

## 重新安装

改完 `cordis.patch.yml` 或 `index.js` 后要重新安装（预设是在安装时注册的）：

```
plugin_manager install_bundle  target=<仓库路径>/cs-agent
```

或在设置 → 插件里卸载重装。

## 本地自测

```sh
cd cs-agent && node smoke.mjs
```

覆盖：英文错误串、中文查询、服务过滤、未命中、kb_get、候选条目不进检索。
