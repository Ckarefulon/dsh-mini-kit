/**
 * The restart itself.
 *
 * What "restart" means here is the user's own description: the same thing that
 * happens when DSH is closed and opened again from the Start menu — the app
 * process ends and a fresh one starts. A Host plugin cannot ask the Electron
 * shell to do that, so this module does the three things it *can* do:
 *
 *   1. **Settle what is running.** Every other running Session has its turn
 *      cancelled and awaited, so the log ends with a real `turn/end` instead of a
 *      turn that was cut in half by a dying process. The caller's own Session is
 *      skipped: this code is running inside its tool call, and cancelling it here
 *      would abort the very execution that is trying to restart.
 *   2. **Record what must come back.** The running Sessions are written to the
 *      marker before anything is killed, because after the kill there is no
 *      process left to remember them.
 *   3. **Hand off to a detached helper** that outlives this process tree. See
 *      `supervisor.mjs` for what it does and why each step is ordered that way.
 *
 * The caller's Session is where the remaining subtlety lives. Its turn is still
 * in flight, and killing the app inside it would leave a half-written turn, so
 * the handoff is deferred until that turn reaches quiescence — with a hard cap,
 * because a turn that keeps calling tools forever must not make the restart
 * unreachable.
 *
 * @module dsh-mini-kit/restart
 */

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/** Absolute path of the detached helper, resolved next to this module. */
const SUPERVISOR_SCRIPT = fileURLToPath(new URL('./supervisor.mjs', import.meta.url))

/** @param {number} ms */
const sleep = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

/**
 * Facts about the process being replaced, or the reason it cannot be.
 *
 * @returns {{ supported: boolean, reason?: string, appExe?: string, mainPid?: number, hostPid?: number }}
 */
export function desktopFacts() {
  const appExe = process.execPath
  const mainPid = process.ppid
  if (process.versions?.electron === undefined) {
    return {
      supported: false,
      reason:
        'restart is only available in the DSH desktop app: this Host runs under plain node, so there is no app process to relaunch',
    }
  }
  if (process.platform !== 'win32' && process.platform !== 'darwin') {
    return {
      supported: false,
      reason: `restart is not implemented for ${process.platform}`,
    }
  }
  if (typeof appExe !== 'string' || appExe === '' || !Number.isInteger(mainPid) || mainPid <= 0) {
    return {
      supported: false,
      reason: 'restart could not identify the desktop app process to relaunch',
    }
  }
  return { supported: true, appExe, mainPid, hostPid: process.pid }
}

/**
 * @param {object} deps
 * @param {object} deps.ctx host context
 * @param {any} deps.config resolved plugin config
 * @param {ReturnType<import('./sessions.js').createSessionIndex>} deps.index
 * @param {ReturnType<import('./marker.js').createMarker>} deps.marker
 * @param {(facts: { appExe: string, mainPid: number, hostPid: number }) => { ok: boolean, message: string }} [deps.launch]
 * handoff seam: the suite must be able to plan a restart without killing the
 * process it is running in
 * @param {() => ReturnType<typeof desktopFacts>} [deps.facts] process-fact seam
 */
export function createRestarter({ ctx, config, index, marker, launch, facts }) {
  const launchFn = typeof launch === 'function' ? launch : launchSupervisor
  const factsFn = typeof facts === 'function' ? facts : desktopFacts
  /**
   * Cancel one Session's turn and wait for the Agent to stop moving.
   *
   * The cause is `hook` rather than `user`: the log records why the turn ended,
   * and "a plugin asked for a restart" is the honest answer.
   *
   * @param {string} sessionId
   * @param {number} budgetMs
   * @returns {Promise<boolean>} whether the Agent reached quiescence
   */
  async function settle(sessionId, budgetMs) {
    const agent = index.agentOf(sessionId)
    if (agent === undefined) return true
    if (agent.status !== 'running') return true
    try {
      agent.cancel({ kind: 'hook', reason: 'dsh-mini-kit restart' })
    } catch {
      // A failed cancel still leaves the wait below as the real test.
    }
    if (typeof agent.whenIdle !== 'function') {
      return waitUntilIdle(sessionId, budgetMs)
    }
    const idle = Promise.resolve(agent.whenIdle()).then(
      () => true,
      () => false,
    )
    const capped = sleep(budgetMs).then(() => false)
    const quiet = await Promise.race([idle, capped])
    return quiet || !(index.agentOf(sessionId)?.status === 'running')
  }

  /**
   * Bounded fallback for an Agent without `whenIdle`.
   *
   * @param {string} sessionId
   * @param {number} budgetMs
   * @returns {Promise<boolean>}
   */
  async function waitUntilIdle(sessionId, budgetMs) {
    const deadline = Date.now() + budgetMs
    while (Date.now() < deadline) {
      if (index.agentOf(sessionId)?.status !== 'running') return true
      await sleep(100)
    }
    return index.agentOf(sessionId)?.status !== 'running'
  }

  /**
   * Push every live Session's buffered events to durable storage.
   *
   * This is the last chance: the next thing that happens to this process is a
   * force kill, and anything still only in memory is gone.
   *
   * @returns {Promise<number>} how many Sessions reported a durability listener
   */
  async function flushAll() {
    let flushed = 0
    for (const session of index.liveSessions()) {
      try {
        if (await ctx.sessions.flush(session)) flushed += 1
      } catch {
        // A Session that cannot flush must not block the others.
      }
    }
    return flushed
  }

  /**
   * Start the detached helper that ends and relaunches the app.
   *
   * @param {{ appExe: string, mainPid: number, hostPid: number }} facts
   * @returns {{ ok: boolean, message: string }}
   */
  function launchSupervisor(facts) {
    const payload = {
      mainPid: facts.mainPid,
      hostPid: facts.hostPid,
      appExe: facts.appExe,
      initialDelayMs: config.relaunchDelayMs,
      gracefulMs: config.gracefulExitMs,
      drainMs: 8000,
      logPath: `${marker.dir}/restart.log`,
    }
    const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64')
    try {
      const child = spawn(process.execPath, [SUPERVISOR_SCRIPT, encoded], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        env: { ...process.env },
      })
      child.unref()
      return { ok: true, message: 'restart helper started' }
    } catch (error) {
      return { ok: false, message: `could not start the restart helper: ${error?.message ?? String(error)}` }
    }
  }

  /**
   * Wait for the calling Session's own turn to finish, then hand off.
   *
   * @param {string | null | undefined} callerSessionId
   * @param {{ appExe: string, mainPid: number, hostPid: number }} facts
   * @returns {Promise<{ deferred: boolean }>}
   */
  async function handoff(callerSessionId, facts) {
    const agent = callerSessionId === null || callerSessionId === undefined ? undefined : index.agentOf(callerSessionId)
    const running = agent?.status === 'running'
    if (running && typeof agent.whenIdle === 'function') {
      const idle = Promise.resolve(agent.whenIdle()).then(
        () => true,
        () => false,
      )
      const capped = sleep(config.quietWaitMs).then(() => false)
      await Promise.race([idle, capped])
    } else if (running) {
      await waitUntilIdle(callerSessionId, config.quietWaitMs)
    }
    await flushAll()
    launchFn(facts)
    return { deferred: running }
  }

  /**
   * Restart the app, resuming the Sessions that were running.
   *
   * @param {{ callerSessionId?: string | null }} [options] the Session whose turn
   * is executing this call, if any; it is never cancelled from inside itself
   * @returns {Promise<{
   *   ok: boolean,
   *   message: string,
   *   rows: Array<{ id: string, title: string | null, workspace: string | null }>,
   *   stopped: number,
   *   unsettled: string[],
   *   deferred: boolean,
   * }>}
   */
  async function restart(options = {}) {
    const facts = factsFn()
    if (!facts.supported) {
      return {
        ok: false,
        message: facts.reason ?? 'restart is unavailable',
        rows: [],
        stopped: 0,
        unsettled: [],
        deferred: false,
      }
    }

    const callerSessionId = options.callerSessionId ?? null
    const rows = index.runningUserRows()

    // Record the plan before touching anything. If it cannot be written, no
    // turn is cancelled and no process is killed: restarting without a record of
    // what to resume is the one outcome this feature exists to prevent.
    if (rows.length > 0) {
      try {
        marker.write(rows.map((row) => ({ id: row.id, title: row.title, workspace: row.workspace, cwd: row.cwd })))
      } catch (error) {
        return {
          ok: false,
          message: `could not record the sessions to resume, so nothing was restarted: ${error?.message ?? String(error)}`,
          rows: [],
          stopped: 0,
          unsettled: [],
          deferred: false,
        }
      }
    } else {
      marker.clear()
    }

    const unsettled = []
    let stopped = 0
    const deadline = Date.now() + config.cancelTimeoutMs
    for (const row of rows) {
      if (row.id === callerSessionId) continue
      const remaining = Math.max(500, deadline - Date.now())
      if (await settle(row.id, Math.min(remaining, config.cancelTimeoutMs))) stopped += 1
      else unsettled.push(row.id)
    }

    await flushAll()

    // The handoff runs detached from the caller: a tool result must be able to
    // return while this waits for the current turn to close.
    const pending = handoff(callerSessionId, facts).then(
      (result) => result,
      () => ({ deferred: false }),
    )
    pending.catch(() => {})

    const deferred = callerSessionId !== null && index.agentOf(callerSessionId)?.status === 'running'
    const resumeNames = rows.map((row) => `${row.workspace ?? 'unknown'} / ${row.title ?? row.id}`)
    const resumeText =
      resumeNames.length === 0
        ? 'No session was running, so nothing will be resumed.'
        : `${resumeNames.length} session(s) will continue after the app reopens: ${resumeNames.join('; ')}`
    const unsettledText =
      unsettled.length === 0 ? '' : ` ${unsettled.length} session(s) did not stop in time and will be cut off.`
    const when = deferred ? 'as soon as this turn ends' : 'in a moment'
    return {
      ok: true,
      rows: rows.map((row) => ({ id: row.id, title: row.title, workspace: row.workspace })),
      stopped,
      unsettled,
      deferred,
      message: `DSH will restart ${when}. ${resumeText}.${unsettledText}`,
    }
  }

  return { restart, flushAll, settle, desktopFacts }
}
