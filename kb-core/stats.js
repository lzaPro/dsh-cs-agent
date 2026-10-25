/**
 * Usage ledger: how often an entry was reported, and how often it was served.
 *
 * Two counters, both keyed by entry id:
 *
 * - `occurrences` — the same signature came in again. A recurring incident is
 *   more likely to be the right answer next time, so it gets a small ranking
 *   prior and shows up first among equals.
 * - `served` — the entry was actually read by an agent, which is the closest
 *   offline proxy for "this answer worked".
 *
 * The ledger is runtime data, not knowledge: it lives next to the gateway's
 * other ledgers under `data/`, so the knowledge files stay hand-editable and
 * diffable. Writes are serialized in-process and applied with write-then-rename
 * so a crash cannot leave a truncated file.
 *
 * @module @local/dsh-kb/stats
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'

/** Shape of one ledger record. */
const EMPTY = { occurrences: 0, served: 0 }

/**
 * Create a ledger bound to one file. Missing file = empty ledger.
 *
 * @param {string|undefined} file - absolute path, or undefined to disable persistence.
 * @returns {object} ledger with `occurrences()`, `record(id, kind)`, `snapshot()`.
 */
export function createLedger(file) {
  let cache = null
  let chain = Promise.resolve()

  /** Read once, tolerate a missing or corrupt file. */
  async function read() {
    if (cache !== null) return cache
    cache = {}
    if (file === undefined) return cache
    try {
      const raw = JSON.parse(await fs.readFile(file, 'utf8'))
      for (const [id, value] of Object.entries(raw)) {
        if (typeof value === 'object' && value !== null) {
          cache[id] = {
            occurrences: Number(value.occurrences) || 0,
            served: Number(value.served) || 0,
            lastSeen: typeof value.lastSeen === 'string' ? value.lastSeen : undefined,
          }
        }
      }
    } catch {
      // A corrupt ledger is not fatal: counters restart, answers do not change.
    }
    return cache
  }

  let warned = false

  /** Persist the current cache. A read-only data directory must not break search. */
  async function flush() {
    if (file === undefined || cache === null) return
    try {
      await fs.mkdir(path.dirname(file), { recursive: true })
      const temporary = `${file}.${process.pid}.tmp`
      await fs.writeFile(temporary, JSON.stringify(cache, undefined, 2), 'utf8')
      await fs.rename(temporary, file)
    } catch (error) {
      if (!warned) {
        warned = true
        process.emitWarning(`dsh-kb: cannot persist the usage ledger at ${file} (${error.message}); counters stay in memory`)
      }
    }
  }

  /** Serialize mutations so two concurrent tool calls cannot lose a count. */
  function mutate(work) {
    chain = chain.then(work, work)
    return chain
  }

  return {
    /**
     * Entry id → occurrence count, for the ranking prior.
     *
     * @returns {Promise<Map<string, number>>} counts.
     */
    async occurrences() {
      const data = await read()
      return new Map(Object.entries(data).map(([id, value]) => [id, value.occurrences]))
    },

    /**
     * Count one event against an entry.
     *
     * @param {string} id - entry id.
     * @param {'occurrence'|'served'} kind - which counter.
     * @returns {Promise<{occurrences: number, served: number}>} updated counts.
     */
    async record(id, kind) {
      return mutate(async () => {
        const data = await read()
        const current = data[id] ?? { ...EMPTY }
        if (kind === 'served') current.served += 1
        else current.occurrences += 1
        current.lastSeen = new Date().toISOString()
        data[id] = current
        await flush()
        return { occurrences: current.occurrences, served: current.served }
      })
    },

    /**
     * Full ledger copy, for reports and the review CLI.
     *
     * @returns {Promise<object>} id → counts.
     */
    async snapshot() {
      const data = await read()
      return JSON.parse(JSON.stringify(data))
    },
  }
}
