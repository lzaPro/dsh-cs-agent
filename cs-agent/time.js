// 时间口径的小工具。
//
// 单独成文件是为了避免 store.js 与 store-pg.js 互相 import 造成循环依赖 ——
// 本地日历日这个东西两边都要用。

/**
 * 本地日历日（YYYY-MM-DD）。
 *
 * 不能用 toISOString().slice(0,10)：那是 UTC 日，东八区凌晨 0-8 点的用量会被
 * 记到前一天，日报对不上。按服务器本地时区算，与值守的人看到的日历一致。
 */
export function localDay(date = new Date()) {
  const pad = value => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/**
 * "最近 N 天"的起始日期（含今天）。
 *
 * 返回 `YYYY-MM-DD`，比日期字符串即可，不需要再做时区运算：定长字符串的
 * 字典序就是时间序。
 *
 * @param {number|undefined} days - 天数；未给或非正数时返回 `undefined`（不过滤）。
 * @param {Date} [now] - 基准时间。
 * @returns {string|undefined} 起始日期。
 */
export function usageWindowStart(days, now = new Date()) {
  if (typeof days !== 'number' || !Number.isFinite(days) || days <= 0) return undefined
  return localDay(new Date(now.getTime() - (Math.floor(days) - 1) * 86_400_000))
}
