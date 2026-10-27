# P17：只读角色（能看 ≠ 能删）

## 起因

P13 把访问控制补上了，但只补到"有没有令牌"，没补到"这个令牌能做什么"。

实际后果：值班同事说"帮我看看这个客户昨天说了什么"，你只能把 admin 令牌给他。
拿到的那一刻，他也能：

- `POST /channel/delete` 删掉会话（不可逆，`docs/refactor-p10.md` 里的 purge 也一样）
- `POST /channel/replay` 把死信重放出去（客户可能收到重复回复）
- `POST /channel/retention {dryRun:false}` 批量清除客户数据
- `POST /channel/config` 改掉 QQ 机器人凭证（等于接管了账号）
- `POST /channel/mode` 接管会话，冒充客服给客户发话

这些都是"运维顺手点一下"就能发生的，而它们全都比"看一眼"严重得多。

## 做了什么

### 服务端：三档变四档

| 角色 | 怎么拿到 | 能做什么 |
| --- | --- | --- |
| `public` | 不配令牌（PDF 开放模式） | `GET /health` |
| `inbound` | `inboundToken`（没配则 `token`） | `POST /channel` |
| `viewer` | `viewerToken` | 全部 `GET`（会话、历史、配置**读**、死信列表、审计、用量、保留期计划、面板） |
| `admin` | `token` | `viewer` 的全部 + 所有 `POST` |

`required(method, url, route)` 的规则只有一条：

```js
if (GET {route}/health && healthPublic) return 'public'
if (POST {route}) return 'inbound'
if (GET || HEAD) return 'viewer'
return 'admin'
```

不逐个接口列白名单，是因为白名单会过期：以后新加一个 `POST /channel/rotate-keys`，
忘了归类时"默认 admin"只会更严，不会更松。

### 401 与 403 分开

```
没带令牌 / 令牌不对  → 401 UNAUTHORIZED
令牌对但权限不够    → 403 FORBIDDEN, reason: "this token is read-only"
```

一开始两个都返回 401，测试时发现问题：只读用户点"删除"，界面说"未授权"，
他会以为令牌抄错了，回去翻文件、重试、找运维要新令牌——而真正的原因是他没有这个权限，
换十个令牌也没用。401 表示"你还没证明你是谁"，403 表示"证明了，但不够"。

### 面板：先问角色再画第一屏

`GET {route}/whoami` 返回 `{mode, role, via, readonly, reason}`。面板启动时
`loadWhoami().then(() => refresh())`，在只读时：

- 侧栏出现"只读"标签，悬停说明哪些操作会被拒
- 批量删除按钮不渲染
- 数据保留卡里的"执行"按钮换成一句"只读令牌：可以看计划，不能执行清除"
- 接管/改备注、重放单条、重放全部、启停机器人、保存凭据 六个入口都先拦一道

界面拦截只是照顾体验，真正的边界在服务端——即使有人绕过界面直接发请求，也会收到 403。

### 为什么只读令牌不回落 admin

`inboundToken` 没配时会用 `token`（适配器静默失联比复用凭证更糟）。但 `viewerToken`
反过来回落成 admin 就把这个角色废了：本来想给"能看不能改"，结果配置少写一行，
权限反而升到最高。所以只读令牌缺失就是"没有只读角色"，不是"和 admin 一样"。

同理，两条告警：

- 只配了 `viewerToken` 没配 `token` → 面板能打开但全是灰的，看起来像坏了
  （`nobody can use admin endpoints — set token or tokenFile too`）
- 两个令牌配成同一个值 → 用户以为限制了权限，其实没有
  （`the viewer token equals the admin token; read-only access is not actually restricted`）

## 交付物

| 文件 | 改动 |
| --- | --- |
| `cs-agent/auth.js` | `viewerToken`/`viewerTokenFile`/`viewerCookieName`；`required` 返回四档；`classify` 返回 `status`；`cookieHeader(route, role)` |
| `cs-agent/gateway.js` | 透传 viewer 配置；403 响应；按角色发 cookie；新增 `GET {route}/whoami` |
| `cs-agent/panel.js` | `state.role`/`state.readonly`/`canWrite()`；`loadWhoami()`；`#role-tag`；6 处写操作守卫；隐藏批量删除与执行清除 |
| `cs-agent/auth-smoke.mjs` | 新增 25 条只读用例（现 70 条） |
| `scripts/check-panel.mjs` | 端点标记加 `/whoami`，运维标记加 `id="role-tag"` |
| `cs-agent/cordis.patch.yml` | 注释补 `viewerTokenFile` |
| `INSTALL.md` | 「### 4.12.1 只读令牌」 |

## 关键决策

1. **只读单独一个 cookie 名（`cs_view`）**。同一个人可能同时持两个凭证，角色取决于用哪个；
   塞进一个 cookie 就得把角色编进值里，反而更容易出错，而且会让"用 admin 登过再点只读链接"
   这种情况行为不可预测。
2. **读 = viewer，写 = admin，不逐个接口列**。漏归类的默认更严。
3. **403 不是 401**。理由见上；`auth-smoke.mjs` 里有专门断言两者 body 的 `code` 不同。
4. **`/whoami` 走 GET，所以只读令牌也能问**。它必须能被只读用户调用，否则面板没法知道自己是只读。
5. **面板先问角色再渲染**。默认按 admin 起、拿到 whoami 再关，而不是反过来：
   先渲染后禁用有一瞬间能看到按钮，但先禁后放开需要"未确定"这个第三态穿透所有渲染分支，改动面大得多。
6. **界面拦截与服务端拦截都做**。只有界面拦 = 绕过界面就没了；只有服务端拦 = 满屏点了报错的按钮。

## 验收

```bash
node cs-agent/auth-smoke.mjs             # 70 PASS
node cs-agent/gateway-smoke.mjs          # 109 PASS（GET 改成 viewer 后无回归）
node cs-agent/panel-dom-smoke.mjs        # 23 PASS
node cs-agent/health-smoke.mjs           # 22 PASS
node cs-agent/retention-auto-smoke.mjs   # 44 PASS
bash scripts/verify-all.sh               # exit 0
DSH_DB=1 bash scripts/verify-all.sh      # exit 0
```

## 已知限制

- **只读能看到全部客户数据**。敏感部署要再细一档（按账户、按渠道），当前没做。
- **面板里"配置"页对只读可见但不显示 secret**（`getConfig()` 本来只返回 `hasSecret`），
  这是有意的：值班的人需要知道机器人配的是哪个 appId 才能排查。
- **没有审计"谁读了多少"**。审计只记写操作（replay/purge/archive）；读操作量大，当前没记。
- **cookie 没有 `Secure` 属性**。面板通常跑在 127.0.0.1 或内网 http，加 `Secure` 会直接失效；
  上公网必须在 TLS 后面，见 INSTALL 里的说明。

## 回滚

不配 `viewerToken` 就是 P16 的行为（`viewer` 角色不存在，所有 GET 仍要 admin 令牌）。
要整体回退：`git revert <this commit>`。

## 下一步

报告第 9 节剩下的：账户作用域强制（`handoff` 的 `account` 目前只靠 Prompt 约束）、
告警接线（`/health` 503 没人收到通知）、端到端安装测试。
