/**
 * The one piece of state that has to survive a process that is about to be
 * killed: which sessions must be picked up again once DSH reopens.
 *
 * It is deliberately a plain JSON file under `DSH_HOME` rather than a Session
 * event or a service-owned store: the writer dies mid-handshake with everything
 * else, so the only durable channel is the filesystem, and the reader is a
 * *different process generation* that may not have loaded this plugin's services
 * yet.
 *
 * @module dsh-mini-kit/marker
 */

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Bumped when the on-disk shape changes; an unknown version is ignored, not guessed at. */
export const MARKER_VERSION = 1

/** File name inside the plugin's state directory. */
const MARKER_FILE = 'pending-restart.json'

/**
 * Resolve the plugin's state directory.
 *
 * `DSH_HOME` is what the running harness itself uses, but a shell launched
 * without a profile has no such variable; `~/.dsh` is the same default the CLI
 * applies, so both spellings land in one place.
 *
 * @param {{ stateDir?: string }} config
 * @returns {string}
 */
export function resolveStateDir(config) {
  const explicit = (config?.stateDir ?? '').trim()
  if (explicit !== '') return explicit
  const home = (process.env.DSH_HOME ?? '').trim() || join(homedir(), '.dsh')
  return join(home, 'mini-kit')
}

/**
 * @typedef {object} PendingRestart
 * @property {number} version
 * @property {number} createdAt epoch milliseconds
 * @property {string} platform
 * @property {Array<{ id: string, title: string | null, workspace: string | null, cwd: string | null }>} sessions
 */

/**
 * Read/write owner for the pending-restart marker.
 *
 * @param {{ stateDir?: string }} config
 */
export function createMarker(config) {
  const dir = resolveStateDir(config)
  const file = join(dir, MARKER_FILE)

  return {
    dir,
    file,

    /**
     * Persist the sessions to resume.
     *
     * Written to a sibling and renamed, so a kill landing mid-write leaves the
     * previous marker intact instead of a truncated one that would parse as
     * "nothing to resume".
     *
     * @param {Array<{ id: string, title?: string | null, workspace?: string | null, cwd?: string | null }>} sessions
     * @returns {string} the marker path
     */
    write(sessions) {
      mkdirSync(dir, { recursive: true })
      /** @type {PendingRestart} */
      const payload = {
        version: MARKER_VERSION,
        createdAt: Date.now(),
        platform: process.platform,
        sessions: sessions.map((session) => ({
          id: String(session.id),
          title: session.title ?? null,
          workspace: session.workspace ?? null,
          cwd: session.cwd ?? null,
        })),
      }
      const temporary = `${file}.${process.pid}.tmp`
      writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
      renameSync(temporary, file)
      return file
    },

    /**
     * Read the marker without consuming it.
     *
     * @returns {PendingRestart | null} a validated marker, or null when absent,
     * malformed, or from a shape this build does not understand
     */
    read() {
      let text
      try {
        text = readFileSync(file, 'utf8')
      } catch {
        return null
      }
      let parsed
      try {
        parsed = JSON.parse(text)
      } catch {
        return null
      }
      if (parsed === null || typeof parsed !== 'object') return null
      if (parsed.version !== MARKER_VERSION) return null
      if (!Array.isArray(parsed.sessions)) return null
      const sessions = parsed.sessions
        .filter((entry) => entry !== null && typeof entry === 'object' && typeof entry.id === 'string' && entry.id !== '')
        .map((entry) => ({
          id: entry.id,
          title: typeof entry.title === 'string' ? entry.title : null,
          workspace: typeof entry.workspace === 'string' ? entry.workspace : null,
          cwd: typeof entry.cwd === 'string' ? entry.cwd : null,
        }))
      return {
        version: parsed.version,
        createdAt: Number.isFinite(parsed.createdAt) ? parsed.createdAt : 0,
        platform: typeof parsed.platform === 'string' ? parsed.platform : '',
        sessions,
      }
    },

    /**
     * Claim the marker for this process generation.
     *
     * Renaming before any resume attempt is what keeps a failing resume from
     * looping forever: the next boot has nothing to find, so one bad session can
     * cost one prompt instead of restarting the app on every launch.
     *
     * @returns {PendingRestart | null} the claimed marker
     */
    claim() {
      const pending = this.read()
      if (pending === null) return null
      try {
        renameSync(file, `${file}.claimed`)
      } catch {
        try {
          rmSync(file, { force: true })
        } catch {
          // Nothing else to do: the resume that follows is still the right one,
          // and a repeat on the next boot is bounded by the retry policy.
        }
      }
      return pending
    },

    /** Remove a marker written by a restart that never happened. */
    clear() {
      try {
        rmSync(file, { force: true })
      } catch {
        // A stale marker only costs one extra resume prompt after the next boot.
      }
    },
  }
}
