# 渠道接入契约（Channel Contract）

平台适配器和 agent 之间只有两个方向的 JSON。适配器不需要知道 DSH，agent 不需要知道 QQ 还是微信。

## 一、会话键

| 场景 | key | 效果 |
|---|---|---|
| 私聊 | `<channel>:<senderId>` | 一个用户一个会话 |
| 群聊 | `<channel>:<groupId>:<senderId>` | 同一个群里，每个人仍然是独立会话 |

**群聊默认按人分流，不共享上下文。** 如果某天要做「群 = 一个工单」，把 key 换成 `<channel>:<ticketId>` 即可，路由层不用改。

key 与 sessionId 的映射持久化在 `~/.dsh/cs-runtime/data/sessions.json`，重启后继续复用。

## 二、入站：平台 → Agent

`POST http://127.0.0.1:3080/channel`

```json
{
  "channel": "qq",
  "groupId": "group-123",
  "senderId": "user-456",
  "messageId": "platform-msg-789",
  "text": "下单一直报 502，截图在下面",
  "attachments": [
    "https://cdn.example.com/shot.png"
  ]
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `channel` | 是 | 平台标识：`qq` / `wechat` / `appia` / `web` |
| `senderId` | 是 | 平台内的用户标识 |
| `text` | 否 | 消息正文。**text 和 attachments 至少要有一个** |
| `groupId` | 否 | 群聊必填；私聊不要传 |
| `messageId` | 否 | 平台消息 id。**强烈建议传**，用于去重 |
| `attachments` | 否 | 图片 URL 数组，或 `{ url, mediaType?, name? }`；最多 4 张，每张上限 8MB |

`attachments` 由网关下载并存入 DSH 的附件存储，模型看到的是真正的图片，不是链接。只接受 `image/*`，其他类型会被拒绝。

### 响应

| 状态 | 含义 | 响应体 |
|---|---|---|
| `202` | 已受理，开始处理 | `{ "key": "qq:user-456", "duplicate": false, "sessionId": "chan-..." }` |
| `200` | 重复消息，已忽略 | `{ "key": "...", "duplicate": true, "sessionId": "..." }` |
| `400` | 参数错误 / 附件拉取失败 | `{ "error": "..." }` |
| `401` | 鉴权失败 | `{ "error": "unauthorized" }` |
| `429` | 触发限流 | `{ "error": "...", "retryAfter": 12 }` + `Retry-After` 头 |

## 运维接口

| 接口 | 作用 |
|---|---|
| `GET /channel/sessions` | 列出会话键 → sessionId |
| `GET /channel/outbox?limit=N` | 最近的出站消息（本地联调） |
| `POST /channel/reset` | `{"key":"qq:xxx"}` 丢一个映射，或 `{"all":true}` 全清；下次消息重建会话 |

**什么时候要 reset**：改过 agent 预设之后。DSH 的会话保留创建时的预设版本，改了预设只影响新会话——老会话会一直用旧版本。所以要 `reset` 掉受影响的会话，让它按新预设重建。

## 存储布局

```
~/.dsh/cs-runtime/
  customer-private/   客服-私聊   ← 私聊会话（独立工作区）
  customer-group/     客服-群聊   ← 群聊会话（独立工作区）
  eval/               客服-评测   ← 评测流量，与真实客户完全隔离
  ops/                运维        ← 运维会话
  data/               sessions.json / outbox / ops-tasks / admin-notify / qq.log
```

会话按**渠道级别**落在不同目录，Web UI 里也分成不同工作区，不会混进开发工作区。
清理：`node scripts/cleanup-sessions.mjs [--yes]`。

## 三、出站：Agent → 平台

配置了 `replyWebhook` 时，每条回复 POST 到该地址：

```json
{
  "key": "qq:user-456",
  "channel": "qq",
  "groupId": null,
  "senderId": "user-456",
  "text": "这是 Sophclaw 的订阅费用：首月 9.9 元……",
  "at": "2026-10-23T04:33:12.000Z"
}
```

适配器据此决定发到哪：`groupId` 为空发私聊，否则发群并 @ `senderId`。

没配 `replyWebhook` 时写入 `~/.dsh/cs-runtime/data/outbox.jsonl`，可用 `GET /channel/outbox?limit=50` 查看——本地联调用。

## 四、回复粒度

`forward` 配置决定发什么：

| 值 | 行为 | 适合 |
|---|---|---|
| `final`（默认） | 缓冲整个 turn，`turn/end` 时合并成一条 | 客服：客户只看到结论，看不到中间工具调用 |
| `all` | 每条 assistant 消息立即发 | 需要逐字流式感的场景 |

**运维过程绝不会出现在这里**：运维是子会话，它的输出回到客服会话，由客服决定怎么说。

## 五、去重与限流

**去重**：同一个 `messageId` 只会处理一次。已处理的 id 持久化在 `~/.dsh/cs-runtime/data/sessions-seen.json`，默认保留最近 2000 条。平台重投（QQ/微信都可能重试）不会重复开 turn。

不传 `messageId` 就没有去重保护——适配器应该尽量传。

**限流**：每个会话键默认每分钟 20 条，超过返回 `429`。按 key 隔离，一个人刷屏不影响别人。计数在内存里，重启归零。

## 六、平台适配器长什么样

适配器是一个独立的小服务（Python / Node 都行），不碰 DSH：

```python
# 伪代码
@on_message
def handle(msg):
    requests.post("http://127.0.0.1:3080/channel", json={
        "channel": "qq",
        "groupId": msg.group_id,        # 私聊时为 None
        "senderId": msg.user_id,
        "messageId": msg.message_id,    # 平台的消息 id，用于去重
        "text": msg.text,
        "attachments": [img.url for img in msg.images],
    }, headers={"Authorization": "Bearer ..."})

@app.post("/reply")                     # 对应 replyWebhook
def reply(body):
    if body["groupId"]:
        platform.send_group(body["groupId"], f'@{body["senderId"]} {body["text"]}')
    else:
        platform.send_private(body["senderId"], body["text"])
```

适配器只做三件事：**转发消息、发回回复、处理平台鉴权**。业务逻辑一律不放在适配器里。

## 七、为什么这样切

- 换平台只改适配器，agent、知识库、会话都不动。
- 会话键在网关里定，平台适配器不需要理解「上下文隔离」。
- 回复走 webhook 而不是让 agent 直接调平台 API：agent 不持有任何平台凭证。

## 八、还没做的

| 项 | 说明 |
|---|---|
| 群聊 @ 判断 | 网关不判断是否被 @，由适配器过滤（否则群里每条消息都会触发） |
| 非图片附件 | 只处理图片；文件、语音需要另接 |
| 回复分段 | 超过平台长度限制的长回复要适配器自己切 |
