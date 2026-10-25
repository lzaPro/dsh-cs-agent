# 共享知识库（dsh-kb）

客服和运维共用的一套故障知识，装成一个服务 + 一组工具，供两个预设挂载。

```
kb/         共享条目（客服 + 运维，按条目里的 audience 再门控）
kb/_candidates/   候选条目，等人工审核
ops-kb/     运维内部 runbook（整目录只挂给 role: ops）
```

## 两种门控

1. **目录级**：`ops-kb/` 在 `role !== 'ops'` 时根本不会被读进来，客服的 `kb_search` 看不到、也搜不到。
2. **条目级**：`kb/` 里的条目按 `audience` 分
   - `customer`（默认）：客服和运维都能读；
   - `ops`：客服能搜到标题、但 `kb_get` 返回 `internalHidden: true`，不给处置细节；
   - `internal`：只给运维。

`kb_get` 对客服隐藏时会去掉 `rootCause` / `resolution` / `verification`——客户能听懂的「怎么办」在 `customerReply` 里，内部怎么修不给。

## 服务

`kb-core/index.js` 提供 `kbStore`：

```js
ctx.get('kbStore').search({ query, service, environment, limit }, role)  // → { hits, total }
ctx.get('kbStore').get(id, role)                                         // → { found, entry?, internalHidden? }
ctx.get('kbStore').propose(input)                                        // → 写候选文件
ctx.get('kbStore').candidates()                                          // → 待审队列
ctx.get('kbStore').verify(id, { audience, reviewer })                    // → 落进 kb/ 或 ops-kb/
ctx.get('kbStore').reject(id, { reason })                                // → 移到 _rejected/
ctx.get('kbStore').stats()                                               // → { shared, internal, candidates }
```

`role` 由工具层传进去，服务本身不信任调用方自报身份——工具插件在装配时就固定了 `role`。

## 工具

`kb-core/tools.js`（`config.role` 必须是 `customer-service` 或 `ops`）：

| 工具 | 说明 |
|---|---|
| `kb_search` | 混合检索：BM25 + 向量双路召回、RRF 融合、按置信度给出 `verdict` |
| `kb_get` | 读全文，按角色隐藏内部字段 |
| `kb_propose` | 提交候选；`audience: internal` 只有 ops 能提，客服提会直接报错（不静默降级）；命中已有签名则只累加计数 |

检索对中文友好：不分词，用「拉丁词 + 汉字 bigram」，所以「扣了9.9元」也能命中 `subscription-fee-9-9-19-9`。

### 输出 schema 是硬契约

三个工具的 `output.schema` 都写了 `additionalProperties: false`，宿主会**在模型看到结果之前**逐字段校验返回值。这带来一个陷阱：给 `store.search()` 加字段（比如 RAG 之后的 `signals`、`margin`）却忘了同步 schema，工具就变成硬错误

```
tool "kb_search" returned invalid output: "value.hits[0].signals"
is not a declared property (additionalProperties: false)
```

模型拿不到结果，只能回头追问客户——表现为「答得客气但什么都没答」，从日志里很难看出是 schema 问题。所以加字段必须同时改两处，并且有 `kb-core/tools-schema-smoke.mjs` 守着：它驱动真实 `execute()`，用一个独立实现的小校验器按声明 schema 逐字段核对（含负向用例，证明这个校验器本身能抓到漏声明）。

## 检索：分块 → 双路召回 → 三级判定

一条故障经验不是一个字符串，而是四段证据：**错误特征 / 现象 / 处置 / 验证**。检索对每段单独建索引，因为客户说的往往是「现象」，而答案在「处置」里。

```
条目 ─→ 分块（signature 1.5 · title 1.3 · symptom 1.2 · customerReply 1.1 · resolution 1.0 · verification 0.7 · meta 0.6）
         ├─ BM25（词命中，只扫倒排表）
         └─ 向量（512 维特征哈希，或 OpenAI 兼容 /embeddings）
              └─ RRF 融合（k=60，每条目每通道只取最好名次）
                   └─ 打分 → 置信度判定：direct / reference / miss
```

打分（`kb-core/hybrid.js` 的 `DEFAULT_TUNING`）：

```
score = (0.46·relevance + 0.32·signature + 0.22·coverage + 0.06·prior + 0.20·signatureTokens) · statusFactor
```

- `relevance`：融合名次归一化；
- `signature`：客户原话里出现完整错误签名（含 `-122` 这类码）；
- `coverage`：查询词落在条目里的比例；
- `prior`：同签名历史出现次数（`log1p` 压缩，最多 10 次封顶）；
- `signatureTokens`：查询词落在「错误特征」段的比例——同一个词出现在「验证」里，证据强度远低于出现在「错误特征」里；
- `statusFactor`：`verified` 1.0、`stale` 0.75、其它 0.6。

三级判定的含义（写进工具描述，模型据此行动）：

| verdict | 触发条件 | 模型该做什么 |
|---|---|---|
| `direct` | 分数 ≥ 0.56 且领先第二名 ≥ 0.08 且（签名命中或覆盖 ≥ 30%） | 按条目答，可引用 `customerReply` |
| `reference` | 分数 ≥ 0.30 | 只当线索，先追问补充信息，不要照搬方案 |
| `miss` | 其余 | 必须调用 `clarify` 追问，禁止编方案 |

`directCoverage` 这条闸门是踩出来的：**只共用一个词就答**会把「服务有点慢」判成 `container-scale-zero`，加闸门后降为 `reference`，模型改为追问。

## 闭环：候选 → 审核 → 去重 → 失效

```
kb_propose ──┬─ 签名与现有条目 Jaccard ≥ 0.5 → 不新建，给该条目 +1 occurrence
             └─ 新问题 → kb/_candidates/*.json（不进检索）
                          └─ scripts/kb-review.mjs verify → 落 kb/ 或 ops-kb/
                          └─ scripts/kb-review.mjs reject → 移 _rejected/
scripts/kb-review.mjs expire <id> → status: deprecated（保留可查，不再出现在检索里）
```

出现次数存在 `<dataDir>/kb-stats.json`，检索时读一次、命中后累加，写入失败只告警不阻断（只读数据目录也要能检索）。

## 评测

```bash
node scripts/eval-rag.mjs           # 26 条标注用例，测 recall@1/@3、miss-precision、tier-agreement
node scripts/eval-rag.mjs --strict  # 任一指标不为 100% 就非零退出
cd kb-core && node rag-smoke.mjs    # 27 项单元测试：分块、BM25、RRF、向量单路、签名、闸门、闭环
```

当前指标（26 条）：`recall@1 100% · recall@3 100% · miss-precision 100% · tier-agreement 100%`。

用例分三类：`sig-*`（带原样错误码）、`para-*`（同一故障的另一种说法）、`miss-*`（知识库里没有的问题，必须判未命中）。

## 审核闭环

```
kb_propose → kb/_candidates/candidate-*.json → 面板「知识库候选」→ verify / reject
```

verify 时按 `audience` 决定落点：`internal` 进 `ops-kb/`，其余进 `kb/`，`status` 改为 `verified`，原候选删除。
未审核的条目**不进检索**——避免一个 agent 的猜测变成另一个 agent 的「事实」。

## 条目格式

```json
{
  "id": "pvc-disk-full",
  "title": "PVC 已满：-122 报错 / disk quota exceed",
  "status": "verified",
  "audience": "ops",
  "errorSignatures": ["-122", "disk quota exceed"],
  "services": ["sophclaw"],
  "environments": ["production"],
  "symptom": "客户发送消息返回 -122，日志显示 disk quota exceed。",
  "customerReply": "这是容器的存储空间满了，已转技术同事处理。",
  "rootCause": "PVC 配额耗尽，写入失败，探针随之失败。",
  "resolution": "1. …\n2. …",
  "verification": "容器 Ready，客户能正常发送消息。",
  "tags": ["storage", "pvc"],
  "updated": "2026-10-23"
}
```

`_template.json` 是空模板。字段权重决定检索排名，不是装饰：`errorSignatures` 是客户原话里的报错码或日志关键字，写准了检索就准。

## 自测

```bash
node kb-core/smoke.mjs        # 22 项：角色门控、候选闭环
node kb-core/rag-smoke.mjs    # 27 项：分块、BM25、RRF、向量、签名、闸门、台账
node scripts/kb-review-smoke.mjs  # 11 项：审核 CLI 的 verify / reject / expire
```

`smoke.mjs` 覆盖：检索命中、角色门控（客服搜不到 internal、`kb_get` 被隐藏）、候选 propose → 不可见 → verify → 可检索、internal 候选落到 `ops-kb/`、reject 出队、坏 JSON 报错。
