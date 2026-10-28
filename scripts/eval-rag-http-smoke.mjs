#!/usr/bin/env node
/**
 * Checks that the retrieval evaluation can actually score a real embedding
 * backend.
 *
 * The script has always advertised `--embedding http`, but only forwarded the
 * backend name: the embedder refuses to start without a baseURL, so the flag
 * threw before measuring anything. A comparison path nobody can run is worse
 * than no comparison path — it reads as evidence that was never collected.
 *
 * These checks pin down both halves: the flags reach the embedder, and a
 * missing or malformed flag fails loudly instead of silently scoring hash
 * vectors while claiming to score a model.
 */

import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const workspace = path.resolve(here, '..')

let passed = 0
let failed = 0

/**
 * Report one check.
 *
 * @param {boolean} ok - whether it held.
 * @param {string} label - what was checked.
 * @param {string} [detail] - extra context on failure.
 */
function check(ok, label, detail) {
  if (ok) {
    passed += 1
    console.log(`PASS ${label}${detail === undefined ? '' : `: ${detail}`}`)
  } else {
    failed += 1
    console.log(`FAIL ${label}${detail === undefined ? '' : `: ${detail}`}`)
  }
}

/**
 * Run the evaluator and collect its streams.
 *
 * @param {string[]} args - arguments after the script path.
 * @returns {Promise<{code: number|null, stdout: string, stderr: string}>} outcome.
 */
function run(args) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [path.join(workspace, 'scripts', 'eval-rag.mjs'), ...args], {
      cwd: workspace,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('close', code => resolve({ code, stdout, stderr }))
  })
}

/**
 * A minimal OpenAI-compatible /embeddings endpoint.
 *
 * Deterministic and dependency-free: the point is to prove the plumbing carries
 * a real vector channel end to end, not to model anything.
 *
 * @param {number} dims - vector width to answer with.
 * @returns {Promise<{server: import('node:http').Server, url: string}>} listening server.
 */
function mockEndpoint(dims) {
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      let input = []
      try {
        ;({ input } = JSON.parse(body === '' ? '{}' : body))
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'bad json' }))
        return
      }
      const texts = Array.isArray(input) ? input : [input]
      const data = texts.map((text, index) => {
        const vector = new Array(dims).fill(0)
        const source = String(text ?? '')
        for (let cursor = 0; cursor < source.length; cursor += 1) {
          vector[(source.charCodeAt(cursor) + cursor) % dims] += 1
        }
        const norm = Math.hypot(...vector) || 1
        return { index, embedding: vector.map(value => value / norm) }
      })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data }))
    })
  })
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve({ server, url: `http://127.0.0.1:${address.port}` })
    })
  })
}

const baseline = await run([])
check(baseline.code === 0, 'the default run still scores the hash backend', `exit ${baseline.code}`)
check(/embedding: hash-512/.test(baseline.stdout), 'the default run reports the hash backend', (baseline.stdout.match(/embedding: \S+/) ?? ['(none)'])[0])

const bare = await run(['--embedding', 'http'])
check(bare.code !== 0, 'asking for http without a base URL fails instead of scoring hash vectors', `exit ${bare.code}`)
check(/baseURL is required/.test(bare.stderr), 'the failure names the missing base URL', (bare.stderr.match(/dsh-kb: [^'\n]*/) ?? ['(none)'])[0])

const badDims = await run(['--embedding', 'http', '--embedding-base-url', 'http://127.0.0.1:9', '--embedding-dims', 'zero'])
check(badDims.code === 2, 'a non-numeric width is rejected before any work', `exit ${badDims.code}`)
check(/--embedding-dims must be a positive number/.test(badDims.stderr), 'the rejection says which flag is wrong')

const { server, url } = await mockEndpoint(64)
try {
  const real = await run([
    '--embedding', 'http',
    '--embedding-base-url', url,
    '--embedding-model', 'mock-64',
    '--embedding-dims', '64',
  ])
  check(real.code === 0, 'a reachable endpoint is scored rather than skipped', `exit ${real.code}`)
  check(/embedding: http:mock-64/.test(real.stdout), 'the report names the model that was actually used', (real.stdout.match(/embedding: \S+/) ?? ['(none)'])[0])
  check(/recall@1/.test(real.stdout), 'the vector run still produces the four metrics')
  // The entry point is the same knowledge base either way, so a working vector
  // channel must not lose the top hit — if it does, the run is measuring noise.
  const recall1 = Number((real.stdout.match(/recall@1 ([\d.]+)%/) ?? [])[1])
  check(recall1 >= 90, 'the vector channel keeps recall@1 within a sane band', `recall@1 ${recall1}%`)
} finally {
  await new Promise(resolve => server.close(resolve))
}

console.log('')
console.log(`${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
