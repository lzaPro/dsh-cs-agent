# 知识库检索设计：四段结构、双路召回、三级判定

这份文档记录客服 agent 的检索层（`kb-core/`）为什么这样拆，以及每条规则的由来。用例和指标在 `eval/rag-cases.json` 与 `scripts/eval-rag.mjs`，改了权重先跑评测再改文档。

## 一、为什么不是「一条故障 = 一段文本」

客服对话里，客户提供的是**现象**，答案在**处置**里，而把两者扣在一起的往往是**错误特征**（报错码、日志关键字）。如果整条记录当一个文档检索，长文本会稀释关键词，短字段（比如 `-122`）几乎不起作用。

所以一条条目被拆成若干块，每块单独建索引、单独给权重：

| 块 | 来源字段 | 权重 | 理由 |
|---|---|---|---|
| `signature` | `errorSignatures` | 1.5 | 客户原样报错码是最强证据 |
| `title` | `title` | 1.3 | 人写的标题天然是浓缩摘要 |
| `symptom` | `symptom` | 1.2 | 客户描述的正是这一段 |
| `customerReply` | `customerReply` | 1.1 | 对外话术，命中说明问的是同一件事 |
| `resolution` | `resolution` | 1.0 | 处置步骤 |
| `verification` | `verification` | 0.7 | 验证条件通常是内部术语，容易误伤 |
| `meta` | `services` + `tags` | 0.6 | 只用来做范围收窄 |

命中块类型会随结果返回（`hit.chunk`），排查「为什么答成这个」时先看它。

## 二、双路召回与融合

- **词法**：BM25（`k1=1.2, b=0.75`）。只遍历倒排表命中的块，不扫全库，条目数量增长时成本是 O(命中词数 × posting 长度)。
- **向量**：默认 `backend: hash`，即特征哈希——词 token 和字符三元组各自双哈希定位到 512 维、按符号累加、L2 归一。它没有语义能力，但能兜住「同一个词的不同大小写/全半角/标点差异」，且零依赖、离线可用、结果确定（相同输入永远同一向量，评测可复现）。
  需要真语义时把 `embedding.backend` 改成 `http` 指向任意 OpenAI 兼容 `/embeddings`，向量按 `sha256(text)` 缓存到 `<indexDir>/vectors.json`，失败时按 `onError: fallback` 退回哈希向量并打 warning，**不让检索因为外部服务挂掉而不可用**。
- **融合**：RRF（`k=60`）。两路分数尺度不同（BM25 无上界、余弦在 [-1,1]），直接加权相加需要归一化，而 RRF 只用名次，免调参。每个条目在每个通道只保留最好名次，避免一条条目用多块刷名次。

## 三、打分与三级判定

```
score = (0.46·relevance + 0.32·signature + 0.22·coverage + 0.06·prior + 0.20·signatureTokens) · statusFactor
```

`signatureTokens` 是「查询词落在错误特征段的比例」。它的存在理由很具体：

> 「查看我的磁盘占用」曾经被 `pvc-disk-full` 抢走，因为该条目 `verification` 里写着「磁盘占用回落」，两个词都在。而 `disk-cpu-usage-check` 的 `errorSignatures` 里就有「磁盘使用」。同样是命中，一个在验证段、一个在错误特征段，证据强度完全不同。加上这个信号后前者 0.55、后者 0.64，排序纠正。

`statusFactor` 让 `verified` 优先于 `stale`，其它状态（`candidate`、`deprecated`）在进入打分前就被 `isSearchable` 过滤掉了。

三级判定：

| verdict | 条件 | 后果 |
|---|---|---|
| `direct` | `score ≥ 0.56` 且 `margin ≥ 0.08` 且（签名命中 或 `coverage ≥ 0.30`） | 允许直接给方案 |
| `reference` | `score ≥ 0.30` | 只能当线索，先追问 |
| `miss` | 其余，或证据闸门未通过 | 必须追问，禁止生成 |

两个闸门都是回归出来的：

1. **证据闸门**（`lexicalFloor 0.15` / `semanticFloor 0.45`）：只被向量通道召回的条目，如果语义相似度不够高就丢掉。没这条时「打印机连不上」会因为哈希向量的一点重合被判成 `gateway-token-changed`。
2. **覆盖闸门**（`directCoverage 0.30`）：`direct` 要求覆盖三成以上查询词。「服务有点慢」只共用了「服务」一个词，覆盖 25%，以前会被直接答成 `container-scale-zero`（副本为 0），现在降为 `reference`，模型改为追问「是完全打不开，还是只是慢」。

## 四、未命中必须追问

`store.search()` 在 `verdict: miss` 时同时返回 `clarify`，由 `missingDetail(query)` 依据缺什么生成最多三条追问（缺错误原文 / 缺环境 / 缺时间范围 / 缺影响范围）。工具描述里明确写了：`miss` 时不得给方案，只能问 `clarify` 里的问题。

这样做的产品理由是**错误答案的代价高于多问一句**：客户按错误方案操作会扩大故障面，而多问一句只是慢一点。

## 五、闭环：候选、去重、失效

```
提问 ──► kb_search ──► 命中？──► 是 ──► direct / reference
                        │
                        └─ 否 ──► clarify 追问 ──► 问题解决后 kb_propose
                                                        │
                                     ┌──────────────────┴───────────────┐
                            签名与现有条目 Jaccard≥0.5            新签名
                                     │                                 │
                            不新建，occurrence +1            kb/_candidates/*.json
                                                                       │
                                          scripts/kb-review.mjs verify / reject
                                                                       │
                                                    kb/ 或 ops-kb/（status: verified）
```

- **去重**：签名集合 Jaccard ≥ 0.5 视为同一条，只累加计数。这实现「同签名条目累计出现次数并前置排序」，也避免十条「-122」互相竞争。计数进入 `prior` 项，最高 10 次封顶，防止老条目永久霸榜。
- **失效**：`kb-review.mjs expire <id> --reason … [--superseded-by …]` 把 `status` 改为 `deprecated`，文件保留（可审计），检索时被 `isSearchable` 排除。
- **审核**：候选**不进检索**。一个 agent 的猜测不能变成另一个 agent 的「事实」。

## 六、评测

`eval/rag-cases.json` 26 条：`sig-*` 带原样错误码、`para-*` 是同一故障的口语说法、`miss-*` 是知识库里确实没有的问题。指标含义：

- `recall@1 / recall@3`：正确条目是否第一 / 前三；
- `miss-precision`：该判未命中的是否真的判了未命中（这条防的是「什么都能答」）；
- `tier-agreement`：`verdict` 与人工标注是否一致。

当前：`100% / 100% / 100% / 100%`。这个数字要打折看——用例是我按现有 15 条知识库写的，不等于线上分布。真实价值在于**它是回归网**：改权重、加分块、换向量后端，跑一遍就知道有没有把原本对的弄坏。

```bash
node scripts/eval-rag.mjs --strict   # CI 用：任一指标不到 100% 就失败
cd kb-core && node rag-smoke.mjs     # 27 项单测，覆盖分块/BM25/RRF/向量单路/签名/闸门/台账
```

## 七、已知局限

1. **哈希向量没有语义**。同义改写靠 BM25 的词重合 + 签名，不靠「理解」。这是刻意的取舍：默认零依赖、离线可跑、结果确定。要语义就把 `embedding.backend` 换成 `http`，评测脚本支持 `--embedding http` 对比。
2. **分块是字段级，不是段落级**。长 `resolution` 当成一块，没有按步骤再切；步骤很多的条目（比如 PVC 清理五步）内部区分度不够。
3. **评测集偏小且自建**。26 条不足以证明线上 20% 人工接入率这类结论，只能证明「这些情况没退化」。
4. **重复检测只看签名**。两条条目讲同一件事但签名写法不同（`-122` vs `Unknown system error -122`）会被当成两条；签名里写全别名是使用者的责任，`_template.json` 有提示。
