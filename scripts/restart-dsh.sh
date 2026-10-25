#!/usr/bin/env bash
# 重启本机 dsh（web），并把输出写到日志里，最后自检 /ops/status 是否加载。
#
# 为什么需要它：宿主插件不热替换，改完 @local/* 包必须重启一次；
# 而手动 Ctrl-C 再起，容易忘记把旧进程彻底关掉（端口占用），或把日志丢了。
#
#   ./scripts/restart-dsh.sh --yes     # 必须显式 --yes，避免误杀正在用的 GUI
#
# 注意：重启会中断当前正在跑的 agent 回合。会话本身是持久的，刷新浏览器即可接着用。
set -uo pipefail

if [ "${1:-}" != "--yes" ]; then
  echo "这会杀掉当前的 dsh web 进程。确认要重启就加 --yes："
  echo "  ./scripts/restart-dsh.sh --yes"
  exit 2
fi

# 第一步先把自己变成独立会话：脚本若在 dsh 进程里被调用，杀掉旧 dsh 的同时
# 会把这个进程组一起带走，于是「杀了但没起来」。脱离之后整段逻辑就不受父进程影响。
if [ "${DSH_RESTART_DETACHED:-}" != '1' ]; then
  node -e '
const { spawn } = require("node:child_process")
const [script, ...rest] = process.argv.slice(1)
const child = spawn("bash", [script, ...rest], {
  detached: true,
  stdio: "ignore",
  env: { ...process.env, DSH_RESTART_DETACHED: "1" },
})
child.unref()
console.log(`== detached restarter pid ${child.pid}`)
' "$0" "$@"
  echo "== running detached; progress goes to ~/.dsh/logs/restart.log"
  exit 0
fi

CHECKOUT="${DSH_CHECKOUT:-/Users/lvziang/dev/projects/deepseek-harness}"
PROFILE="${DSH_PROFILE:-web}"
PORT="${DSH_PORT:-3080}"
LOG_DIR="$HOME/.dsh/logs"
LOG="$LOG_DIR/dsh-$PROFILE.log"
PATTERN='apps/cli/src/bin.ts web'

mkdir -p "$LOG_DIR"
if [ "${DSH_RESTART_DETACHED:-}" = '1' ] && [ "${DSH_RESTART_LOGGED:-}" != '1' ]; then
  export DSH_RESTART_LOGGED=1
  exec >>"$LOG_DIR/restart.log" 2>&1
fi

pids=$(pgrep -f "$PATTERN" || true)
if [ -n "$pids" ]; then
  echo "== stopping: $(echo "$pids" | tr '\n' ' ')"
  # shellcheck disable=SC2086
  kill -TERM $pids 2>/dev/null || true
  for _ in $(seq 1 20); do
    pgrep -f "$PATTERN" >/dev/null 2>&1 || break
    sleep 0.5
  done
  leftover=$(pgrep -f "$PATTERN" || true)
  if [ -n "$leftover" ]; then
    echo "== force killing: $(echo "$leftover" | tr '\n' ' ')"
    # shellcheck disable=SC2086
    kill -KILL $leftover 2>/dev/null || true
    sleep 1
  fi
else
  echo '== no running dsh web process'
fi

# pnpm 必须解析成绝对路径：这台机器上它同时存在于 checkout 的 node_modules/.bin
# 和 ~/.local/bin，两者靠 PATH 决定，而 detached 子进程的 PATH 未必和我们一样。
PNPM=""
for candidate in "$HOME/.local/bin/pnpm" "$(command -v pnpm 2>/dev/null || true)"; do
  if [ -n "$candidate" ] && [ -x "$candidate" ]; then PNPM="$candidate"; break; fi
done
if [ -z "$PNPM" ]; then
  echo '== cannot find pnpm (looked at ~/.local/bin/pnpm and PATH)' >&2
  exit 1
fi

echo "== starting: $PNPM -C $CHECKOUT dsh $PROFILE  (log: $LOG)"
# 必须用 detached spawn，而不是 nohup + &：nohup 只挡 SIGHUP，新进程仍在同一个进程组里，
# 本脚本的父进程（也就是被我们杀掉的 dsh）一退出，整组会被一起带走——上一次就是这样，
# 服务停了 8 分钟没起来。detached 会新开会话/进程组，父进程死光也不受影响。
node -e '
const { spawn } = require("node:child_process")
const [pnpm, checkout, profile, log] = process.argv.slice(1)
const fd = require("node:fs").openSync(log, "a")
const child = spawn(pnpm, ["dsh", profile], {
  cwd: checkout,
  detached: true,
  stdio: ["ignore", fd, fd],
  env: { ...process.env, DSH_RESTARTED_AT: new Date().toISOString() },
})
child.unref()
console.log(`== detached pid ${child.pid}`)
' "$PNPM" "$CHECKOUT" "$PROFILE" "$LOG"

echo '== waiting for the HTTP surface'
for _ in $(seq 1 60); do
  code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/channel/sessions" 2>/dev/null || true)
  if [ "$code" = '200' ]; then break; fi
  sleep 1
done

ops=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/ops/status" 2>/dev/null || true)
echo "== /channel/sessions -> $code   /ops/status -> $ops"

if [ "$ops" = '200' ]; then
  echo '== ops plugin loaded. Run: node scripts/check-ops-live.mjs'
else
  echo '== ops plugin NOT loaded; last 40 log lines:'
  tail -n 40 "$LOG"
  exit 1
fi
