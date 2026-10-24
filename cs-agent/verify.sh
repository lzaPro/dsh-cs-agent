#!/usr/bin/env bash
# Live acceptance check against a running dsh web.
#   ./cs-agent/verify.sh [base-url]
# Triggers exactly one model turn, then re-sends the same message id to prove dedupe.
set -u

BASE="${1:-http://127.0.0.1:3080}"
CHANNEL="$BASE/channel"
STAMP="$(date +%s)"
MSG_ID="verify-$STAMP"
fail=0

say() { printf '%s %s\n' "$1" "$2"; }
check() {
  if [ "$1" = "$2" ]; then say PASS "$3"; else say FAIL "$3 (got $1, want $2)"; fail=1; fi
}

code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

check "$(code "$CHANNEL/sessions")" 200 "GET /channel/sessions"

check "$(code "$CHANNEL/outbox?limit=1")" 200 "GET /channel/outbox"

first="$(curl -s -o /tmp/cs-verify-1.json -w '%{http_code}' \
  -X POST "$CHANNEL" -H 'content-type: application/json' \
  -d "{\"channel\":\"qq\",\"senderId\":\"verify-user\",\"messageId\":\"$MSG_ID\",\"text\":\"我账户扣了9.9元，怎么回事\"}")"
check "$first" 202 "first message accepted"

second="$(curl -s -o /tmp/cs-verify-2.json -w '%{http_code}' \
  -X POST "$CHANNEL" -H 'content-type: application/json' \
  -d "{\"channel\":\"qq\",\"senderId\":\"verify-user\",\"messageId\":\"$MSG_ID\",\"text\":\"我账户扣了9.9元，怎么回事\"}")"
check "$second" 200 "duplicate message rejected from processing"

if grep -q '"duplicate":true' /tmp/cs-verify-2.json; then
  say PASS "duplicate flag present"
else
  say FAIL "duplicate flag missing"
  fail=1
fi

if grep -q '"key":"qq:verify-user"' /tmp/cs-verify-1.json; then
  say PASS "session key routed to qq:verify-user"
else
  say FAIL "unexpected session key"
  fail=1
fi

printf '\nwaiting 30s for the reply...\n'
for _ in $(seq 1 30); do
  sleep 1
  if curl -s "$CHANNEL/outbox?limit=20" | grep -q '"key":"qq:verify-user"'; then
    say PASS "reply reached the outbox"
    curl -s "$CHANNEL/outbox?limit=1"
    printf '\n'
    exit 0
  fi
done

say FAIL "no reply within 30s (check the session in the Web UI)"
curl -s "$CHANNEL/outbox?limit=5"
printf '\n'
exit 1
