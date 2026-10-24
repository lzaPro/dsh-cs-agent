# 平台适配器（platform-adapter）

唯一知道「平台是谁」的一层。它把 QQ / 微信 / Appia 的消息转成网关能吃的 JSON，再把网关的回复发回平台。

```
平台 ──回调──▶ adapter ──POST /channel──▶ gateway ──▶ agent
平台 ◀─发送─── adapter ◀──replyWebhook─── gateway
```

网关不知道平台是什么，适配器不知道 agent 说了什么。

## 跑起来

```bash
# 开发模式：回复从网关 outbox 轮询，打到控制台
ADAPTER_PORT=3091 REPLY_MODE=poll node cs-agent/adapter/cli.js

# 发一条（模拟平台回调）
curl -X POST http://127.0.0.1:3091/platform/message \
  -H 'content-type: application/json' \
  -d '{"channel":"qq","userId":"u1","messageId":"m1","text":"我的容器一直重启，报OOMKilled"}'
```

回复会打印成一行 JSON：

```json
{"sentTo":"user:u1","text":"我查了一下知识库……"}
```

## 配置

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `GATEWAY_URL` | `http://127.0.0.1:3080` | 网关地址 |
| `GATEWAY_TOKEN` | 无 | 网关配了 `token` 时填 |
| `ADAPTER_PORT` | `3090` | 监听端口 |
| `REPLY_MODE` | `poll` | `poll`（开发）或 `webhook`（生产） |
| `TRANSPORT` | `console` | `console` 打印，`http` 转发到 `PLATFORM_SEND_URL` |
| `PLATFORM_SEND_URL` | 无 | `TRANSPORT=http` 时必填 |
| `REQUIRE_MENTION` | `true` | 群消息是否必须 @ 机器人才处理 |

生产环境的链路是：

1. 网关配置 `replyWebhook: http://127.0.0.1:3090/reply`
2. 适配器 `REPLY_MODE=webhook`
3. 平台的消息回调指向适配器的 `POST /platform/message`

## 平台回调要传什么

```json
{
  "channel": "qq",
  "groupId": "g1",
  "userId": "u1",
  "messageId": "平台自己的消息id",
  "text": "消息正文",
  "images": ["https://.../shot.png"],
  "mentioned": true
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `channel` | 是 | `qq` / `wechat` / `appia` |
| `userId` | 是 | 发送者 id |
| `messageId` | 建议 | 平台消息 id，用于去重；不传会自动生成（**就没有跨平台去重了**） |
| `groupId` | 否 | 群聊时填 |
| `text` / `images` | 至少一个 | 纯图片消息可以不带 text |
| `mentioned` | 群聊必填 | 机器人是否被 @ |

适配器也会做一层兜底：群消息没 @ 就直接丢弃，不会打到网关。

## 接入 QQ 机器人（已实现）

`qq.js` 处理了官方 API v2 的全部接入细节，`qq-cli.js` 是可直接运行的服务。

### 1. 开放平台准备

1. 在 [QQ 开放平台](https://q.qq.com/) 创建机器人，拿到 `AppID` 和 `AppSecret`。
2. 配置**回调地址**：必须公网可达的 HTTPS，端口只允许 `80 / 443 / 8080 / 8443`。
3. 订阅事件：至少勾选 `C2C_MESSAGE_CREATE`（私聊）和 `GROUP_AT_MESSAGE_CREATE`（群 @）。
4. 把机器人加进群，或在私聊里添加它。

### 2. 启动

```bash
QQ_APP_ID=你的AppID \
QQ_APP_SECRET=你的AppSecret \
QQ_PORT=8080 \
node cs-agent/adapter/qq-cli.js
```

本地开发需要把 `8080` 暴露成公网 HTTPS（用反向代理、frp、cloudflared 均可）。官方只往这几个固定端口回调。

### 3. 让网关把回复推给它

在 `cs-agent/cordis.patch.yml` 的 `channel-gateway` 配置里加一行，然后重启：

```yaml
replyWebhook: http://127.0.0.1:8080/reply
```

没配之前回复只写 outbox，QQ 用户收不到。

### 4. 已经处理好的

| 项 | 说明 |
|---|---|
| 签名校验 | 每次回调验 `X-Signature-Ed25519`，未通过直接 `401`；算法与官方测试向量逐字节一致 |
| 回调地址验证 | `op=13` 自动回 `{plain_token, signature}` |
| 事件翻译 | 群 @ 和私聊事件转成网关消息，剥掉 `<@!123>` 标记 |
| 被动回复 | 5 分钟内用 `msg_id` + 递增 `msg_seq` 回复，不占主动消息配额 |
| 过期回退 | 超过窗口或 `msg_id` 失效（`304103` 等）自动改发主动消息 |
| Token 缓存 | 提前 60 秒刷新，不会每发一条都换 token |

### 5. QQ 的硬限制（会影响产品设计）

- **被动回复只有 5 分钟、每条消息最多回 5 次**。客服如果查知识库 + 等运维超过 5 分钟，回复就会变成主动消息，受频控（群 20 条/分钟、1000 条/天/群）。
- **群聊必须 @ 机器人才会收到事件**，这是平台的规则，不是我们的过滤。
- **私聊需要用户先添加机器人**。
- **消息里不能带 URL**（`40054010`）。回复里如果出现链接会被拒。

因此客服的回答要短，长内容要主动切分——`split()` 已经做了，但平台侧仍建议控制单条长度。

## WebSocket 模式（推荐，无需公网）

QQ 支持两条收事件的路：Webhook 和 WebSocket。

| | Webhook | WebSocket |
|---|---|---|
| 公网地址 | 必须 HTTPS，端口限 80/443/8080/8443 | **不需要** |
| 部署位置 | 公网服务器 | 本机 / 内网都行 |
| 进程存活 | 无状态，重启不丢事件 | 必须常驻，断了会重连 |
| 适合 | 生产、多实例 | 单机器人、本地、快速验证 |

本地开发和单机部署用 WebSocket：

```bash
QQ_APP_ID=你的AppID QQ_APP_SECRET=你的AppSecret \
REPLY_PORT=8080 \
node cs-agent/adapter/qq-ws-cli.js
```

启动后的输出：

```
qq: connecting
qq: ready as 客服 (session 1ebf...)
```

`ready` 出现就说明鉴权通过、intents 被接受。

**回复通道**：网关配置 `replyWebhook: http://127.0.0.1:8080/reply`（指向本进程）。
没配也能跑，用 `REPLY_MODE=poll` 从 outbox 取回复——但那只是联调备用，延迟 2 秒。

**常驻运行**：

```bash
nohup env QQ_APP_ID=... QQ_APP_SECRET=... node cs-agent/adapter/qq-ws-cli.js \
  >> ~/.dsh/cs-runtime/data/qq.log 2>&1 &
```

进程退出机器人就离线，事件不会补发（除非在 resume 窗口内重连）。

## 接另一个平台

平台相关的代码只有 `transport.send()` 一个函数。以 `http` transport 为例，它把 `{groupId, userId, text}` POST 出去，真实实现替换成平台 SDK 调用即可：

```js
{
  send: async ({ groupId, userId, text }) => {
    if (groupId) await qq.sendGroupMessage(groupId, text)
    else await qq.sendPrivateMessage(userId, text)
  }
}
```

接平台时还需要补三件事，都在适配器这一层：

1. **签名校验**：QQ / 企业微信的回调都带签名头，必须在适配器里验，不能让伪造请求打到网关。
2. **消息 id 映射**：平台的 id 形式各不相同，映射成字符串透传即可。
3. **@ 判定**：从平台回调里判断机器人是否被 @，填进 `mentioned`。

## 已经处理的边界

| 场景 | 行为 |
|---|---|
| 群消息没 @ | 丢弃，不消耗 agent 资源 |
| 回复过长 | 按段落切分，硬上限 `maxChars`（默认 1800），群聊只在第一段加 @ |
| 平台发送失败 | 指数退避重试 3 次 |
| 网关返回 429/500 | 直接抛错给平台，由平台自己重投 |
| 开发重启 | 不重放启动前的历史回复（cursor 默认为启动时刻） |

## 自测

```bash
node cs-agent/adapter/smoke.mjs
```

16 项：私聊/群聊路由、@ 过滤、图片过滤、网关错误透出、@ 提及、长文切分、重试、轮询去重。
