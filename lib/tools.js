/**
 * The two model-facing tools.
 *
 * Both descriptions are one line on purpose. Each tool answers one question and
 * returns plain text, so nothing else has to be said: no parameter rules (they
 * take none), no output format to learn, and no caveat the model could not read
 * off the result itself.
 *
 * @module dsh-mini-kit/tools
 */

import { formatRow } from './sessions.js'

/** Every tool here returns one rendered string, declared once. */
const textOutput = {
  schema: { type: 'string' },
  /**
   * @param {unknown} _args
   * @param {string} value
   * @returns {Array<{ type: 'text', text: string }>}
   */
  render(_args, value) {
    return [{ type: 'text', text: value }]
  },
}

/** No tool here accepts arguments, and the schema says so rather than accepting junk. */
const noParameters = { type: 'object', properties: {}, additionalProperties: false }

/**
 * @param {object} ctx host context
 * @param {object} deps
 * @param {ReturnType<import('./sessions.js').createSessionIndex>} deps.index
 * @param {ReturnType<import('./restart.js').createRestarter>} deps.restarter
 * @returns {() => void} disposer for both registrations
 */
export function registerTools(ctx, { index, restarter }) {
  const listRunning = ctx.tools.register({
    name: 'list_running_sessions',
    description: 'List the sessions running a turn right now, as workspace / session title.',
    parameters: noParameters,
    output: textOutput,
    async execute(_args, exec) {
      exec?.signal?.throwIfAborted?.()
      const rows = index.runningUserRows()
      if (rows.length === 0) return 'No session is running a turn right now.'
      return `${rows.length} running session(s):\n${rows.map((row) => `- ${formatRow(row)}`).join('\n')}`
    },
  })

  const restart = ctx.tools.register({
    name: 'restart_dsh',
    description: 'Restart the DSH app; the sessions running now continue after it reopens.',
    parameters: noParameters,
    output: textOutput,
    async execute(_args, exec) {
      const result = await restarter.restart({ callerSessionId: exec?.agent?.id ?? null })
      return result.message
    },
  })

  return () => {
    try {
      restart()
    } catch {
      // A registration already torn down by its fiber is not an error here.
    }
    try {
      listRunning()
    } catch {
      // See above.
    }
  }
}
