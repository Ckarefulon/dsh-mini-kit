import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { Config, DEFAULTS, apply, internals, readConfig } from '../lib/index.js'
import { createMarker } from '../lib/marker.js'
import { createFakeContext, sleep } from './helpers.mjs'

/** @returns {string} */
function stateDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix))
}

test('readConfig fills every default and accepts the row shapes the Loader can hand over', () => {
  assert.deepEqual(readConfig(undefined), DEFAULTS)
  assert.deepEqual(readConfig({}), DEFAULTS)
  assert.deepEqual(readConfig({ gracefulExitMs: 900 }).gracefulExitMs, 900)
  assert.deepEqual(readConfig({ resumePrompt: 'go' }).resumePrompt, 'go')
  // A volatile root exposes `get()`; the values are behind it, not on it.
  assert.equal(readConfig({ get: () => ({ quietWaitMs: 77 }) }).quietWaitMs, 77)
  // Unknown keys cannot leak into the resolved config.
  assert.equal('nonsense' in readConfig({ nonsense: 1 }), false)
})

test('the exported schema covers every default, so a profile edit and the fallback agree', () => {
  assert.equal(typeof Config, 'function')
  const fromSchema = Config({})
  assert.deepEqual(Object.keys(fromSchema).sort(), Object.keys(DEFAULTS).sort())
  for (const key of Object.keys(DEFAULTS)) {
    assert.deepEqual(fromSchema[key], DEFAULTS[key], `${key} drifted from the schema default`)
  }
})

test('apply registers two tools, one command, and the resume hook', () => {
  const fake = createFakeContext({ sessions: [] })
  apply(fake.ctx, { stateDir: stateDir('dsh-mini-kit-apply-'), autoResume: true, resumeDelayMs: 5 })
  assert.deepEqual(
    fake.tools.map((tool) => tool.name),
    ['list_running_sessions', 'restart_dsh'],
  )
  assert.deepEqual(
    fake.commands.map((command) => command.name),
    ['restart'],
  )
  assert.equal(fake.effects.length, 3)
})

test('autoResume false installs no resume hook', () => {
  const fake = createFakeContext({ sessions: [] })
  apply(fake.ctx, { stateDir: stateDir('dsh-mini-kit-noresume-'), autoResume: false })
  assert.equal(fake.effects.length, 2)
})

test('a marker from the previous process reseeds the follow-up prompt', async () => {
  const dir = stateDir('dsh-mini-kit-resume-')
  createMarker({ stateDir: dir }).write([{ id: 's1', title: 'Fix the login page', workspace: 'Alpha' }])

  const fake = createFakeContext({
    sessions: [{ id: 's1', running: true, cwd: 'C:\\Work\\Alpha', title: 'Fix the login page' }],
    workspaces: [{ path: 'C:\\Work\\Alpha', title: 'Alpha' }],
  })
  apply(fake.ctx, { stateDir: dir, autoResume: true, resumeDelayMs: 5, resumePrompt: 'keep going' })
  await sleep(60)

  assert.equal(fake.followups.length, 1)
  assert.equal(fake.followups[0].id, 's1')
  assert.deepEqual(fake.followups[0].content, [{ type: 'text', text: 'keep going' }])
  assert.deepEqual(fake.followups[0].source, { kind: 'dsh-mini-kit' })

  // The marker is consumed exactly once, so a later boot has nothing to resume.
  assert.equal(createMarker({ stateDir: dir }).read(), null)
})

test('a resume resolves a cold Session through sessionController before giving up', async () => {
  const dir = stateDir('dsh-mini-kit-coldresume-')
  createMarker({ stateDir: dir }).write([{ id: 'cold' }])

  /** @type {string[]} */
  const resolved = []
  const fake = createFakeContext({
    sessions: [],
    services: {
      sessionController: {
        async resolveAgent(id) {
          resolved.push(String(id))
          return {
            agent: {
              id,
              status: 'idle',
              followup(payload) {
                fake.followups.push({ id: String(id), content: payload?.content, source: payload?.source })
              },
            },
          }
        },
      },
    },
  })
  apply(fake.ctx, { stateDir: dir, autoResume: true, resumeDelayMs: 5 })
  await sleep(60)

  assert.deepEqual(resolved, ['cold'])
  assert.equal(fake.followups.length, 1)
})

test('internals expose the seams the suite drives', () => {
  assert.equal(typeof internals.readConfig, 'function')
  assert.equal(typeof internals.desktopFacts, 'function')
  assert.equal(internals.DEFAULTS, DEFAULTS)
})
