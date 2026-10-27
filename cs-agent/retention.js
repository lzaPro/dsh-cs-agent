// 数据生命周期：什么时候归档、什么时候清除。
//
// 三种"删除"要分清，混在一起会出事：
//   归档 = 打 archivedAt，从侧边栏消失，映射还在；客户再来消息自动恢复，上下文不丢。
//   清除 = 会话映射 + 消息 + 用量一起删掉，不可逆。
//   停用 = 知识条目 retired，跟会话无关，走 kb 的审核流程。
//
// 这里只算**业务数据**该不该删。DSH 自己那套会话目录（`<dsh>/sessions/<id>`）
// 仍然由 `scripts/retention.mjs` 处理 —— 网关不该去动运行时的存储布局。
//
// 全部逻辑都是纯函数，方便先 dry-run 看清楚会删哪些、再决定要不要真删。
import { localDay } from './time.js'

/** 默认保留期（天）。归档天数 < 清除天数，否则刚归档就被清掉。 */
export const DEFAULT_RETENTION = {
  groupArchiveDays: 3,
  groupPurgeDays: 30,
  privateArchiveDays: 30,
  privatePurgeDays: 90,
}

const DAY_MS = 24 * 60 * 60 * 1000

/** 合并配置：只接受正的整数天，0 表示"不按时间自动处理"。 */
export function retentionLimits(config = {}) {
  const pick = (name, fallback) => {
    const value = Number(config[name])
    return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback
  }
  const limits = {
    groupArchiveDays: pick('groupArchiveDays', DEFAULT_RETENTION.groupArchiveDays),
    groupPurgeDays: pick('groupPurgeDays', DEFAULT_RETENTION.groupPurgeDays),
    privateArchiveDays: pick('privateArchiveDays', DEFAULT_RETENTION.privateArchiveDays),
    privatePurgeDays: pick('privatePurgeDays', DEFAULT_RETENTION.privatePurgeDays),
  }
  // 配置写反了（归档 30 天、清除 3 天）不能默默按字面执行：那样每次跑都会
  // 直接清掉本该先归档的会话。把清除日抬到归档日之后。
  if (limits.groupPurgeDays !== 0 && limits.groupPurgeDays < limits.groupArchiveDays) {
    limits.groupPurgeDays = limits.groupArchiveDays
  }
  if (limits.privatePurgeDays !== 0 && limits.privatePurgeDays < limits.privateArchiveDays) {
    limits.privatePurgeDays = limits.privateArchiveDays
  }
  return limits
}

/** 群聊还是私聊。群聊流失快，保留期短；私聊可能要回溯很久。 */
export function scopeOf(record) {
  return record?.groupId === undefined || record?.groupId === null ? 'private' : 'group'
}

function ageDays(record, now) {
  const last = Date.parse(record?.lastSeenAt ?? record?.createdAt ?? '')
  if (!Number.isFinite(last)) return 0
  return (now.getTime() - last) / DAY_MS
}

/**
 * 算出这一轮该归档哪些、该清除哪些。
 *
 * 规则（按顺序，先归档后清除）：
 *   - 已归档且超过「清除天数」→ 清除；
 *   - 未归档且超过「归档天数」→ 归档；
 *   - `eval` 通道是评测数据，不参与自动处理（否则跑测试会把正在用的会话删掉）。
 *
 * 顺序很重要：同一个会话不能在同一轮既归档又清除，否则审计里会出现
 * "刚归档就被删了"的诡异记录。
 */
export function planRetention(records, options = {}) {
  const now = options.now instanceof Date ? options.now : new Date(options.now ?? Date.now())
  const limits = retentionLimits(options.limits ?? options)
  const archive = []
  const purge = []
  for (const record of records) {
    if (record?.channel === 'eval') continue
    if (typeof record?.key !== 'string' || record.key === '') continue
    const scope = scopeOf(record)
    const archiveDays = scope === 'group' ? limits.groupArchiveDays : limits.privateArchiveDays
    const purgeDays = scope === 'group' ? limits.groupPurgeDays : limits.privatePurgeDays
    const age = ageDays(record, now)
    const archived = record.archivedAt !== undefined && record.archivedAt !== null
    if (purgeDays !== 0 && archived && age >= purgeDays) {
      purge.push({ key: record.key, scope, ageDays: Math.floor(age), archivedAt: record.archivedAt })
      continue
    }
    if (archiveDays !== 0 && !archived && age >= archiveDays) {
      archive.push({ key: record.key, scope, ageDays: Math.floor(age) })
    }
  }
  return { archive, purge, limits, at: now.toISOString() }
}

/**
 * 按客户清除：先列出这个客户名下的会话，再逐个清。
 *
 * 匹配维度就是现有记录真有的那些：`key`（会话键，最精确）、`senderId`（私聊的客户）、
 * `groupId`（群）。**没有租户维度** —— 多租户还没做，假装能按 `tenantId` 过滤
 * 只会让人以为数据隔离已经生效了。
 */
export function planPurgeByOwner(records, owner = {}) {
  const filters = []
  if (owner.key !== undefined) filters.push(record => record.key === owner.key)
  if (owner.senderId !== undefined) filters.push(record => record.senderId === owner.senderId)
  if (owner.groupId !== undefined) filters.push(record => (record.groupId ?? null) === owner.groupId)
  if (filters.length === 0) {
    throw new Error('planPurgeByOwner: provide key, senderId or groupId')
  }
  const matched = []
  for (const record of records) {
    if (typeof record?.key !== 'string' || record.key === '') continue
    if (record.channel === 'eval') continue
    if (!filters.some(match => match(record))) continue
    matched.push({ key: record.key, scope: scopeOf(record), channel: record.channel ?? null })
  }
  return matched
}

/**
 * 解析"自动跑"的配置。
 *
 * 默认**关着**。删数据是不可逆的，所以这件事必须由人明确同意一次：升级一个已有
 * 部署不该在某天早上自己删掉一批历史会话。打开写 `retentionAuto: { enabled: true }`
 * 即可，保留期默认是 `DEFAULT_RETENTION`（群聊 3 天归档/30 天清除，私聊 30/90 天）。
 *
 * 打开之后请确认 `/health` 的 `retention.lastRunAt` 会更新——它是"定时器还活着"的
 * 唯一证据。
 *
 * @param {unknown} option - 插件配置里的 `retentionAuto`。
 * @returns {{enabled: boolean, everyMs: number, initialDelayMs: number, dryRun: boolean}}
 */
export function resolveRetentionAuto(option) {
  const given = option !== null && typeof option === 'object' ? option : {}
  const every = Number(given.everyMs)
  const delay = Number(given.initialDelayMs)
  return {
    enabled: given.enabled === true,
    // 6 小时一次：一天四次，足够"当天清掉"，又不会每小时全表扫一遍。
    everyMs: Number.isFinite(every) && every > 0 ? Math.floor(every) : 6 * 60 * 60 * 1000,
    // 启动后先等一会儿再扫：刚起来时数据库连接池还冷，也不该一起床就先删一波数据。
    initialDelayMs: Number.isFinite(delay) && delay >= 0 ? Math.floor(delay) : 60_000,
    dryRun: given.dryRun === true,
  }
}

/** 把计划变成人能读的一行摘要，日志和审计都用它。 */
export function describePlan(plan) {
  const archive = plan.archive.length
  const purge = plan.purge.length
  if (archive === 0 && purge === 0) return 'nothing to do'
  const parts = []
  if (archive > 0) parts.push(`${archive} to archive`)
  if (purge > 0) parts.push(`${purge} to purge`)
  return parts.join(', ')
}

export { localDay }
