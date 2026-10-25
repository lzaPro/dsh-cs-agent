# 首次配置与自检

本指南供首次使用 `cte-rancher-support` 的 CTE 支持人员使用。Skill 只包含查询模板、排障流程和日志脱敏脚本；Grafana 和 Rancher/Kubernetes 的账号密码/kubeconfig 均由操作员自行配置，Skill 文件本身不包含任何凭据。

## 1. 安装前提

- Windows PowerShell 5.1/7，或 Linux/macOS Bash；
- `kubectl` 已安装并可通过 `kubectl version --client` 运行；
- 可访问公司网络或已连接获批的办公网络/VPN；
- 已为当前操作员创建一个**只读** Grafana 账号（不要用个人管理员账号），账号密码已按第 5 节配置为环境变量；
- 平台管理员为当前操作员签发的个人 kubeconfig，且仅包含所需集群和命名空间权限。

不要共享他人的 `%USERPROFILE%\.kube\config`、Rancher Token、浏览器 Cookie 或账号密码。每位用户应使用独立身份，以便审计记录对应实际操作人。

## 2. 配置 kubeconfig

由平台管理员通过获批渠道提供个人 kubeconfig，推荐保存到：

```text
%USERPROFILE%\.kube\config
```

如需使用其他位置，仅在当前 PowerShell 会话指定：

```powershell
$env:KUBECONFIG = 'C:\approved\path\cte-kubeconfig.yaml'
```

Linux/macOS：

```bash
export KUBECONFIG="$HOME/.kube/config"
chmod 600 "$KUBECONFIG"
```

不要把 kubeconfig 放入 skill 文件夹、Git 仓库、聊天附件或共享压缩包，也不要打印其内容进行排障。

## 3. 配置 Rancher 网络绕过

Rancher API 主机需要绕过本机 HTTP 代理。合并到现有列表，不能覆盖原值：

```powershell
$cteBypass = 'rancher-sophgo-prod.appia.cn,.appia.cn'
$env:NO_PROXY = (($env:NO_PROXY, $cteBypass) -ne '' -join ',')
$env:no_proxy = (($env:no_proxy, $cteBypass) -ne '' -join ',')
```

Linux/macOS Bash：

```bash
cte_bypass='rancher-sophgo-prod.appia.cn,.appia.cn'
export NO_PROXY="${NO_PROXY:+$NO_PROXY,}$cte_bypass"
export no_proxy="${no_proxy:+$no_proxy,}$cte_bypass"
```

设置只作用于当前 PowerShell 会话。永久配置应遵循公司的终端管理流程，不要由 skill 擅自修改系统代理或证书设置。保持 TLS 校验；出现证书告警时联系平台管理员。

## 4. 验证 Context 与连通性

```powershell
kubectl config get-contexts
kubectl --context sophnet-openclaw-prod cluster-info
kubectl --context sophnet-openclaw-prod2 cluster-info
```

若返回 `proxyconnect ... 127.0.0.1`，检查 `NO_PROXY`。若返回认证或证书错误，联系平台管理员；不要借用他人凭据或绕过 TLS。

## 5. 配置 Grafana（Agent 自动登录）

从这一版开始，Agent 会直接用浏览器工具登录 Grafana Explore 并执行查询，不再需要操作员手动跑 SQL。Grafana 地址已内置在 Skill 中（`http://grafana-cn-c6k4gh5ju01-vpc.grafana.aliyuncs.com`），操作员只需要提前完成两件事：

1. 找平台管理员申请一个**只读**的 Grafana 账号（只能 `SELECT`，不能写入/DDL，且只能访问团队批准的数据源，如 `prod_mysql`）。**不要**用自己的个人账号或管理员账号。
2. 将账号密码配置为环境变量，供 Agent 读取：

   ```powershell
   # Windows PowerShell（仅当前会话生效）
   $env:CTE_GRAFANA_USERNAME = '<只读账号用户名或邮箱>'
   $env:CTE_GRAFANA_PASSWORD = '<只读账号密码>'
   ```

   长期生效（写入用户级环境变量，只影响新开的终端，不影响当前会话）：

   ```powershell
   setx CTE_GRAFANA_USERNAME "<只读账号用户名或邮箱>"
   setx CTE_GRAFANA_PASSWORD "<只读账号密码>"
   ```

   ```bash
   # Linux/macOS Bash（当前会话）
   export CTE_GRAFANA_USERNAME='<只读账号用户名或邮箱>'
   export CTE_GRAFANA_PASSWORD='<只读账号密码>'

   # 长期生效可追加到 ~/.bashrc 或 ~/.zshrc
   echo 'export CTE_GRAFANA_USERNAME="<只读账号用户名或邮箱>"' >> ~/.bashrc
   echo 'export CTE_GRAFANA_PASSWORD="<只读账号密码>"' >> ~/.bashrc
   ```

不要把这两个变量写进 skill 文件夹、Git 仓库、聊天记录或共享文档；只写入自己的终端 profile 或系统环境变量。密码不会被 Agent 打印、截图或记录到日志中。配置完成后需要**重启当前终端/应用**才能让 SophCode 读取到新的环境变量。

Agent 读取方式（Windows 用户级作用域）：SophCode 的 shell 会话可能继承不到这两个变量（尤其是通过 `setx` 或"用户级"作用域配置时）。此时 Agent 会改用 PowerShell 从用户级作用域读取：

```powershell
[Environment]::GetEnvironmentVariable('CTE_GRAFANA_USERNAME', 'User')
[Environment]::GetEnvironmentVariable('CTE_GRAFANA_PASSWORD', 'User')
```

注意两点：

1. 受控浏览器由 Agent 驱动，操作员无法在其中手动输入，因此登录表单必须由 Agent 填写。这要求 Agent 先读到密码值——读取动作会经过本机工具调用记录，Agent 会在读取前先征得操作员同意，且不会在回复、报告或文件中复述该值。
2. 密码值仅用于通过浏览器 `type` 工具填写登录表单，不用于其他任何用途。


查询模板见 [grafana-query-cookbook.md](grafana-query-cookbook.md)。流程是：Agent 选好模板 → 用浏览器工具登录 Grafana → 在 Explore 中执行该条 `SELECT` → 直接读取并解读结果。从最小字段查询开始，不使用示例中的身份值执行查询。

## 6. 验证最小权限

```powershell
kubectl --context <context> auth can-i get pods -n <namespace>
kubectl --context <context> auth can-i get pods/log -n <namespace>
kubectl --context <context> auth can-i get deployments -n <namespace>
kubectl --context <context> auth can-i get events -n <namespace>
kubectl --context <context> auth can-i get secrets -n <namespace>
kubectl --context <context> auth can-i create pods/exec -n <namespace>
```

常规诊断建议：pods、pods/log、deployments、events 为 `yes`；secrets 应为 `no`；pods/exec 默认应为 `no`，仅在团队流程允许容器内排查时单独授予。以目标资源的 `auth can-i` 结果为准。

## 7. 首次只读验证

使用团队批准的测试 Pool ID 或 Pod：

```powershell
kubectl --context <context> get pods -n <namespace> -o wide
kubectl --context <context> get events -n <namespace> --sort-by=.lastTimestamp
& scripts/Collect-RancherLogs.ps1 -Context <context> -Namespace <namespace> -MoltbotId <pool-id> -SinceMinutes 15
```

Linux/macOS：

```bash
chmod +x scripts/collect-rancher-logs.sh
./scripts/collect-rancher-logs.sh --context <context> --namespace <namespace> --moltbot-id <pool-id> --since-minutes 15
```

确认日志写入当前目录下的 `rancher-logs`，且敏感字段显示为 `[REDACTED]`。分享前仍需人工复核，因为自动脱敏不能保证覆盖所有业务数据。

## 8. 安装与分享

将完整的 `cte-rancher-support` 文件夹复制到每位用户自己的：

```text
# Windows
%USERPROFILE%\.codex\skills\cte-rancher-support

# Linux/macOS
$HOME/.codex/skills/cte-rancher-support
```

随后重启或刷新 Codex skill 发现。只分享 skill 文件夹或发布的 ZIP；不要把 kubeconfig、采集日志、终端历史或凭据一起打包。
