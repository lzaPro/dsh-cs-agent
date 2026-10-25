# 安装客服插件

四个包，装完就能用。运行目录默认在 `~/.dsh/cs-runtime`，可用 `DSH_CS_ROOT` 改。

| 包 | 必需 | 作用 |
|---|---|---|
| `dsh-kb` | ✅ | 共享知识库服务 + `kb_search`/`kb_get`/`kb_propose` 工具（客服与运维共用） |
| `dsh-cs-agent` | ✅ | 渠道网关、OCR、客服预设、QQ 适配器 |
| `dsh-ops-agent` | 可选 | 运维预设 + 派单器 + 只读集群/日志/指标工具 + 控制面板 |
| `dsh-cs-panel` | 建议 | 控制台里的「客服」页和会话标题栏按钮 |

## 1. 初始化

```bash
npx dsh-cs-setup
```

它会问你要 QQ 机器人的 AppID 和 AppSecret，然后：

- 创建运行目录：`customer`、`eval`、`ops`、`data`、`adapter`、`kb`、`kb/_candidates`、`ops-kb`
- 技能目录不用手工建：运维技能随 `@local/dsh-ops-agent` 包发（`ops-agent/skills/`），
  用户级技能放 `~/.agents/skills/` 或 `~/.dsh/skills/`，两个预设都会读
- 把 QQ 适配器复制到 `~/.dsh/cs-runtime/adapter`
- 写入 `~/.dsh/cs-runtime/adapter/.env.local`（权限 600）
- 复制知识库模板（已有内容不会被覆盖）

非交互方式：

```bash
npx dsh-cs-setup --app-id 123456 --app-secret xxxxx
```

## 2. 安装插件

在 DSH 的「设置 → 插件」里，把这两个/三个目录作为本地插件装上：

```
<包目录>/kb-core         # 必需：知识库服务
<包目录>/cs-agent
<包目录>/cs-panel        # 建议
<包目录>/ops-agent       # 可选：运维 agent
```

装完重启 dsh。

## 3. 启动

- 打开「设置 → 客服」（左侧栏一级入口），点「启动」
- 或者命令行：`~/.dsh/cs-runtime/adapter/qq.sh start`

工作台：`http://127.0.0.1:3080/channel/panel`
运维控制台（装了 `ops-agent` 才有）：`http://127.0.0.1:3080/ops/panel`

## 4. 配置（一般不需要）

所有路径都有默认值。要覆盖时改插件配置：

| 配置 | 默认值 |
|---|---|
| `privateWorkspace` / `groupWorkspace` | `<运行根>/customer` |
| `evalWorkspace` | `<运行根>/eval` |
| `dataFile` | `<运行根>/data/sessions.json` |
| `outbox` | `<运行根>/data/outbox.jsonl` |
| `imageDir` | `<运行根>/data/images` |
| `adapterCommand` | `<运行根>/adapter/qq.sh` |
| `sessionsRoot` | `~/.dsh/sessions` |
| `kbDir`（预设内） | `<运行根>/kb` |
| 运维 workspace | `<运行根>/ops` |

换整个根目录只需要一个环境变量：

```bash
export DSH_CS_ROOT=/data/cs-runtime
```

## 4.1 知识库维护

日常只有三件事，都在 `scripts/` 里：

```bash
node scripts/kb-import.mjs --from ./导出 --to ~/.dsh/cs-runtime/kb --write   # 批量导入（默认 dry-run）
node scripts/kb-review.mjs list                                            # 看 agent 提交的候选
node scripts/kb-review.mjs verify <id>       # 入库；加 --ops 进运维 runbook
node scripts/kb-review.mjs expire <id> --reason "已被新版本修复"             # 标记失效，不再参与检索
node scripts/kb-review.mjs stats             # 各目录条目数、出现次数排行
node scripts/eval-rag.mjs                    # 改完条目跑一遍检索质量
```

候选条目在人工 `verify` 之前**不参与检索**。检索的打分权重、阈值、向量后端都在 `kb-core/cordis.patch.yml` 的 `tuning` 与 `embedding` 段，留空即默认值。

## 5. OCR

图片消息默认落盘成路径，模型用 `ocr_image` 读文字。

- **macOS**：运行 `tools/build-ocr.sh` 生成 Vision 二进制，装到 `<运行根>/bin/ocr`；或装 tesseract
- **Linux/Windows**：装 tesseract，然后在预设里把 `ocr` 的 `backend` 改成 `tesseract`

没有可用的 OCR 后端时，工具会告诉你缺什么，不会静默失败。

## 6. QQ 平台设置

- 机器人类型：群聊/单聊
- 群聊要能收到消息：用户必须 **@机器人**；想接收群里所有消息（含未 @ 的图片），需要在开放平台开启「接收所有消息」
- 被动回复窗口：客户最后一条消息后 **5 分钟**，同一消息最多 5 条。超时会转主动消息，需要单独申请权限

## 7. 升级

```bash
# 重新拉取包后
npx dsh-cs-setup --force     # 只更新适配器，不动知识库和凭证
# 重启 dsh
```

预设改动只对新会话生效；旧会话如果出现装配错误，网关会自动丢弃映射并重建。

## 8. 卸载

```bash
~/.dsh/cs-runtime/adapter/qq.sh stop
# 在「设置 → 插件」里移除全部本地包
rm -rf ~/.dsh/cs-runtime
```

会话日志在 `~/.dsh/sessions` 下，不会随插件删除。

## 发布到 npm

包名现在是 `@local/...`，发布前改成你自己的 scope：

```bash
node scripts/rename-scope.mjs --to @yourscope
node scripts/check-client-plugins.mjs   # 客户端模块 id 必须和包名一致
cd kb-core && npm publish --access public
cd ../cs-agent && npm publish --access public
cd ../ops-agent && npm publish --access public
cd ../cs-panel && npm publish --access public
```
