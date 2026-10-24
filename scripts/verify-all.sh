#!/usr/bin/env bash
# 重启前跑一遍：静态检查 + 全部测试。任何一项失败就退出非零。
set -euo pipefail
cd "$(dirname "$0")/.."

echo '== client plugin ids'
node scripts/check-client-plugins.mjs

echo '== client runtime'
node scripts/check-client-runtime.mjs

echo '== config placement'
node scripts/check-config.mjs

echo '== panel script'
node scripts/check-panel.mjs

echo '== knowledge base'
(cd cs-agent && node smoke.mjs)

echo '== gateway'
(cd cs-agent && node gateway-smoke.mjs)

echo '== handoff'
(cd cs-agent && node handoff-smoke.mjs)

echo '== ops orchestrator'
(cd cs-ops && node orchestrator-smoke.mjs)

echo '== ocr'
(cd cs-agent && node ocr-smoke.mjs)

echo '== adapter'
(cd cs-agent/adapter && node smoke.mjs)

echo '== qq'
(cd cs-agent/adapter && node qq-smoke.mjs)

echo '== kb import'
(cd scripts && node kb-import-smoke.mjs)

echo '== runtime migration'
(cd scripts && node move-runtime-smoke.mjs)

echo '== retention'
(cd scripts && node retention-smoke.mjs)

echo '== installer'
node scripts/setup-smoke.mjs

echo 'all checks passed'
