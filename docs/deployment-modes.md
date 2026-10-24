# 部署模式

客服 agent 可以和你日常开发共用一个 dsh，也可以完全分开。三种模式，按需要选。

| 模式 | 进程数 | 开发重启会影响客服吗 | 适合 |
|---|---|---|---|
| A. 同进程 | 1 | **会**（机器人短暂掉线，期间消息丢失） | 开发、自测 |
| B. 同机双 profile | 2 | 不会 | 有真实客户，还没上生产 |
| C. 独立机器 | 2（另一台） | 不会，且互不争资源 | 正式对外 |

---

## A. 同进程（当前默认）

一个 dsh 进程同时跑你的开发会话和客服会话。**能力上不冲突**：预设是按会话选的，你的会话用 `standard`，客服会话用 `service-desk`。

代价：你重启 dsh 调代码，机器人就掉线。QQ 的 WebSocket 事件不重投，这段时间的消息是真丢。

---

## B. 同机双 profile（推荐）

一条命令多开一个实例，端口不同，数据目录不同。

### 1. 创建客服专用 profile

```bash
dsh --profile cs --from-default-profile web --port 3081
```

第一次会从 `web` 模板复制一份 `cs` profile，然后以 3081 端口启动。
（`--port` 由 web 应用解析，写进 `webStartup` 服务，覆盖默认的 3080。）

### 2. 把插件装到 cs profile

```bash
dsh plugin --profile cs add /绝对路径/cs-agent
```

### 3. 改 cs profile 的配置

`~/.dsh/profiles/cs/cordis.patch.yml` 里，客服相关的路径要和开发实例**完全分开**：

```yaml
- id: channel-gateway
  config:
    privateWorkspace: /Users/you/.dsh/cs-runtime/customer-private
    groupWorkspace: /Users/you/.dsh/cs-runtime/customer-group
    evalWorkspace: /Users/you/.dsh/cs-runtime/eval
    dataFile: /Users/you/.dsh/cs-runtime/data/sessions.json
    outbox: /Users/you/.dsh/cs-runtime/data/outbox.jsonl
    replyWebhook: http://127.0.0.1:8091/reply
```

> 两个实例不要共用 `dataFile`。网关启动时会抢一个 `.lock` 文件，发现被活着的进程占用就直接报错退出——这是故意的，防止两份会话映射互相覆盖。

### 4. 适配器指向客服实例

```bash
cd cs-agent/adapter
QQ_APP_ID=... QQ_APP_SECRET=... \
GATEWAY_URL=http://127.0.0.1:3081 \
REPLY_PORT=8091 \
node qq-ws-cli.js
```

### 5. 验证

```bash
curl http://127.0.0.1:3081/channel/sessions   # 客服实例
curl http://127.0.0.1:3080/channel/sessions   # 开发实例
```

两个都 200，说明互不干扰。

---

## C. 独立机器

同 B，只是把 dsh + 适配器部署到另一台机器。需要处理：

- 那台机器要能出站访问 QQ 网关（不需要公网 IP）
- 备份：`~/.dsh/sessions/` 和 `~/.dsh/cs-runtime/`
- 监控：进程挂了要有人知道（`qq.sh status` 或 systemd/launchd）

---

## 迁移检查清单

从 A 换到 B 时，逐项确认：

- [ ] `dataFile` 换了新路径（否则锁会拒绝启动）
- [ ] 三个 workspace 路径分开（否则两个实例的会话会混在一个工作区）
- [ ] `replyWebhook` 端口和适配器的 `REPLY_PORT` 一致
- [ ] 适配器 `GATEWAY_URL` 指向新端口
- [ ] 旧实例停掉（否则两个适配器会抢同一个 QQ 长连接）
- [ ] 知识库路径可以共用（只读），也可以各自一份

最后一条值得说：**知识库可以共享**，因为它是只读文件；但候选条目是写入的，两个实例都写 `_candidates/` 会混在一起。如果要共享，建议候选目录也分开。
