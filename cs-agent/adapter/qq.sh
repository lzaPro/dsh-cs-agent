#!/usr/bin/env bash
# QQ 机器人（WebSocket）进程管理：start / stop / restart / status / logs
# 凭证由 adapter/.env.local 提供，不需要在命令行输入。
set -u

DIR="$(cd "$(dirname "$0")" && pwd)"
RUNTIME="${DSH_CS_ROOT:-$HOME/.dsh/cs-runtime}/data"
PID_FILE="$RUNTIME/qq.pid"
LOG_FILE="$RUNTIME/qq.log"
ENTRY="$DIR/qq-ws-cli.js"

mkdir -p "$RUNTIME"

running() {
  [ -f "$PID_FILE" ] || return 1
  local pid
  pid="$(cat "$PID_FILE" 2>/dev/null)"
  [ -n "${pid:-}" ] && kill -0 "$pid" 2>/dev/null
}

start() {
  if running; then
    echo "already running (pid $(cat "$PID_FILE"))"
    return 0
  fi
  if [ ! -f "$DIR/.env.local" ]; then
    echo "missing adapter/.env.local" >&2
    return 1
  fi
  # Detach into a new session so the service outlives the shell that started it.
  if command -v setsid >/dev/null 2>&1; then
    setsid node "$ENTRY" >> "$LOG_FILE" 2>&1 &
  else
    python3 -c 'import os, sys; os.setsid(); os.execvp(sys.argv[1], sys.argv[1:])' \
      node "$ENTRY" >> "$LOG_FILE" 2>&1 &
  fi
  echo $! > "$PID_FILE"
  sleep 3
  if running; then
    echo "started (pid $(cat "$PID_FILE"))"
    tail -n 3 "$LOG_FILE"
    return 0
  fi
  echo "failed to start; last lines:" >&2
  tail -n 10 "$LOG_FILE" >&2
  return 1
}

stop() {
  if ! running; then
    echo "not running"
    rm -f "$PID_FILE"
    return 0
  fi
  local pid
  pid="$(cat "$PID_FILE")"
  kill "$pid" 2>/dev/null
  for _ in $(seq 1 20); do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.25
  done
  kill -9 "$pid" 2>/dev/null
  rm -f "$PID_FILE"
  echo "stopped"
}

status() {
  if running; then
    echo "running (pid $(cat "$PID_FILE"))"
    local port
    port="$(grep -E '^REPLY_PORT=' "$DIR/.env.local" 2>/dev/null | tail -1 | cut -d= -f2 | tr -d '[:space:]')"
    curl -s -m 2 "http://127.0.0.1:${port:-8080}/health" || echo "(health endpoint unreachable)"
    echo
  else
    echo "not running"
  fi
}

case "${1:-start}" in
  start) start ;;
  stop) stop ;;
  restart) stop; start ;;
  status) status ;;
  logs) tail -f "$LOG_FILE" ;;
  *) echo "usage: $0 {start|stop|restart|status|logs}" >&2; exit 2 ;;
esac
