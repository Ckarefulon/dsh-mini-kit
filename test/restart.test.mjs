import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { createMarker } from '../lib/marker.js'
import { createRestarter } from '../lib/restart.js'
import { createSessionIndex } from '../lib/sessions.js'
import { createFakeContext, sleep } from './helpers.mjs'

/** @returns {string} */
function tempStateDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix))
}

/** @param {Partial<typeof import('../lib/index.js').DEFAULTS>} [overrides] */
function config(overrides = {}) {
  return {
    autoResume: true,
    resumePrompt: 'continue',
    resumeDelayMs: 10,
    cancelTimeoutMs: 1000,
    quietWaitMs: 200,
    gracefulExitMs: 10,
    relaunchDelayMs: 1,
    stateDir: '',
    ...overrides,
  }
}

/**
 * @param {object} [options]
 * @param {ReturnType<typeof config>} [options.config]
 * @param {Array<object>} [options.sessions]
 * @param {{ appExe: string, mainPid: number, hostPid: number } | null} [options.desktop]
 */
function setup(options = {}) {
  const fake = createFakeContext({
    sessions: options.sessions ?? [],
    workspaces: [{ path: 'C:\\Work\\Alpha', title: 'Alpha' }],
  })
  const launches = []
  const desktop =
    options.desktop === null
      ? { supported: false, reason: 'not the desktop app' }
      : {
          supported: true,
          appExe: options.desktop?.appExe ?? 'C:\\app\\DeepSeek Harness.exe',
          mainPid: options.desktop?.mainPid ?? 111,
          hostPid: options.desktop?.hostPid ?? 222,
        }
  const marker = createMarker({ stateDir: options.config?.stateDir ?? '' })
  const restarter = createRestarter({
    ctx: fake.ctx,
    config: options.config ?? config(),
    index: createSessionIndex(fake.ctx),
    marker,
    facts: () => desktop,
    launch: (facts) => {
      launches.push(facts)
      return { ok: true, message: 'stub' }
    },
  })
  return { fake, restarter, marker, launches }
}

test('refuses outside the desktop app instead of killing something else', async () => {
  const { restarter } = setup({ desktop: null })
  const result = await restarter.restart({})
  assert.equal(result.ok, false)
  assert.match(result.message, /desktop app/u)
})

test('cancels other running turns, spares the caller, and records every running session', async () => {
  const dir = tempStateDir('dsh-mini-kit-restart-')
  const { fake, restarter, marker, launches } = setup({
    config: config({ stateDir: dir }),
    sessions: [
      { id: 's1', running: true, cwd: 'C:\\Work\\Alpha', title: 'Caller' },
      { id: 's2', running: true, cwd: 'C:\\Work\\Alpha', title: 'Other' },
      { id: 's3', running: true, cwd: 'C:\\Work\\Alpha', title: 'Child', parentSession: 's1' },
      { id: 's4', running: false, cwd: 'C:\\Work\\Alpha', title: 'Idle' },
    ],
  })

  const result = await restarter.restart({ callerSessionId: 's1' })
  assert.equal(result.ok, true)
  assert.deepEqual(fake.cancels, ['s2:hook'])
  assert.equal(result.deferred, true)
  assert.deepEqual(
    result.rows.map((row) => row.id),
    ['s1', 's2'],
  )

  const pending = marker.read()
  assert.deepEqual(
    pending.sessions.map((entry) => entry.id),
    ['s1', 's2'],
  )
  assert.deepEqual(
    pending.sessions.map((entry) => entry.workspace),
    ['Alpha', 'Alpha'],
  )

  await sleep(25)
  assert.equal(launches.length, 1)
  assert.equal(launches[0].mainPid, 111)
})

test('a command restart cancels the Session it was typed in, because nothing is executing', async () => {
  const { fake, restarter, marker } = setup({
    config: config({ stateDir: tempStateDir('dsh-mini-kit-command-') }),
    sessions: [{ id: 's1', running: true, cwd: 'C:\\Work\\Alpha', title: 'Only' }],
  })
  const result = await restarter.restart({ callerSessionId: null })
  assert.equal(result.ok, true)
  assert.deepEqual(fake.cancels, ['s1:hook'])
  assert.equal(result.deferred, false)
  assert.equal(marker.read().sessions[0].id, 's1')
  await sleep(25)
})

test('an unwritable state directory aborts the restart without disturbing running work', async () => {
  const root = tempStateDir('dsh-mini-kit-blocked-')
  // A regular file where the state directory's parent should be: `mkdir -p`
  // cannot resolve that, so the write fails the way a locked profile would.
  const blocker = join(root, 'blocker')
  writeFileSync(blocker, 'x', 'utf8')

  const { fake, restarter, launches } = setup({
    config: config({ stateDir: join(blocker, 'mini-kit') }),
    sessions: [{ id: 's1', running: true, cwd: 'C:\\Work\\Alpha', title: 'Only' }],
  })
  const result = await restarter.restart({})
  assert.equal(result.ok, false)
  assert.match(result.message, /could not record the sessions to resume/u)
  assert.deepEqual(fake.cancels, [])
  await sleep(25)
  assert.equal(launches.length, 0)
})

test('nothing running leaves no marker behind', async () => {
  const dir = tempStateDir('dsh-mini-kit-empty-')
  const { restarter, marker } = setup({ config: config({ stateDir: dir }), sessions: [] })
  const result = await restarter.restart({})
  assert.equal(result.ok, true)
  assert.match(result.message, /nothing will be resumed/u)
  assert.equal(marker.read(), null)
  await sleep(25)
})

test('flushAll reports how many Sessions reached durable storage', async () => {
  const { fake, restarter } = setup({
    sessions: [{ id: 's1' }, { id: 's2' }],
  })
  fake.ctx.sessions.flush = async () => true
  assert.equal(await restarter.flushAll(), 2)
  fake.ctx.sessions.flush = async () => {
    throw new Error('writer gone')
  }
  assert.equal(await restarter.flushAll(), 0)
})
