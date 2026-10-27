# P1：数据库地基

> 这是「重构到可落地真实使用场景」的第一阶段。**本阶段不改动任何现有行为**：
> 不接网关、不接知识库、不改检索链路，只是把存储层的地基打好，并证明它能用。
>
> 分支 `refactor/production-p0`，基线 tag `pre-refactor`（commit `2f0f276`）。

## 1. 目标与边界

要做的事：把现在「一个 JSON 文件全量重写」的持久化方式，换成「有事务、有约束、
有并发安全」的关系库，为后续把会话、工单、投递、去重迁进去做准备。

明确不做的事：

| 不做 | 原因 |
|---|---|
| 不接 `gateway.js` | 接管会话状态是 P2 的事，混在一起无法判断回归来自哪里 |
| 不迁知识条目正文 | `kb/` 里的 JSON 要人工审核、要 `git diff`、要能回滚，文件是特性不是缺陷 |
| 不引入 ORM | 表结构不多，裸 SQL + 迁移文件比 ORM 更好审 |
| 不改四个包"零依赖"的性质 | 见下面 §3.1 |
| 不要求所有部署都装数据库 | 见下面 §3.2 |

## 2. 交付物

| 文件 | 作用 |
|---|---|
| `docker-compose.yml` | 本地 Postgres，端口 55432，卷 `cs-agent-pgdata` |
| `cs-agent/db/migrations/0001_init.sql` | 9 张表、索引、约束、append-only 触发器 |
| `cs-agent/db/pool.mjs` | 连接池、配置解析、`withTransaction`、`dbHealth` |
| `cs-agent/db/migrate.mjs` | 迁移执行器（带校验和，改历史会报错） |
| `cs-agent/db-smoke.mjs` | 60 条断言，不启用数据库时自动跳过 |
| `scripts/db-up.sh` / `db-down.sh` | 起停脚本，含端口占用检测与健康轮询 |
| `.gitignore` | 加 `.env.db` |
| `cs-agent/package.json` | 加 `./db/pool`、`./db/migrate` 两个导出，`pg` 放 optionalDependencies |
| `scripts/verify-all.sh` | 加一步 `database` |

## 3. 关键决策

### 3.1 为什么要保住"零依赖"

四个包（`cs-agent`、`kb-core`、`cs-panel`、`ops-agent`）此前**零 dependencies**，
靠 node 内置模块就能跑。这带来两个现实好处：装插件不需要联网装包；`node xxx.mjs`
永远能直接跑，不会因为 `node_modules` 缺失而炸。

所以 `pg` 放 `optionalDependencies`，并且**只在 `DSH_DB=1` 时才 `import('pg')`**。
不开数据库的人永远不触发这个依赖；开了的人缺驱动会收到一条明确提示：

```
database driver "pg" is missing (install it with: cd cs-agent && npm install pg)
```

顺带说明否决过的两个方案：手写 Postgres 协议客户端（要处理 SCRAM 认证和扩展查询协议，
安全敏感代码，不值得）；用 `psql` 子进程（每条查询一个进程，连接管理、事务、参数化全丢）。

### 3.2 为什么数据库是"可选"而不是"必需"

现在的部署方式里有纯本机自测、有单机双 profile、有独立机器（见
[deployment-modes.md](deployment-modes.md)）。强制所有人装 Postgres 会让"装完就能用"
的体验断掉，而且并不是每个场景都需要。

`DSH_DB` 未设置时：`dbEnabled()` 返回 `false`，`getPool()` 抛
`DatabaseDisabledError`（code `DB_DISABLED`），`dbHealth()` 直接返回
`{enabled: false, reason: 'disabled'}` 不去连库，`db-smoke.mjs` 打印一行 SKIP 后退出 0。
`scripts/verify-all.sh` 因此在没开数据库的机器上仍然是全绿的。

### 3.3 为什么端口是 55432

本机已有 `orvia-mysql`（3306）和 `orvia-redis`（6379）在跑，且 5432 是同机其他项目的
默认值。用 55432 避开冲突，`DSH_DB_PORT` 可覆盖。

### 3.4 为什么卷挂在 `/var/lib/postgresql` 而不是 `.../data`

Postgres 18 镜像改了数据目录布局，挂在 `.../data` 会直接拒绝启动并打印：

```
Error: in 18+, these Docker images are configured to store database data in a format
which is compatible with "pg_ctlcluster" (specifically, using major-version-specific
directory names)
```

挂在父目录 `/var/lib/postgresql` 则两代都成立：16 用 `<父>/data`，18+ 用 `<父>/18/docker`。
换镜像版本不会因为布局变化而启动失败。

> 本机验证用的是 `postgres:18-alpine`（本机已有该镜像，沙箱拉不到 Docker Hub）。
> `docker-compose.yml` 的默认值仍是 `postgres:16-alpine`，可用 `DSH_DB_IMAGE` 覆盖。

### 3.5 append-only 为什么用触发器 + GUC，而不是数据库权限

工单流水（`ticket_events`）和审计日志（`audit_log`）只能追加，不能改、不能删。
可以靠"不给应用 UPDATE/DELETE 权限"实现，但那要求应用和运维用不同的数据库角色，
本地开发和单机部署会很啰嗦。

改成触发器：`UPDATE` 一律拒绝；`DELETE` 只有当前事务显式执行过
`set local app.allow_purge = 'on'` 才放行。这样保留策略（`scripts/retention.mjs`
那一套）能清理过期数据，而业务代码里的误操作会被数据库挡住：

```
append-only: UPDATE on audit_log refused
```

## 4. 表结构

| 表 | 存什么 | 关键约束 |
|---|---|---|
| `conversations` | 一个客户会话的映射（平台侧 key → DSH session） | `external_key` 唯一；`mode ∈ ai\|human`；`dsh_session_id` 部分唯一 |
| `messages` | 消息正文与 token 用量 | `platform_msg_id` 部分唯一（去重）；`role ∈ user\|assistant\|system` |
| `tickets` | 工单，与 `ops-agent` 的 incident 对应 | `state` 枚举；`incident_id` 部分唯一 |
| `ticket_events` | 工单流水，只追加 | `(ticket_id, seq)` 唯一；触发器禁止改动 |
| `outbox` | 待投递的外发消息，支持重试与重放 | `idempotency_key` 唯一；`state ∈ pending\|sending\|sent\|failed\|dead` |
| `inbound_dedupe` | 入站平台消息去重 | 主键 `(platform_msg_id, channel)` |
| `audit_log` | 谁在什么时候对哪个客户做了什么 | 触发器禁止改动 |
| `usage_daily` | 按天按会话的成本与用量 | 主键 `(day, conversation_id)` |
| `schema_migrations` | 已应用的迁移与校验和 | 迁移内容被改会报错 |

三个为后续阶段预留的字段，现在就要有：

- `conversations.dsh_session_id` —— 业务库和 DSH 自己的 session store 的关联键。
  **DSH 的 session store 不动**（面板、会话搜索、compaction 都依赖它），数据库只存业务视图。
- `conversations.account_id` —— 客户作用域。现在运维查日志靠模型传 `account` 参数，
  服务端没有强制；有了这一列才能在服务端强制"只查这个客户的"。
- `conversations.tenant_id` —— 多租户预留位。现在全是单租户，但加上列比以后改主键便宜。

## 5. 验收

```bash
# 1. 起库（会自动装 pg 驱动、跑迁移）
./scripts/db-up.sh

# 2. 只跑数据库这一层
DSH_DB=1 node cs-agent/db-smoke.mjs

# 3. 全量回归（数据库没开时会自动跳过这一步）
bash scripts/verify-all.sh
```

`db-smoke.mjs` 覆盖三层：

1. **配置层**（不连库）：默认关闭、`DB_DISABLED`、默认端口与库名、`DSH_DB_URL` 优先级、
   密码脱敏、非法端口在解析期报错、`shortHash` 稳定性。
2. **结构与迁移**：9 张表都在；`conversations` 的三个关键列都在；两个 append-only 触发器存在；
   迁移已应用且没有 pending。
3. **约束行为**：唯一键冲突被拒、枚举越界被拒、级联删除不留下孤儿消息、
   `ticket_events`/`audit_log` 不能改、不能删、开了 `app.allow_purge` 才能删。

**所有写操作在一个事务里执行，结束时统一回滚**，所以这个测试可以反复跑，
不会在库里留下任何数据（已验证：跑完后 8 张业务表计数全是 0）。

每条"预期被拒绝"的语句都包在 `savepoint` 里——否则第一条失败的语句会让整个事务
进入 aborted 状态，后续断言全部被 `25P02` 污染，测试会假失败。

本地实测：**60 条断言全部 PASS**，Postgres 18.4；`verify-all.sh` 仍全绿。

## 6. 回滚

P1 是纯新增，没改任何现有代码路径，所以回滚只是"不用它"：

```bash
./scripts/db-down.sh          # 停容器，保数据
./scripts/db-down.sh --purge  # 连数据卷一起删
```

要回到重构前：`git checkout pre-refactor`。

## 7. 已知限制

- `scripts/db-up.sh` 假设本机有 Docker。没有 Docker 的机器需要自己准备 Postgres，
  然后 `DSH_DB_URL=postgres://... ./scripts/db-up.sh` 只跑迁移部分。
- 迁移执行器单进程假设：两个进程同时跑迁移会撞 `schema_migrations` 主键。
  正常部署只有一个迁移入口，够用；要更稳可以加 advisory lock（P2 视需要）。
- `pg` 驱动只在 `cs-agent/` 下装。如果有一天 `ops-agent` 也要连库，它需要自己一份
  `optionalDependencies`，不要跨包 import。
- 数据库还没接任何业务代码，所以现在的 `outbox`、`tickets` 表是空的，
  真实写入路径要等 P2/P3。

## 8. 下一步（P2）

把会话状态从 `sessions.json` 迁到 `conversations` + `messages`，并把
`cs-agent/gateway.js` 里那个 933 行的 `createGateway` 拆开。判据：`gateway-smoke.mjs`
的 109 条断言一条不少，且并发首消息不再重复建会话（当前 `load()` 先置 `loaded = true`
再 `await`，有这个竞态）。
