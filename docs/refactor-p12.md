# P12：评测门禁（检索逐条比基线 + 回复可判定回归）

## 目标

前面十一阶段修的都是"能不能用"：会丢消息、会重复发、单机、查不到历史、删不掉数据。
这些修完还剩一个问题——**改坏了怎么知道**。

真实事故长这样：有位同事觉得 `subscription-fee-9-9-19-9` 的 `errorSignatures` 太啰嗦，
删了两条。检索指标从 recall@1 100% 掉到 92%，没人看；一周后有客户问"为什么每月扣
19.9"，客服 agent 答"这个我不太确定"，人工兜底三次才发现。

现有工具回答不了这个问题：

| 工具 | 它能说什么 | 它不能说什么 |
| --- | --- | --- |
| `scripts/eval-rag.mjs` | `recall@1 92%` | 哪两条掉了、掉的这两条以前是什么 |
| `eval-rag.mjs --strict` | 不满 100% 就红 | 库有 200 条、其中 3 条本来就难，永远红，于是被注释掉 |
| `scripts/eval-cs.mjs` | 12 条回复全文 + 泄漏检查 | 要真实模型，进不了 CI；也没有"和上次比" |

所以这一阶段不是加功能，是**加一个会说清哪里变差了的闸门**。

## 交付物

| 文件 | 内容 |
| --- | --- |
| `scripts/eval-gate.mjs`（新） | 两种模式：检索（默认）与 `--replies` |
| `eval/rag-baseline.json`（新） | 26 条用例的逐条基线：top 命中、verdict、分数、指标、kb 指纹 |
| `scripts/reply-leaks.mjs`（新） | 6 条泄漏规则，`eval-cs.mjs` 与门禁共用一份 |
| `scripts/eval-cs.mjs` | 删掉内联的 LEAKS，改成 import；行为不变 |
| `scripts/eval-gate-smoke.mjs`（新） | 27 条断言，验证门禁"该挂时真挂"；自带迷你知识库，不依赖部署的 `kb/` |
| `scripts/verify-all.sh` | 新增 `== retrieval gate` 与 `== gate self-test`（现 42 步） |

## 检索门禁怎么判

跑一遍 `eval/rag-cases.json`（26 条，离线 hash 向量，0.3 秒），和基线逐条比：

1. **用例本身先校验**。`expect` 写的是知识条目 id。条目改名/停用后那些用例会永远不命中，
   而门禁会显示"和基线一致"——因为它比的是基线，不是事实。所以每条 `expect` 必须
   `store.get(id, 'ops')` 真能查到；查不到直接退出码 2，不给比。
   同理：id 重复、缺 query、tier 不在 `direct|reference|miss` 里，都退 2。

2. **逐条比回退**。基线 `hit1: true` 而当前 `hit1: false` → 失败，并且报出
   `used to hit "X" and now returns "Y"`。verdict 从 direct 变成 reference 也算回退
   （客户看到的置信度会变）。

3. **整体指标不得低于基线**（`--tolerance` 可放宽）。这条是兜底：上面逐条比不该漏，
   但如果以后有人加了聚合指标，这里拦住。

4. **基线也得对得上环境**。向量后端从 hash 换成 openai，指标本来就会变，跟代码好坏
   无关 → 退出码 1 并提示 `rebuild the baseline with --update`，而不是让你去查代码。

5. **知识库变更单独提示**。基线记了 `kb` 指纹（对**文件正文**取哈希，不是只对 id+updated
   取——改了签名忘了改 `updated` 恰恰是最常见的情况）。指纹变了打印 NOTE：
   这次的退步可能来自条目而不是代码。这条是给人看的线索，不是失败条件。

6. **用例被删也算回退**。基线里有、当前用例文件里没有 → 失败。否则"把难用例删了"
   就是最省事的通过方式。

退出码：`0` 一致 / `1` 有回退 / `2` 数据不全（没基线、用例坏）。

## 回复门禁（`--replies`）

回复要真实模型，进不了 CI，所以它比的是**人能判定、机器也能判定**的三件事：

| 判据 | 为什么可判定 |
| --- | --- |
| 以前答出来的，现在空了吗 | `answered` 是布尔 |
| 以前没兜底，现在兜底了吗 | 兜底回复是一段固定文案（`没处理成功`） |
| 以前没泄漏，现在泄漏了吗 | 6 条正则 |

措辞变了不管——"目前平台不支持退款"改成"暂时不支持退款呢"是通过，不是回退。
判据的单一真源是 `scripts/reply-leaks.mjs`：`eval-cs.mjs` 打分用它，门禁判回退也用它。
两份各写一遍的后果很具体：往一处加了规则，另一处继续放行，门禁显示 PASS 而回复里
已经在说"插件"。

用法：

```bash
node scripts/eval-cs.mjs              # 跑 12 条真实回复，写 eval/last-run.json
node scripts/eval-gate.mjs --replies  # 和 eval/baseline.json（人工审过的版本）比
```

## 门禁自己也要测

`scripts/eval-gate-smoke.mjs` 造临时数据，逐条验证门禁在**该挂的时候真的挂**，
并且退出码是 0/1/2 里正确的那个。27 条断言覆盖：记录基线、无变更通过、
改坏一份知识库副本后必须失败且点名用例、`expect` 指向不存在的条目退 2、
重复用例 id 退 2、缺基线退 2 且提示 `--update`、换向量后端退 1、
删用例退 1、`--json` 输出可解析、改措辞通过、新兜底退 1、新泄漏退 1、
回复变空退 1、用例缺失退 1、run 文件缺失退 2。

为什么值得写：门禁挂了比没有门禁更危险——它显示 PASS，你于是放心合并。

## 关键决策

1. **逐条比而不是只比百分比**。100% → 92% 说不了任何可执行的事；"sig-19-9-auto 以前
   命中的条目，现在返回 null"直接指到那条知识条目。
2. **基线进 git**。`eval/rag-baseline.json` 是代码的一部分：改检索逻辑或改知识库都在
   同一个 PR 里看到基线怎么变。`--update` 只能人手动跑，不进 verify-all。
3. **默认 hash 向量**。评测必须确定性、离线、0.3 秒；用真实 embedding 服务意味着
   评测结果随服务版本漂移，门禁变成"网络好不好"的测试。
4. **知识库指纹取正文哈希**。只取 `id:updated` 会漏掉"改了签名忘了改 updated"，
   那恰好是最能伤检索的改动。
5. **用例坏了直接退 2，不给比**。一个引用了不存在条目 id 的用例会让门禁永久静默失效，
   这比红更糟。
6. **泄漏规则抽成单独模块**，两处引用同一份。这是本项目反复出现的一类账：
   工具 schema、端点字段、面板标记都因为"两处各写一遍"而漂移过（P2 的
   `groupId` 从 `null` 变成 `undefined`、P11 的 `assistant/message` 事件形状）。
7. **回复门禁只判可判定项**，不判"答得好不好"。后者需要一个会判分的人，写成正则只会
   让人学会绕过正则。

## 验收

```bash
node scripts/eval-gate.mjs              # recall@1 100%，PASS retrieval quality matches the baseline
node scripts/eval-gate.mjs --replies    # 12/12 answered，PASS replies match the reviewed baseline
node scripts/eval-gate-smoke.mjs        # 27/27 checks passed
bash scripts/verify-all.sh              # 42 步全绿（新增两步）
DSH_DB=1 bash scripts/verify-all.sh     # 同上，连库模式
```

故意改坏再跑，确认它会红：

```bash
cp -R kb /tmp/kb-broken
# 手动清空 subscription-fee-9-9-19-9.json 的 errorSignatures
node scripts/eval-gate.mjs --kb /tmp/kb-broken
# FAIL case sig-19-9-auto used to hit "subscription-fee-9-9-19-9" and now returns nothing
# NOTE knowledge base changed since the baseline
# 退出码 1
```

## 已知限制

- **回复门禁不自动跑**。它要真实模型和真实知识库，只能人跑完 `eval-cs.mjs` 再门禁。
  verify-all 里只有检索门禁。
- **基线要人维护**。改了知识库、确认新结果是对的之后，必须 `--update` 重记，
  否则门禁会拿旧事实判新代码。这是这个工具唯一的运维成本。
- **`--replies` 比的是"有没有"，不是"好不好"**。回复变蠢但没兜底、没泄漏，它放行。
  质量判断仍然靠人看 `eval/last-run.json`。
- **评测集只有 26 条**。门禁能守住"别变差"，守不住"覆盖够不够"；扩用例是另一件事。

## 回滚

```bash
git revert <this commit>
```

删掉 `eval/rag-baseline.json` 与两个新脚本即可，不涉及运行时、数据库、配置。
`eval-cs.mjs` 只是把内联常量换成 import，回滚后仍在。

## 下一步候选

- 发布管理：prompt / 知识库版本化 + 灰度（门禁是它的前置——没有门禁就没法安全灰度）。
- `usage_daily` 加单价，把 token 换成钱。
- 面板加登录态（现在不要暴露公网）。
- 数据保留自动跑（现在只有端点和面板按钮，没有定时器）。
