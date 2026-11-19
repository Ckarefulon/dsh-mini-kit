/**
 * Read-only view over "what is running right now", in the shape the two
 * capabilities report it: one row per Session, carrying its Workspace, its
 * title, and its identity.
 *
 * Two details are load-bearing:
 *
 *   - "Running" is `Agent.status === 'running'`, the same predicate the Host's
 *     own Session list uses. It is true only while a turn is in flight, which is
 *     exactly the set the user asked to see and the set that must be resumed
 *     after a restart.
 *   - Subagent children are excluded. They are Agents with their own Sessions,
 *     but a user never started one directly, and resurrecting one on the next
 *     boot would run it outside the parent that owns its work.
 *
 * @module dsh-mini-kit/sessions
 */

import { basename, normalize as normalizePath } from 'node:path'

/** Marker text used whenever a title or workspace name cannot be resolved. */
export const UNKNOWN = 'unknown'

/**
 * Normalize a filesystem path for equality comparison only.
 *
 * Workspace records and Session headers both carry absolute paths that arrived
 * through different normalization, and Windows makes them case-insensitive, so
 * a raw `===` would miss real matches.
 *
 * @param {string | undefined | null} value
 * @returns {string}
 */
export function pathKey(value) {
  if (typeof value !== 'string' || value === '') return ''
  const normalized = normalizePath(value)
  const trimmed = normalized.length > 3 ? normalized.replace(/[\\/]+$/u, '') : normalized
  return process.platform === 'win32' ? trimmed.toLowerCase() : trimmed
}

/**
 * @param {object} ctx host context
 */
export function createSessionIndex(ctx) {
  /**
   * Acquire an optional service without failing activation when a profile does
   * not mount it; every caller here has a degraded but honest fallback.
   *
   * @param {string} name
   * @returns {any}
   */
  function service(name) {
    try {
      return ctx.get(name, false)
    } catch {
      return undefined
    }
  }

  /** @returns {import('@deepseek-ai/dsh-session').Session[]} */
  function liveSessions() {
    try {
      return ctx.sessions.list()
    } catch {
      return []
    }
  }

  /** @param {string} id */
  function agentOf(id) {
    try {
      return ctx.agents.get(id)
    } catch {
      return undefined
    }
  }

  /**
   * Latest logged title for a live Session, through the projection the client
   * itself reads.
   *
   * @param {any} session
   * @returns {string | null}
   */
  function titleOf(session) {
    const projections = service('sessionProjections')
    if (projections?.snapshot === undefined) return null
    try {
      const value = projections.snapshot(session, ['title'])?.values?.title
      return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
    } catch {
      return null
    }
  }

  /**
   * Workspace lookup by canonical path, built once per call: the registry is a
   * short list, and rebuilding beats caching a value the user can rename.
   *
   * @returns {(cwd: string | undefined) => string | null}
   */
  function workspaceResolver() {
    const registry = service('workspaceRegistry')
    /** @type {Map<string, string>} */
    const byPath = new Map()
    let workspaces = []
    try {
      workspaces = registry?.list?.() ?? []
    } catch {
      workspaces = []
    }
    for (const workspace of workspaces) {
      const title = typeof workspace?.title === 'string' ? workspace.title.trim() : ''
      const key = pathKey(workspace?.path)
      if (key !== '') byPath.set(key, title !== '' ? title : basename(workspace.path))
    }
    return (cwd) => {
      const key = pathKey(cwd)
      if (key === '') return null
      const known = byPath.get(key)
      if (known !== undefined) return known
      return basename(normalizePath(cwd)) || null
    }
  }

  /**
   * Whether this Session belongs to a delegated child Agent.
   *
   * @param {any} session
   * @returns {boolean}
   */
  function isSubagent(session) {
    const header = session?.header
    if (header === undefined || header === null) return false
    if (header.origin === 'subagent') return true
    return header.parentSession !== undefined && header.parentSession !== null
  }

  /**
   * Rows for every Session with a turn in flight, newest activity last.
   *
   * @returns {Array<{ id: string, title: string | null, workspace: string | null, cwd: string | null, subagent: boolean }>}
   */
  function runningRows() {
    const workspaceFor = workspaceResolver()
    /** @type {Array<{ id: string, title: string | null, workspace: string | null, cwd: string | null, subagent: boolean }>} */
    const rows = []
    for (const session of liveSessions()) {
      const agent = agentOf(session.id)
      if (agent?.status !== 'running') continue
      const cwd = typeof session.header?.cwd === 'string' ? session.header.cwd : null
      rows.push({
        id: String(session.id),
        title: titleOf(session),
        workspace: workspaceFor(cwd ?? undefined),
        cwd,
        subagent: isSubagent(session),
      })
    }
    return rows
  }

  /**
   * The rows a user thinks of as "sessions", in a stable order.
   *
   * @returns {Array<{ id: string, title: string | null, workspace: string | null, cwd: string | null, subagent: boolean }>}
   */
  function runningUserRows() {
    return runningRows().filter((row) => !row.subagent)
  }

  return { liveSessions, agentOf, titleOf, runningRows, runningUserRows, service }
}

/**
 * Render one row as `workspace / session`.
 *
 * @param {{ title: string | null, workspace: string | null, id: string }} row
 * @returns {string}
 */
export function formatRow(row) {
  const workspace = row.workspace ?? UNKNOWN
  const session = row.title ?? `${UNKNOWN} (${row.id})`
  return `${workspace} / ${session}`
}
