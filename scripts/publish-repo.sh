#!/usr/bin/env bash
# 把工作区的三个包同步进 dsh-cs-agent 仓库并推送。
#   ./scripts/publish-repo.sh "提交说明"
set -euo pipefail
cd "$(dirname "$0")/.."
REPO=dsh-cs-agent
[ -d "$REPO/.git" ] || { echo "$REPO 不是 git 仓库"; exit 1; }

rsync -a --delete \
  --exclude node_modules --exclude '.env.local' --exclude '.env' \
  --exclude '.build' --exclude 'bin' --exclude '*.tgz' \
  cs-agent cs-ops cs-panel scripts docs tools "$REPO"/
rsync -a INSTALL.md "$REPO"/

cd "$REPO"
git add -A
if git diff --cached --quiet; then
  echo '没有变化'
  exit 0
fi
git commit -q -m "${1:-同步}"
git push -q origin HEAD
git log --oneline -1
