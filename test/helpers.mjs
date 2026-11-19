/**
 * A context just real enough to drive the plugin's own modules.
 *
 * The plugin talks to five services, and a test that re-implemented them would
 * test the re-implementation. This records every registration so the suite can
 * assert on what the plugin actually asked the Host to do.
 */

/** @param {number} ms */
export const sleep = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

/**
 * @param {object} spec
 * @param {string} spec.id
 * @param {boolean} [spec.running]
 * @param {string | null} [spec.cwd]
 * @param {string | null} [spec.title]
 * @param {string | null} [spec.parentSession]
 * @param {string | null} [spec.origin]
 */
export function makeSession(spec) {
  const session = {
    id: spec.id,
    header: {
      cwd: spec.cwd ?? undefined,
      parentSession: spec.parentSession ?? undefined,
      origin: spec.origin ?? undefined,
    },
  }
  return session
}

/**
 * @param {object} [options]
 * @param {Array<object>} [options.sessions] session specs
 * @param {Array<{ path: string, title?: string }>} [options.workspaces]
 * @param {Record<string, unknown>} [options.services] extra services by name
 */
export function createFakeContext(options = {}) {
  /** @type {any[]} */
  const sessionList = []
  /** @type {Map<string, any>} */
  const agentById = new Map()
  /** @type {Map<string, any>} */
  const sessionById = new Map()
  /** @type {string[]} */
  const cancels = []
  /** @type {Array<{ id: string, content: unknown, source: unknown }>} */
  const followups = []
  /** @type {Array<() => void>} */
  const disposers = []

  const tools = []
  const commands = []
  const effects = []

  const titles = new Map()
  for (const spec of options.sessions ?? []) {
    const session = makeSession(spec)
    sessionList.push(session)
    sessionById.set(spec.id, session)
    titles.set(spec.id, spec.title ?? null)
    agentById.set(spec.id, {
      id: spec.id,
      status: spec.running === true ? 'running' : 'idle',
      cancel(cause) {
        cancels.push(`${spec.id}:${cause?.kind ?? 'unknown'}`)
        this.status = 'idle'
      },
      whenIdle() {
        return Promise.resolve()
      },
      followup(payload) {
        followups.push({ id: spec.id, content: payload?.content, source: payload?.source })
      },
    })
  }

  const services = {
    sessionProjections: {
      snapshot(session) {
        return { asOfSeq: 1, values: { title: titles.get(session.id) ?? null } }
      },
    },
    workspaceRegistry: {
      list() {
        return (options.workspaces ?? []).map((workspace) => ({
          path: workspace.path,
          title: workspace.title ?? '',
        }))
      },
    },
    ...options.services,
  }

  const ctx = {
    logger: {
      info() {},
      warn() {},
      error() {},
    },
    sessions: {
      list() {
        return [...sessionList]
      },
      async flush() {
        return true
      },
    },
    agents: {
      get(id) {
        return agentById.get(id)
      },
      list() {
        return [...agentById.values()]
      },
    },
    tools: {
      register(definition) {
        tools.push(definition)
        const disposer = () => {}
        disposers.push(disposer)
        return disposer
      },
    },
    commands: {
      register(definition) {
        commands.push(definition)
        const disposer = () => {}
        disposers.push(disposer)
        return disposer
      },
    },
    effect(callback) {
      effects.push(callback)
      return callback()
    },
    get(name) {
      return services[name]
    },
  }

  return { ctx, tools, commands, effects, disposers, cancels, followups, sessionById, agentById, services }
}
