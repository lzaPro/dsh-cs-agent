// 审计日志。
//
// 什么算审计：**改变了系统状态、且事后需要回答"是谁干的"** 的操作。目前有两类：
//   - 人工重放死信（把发不出去的回复放回队列）；
//   - 数据清理（保留期到期、按客户删除）。
//
// 普通的客户消息不写这里 —— 那是业务数据（messages 表），审计要的是操作记录。
//
// 两处落点：
//   - json 模式：append 到 `<dataFile 去 .json>-audit.jsonl`，一行一条，只增不改；
//   - postgres 模式：同时插进 `audit_log` 表（该表有 append-only 触发器，改不了也删不掉）。
//
// 文件与表都写，是有意的冗余：jsonl 是"库里挂了也能查"的底稿，表是"能按条件查"的索引。
import { promises as fs } from 'node:fs'
import path from 'node:path'

/** json 模式下的审计文件路径。 */
export function auditFileFor(dataFile) {
  return `${dataFile.replace(/\.json$/i, '')}-audit.jsonl`
}

/**
 * 建一个审计记录器。
 *
 * @param {object} options
 * @param {'json'|'postgres'} [options.kind]
 * @param {string} options.file json 模式必填：jsonl 路径
 * @param {{warn: Function}} [options.logger]
 */
export function createAudit(options = {}) {
  const kind = options.kind ?? 'json'
  const file = options.file
  const logger = options.logger

  if (kind === 'json' && (typeof file !== 'string' || file === '')) {
    throw new Error('audit: json storage needs a file path')
  }

  // 数据库连接懒加载：审计是旁路，不该在网关启动时就去连库。
  let poolPromise

  async function writeJsonl(entry, line) {
    await fs.mkdir(path.dirname(file), { recursive: true })
    // 0600：审计里有操作人和目标 id，不该让同机其他用户读到。
    await fs.appendFile(file, `${line}\n`, { encoding: 'utf8', mode: 0o600 })
  }

  async function writeTable(entry) {
    if (kind !== 'postgres') return
    poolPromise ??= import('./db/pool.mjs').then(module => module.getPool())
    const pool = await poolPromise
    await pool.query(
      `insert into audit_log (actor, role, action, target_type, target_id, target_account, detail, trace_id)
       values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
      [
        entry.actor ?? null,
        entry.role ?? null,
        entry.action,
        entry.targetType ?? null,
        entry.targetId ?? null,
        entry.targetAccount ?? null,
        JSON.stringify(entry.detail ?? {}),
        entry.traceId ?? null,
      ],
    )
  }

  return {
    kind,
    file,
    /**
     * 记一条审计。
     *
     * 返回是否至少落到了一处。审计失败不抛给调用方 —— 操作已经生效了，
     * 因为"记不上账"就把业务回滚掉更糟；但必须告警，否则就是静默丢失。
     */
    async record(entry = {}) {
      if (typeof entry.action !== 'string' || entry.action === '') {
        throw new Error('audit: action is required')
      }
      const record = {
        ...entry,
        at: entry.at ?? new Date().toISOString(),
      }
      const line = JSON.stringify(record)
      let landed = false
      if (kind === 'json') {
        try {
          await writeJsonl(record, line)
          landed = true
        } catch (error) {
          logger?.warn?.(`channel-gateway: audit log write failed: ${error.message}`)
        }
      }
      // 数据库模式下两处都写：jsonl 是底稿，表是查询索引。
      if (kind === 'postgres') {
        try {
          await writeTable(record)
          await writeJsonl(record, line)
          landed = true
        } catch (error) {
          logger?.warn?.(`channel-gateway: audit table write failed: ${error.message}`)
          // 表写不进去时再试一次文件：底稿比索引重要。
          try {
            await writeJsonl(record, line)
            landed = true
          } catch (fileError) {
            logger?.warn?.(`channel-gateway: audit log write failed: ${fileError.message}`)
          }
        }
      }
      return landed
    },
    /** 最近 limit 条，按时间倒序（新→旧）。json 模式读文件，pg 模式读表。 */
    async list(limit = 50) {
      const size = Math.max(1, Math.min(Number(limit) || 50, 500))
      if (kind === 'postgres') {
        poolPromise ??= import('./db/pool.mjs').then(module => module.getPool())
        const pool = await poolPromise
        const { rows } = await pool.query(
          `select actor, role, action, target_type, target_id, detail, trace_id, created_at
             from audit_log order by created_at desc, id desc limit $1`,
          [size],
        )
        return rows.map(row => ({
          actor: row.actor,
          role: row.role,
          action: row.action,
          ...(row.target_type === null ? {} : { targetType: row.target_type }),
          ...(row.target_id === null ? {} : { targetId: row.target_id }),
          detail: row.detail,
          ...(row.trace_id === null ? {} : { traceId: row.trace_id }),
          at: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
        }))
      }
      const text = await fs.readFile(file, 'utf8').catch(error => {
        if (error?.code === 'ENOENT') return ''
        throw error
      })
      const entries = []
      for (const line of text.split('\n')) {
        if (line.trim() === '') continue
        try {
          entries.push(JSON.parse(line))
        } catch {
          // 半行跳过，别让一条坏记录毁掉整份审计。
        }
      }
      return entries.slice(-size).reverse()
    },
  }
}
