# 运维 Agent（cs-ops）

可选插件。装了就多一个「运维」工作区和一个可被客服调用的调度器；不装，客服照样能用，只是
`ops_handoff` 会明确告诉你「运维插件未安装」。

## 装了什么

| 行 | 作用 |
|---|---|
| `ops-dispatch` | 每个故障建一个独立运维会话，等结论、超时、通知管理员、回传客服 |
| `preset-ops` | 运维角色：bash + 知识库（ops 视图）+ `cte-rancher-support` skill |

## 和客服包的关系

- 依赖 `@local/dsh-cs-agent` 的知识库插件（`preset-ops` 里引用它的 `role: ops`）。
- 通过 `ctx.provide('opsDispatch', dispatcher)` 暴露调度器。
- 客服包的 `ops_handoff` 用 `ctx.get('opsDispatch')` 查找；找不到就报「未安装」。

两个包可以分别安装、分别升级。卸载 `cs-ops` 不影响客服对话，只是不能转运维。

## 配置

`cordis.patch.yml` 里 `ops-dispatch`：

| 字段 | 说明 |
|---|---|
| `opsPreset` | 用哪个预设，默认 `ops` |
| `workspace` | 运维会话的工作目录 |
| `timeoutMs` | 单任务超时，默认 10 分钟 |
| `taskLog` / `notifyLog` | 任务与告警落盘位置 |
| `notifyWebhook` / `adminId` | 超时或 `needs_human` 时通知管理员 |

## 自测

```bash
cd cs-ops && node orchestrator-smoke.mjs   # 21 项
```
