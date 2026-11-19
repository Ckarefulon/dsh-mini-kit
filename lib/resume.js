/**
 * The other half of a restart: picking the interrupted Sessions back up.
 *
 * This runs in a *fresh* Host process, so everything it needs has to come from
 * the marker file — it cannot remember what the previous generation was doing.
 *
 * Two rules shape it:
 *
 *   - **Claim before acting.** The marker is renamed at the start, so a resume
 *     that fails cannot make the next launch restart itself again. One bad
 *     Session costs one missing prompt, never a boot loop.
 *   - **Wait for a Host that can answer.** A plugin activates long before the
 *     rest of the tree is ready, so resuming is deferred and retried rather than
 *     attempted once against a controller that is still wiring itself up.
 *
 * @module dsh-mini-kit/resume
 */

/** @param {number} ms */
const sleep = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

/**
 * @param {object} deps
 * @param {object} deps.ctx host context
 * @param {any} deps.config resolved plugin config
 * @param {ReturnType<import('./marker.js').createMarker>} deps.marker
 * @param {ReturnType<import('./sessions.js').createSessionIndex>} deps.index
 * @param {{ info?: Function, warn?: Function }} [deps.logger]
 */
export function createResumer({ ctx, config, marker, index, logger }) {
  const log = {
    /** @param {...unknown} parts */
    info(...parts) {
      try {
        logger?.info?.(...parts)
      } catch {
        // Logging is never the point.
      }
    },
    /** @param {...unknown} parts */
    warn(...parts) {
      try {
        logger?.warn?.(...parts)
      } catch {
        // See above.
      }
    },
  }

  /**
   * Resolve a Session to a live Agent, retrying while the Host finishes booting.
   *
   * @param {string} sessionId
   * @param {number} attempts
   * @returns {Promise<any | null>}
   */
  async function resolve(sessionId, attempts = 5) {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const live = index.agentOf(sessionId)
      if (live !== undefined) return live
      const controller = index.service('sessionController')
      if (controller?.resolveAgent !== undefined) {
        try {
          const result = await controller.resolveAgent(sessionId)
          if (result?.agent !== undefined) return result.agent
          const code = result?.error?.code
          // `session/agent-busy` means the browser half resumed it first, which is
          // a success from here; anything else may be a controller that is not
          // ready yet, so it is worth one more look.
          if (code === 'session/agent-busy') return index.agentOf(sessionId) ?? null
        } catch {
          // Fall through to the retry delay.
        }
      }
      await sleep(1200)
    }
    return index.agentOf(sessionId) ?? null
  }

  /**
   * Hand one Session its continuation prompt.
   *
   * @param {{ id: string, title: string | null, workspace: string | null }} entry
   * @returns {Promise<boolean>}
   */
  async function resumeOne(entry) {
    const agent = await resolve(entry.id)
    if (agent === null) {
      log.warn('resume: session could not be resolved', entry.id)
      return false
    }
    if (typeof agent.followup !== 'function') {
      log.warn('resume: agent cannot accept a follow-up', entry.id)
      return false
    }
    try {
      agent.followup({
        content: [{ type: 'text', text: config.resumePrompt }],
        source: { kind: 'dsh-mini-kit' },
      })
      log.info('resume: continued', entry.id, entry.title ?? '')
      return true
    } catch (error) {
      log.warn('resume: follow-up rejected', entry.id, error?.message ?? String(error))
      return false
    }
  }

  /**
   * Claim the marker and resume what it names.
   *
   * @returns {Promise<{ resumed: number, skipped: number }>}
   */
  async function resumePending() {
    const entry = marker.claim()
    if (entry === null) return { resumed: 0, skipped: 0 }
    if (entry.sessions.length === 0) return { resumed: 0, skipped: 0 }
    log.info('resume: marker claimed', { count: entry.sessions.length, createdAt: entry.createdAt })
    let resumed = 0
    for (const session of entry.sessions) {
      if (await resumeOne(session)) resumed += 1
    }
    log.info('resume: done', { resumed, requested: entry.sessions.length })
    return { resumed, skipped: entry.sessions.length - resumed }
  }

  /**
   * Arm the resume for this process generation.
   *
   * @returns {() => void} disposer that cancels the pending resume
   */
  function install() {
    let cancelled = false
    const timer = setTimeout(() => {
      if (cancelled) return
      resumePending().catch((error) => {
        log.warn('resume: failed', error?.message ?? String(error))
      })
    }, config.resumeDelayMs)
    timer.unref?.()
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }

  return { install, resumePending }
}
