#!/usr/bin/env bash
# 停掉本地数据库。
#
#   ./scripts/db-down.sh          停容器，保留数据
#   ./scripts/db-down.sh --purge  停容器并删掉数据卷（会丢全部业务数据）
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [ -f "$ROOT/.env.db" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$ROOT/.env.db"
  set +a
fi

if [ "${1:-}" = "--purge" ]; then
  echo "▶ 停止并删除数据卷 cs-agent-pgdata ..."
  docker compose down --volumes
  echo "已清空。下次 db-up.sh 会从零建库并跑迁移。"
else
  echo "▶ 停止容器（数据保留在卷 cs-agent-pgdata）..."
  docker compose down
fi
