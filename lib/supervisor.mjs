/**
 * Detached restart helper.
 *
 * This file runs in its own process, started by `restart.js` with `detached:
 * true` and then forgotten. It exists because the Desktop shell gives a Host
 * plugin no way to relaunch it: the shell validates a fixed set of IPC events
 * and the preload bridge exposes no relaunch call, so the only honest way to
 * reach "closed and opened again from the Start menu" is from outside the
 * process tree being replaced.
 *
 * Ordering is deliberate and each step protects a specific failure:
 *
 *   1. wait, so the caller's tool result reaches the UI before the window goes;
 *   2. verify the parent really is this app's executable, so an unexpected
 *      parent (a terminal, `dsh web` under node) is never killed;
 *   3. resolve the actual application root. The pid handed over is an
 *      intermediate process — the shell starts a desktop-host process, which
 *      starts the profile Host, which is where the plugin lives — so the walk
 *      matters; closing the intermediate one would leave the window running;
 *   4. ask nicely (`taskkill` without `/F` posts WM_CLOSE), then force after the
 *      grace period — DSH keeps running in the tray, so the polite step usually
 *      only saves window state;
 *   5. kill the Host explicitly. It is our own former process and it holds the
 *      HTTP port; leaving it alive would make the relaunched app die with
 *      "another DSH instance is already running";
 *   6. sweep leftovers of the same image except ourselves, because a killed
 *      shell leaves renderers behind on some Windows builds;
 *   7. relaunch with `ELECTRON_RUN_AS_NODE` removed — inherited, it would start
 *      the app as a headless node script instead of a window.
 *
 * @module dsh-mini-kit/supervisor
 */

import { spawn } from 'node:child_process'
import { appendFileSync, mkdirSync } from 'node:fs'
import { basename, dirname } from 'node:path'

import {
  findRootAppPid,
  imageNameOf,
  pidsOfImage,
  sleep,
  stopProcess,
  taskkill,
  waitGone,
} from './process-tree.mjs'

/** @param {string} text */
function decodePayload(text) {
  return JSON.parse(Buffer.from(text, 'base64').toString('utf8'))
}

const payload = (() => {
  try {
    return decodePayload(process.argv[2] ?? '')
  } catch {
    return null
  }
})()

/** @param {string} line @param {unknown} [detail] */
function log(line, detail) {
  const text = detail === undefined ? line : `${line} ${JSON.stringify(detail)}`
  try {
    if (payload?.logPath) {
      mkdirSync(dirname(payload.logPath), { recursive: true })
      appendFileSync(payload.logPath, `[${new Date().toISOString()}] ${text}\n`, 'utf8')
    }
  } catch {
    // Logging must never be the reason a restart fails.
  }
}

/** @param {Record<string, string | undefined>} environment */
function relaunchEnvironment(environment) {
  /** @type {Record<string, string>} */
  const clean = {}
  for (const [key, value] of Object.entries(environment)) {
    if (value === undefined) continue
    if (key.toUpperCase() === 'ELECTRON_RUN_AS_NODE') continue
    clean[key] = value
  }
  return clean
}

/**
 * @param {{
 *   mainPid: number,
 *   hostPid: number,
 *   appExe: string,
 *   initialDelayMs?: number,
 *   gracefulMs?: number,
 *   drainMs?: number,
 *   logPath?: string,
 * }} options
 */
async function main(options) {
  const initialDelayMs = options.initialDelayMs ?? 800
  const gracefulMs = options.gracefulMs ?? 3000
  const drainMs = options.drainMs ?? 8000
  const appExe = options.appExe
  const image = basename(appExe)

  log('start', {
    mainPid: options.mainPid,
    hostPid: options.hostPid,
    appExe,
    platform: process.platform,
    self: process.pid,
  })

  await sleep(initialDelayMs)

  if (process.platform === 'win32') {
    const parentImage = imageNameOf(options.mainPid)
    if (parentImage.toLowerCase() !== image.toLowerCase()) {
      log('abort: refusing to stop an unexpected parent', {
        mainPid: options.mainPid,
        parentImage,
        expected: image,
      })
      return
    }
  }

  const rootPid = process.platform === 'win32' ? await findRootAppPid(options.mainPid, image) : options.mainPid
  log('resolved app root', { from: options.mainPid, root: rootPid })

  await stopProcess(rootPid, gracefulMs, 'shell', log)
  await stopProcess(options.hostPid, gracefulMs, 'host', log)

  if (process.platform === 'win32') {
    const deadline = Date.now() + drainMs
    for (;;) {
      const leftovers = pidsOfImage(image).filter((pid) => pid !== process.pid)
      if (leftovers.length === 0) break
      if (Date.now() >= deadline) {
        log('drain: giving up on leftovers', leftovers)
        break
      }
      for (const pid of leftovers) taskkill(['/PID', String(pid), '/F'])
      await sleep(250)
    }
  }

  if (!(await waitGone(rootPid, drainMs))) log('warn: shell still alive before relaunch')

  // A little longer than the drain poll: Windows releases the listening socket
  // and the single-instance lock asynchronously, and relaunching into either one
  // produces a window that immediately exits.
  await sleep(700)
  log('relaunching', appExe)
  try {
    const child = spawn(appExe, [], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
      cwd: dirname(appExe),
      env: relaunchEnvironment(process.env),
    })
    child.unref()
    log('relaunched', { pid: child.pid ?? null })
  } catch (error) {
    log('relaunch failed', { message: error?.message ?? String(error) })
  }
}

if (payload === null) {
  log('fatal: no payload')
} else {
  await main(payload)
}
