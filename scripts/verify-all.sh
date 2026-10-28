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
echo '== panel view'
node cs-agent/panel-dom-smoke.mjs

echo '== ops client render'
node scripts/check-ops-client-render.mjs

echo '== shared knowledge base'
(cd kb-core && node smoke.mjs)

echo '== rag units'
(cd kb-core && node rag-smoke.mjs)

echo '== tool output schemas'
(cd kb-core && node tools-schema-smoke.mjs)

# 下面两步评的是部署自己的知识库（kb/）。插件包不随发布带 kb/（那是部署数据，
# 且含客户支持话术），所以没有 kb/ 的 checkout 里明确跳过——不要让评测去评空库，
# 那既会误报失败，也会让人以为"评测过了"。单测与门禁自检仍用 kb-core 的演示库跑。
echo '== embedding backend'
node scripts/eval-rag-http-smoke.mjs

echo '== rag retrieval quality'
if [ -d kb ]; then
  node scripts/eval-rag.mjs --strict
else
  echo '   skip: 没有 kb/ 目录（部署知识库不随插件发布）；kb-core 的单测仍在上面跑过'
fi

echo '== retrieval gate'
if [ -d kb ]; then
  node scripts/eval-gate.mjs
else
  echo '   skip: 同上，eval/rag-baseline.json 只对部署自己的知识库有意义'
fi

echo '== gate self-test'
node scripts/eval-gate-smoke.mjs

echo '== gateway'
(cd cs-agent && node gateway-smoke.mjs)

echo '== session store'
node cs-agent/store-smoke.mjs

echo '== reply delivery'
node cs-agent/outbox-smoke.mjs

echo '== write lease'
node cs-agent/lease-smoke.mjs

echo '== inbound accept'
node cs-agent/inbox-smoke.mjs
echo '== health'
node cs-agent/health-smoke.mjs

echo '== alerts'
node cs-agent/alerts-smoke.mjs

echo '== access control'
node cs-agent/auth-smoke.mjs
echo '== lease guard'
node cs-agent/lease-guard-smoke.mjs
echo '== message archive'
node cs-agent/message-smoke.mjs
echo '== usage and cost'
node cs-agent/usage-smoke.mjs
echo '== dead letters'
node cs-agent/dead-smoke.mjs
echo '== retention'
node cs-agent/purge-smoke.mjs
echo '== retention auto'
node cs-agent/retention-auto-smoke.mjs

echo '== handoff'
(cd cs-agent && node handoff-smoke.mjs)

echo '== ops agent'
(cd ops-agent && node smoke.mjs)

echo '== account scope'
node ops-agent/scope-smoke.mjs

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

# 发布包自检：npm pack 会发出去什么。凭证、漏掉的模块、坏的 exports 都在这里现形。
echo '== packaging'
node scripts/packaging-smoke.mjs

# 端到端安装：从空目录按 INSTALL 装一遍，再让真插件收一条消息、回一条、重启后还认得那个客户。
# 前面两步只证明"文件到位""apply() 不抛"，这一步证明"装完真能用"。
echo '== install e2e'
node scripts/install-e2e-smoke.mjs

# 数据库是可选的：没设 DSH_DB 时这个测试自己会打印 SKIP 并返回 0，
# 所以不开数据库的部署仍然是一条命令跑完全部检查。
echo '== database'
node cs-agent/db-smoke.mjs

echo 'all checks passed'
