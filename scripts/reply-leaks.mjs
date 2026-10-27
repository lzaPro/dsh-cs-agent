/**
 * 回复泄漏规则：客服回复里不该出现的东西。
 *
 * 为什么单独一个文件：`scripts/eval-cs.mjs` 跑评测时用它判分，`scripts/eval-gate.mjs`
 * 拿它当回归门禁的判据。两份规则各写一遍的后果是——有人往一处加了新规则，另一处
 * 继续放行，于是门禁显示通过而回复里已经在说"插件"。
 *
 * 每条规则是 [标签, 正则]。正则一律带 u 标志、尽量避开大小写歧义。
 */
export const LEAKS = [
  ['实现细节', /DSH|Harness|agent|prompt|token/iu],
  ['知识库编号', /知识库条目|`[a-z][a-z0-9-]{6,}`/u],
  ['检索旁白', /我先查|查一下知识库|查询结果匹配/u],
  ['错误承诺', /我去查|我这边核对|我先确认一下你的实例|我帮你查/u],
  ['平台术语', /插件|扩展|预设|社区/u],
  ['URL', /https?:\/\//u],
]

/**
 * 找出文本命中的泄漏项。
 *
 * @param {string} text - 回复正文。
 * @returns {string[]} 命中的标签，按规则顺序。
 */
export function findLeaks(text) {
  const body = typeof text === 'string' ? text : ''
  return LEAKS.filter(([, pattern]) => pattern.test(body)).map(([label]) => label)
}
