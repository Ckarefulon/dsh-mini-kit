import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'

import { createSessionIndex, formatRow, pathKey } from '../lib/sessions.js'
import { createFakeContext } from './helpers.mjs'

const WINDOWS = process.platform === 'win32'

/** A workspace directory, spelled the way this platform spells one. */
const ALPHA = join(process.env.SystemDrive ?? '/', 'Work', 'Alpha')

test('pathKey ignores a trailing separator everywhere, and case on Windows', () => {
  assert.equal(pathKey(ALPHA), pathKey(`${ALPHA}${WINDOWS ? '\\' : '/'}`))
  assert.equal(pathKey(''), '')
  assert.equal(pathKey(undefined), '')
  if (WINDOWS) assert.equal(pathKey('C:\\Work\\Alpha\\'), pathKey('c:/work/alpha'))
})

test('runningUserRows reports only turns in flight, with workspace and title', () => {
  const fake = createFakeContext({
    sessions: [
      { id: 's1', running: true, cwd: ALPHA, title: 'Fix the login page' },
      { id: 's2', running: false, cwd: ALPHA, title: 'Idle session' },
      { id: 's3', running: true, cwd: ALPHA, title: 'Child worker', parentSession: 's1' },
    ],
    // Registered the way a Windows user would see it: different case, native separators.
    workspaces: [{ path: WINDOWS ? ALPHA.toUpperCase() : ALPHA, title: 'Alpha' }],
  })

  const index = createSessionIndex(fake.ctx)
  assert.deepEqual(index.runningUserRows(), [
    { id: 's1', title: 'Fix the login page', workspace: 'Alpha', cwd: ALPHA, subagent: false },
  ])
  assert.equal(index.runningRows().length, 2)
})

test('a Session outside every registered workspace falls back to its directory name', () => {
  const loose = join(process.env.SystemDrive ?? '/', 'Scratch', 'Loose')
  const fake = createFakeContext({
    sessions: [{ id: 's1', running: true, cwd: loose, title: null }],
    workspaces: [{ path: ALPHA, title: 'Alpha' }],
  })
  const [row] = createSessionIndex(fake.ctx).runningUserRows()
  assert.equal(row.workspace, 'Loose')
  assert.equal(row.title, null)
  assert.equal(formatRow(row), 'Loose / unknown (s1)')
})

test('a subagent is excluded both by parent lineage and by declared origin', () => {
  const fake = createFakeContext({
    sessions: [
      { id: 's1', running: true, parentSession: 'root' },
      { id: 's2', running: true, origin: 'subagent' },
    ],
  })
  assert.deepEqual(createSessionIndex(fake.ctx).runningUserRows(), [])
})

test('missing optional services degrade instead of throwing', () => {
  const fake = createFakeContext({ sessions: [{ id: 's1', running: true, cwd: ALPHA }] })
  delete fake.services.sessionProjections
  delete fake.services.workspaceRegistry
  const [row] = createSessionIndex(fake.ctx).runningUserRows()
  assert.equal(row.title, null)
  assert.equal(row.workspace, 'Alpha')
})

test('formatRow keeps the workspace / session shape the tool documents', () => {
  assert.equal(formatRow({ workspace: 'Alpha', title: 'Fix it', id: 's1' }), 'Alpha / Fix it')
  assert.equal(formatRow({ workspace: null, title: 'Fix it', id: 's1' }), 'unknown / Fix it')
})
