# DSH 客服台

在 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 上跑一套**接 QQ 的客服系统**：
客户消息进来自动答，答不了转给运维 agent，人工随时可以接管。

三个 npm 包，一层渠道网关，全部挂在 DSH 原生插槽上，不改 DSH 源码。

```
客户 QQ ──► 适配器 ──► 渠道网关 ──► 客服 agent ──► 知识库（BM25 + 向量，三级判定）
                                │
                                └──► 运维 agent（可选，只和客服/管理员对话）
```

知识库检索不是关键词匹配：一条故障经验拆成「错误特征 / 现象 / 处置 / 验证」四段分别建索引，
双路召回后融合打分，按置信度判「直接答 / 只当线索 / 判未命中」，未命中时强制追问。
设计细节和实测数字见 [docs/retrieval-design.md](docs/retrieval-design.md)。

## 包

| 包 | 作用 |
|---|---|
| `cs-agent` | 渠道网关、OCR、客服预设、QQ 适配器、安装脚本 |
| `kb-core` | 共享知识库：分块索引、BM25 + 向量融合、三级判定、候选/去重/失效闭环、`kb_search` / `kb_get` / `kb_propose` |
| `cs-ops` | 运维预设 + 派单调度器：每个故障开一个独立运维会话，等结论，超时通知管理员 |
| `cs-panel` | DSH 界面：设置左栏入口、会话标题栏的「接管 / 回复」、侧栏「人」标记 |

工作台是一个独立页面（`/channel/panel`）：会话列表、搜索、归档、备注、人工接管、QQ 凭证配置。

## 快速开始

```bash
# 1. 装依赖（三个包都没有运行时依赖，直接链进 profile 即可）
#    在 DSH 里用 plugin_manager 装上这三个目录，或复制到 profile 的 node_modules

# 2. 初始化运行目录（问你要 AppID / Secret，建目录，写 600 的 .env.local）
node cs-agent/install/setup.mjs

# 3. 启动 QQ 适配器
cs-agent/adapter/qq.sh start

# 4. 打开 DSH：设置 → 客服 → 打开工作台
```

完整步骤（QQ 开放平台配置、OCR、部署模式）见 [INSTALL.md](INSTALL.md)。

## 配置

所有路径都有默认值，落在 `~/.dsh/cs-runtime`：

```
~/.dsh/cs-runtime/
├── adapter/    QQ 适配器 + .env.local（AppID / Secret）
├── kb/         知识库 JSON
├── data/       会话映射、发件箱、任务日志
├── customer-private/  客户私聊会话工作区
├── customer-group/    客户群聊会话工作区
├── eval/        评测隔离工作区
└── ops/         运维会话工作区
```

换位置只改一个环境变量：`export DSH_CS_ROOT=/data/cs-runtime`。

QQ 凭证可以在「设置 → 客服」的配置页里填，也可以跑 `setup.mjs`。改完要重启 dsh（适配器在启动时读环境文件）。

## 测试

```bash
./scripts/verify-all.sh
```

约 500 项检查：知识库（含 27 项检索单测与标注用例的质量评测）、网关（含配置读写）、接管、OCR、适配器、QQ 签名与事件、运维调度、运行时迁移、保留策略、安装器、客户端插槽渲染。

单独跑检索质量：

```bash
node scripts/eval-rag.mjs --strict    # recall@1 / recall@3 / miss-precision / tier-agreement
```

## 目录

```
cs-agent/      客服包 + adapter/ + install/ + kb-starter/
kb-core/       共享知识库（检索、台账、审核闭环、工具）
cs-ops/        运维包
cs-panel/      界面插件（client.js）
scripts/       导入、迁移、保留策略、会话对账、验证
docs/          渠道契约、部署模式、事故台设计、检索设计
tools/         macOS Vision OCR 的 Swift 源码（可选）
```

## 已知限制

- **OCR**：macOS 走自带的 Vision（`tools/build-ocr.sh` 编译），其它平台用 tesseract，配置里把 `backend` 改成 `tesseract`。
- **QQ 主动消息**：需要开放平台给「主动消息」权限；没有权限时，超过 5 分钟被动回复窗口的回复会失败，错误会显示在工作台里。
- **群消息**：默认只推送 @机器人 的消息；要收全部图片消息，需要在开放平台开启「接收所有消息」。
- **运维只读**：运维 agent 只有读权限的工具，写操作要人批准（结论里写清楚动作、影响、回滚）。

## 许可

MIT，见 [LICENSE](LICENSE)。三个包 `cs-agent`、`cs-ops`、`cs-panel` 各自也带一份。
