/**
 * `ops_task`: the ops agent's own bookkeeping while it works.
 *
 * These actions change what the administrator sees in the panel and what the
 * requesting customer-service session hears mid-incident. They never execute a
 * cluster change: `propose_change` only files a proposal a human must approve.
 *
 * @module @local/dsh-ops-agent/task-tools
 */

/** Cordis function-plugin name. */
export const name = 'ops-task-tools'

/** Host services required to register the tool. */
export const inject = ['tools']

/** Progress states the ops agent may set without settling the ticket. */
const PROGRESS_STATES = new Set(['diagnosing', 'waiting_info', 'blocked', 'mitigated'])

/**
 * Register `ops_task`.
 *
 * @param ctx - plugin context; the dispatcher is resolved through `ctx.get('opsDispatch')`.
 */
export function apply(ctx) {
  ctx.tools.register(tool(ctx))
}

/** Resolve the dispatcher or fail with an actionable message. */
function dispatcherOf(ctx) {
  const dispatcher = ctx.get?.('opsDispatch')
  if (dispatcher === undefined || dispatcher === null) {
    throw new Error('运维调度器未加载：@local/dsh-ops-agent/dispatcher 没有挂到当前组合上。')
  }
  return dispatcher
}

/** The ops session id that owns the calling tool invocation. */
function sessionOf(exec) {
  const sessionId = exec?.agent?.session?.id
  if (typeof sessionId !== 'string' || sessionId === '') {
    throw new Error('ops_task: 只能从运维会话里调用')
  }
  return sessionId
}

/** `ops_task` definition. */
function tool(ctx) {
  return {
    name: 'ops_task',
    description:
      'Update the incident while you work: set a progress status, ask customer service for missing information, escalate to a human, '
      + 'or file a change proposal. This never changes the cluster. '
      + 'Use propose_change instead of describing a fix only in prose — a proposal is what the administrator can approve.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['set_status', 'ask_requester', 'escalate', 'propose_change'] },
        status: { type: 'string', enum: ['diagnosing', 'waiting_info', 'blocked', 'mitigated'] },
        note: { type: 'string', description: 'One line for the board (set_status / escalate).' },
        question: { type: 'string', description: 'What to ask customer service (ask_requester). Make it answerable.' },
        reason: { type: 'string', description: 'Why you escalate (escalate).' },
        change: {
          type: 'object',
          additionalProperties: false,
          description: 'Required for propose_change.',
          properties: {
            action: { type: 'string', description: 'What must be done, e.g. "raise memory limit".' },
            target: { type: 'string', description: 'Exact object: namespace/workload or config key.' },
            command: { type: 'string', description: 'Copy-pasteable command; the administrator runs it after approval.' },
            impact: { type: 'string', description: 'Blast radius.' },
            rollback: { type: 'string', description: 'How to undo it.' },
            verify: { type: 'string', description: 'How to confirm it worked.' },
          },
          required: ['action', 'target', 'impact', 'rollback', 'verify'],
        },
      },
      required: ['action'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          incidentId: { type: 'string' },
          detail: { type: 'string' },
          proposalId: { type: 'string' },
        },
        required: ['ok', 'incidentId', 'detail'],
      },
      render: (_args, value) => [{
        type: 'text',
        text: `[${value.incidentId}] ${value.detail}${value.proposalId === undefined ? '' : ` (${value.proposalId})`}`,
      }],
    },
    async execute(args, exec) {
      const dispatcher = dispatcherOf(ctx)
      const sessionId = sessionOf(exec)
      const record = dispatcher.getTask(sessionId)
      if (record === undefined) throw new Error('ops_task: 当前会话没有对应的工单记录')
      const action = String(args?.action ?? '')

      if (action === 'set_status') {
        const status = String(args?.status ?? '')
        if (!PROGRESS_STATES.has(status)) {
          throw new Error(`ops_task: set_status 需要 status ∈ ${[...PROGRESS_STATES].join('|')}`)
        }
        await dispatcher.setStatus(sessionId, status, typeof args?.note === 'string' ? args.note : '')
        return { ok: true, incidentId: record.incidentId, detail: `状态更新为 ${status}` }
      }

      if (action === 'ask_requester') {
        const question = requireText(args?.question, 'question')
        await dispatcher.setStatus(sessionId, 'waiting_info', question)
        await dispatcher.askRequester(record.incidentId, question)
        return { ok: true, incidentId: record.incidentId, detail: '已请客服补充信息' }
      }

      if (action === 'escalate') {
        const reason = requireText(args?.reason ?? args?.note, 'reason')
        await dispatcher.setStatus(sessionId, 'blocked', reason)
        await dispatcher.notifyAdmin(`[运维升级] ${record.incidentId}\n${reason}\n运维会话：${sessionId}`)
        return { ok: true, incidentId: record.incidentId, detail: '已升级给人工' }
      }

      if (action === 'propose_change') {
        const result = await dispatcher.proposeChange(sessionId, args?.change ?? {}, { from: 'tool' })
        return {
          ok: true,
          incidentId: record.incidentId,
          detail: `变更提案已提交，等管理员在面板批准（本版本不自动执行）`,
          proposalId: result.id,
        }
      }

      throw new Error(`ops_task: 未知 action ${JSON.stringify(action)}`)
    },
  }
}

/** Require a non-empty string. */
function requireText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`ops_task: ${field} must be a non-empty string`)
  }
  return value.trim()
}
