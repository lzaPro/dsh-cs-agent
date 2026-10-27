// 投递重试策略与幂等键。
//
// 单独一个文件是为了让 json 与 postgres 两套队列实现共用同一份策略，同时避免
// outbox.js ↔ outbox-pg.js 循环依赖。
import { shortHash } from './db/pool.mjs'

/** 默认重试策略：2s、8s、32s、2m，共 5 次机会。QQ 被动回复窗口是 5 分钟，够用。 */
export const DEFAULT_RETRY = {
  maxAttempts: 5,
  baseMs: 2000,
  factor: 4,
  maxMs: 120_000,
  /** 单次发送的租约：超时没标结果的条目视为发送者已崩，可以重新领取。 */
  leaseMs: 120_000,
  /** 入队后的宽限期：给调用方留出内联首发的窗口，避免和后台扫描抢同一条。 */
  graceMs: 2000,
  /** 后台扫描间隔。 */
  sweepMs: 5000,
  /** 给重试加 20% 抖动，避免所有实例同一毫秒重发。测试里关掉。 */
  jitter: true,
}

/** 第 n 次失败之后该等多久。n 从 1 开始。 */
export function retryDelay(attempts, retry = DEFAULT_RETRY, random = Math.random) {
  const settings = { ...DEFAULT_RETRY, ...retry }
  const raw = settings.baseMs * settings.factor ** Math.max(0, attempts - 1)
  const capped = Math.min(raw, settings.maxMs)
  if (!settings.jitter) return capped
  return Math.round(capped * (0.8 + random() * 0.4))
}

/**
 * 幂等键：同样的内容在同一个时间点只应该发一次。
 *
 * 用内容 + 入队时刻算，所以"同一条回复被重复入队"（比如进程重启后回放）会命中
 * 同一个键；而客户先后两条相同的"好的"因为时刻不同，仍然是两条。
 */
export function outboxKey(envelope) {
  return shortHash([
    envelope.key ?? '',
    envelope.channel ?? '',
    envelope.at ?? '',
    envelope.text ?? '',
    envelope.mention ?? '',
  ].join('\u0000'))
}
