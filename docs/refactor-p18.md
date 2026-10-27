# P18：账户作用域强制（工单只能看它自己的机器）

## 起因

客服把工单交给运维时，`ops_handoff` 有个 `account` 参数——客户叫什么、用的哪个环境。
但它在系统里只是一行字：派单器把它写进任务卡（`**账号信息**：acme`），模型读到这句话，
然后自己去猜该看哪个 namespace。

服务端没有任何东西把"这张工单属于 acme"和"这次取证只能碰 acme"连起来。两个真实后果：

1. **跨客户取证**。模型看到 `acme`，也可能顺手 `kubectl get pods -n globex-prod`。
   重构前 `cluster.js` 只有全局 `namespaces` 白名单，运维为了方便通常配 `['*']`——
   等于任何一张工单都能读整个集群。
2. **`-A` 扫全集群**。更常见的是模型不写 namespace（`kubectl get pods` 默认当前
   namespace，但 `-A` 或空 namespace 时就等于全扫）。一张 acme 的工单，输出里混进
   globex 的 pod 名和报错信息，运维照着念给客户——这就成了数据泄漏。

这两个都不是"模型不听话"，是**系统没给它边界**。Prompt 里的约束在长上下文里会衰减，
而数据边界必须是硬约束。

## 做了什么

三层，自上而下：

```
config.accounts: { acme: {namespaces:[acme-prod], contexts:[prod], aliases:[...]}, ... }
        │  派单时
        ▼
dispatcher.dispatch() → scopes.set(opsSessionId, scope)     ← 绑定"这张工单是 acme"
        │  工具执行时
        ▼
cluster.k8s(args, scope) → assertScoped → checkNamespace → kubectl
```

### 1. `ops-agent/scope.js`（纯函数，无 IO）

| 函数 | 作用 |
| --- | --- |
| `parseAccounts(raw)` | 把配置解析成条目表，配错直接抛（`accounts 必须是对象`、`空账号 id`、`accounts.acme 必须是对象`） |
| `scopeFor(accounts, raw)` | 工单上的 `account` 字段 → 作用域对象；不认识的账号标记 `unknown`，没写标记 `unbound` |
| `effectiveNamespaces(global, scope)` | **交集**：全局 `*` 遇上账号列表 → 以账号为准 |
| `effectiveContexts(global, scope)` | 同上 |
| `describeScope(scope)` | 给人看的一句话，也进 `ops_env` 的输出 |

`scopeFor` 的三种"有问题"状态是分开的，因为它们对应三种不同的处置：

- `configured:false` —— 没配账号表。不限制，行为与重构前完全一致。
- `unbound:true` —— 配了表但工单没写账号。取证拒绝，让客服补。
- `unknown:true` —— 写了但表里没有。取证拒绝，让管理员补表。

### 2. `ops-agent/cluster.js`：拒绝，而不是"尽力而为"

```js
function assertScoped(scope) {
  if (scope?.unbound === true) throw new Error('ops_k8s: 这张工单没有账号信息…')
  if (scope?.unknown === true) throw new Error('ops_k8s: 账号「x」不在账号映射表里…')
}
```

`checkNamespace(namespace, scope)` 多一条：**作用域生效时省略 namespace 直接拒绝**。

```js
if (scopeActive(scope) && (namespace === undefined || namespace === '')) {
  throw new Error('ops_k8s: 这张工单绑定了账号作用域，必须显式写 namespace；'
    + '不写会退化成扫全集群，拒绝执行')
}
```

这条是 P18 里最要紧的一处。允许"不写 namespace"在任何一条路径上都会漏——`kubectl get
pods -A`、`kubectl get events`（全 namespace）、`kubectl top pods --all-namespaces`。
与其逐个堵 `-A`，不如要求"必须点名"，不点名就拒。拒绝信息里还带了该怎么改，模型不会卡住。

`ops_env` 的 `hints` 在作用域生效时追加一句：

```
本工单账号：acme。取证时必须显式写 namespace，且只能用该账号的：acme-prod。
```

这句话是给模型看的——提前告诉它边界，比让它撞墙再改便宜。

### 3. `ops-agent/dispatcher.js`：绑定的那一刻

```js
const scope = scopeFor(accounts, normalized.account)
scopes.set(opsSessionId, scope)
```

一个工单一个运维会话（P1 之前就是这样），所以**会话 id 就是工单身份**。
`scopeFor(sessionId)` 暴露出去，`cluster.apply()` 里通过 `ctx.get('opsDispatch')`
每次现问——不能缓存，因为预设可能先于派单器挂载。

不认识的账号**不拦派单**，只记一条 warn：

```
ops-dispatch: incident INC-... has no usable account scope: 账号「initech」不在账号表里
```

理由：运维至少得能回一句"这张单缺账号信息"，把他挡在门外连这句话都说不出。

### 4. `ops_env` 的 schema 同步

`ops_env` 的 output schema 加了 `account` 和 `scope` 两个字段，都进 `required`，
`render` 加一行 `account scope: ${value.scope}`。

这一步不能省。`docs/` 里记着历史上 `kb_search` 漏声明输出字段、导致工具硬错误的那次
（`8dbd177`）。schema 声明了但实现没给 → 工具调用直接失败；实现给了但 schema 没声明
→ 字段被悄悄丢掉，模型看不到。两边必须一起改。

## 交付物

| 文件 | 改动 |
| --- | --- |
| `ops-agent/scope.js` | 新建：解析、作用域计算、命名空间/context 交集、描述 |
| `ops-agent/cluster.js` | `assertScoped`、`checkNamespace` 强制点名、`env/k8s/logs` 接受 scope、`apply()` 接派单器、三个工具改成 `execute(args, exec)`、`scopedHint` |
| `ops-agent/dispatcher.js` | `scopes` Map、`dispatch()` 绑定、`scopeFor()`、warn、`dispose/removeIncident` 清理 |
| `ops-agent/scope-smoke.mjs` | 新建：**58 条**（纯函数 26 + cluster 强制 19 + 派单绑定 7 + 工具执行链路 6） |
| `ops-agent/package.json` | exports `./scope`、files 加 `scope.js` |
| `ops-agent/cordis.patch.yml` | `accounts` 配置示例与说明 |
| `scripts/verify-all.sh` | `== account scope` 一步 |
| `INSTALL.md` | 「### 4.14 账号作用域」 |

## 关键决策

1. **交集，不是并集**。全局 `namespaces: ['*']` 的意思从"所有"变成"所有客户的总和，
   单张工单再按客户收窄"。写反了等于没配，而且是那种"配了以为安全"的没配。
2. **拒绝，不是截断**。越界请求直接抛错，而不是"悄悄换成允许的 namespace 继续"。
   静默改写会让运维以为是 globex 的机器没问题，其实是查了 acme 的。
3. **必须显式写 namespace**。理由见上，这是唯一能一次堵住所有 `-A` 变体的规则。
4. **不认识的账号拒绝，不猜测**。猜错方向比拒绝危险得多。
5. **不拦派单**。工单照建，工具层拒绝。运维能回"缺信息"，而不是"门都进不去"。
6. **`account` 支持别名且忽略大小写**。客服写"Acme Inc"、"acme.com"、"ACME" 都能对上——
   客服不该被要求记住内部账号 id。
7. **没配账号表 = 完全不限制**。这是"可选增强"的一致性：不配就没有这层，和 P2/P3
   的开关一样，默认不改变现有行为。

## 验收

```bash
node ops-agent/scope-smoke.mjs   # 58 PASS
node ops-agent/smoke.mjs         # 78 PASS（原有行为无回归）
bash scripts/verify-all.sh       # exit 0
DSH_DB=1 bash scripts/verify-all.sh  # exit 0
```

`scope-smoke.mjs` 的四段：

- **纯函数**：解析报错、别名、大小写、交集语义、`*` 收窄、`unbound`/`unknown`/`configured:false` 三态
- **cluster 强制**：本账号通过、他账号拒（且报 `本工单账号`）、省略 namespace 拒、越界 context 拒、logs 同规则、`ops_env` 报窄化后的清单
- **派单绑定**：`dispatch()` 后 `scopeFor(opsSessionId)` 拿到正确作用域；没写账号的单 unbound；未知账号 unknown
- **工具执行链路**：`apply()` 注册的三个工具，从 `exec.agent.session.id` 一路解析到作用域——这条才是生产里真正跑的路径

最后一段是补测的。前三段都是"单元正确"，只有这一段能证明 `execute(args, exec)` 的
`exec` 真的被用上了。加它的时候发现我最初的测试只测到 cluster 层，把 `scopeOf` 传进去
却忘了传给 `k8s()`——5 条失败，暴露的正是"接线漏了但单元测试全绿"这种最危险的形态。

## 已知限制

- **只按命名空间隔离**。同一 namespace 里多个客户（共享集群）挡不住。
- **`ops_metrics` 没有作用域**。Prometheus/Grafana 查询目前是全量的，按标签过滤取决于
  运维写 PromQL 时自己加 `namespace="acme-prod"`。下一阶段可做的是把 `scope` 注入
  `ops_metrics` 的默认标签过滤。
- **`account` 由客服填写**。客服写错（把 globex 写成 acme）时，服务端不会发现——
  它只保证"工单写的是哪个，就只能看哪个"。
- **告警只写日志**。unbound/unknown 只 `ctx.logger.warn`，没有进台账也没有面板提示。
  真实运营里配错账号表会静默持续一段时间。

## 回滚

不配 `config.accounts` 就是 P17 的行为。要整体回退：`git revert <this commit>`。

## 下一步

报告第 9 节剩下的：告警接线（`/health` 503 没人收到通知）、端到端安装测试。
`ops_metrics` 的作用域过滤是 P18 自然的延续，可以并进去。
