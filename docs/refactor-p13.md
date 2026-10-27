# P13：访问控制（三种角色 + 浏览器可用 + 令牌不落在 YAML 里）

## 目标

重构前的鉴权只有一行：

```js
if (token !== undefined) {
  const header = req.headers?.authorization ?? ''
  if (header !== `Bearer ${token}`) return sendJson(res, 401, { error: 'unauthorized' })
}
```

它有两个方向的问题，都是"能落地"的硬伤。

**配了令牌 → 面板打不开。** 面板是浏览器里的页面，浏览器不会自动给页面请求加
`Authorization` 头。于是要开面板就得在控制台手动 `fetch` 一遍，或者干脆把令牌删掉。

**不配令牌 → 什么都能调。** 包括：

| 端点 | 后果 |
| --- | --- |
| `POST {route}/delete` | 删任意会话映射 |
| `POST {route}/config` | **改 QQ 凭证**（AppID / AppSecret） |
| `POST {route}/adapter/start` | 起适配器 |
| `POST {route}/replay` | 重放死信（客户会再收到一条消息） |
| `POST {route}/retention` | 按保留期清除客户数据，不可逆 |
| `POST {route}` | 伪造任意客户消息，直接唤醒模型 |

这些在 `127.0.0.1` 上还能接受。一旦按 P4 的方式部署到内网给同事用，或者前面挂了
反向代理，等于把删库和改凭证的按钮挂在网上。

第三个问题小一点但真实：令牌只能写在 `cordis.patch.yml` 里，而这个文件进 git。

## 交付物

| 文件 | 内容 |
| --- | --- |
| `cs-agent/auth.js`（新） | `createAuth` / `readTokenFile` / `constantTimeEqual` |
| `cs-agent/gateway.js` | 删掉那一行鉴权，改成三角色判定 + 面板登录页 + cookie 跳转 |
| `cs-agent/auth-smoke.mjs`（新） | 45 条断言 |
| `cs-agent/cordis.patch.yml` | 注释说明怎么配（不写真实令牌） |
| `cs-agent/package.json` | exports 加 `./auth`；files 加 `auth.js` |
| `scripts/verify-all.sh` | 新增 `== access control`（现 43 步） |

## 三种角色

| 角色 | 谁 | 端点 | 为什么这么分 |
| --- | --- | --- | --- |
| `public` | 编排系统、探针 | `GET {route}/health` | 判断"能不能干活"必须免凭证，否则探针要藏密钥。它只返回队列计数与版本，不含客户数据 |
| `inbound` | 平台适配器 | `POST {route}` | 适配器和运维面板不是同一拨人，凭证不该共用。灌消息的权限不该等于删数据的权限 |
| `admin` | 运维 | 其余全部 | 面板、会话、配置、死信、保留期、审计 |

令牌来源优先级：`Authorization: Bearer` → `x-admin-token` / `x-inbound-token` →
`?token=` → 面板 cookie。

`inboundToken` 没配时**复用** `token`：设了一个凭证却漏配另一个，不该让适配器静默失联。
反向不成立——`inboundToken` 碰不了 admin 端点，测试里有一整条断言盯着这件事。

## 浏览器怎么用

```
GET {route}/panel
  → 401 + 登录页（一个纯 HTML 表单，GET 回 {route}/panel?token=…）

GET {route}/panel?token=…
  → 302 Location: {route}/panel
    Set-Cookie: cs_panel=…; Path=/channel; HttpOnly; SameSite=Strict; Max-Age=43200

GET {route}/panel   （浏览器自动带 cookie）
  → 200 面板
```

三个细节：

1. **登录页不用 JS**。面板本身已经是内联脚本，登录页再塞一段就是"两段脚本都要能跑"，
   而这段平时不会被测试覆盖。表单最笨，也最不会坏。
2. **换成 cookie 再跳转**，是为了让令牌不留在地址栏、不留在浏览器历史、也不留在反向代理
   的访问日志里。
3. **`HttpOnly`**：面板自己的 JS 读不到这个 cookie，XSS 也偷不走。代价是 JS 不能自己清
   cookie——退出登录就是删浏览器数据，够用。

## 令牌怎么放

写文件，不写 YAML：

```yaml
config:
  route: /channel
  tokenFile: ~/.dsh/cs-runtime/data/admin.token       # 权限 600
  inboundTokenFile: ~/.dsh/cs-runtime/data/adapter.token
```

`readTokenFile` 取**第一个非空行**（容忍结尾换行、行首空格），文件权限宽于 `600` 时
警告：

```
channel-gateway: tokenFile … is readable by other users (mode 644); chmod 600 it
```

文件不存在**抛错，不降级**：

```
channel-gateway: cannot read tokenFile …/admin.token: ENOENT: no such file or directory, open '…'
```

这条是有意的。配了 `tokenFile` 却读不到，绝大多数情况是路径写错或文件没同步；
这时候若静默退化成"全开"，运维以为锁上了，实际门是开的。**启动失败比静默开门好。**
反过来，文件存在但内容为空，视为"没配"→ 全开 + 警告（这种情况是"我还没填"，
不是"我填了但丢了"）。

## 比较是常数时间的

```js
export function constantTimeEqual(left, right) {
  const a = createHash('sha256').update(String(left)).digest()
  const b = createHash('sha256').update(String(right)).digest()
  return timingSafeEqual(a, b)
}
```

先各自 sha256 再比：`timingSafeEqual` 要求两个 Buffer 等长，直接比会按长度提前返回，
等于把"令牌多长"泄漏给攻击者。哈希后长度固定，比较才是真的常数时间。

## 关键决策

1. **没配令牌仍然全开，但启动时警告一次**。开发机上每次都要填令牌会让人把令牌写进
   shell 历史；完全关闭又挡住"先跑起来看看"。折中是保留行为 + 明确告警。告警文案
   直接点名后果（"delete, config, replay, retention"），而不是含糊的 "insecure"。
2. **`/health` 默认公开，可关**。探针要么免凭证、要么得存凭证，后者在编排系统里是
   更大的负担。`healthPublic: false` 给"连队列计数都不想暴露"的部署留了口子。
3. **`inboundToken` 未配置时复用 admin 令牌**，理由见上。这条也保证了重构前的
   `token: 'secret'` 配置行为不变（`gateway-smoke.mjs` 的 109 条断言一条没改）。
4. **令牌文件读不到就抛错**，不降级。
5. **`?token=` 只用于换取 cookie**，之后所有请求走 cookie。查询串会进日志，
   不该成为常规通道。
6. **不引入 session 表**。浏览器侧一个 HttpOnly cookie 足够；服务端无需记住谁登录过，
   也就没有"登录态过期要清理"这类账。

## 验收

```bash
node cs-agent/auth-smoke.mjs        # 45/45
node cs-agent/gateway-smoke.mjs     # 109 条不变（含原有的 'secret' 令牌用例）
node cs-agent/panel-dom-smoke.mjs   # 23 条不变（无令牌模式下面板照旧）
bash scripts/verify-all.sh          # 43 步
DSH_DB=1 bash scripts/verify-all.sh # 同上
```

`auth-smoke.mjs` 覆盖：全开模式照旧可用并告警、缺令牌 401 且带 `code: UNAUTHORIZED`、
错令牌 401、`x-admin-token`、`?token=`、cookie 四种来源、`/health` 免令牌且返回可用信息、
`healthPublic: false` 生效、入站令牌与 admin 令牌互不越权、面板登录页是表单、
`?token=` 换 cookie 并 302 且 Location 去掉查询串、cookie 是 HttpOnly/SameSite=Strict
且 Path 限定在 route、错 cookie 回登录页、令牌文件取首个非空行、文件过宽告警、
文件缺失抛错、空文件退全开并告警、常数时间比较跨长度不抛、`classify` 报出凭证来源。

## 已知限制

- **没有用户体系**，只有"有令牌/没令牌"。多个运维共用一个令牌，审计里 `actor` 是
  调用方自己填的名字（`POST /replay` 的 `actor` 字段），不是可信身份。
- **没有速率限制**。令牌被暴力猜的风险靠"令牌足够长"，没有锁定/退避。
- **面板没有 CSRF token**。`SameSite=Strict` 挡住跨站表单提交，但没有二次校验；
  恶意同站页面（如果同源下还跑别的东西）仍可发请求。
- **cookie 不过期回收**。`Max-Age` 到了浏览器就丢，服务端不记，改令牌后旧 cookie
  立即失效（因为每次都重新比对令牌本身）。

## 回滚

```bash
git revert <this commit>
```

`auth.js` 是新增文件，删掉即可；`gateway.js` 恢复成单行 `Bearer` 校验。
`cordis.patch.yml` 里只有注释。运行时数据、数据库都不涉及。

## 下一步候选

- 发布管理：prompt / 知识库版本化 + 灰度。
- `usage_daily` 加单价。
- 数据保留自动跑（定时器）。
- 面板按其能力拆权限（只读账号 vs 能删数据）。
