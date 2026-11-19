/**
 * dsh-mini-kit — host half.
 *
 * Two small utilities, one package:
 *
 *   - **`/restart` and the `restart_dsh` tool** end the desktop app and start it
 *     again, then continue the Sessions whose turns were running at that moment.
 *     `restart.js` owns the settling and the handoff, `supervisor.mjs` owns the
 *     part that has to run after this process is gone, and `resume.js` owns the
 *     part that runs in the next process.
 *   - **The `list_running_sessions` tool** reports what is running as
 *     `workspace / session title`, straight from the live Agent registry.
 *
 * There is no browser half and no client bundle: a tool and a slash command are
 * both served from the Host, so this package never loads in the Web GUI.
 *
 * @module dsh-mini-kit
 */

import z from '@deepseek-ai/schemastery'

import { registerCommands } from './commands.js'
import { createMarker, resolveStateDir } from './marker.js'
import { createRestarter, desktopFacts } from './restart.js'
import { createResumer } from './resume.js'
import { createSessionIndex } from './sessions.js'
import { registerTools } from './tools.js'

/** Stable Loader identity; also the patch row id and the state directory name. */
export const name = 'dsh-mini-kit'

/**
 * `tools` and `commands` are what this package publishes; `sessions` and
 * `agents` are how it finds and stops work. `sessionController`,
 * `sessionProjections`, and `workspaceRegistry` are acquired opportunistically
 * instead: they improve a title or a resume, and a profile without them should
 * still get a working restart rather than an inactive plugin.
 */
export const inject = ['tools', 'commands', 'sessions', 'agents']

/**
 * Defaults, stated once.
 *
 * These are the schema's `.default()` arguments *and* the fallback used when a
 * raw config cannot be read, so the two can never drift apart.
 */
export const DEFAULTS = {
  /** Continue the Sessions that were running before the restart. */
  autoResume: true,
  /** Prompt handed to each resumed Session. */
  resumePrompt:
    'DSH 刚刚重启，上一轮工作被中断了。请从中断的地方继续；如果其实已经完成，简要总结一下结果即可。',
  /** How long to let the fresh Host finish wiring itself up before resuming. */
  resumeDelayMs: 2500,
  /** Total budget for cancelling the running turns of other Sessions. */
  cancelTimeoutMs: 20000,
  /** Cap on waiting for the calling Session's own turn to close before restarting anyway. */
  quietWaitMs: 60000,
  /** How long the helper asks the app to close before forcing it. */
  gracefulExitMs: 3000,
  /** Delay between handing off and the window disappearing, so the result is visible. */
  relaunchDelayMs: 800,
  /** Override the state directory; empty means `<DSH_HOME>/mini-kit`. */
  stateDir: '',
}

/**
 * Plugin configuration.
 *
 * Deliberately not `volatile`: a restart is not a setting worth reloading live,
 * and a profile-level edit already takes effect on the next boot, which is when
 * every one of these values is read anyway.
 */
export const Config = z.object({
  autoResume: z.boolean().default(DEFAULTS.autoResume),
  resumePrompt: z.string().default(DEFAULTS.resumePrompt),
  resumeDelayMs: z.number().default(DEFAULTS.resumeDelayMs),
  cancelTimeoutMs: z.number().default(DEFAULTS.cancelTimeoutMs),
  quietWaitMs: z.number().default(DEFAULTS.quietWaitMs),
  gracefulExitMs: z.number().default(DEFAULTS.gracefulExitMs),
  relaunchDelayMs: z.number().default(DEFAULTS.relaunchDelayMs),
  stateDir: z.string().default(DEFAULTS.stateDir),
})

/**
 * Resolve the live config.
 *
 * A volatile schemastery root exposes `get()`; a plain one is the object itself.
 * Both shapes are accepted, and only keys the schema knows are copied, so an
 * unrelated field in the row cannot leak in.
 *
 * @param {unknown} rawConfig the Loader's config for this row
 * @returns {typeof DEFAULTS}
 */
export function readConfig(rawConfig) {
  const source = typeof (/** @type {any} */ (rawConfig)?.get) === 'function' ? rawConfig.get() : rawConfig
  const record = source !== null && typeof source === 'object' ? source : {}
  /** @type {typeof DEFAULTS} */
  const resolved = { ...DEFAULTS }
  for (const key of Object.keys(DEFAULTS)) {
    const value = record[key]
    if (value === undefined || value === null) continue
    // @ts-expect-error the key is one of DEFAULTS' own keys by construction.
    resolved[key] = value
  }
  return resolved
}

/**
 * Install the host half.
 *
 * @param {object} ctx host context
 * @param {unknown} rawConfig the Loader's config for this row
 */
export function apply(ctx, rawConfig) {
  const config = readConfig(rawConfig)
  const marker = createMarker(config)
  const index = createSessionIndex(ctx)
  const restarter = createRestarter({ ctx, config, index, marker })
  const resumer = createResumer({ ctx, config, marker, index, logger: ctx.logger })

  ctx.effect(() => registerTools(ctx, { index, restarter }), 'dsh-mini-kit: tools')
  ctx.effect(() => registerCommands(ctx, { restarter }), 'dsh-mini-kit: commands')

  // The only work that belongs to a fresh process: pick up what the previous one
  // recorded. It runs whether or not this is a restart — an absent marker is the
  // normal case and costs one file read.
  if (config.autoResume) ctx.effect(() => resumer.install(), 'dsh-mini-kit: resume')
}

/**
 * Internals exposed for the test suite, which drives the real modules against a
 * fake context instead of re-implementing them.
 */
export const internals = {
  readConfig,
  DEFAULTS,
  createMarker,
  createSessionIndex,
  createRestarter,
  createResumer,
  registerTools,
  registerCommands,
  resolveStateDir,
  desktopFacts,
}
