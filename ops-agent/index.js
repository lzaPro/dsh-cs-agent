/**
 * Host half of the ops-agent UI package.
 *
 * The browser half (`./client.js`, declared through `dsh.client` in
 * package.json) registers the settings section, the session-header approval
 * badge, and the sidebar mark. The host side has nothing to register: the
 * panel route belongs to `./panel.js` and the dispatcher to `./dispatcher.js`.
 *
 * This module exists so the package has a Loader row named exactly
 * `@local/dsh-ops-agent`. Client-module scanning only resolves browser code
 * for a Loader entry whose name is a bare package specifier (not a subpath),
 * so without this row the whole UI stays invisible in the Web shell.
 *
 * @module @local/dsh-ops-agent
 */

/** Cordis function-plugin name. */
export const name = 'ops-agent-ui'

/** Nothing to provide, inject, or dispose. */
export function apply() {}
