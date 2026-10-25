/**
 * Tests for scripts/kb-review.mjs: the human half of the candidate loop.
 *
 * Each case builds a throwaway knowledge base and runs the CLI as a child
 * process, so the assertions cover the real argv parsing and output.
 *
 *   node kb-review-smoke.mjs
 */

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const here = path.dirname(fileURLToPath(import.meta.url))
const cli = path.join(here, 'kb-review.mjs')

let failed = 0
let passed = 0

/**
 * Record one assertion block.
 *
 * @param {string} name - test label.
 * @param {() => Promise<void>} body - assertions.
 * @returns {Promise<void>} resolves after recording the result.
 */
async function test(name, body) {
  try {
    await body()
    passed += 1
    console.log(`PASS ${name}`)
  } catch (error) {
    failed += 1
    console.log(`FAIL ${name}: ${error.message}`)
  }
}

/**
 * Create a knowledge base with one entry and one pending candidate.
 *
 * @returns {Promise<{root: string, kb: string, opsKb: string, data: string}>} paths.
 */
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-review-'))
  const kb = path.join(root, 'kb')
  const opsKb = path.join(root, 'ops-kb')
  const data = path.join(root, 'data')
  await fs.mkdir(path.join(kb, '_candidates'), { recursive: true })
  await fs.mkdir(opsKb, { recursive: true })
  await fs.writeFile(path.join(kb, 'dialog-stuck.json'), `${JSON.stringify({
    id: 'dialog-stuck',
    title: '对话没反应',
    status: 'verified',
    audience: 'customer',
    errorSignatures: ['对话没反应'],
    services: ['chat'],
    environments: ['saas'],
    symptom: '客户发消息后一直转圈。',
    customerReply: '已经收到，正在处理。',
    rootCause: '容器卡住。',
    resolution: '重启容器。',
    verification: '客户能收到回复。',
    tags: [],
    updated: '2026-10-01',
  }, undefined, 2)}\n`)
  await fs.writeFile(path.join(kb, '_candidates', 'candidate-1.json'), `${JSON.stringify({
    id: 'candidate-1',
    title: '导出 PDF 乱码',
    audience: 'customer',
    errorSignatures: ['PDF 乱码'],
    services: ['chat'],
    environments: ['saas'],
    symptom: '导出 PDF 后中文变成方块。',
    customerReply: '换个字体再导出。',
    rootCause: '字体缺失。',
    resolution: '安装中文字体。',
    verification: '导出正常。',
    tags: [],
    updated: '2026-10-20',
  }, undefined, 2)}\n`)
  return { root, kb, opsKb, data }
}

/**
 * Run the CLI against a fixture.
 *
 * @param {{kb: string, opsKb: string, data: string}} paths - fixture paths.
 * @param {string[]} argv - CLI arguments.
 * @returns {Promise<{stdout: string, stderr: string}>} output.
 */
function review(paths, argv) {
  return run(process.execPath, [cli, ...argv, '--kb', paths.kb, '--ops-kb', paths.opsKb, '--data-dir', paths.data])
}

await test('list shows the pending candidate', async () => {
  const paths = await fixture()
  const { stdout } = await review(paths, ['list'])
  assert.match(stdout, /1 个待审核候选/)
  assert.match(stdout, /candidate-1/)
  await fs.rm(paths.root, { recursive: true, force: true })
})

await test('show prints the full candidate body', async () => {
  const paths = await fixture()
  const { stdout } = await review(paths, ['show', 'candidate-1'])
  assert.match(stdout, /导出 PDF 乱码/)
  assert.match(stdout, /字体缺失/)
  await fs.rm(paths.root, { recursive: true, force: true })
})

await test('verify moves the candidate into the shared set', async () => {
  const paths = await fixture()
  const { stdout } = await review(paths, ['verify', 'candidate-1'])
  assert.match(stdout, /已入库/)
  const files = await fs.readdir(paths.kb)
  assert.ok(files.includes('candidate-1.json'))
  const pending = await fs.readdir(path.join(paths.kb, '_candidates'))
  assert.equal(pending.includes('candidate-1.json'), false)
  const saved = JSON.parse(await fs.readFile(path.join(paths.kb, 'candidate-1.json'), 'utf8'))
  assert.equal(saved.status, 'verified')
  assert.equal(saved.audience, 'customer')
  await fs.rm(paths.root, { recursive: true, force: true })
})

await test('verify --internal lands in the ops runbook', async () => {
  const paths = await fixture()
  await review(paths, ['verify', 'candidate-1', '--internal'])
  const files = await fs.readdir(paths.opsKb)
  assert.ok(files.includes('candidate-1.json'))
  await fs.rm(paths.root, { recursive: true, force: true })
})

await test('reject keeps a reason and leaves the queue', async () => {
  const paths = await fixture()
  const { stdout } = await review(paths, ['reject', 'candidate-1', '--reason', '只是字体问题'])
  assert.match(stdout, /已丢弃/)
  const rejected = await fs.readdir(path.join(paths.kb, '_candidates', '_rejected'))
  assert.ok(rejected.includes('candidate-1.json'))
  const pending = await fs.readdir(path.join(paths.kb, '_candidates'))
  assert.equal(pending.includes('candidate-1.json'), false)
  await fs.rm(paths.root, { recursive: true, force: true })
})

await test('reject refuses to run without a reason', async () => {
  const paths = await fixture()
  await assert.rejects(review(paths, ['reject', 'candidate-1']), /--reason/)
  await fs.rm(paths.root, { recursive: true, force: true })
})

await test('expire marks the entry deprecated in place', async () => {
  const paths = await fixture()
  const { stdout } = await review(paths, ['expire', 'dialog-stuck', '--reason', '已由新版本修复'])
  assert.match(stdout, /已标记失效/)
  const saved = JSON.parse(await fs.readFile(path.join(paths.kb, 'dialog-stuck.json'), 'utf8'))
  assert.equal(saved.status, 'deprecated')
  assert.equal(saved.deprecatedReason, '已由新版本修复')
  await fs.rm(paths.root, { recursive: true, force: true })
})

await test('expire records the replacement entry', async () => {
  const paths = await fixture()
  await review(paths, ['expire', 'dialog-stuck', '--reason', '拆成两条', '--superseded-by', 'dialog-timeout'])
  const saved = JSON.parse(await fs.readFile(path.join(paths.kb, 'dialog-stuck.json'), 'utf8'))
  assert.equal(saved.supersededBy, 'dialog-timeout')
  await fs.rm(paths.root, { recursive: true, force: true })
})

await test('stats counts both sets and the queue', async () => {
  const paths = await fixture()
  const { stdout } = await review(paths, ['stats'])
  assert.match(stdout, /共享条目 1/)
  assert.match(stdout, /待审核 1/)
  assert.match(stdout, /hash-512/)
  await fs.rm(paths.root, { recursive: true, force: true })
})

await test('duplicates only reports real overlap', async () => {
  const paths = await fixture()
  const quiet = await review(paths, ['duplicates'])
  assert.match(quiet.stdout, /没有发现签名高度重合/)
  await fs.writeFile(path.join(paths.kb, 'dialog-stuck-2.json'), `${JSON.stringify({
    id: 'dialog-stuck-2',
    title: '又是没反应',
    status: 'verified',
    audience: 'customer',
    errorSignatures: ['对话没反应'],
    services: ['chat'],
    environments: ['saas'],
    symptom: '一直转圈。',
    customerReply: '处理中。',
    resolution: '重启。',
    verification: 'ok',
    tags: [],
    updated: '2026-10-21',
  }, undefined, 2)}\n`)
  const loud = await review(paths, ['duplicates'])
  assert.match(loud.stdout, /dialog-stuck-2/)
  assert.match(loud.stdout, /--superseded-by/)
  await fs.rm(paths.root, { recursive: true, force: true })
})

await test('unknown command prints usage', async () => {
  const paths = await fixture()
  await assert.rejects(review(paths, ['bogus']), /未知命令/)
  await fs.rm(paths.root, { recursive: true, force: true })
})

console.log('')
console.log(`${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
