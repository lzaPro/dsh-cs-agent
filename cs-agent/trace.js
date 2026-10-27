// 请求追踪。
//
// 现实问题：客户说"刚才那条没回"，运维去翻日志，只看到一堆 `channel-gateway: xxx`，
// 分不清哪条日志属于哪条消息。一个请求要跨"受理 → 建会话 → 唤醒模型 → 模型回复 →
// 投递适配器"五段异步流程，中间还有重试，没有 id 就串不起来。
//
// 做法：入站时生成一个短 traceId，用 AsyncLocalStorage 挂在异步上下文上，凡是在这个
// 上下文里打的日志自动带 `[traceId]` 前缀，不需要一路传参。跨进程的边界（审计 jsonl、
// 投递信封、模型消息的 source）显式带上字段。
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'

const storage = new AsyncLocalStorage()

/** 新的追踪 id：12 位十六进制，够用且不会把日志行撑长。 */
export function newTraceId() {
  return randomUUID().replace(/-/g, '').slice(0, 12)
}

/** 当前异步上下文的追踪 id，没有就是 undefined。 */
export function currentTraceId() {
  return storage.getStore()
}

/** 在给定 traceId 的上下文里跑一段异步逻辑。 */
export function withTrace(traceId, run) {
  return storage.run(traceId, run)
}

/** 给日志行加前缀；没有 traceId 时原样返回。 */
export function tracePrefix(traceId = currentTraceId()) {
  return traceId === undefined ? '' : `[${traceId}] `
}
