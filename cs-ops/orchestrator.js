/**
 * Ops dispatcher: the component that owns the edge between customer service and
 * operations once they stop being parent and child.
 *
 * It creates one ops root session per incident, feeds it a structured task,
 * waits for the closing JSON block, relays the result back to the requesting
 * session, and turns timeouts or `needs_human` into an admin notification.
 *
 * It is the only component that knows an ops task is in flight, so it is also
 * the only one that can enforce a deadline.
 *
 * @module @local/dsh-cs-agent/orchestrator
 */

import { appendFile, mkdir } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { defaultPaths } from './paths.js'

/** Cordis function-plugin name. */
export const name = 'ops-dispatch'

/** Host services the dispatcher needs. */
export const inject = ['agents', 'agentPresets', 'agentDefaultModel', 'sessionTitle', 'workspaceRegistry']

/** Default deadline for one ops task. */
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000

/** How much assistant text to keep while an ops turn runs. */
const MAX_BUFFERED = 40

/**
 * Register the dispatcher and its session observer.
 * @param ctx - host context.
 * @param config - ops preset, workspace, deadline, and admin notification.
 */
export function apply(ctx, config) {
  const dispatcher = createDispatcher(ctx, config)
  // 客服包的 ops_handoff 通过这个服务找到调度器；没装本包时它拿不到。
  const dispose = ctx.provide('opsDispatch', dispatcher)
  ctx.effect(() => dispose, 'ops-dispatch: service')
  ctx.effect(() => () => dispatcher.dispose(), 'ops-dispatch: lifecycle')
  ctx.effect(() => {
    const off = ctx.on('session/event', (session, event) => dispatcher.observe(session, event))
    return typeof off === 'function' ? off : undefined
  }, 'ops-dispatch: observe')
}

/**
 * Build the dispatcher. Exported for tests.
 * @param ctx - context exposing agents, presets, and events.
 * @param config - deployment configuration.
 */
export function createDispatcher(ctx, config) {
  const opsPreset = requireText(config?.opsPreset ?? 'ops', 'opsPreset')
  const paths = defaultPaths()
  const workspace = requireAbsolute(config?.workspace ?? paths.ops, 'workspace')
  const timeoutMs = Number.isSafeInteger(config?.timeoutMs) && config.timeoutMs > 0
    ? config.timeoutMs
    : DEFAULT_TIMEOUT_MS
  const taskLog = requireAbsolute(config?.taskLog ?? path.join(paths.data, 'ops-tasks.jsonl'), 'taskLog')
  const notifyLog = requireAbsolute(config?.notifyLog ?? path.join(paths.data, 'admin-notify.jsonl'), 'notifyLog')
  const notifyWebhook = typeof config?.notifyWebhook === 'string' && config.notifyWebhook !== ''
    ? config.notifyWebhook
    : undefined
  const adminId = typeof config?.adminId === 'string' && config.adminId !== '' ? config.adminId : undefined
  const fetchImpl = config?.fetch ?? fetch

  /** opsSessionId -> task record. */
  const tasks = new Map()
  /** sessionId -> assistant text of the running turn. */
  const buffers = new Map()

  /** Dispatch one incident to a fresh ops session. */
  async function dispatch({ requesterSessionId, task }) {
    if (typeof requesterSessionId !== 'string' || requesterSessionId === '') {
      throw new Error('ops_handoff needs the requesting session')
    }
    const normalized = normalizeTask(task)
    const incidentId = normalized.incidentId ?? `INC-${stamp()}`
    const opsSessionId = `ops-${randomUUID()}`
    const selection = ctx.agentDefaultModel.currentSelection()
    const handle = await ctx.agents.create({
      sessionId: opsSessionId,
      meta: { cwd: workspace, agentPreset: opsPreset },
      agentOptions: { provider: selection.provider, model: selection.model },
      setup: async (agentCtx) => {
        await ctx.agentPresets.mount(agentCtx, opsPreset)
      },
    })
    ctx.sessionTitle.rename(handle.agent.session, `运维 ${incidentId}`)
    try {
      await mkdir(workspace, { recursive: true })
      const attached = await ctx.workspaceRegistry.create(workspace)
      await attached.setTitle('运维')
      await attached.attachSession(opsSessionId)
    } catch (error) {
      ctx.logger?.warn?.(`ops-dispatch: workspace attach failed: ${error.message}`)
    }

    const record = {
      incidentId,
      opsSessionId,
      requesterSessionId,
      state: 'running',
      startedAt: new Date().toISOString(),
      finishedAt: null,
      task: normalized,
      result: null,
    }
    tasks.set(opsSessionId, record)
    record.timer = setTimeout(() => { void onTimeout(record) }, timeoutMs)

    handle.agent.followup({
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text: renderTask(incidentId, normalized) }],
      source: { kind: 'ops-task', form: 'notice', summary: `ops task ${incidentId}` },
    })

    await recordTask({ ...record, timer: undefined })
    return { incidentId, opsSessionId, state: 'dispatched' }
  }

  /** Buffer assistant text and finish the task on turn end. */
  function observe(session, event) {
    const sessionId = session?.id
    if (typeof sessionId !== 'string') return
    const record = tasks.get(sessionId)
    if (record === undefined) return

    if (event.type === 'assistant/message') {
      const text = textOf(event.data?.message?.content)
      if (text === '') return
      const buffer = buffers.get(sessionId) ?? []
      buffer.push(text)
      buffers.set(sessionId, buffer.slice(-MAX_BUFFERED))
      return
    }

    if (event.type === 'turn/end') {
      const chunks = buffers.get(sessionId)
      buffers.delete(sessionId)
      if (chunks === undefined || chunks.length === 0) return
      void finish(record, chunks.join('\n\n'))
    }
  }

  /** Settle one task from the ops agent's closing message. */
  async function finish(record, text) {
    if (record.state !== 'running') return
    const parsed = parseResult(text)
    const result = parsed ?? {
      status: 'needs_human',
      diagnosis: '运维没有按协议返回结果，以下为原始输出。',
      evidence: [],
      actions_taken: [],
      verification: '',
      customer_summary: '技术同事还在处理，稍后同步。',
      raw: text.slice(0, 2000),
    }
    clearTimeout(record.timer)
    record.state = result.status ?? 'needs_human'
    record.result = result
    record.finishedAt = new Date().toISOString()
    await recordTask({ ...record, timer: undefined })

    if (record.state === 'needs_human') {
      await notifyAdmin(
        `[需要人工] ${record.incidentId}\n${result.diagnosis ?? ''}\n运维会话：${record.opsSessionId}`,
      )
    }
    await relayToRequester(record, result)
  }

  /** Deadline hit: tell the admin, tell customer service, keep the session for follow-up. */
  async function onTimeout(record) {
    if (record.state !== 'running') return
    record.state = 'timeout'
    record.finishedAt = new Date().toISOString()
    await recordTask({ ...record, timer: undefined })
    await notifyAdmin(
      `[超时] ${record.incidentId} 超过 ${Math.round(timeoutMs / 60000)} 分钟没有结论。\n`
      + `运维会话：${record.opsSessionId}`,
    )
    await relayToRequester(record, {
      status: 'timeout',
      diagnosis: '运维处理超时。',
      evidence: [],
      actions_taken: [],
      verification: '',
      customer_summary: '技术同事还在处理，我会继续跟进，有结果第一时间同步。',
    })
  }

  /** Deliver the outcome as a new turn on the requesting session. */
  async function relayToRequester(record, result) {
    let agent = ctx.agents.get(record.requesterSessionId)
    if (agent === undefined) {
      try {
        agent = (await ctx.agents.resume({ resumeSessionId: record.requesterSessionId })).agent
      } catch (error) {
        await notifyAdmin(
          `[回传失败] ${record.incidentId} 的客服会话无法恢复：${error.message}`,
        )
        return
      }
    }
    agent.followup({
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text: renderRelay(record, result) }],
      source: { kind: 'ops-result', form: 'relay' },
    })
  }

  /** Record the task for the dashboard and for post-mortems. */
  async function recordTask(record) {
    if (taskLog === undefined) return
    await mkdir(path.dirname(taskLog), { recursive: true })
    const row = { ...record }
    delete row.timer
    await appendFile(taskLog, `${JSON.stringify(row)}\n`, 'utf8')
  }

  /** Notify the admin without touching the customer channel. */
  async function notifyAdmin(text) {
    if (notifyLog !== undefined) {
      await mkdir(path.dirname(notifyLog), { recursive: true })
      await appendFile(notifyLog, `${JSON.stringify({ at: new Date().toISOString(), text })}\n`, 'utf8')
    }
    if (notifyWebhook !== undefined && adminId !== undefined) {
      try {
        await fetchImpl(notifyWebhook, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ senderId: adminId, groupId: null, text }),
        })
      } catch (error) {
        ctx.logger?.warn?.(`ops-dispatch: admin notification failed: ${error.message}`)
      }
    }
  }

  return {
    dispatch,
    observe,
    notifyAdmin,
    getTask: sessionId => tasks.get(sessionId),
    dispose() {
      for (const record of tasks.values()) clearTimeout(record.timer)
      tasks.clear()
    },
  }
}

/** Render the task card the ops agent receives. */
function renderTask(incidentId, task) {
  const lines = [
    `# 运维任务 ${incidentId}`,
    '',
    `**现象**：${task.symptom}`,
  ]
  if (task.account !== undefined) {
    lines.push('', `**账号信息**：${typeof task.account === 'string' ? task.account : JSON.stringify(task.account)}`)
  }
  if (task.errorSignatures.length > 0) {
    lines.push('', `**错误特征**：${task.errorSignatures.join(' | ')}`)
  }
  if (task.evidence.length > 0) {
    lines.push('', `**已有证据**：`, ...task.evidence.map(item => `- ${item}`))
  }
  if (task.successCriteria.length > 0) {
    lines.push('', `**成功标准**：`, ...task.successCriteria.map(item => `- ${item}`))
  }
  lines.push(
    '',
    '## 约束',
    '',
    '- 你是运维工程师，只做诊断和建议。你无法接触客户，也不要说「我已经回复客户」。',
    '- 只读优先。需要写操作时，说明需要做什么、影响是什么、怎么回滚，不要自行执行。',
    '- 先查证据再下结论。没有证据时明确写「证据不足」。',
    '- 不要输出 Token、密码、完整 Key、Secret。',
    '',
    '## 必须的收尾格式',
    '',
    '最后一条消息必须以一个 ```json 代码块结束，结构如下：',
    '',
    '```json',
    JSON.stringify({
      status: 'resolved | needs_human | need_info | not_found',
      diagnosis: '一句话根因，或「证据不足」',
      evidence: ['时间戳 + 你看到的证据'],
      actions_taken: ['实际执行过的操作；只读诊断就留空数组'],
      verification: '怎么确认恢复的；没恢复就写空字符串',
      customer_summary: '给客服转译用的一句话，不含内部细节',
      need_from_customer: ['还需要客户补充什么'],
    }, undefined, 2),
    '```',
  )
  return lines.join('\n')
}

/** Render the relay message the customer-service session receives. */
function renderRelay(record, result) {
  return [
    `【运维回执】${record.incidentId} → ${result.status}`,
    '',
    `诊断：${result.diagnosis ?? ''}`,
    result.evidence?.length ? `证据：\n${result.evidence.map(item => `- ${item}`).join('\n')}` : '',
    result.actions_taken?.length ? `已执行：\n${result.actions_taken.map(item => `- ${item}`).join('\n')}` : '',
    result.verification ? `验证：${result.verification}` : '',
    result.need_from_customer?.length ? `需要客户补充：${result.need_from_customer.join('、')}` : '',
    '',
    `对客说明（可直接改写后发给客户）：${result.customer_summary ?? ''}`,
    '',
    '请根据以上内容回复客户。不要提及内部会话、Pod 名或集群信息。',
  ].filter(line => line !== '').join('\n')
}

/** Parse the last fenced JSON block of a message. */
export function parseResult(text) {
  const blocks = [...text.matchAll(/```json\s*([\s\S]*?)```/gi)]
  if (blocks.length === 0) return undefined
  try {
    const value = JSON.parse(blocks.at(-1)[1])
    if (value === null || typeof value !== 'object') return undefined
    if (typeof value.status !== 'string') return undefined
    return value
  } catch {
    return undefined
  }
}

/** Join text blocks. */
function textOf(content) {
  if (!Array.isArray(content)) return ''
  return content
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n')
    .trim()
}

/** Normalize the model-supplied task. */
function normalizeTask(task) {
  if (task === null || typeof task !== 'object') throw new Error('ops_handoff: task must be an object')
  const symptom = requireText(task.symptom, 'symptom')
  return {
    symptom,
    incidentId: typeof task.incidentId === 'string' && task.incidentId !== '' ? task.incidentId : undefined,
    account: task.account,
    errorSignatures: stringList(task.errorSignatures),
    evidence: stringList(task.evidence),
    successCriteria: stringList(task.successCriteria),
  }
}

/** Coerce a string list. */
function stringList(value) {
  return Array.isArray(value) ? value.filter(item => typeof item === 'string' && item !== '') : []
}

/** Require a non-empty string. */
function requireText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`ops-dispatch: ${field} must be a non-empty string`)
  }
  return value.trim()
}

/** Require an absolute path. */
function requireAbsolute(value, field) {
  const text = requireText(value, field)
  if (!path.isAbsolute(text)) throw new Error(`ops-dispatch: config.${field} must be absolute`)
  return text
}

/** Compact timestamp for generated incident ids. */
function stamp() {
  return new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
}
