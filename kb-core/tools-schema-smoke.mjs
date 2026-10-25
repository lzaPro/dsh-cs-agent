/**
 * Schema-conformance test for the model-facing knowledge-base tools.
 *
 * The knowledge-base tools declare a strict output schema
 * (`additionalProperties: false`, because a loosely typed tool result is what
 * makes a model hallucinate). The host validates every tool result against that
 * schema before the model ever sees it, so a field added to `store.search()`
 * but not to the schema turns the tool into a hard runtime error:
 *
 *   tool "kb_search" returned invalid output: "value.hits[0].signals"
 *   is not a declared property (additionalProperties: false)
 *
 * That is exactly what happened when retrieval started returning `signals` and
 * `margin`: retrieval tests call `store.search()` directly, so they all passed
 * while the live agent silently lost the tool. This test drives the real
 * `execute` functions and validates their output against the declared schema.
 *
 * @module @local/dsh-kb/tools-schema-smoke
 */

import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { createKbStore } from './index.js'
import { apply as applyTools } from './tools.js'

const root = await mkdtemp(path.join(tmpdir(), 'kb-tools-schema-'))
const kbDir = path.join(root, 'kb')
await mkdir(kbDir, { recursive: true })

const entry = {
  id: 'schema-disk-full',
  title: '容器写盘报 -122 磁盘配额超限',
  status: 'verified',
  audience: 'customer',
  source: 'shared',
  errorSignatures: ['-122', 'disk quota exceed'],
  services: ['payment-service'],
  environments: ['production'],
  symptom: '上传文件时报错 -122 disk quota exceed。',
  customerReply: '磁盘空间已达上限，清理后可以恢复上传。',
  rootCause: '容器可写层写满，触发配额限制。',
  resolution: '1. 清理容器内临时文件；2. 重启实例。',
  verification: '重新上传成功。',
  tags: ['磁盘', '上传'],
  updated: '2026-10-01',
}
await writeFile(path.join(kbDir, `${entry.id}.json`), `${JSON.stringify(entry, undefined, 2)}\n`)

const store = createKbStore({ kbDir, opsKbDir: path.join(root, 'ops-kb'), dataDir: path.join(root, 'data') })

const registered = []
const ctx = {
  tools: { register: definition => { registered.push(definition) } },
  get: service => (service === 'kbStore' ? store : undefined),
}
applyTools(ctx, { role: 'customer-service' })

let passed = 0
let failed = 0

/**
 * Run one assertion and report it.
 *
 * @param {string} title - assertion title.
 * @param {() => (void | Promise<void>)} body - assertion body.
 */
async function test(title, body) {
  try {
    await body()
    passed += 1
    console.log(`PASS ${title}`)
  } catch (error) {
    failed += 1
    console.log(`FAIL ${title}\n     ${error.message}`)
  }
}

/**
 * Validate a value against the subset of JSON Schema the tools actually use.
 *
 * Deliberately independent of the host validator: this test must fail when the
 * schema and the returned value disagree, no matter which side changed.
 *
 * @param value - value produced by the tool.
 * @param schema - declared schema for that value.
 * @param pathSoFar - JSON pointer-ish path for the error message.
 * @returns {string[]} human-readable violations.
 */
function violationsOf(value, schema, pathSoFar = 'value') {
  const problems = []
  if (schema === undefined || schema === null || value === undefined) return problems

  if (schema.type === 'object') {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return [`${pathSoFar} must be an object, got ${Array.isArray(value) ? 'array' : typeof value}`]
    }
    for (const key of schema.required ?? []) {
      if (value[key] === undefined) problems.push(`${pathSoFar}.${key} is required but missing`)
    }
    const declared = schema.properties ?? {}
    for (const key of Object.keys(value)) {
      if (value[key] === undefined) continue
      if (declared[key] === undefined) {
        if (schema.additionalProperties === false) {
          problems.push(`${pathSoFar}.${key} is not a declared property (additionalProperties: false)`)
        }
        continue
      }
      problems.push(...violationsOf(value[key], declared[key], `${pathSoFar}.${key}`))
    }
    return problems
  }

  if (schema.type === 'array') {
    if (!Array.isArray(value)) return [`${pathSoFar} must be an array`]
    value.forEach((item, index) => {
      problems.push(...violationsOf(item, schema.items, `${pathSoFar}[${index}]`))
    })
    return problems
  }

  if (schema.type === 'integer' && !Number.isInteger(value)) {
    problems.push(`${pathSoFar} must be an integer, got ${typeof value}`)
  } else if (schema.type === 'number' && typeof value !== 'number') {
    problems.push(`${pathSoFar} must be a number, got ${typeof value}`)
  } else if (schema.type === 'string' && typeof value !== 'string') {
    problems.push(`${pathSoFar} must be a string, got ${typeof value}`)
  } else if (schema.type === 'boolean' && typeof value !== 'boolean') {
    problems.push(`${pathSoFar} must be a boolean, got ${typeof value}`)
  }

  if (schema.enum !== undefined && !schema.enum.includes(value)) {
    problems.push(`${pathSoFar} must be one of ${schema.enum.join('/')}, got ${JSON.stringify(value)}`)
  }
  return problems
}

/**
 * Find a registered tool by name, failing loudly when it is absent.
 *
 * @param {string} name - tool name.
 * @returns {object} tool definition.
 */
function toolOf(name) {
  const found = registered.find(item => item.name === name)
  assert.ok(found !== undefined, `tool ${name} was not registered`)
  return found
}

/**
 * Execute a tool and assert its output satisfies its own declared schema.
 *
 * @param {string} name - tool name.
 * @param {object} args - tool arguments.
 * @returns the raw output, so the caller can assert on content.
 */
async function executeAndValidate(name, args) {
  const tool = toolOf(name)
  const output = await tool.execute(args)
  const problems = violationsOf(output, tool.output.schema)
  assert.deepEqual(problems, [], `${name} output violates its declared schema: ${problems.join('; ')}`)
  assert.ok(typeof tool.output.render === 'function', `${name} must declare a renderer`)
  const rendered = tool.output.render(args, output)
  assert.ok(Array.isArray(rendered) && rendered.length > 0, `${name} renderer must return blocks`)
  assert.ok(rendered.every(block => typeof block.text === 'string'), `${name} renderer must return text blocks`)
  return output
}

await test('registers kb_search, kb_get and kb_propose', () => {
  assert.deepEqual(registered.map(item => item.name).sort(), ['kb_get', 'kb_propose', 'kb_search'])
})

await test('kb_search output satisfies its declared schema', async () => {
  const output = await executeAndValidate('kb_search', { query: 'disk quota exceed' })
  assert.equal(output.verdict, 'direct')
  assert.equal(output.hits[0].id, 'schema-disk-full')
})

await test('kb_search schema declares every diagnostic signal the store returns', async () => {
  const output = await executeAndValidate('kb_search', { query: 'disk quota exceed' })
  const schema = toolOf('kb_search').output.schema
  for (const key of Object.keys(output.hits[0].signals)) {
    assert.ok(
      schema.properties.hits.items.properties.signals.properties[key] !== undefined,
      `signal ${key} is returned but not declared in the output schema`,
    )
  }
  assert.equal(typeof output.margin, 'number')
  assert.equal(typeof schema.properties.margin?.type, 'string')
})

await test('kb_search miss output also satisfies the schema', async () => {
  const output = await executeAndValidate('kb_search', { query: '打印机连不上' })
  assert.equal(output.verdict, 'miss')
  assert.ok(output.clarify.length > 0)
})

await test('kb_get output satisfies its declared schema', async () => {
  const found = await executeAndValidate('kb_get', { id: 'schema-disk-full' })
  assert.equal(found.found, true)
  const missing = await executeAndValidate('kb_get', { id: 'no-such-entry' })
  assert.equal(missing.found, false)
})

await test('kb_propose output satisfies its declared schema', async () => {
  const saved = await executeAndValidate('kb_propose', {
    title: '对象存储 403 SignatureDoesNotMatch',
    symptom: '上传时报 403 SignatureDoesNotMatch。',
    resolution: '1. 重新下发临时凭证；2. 客户端重试。',
    errorSignatures: ['SignatureDoesNotMatch'],
    audience: 'ops',
  })
  assert.equal(saved.saved, true)
  const absorbed = await executeAndValidate('kb_propose', {
    title: '重复签名',
    symptom: 'SignatureDoesNotMatch 再次出现。',
    resolution: '重新下发临时凭证。',
    errorSignatures: ['SignatureDoesNotMatch'],
  })
  assert.equal(absorbed.saved, false)
})

await test('the validator catches an undeclared property', () => {
  const schema = toolOf('kb_search').output.schema
  const problems = violationsOf({ verdict: 'miss', hits: [], total: 0, surprise: 1 }, schema)
  assert.equal(problems.length, 1)
  assert.match(problems[0], /surprise is not a declared property/)
})

await test('the validator catches a missing required property', () => {
  const schema = toolOf('kb_search').output.schema
  const problems = violationsOf({ hits: [] }, schema)
  assert.ok(problems.some(problem => problem.includes('verdict is required')))
})

await rm(root, { recursive: true, force: true })
console.log(`\n${passed} passed, ${failed} failed`)
process.exitCode = failed === 0 ? 0 : 1
