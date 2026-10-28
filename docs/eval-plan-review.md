# 评测落地方案评审

> **评审对象**：针对本仓库的 7 模块评测落地方案（知识库检索、Ragas、意图与路由、运维转交、网关可靠性、知识库治理、评测体系与门禁）。
> **本文范围**：评估方案 + 回答方案里提出的问题。**能回答的直接回答；需要新增测试方案的，只给设计选项，等你拍板**（见第 10 节）。
> **口径**：所有事实以当前代码为准，行号指向工作区根目录。

图例：

| 标记 | 含义 |
| --- | --- |
| ✅ | 已在代码里实现，且有测试覆盖 |
| 🟡 | 部分实现，或实现有但测试没跟上 |
| ⬜ | 方案建议、当前**未实现** |
| ⏳ | 需要你确认的技术方案 |

---

## 1. 总体判断

### 1.1 结论

方案的方法论是对的：按模块拆、每个模块配"怎么验证"、把"已实现"和"计划增加"分开，这三件事本身就是面试里最容易被追问的部分。**不需要换向量库，也不需要改成 Agentic RAG**——这个判断我同意，理由在第 2 节 Q5 展开。

但有 **5 处事实需要修正**，**1 处顺序需要调整**，其中第一处是概念性的，会直接影响整套用例能不能自动判分。

### 1.2 需要修正的事实

| 方案里的说法 | 代码里的实际情况 | 为什么重要 |
| --- | --- | --- |
| 调参表列了 8 项 | `DEFAULT_TUNING` 实际 **11 项**（`kb-core/hybrid.js:27`）。方案漏了 `occurrences 0.06`、`semanticFloor 0.45`、`lexicalFloor 0.15` | 被追问"还有别的阈值吗"会答不上。漏掉的两个正是**噪声闸门**：`semanticFloor` 拦"只有向量、余弦太低"的假召回，`lexicalFloor` 拦"词面覆盖太低、必须靠签名兜底"的假召回 |
| `direct` = 分数 ≥ 0.56 且 margin ≥ 0.08 | 判定还要求第三条件 `(top.signatures \|\| covered)`，并且有一条**容差后门**：`if (top.signatures && top.score >= tuning.direct - 0.12) verdict = 'direct'`（`hybrid.js:294`） | 有完整签名命中时，**0.44 分也能判 direct**。这恰好回答"为什么签名这么值钱"，同时也是误判风险点（第 4 节 Unsafe Answer 的来源之一） |
| "意图识别"是一个可评测对象 | 系统里**没有意图产物**：`cs-agent/cordis.patch.yml` 里是一段 6 步流程 prompt + 三个工具，决策发生在模型侧 | 用例需要"输入 → 期望观测 → 可判分"。意图不可观测，除非再跑一个 judge 模型打标（成本高、有二次误差）。**可观测且可确定性断言的是 `tool/call` 事件**（见 4.2） |
| 7 个意图标签都能用 | `account_query`（余额/账单/订阅状态）和 `security_incident`（盗号/泄漏）在你系统里**没有对应能力**：客服没有后台查询工具，也没有安全升级通道 | 这两类只能评"是否被错误地当普通问答处理"（漏检），评不了"正确处理率"。照抄方案的标签会得到一批**永远不可能对**的用例，把 Accuracy 压低却说明不了系统好坏 |
| 建议新增 `eval/intent-cases.json`、`eval/ragas-dataset.jsonl`、`eval/reports/` | **尚未创建**。现有 `eval/` 只有：`cases.json`（12 条回复用例）、`baseline.json`（12 行人工评基线）、`last-run.json`、`rag-cases.json`（26 条检索用例）、`rag-baseline.json` | 文档里必须标"未创建"，否则面试演示时按路径找不到文件，比不做还伤 |

### 1.3 需要调整的顺序

方案建议"**先补意图与动作评测集，再接 Ragas**"。前半同意，但把"意图"换成**动作轨迹（action trace）**：

```
动作轨迹 harness  →  确定性引用一致性  →  Ragas 语言层  →  门禁
（能进 CI，天级）    （能进 CI，天级）     （周级报表）     （不可退化）
```

理由：前两步都是确定性的、能进 `scripts/verify-all.sh`；Ragas 需要 judge 模型，只能做离线报表，做不了每次提交的门禁。方案里也写了"Ragas 不必参与每次在线请求"，但还要再进一步——**它也不该参与每次提交**。

---

## 2. 模块 1：知识库与混合检索

### Q1：为什么用结构化故障条目，而不是 PDF + 定长 Chunk？

因为这里要解决的问题不是"找到相关段落"，而是三个更难的问题：

1. **能不能直接对客户说**——`customerReply` 是人工写好的、可直接复述的原话，不是模型从段落里现编。
2. **什么时候不该说**——`audience`（`customer` / `ops` / `internal`）+ `status` 决定权限与可信度；客服角色读到 `audience !== 'customer'` 的条目时，内部诊断字段被剥掉（`kb-core/index.js:193` 的 `hidden = role === 'customer-service' && entry.audience !== 'customer'`）。
3. **这次算不算真解决**——`verification` 是单独的字段，是"可验证"这个要求的落点。

定长 chunk 会把这几类语义混在同一段文本里：检索命中"处置段落"和命中"客户话术"无法区分。你的实现是**按字段切块并给不同权重**：

```js
// kb-core/chunks.js:17
export const CHUNK_FIELDS = {
  signature:     { field: 'errorSignatures', weight: 1.5 },   // 人工写的错误码集合，最可靠
  title:         { field: 'title',           weight: 1.3 },
  symptom:       { field: 'symptom',         weight: 1.2 },   // 客户描述通常命中这里
  customerReply: { field: 'customerReply',   weight: 1.1 },   // 可直接对客说的原话
  resolution:    { field: 'resolution',      weight: 1  },     // 运维问题命中这里
  verification:  { field: 'verification',    weight: 0.7 },
  meta:          { field: 'services',        weight: 0.6 },   // services + tags 合成一块
}
```

**要主动说的代价**：这种结构对录入质量要求高（条目人工写、字段填全），不适合"把一堆 PDF 丢进来就能用"。这不是缺陷，是取舍——客服回答的合规成本远高于录入成本。

> 一个细节值得主动讲：`meta` 块故意把 `services` 和 `tags` 合成一块（`chunks.js` 注释写得很清楚），否则单独一个 "grafana" 就能压过真实症状匹配。

### Q2：为什么 BM25 + 向量双路？

两路的失效模式不同：

| 查询 | 只用 BM25 | 只用向量 |
| --- | --- | --- |
| `提示-122错误` vs 条目写 `no space left on device` | 断（词面不重合） | 也不稳（数字/符号差异） |
| `9.9` vs `19.9` | 准（数字是 token） | 危险（向量认为很像） |
| `对话发消息一直转圈` vs `dialog-no-response` | 断 | 可能救回来 |
| 客户打错字 `磁盤` | 断 | 字符 trigram 可能救回来 |

所以：**BM25 负责高精度词面信号（错误码、服务名、报错原文），向量负责词面不重合的召回**，`signature` 字段是第三条路——人工维护的错误码集合精确匹配（`signature 1.5` 权重最高，且有容差后门）。

### Q3：为什么用 RRF（而不是加权求和）？

BM25 分数是 unbounded 的 tf-idf 加权和，cosine 在 `[-1, 1]`。直接加权需要先归一化，而归一化参数**换语料就得重调**。RRF 只用排名：

```js
// kb-core/hybrid.js:24
export const RRF_K = 60
// 融合分数 = Σ 1 / (RRF_K + rank_i)
```

好处：对分数尺度免疫、对单路偶发的极端值不敏感。代价：**丢掉了"差多少"的信息**——所以融合之后还有一层基于信号的规则重排（`signature` / `coverage` / `signatureTokens` / `occurrences`）把"差多少"补回来。这两段要连着讲，只讲 RRF 会被追问"那分数大小不就浪费了"。

### Q4：向量模型是什么？

**默认不是语义模型**，这点必须主动说清楚：

- `backend: 'hash'`（默认）：`HASH_DIMS = 512`，word token + 3 字符 trigram，FNV-1a 双 seed 哈希到 512 维，再 L2 归一化（`kb-core/embed.js`）。它解决的是**拼写变体、同词根、字符重合**，不是 `扣费 ↔ billing` 这种跨语言语义。
- `backend: 'http'`：任意 OpenAI 兼容 `/embeddings`，指向 BGE / M3E / text-embedding 服务；**按内容 hash 做磁盘向量缓存**，重启不重算。
- `backend: 'off'`：退化成纯 BM25，所有调用方仍能工作。

**为什么这么设计**：零依赖、零网络、零 GPU，装完就能跑，且**确定性**——评测基线才有意义（同一份代码跑两次结果必须一样，否则 `eval-gate` 没法逐条比）。

**边界要自己先讲**：hash 后端下"同义不同词"的召回靠 BM25 分词和人工 signature 兜着，不靠向量。这正是评测里必须单列"同义表达"一类用例的原因。

### Q5：为什么不用 Qdrant / Milvus / 甚至 pgvector？

规模算一下就知道：16 条条目 × 最多 7 类 chunk ≈ 100 个 chunk，暴力 cosine 在微秒级。向量库解决的是"百万级向量 + 高并发 + 增量更新"，这里**一个都不成立**。

更关键的是成本不在检索，在运维：多一个服务就要备份、升版本、监控、写故障预案。项目已经引入了 Postgres（`DSH_DB=1`，可选），再挂一个专用向量库是纯负债。

**演进路径要能讲**：`search()` 的对外契约是 `{hits, verdict, confidence, margin}`，融合与判定都在 `hybrid.js`，与后端解耦。真要换——"chunk 向量写进 Postgres 用 pgvector，只换检索函数实现，融合和三级判定不动"。这就是为什么现在不上，而不是"不会上"。

### Q6：没有 chunk size / overlap 参数，怎么回答？

不是"没切块"，是**切块单位由数据结构决定，而不是由字符数决定**：一个条目按字段切成最多 7 块。所以 `size` / `overlap` 这两个参数在这里不存在，取而代之的是**字段权重**。

反过来说：如果将来真要接文档型知识（PDF/网页），那时才需要 size/overlap，且应该新增一种 `source: 'document'` 的条目类型，而不是把文档硬塞进现有结构（否则 `audience` / `status` / `verification` 三个治理字段全部失效）。

### 参数全表（面试用，11 项）

| 参数 | 默认值 | 作用 | 调大会怎样 |
| --- | --- | --- | --- |
| `relevance` | 0.46 | 融合排名在最终分里的权重 | 更依赖排名，忽略信号 |
| `signature` | 0.32 | 完整签名命中的权重 | 错误码匹配更容易压过一切 |
| `coverage` | 0.22 | 查询词覆盖率的权重 | 长查询占优，短查询吃亏 |
| `occurrences` | 0.06 | "这条反复出现"的先验 | 老条目更容易被选中 |
| `signatureTokens` | 0.20 | 签名段落内的部分词匹配 | 部分匹配也算证据 |
| `direct` | 0.56 | 可直接回答的分数门槛 | 更保守，更多 reference |
| `reference` | 0.3 | 可作参考的门槛 | 更容易从 miss 变成 reference |
| `margin` | 0.08 | 第一名要领先第二名的最小差距 | 更保守，歧义时降级 |
| `directCoverage` | 0.3 | direct 所需的最低查询覆盖率 | 更保守，短查询难 direct |
| `semanticFloor` | 0.45 | 纯向量召回的余弦下限（低于视为噪声） | 更容易接受弱向量召回 |
| `lexicalFloor` | 0.15 | 低于此覆盖率的词面召回必须有签名才成立 | 更容易接受弱词面召回 |

判定逻辑（`kb-core/hybrid.js:280-303`，可背）：

```text
margin  = 只有一个命中 ? 1 : top.score - second.score
verdict = 'miss'
if (top.score >= reference) verdict = 'reference'
covered = top.coverage >= directCoverage
if (top.score >= direct && margin >= margin && (top.signatures || covered)) verdict = 'direct'
if (top.signatures && top.score >= direct - 0.12) verdict = 'direct'   // 签名容差后门
```

> **面试加分点**：主动说"这些是加权打分规则，不是概率校准"。0.56 不代表"56% 概率正确"，它只表示"在这套权重下强到可以直说"。

### 测试集 7 类：现状映射

| 方案里的类别 | 现状 | 说明 |
| --- | --- | --- |
| 精确错误码 | ✅ | `eval/rag-cases.json` 里 `sig-*` 用例即此类（如 `sig-9-9`、`sig-dialog`） |
| 同义表达 | ✅ | `rag-cases.json` 的 `expect` 指向同一条目但查询措辞不同 |
| 关键词冲突 | 🟡 | 有 `margin` 机制，但用例里没有专门构造"两条条目共用同一个词"的样本 |
| 无关问题 | ✅ | `expect: null` + `tier: 'miss'` 的负样本，`eval-rag.mjs` 统计 miss-precision |
| 低证据问题 | 🟡 | 靠 `reference` + `clarify` 机制，但"服务有点慢"这种没有专门用例 |
| 内部知识 | ✅ | `audience` 三档 + `get()` 里的字段剥离，`kb-core/smoke.mjs` 与 install-e2e 都验过 |
| 过期知识 | 🟡 | `isSearchable` 已排除 `candidate` / `deprecated` / `retired` / 有 `supersededBy`（`kb-core/kb.js:146`），但**当前 16 条条目里 0 条是 deprecated**，这条路径没有真实数据跑过 |

> **待你确认的一个语义问题**：`isSearchable` 允许 `unverified` 条目被检索（只有 `candidate` / `deprecated` / `retired` 被排除）。当前 16 条里有 1 条是 `unverified`。这是有意的（"没见过但也不能当没有"）还是漏了？如果是有意的，条目 `status` 只影响 Prompt 里的可信度判断（预设第 3 步要求"status 不是 verified 就说这只是参考方案"），这一点值得在文档里写清。

---

## 3. 模块 2：Ragas 评测体系

### 3.1 对方案的评价

| 方案主张 | 我的判断 |
| --- | --- |
| Ragas 只做离线评测，不进在线链路 | ✅ 完全同意，且要更进一步：**也不该进每次提交的门禁**（judge 模型有成本、有波动） |
| Ragas 不能取代现有确定性门禁 | ✅ 同意。`eval-gate.mjs` 逐条比"哪条从命中变不命中"，这是 Ragas 给不了的定位能力 |
| 100~300 条人工审核样本起步 | ✅ 同意，但建议**从现有 26 条 rag-cases 起步扩到 50~80 条**，先把流程跑通再扩量；一次做 300 条大概率做不完，且没有基线可比 |
| 四层指标（Context Precision/Recall、Faithfulness、Answer Relevancy/Correctness） | 🟡 需要在你的系统上做两处改造，见 3.2 |

### 3.2 两处必须改造的地方

**改造一：Faithfulness 有一半可以确定性化。**

你的客户回复主要由 `customerReply` 字段拼装，不是自由生成。所以"回复里的错误码、数值、步骤是否来自命中条目"是**字符串可判定的**：

```text
确定性引用一致性（可进 CI）：
  1. 回复里出现的错误码 ∈ 命中条目的 errorSignatures ∪ resolution 中出现的错误码？
  2. 回复里出现的金额/数值 ∈ customerReply？
  3. 回复里是否出现命中条目中没有、且不属于通用话术的具体操作指令？（如"删除容器文件"）
```

只有"语气是否回答了问题""表述是否与证据矛盾"这部分需要 judge。**先做确定性那半，Ragas 只补语言层**，这样门禁仍然 100% 确定性。

**改造二：Context Recall 的标注粒度应该是 chunk id，不是 doc id。**

方案给的标注字段是 `relevant_doc_ids`。但你的检索单位是 **chunk**（`entryId#type`，见 `chunks.js:47`），命中 `symptom` 块和命中 `resolution` 块对客户问题来说是不同证据。所以标注应该是：

```json
"relevant_chunk_ids": ["dialog-no-response#symptom", "dialog-no-response#customerReply"]
```

这样能回答 Ragas 原本回答不了的问题：**"检索到了正确的条目，但命中的是错的那一段"**——这正是你 `CHUNK_FIELDS` 设计要解决的问题，也是最容易被面试官抓到的地方。

### 3.3 接口设计（⬜ 未实现）

```text
Node 客服系统                    Python 评测                     输出
─────────────                    ──────────                     ─────
eval/ragas-dataset.jsonl   ──▶   ragas_runner.py           ──▶  eval/reports/ragas.json
（由导出脚本生成，不进主链路）    （固定版本、单独 venv）           （趋势报表，人工看）
```

每行样本字段：

| 字段 | 来源 | 说明 |
| --- | --- | --- |
| `id` | 用例 id | 与 `eval/cases.json` 对齐，便于交叉引用 |
| `question` | 用例文本 | 客户原话 |
| `contexts` | `kb_search` 返回的 `hits[].snippet` + `kb_get` 的条目字段 | **必须是真实检索结果**，不能拿知识库全文冒充（方案里也强调了） |
| `response` | 网关回推给适配器的文本（`outbox` / `data/outbox.jsonl`） | 真实回复 |
| `ground_truth` | 人工审核 | 必须人工写，不能模型生成 |
| `relevant_chunk_ids` | 人工标注 | 见改造二 |
| `verdict` | `kb_search` 返回 | 用于分层统计（direct / reference / miss 的表现应当不同） |
| `trace_id` | 网关 traceId | 出问题时能回到原始链路 |

### 3.4 三条硬约束（写进方案里，别踩）

1. **Ragas 数据必须来自真实运行**：`contexts` 用真实 `kb_search` 结果，`response` 用真实回推文本。否则指标虚高。
2. **ground_truth 不能由模型生成**：那就变成"两个模型互相印证"，不是评测。
3. **锁版本**：Ragas 指标 API 跨版本变过（方案自己也提示了）。建议锁 `ragas==0.1.x` 之类具体版本，并在报告里记版本号，否则两次报表不可比。

### 3.5 需要你决定

见第 10.1 节。

---

## 4. 模块 3：意图识别与客服路由（改造最大的一节）

### 4.1 现状：决策在哪里

`cs-agent/cordis.patch.yml` 的 persona prefix 就是决策逻辑，6 步：

```text
1. 提取信息（报错原文/错误码、服务、环境、时间、影响范围）
2. kb_search（可以查两次：先错误特征，再服务名+现象）
3. 判断命中：核对 services / environments 是否匹配，看 status 与 audience
     - audience=customer 且 status=verified → 按 customerReply 回答
     - audience=ops → 说明已知问题、需要技术介入，收集账号标识/时间/原文
     - status 不是 verified 或环境不匹配 → 只说"参考方案，需验证"
     - 分数很低 → 当未命中，不要硬套
4. 未命中 → 明确说是新问题，继续收集（变更/范围/可复现），不编方案
5. 需要查集群/后台/账号 → ops_handoff（先收集齐账号、原文、时间）
6. 客户确认解决 → kb_propose 沉淀候选条目
```

工具只有四个：`kb_search`（`kb-core/tools.js:59`）、`kb_get`（`:200`）、`kb_propose`（`:249`）、`ops_handoff`（`cs-agent/handoff.js`）。**没有意图分类器，也没有服务端路由表**——决策在模型侧，约束在工具侧（权限、作用域、输出 schema、`additionalProperties: false`）。

所以方案里"意图处理目前以预设流程和工具调用为主"这句**判断准确**，可以照讲。

### 4.2 为什么"意图"不能直接当评测对象

一个用例要能自动判分，必须有 `(输入 → 可观测的输出 → 期望)`。意图在你这套系统里**不产生任何可观测输出**。两条路：

| 做法 | 代价 |
| --- | --- |
| 再跑一个 judge 模型给回复打意图标签 | 第二个模型的误差 + 成本 + 不可进 CI；且"分类错了但处理对了"会被误判成失败 |
| **记录模型实际调了什么工具、参数是什么** | 零额外模型调用，`tool/call` 事件里本来就有，确定性可断言 |

DSH 的 session 事件里明确有这两个事件（`packages/core/session/lib/types/types.d.ts:355` 与 `:375`）：

```ts
'tool/call':   { turn, step, callId, name, arguments /* 原始 JSON 字符串 */ }
'tool/result': { turn, step, message, error?, meta? }
```

**所以评测对象定义成「动作轨迹 + 终态」**：

```text
轨迹   = [tool/call 序列]（name + arguments 解析后的关键字段）
终态   = 会话 mode（ai / human）、inbox/outbox 最终状态、回复文本
可判分 = 序列是否匹配期望、参数是否合规、是否出现禁止动作
```

这样"该追问却硬答"、"该交接却自己编"、"没查库就回答"这类错误全部变成**确定性断言**，不需要 judge。

### 4.3 建议的标签集：按"能力是否存在"分两档

方案的 7 个标签问题在于混了两类东西：**能做的**和**做不到但必须承认做不到的**。建议改成：

**A. 可自助（可以评"处理对没对"）**

| 标签 | 期望动作轨迹 | 禁止动作 |
| --- | --- | --- |
| `knowledge_qa` | `kb_search` → （必要时 `kb_get`）→ 基于命中条目作答 | 不检索直接答 |
| `technical_issue_known` | `kb_search` 命中 `verified` + `audience=customer` → 直接用 `customerReply` | 命中后仍说"我转技术查一下" |
| `technical_issue_needs_ops` | 收集账号/时间/原文 → `ops_handoff`（`symptom` 必填） | 描述内部操作步骤、承诺"我去查" |
| `no_info_clarify` | `kb_search` 得到 `miss` → 按 `clarify` 追问 | 给具体解决方案、调 `ops_handoff`（信息不足时交接是浪费） |
| `human_request` | 切人工接管（`mode=human`），AI 停止自动对客 | 继续自动回复、反复要求用户自助排查 |

**B. 不可自助（只能评"是否被识别为不能自助"）**

| 标签 | 期望 | 当前能力 | 结论 |
| --- | --- | --- | --- |
| `account_query`（余额/账单/订阅状态） | 不假装能查；追问账号标识或 `ops_handoff` | 无后台查询工具 | 可评"是否说了我查一下"（禁止项），**评不了"查对金额"** |
| `security_incident`（盗号/泄漏/越权） | 立即升级人工 + 提醒改密 + 不展开内部细节 | **无安全升级通道** | 会稳定 fail。建议先做**观察项**，不做门禁；补通道后再转门禁 |

> 一句话总结给面试官：**评测标签必须与系统能力对齐**。给一个没有后台权限的客服配 `account_query` 用例，能测出的只有"它有没有假装自己能查"，而不是"它查得准不准"。这两件事在工程上是两个不同的指标。

### 4.4 采集方案（⏳ 待你选，见 10.2）

**方案 A（推荐）——旁挂事件记录器**

网关本来就订阅了 `session/event`（`apply()` 里的 `ctx.effect(... 'channel-gateway: observe')`）。再加一个只读观察者，把 `tool/call` / `tool/result` 落成 jsonl：

```text
<dataDir>/traces/<traceId>.jsonl   （只是记录，不参与业务决策）
每行：{ at, traceId, sessionId, turn, step, callId, phase: 'call'|'result',
        name, arguments(解析后), resultOk }
```

优点：完全离线、确定性、能覆盖交接与接管；改动局限在一个新模块 + 一次订阅。
风险：`arguments` 是模型原始 JSON 字符串，解析失败要能容错（记原文 + `parsed:false`）。

**方案 B —— 独立 eval 插件**：与 A 等价，区别只是放在 `cs-agent/` 还是独立包里。如果担心网关变胖，就选 B。

**方案 C（不推荐）——LLM judge 判意图**：见 4.2。

### 4.5 指标定义（比方案多的两项标了 ★）

| 指标 | 定义 | 建议门禁 |
| --- | --- | --- |
| Action Accuracy | 轨迹与期望序列一致的比例（只看工具序列 + 关键参数，不比文本） | 基线不回退 |
| Tool Precision | 调用的工具里"该调"的比例 | 基线不回退 |
| Tool Recall | "该调"的工具里真调了的比例 | 基线不回退 |
| Handoff Recall | 该交接的样本里真交接的比例 | 安全指标，0 容忍 |
| ★ Handoff False-Positive Rate | 不该交接却交接的比例 | 基线不回退（方案只提了 Recall，但误交接会打扰运维，同样是缺陷） |
| Unsafe Answer Rate | `miss` 时给了具体方案 / 对受限能力承诺"我查" / 泄漏内部字段 | 安全指标，0 容忍 |
| Clarification Hit | 追问是否覆盖了 `clarify` 里的关键项 | 基线不回退 |

### 4.6 是否单独做意图分类器（可直接背的答案）

> 当前方案把决策放在预设流程 + 工具契约里，不额外引入一个分类模型，省掉一次模型调用和一套服务。原因是这套系统的失败模式不是"分不清意图"，而是"该查的时候没查、该承认不知道的时候编了方案"——后者用工具契约和确定性门禁就能钉住，前者用分类器也钉不住。
>
> 如果意图数量和路由复杂度继续涨，我会先把评测从端到端回复里拆出来（动作轨迹评测），用混淆矩阵看哪几类经常混。只有在流量大、意图稳定、且混淆矩阵显示规则化成本高于模型成本时，才考虑换成小分类模型。但高风险动作始终由服务端策略校验，**不让分类结果直接获得执行权限**——账号作用域、只读限制、`additionalProperties: false` 这些约束都在工具层。

---

## 5. 模块 4：运维转交与管理员升级

方案给的 7 个问题，逐个回答：

| 问题 | 回答（含代码位置） |
| --- | --- |
| 为什么客服与运维是两个独立 Agent？ | 工具权限隔离。客服的预设里只有 `kb_*` + `ops_handoff` + 文件只读 + OCR；`ops_k8s` / `ops_logs` / `ops_metrics` 只在运维预设里。客服**拿不到**集群凭据，这是结构性保证，不是 Prompt 约束 |
| `ops_handoff` 需要传什么？ | 6 个参数，只有 `symptom` 必填（`cs-agent/handoff.js:57`）：`symptom`、`account`、`errorSignatures`、`evidence`、`successCriteria`、`incidentId`。输出 schema 是 `{incidentId, opsSessionId, state}`，`state='disabled'` 表示运维插件没装（`:68`、`:93`） |
| 运维结果怎么回到客服？ | 派单器把结构化回执作为**新消息**送回发起的客服会话（模型被重新唤醒后向客户转述），不共享上下文 |
| 如何防止跨客户取证？ | 三层：①账号作用域（P18）——`account` 变成服务端强制，`namespaces`/`contexts` 取交集，省略 namespace 直接拒；②PromQL 边界（P21）——不写 `namespace` 匹配器直接拒，`!=`/`!~`/通配一律拒；③全局白名单（`cluster.js` 的 `checkNamespace`） |
| 运维能否直接改生产？ | 当前只读取证。任何变更走提案 + 人工审批，`ops-agent` 没有写工具 |
| 运维返回格式不合法怎么办？ | `dispatcher.js:815`：`RESULT_STATUSES.has(parsed.status) ? parsed.status : 'needs_human'`——解析不出来就降级为需要人工，**绝不当成功** |
| 运维插件未安装？ | `handoff.js:93` 返回 `state: 'disabled'`，客服会明确说"运维协同没开启"，不谎称已处理 |

现有测试入口（都在 `scripts/verify-all.sh` 里）：

```bash
node cs-agent/handoff-smoke.mjs      # 6 条：契约、disabled 分支、回执投递
node ops-agent/smoke.mjs             # 78 条：派单、超时、回执解析、协同开关
node ops-agent/scope-smoke.mjs       # 86 条：作用域 + PromQL + 工具执行链路
```

方案列的 7 个端到端场景，现状：正常派单 ✅、结论回传 ✅、`need_info` 保持进行中 ✅、格式异常升级 ✅、协同关闭 ✅、越权取证 ✅（3 种绕过方式全覆盖）、变更安全 ✅（无写工具，属结构性）。

---

## 6. 模块 5：渠道网关、消息可靠性与人工接管

方案给的 7 个问题：

| 问题 | 回答 |
| --- | --- |
| 为什么入站先入队再返回 202？ | 取消息比处理消息更重要。重构前 `inbound()` 一个函数串完"归一化→去重→限流→下载附件→建会话→落盘→唤醒模型"，任何一步抛错消息就丢，而平台不保证重投。现在先 `inbox.enqueue` 再 `processInbound`，失败留在队列里等重试（P5） |
| 同一消息重投为什么不会两条回复？ | 幂等键**由内容派生**而不是随机 UUID：有 `messageId` 用 `channel:msg:<id>`，否则用内容指纹（`inboxKey()`）。踩过真坑：初版复用了 outbox 的键，而那个键含 `at` 时间戳 → 同一消息每次重投都算出不同键 → 客户收到两条 |
| 出站 Webhook 超时怎么重试？ | 退避 2s → 8s → 32s → 2m，5 次后进 `dead`（`outbox-retry.js`）。失败时 `emit` 仍返回 `{delivered:false, queued, attempts}`，调用方能区分"发送失败但已排队"和"彻底失败" |
| 为什么要死信 + 人工重放？ | 重试用尽不等于该丢——可能是适配器换地址了。`GET /dead` 看、`POST /replay` 推回去、写 `audit_log`（谁推的、什么时候），且**只允许从 dead/failed 重放**，已发送的永不重发（否则客户看到两条一样的回复） |
| 人工接管后怎么阻止 AI 继续回？ | `mode=human` 时走 `agent.inject` 而不是 `agent.followup`——`inject` 不唤醒模型，所以 AI 不会自动对客。另有只读角色与写租约兜底 |
| 怎么用 traceId 追踪？ | 12 位 id 从入站生成，贯穿 inbox → 处理 → 模型调用 → outbox 投递；回复信封带触发它的那条消息的 traceId；日志行有 `[traceId]` 前缀；`/health` 失败时能定位到是哪类故障 |
| 为什么测试会话要和真实客户隔离？ | 三种手段：测试用临时 `DSH_HOME` / 临时 `dataFile`；`channel='eval'` 的会话被保留策略跳过；PG 测试用前缀标记并在收尾按前缀删 |

### 故障注入矩阵：方案 8 项验收标准 vs 现有覆盖

| 验收标准 | 现状 | 覆盖它的测试 |
| --- | --- | --- |
| 同一 `messageId` 重复投递不重复处理/回复 | ✅ | `inbox-smoke.mjs`（重投 `duplicate` 且不二次唤醒） |
| 入站处理超时，消息仍在队列 | ✅ | `inbox-smoke.mjs`（`failTimes:99` 建会话失败仍"已受理"、留队列，恢复后 `drainInbox` 补上） |
| 出站连续失败按退避重试，最终进死信 | ✅ | `outbox-smoke.mjs`（503×2 → dead，退避序列 `100,400,1000,1000`） |
| Webhook 恢复后未完成投递可继续 | ✅ | `outbox-smoke.mjs` + `panel-dom-smoke.mjs`（前 2 次 503 后 200，最终 `sent=1`） |
| 人工接管后 AI 自动回复被抑制 | ✅ | `gateway-smoke.mjs`（human 分支只 `inject` 不 `followup`） |
| 数据库不可用，健康检查准确报告异常 | 🟡 | `health-smoke.mjs` 验了 `database` 字段存在与版本；**"库中途挂掉 → `/health` 503"没有真断库测过** |
| 两个 Worker 同时领取不重复投递 | ✅ | `outbox-pg.js` 用 `for update skip locked`；`lease-smoke.mjs`（第二实例被拒、释放后可接管） |
| 评测运行结束不污染真实客户会话 | 🟡 | 检索/门禁/install-e2e 都走临时目录 ✅；`eval-cs.mjs` 会真的往运行中的网关塞消息（靠 `channel='eval'` 标记让保留策略跳过），**只在部署侧隔离，不是测试侧隔离** |

### 一句可背的总结

> 我不只测模型能不能生成答案，还要测消息从接收到回推整条链路是否可靠。Agent 的正确性等于模型行为 + 消息可靠性 + 工具执行状态 + 人工接管边界，这四件事分别有对应的门禁。

---

## 7. 模块 6：知识库更新、审核、权限与数据隔离

| 方案问题 | 回答 | 状态 |
| --- | --- | --- |
| 新知识怎么进入知识库？ | `问题解决 → kb_propose → 候选条目 → 人工审核（scripts/kb-review.mjs）→ 正式库`。模型只能写候选，不能直接写正式库 | ✅ |
| 如何避免错误经验污染检索？ | `candidate` 不在 `isSearchable` 里（`kb-core/kb.js:146`），所以候选条目根本不参与检索；审核通过才 `status='verified'` | ✅ |
| 重复故障条目怎么处理？ | `kb_propose` 用签名集合做 jaccard 相似度，重复时**吸收而不是新建**、并 `occurrences + 1`（发出重复问题的人越多，这条越可信——这也是 `occurrences` 权重 0.06 的来源） | ✅ |
| 旧知识失效怎么办？ | `status` 置 `deprecated`（带 `deprecatedAt` / `deprecatedReason`）或 `supersededBy`，两者都会被 `isSearchable` 排除 | 🟡 机制在，**当前 16 条里 0 条 deprecated**，没跑过真实路径 |
| 客服和运维怎么共享又隔离？ | `sourcesFor(role)`：客服只读 `kb/`；运维读 `kb/` + `ops-kb/`（`kb-core/index.js:99`）。佣金/内部流程类条目放 `ops-kb/` 或 `audience='internal'` | ✅ |
| 改了知识库怎么确认没退化？ | `eval-gate.mjs --update` 记基线，之后逐条比"哪条从命中变不命中"，并校验 `expect` 引用的条目真实存在 | ✅ |
| 怎么保证新工具的返回字段没破坏 schema？ | `kb-core/tools-schema-smoke.mjs` 拿真实工具定义 + 真实返回值校验；`additionalProperties:false` 让多一个字段就整条结果被拒——历史上真炸过一次（`kb_search` 漏声明 `signals`/`margin`） | ✅ |
| 如果模型提示用户做破坏性操作？ | 预设硬性约束 + `reply-leaks.mjs` 的泄漏正则 + `eval-cs.mjs` 人工看；**这是 Prompt 层约束，不是代码强制** | 🟡 值得补：把"禁止操作"做成回复后置检查 |

> **一条值得主动讲的经验**：检索函数单测通过 ≠ 模型能正确用工具。历史上出过"工具返回字段与声明 schema 不一致导致工具硬错误"，所以测试必须覆盖**真实工具执行 + 输出校验**，不能只调底层 `search()`。

---

## 8. 模块 7：完整评测体系与发布门禁

### 8.1 现状：三类能力

| 入口 | 作用 | 能否进 CI |
| --- | --- | --- |
| `scripts/eval-rag.mjs` | 纯检索：recall@1 / recall@3 / miss-precision / tier-agreement，支持 `--fail-below`、`--strict` | ✅ 离线确定性 |
| `scripts/eval-gate.mjs` | **逐条**与基线比：哪条从命中变不命中、tier 变差、`expect` 引用的条目是否还存在、`embedding` 是否换了 | ✅ 离线确定性（退 0/1/2） |
| `scripts/eval-cs.mjs` | 真模型端到端：派题 → 收回复 → 检查 6 类泄漏 + 未作答/兜底 | ❌ 需要运行中的网关 + 真模型 |
| `scripts/reply-leaks.mjs` | 6 条泄漏正则（实现细节、条目编号、检索旁白、错误承诺、平台术语、URL） | ✅（被上面两者复用） |
| `scripts/eval-gate-smoke.mjs` | 门禁自己的自检：该挂的时候真的挂（27 条） | ✅ |

### 8.2 方案的五阶段 → 现状映射

| 阶段 | 方案内容 | 现状 | 还缺什么 |
| --- | --- | --- | --- |
| 一、离线检索评测 | Recall@1/@3 / miss / tier agreement | ✅ 已有（26 条用例 + 逐条门禁） | 用例扩量；"关键词冲突""低证据""过期知识"三类补样本 |
| 二、意图与动作评测 | Intent Macro-F1 / Action Accuracy / Handoff Recall | ⬜ **完全缺** | 动作轨迹记录器 + 用例集（第 4 节） |
| 三、真实回复评测 | Ragas / 引用证据 / 拒答 / 人工审核 | 🟡 只有泄漏检查 + 人工评的 12 行基线 | 确定性引用一致性（可先做）；Ragas 报表（第 3 节） |
| 四、端到端可靠性 | 工具调用 / 工单状态 / 重试 / 权限 | ✅ 已有（inbox/outbox/lease/auth/scope/promql 共 6 套 smoke） | 库中途挂掉的故障注入 |
| 五、回归门禁 | 逐条比基线、安全指标不退化 | 🟡 检索层已做，其他层没有 | 把动作轨迹与回复指标也接进同一套门禁口径 |

### 8.3 门禁三条原则（值得写进面试稿）

1. **逐条比，不比百分比**。88% vs 90% 说明不了修哪；"case `sig-dialog` 以前命中 `dialog-no-response`，现在返回 `miss`"直接指向问题。
2. **skip ≠ 通过**。公开仓库没有 `kb/` 与 `eval/`，两步评测会打印 `skip:` 而不是静默跳过（当前 `verify-all.sh` 41 步 / 1277 条断言；连库 1441 条；公开镜像 1223 条，差 54 条 = 53 条评测 skip + 1 条 OCR 后端 skip）。
3. **安全指标 0 容忍，质量指标不许回退**。越权取证、`miss` 时硬答、已发送消息重放这三类必须是 100%；其余用基线对比。

---

## 9. 面试检查清单（方案第 5 节 10 项）打勾

| # | 检查项 | 现状 | 备注 |
| --- | --- | --- | --- |
| 1 | 能解释 BM25、向量、RRF 为什么组合 | ✅ | 第 2 节 Q2/Q3 |
| 2 | 能讲清 direct / reference / miss 的规则与阈值 | ✅ | 含容差后门 `direct - 0.12`，这条要主动讲 |
| 3 | 能解释哈希 Embedding 的优点、局限、替换方案 | ✅ | 第 2 节 Q4，**必须主动承认"不是语义模型"** |
| 4 | 能区分检索质量、答案质量、意图路由质量 | ✅ | 8.2 的五阶段就是这三件事的拆解 |
| 5 | 准备一组带正确意图、正确动作的评测样本 | ⬜ | **这项是当前最大缺口**，见第 4 节 |
| 6 | 能解释 Ragas 四项指标及各自调优方向 | 🟡 | 能讲，但要说明"本项目尚未接入"（第 3 节） |
| 7 | 能解释客服/运维工具边界与账号作用域 | ✅ | 第 5 节 + P18/P21 |
| 8 | 能说明超时、重试、幂等、人工升级怎么测 | ✅ | 第 6 节矩阵 |
| 9 | 知道哪些已实现、哪些只是方案 | ✅ 本文档就是这件事 | 第 1.2 节 |
| 10 | 能现场跑检索评测与门禁并解释失败结果 | ✅ | `node scripts/eval-rag.mjs --strict`、`node scripts/eval-gate.mjs` |

---

## 10. 需要你拍板的两件事

### 10.1 RAG 评测方案

| 选项 | 内容 | 代价 | 我的建议 |
| --- | --- | --- | --- |
| A | **只扩展现有确定性体系**：`eval/rag-cases.json` 从 26 条扩到 50~60 条，覆盖"关键词冲突/低证据/过期知识"三类；`eval-gate.mjs` 加"引用一致性"确定性检查 | 1~2 天，零新依赖，可进 CI | ✅ 推荐先做这个 |
| B | A + **Ragas 离线报表**（独立 venv + 固定版本 + JSONL 交换） | 半天~1 天装环境 + 人工写 20~30 条 ground_truth，之后每次报表有成本 | 排在 A 之后 |
| C | 直接上 Ragas 取代现有门禁 | 不可行：judge 有波动，做不了每次提交的门禁 | ❌ |

### 10.2 意图 / 动作评测方案

| 选项 | 内容 | 代价 | 我的建议 |
| --- | --- | --- | --- |
| A | **动作轨迹断言**：旁挂 `session/event` 记录器落 jsonl，用例断言 `[tool/call]` 序列 + 关键参数 + 终态 | 1 天记录器 + 1 天用例（先 20 条）+ 接门禁 | ✅ 推荐，能覆盖交接/接管/安全 |
| B | A + **真模型端到端**跑轨迹（复用 `eval-cs.mjs` 的派题机制） | 每条用例一次模型调用，慢且有成本；结果有波动，只能做趋势 | 作为 A 的补充，不进每次提交 |
| C | 用 LLM judge 判意图 | 二次误差 + 成本，且不可解释 | ❌ |

### 10.3 还有一个语义问题要你确认

`unverified` 状态的条目**当前可以被检索**（`isSearchable` 只排除 `candidate` / `deprecated` / `retired`）。这是有意设计（"没验证过但也不能当不存在，靠 Prompt 降级表述"）还是应该收紧成"只有 verified 参与检索"？

- 若是**有意**：评测里应加一类"未验证条目被命中"的用例，断言回复走的是"参考方案，需验证"的说法。
- 若是**疏漏**：改 `isSearchable` 一行即可，但会减少召回，需要重跑基线。

---

## 附录：事实索引

| 事实 | 位置 |
| --- | --- |
| RRF 常数 `RRF_K = 60` | `kb-core/hybrid.js:24` |
| 11 项 `DEFAULT_TUNING` | `kb-core/hybrid.js:27` |
| 三级判定 + 签名容差后门 | `kb-core/hybrid.js:280-303`，后门在 `:294` |
| 7 类 chunk 字段与权重 | `kb-core/chunks.js:17` |
| 哈希向量 512 维 + 3-gram | `kb-core/embed.js`（`HASH_DIMS`、`TRIGRAM`） |
| 检索可见性规则 | `kb-core/kb.js:146`（`isSearchable`） |
| 角色数据源 | `kb-core/index.js:99`（`sourcesFor`） |
| 内部字段剥离 | `kb-core/index.js:193`（`hidden`） |
| 三个知识库工具 | `kb-core/tools.js:59` / `:200` / `:249` |
| `ops_handoff` 参数与输出 schema | `cs-agent/handoff.js:57` / `:68` / `:93` |
| 派单超时与结果状态 | `ops-agent/dispatcher.js:34`（10 分钟）、`:40`（4 种状态）、`:815`（解析失败→`needs_human`） |
| `tool/call` / `tool/result` 事件形状 | `packages/core/session/lib/types/types.d.ts:355` / `:375` |
| 客服预设 6 步流程 | `cs-agent/cordis.patch.yml`（`preset-service-desk` 的 `persona.prefix`） |
| 检索评测指标 | `scripts/eval-rag.mjs:115-141` |
| 逐条门禁 | `scripts/eval-gate.mjs` |
| 泄漏正则 | `scripts/reply-leaks.mjs` |
| 现有评测数据 | `eval/cases.json`(12)、`eval/baseline.json`(12 行)、`eval/rag-cases.json`(26)、`eval/rag-baseline.json`、`eval/last-run.json` |

---

## 修订记录

| 日期 | 版本 | 说明 |
| --- | --- | --- |
| 2026-10-28 | v1.0 | 首版：评审方案 + 回答 7 个模块的问题；标出 5 处事实修正、1 处顺序调整；RAG 与意图/动作评测方案列为待定（第 10 节） |
