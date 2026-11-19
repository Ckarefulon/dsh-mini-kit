import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createSessionIndex, formatRow, pathKey } from '../lib/sessions.js'
import { createFakeContext } from './helpers.mjs'

test('pathKey treats Windows paths case-insensitively and ignores trailing separators', () => {
  assert.equal(pathKey('C:\\Work\\Alpha\\'), pathKey('c:/work/alpha'))
  assert.equal(pathKey(''), '')
  assert.equal(pathKey(undefined), '')
})

test('runningUserRows reports only turns in flight, with workspace and title', () => {
  const fake = createFakeContext({
    sessions: [
      { id: 's1', running: true, cwd: 'C:\\Work\\Alpha', title: 'Fix the login page' },
      { id: 's2', running: false, cwd: 'C:\\Work\\Alpha', title: 'Idle session' },
      { id: 's3', running: true, cwd: 'C:\\Work\\Alpha', title: 'Child worker', parentSession: 's1' },
    ],
    workspaces: [{ path: 'c:/work/alpha', title: 'Alpha' }],
  })

  const index = createSessionIndex(fake.ctx)
  assert.deepEqual(index.runningUserRows(), [
    { id: 's1', title: 'Fix the login page', workspace: 'Alpha', cwd: 'C:\\Work\\Alpha', subagent: false },
  ])
  assert.equal(index.runningRows().length, 2)
})

test('a Session outside every registered workspace falls back to its directory name', () => {
  const fake = createFakeContext({
    sessions: [{ id: 's1', running: true, cwd: 'D:\\Scratch\\Loose', title: null }],
    workspaces: [{ path: 'C:\\Work\\Alpha', title: 'Alpha' }],
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
  const fake = createFakeContext({ sessions: [{ id: 's1', running: true, cwd: 'C:\\Work\\Alpha' }] })
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
