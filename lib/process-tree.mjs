/**
 * The Win32 process operations the restart helper needs, separated from the
 * restart policy so they can be tested without restarting anything.
 *
 * Everything here shells out to `tasklist`, `taskkill`, and one PowerShell
 * query: a plugin cannot call Win32 from JavaScript, and adding a native
 * dependency to a plugin whose whole job is "end this process" is not worth the
 * install risk.
 *
 * @module dsh-mini-kit/process-tree
 */

import { spawnSync } from 'node:child_process'

/** @param {number} ms */
export const sleep = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

/**
 * @param {number} pid
 * @returns {boolean} whether the process still exists
 */
export function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

/**
 * @param {number} pid
 * @param {number} budgetMs
 * @returns {Promise<boolean>} whether it exited inside the budget
 */
export async function waitGone(pid, budgetMs) {
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline) {
    if (!alive(pid)) return true
    await sleep(100)
  }
  return !alive(pid)
}

/**
 * @param {string[]} args
 * @returns {number} the exit status, or -1 when the call itself failed
 */
export function taskkill(args) {
  try {
    const result = spawnSync('taskkill', args, { windowsHide: true, stdio: 'ignore' })
    return result.status ?? -1
  } catch {
    return -1
  }
}

/**
 * Extract the quoted fields of one `tasklist /FO CSV` row.
 *
 * `tasklist` is localized and its last field legitimately contains a comma
 * ("1,234 K"), so neither the header nor a naive split can be relied on; the
 * quoted fields are stable across locales.
 *
 * @param {string} line
 * @returns {string[]}
 */
export function quotedFields(line) {
  const fields = []
  const pattern = /"([^"]*)"/gu
  let match = pattern.exec(line)
  while (match !== null) {
    fields.push(match[1])
    match = pattern.exec(line)
  }
  return fields
}

/**
 * @param {string} command
 * @param {string[]} args
 * @returns {string}
 */
export function capture(command, args) {
  try {
    const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true, timeout: 5000 })
    return typeof result.stdout === 'string' ? result.stdout : ''
  } catch {
    return ''
  }
}

/**
 * @param {number} pid
 * @returns {string} the image name, or '' when the process is gone
 */
export function imageNameOf(pid) {
  const output = capture('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'])
  for (const line of output.split(/\r?\n/u)) {
    const fields = quotedFields(line)
    if (fields.length >= 2 && fields[1] === String(pid)) return fields[0]
  }
  return ''
}

/**
 * @param {number} pid
 * @returns {Promise<number>} the parent pid, or 0 when unknown
 */
export async function parentOf(pid) {
  const script = `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}' -ErrorAction SilentlyContinue).ParentProcessId`
  const output = capture('powershell', ['-NoProfile', '-NoLogo', '-NonInteractive', '-Command', script])
  const parsed = Number.parseInt(output.trim(), 10)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 0
}

/**
 * Every live process of one image name.
 *
 * @param {string} image
 * @returns {number[]}
 */
export function pidsOfImage(image) {
  const wanted = image.toLowerCase()
  const output = capture('tasklist', ['/FI', `IMAGENAME eq ${image}`, '/FO', 'CSV', '/NH'])
  const pids = []
  for (const line of output.split(/\r?\n/u)) {
    const fields = quotedFields(line)
    if (fields.length < 2) continue
    if (fields[0].toLowerCase() !== wanted) continue
    const pid = Number.parseInt(fields[1], 10)
    if (Number.isInteger(pid) && pid > 0) pids.push(pid)
  }
  return pids
}

/**
 * Walk up to the top-most ancestor that is still this application.
 *
 * The profile Host is not a direct child of the window process: the shell starts
 * a desktop-host process, which starts the profile Host, which is where a plugin
 * runs. `process.ppid` therefore names an intermediate process, and closing that
 * one leaves the window — and the application — alive. The starting pid is only
 * a starting point.
 *
 * @param {number} startPid
 * @param {string} image
 * @param {number} [maxHops]
 * @returns {Promise<number>}
 */
export async function findRootAppPid(startPid, image, maxHops = 8) {
  const wanted = image.toLowerCase()
  let current = startPid
  for (let hop = 0; hop < maxHops; hop += 1) {
    const parent = await parentOf(current)
    if (parent === 0) break
    if (imageNameOf(parent).toLowerCase() !== wanted) break
    current = parent
  }
  return current
}

/**
 * Stop one process: ask it to close, then force it once the grace period is over.
 *
 * @param {number} pid
 * @param {number} gracefulMs
 * @param {string} label
 * @param {(line: string, detail?: unknown) => void} [log]
 * @returns {Promise<void>}
 */
export async function stopProcess(pid, gracefulMs, label, log = () => {}) {
  if (!alive(pid)) {
    log(`stop ${label}: already gone`)
    return
  }
  if (process.platform === 'win32') {
    taskkill(['/PID', String(pid)])
  } else {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      // Already gone, or not ours; the force step below reports as needed.
    }
  }
  if (await waitGone(pid, gracefulMs)) {
    log(`stop ${label}: exited gracefully`)
    return
  }
  log(`stop ${label}: grace expired, forcing`)
  if (process.platform === 'win32') {
    taskkill(['/PID', String(pid), '/F'])
  } else {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // Nothing further can be done for this pid.
    }
  }
}
