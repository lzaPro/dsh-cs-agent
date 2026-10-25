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

echo '== plugin apply'
node scripts/check-plugin-apply.mjs

echo '== panel script'
node scripts/check-panel.mjs

echo '== ops client render'
node scripts/check-ops-client-render.mjs

echo '== shared knowledge base'
(cd kb-core && node smoke.mjs)

echo '== rag units'
(cd kb-core && node rag-smoke.mjs)

echo '== tool output schemas'
(cd kb-core && node tools-schema-smoke.mjs)

echo '== rag retrieval quality'
node scripts/eval-rag.mjs --strict

echo '== gateway'
(cd cs-agent && node gateway-smoke.mjs)

echo '== handoff'
(cd cs-agent && node handoff-smoke.mjs)

echo '== ops agent'
(cd ops-agent && node smoke.mjs)

echo '== ocr'
(cd cs-agent && node ocr-smoke.mjs)

echo '== adapter'
(cd cs-agent/adapter && node smoke.mjs)

echo '== qq'
(cd cs-agent/adapter && node qq-smoke.mjs)

echo '== kb import'
(cd scripts && node kb-import-smoke.mjs)

echo '== kb review'
(cd scripts && node kb-review-smoke.mjs)

echo '== runtime migration'
(cd scripts && node move-runtime-smoke.mjs)

echo '== retention'
(cd scripts && node retention-smoke.mjs)

echo '== installer'
node scripts/setup-smoke.mjs

echo 'all checks passed'
