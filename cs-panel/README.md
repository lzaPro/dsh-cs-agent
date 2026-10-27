# @local/dsh-cs-panel

客服面板：一页看所有对话、接管、回复、归档。挂载在 DSH Web 的侧边栏里。

## 它包含什么

| 文件 | 作用 |
| --- | --- |
| `index.js` | 插件入口：往宿主注册面板页与路由 |
| `client.js` | 浏览器侧渲染（`dsh.client` 声明的 Web 组件） |
| `locale/*.json` | 界面文案 |
| `icon.svg` | 侧边栏图标 |
| `cordis.patch.yml` | 挂载到 profile 的 bundle patch |

## 和网关的关系

面板不直连聊天平台。它读的是 `@local/dsh-cs-agent/gateway` 挂出的 HTTP 端点
（会话列表、历史、接管、归档、死信、保留期）。所以：

- 网关没装 → 面板是空的；
- 网关配了访问令牌 → 面板先显示登录页，见 `cs-agent` 的 `INSTALL.md` 4.12。

## 安装

```bash
dsh plugin install /path/to/cs-panel
```

细节见仓库根目录的 `INSTALL.md`。
