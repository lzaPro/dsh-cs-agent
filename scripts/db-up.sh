#!/usr/bin/env bash
# 一条命令把本地数据库拉起来并迁移到最新。
#
#   ./scripts/db-up.sh
#
# 做的事：读 .env.db（可选）→ 起容器 → 等健康检查 → 确保驱动 → 跑迁移。
# 幂等：重复执行只会说"已经是最新"。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [ -f "$ROOT/.env.db" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$ROOT/.env.db"
  set +a
fi

export DSH_DB_PORT="${DSH_DB_PORT:-55432}"
export DSH_DB_NAME="${DSH_DB_NAME:-cs_agent}"
export DSH_DB_USER="${DSH_DB_USER:-cs_agent}"
export DSH_DB_PASSWORD="${DSH_DB_PASSWORD:-cs_agent_dev}"

say() { printf '%s\n' "$*"; }

if ! docker info >/dev/null 2>&1; then
  say "Docker 没在运行。先启动 Docker Desktop，再重跑这条命令。" >&2
  exit 1
fi

# 端口被人占了就明确报出来，不要等到容器起不来才猜。
if command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:"$DSH_DB_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  holder="$(lsof -nP -iTCP:"$DSH_DB_PORT" -sTCP:LISTEN | awk 'NR==2 {print $1" (pid "$2")"}')"
  if [ "$(docker ps --filter "name=cs-agent-postgres" --format '{{.Names}}' 2>/dev/null)" != "cs-agent-postgres" ]; then
    say "端口 $DSH_DB_PORT 已被占用：$holder" >&2
    say "在 .env.db 里写 DSH_DB_PORT=<另一个端口> 后重试。" >&2
    exit 1
  fi
fi

say "▶ 启动 postgres ..."
docker compose up -d

say "▶ 等待就绪 ..."
for _ in $(seq 1 60); do
  status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' cs-agent-postgres 2>/dev/null || echo missing)"
  case "$status" in
    healthy) say "  就绪（healthy）"; break ;;
    missing) say "  容器不存在，启动失败" >&2; exit 1 ;;
  esac
  sleep 1
done
if [ "${status:-}" != "healthy" ]; then
  say "容器在 60 秒内没变成 healthy，看一下日志：" >&2
  say "  docker logs --tail 50 cs-agent-postgres" >&2
  exit 1
fi

# 驱动是可选依赖：不装也能跑（只要不开库）。这里只在缺的时候装一次。
if ! (cd "$ROOT/cs-agent" && node -e "import('pg').then(()=>process.exit(0),()=>process.exit(1))" >/dev/null 2>&1); then
  say "▶ 安装数据库驱动 pg（可选依赖）..."
  # --cache 指到仓库内，避免写到 $HOME 被沙箱拦下。
  # --no-save：依赖已经声明在 optionalDependencies 里，不要让 npm 改写 package.json。
  (cd "$ROOT/cs-agent" && npm install --no-save --no-package-lock --cache "$ROOT/.build/npm-cache" pg@^8)
fi

say "▶ 应用迁移 ..."
(cd "$ROOT" && DSH_DB=1 node cs-agent/db/migrate.mjs)

say ""
say "数据库就绪：postgres://127.0.0.1:${DSH_DB_PORT}/${DSH_DB_NAME}"
say "连进去看：docker exec -it cs-agent-postgres psql -U ${DSH_DB_USER} -d ${DSH_DB_NAME}"
