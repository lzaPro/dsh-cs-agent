# P21：指标查询的作用域边界

## 问题

P18 把 `ops_handoff` 的 `account` 变成了 k8s 取证路径上的硬约束：
绑了账号的工单，`ops_k8s` / `ops_logs` 只能读那个账号的命名空间，不写 namespace 直接拒绝。

**但同一张工单还能调 `ops_metrics`，而它接受任意 PromQL。** 上一阶段留下的这个口子，
足以把 P18 的隔离整个绕过：

```promql
sum(rate(http_requests_total[5m]))              # 没有标签选择器：跨全部命名空间聚合
{namespace="globex-prod"} rate(errors_total[5m]) # 直接读别人的错误率
sum by (namespace) (container_memory_usage)     # 一次把所有客户都列出来
```

更糟的是指标看起来"不像数据"：运维把 globex 的延迟数字念给 acme 的客户听，
不会有人意识到那是泄漏。

## 为什么不能靠解析 PromQL

PromQL 是一门完整语言：子查询、二元运算符、`by`/`without` 聚合、`label_replace`、
`vector(...)`、`absent(...)`。要在客户端静态判定"这条查询只碰了哪些标签值"，
等于实现半个 PromQL 求值器，而且一旦漏掉一种语法，泄漏就是静默的。

选的方向是**反过来**：不证明查询安全，只接受能一眼看懂边界的写法。

## 规则（作用域生效时）

| 查询形态 | 结果 |
| --- | --- |
| 没有 `namespace` 匹配器 | 拒绝：`必须显式写 namespace 匹配器` |
| `namespace="acme-prod"`（在允许列表里） | 通过 |
| `namespace="globex-prod"` | 拒绝：`不属于本工单账号` |
| `namespace=~"acme-prod\|acme-staging"`（全部在允许列表里） | 通过 |
| `namespace=~"acme-prod\|globex-prod"` | 拒绝：点名 `globex-prod` |
| `namespace=~"acme-.*"` | 拒绝：`无法证明它不会匹配到别的客户` |
| `namespace!="globex-prod"` / `namespace!~"..."` | 拒绝：`排除掉一个客户，剩下的仍然包含所有别的客户` |
| 工单没写账号 / 账号不在表里 / 账号没配命名空间 | 拒绝，并说明该找谁补 |

判定发生在**构造请求之前**：被拒的查询一个字节都不会出网。

### 为什么允许 `|` 枚举，而不允许 `.*`

`|` 枚举的每个分支都是字面量，可以逐个核对是否在白名单里；`.*` 不是——
`acme-.*` 会匹配 `acme-secret-project`，而后者可能是另一个客户的命名空间。
白名单的意义就是"能穷举的才允许"。

实现上 `literalAlternatives()` 剥掉 `^`/`$` 锚点后按 `|` 切分，任何分支里出现
正则元字符（`. * + ? [ ] ( ) { } ^ $ \`）就返回 `undefined`，调用方一律拒绝。

### 为什么不加 `ignore_error` 之类的手动放行

一条"我知道我在干什么"的开关，三个月后一定会出现在所有查询上。
宁可让模型改写查询（错误信息里直接给了可用的写法），也不要留一个长期被打开的后门。

## 交付物

| 文件 | 改动 |
| --- | --- |
| `ops-agent/promql.js` | 新增。`namespaceMatchers(promql)`、`literalAlternatives(value)`、`checkMetricsScope(promql, scope)` |
| `ops-agent/metrics.js` | `apply()` 里取 `ctx.get('opsDispatch').scopeFor`（调用时现问，不缓存）；`createMetrics(config, { scopeOf })`；`query(args, scope)` 发请求前 `checkMetricsScope`；`execute(args, exec)` 走 `sessionScope(metrics, exec)` |
| `ops-agent/scope-smoke.mjs` | 新增「指标作用域」一段（28 条）：匹配器识别、枚举展开、七种拒绝、工具链路、未配账号不限制 |
| `ops-agent/package.json` | exports 加 `./promql`，files 加 `promql.js` |
| `ops-agent/cordis.patch.yml` | `accounts` 注释块说明指标也必须写 namespace |
| `INSTALL.md` | 4.14 节补 PromQL 规则与正反例 |

## 关键决策

1. **作用域在调用时现问，不缓存。** 与 cluster 一致：派单器可能晚于指标插件挂载，
   `apply()` 时 `ctx.get('opsDispatch')` 还是 `undefined`。
2. **没有 `exec` 就不限制。** 模型在会话外被调用（调试、单测）时没有工单上下文，
   这时强行拒绝会让工具彻底不可用。判断依据是 `exec?.agent?.session?.id`。
3. **违规是抛错，不是返回 `{ok:false}`。** 与 `ops_k8s` 的 namespace 检查一致：
   这是"调用方式不对"，不是"后端查不到"，混进 `ok:false` 会被当成临时故障重试。
4. **配置缺失也算违规。** 账号表里没写 `namespaces` 时拒绝执行，而不是"不限制"——
   缺配置的默认值必须是安全的那一侧。
5. **输出 schema 没动。** 拒绝走的是异常路径，`ops_metrics` 的返回结构保持
   `{ok, configured, data, ...}` 不变，宿主侧的校验规则不用跟着改。

## 踩坑

**`scopeFor(accounts, raw)` 的第一个参数是 `parseAccounts()` 的结果，不是原始配置对象。**
测试里我直接写 `scopeFor({ acme: { namespaces: [...] } }, 'acme')`，
得到的是 `{configured: false, ...}` —— 于是所有"应该被拒绝"的断言全部失败，
而"应该通过"的那条也失败（`namespaces` 是空数组）。

这个坑值得记下来，因为它说明 `scope.js` 的两个函数耦合得比签名看起来更紧：
`parseAccounts` 的返回值形状（`{configured, entries}`）是 `scopeFor` 的隐含契约，
类型上没有任何约束。修法是在测试里一律先 `parseAccounts(...)` 再 `scopeFor(...)`，
与生产代码（`dispatcher.js`）的调用方式保持一致。

## 验收

```bash
node ops-agent/scope-smoke.mjs     # 86 条（原 58 + 指标 28）
node ops-agent/smoke.mjs           # 78 条，无回归
node scripts/check-config.mjs      # 7 rows, 0 problems
node scripts/packaging-smoke.mjs   # promql.js 已进发布包
bash scripts/verify-all.sh         # 全绿
DSH_DB=1 bash scripts/verify-all.sh
```

## 已知限制

1. **只认 `namespace` 这一个标签。** 真实部署里客户边界也可能体现在 `cluster`、
   `tenant`、`service` 等标签上。加新标签需要在 `promql.js` 里显式扩展
   （目前写死 `namespace`），这是有意的：多认一个标签就多一份误判风险。
2. **不检查聚合后的语义。** `sum by (namespace)` 里即使带了允许的 matcher，
   模型仍可能把结果读给错误的客户。这是"运维看懂了不该说"的问题，不是工具能解决的。
3. **`ops_metrics` 之外的 HTTP 出口没有同类检查。** 目前只有这一个工具能发外部请求，
   以后新增（比如日志平台、链路追踪）需要各自实现等价边界。
4. **`ops_env` 仍然不报指标作用域。** 它报的是 k8s 侧边界；模型要靠错误信息
   才知道 PromQL 也要写 namespace。可以把两者合并进 `ops_env`，本轮没做。

## 回滚

删除 `ops-agent/promql.js`，`metrics.js` 里去掉 import、`scopeOf` 参数、
`checkMetricsScope(...)` 一行和 `sessionScope` helper，`package.json` 去掉
`./promql` 与 `promql.js`，`scope-smoke.mjs` 删掉指标段。
产品行为回到 P18 状态（指标不受账号约束）。

## 下一步

报告第 9 节的清单已经清空。接下来候选：

- `ops_env` 一并报出指标边界（把"要写 namespace"从错误信息提前到开工提示）；
- 整体验收报告 v2（把 P15–P21 补进去，重出数字）；
- 真实 QQ 沙箱联调清单。
