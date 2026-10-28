#!/usr/bin/env node
// 把真实客服群聊导出（GB18030 转成 UTF-8 的纯文本）转成 Ragas 评测数据集。
//
// 输入是运营群里的聊天记录，不是结构化数据：草稿、日报、任务单、人机问答混在
// 一起，还夹着投递调试和排班闲聊。这个脚本做四件事：
//   1. 切消息：导出格式是「发言人单独一行 + 若干行正文」，但 avatar 行位置不固定，
//      所以用「提问锚点」反推边界，而不是靠 avatar（见 anchorsOf）。
//   2. 认块：一条 bot 消息里可能同时有 KB 草稿和客户支持日报，按章节标记切。
//   3. 转成知识库形态：草稿/任务单本来就是人写的条目，映射到 kb/*.json 的字段；
//      这一步产出的 kbForm 既是 contexts 的来源，也保留成结构化的证据。
//   4. 脱敏 + 分级标注：手机号、userId、人名全部打码；日志里被「确认」「已解决」
//      印证过的答案标 gold，其余标 silver。
//
// 用法：
//   node scripts/ragas-dataset.mjs --log .build/eval-import/records-utf8.txt
//   node scripts/ragas-dataset.mjs --log <path> --out eval/ragas-dataset.jsonl --stats
//   node scripts/ragas-dataset.mjs --fixture --stats        # 只跑内置小样本
//
// 原始聊天记录**不入库**（含真实手机号），只有脱敏后的 JSONL 进 git。

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

export const DATASET_VERSION = 1;

// 需求方（m03920）拍板的口径，写在这里让产物自解释：
//   - 只产出 Ragas 数据集，不往 kb/ 写条目
//   - gold / silver 分级
//   - 全部脱敏
export const SAMPLE_FAMILIES = {
  kb_entry: '从 KB 草稿或任务单转出的条目型样本（问题由症状合成）',
  logged_qa: '群里真实发生的「同事问 → bot 答」样本'
};

const DRAFT_RE = /KB 草稿\s+(draft-\d{8}-\d{3})/;
const REPORT_RE = /客户支持日报[（(](\d{4}-\d{2}-\d{2})[）)]/;
const BUG_RE = /Bug\s*日报[（(]?(\d{4}-\d{2}-\d{2})?/;
const TASK_RE = /^任务\s*([A-Za-z][A-Za-z0-9_]*)\s*[：:]\s*(.*)$/;
const RESOLVED_RE = /任务\s*([A-Za-z][A-Za-z0-9_]*)\s*已解决[，,]\s*排查结论为\s*[：:]\s*(.*)$/;
const STEP_REF_RE = /(kb\/[A-Za-z0-9_\-/\u4e00-\u9fa5]+|draft-\d{8}-\d{3})/g;

function lines(file) {
  return readFileSync(file, 'utf8').split('\n').map(line => line.replace(/\r$/, ''));
}

function isBlank(line) {
  return line.trim() === '';
}

function isAvatar(line) {
  return line.trim() === 'avatar';
}

function isBot(line) {
  return line.trim().startsWith('SPC BCB');
}

// 提问有两种写法，都要认：
//   发言人独占一行，下一行 @SPC BCB ...
//   发言人：@SPC BCB ...（同一行）
const INLINE_ASK_RE = /^([^\s：:@*•]{1,8})[：:]\s*(@SPC BCB\b.*)$/;
const AT_BOT_RE = /^@SPC BCB\b/;

// 这些行长得像提问，其实是模板说明，配上去只会污染数据集。
const TEMPLATE_ASKS = [
  /任务\s*XXX\s*已解决/, // 「例：」下面的模板
  /^@SPC BCB\s*确认\s+draft-/,
  /^@SPC BCB\s*拒绝\s+draft-/
];

function isTemplateAsk(text) {
  return TEMPLATE_ASKS.some(re => re.test(text));
}

/**
 * 找出所有"真人问 bot"的锚点，返回行号 -> {asker, question}。
 * 不依赖 avatar，因为它在导出里时有时无。
 */
export function anchorsOf(source) {
  const anchors = new Map();
  for (let index = 0; index < source.length; index += 1) {
    const line = source[index];
    if (!AT_BOT_RE.test(line.trim())) {
      // 内联形态：韩子怡：@SPC BCB ...
      const inline = INLINE_ASK_RE.exec(line.trim());
      if (inline === null || isTemplateAsk(inline[2])) continue;
      // 内联草稿确认/拒绝也在同一行，用模板过滤挡掉
      const question = inline[2].replace(/^@SPC BCB\s*/, '').trim();
      if (question === '' || isTemplateAsk('@SPC BCB ' + question)) continue;
      anchors.set(index, { asker: inline[1], question, askerLine: index });
      continue;
    }
    const trimmed = line.trim();
    if (isTemplateAsk(trimmed)) continue;
    const question = trimmed.replace(/^@SPC BCB\s*/, '').trim();
    if (question === '') continue;
    // 往上跳过空行与 avatar 行，取发言人
    let back = index - 1;
    while (back >= 0 && (isBlank(source[back]) || isAvatar(source[back]))) back -= 1;
    const asker = back >= 0 ? source[back].trim() : '';
    anchors.set(index, { asker, question, askerLine: back >= 0 ? back : index });
  }
  return anchors;
}

/**
 * 把行数组切成消息：bot 消息单独收，其余按提问锚点收。
 * 返回 [{kind:'bot'|'ask', from, lines, startLine}]
 */
export function messagesOf(source) {
  const anchors = anchorsOf(source);
  const messages = [];
  let index = 0;
  while (index < source.length) {
    const line = source[index];
    if (isBot(line) && !anchors.has(index)) {
      const start = index;
      let end = index + 1;
      while (end < source.length) {
        const next = source[end];
        if (isBot(next) || isAvatar(next) || anchors.has(end)) break;
        end += 1;
      }
      messages.push({ kind: 'bot', from: 'SPC BCB', lines: bodyOf(source, start + 1, end), startLine: start });
      index = end;
      continue;
    }
    const anchor = anchors.get(index);
    if (anchor !== undefined) {
      messages.push({ kind: 'ask', from: anchor.asker, question: anchor.question, startLine: index });
      index += 1;
      continue;
    }
    index += 1;
  }
  return messages;
}

function bodyOf(source, from, to) {
  const body = source.slice(from, to);
  while (body.length > 0 && isBlank(body[body.length - 1])) body.pop();
  return body;
}

/** 一条 bot 消息里可能有好几块，按章节标记切。 */
export function sectionsOf(body) {
  const markers = [];
  for (let index = 0; index < body.length; index += 1) {
    const line = body[index];
    if (DRAFT_RE.test(line)) markers.push({ index, kind: 'draft' });
    else if (REPORT_RE.test(line)) markers.push({ index, kind: 'report' });
    else if (/新任务待处理/.test(line) && /🐛|任务/.test(line)) markers.push({ index, kind: 'task' });
    else if (BUG_RE.test(line) && /Bug/.test(line)) markers.push({ index, kind: 'bug' });
  }
  if (markers.length === 0) return [{ index: 0, kind: 'answer' }];
  const sections = [];
  // 第一个标记之前的行：可能是给上一个提问的答复，也可能是空
  if (markers[0].index > 0) sections.push({ index: 0, kind: 'answer' });
  for (let at = 0; at < markers.length; at += 1) {
    const end = at + 1 < markers.length ? markers[at + 1].index : body.length;
    sections.push({ ...markers[at], end });
  }
  for (let at = 0; at < sections.length; at += 1) {
    if (sections[at].end === undefined) {
      sections[at].end = at + 1 < sections.length ? sections[at + 1].index : body.length;
    }
  }
  return sections.filter(section => section.end > section.index);
}

function clean(value) {
  return (value ?? '').replace(/\s+/gu, ' ').trim();
}

// 答案里的编号步骤是有效信息，只压掉多余空格、保留换行。
function flatten(block) {
  return block
    .map(line => line.replace(/[ \t\u3000]+/gu, ' ').trim())
    .filter(line => line !== '')
    .join('\n');
}

function stripDecor(text) {
  return text.replace(/^[【\[]/u, '').replace(/[】\]]$/u, '').replace(/[：:]\s*$/, '');
}

// 标题行有三种写法：【SophCode Desktop 无法保存凭证】 / 标题】iPhone 下载 App /
// 标题: Sophclaw 套餐不支持回退。不清掉前缀，标题会带着「标题】」进数据集。
function cleanTitle(line) {
  return line
    .replace(/^[【\[]?\s*标\s*题\s*[】\]]?\s*[:：]?\s*/u, '')
    .replace(/^[【\[]/u, '')
    .replace(/[】\]]$/u, '')
    .trim();
}

const STEP_RE = /^\s*(?:\d+[)）.、]|[①②③④⑤⑥⑦⑧⑨⑩])\s*(.+)$/u;

function stepsOf(body) {
  const steps = [];
  for (const line of body) {
    const matched = STEP_RE.exec(line);
    if (matched !== null) steps.push(matched[1].trim());
  }
  return steps;
}

function refsOf(texts) {
  const found = new Set();
  for (const text of texts) {
    for (const match of String(text).matchAll(STEP_REF_RE)) {
      found.add(match[1].replace(/[。，,；;：:]+$/, ''));
    }
  }
  return [...found];
}

/** 知识库草稿 -> kb 条目形态。 */
export function parseDraft(block, source) {
  const head = block[0];
  const id = DRAFT_RE.exec(head)[1];
  const rest = block.slice(1);
  let title = '';
  let category = '';
  const symptom = [];
  const scenario = [];
  const steps = [];
  let bucket = 'title';
  for (const rawLine of rest) {
    const line = rawLine.trim();
    if (line === '') continue;
    if (/^确认\s*[:：]/u.test(line) || /^拒绝\s*[:：]/u.test(line)) break;
    const label = stripDecor(line);
    if (/^分类$/u.test(label)) {
      bucket = 'category';
      continue;
    }
    if (/^分类\s*[:：]/u.test(line)) {
      category = line.replace(/^分类\s*[:：]\s*/, '').trim();
      bucket = 'category';
      continue;
    }
    if (/^标签$/u.test(label)) {
      bucket = 'tags';
      continue;
    }
    if (/^问题描述$/u.test(label)) {
      bucket = 'symptom';
      continue;
    }
    if (/^(适用场景|场景)$/u.test(label)) {
      bucket = 'scenario';
      continue;
    }
    if (/^(操作步骤|处理步骤|解决步骤)$/u.test(label)) {
      bucket = 'steps';
      continue;
    }
    if (bucket === 'title') {
      title = cleanTitle(line);
      bucket = 'symptom-head';
      continue;
    }
    if (bucket === 'category') {
      category = line;
      bucket = 'symptom-head';
      continue;
    }
    const step = STEP_RE.exec(line);
    if (step !== null && bucket === 'steps') steps.push(step[1].trim());
    else if (step !== null) steps.push(step[1].trim());
    else if (bucket === 'scenario') scenario.push(line);
    else if (bucket === 'steps') steps.push(line);
    else symptom.push(line);
  }
  const confirmed = source.some(line => new RegExp(`确认\\s*[:：]?\\s*@?SPC BCB\\s+确认\\s+${id}`).test(line));
  const rejected = source.some(line => new RegExp(`拒绝\\s*[:：]?\\s*@?SPC BCB\\s+拒绝\\s+${id}`).test(line));
  return {
    id,
    title: clean(title),
    category: clean(category),
    symptom: clean(symptom.join(' ')),
    scenario: clean(scenario.join(' ')),
    steps,
    confirmed,
    rejected
  };
}

/** 「🐛 新任务待处理」块 -> kb 条目形态。 */
export function parseTask(block) {
  const text = block.join('\n');
  const taskMatch = /任务\s*([A-Za-z][A-Za-z0-9_]*)\s*[：:]\s*([\s\S]*?)(?:\n\s*受影响用户及电话|\n\s*图片|\n\s*来源)/.exec(text);
  const taskId = taskMatch === null ? '' : taskMatch[1];
  const symptom = taskMatch === null ? '' : clean(taskMatch[2]).replace(/（[^）]*代报）/u, '').trim();
  const userLine = /受影响用户及电话\s*[：:]\s*(.+)/u.exec(text);
  const userOps = sectionBetween(block, '【用户操作】', '【管理员操作】');
  const adminOps = sectionBetween(block, '【管理员操作】', '如果知识库内容缺失');
  const quotedErrors = [];
  for (const match of symptom.matchAll(/[「『]([^」』]{2,40})[」』]/gu)) quotedErrors.push(match[1].trim());
  return {
    id: taskId,
    symptom,
    affectedUser: userLine === null ? '' : clean(userLine[1]),
    customerReplySteps: userOps,
    resolutionSteps: adminOps,
    errorSignatures: quotedErrors,
    referenced: refsOf([...userOps, ...adminOps]),
    reportedAt: ''
  };
}

function sectionBetween(block, startLabel, endLabel) {
  const start = block.findIndex(line => line.includes(startLabel));
  if (start === -1) return [];
  const out = [];
  for (let index = start + 1; index < block.length; index += 1) {
    const line = block[index].trim();
    if (line.includes(endLabel)) break;
    if (line === '' || /^【/.test(line)) continue;
    if (/^(如果知识库内容缺失|值班人员|处理完成后)/.test(line)) break;
    const step = STEP_RE.exec(line);
    if (step !== null) out.push(step[1].trim());
    else out.push(line);
  }
  return out;
}

/** 客户支持日报 -> 未沉淀的症状清单（用来扩充 query 变体）。 */
export function parseReport(block) {
  const date = REPORT_RE.exec(block[0])?.[1] ?? '';
  let bucket = '';
  let handoff = 0;
  const handled = [];
  const suggested = [];
  const drafts = [];
  for (const rawLine of block.slice(1)) {
    const line = rawLine.trim();
    if (line === '') continue;
    if (/^【总览】/u.test(line)) {
      bucket = 'overview';
      continue;
    }
    if (/^【人工处理】/u.test(line)) {
      bucket = 'handled';
      continue;
    }
    if (/^【建议补充知识库】/u.test(line)) {
      bucket = 'suggested';
      continue;
    }
    if (/重复问题预警/u.test(line)) break;
    const handoffMatch = /转人工\s*[：:]\s*(\d+)/u.exec(line);
    if (handoffMatch !== null) {
      handoff = Number(handoffMatch[1]);
      continue;
    }
    const draftMatch = /^[•·]?\s*(draft-\d{8}-\d{3})\s*[:：]\s*(.+)$/u.exec(line);
    if (draftMatch !== null) {
      drafts.push({ id: draftMatch[1], title: clean(draftMatch[2]) });
      continue;
    }
    const bullet = /^[•·]\s*(.+)$/u.exec(line);
    if (bullet === null) continue;
    if (bucket === 'handled') handled.push(clean(bullet[1]));
    else if (bucket === 'suggested') suggested.push(clean(bullet[1]));
  }
  return { date, handoff, handled, suggested, drafts };
}

/** 把 kb 条目形态渲染成检索时真正会看到的文本（contexts 用）。 */
export function renderEntry(entry) {
  const parts = [];
  if (entry.title !== undefined && entry.title !== '') parts.push(`标题：${entry.title}`);
  if (entry.status !== undefined) parts.push(`状态：${entry.status}`);
  if (entry.audience !== undefined) parts.push(`对象：${entry.audience}`);
  if (Array.isArray(entry.errorSignatures) && entry.errorSignatures.length > 0) {
    parts.push(`报错特征：${entry.errorSignatures.join(' / ')}`);
  }
  if (entry.symptom !== undefined && entry.symptom !== '') parts.push(`症状：${entry.symptom}`);
  const replyDuplicated = entry.customerReply !== undefined && entry.customerReply !== ''
    && String(entry.resolution ?? '').startsWith(entry.customerReply);
  if (entry.customerReply !== undefined && entry.customerReply !== '' && !replyDuplicated) {
    parts.push(`对客户说明：${entry.customerReply}`);
  }
  if (entry.resolution !== undefined && entry.resolution !== '') parts.push(`处理步骤：${entry.resolution}`);
  if (entry.verification !== undefined && entry.verification !== '') parts.push(`验证：${entry.verification}`);
  return parts.join('\n');
}

function numbered(steps) {
  return steps.map((step, index) => `${index + 1}. ${step}`).join('\n');
}

// ---------------------------------------------------------------- 脱敏

const PHONE_RE = /(?<!\d)(1[3-9]\d{9})(?!\d)/g;
const ID_RUN_RE = /(?<!\d)(\d{4,8})(?!\d)/g;

export function maskPhone(text) {
  return String(text).replace(PHONE_RE, (_, phone) => `${phone.slice(0, 3)}****${phone.slice(-4)}`);
}

/**
 * 人名的收集：发言人 + 「受影响用户」行里的名字。
 * 不做通用 NER——这批日志里人名就是这两处出现，硬猜反而会打错。
 */
export function namesOf(source, messages) {
  const names = new Set();
  for (const message of messages) {
    if (message.kind === 'ask' && message.from !== '' && message.from !== 'SPC BCB') names.add(message.from);
  }
  for (const line of source) {
    const matched = /受影响用户及电话\s*[：:]\s*([^（(\s，,、]+)/u.exec(line);
    if (matched !== null) names.add(matched[1]);
    const bullet = /反馈[^。，,\n]{0,6}?用户\s*([\u4e00-\u9fa5]{2,4})(?:（|\(|反馈|需要|的)/u.exec(line);
    if (bullet !== null) names.add(bullet[1]);
  }
  // 值班人员也要打码，但它们是内部同事、不进样本的答案；不打码会漏进 meta
  for (const line of source) {
    const duty = /值班人员\s*[：:]\s*@?\s*([\u4e00-\u9fa5]{2,4})/u.exec(line);
    if (duty !== null) names.add(duty[1]);
  }
  return [...names].filter(name => name.length >= 2 && name !== '用户' && name !== '客服');
}

export function createMasker(names) {
  const sorted = [...names].sort((left, right) => right.length - left.length);
  const byName = new Map(sorted.map((name, index) => [name, `用户${alpha(index)}`]));
  const byId = new Map();
  const idAlias = (code) => {
    if (!byId.has(code)) byId.set(code, `UID-${String(byId.size + 1).padStart(4, '0')}`);
    return byId.get(code);
  };

  // 关键：一次扫描 + 占位符。分开多轮替换会互相吃掉——先打码手机号成
  // 「188****5727」，下一轮的「6 位以上数字」再把它中间的 5727 打一遍，就成了
  // 「188****#****」；日期「2026-10-09」也会被当成号码打成「#****-10-09」。
  function scrub(text) {
    if (text === undefined || text === null) return '';
    let out = String(text);
    const kept = [];
    const stash = (value) => {
      kept.push(value);
      return `\u0000${kept.length - 1}\u0000`;
    };

    // 1) 先护住日期与时间：它们是内容，不是隐私
    out = out.replace(/(?<!\d)\d{4}-\d{1,2}-\d{1,2}(?!\d)/gu, match => stash(match));
    out = out.replace(/(?<!\d)\d{1,2}:\d{2}(?!\d)/gu, match => stash(match));
    // 草稿 id 里的 8 位日期同理，打掉就没法追溯了
    out = out.replace(/draft-\d{8}-\d{3}/gu, match => stash(match));
    // 2) 手机号
    out = out.replace(PHONE_RE, phone => stash(`${phone.slice(0, 3)}****${phone.slice(-4)}`));
    // 3) userId 141201 / 用户9641 这类用户编号
    out = out.replace(/userId\s*[：:=]?\s*(\d{3,8})/giu, (_, code) => stash(`userId ${idAlias(code)}`));
    out = out.replace(/用户\s*(\d{3,8})(?!\d)/gu, (_, code) => stash(`用户 ${idAlias(code)}`));
    // 4) 人名（长的先替，避免「王豪」把「王豪州」拆坏）
    for (const [name, alias] of byName) {
      if (name !== '' && out.includes(name)) out = out.split(name).join(stash(alias));
    }
    // 5) 工单号 / 表格 id / 其余长数字串
    out = out.replace(/(sheetId|recordId)\s*[=：:]\s*([A-Za-z0-9]{1,12})/gu, (_, key, id) => stash(`${key}=${id.slice(0, 3)}***`));
    out = out.replace(/(?<!\d)\d{6,}(?!\d)/gu, match => stash(`${match.slice(0, 3)}****${match.slice(-2)}`));
    // 6) 「（比特，…）」这种渠道+逗号前缀对客户没意义
    out = out.replace(/（(?:比特|个人版|企业版)[，,]\s*/gu, '（');

    const restored = out.replace(/\u0000(\d+)\u0000/gu, (_, index) => kept[Number(index)]);
    // 原文常写「用户魏爽」/「比特用户魏爽」，替换人名后会变成「用户用户Q」，收一下。
    // 必须在还原占位符之后做：人名是以占位符形式插进去的，早做匹配不到。
    return restored.replace(/比特用户/gu, '用户').replace(/用户\s*用户/gu, '用户');
  }

  function map() {
    return {
      names: Object.fromEntries(byName),
      ids: Object.fromEntries(byId)
    };
  }
  return { scrub, map };
}

function alpha(index) {
  return String.fromCharCode(65 + (index % 26)) + (index >= 26 ? String(Math.floor(index / 26)) : '');
}

// ---------------------------------------------------------------- 组装样本

// 任务描述是一长句。标题取首个冒号前的那一段（「用户反馈 sophclaw 无法使用」），
// 硬截断会切在词中间，读起来像乱码。
function titleOfSymptom(symptom) {
  const flat = clean(symptom);
  if (flat === '') return '';
  const head = flat.split(/[：:]/u)[0].trim();
  const text = head.length >= 6 ? head : flat;
  if (text.length <= 60) return text;
  const cut = text.slice(0, 60);
  const boundary = Math.max(cut.lastIndexOf('，'), cut.lastIndexOf('。'), cut.lastIndexOf(' '));
  return `${boundary > 20 ? cut.slice(0, boundary) : cut}…`;
}

function questionFromDraft(entry) {
  const title = entry.title.replace(/[（(][^）)]*[）)]$/u, '').trim();
  return `用户反馈「${title}」，怎么处理？`;
}

function questionFromTask(task) {  const text = task.symptom
    .replace(/^(比特)?用户[^:：]{0,12}?(反馈|说|表示)/u, '用户反馈')
    .replace(/^任务\s*[A-Za-z0-9_]+\s*[：:]\s*/u, '')
    .trim();
  const body = text === '' ? task.symptom : text;
  return body.endsWith('？') || body.endsWith('?') ? body : `${body}，怎么处理？`;
}

function draftEntry(draft) {
  return {
    id: draft.id,
    title: draft.title,
    status: draft.confirmed ? 'verified' : 'unverified',
    audience: 'customer',
    errorSignatures: [],
    services: ['sophclaw'],
    environments: [],
    symptom: draft.symptom,
    // 草稿的「操作步骤」本身就是对客户说的话，再单列一句 customerReply 会重复
    customerReply: '',
    resolution: numbered(draft.steps),
    verification: draft.scenario,
    tags: draft.category === '' ? [] : [draft.category],
    updated: ''
  };
}

function taskEntry(task) {
  return {
    id: task.id,
    title: titleOfSymptom(task.symptom),
    status: 'verified',
    audience: 'customer',
    errorSignatures: task.errorSignatures,
    services: ['sophclaw'],
    environments: [],
    symptom: task.symptom,
    customerReply: numbered(task.customerReplySteps),
    resolution: numbered(task.resolutionSteps),
    verification: '',
    tags: [],
    updated: ''
  };
}

// 群里混着排班、投递调试、任务回执这些内部杂事，它们不是客服知识。
// 只留下答案确实来自知识库（引用了 kb/ 路径，或明说知识库没覆盖）的问答。
const INTERNAL_NOISE = /(值班|排班|请假|调班|投递|截图|金山表格|已解决|已记录|已录入|recordId|sheetId|kdocs|CTE|进度说明)/u;
const KB_GROUNDED = /(根据知识库|我查遍了知识库|知识库未覆盖|知识库未直接覆盖|没有完全对应的文档|kb\/)/u;

export function isKnowledgeAnswer(question, answer) {
  if (question.length < 4) return false;
  if (INTERNAL_NOISE.test(question)) return false;
  if (answer.length < 60) return false;
  if (!KB_GROUNDED.test(answer)) return false;
  // 「📎 CAn 截图 1/1」这类是附件占位，不是答案
  if (/^📎/u.test(answer)) return false;
  return true;
}

export function buildSamples(source, options = {}) {
  const messages = messagesOf(source);
  const names = namesOf(source, messages);
  const masker = createMasker(names);

  // 先扫一遍「已解决」回执：任务号 -> 排查结论，给任务型样本做 gold
  const resolutions = new Map();
  for (let index = 0; index < source.length; index += 1) {
    const matched = RESOLVED_RE.exec(source[index].trim());
    if (matched === null) continue;
    const tail = [matched[2]];
    for (let next = index + 1; next < source.length; next += 1) {
      const line = source[next].trim();
      if (line === '' || isAvatar(line) || isBot(line)) break;
      if (/^(通知|值班|@)/u.test(line)) break;
      tail.push(line);
      if (tail.join(' ').length > 400) break;
    }
    if (!resolutions.has(matched[1])) resolutions.set(matched[1], clean(tail.join(' ')));
  }

  const drafts = [];
  const tasks = [];
  const reports = [];
  const answers = [];

  let pendingQuestion;
  for (const message of messages) {
    if (message.kind === 'ask') {
      pendingQuestion = message;
      continue;
    }
    const sections = sectionsOf(message.lines);
    // 一条 bot 消息如果带着草稿/日报/任务单，它就是在推送，不是在回答上一条提问。
    // 不排除的话，日报开头那几行会被当成"答案"配给下一条提问。
    const pushing = sections.some(section => section.kind !== 'answer');
    for (const section of sections) {
      const block = message.lines.slice(section.index, section.end);
      if (block.length === 0) continue;
      if (section.kind === 'draft') {
        drafts.push({ ...parseDraft(block, source), lines: message.startLine + section.index + 1 });
      } else if (section.kind === 'task') {
        tasks.push({ ...parseTask(block), lines: message.startLine + section.index + 1 });
      } else if (section.kind === 'report') {
        reports.push(parseReport(block));
      } else if (section.kind === 'answer' && !pushing) {
        const text = flatten(block);
        if (text !== '' && pendingQuestion !== undefined) {
          answers.push({ question: pendingQuestion.question, asker: pendingQuestion.from, answer: text, lines: message.startLine + section.index + 1 });
          pendingQuestion = undefined;
        }
      }
    }
    if (pushing) pendingQuestion = undefined;
  }

  const samples = [];
  const seenQuestions = new Set();
  const push = (sample) => {
    const key = sample.question;
    if (seenQuestions.has(key)) return;
    seenQuestions.add(key);
    samples.push(sample);
  };

  // 1) 草稿型：经过人工确认的草稿，知识本身可信，但问题是合成的 → gold 只在
  //    「条目内容」这一层成立，应答质量没被验证过。
  for (const draft of drafts) {
    const entry = draftEntry(draft);
    const context = renderEntry(entry);
    const question = masker.scrub(questionFromDraft(entry));
    push({
      id: `draft-${draft.id}`,
      family: 'kb_entry',
      question,
      contexts: [masker.scrub(context)],
      answer: masker.scrub(context),
      ground_truth: masker.scrub(context),
      ground_truth_kind: draft.confirmed ? 'gold' : 'silver',
      gold_source: draft.confirmed ? 'kb_draft_confirmed' : 'kb_draft_unconfirmed',
      question_origin: 'synthesized_from_title',
      eval_scope: ['context_precision', 'context_recall', 'faithfulness', 'answer_relevancy', 'answer_correctness'],
      kb_form: scrubDeep(entry, masker),
      meta: {
        source: 'kb_draft',
        source_kind: 'bot_push',
        line: draft.lines,
        draft_id: draft.id,
        confirmed: draft.confirmed,
        rejected: draft.rejected,
        category: masker.scrub(draft.category)
      }
    });
  }

  // 2) 任务单型：群里真实报上来的故障，答案来自生产知识库，问题也是真实转述。
  for (const task of tasks) {
    const entry = taskEntry(task);
    const resolution = resolutions.get(task.id);
    const context = renderEntry(entry);
    const goldText = resolution === undefined ? '' : masker.scrub(resolution);
    push({
      id: `task-${task.id}`,
      family: 'kb_entry',
      question: masker.scrub(questionFromTask(task)),
      contexts: [masker.scrub(context)],
      answer: masker.scrub(context),
      ground_truth: goldText === '' ? masker.scrub(context) : goldText,
      ground_truth_kind: resolution === undefined ? 'silver' : 'gold',
      gold_source: resolution === undefined ? 'production_kb_quote' : 'task_resolved',
      question_origin: 'internal_report',
      eval_scope: ['context_precision', 'context_recall', 'faithfulness', 'answer_relevancy', 'answer_correctness'],
      kb_form: scrubDeep(entry, masker),
      meta: {
        source: 'task_block',
        source_kind: 'bot_push',
        line: task.lines,
        task_id: task.id,
        referenced: task.referenced.map(item => masker.scrub(item)),
        received_ops_steps: task.resolutionSteps.length
      }
    });
  }

  // 3) 真实问答型：问题是人真问的，答是 bot 真答的，ground_truth 没有人工复核
  //    → 一律 silver，除非同一话题能对上某条已确认草稿。
  let qa = 0;
  for (const answer of answers) {
    const question = clean(answer.question);
    if (!isKnowledgeAnswer(question, answer.answer)) continue;
    qa += 1;
    const cited = refsOf([answer.answer]);
    const matchedDraft = drafts.find(draft => cited.some(ref => ref === draft.id));
    const groundTruth = matchedDraft === undefined ? masker.scrub(answer.answer) : masker.scrub(renderEntry(draftEntry(matchedDraft)));
    push({
      id: `qa-${String(qa).padStart(3, '0')}`,
      family: 'logged_qa',
      question: masker.scrub(question),
      contexts: cited.map(item => masker.scrub(item)),
      answer: masker.scrub(answer.answer),
      ground_truth: groundTruth,
      ground_truth_kind: matchedDraft === undefined ? 'silver' : 'gold',
      gold_source: matchedDraft === undefined ? 'bot_answer' : 'kb_draft_confirmed',
      question_origin: 'logged_ask',
      eval_scope: matchedDraft === undefined
        ? ['faithfulness', 'answer_relevancy']
        : ['context_precision', 'context_recall', 'faithfulness', 'answer_relevancy', 'answer_correctness'],
      kb_form: matchedDraft === undefined ? null : scrubDeep(draftEntry(matchedDraft), masker),
      meta: {
        source: 'logged_qa',
        source_kind: 'human_ask',
        line: answer.lines,
        asker: masker.scrub(answer.asker),
        cited_refs: cited.map(item => masker.scrub(item)),
        contexts_are_paths_only: matchedDraft === undefined,
        kb_coverage: /知识库未覆盖|知识库未直接覆盖|没有完全对应的文档/u.test(answer.answer) ? 'miss' : 'hit'
      }
    });
  }

  return {
    samples,
    scrubMap: masker.map(),
    inventory: {
      messages: messages.length,
      drafts: drafts.length,
      tasks: tasks.length,
      reports: reports.length,
      answers: answers.length,
      resolutions: resolutions.size,
      samples: samples.length,
      gold: samples.filter(sample => sample.ground_truth_kind === 'gold').length,
      silver: samples.filter(sample => sample.ground_truth_kind === 'silver').length,
      byFamily: samples.reduce((acc, sample) => {
        acc[sample.family] = (acc[sample.family] ?? 0) + 1;
        return acc;
      }, {})
    }
  };
}

function scrubDeep(value, masker) {
  if (typeof value === 'string') return masker.scrub(value);
  if (Array.isArray(value)) return value.map(item => scrubDeep(item, masker));
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = scrubDeep(item, masker);
    return out;
  }
  return value;
}

export function toJsonl(samples) {
  return samples.map(sample => JSON.stringify(sample)).join('\n') + '\n';
}

const FIXTURE = [
  'avatar',
  '韩子怡',
  '@SPC BCB 用户9641(13718729641)，文件管理功能需要登录 reef MCP 吗？',
  'avatar',
  'SPC BCB',
  '⚠️ 当前知识库未直接覆盖 reef MCP 是否需要登录才能用文件管理。以下是我基于知识库内容的分析：',
  '1) 需要登录',
  'avatar',
  'SPC BCB',
  '📝 KB 草稿 draft-20261010-001',
  '对话上下文窗口满与自动压缩异常的处理',
  '问题描述',
  '长对话进行到一定程度后，上下文窗口已满，自动压缩功能异常，模型无法继续回复。',
  '适用场景',
  '用户在长时间对话后，模型停止响应时。',
  '操作步骤',
  '1) 在输入框发送 /compact 命令，手动触发上下文压缩',
  '2) 若压缩后仍无法恢复，新开一个会话框继续对话',
  '确认: @SPC BCB 确认 draft-20261010-001',
  '拒绝: @SPC BCB 拒绝 draft-20261010-001',
  ' Sophclaw 客户支持日报（2026-10-10）',
  '【总览】',
  '转人工：3 次',
  '【人工处理】',
  '• 上下文窗口满导致无法回复',
  '  自动生成 KB 草稿 1 篇',
  '• draft-20261010-001: 对话上下文窗口满与自动压缩异常的处理',
  '【建议补充知识库】',
  '• 新用户订阅赠送 20 元未到账',
  '重复问题预警',
  'avatar',
  'SPC BCB',
  '🐛 新任务待处理',
  '---',
  '任务 CAo：比特用户魏爽反馈 sophclaw 无法使用：模型设置页面提示「not connected」，点击「重试」无效（孟衍希代报）',
  '受影响用户及电话：魏爽（比特，18833255727）',
  '图片：见下方附件',
  '来源：Appia群聊',
  '知识库相关内容：',
  '【用户操作】',
  '① Sophnet 用户中心检查 Sophclaw 服务是否过期/欠费，过期→订阅续期后重试（kb/user/startup/sophclaw-reconnecting-service-expired）',
  '② 文件管理→openclaw.json 复制 auth.token 填入原生页面「网关令牌」重新连接',
  '【管理员操作】',
  '① 获取用户 moltbot_service_url 打开 OPC 原生页面发消息（kb/admin/config/container-restart）',
  '② 报 401 Unauthorized → 用户 openclaw.json API Key 配置错误',
  '如果知识库内容缺失或不准确，请在本群中直接说明正确的处理步骤，系统将自动收录到知识库。',
  '值班人员： @丁宇涵',
  '处理完成后，请在群内 @SPC BCB 更新任务状态并告知用户结果。例：',
  '@SPC BCB 任务 XXX 已解决，排查结论为：{排查结果}',
  'avatar',
  '丁宇涵',
  '@SPC BCB 任务 CAo 已解决，排查结论为：服务实例异常，Redeploy 后恢复'
];

export function fixtureSource() {
  return FIXTURE.slice();
}

function main(argv) {
  const options = { out: 'eval/ragas-dataset.jsonl', log: '.build/eval-import/records-utf8.txt', stats: false, fixture: false, map: '' };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--log') options.log = argv[++index];
    else if (arg === '--out') options.out = argv[++index];
    else if (arg === '--map') options.map = argv[++index];
    else if (arg === '--stats') options.stats = true;
    else if (arg === '--fixture') options.fixture = true;
    else if (arg === '--help' || arg === '-h') {
      console.log('usage: node scripts/ragas-dataset.mjs [--log <txt>] [--out <jsonl>] [--map <json>] [--stats] [--fixture]');
      return 0;
    } else {
      console.error(`unknown argument: ${arg}`);
      return 2;
    }
  }
  const source = options.fixture ? fixtureSource() : lines(options.log);
  const built = buildSamples(source);
  if (options.stats) {
    console.log(JSON.stringify(built.inventory, undefined, 2));
  }
  if (!options.fixture) {
    mkdirSync(path.dirname(options.out), { recursive: true });
    writeFileSync(options.out, toJsonl(built.samples));
    if (options.map !== '') {
      mkdirSync(path.dirname(options.map), { recursive: true });
      writeFileSync(options.map, JSON.stringify(built.scrubMap, undefined, 2));
    }
    console.log(`wrote ${built.samples.length} samples to ${options.out}`);
  }
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}
