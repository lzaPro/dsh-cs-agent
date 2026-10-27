# P14：发布包自检（`npm pack` 会把真凭证发出去）

## 起因

前十三阶段一直在加代码：`auth.js`、`trace.js`、`time.js`、`audit.js`、`retention.js`、
`panel.js`、`store*.js`、`outbox*.js`、`lease.js`、`inbox.js`。每个新文件都要手动加进
`cs-agent/package.json` 的 `files[]`——纯粹靠人记住。

于是很自然地问了一个问题：**如果漏加，会怎么样？**

答案不是"包小一点"，是装出来的包 `import` 就崩。而这类错误只有真实安装的人才会遇到，
本机永远跑得好好的（本机读的是工作区，不是包）。

顺着这个问题查下去，`npm pack --dry-run` 直接给出一个更糟的结论：

```
$ cd cs-agent && npm pack --dry-run
npm notice 366B  adapter/.env.local          ← 真实的 QQ AppSecret
npm notice 4.1kB adapter/smoke.mjs
npm notice 10.4kB adapter/qq-smoke.mjs
```

`files[]` 里写了 `adapter` 这个**目录**，目录里的东西整包带走——
`adapter/.env.local` 里是 `QQ_APP_ID` 和 `QQ_APP_SECRET`。谁从 npm 装了 `cs-agent`，
谁就拿到了我们的机器人凭证。这不是"包有点大"。

全局搜索确认影响面：只有 `cs-agent` 这一个包带 `.env.local`，`ops-agent` 的
`skills/**/*.md` 里没有凭证明文。

## 一件必须先讲清的 npm 规则

第一反应是加一个包根 `.npmignore`：

```gitignore
.env
.env.*
```

**没用。** npm 文档写明：包根的 `.npmignore` **不能覆盖 `files[]`**，只有**子目录里**的
`.npmignore` 才能排除该子目录内的文件。所以正确写法是 `cs-agent/adapter/.npmignore`。

这个反直觉之处非常危险：根上加了一行 `.npmignore`，看起来像修好了，`npm pack` 仍然把
凭证带出去。所以验证方式不能是"我加了 ignore 文件"，只能是**直接问 npm 要文件清单**。

## 交付物

| 文件 | 内容 |
| --- | --- |
| `scripts/packaging-smoke.mjs`（新） | 77 条断言：四个包各跑一次 `npm pack`，查凭证/漏文件/坏 exports，并真装一次 |
| `cs-agent/adapter/.npmignore`（新） | 排除 `.env*`、`*smoke*.mjs`、密钥 |
| `cs-agent/{db,install,kb-starter}/.npmignore`、`cs-panel/locale/`、`ops-agent/{skills,locale}/`（新） | 同上，凡 `files[]` 里是目录的都放一份 |
| `kb-core/package.json` | **补 5 个漏掉的模块**（见下） |
| `ops-agent/package.json` | 补 `icon.svg`（`exports['./icon']` 指向它却没打包） |
| `cs-panel/README.md`（新） | `files[]` 声明了却不存在 |
| `kb-core/LICENSE`、`ops-agent/LICENSE`、`cs-panel/LICENSE`（新） | 同上，从 `cs-agent/LICENSE` 复制（同为 MIT） |
| 四个 `package.json` | 各加 `"//files"` 说明"列目录要先给目录配 `.npmignore`" |
| `scripts/verify-all.sh` | 新增 `== packaging`（现 44 步） |

## 修掉的两个真 bug

**1. `kb-core` 发出去的包直接不能用。**

`files[]` 只列了 `index.js`、`tools.js`、`kb.js`，但 `index.js` 的依赖链是：

```
index.js → hybrid.js → bm25.js / chunks.js / embed.js / kb.js
         → stats.js
```

漏了 5 个模块。装了这个包的人 `import '@local/dsh-kb'` 会得到：

```
Cannot find module '.../node_modules/@local/dsh-kb/hybrid.js'
```

本机测不出来，因为本机用的是工作区里的相对路径。

**2. `ops-agent` 的 `./icon` 指向不存在的文件。**

`exports` 里有 `"./icon": "./icon.svg"`，`icon.svg` 在磁盘上，但 `files[]` 没列它 →
发布包里没有这个文件 → 任何 `import '@local/dsh-ops-agent/icon'` 都 404。

这两个都是"exports 说得比 files 多"。检查里专门有一条断言对这件事：
**每个 export 目标都必须在打包清单里。**

## 检查怎么做的

不自己实现 npm 的打包规则——那一定会和 npm 漂移。直接问 npm：

```js
const { files } = JSON.parse(stdout)[0]   // npm pack --dry-run --json
```

然后六类断言：

1. **不该发的**：凭证（`.env*`、`*.token`、`*.key`、`*.pem`、`.npmrc`）、测试
   （`*smoke*.mjs`）、日志与缓存、`.DS_Store`。逐类给标签，失败时列出具体文件。
2. **该发的**：`exports` 里每个静态目标都在清单里；通配符出口（`./locale/*.json`）
   至少匹配到一个文件。
3. **`files[]` 自洽**：每条要么存在，要么展开后非空（目录）。防止声明了却不存在的路径
   （就是 `LICENSE` / `README.md` 那两条）。
4. **bundle patch 跟着走**：`dsh.bundle.patch` 指向的 `cordis.patch.yml` 必须在包里，
   否则 `dsh plugin install` 拿到的是没有挂载配置的包。
5. **`package.json` / `README.md`** 在包里。
6. **真装一次**：把清单里的文件复制到临时目录，然后 `import()` 每个 JS 入口，
   断言能加载且有导出。这一步才是抓"漏文件"的终局手段——它跑的是包的形状，
   不是工作区的形状。

`dsh.client` 声明的 `./client` 入口是浏览器模块（模块作用域里就有 `window`），
node 里 import 必然抛错，所以单独标记为"已打包但不 import"，并把它写进通过项，
免得读者以为是漏测。

**反向验证过**：把 `files[]` 里的 `time.js` 删掉再跑，检查给出 4 条失败并点名
`Cannot find module .../time.js`——正是它要抓的那类问题。

## 关键决策

1. **问 npm 而不是自己算**。打包规则（`files[]`、`.npmignore`、`.gitignore` 回退、
   总是包含 package.json/README/LICENSE）细节多且会变；复刻一份等于制造第二个真源。
2. **真的 import 一遍**。文件清单对了不代表能用——入口解析、`exports` 条件、
   ESM/CJS 边界都可能出问题。代价是每个包多起一个 node 进程（四个包共约 1 秒）。
3. **子目录 `.npmignore` 而不是把 `files[]` 改成逐文件**。逐文件更安全但要手工维护
   `adapter/` 下十来个文件，且新增文件会被静默漏掉；目录 + 子目录 ignore 的失效模式是
   "多发了东西"，而这条正是检查第 1 类断言盯着的。
4. **`LICENSE` 补文件而不是从 `files[]` 删掉**。MIT 声明在 `package.json` 里，
   但分发时附一份正文是常识（也满足一些合规扫描器）。
5. **检查进 `verify-all`**，每次改动都跑。它只要 2-4 秒，而它能拦住"发布出去的包是坏的"
   这类事后才发现成本极高的错误。

## 验收

```bash
node scripts/packaging-smoke.mjs      # 77/77
cd cs-agent && npm pack --dry-run     # 人工确认：没有 .env.local，没有 smoke
bash scripts/verify-all.sh            # 44 步
DSH_DB=1 bash scripts/verify-all.sh   # 同上
```

## 已知限制

- **检查的是 `npm pack`，不是 `publish-repo.sh` 的镜像**。`dsh-cs-agent` 那个 GitHub 仓库
  由 `rsync` 同步（已排除 `.env.local`），是另一条发布路径；比重构前的 git 仓库多出来的
  风险不在这里。
- **不检查依赖是否可解析**。四个包零运行时依赖（`pg` 是 optional），所以现在没有这个
  问题；将来真的加依赖时，这里会漏掉"依赖版本冲突"。
- **不检查 `dsh plugin install` 的端到端行为**。`scripts/setup-smoke.mjs` 覆盖安装器，
  但那是从工作区装，不是从 tarball 装。
- **大小没有阈值**。目前四个包合计 < 200KB，没有为它设上限，避免无意义的维护。

## 回滚

```bash
git revert <this commit>
```

只涉及 `package.json` 的 `files[]` 补项、若干 `.npmignore`、三个 `LICENSE`、
一个 `README.md` 和一个新脚本。删掉不会影响运行时。

## 下一步候选

- 发布管理：prompt / 知识库版本化 + 灰度。
- `usage_daily` 加单价。
- 数据保留自动跑（定时器）。
- 从 tarball 装一遍的端到端测试（`npm pack` → 装 → 起网关）。
