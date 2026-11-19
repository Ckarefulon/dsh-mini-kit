/**
 * The slash command.
 *
 * `/restart` is the human entry point and shares every mechanism with the
 * `restart_dsh` tool; the only difference is the caller. A command is submitted
 * from the composer rather than from inside a turn, so nothing here is
 * mid-execution: every running Session — including the one the command was typed
 * in — can be settled immediately instead of waiting for its turn to end.
 *
 * @module dsh-mini-kit/commands
 */

import { formatRow } from './sessions.js'

/** Command name without the leading slash. */
export const RESTART_COMMAND = 'restart'

/**
 * @param {object} ctx host context
 * @param {object} deps
 * @param {ReturnType<import('./restart.js').createRestarter>} deps.restarter
 * @returns {() => void} disposer for the registration
 */
export function registerCommands(ctx, { restarter }) {
  return ctx.commands.register({
    name: RESTART_COMMAND,
    description: 'Restart DSH and continue the sessions that were running',
    async handler() {
      const result = await restarter.restart({ callerSessionId: null })
      if (!result.ok) return { kind: 'error', text: result.message }
      if (result.rows.length === 0) {
        return { kind: 'success', text: 'Restarting DSH now. No session was running, so nothing will resume.' }
      }
      const lines = result.rows.map((row) => `- ${formatRow(row)}`).join('\n')
      const unsettled =
        result.unsettled.length === 0 ? '' : `\n${result.unsettled.length} session(s) did not stop in time.`
      return {
        kind: 'success',
        text: `Restarting DSH now. These sessions will continue after it reopens:\n${lines}${unsettled}`,
      }
    },
  })
}
