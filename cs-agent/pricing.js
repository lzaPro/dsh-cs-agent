/**
 * 用量换算成钱。
 *
 * 这块单独成文件、且全是纯函数，原因很实际：**价格是一份配置，不是一份代码**。
 * 换模型、换供应商、谈下折扣，改的都是这一处配置，而"怎么算"这件事不该跟着变。
 *
 * 单位：
 * - 配置里写的是 **每 100 万 token 的美元价**（模型报价单就是这么写的，直接抄）。
 * - 存进数据库的是 **micro-USD 整数**（1e-6 美元）。用整数是因为浮点累加会漂：
 *   一千次 0.0000004 加起来的误差足以让对账差出几分钱。
 * - 换算关系恰好很整齐：`tokens × (USD / 1e6) × 1e6 = tokens × USD`，
 *   所以 `micros = round(tokens × pricePerMillion)`，不需要额外除法。
 *
 * 缓存读/写的单价可以单独配。没配时按输入价算 —— 这是个**偏保守**的假设
 * （缓存读实际比输入便宜很多），宁可高估成本，也不要给老板一个偏低的数字。
 */

/** 没配价格时的空配置：所有成本都是 0，`/usage` 会明确说有配置才能算钱。 */
export const EMPTY_PRICING = { currency: 'USD', models: {} }

/**
 * 校验并归一化价格配置。
 *
 * 配置写错（负价、字符串、拼错字段）必须**在启动时报错**，而不是算出一堆 0
 * 让成本长期偏小——那种错误没人会发现。
 *
 * @param {unknown} config - 来自 cordis patch 的 `pricing` 配置。
 * @returns {{currency: string, models: Record<string, {input: number, output: number, cacheRead: number, cacheWrite: number}>}}
 * @throws {Error} 配置非法时抛出，消息里带具体模型与字段。
 */
export function parsePricing(config) {
  if (config === undefined || config === null) return EMPTY_PRICING
  if (typeof config !== 'object' || Array.isArray(config)) {
    throw new Error(`pricing: expected an object, got ${Array.isArray(config) ? 'array' : typeof config}`)
  }
  const currency = config.currency ?? 'USD'
  if (typeof currency !== 'string' || currency === '') {
    throw new Error(`pricing: currency must be a non-empty string, got ${JSON.stringify(currency)}`)
  }
  const models = config.models ?? {}
  if (typeof models !== 'object' || Array.isArray(models)) {
    throw new Error(`pricing: models must be an object keyed by model id, got ${Array.isArray(models) ? 'array' : typeof models}`)
  }
  const normalized = {}
  for (const [model, price] of Object.entries(models)) {
    if (price === null || typeof price !== 'object' || Array.isArray(price)) {
      throw new Error(`pricing: the price for model "${model}" must be an object with input/output`)
    }
    const read = name => {
      const value = price[name]
      if (value === undefined) return undefined
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        throw new Error(`pricing: "${name}" for model "${model}" must be a non-negative number, got ${JSON.stringify(value)}`)
      }
      return value
    }
    const input = read('input')
    const output = read('output')
    if (input === undefined && output === undefined) {
      throw new Error(`pricing: model "${model}" needs at least an "input" or "output" price`)
    }
    const base = input ?? output ?? 0
    normalized[model] = {
      input: input ?? 0,
      output: output ?? input ?? 0,
      // 没单独配缓存价就按输入价，宁可高估。
      cacheRead: read('cacheRead') ?? base,
      cacheWrite: read('cacheWrite') ?? base,
    }
  }
  return { currency, models: normalized }
}

/**
 * 挑出某个模型该用哪一行价格。
 *
 * 顺序：精确匹配 → 最长前缀匹配（供应商常给 `deepseek-chat-2024-08` 这类号）→ `*` 兜底。
 * 返回 `undefined` 表示没有可用价格，调用方应当把成本记 0 而不是猜。
 *
 * @param {object} pricing - `parsePricing` 的返回值。
 * @param {string|undefined} model - 事件里带回来的模型 id。
 * @returns {{input: number, output: number, cacheRead: number, cacheWrite: number}|undefined} 命中的价格行。
 */
export function priceFor(pricing, model) {
  const models = pricing?.models ?? {}
  if (typeof model === 'string' && model !== '') {
    if (models[model] !== undefined) return models[model]
    let best
    for (const key of Object.keys(models)) {
      if (key === '*' || key.includes('*')) continue
      if (model.startsWith(key) && (best === undefined || key.length > best.length)) best = key
    }
    if (best !== undefined) return models[best]
  }
  return models['*']
}

/**
 * 把一次调用的用量折成 micro-USD。
 *
 * @param {{inputTokens?: number, outputTokens?: number, cacheReadTokens?: number, cacheWriteTokens?: number}} usage - 事件里的用量。
 * @param {{input: number, output: number, cacheRead: number, cacheWrite: number}|undefined} price - `priceFor` 的结果。
 * @returns {number} micro-USD 整数；没有价格时为 0。
 */
export function costMicros(usage, price) {
  if (price === undefined) return 0
  const micros =
    (usage?.inputTokens ?? 0) * price.input +
    (usage?.outputTokens ?? 0) * price.output +
    (usage?.cacheReadTokens ?? 0) * price.cacheRead +
    (usage?.cacheWriteTokens ?? 0) * price.cacheWrite
  if (!Number.isFinite(micros)) return 0
  return Math.round(micros)
}

/**
 * 配置里有没有任何一行真的能算钱。
 *
 * 全 0 的价格表算"没配"——否则报表上会出现一堆 `$0.00`，看起来像算过了。
 *
 * @param {object} pricing - `parsePricing` 的返回值。
 * @returns {boolean} 至少一行有非零单价时为真。
 */
export function pricingReady(pricing) {
  for (const price of Object.values(pricing?.models ?? {})) {
    if (price.input > 0 || price.output > 0 || price.cacheRead > 0 || price.cacheWrite > 0) return true
  }
  return false
}

/**
 * 把 micro-USD 显示成人看的样子。
 *
 * 小额（不到 1 分）保留 4 位，否则只看得到 `$0.00`，等于没显示。
 *
 * @param {number} micros - micro-USD 整数。
 * @param {string} [currency] - 货币符号前的标记，默认 `$`。
 * @returns {string} 形如 `$0.0123`、`$1.20`。
 */
export function formatCost(micros, currency = '$') {
  const value = (micros ?? 0) / 1e6
  if (value === 0) return `${currency}0.00`
  if (Math.abs(value) < 0.01) return `${currency}${value.toFixed(4)}`
  return `${currency}${value.toFixed(2)}`
}
