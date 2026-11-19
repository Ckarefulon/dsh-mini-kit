import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { createMarker, resolveStateDir, MARKER_VERSION } from '../lib/marker.js'

/** @returns {string} */
function tempDir() {
  return mkdtempSync(join(tmpdir(), 'dsh-mini-kit-marker-'))
}

test('stateDir honours an explicit override, else DSH_HOME, else ~/.dsh', () => {
  assert.equal(resolveStateDir({ stateDir: 'C:\\custom' }), 'C:\\custom')

  const previous = process.env.DSH_HOME
  try {
    process.env.DSH_HOME = join('C:\\', 'home-from-env')
    assert.equal(resolveStateDir({ stateDir: '' }), join(process.env.DSH_HOME, 'mini-kit'))
    // Whitespace is the same as unset: an empty variable must not produce a
    // state directory of `mini-kit` relative to the process working directory.
    process.env.DSH_HOME = '   '
    assert.match(resolveStateDir({ stateDir: '' }), /mini-kit$/u)
    assert.equal(resolveStateDir({ stateDir: '' }).startsWith(process.cwd()), false)
    delete process.env.DSH_HOME
    assert.match(resolveStateDir({ stateDir: '' }), /mini-kit$/u)
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})

test('write then read round-trips the sessions to resume', () => {
  const marker = createMarker({ stateDir: tempDir() })
  marker.write([
    { id: 's1', title: 'Fix the login page', workspace: 'Alpha', cwd: 'C:\\Work\\Alpha' },
    { id: 's2' },
  ])
  const pending = marker.read()
  assert.equal(pending.version, MARKER_VERSION)
  assert.equal(pending.sessions.length, 2)
  assert.deepEqual(pending.sessions[0], {
    id: 's1',
    title: 'Fix the login page',
    workspace: 'Alpha',
    cwd: 'C:\\Work\\Alpha',
  })
  assert.deepEqual(pending.sessions[1], { id: 's2', title: null, workspace: null, cwd: null })
})

test('claim consumes the marker so a failing resume cannot loop on the next boot', () => {
  const marker = createMarker({ stateDir: tempDir() })
  marker.write([{ id: 's1' }])
  const claimed = marker.claim()
  assert.equal(claimed.sessions.length, 1)
  assert.equal(marker.read(), null)
  assert.equal(existsSync(`${marker.file}.claimed`), true)
})

test('a wrong version, malformed JSON, or an empty id set is ignored rather than guessed at', () => {
  const marker = createMarker({ stateDir: tempDir() })

  writeFileSync(marker.file, JSON.stringify({ version: 99, sessions: [{ id: 's1' }] }), 'utf8')
  assert.equal(marker.read(), null)

  writeFileSync(marker.file, '{not json', 'utf8')
  assert.equal(marker.read(), null)

  writeFileSync(marker.file, JSON.stringify({ version: MARKER_VERSION, sessions: [{ id: '' }] }), 'utf8')
  assert.deepEqual(marker.read().sessions, [])
})

test('clear removes a marker written by a restart that never happened', () => {
  const marker = createMarker({ stateDir: tempDir() })
  marker.write([{ id: 's1' }])
  marker.clear()
  assert.equal(marker.read(), null)
})

test('the on-disk file is plain readable JSON', () => {
  const marker = createMarker({ stateDir: tempDir() })
  marker.write([{ id: 's1', title: 'T' }])
  const parsed = JSON.parse(readFileSync(marker.file, 'utf8'))
  assert.equal(parsed.sessions[0].id, 's1')
  assert.equal(typeof parsed.createdAt, 'number')
})
