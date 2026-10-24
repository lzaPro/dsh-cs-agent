#!/usr/bin/env node
/**
 * Render one scenario pack into a preset YAML block.
 *
 *   node scripts/render-scenario.mjs --scenario bug-report --kb-dir /path/to/kb
 *
 * The scenario owns the persona and the tool set; the instance owns the paths.
 * Nothing is written back — pipe it somewhere or diff it.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

const args = process.argv.slice(2)
const option = (name) => {
  const index = args.indexOf(`--${name}`)
  return index === -1 ? undefined : args[index + 1]
}

const scenarioId = option('scenario')
if (scenarioId === undefined) {
  console.error('usage: render-scenario.mjs --scenario <id> --kb-dir <path>')
  process.exit(2)
}
const kbDir = option('kb-dir')
if (kbDir === undefined || !kbDir.startsWith('/')) {
  console.error('--kb-dir must be an absolute path')
  process.exit(2)
}

const dir = join(root, 'scenarios', scenarioId)
const meta = JSON.parse(readFileSync(join(dir, 'scenario.json'), 'utf8'))
const preset = readFileSync(join(dir, 'preset.yml'), 'utf8')
const persona = readFileSync(join(dir, 'persona.md'), 'utf8').replace(/\n+$/, '')

// The persona sits under `prefix: |`, which is indented 16 columns.
const personaBlock = persona
  .split('\n')
  .map(line => (line === '' ? '' : `${' '.repeat(16)}${line}`))
  .join('\n')

const rendered = preset
  .replace('{{PERSONA}}', personaBlock)
  .replaceAll('{{KB_DIR}}', kbDir)

const withProduct = rendered.replaceAll('{{PRODUCT}}', meta.product ?? '')

if (withProduct.includes('{{')) {
  const leftover = withProduct.match(/\{\{[A-Z_]+\}\}/g)
  console.error(`unresolved placeholders: ${[...new Set(leftover)].join(', ')}`)
  process.exit(1)
}

process.stdout.write(withProduct)
console.error(`rendered ${meta.id} (${meta.name}) with kbDir=${kbDir}`)
