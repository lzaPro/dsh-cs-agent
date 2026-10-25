/**
 * `ops_handoff`: the customer-service agent's only way to reach operations.
 *
 * Mount this inside the customer-service preset, never in the ops preset — the
 * ops agent must not be able to dispatch work to itself.
 *
 * @module @local/dsh-cs-agent/handoff
 */

/** Cordis function-plugin name. */
export const name = 'ops-handoff'

/** Host services required to register the tool. */
export const inject = ['tools']

/** Register the handoff tool. */
export function apply(ctx) {
  ctx.tools.register({
    name: 'ops_handoff',
    description:
      'Hand an incident to the operations agent when answering needs cluster or backend access you do not have: '
      + 'looking at pods, logs, events, database records, or account state. '
      + 'Do NOT use it for questions the knowledge base already answers, and do not use it before searching. '
      + 'Returns immediately with an incident id; the operations verdict arrives later as a new message.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        symptom: {
          type: 'string',
          description: 'What the customer observes, in one or two concrete sentences.',
        },
        account: {
          type: 'string',
          description: 'The customer identifier needed for lookup (phone, email, org id, or pool id). Omit if unknown.',
        },
        errorSignatures: {
          type: 'array',
          items: { type: 'string' },
          description: 'Exact error strings, codes, or keywords from the customer.',
        },
        evidence: {
          type: 'array',
          items: { type: 'string' },
          description: 'What has already been tried or observed, including knowledge-base ids checked.',
        },
        successCriteria: {
          type: 'array',
          items: { type: 'string' },
          description: 'What a useful verdict must contain, e.g. "root cause with evidence" or "confirm the pod is healthy".',
        },
        incidentId: {
          type: 'string',
          description: 'Optional existing incident id to keep the thread aligned.',
        },
      },
      required: ['symptom'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          incidentId: { type: 'string' },
          opsSessionId: { type: 'string' },
          state: { type: 'string' },
        },
        required: ['incidentId', 'opsSessionId', 'state'],
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.state === 'disabled'
          ? 'Operations collaboration is currently switched off by the administrator. '
            + 'Handle this yourself with the knowledge base; do not tell the customer about any limitation '
            + 'and do not promise an escalation.'
          : `Dispatched to operations as ${value.incidentId}. The verdict will arrive as a new message; `
            + 'tell the customer it has been escalated and that you will follow up.',
      }],
    },
    async execute(args, exec) {
      const requester = exec.agent?.session?.id
      if (typeof requester !== 'string' || requester === '') {
        throw new Error('ops_handoff must be called by an agent session')
      }
      // 运维是可选的独立插件；没装时给出明确提示，而不是静默失败。
      const dispatcher = ctx.get?.('opsDispatch')
      if (dispatcher === undefined) {
        throw new Error('运维插件未安装：请先安装 @local/dsh-ops-agent 后再转运维。')
      }
      // 管理员在运维面板关掉协同后，客服必须能独立跑完——这里返回一个结构化结果，
      // 而不是抛错，免得客服把这个当作故障去盘查。
      if (typeof dispatcher.isEnabled === 'function' && dispatcher.isEnabled() === false) {
        return { incidentId: '', opsSessionId: '', state: 'disabled' }
      }
      return dispatcher.dispatch({ requesterSessionId: requester, task: args })
    },
  })
}
