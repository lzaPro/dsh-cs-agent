/**
 * Load `.env.local` (then `.env`) beside this module before anything reads
 * process.env. Real environment variables always win, so a shell export can
 * override the file for one run.
 *
 * Written as an import side effect: place `import './env.js'` first.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const explicit = process.env.ENV_FILE
const candidates = explicit !== undefined && explicit !== ''
  ? [explicit]
  : [join(here, '.env.local'), join(here, '.env')]

for (const file of candidates) {
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') continue
    throw error
  }
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(trimmed)
    if (match === null) continue
    const key = match[1]
    let value = match[2].trim()
    if (value.length >= 2
      && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1)
    }
    if (process.env[key] === undefined) process.env[key] = value
  }
}
