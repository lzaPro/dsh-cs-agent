# CTE Rancher 环境路由

以下为生产环境提示，访问权限和工作负载位置可能变化，必须在运行时验证。

| Context | 常见 OpenClaw 命名空间 |
|---|---|
| `sophnet-openclaw-prod` | `openclaw`, `openclaw2`, `openclaw3` |
| `sophnet-openclaw-prod2` | `openclaw4`, `openclaw5`, `openclaw6` |

Rancher API 主机为 `rancher-sophgo-prod.appia.cn`。如果使用 HTTP 代理，将该主机和 `.appia.cn` 合并进当前会话的 `NO_PROXY` 与 `no_proxy`，不得覆盖原列表。

常用入口：

- Grafana：`http://grafana-cn-c6k4gh5ju01-vpc.grafana.aliyuncs.com/`
- Rancher：`https://rancher-sophgo-prod.appia.cn/dashboard/home`

Grafana 使用团队授权的内部实例和 `prod_mysql` 等只读 MySQL 数据源。数据源 UID 和组织可能调整，运行时必须从已登录页面确认；不要把登录 Cookie、密码、客服密钥或 API Token 写入 skill。

```powershell
kubectl config get-contexts
kubectl --context <context> auth can-i get pods -n <namespace>
kubectl --context <context> auth can-i get pods/log -n <namespace>
kubectl --context <context> get pods -n <namespace> -o wide
kubectl --context <context> get events -n <namespace> --sort-by=.lastTimestamp
```

只有在已通过获批的 Grafana 流程取得 Pool ID 且不知道命名空间时，才在上述已授权命名空间中按 `moltbot-<pool-id>-` 前缀有限搜索。不要搜索未授权命名空间。
