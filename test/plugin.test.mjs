import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { RESTART_COMMAND, registerCommands } from '../lib/commands.js'
import { createMarker } from '../lib/marker.js'
import { createRestarter } from '../lib/restart.js'
import { createSessionIndex } from '../lib/sessions.js'
import { registerTools } from '../lib/tools.js'
import { createFakeContext } from './helpers.mjs'

const NO_PARAMETER_TOOLS = ['list_running_sessions', 'restart_dsh']

/**
 * @param {object} [options]
 * @param {Array<object>} [options.sessions]
 * @param {boolean} [options.desktop]
 */
function setup(options = {}) {
  const fake = createFakeContext({
    sessions: options.sessions ?? [{ id: 's1', running: true, cwd: 'C:\\Work\\Alpha', title: 'Fix the login page' }],
    workspaces: [{ path: 'C:\\Work\\Alpha', title: 'Alpha' }],
  })
  const restarter = createRestarter({
    ctx: fake.ctx,
    config: {
      autoResume: true,
      resumePrompt: 'continue',
      resumeDelayMs: 10,
      cancelTimeoutMs: 500,
      quietWaitMs: 100,
      gracefulExitMs: 10,
      relaunchDelayMs: 1,
      stateDir: '',
    },
    index: createSessionIndex(fake.ctx),
    marker: createMarker({ stateDir: mkdtempSync(join(tmpdir(), 'dsh-mini-kit-plugin-')) }),
    facts: () =>
      options.desktop === false
        ? { supported: false, reason: 'not the desktop app' }
        : { supported: true, appExe: 'C:\\app\\DeepSeek Harness.exe', mainPid: 1, hostPid: 2 },
    launch: () => ({ ok: true, message: 'stub' }),
  })
  registerTools(fake.ctx, { index: createSessionIndex(fake.ctx), restarter })
  registerCommands(fake.ctx, { restarter })
  return { fake, restarter }
}

test('both tools are one line, take no parameters, and return text', () => {
  const { fake } = setup()
  assert.deepEqual(
    fake.tools.map((tool) => tool.name),
    NO_PARAMETER_TOOLS,
  )
  for (const tool of fake.tools) {
    assert.equal(tool.description.includes('\n'), false, `${tool.name} description must be one line`)
    assert.ok(tool.description.length <= 90, `${tool.name} description is too long to be free: ${tool.description.length}`)
    assert.deepEqual(tool.parameters, { type: 'object', properties: {}, additionalProperties: false })
    assert.deepEqual(tool.output.schema, { type: 'string' })
    assert.deepEqual(tool.output.render({}, 'hi'), [{ type: 'text', text: 'hi' }])
  }
})

test('list_running_sessions renders workspace / title and says so when nothing runs', async () => {
  const { fake } = setup()
  const listRunning = fake.tools.find((tool) => tool.name === 'list_running_sessions')
  assert.equal(await listRunning.execute({}, {}), '1 running session(s):\n- Alpha / Fix the login page')

  const idle = setup({ sessions: [{ id: 's1', running: false }] })
  const idleTool = idle.fake.tools.find((tool) => tool.name === 'list_running_sessions')
  assert.match(await idleTool.execute({}, {}), /No session is running/u)
})

test('restart_dsh reports the restart plan and passes the caller through', async () => {
  const { fake } = setup()
  const restart = fake.tools.find((tool) => tool.name === 'restart_dsh')
  const text = await restart.execute({}, { agent: { id: 's1' }, signal: new AbortController().signal })
  assert.match(text, /DSH will restart as soon as this turn ends/u)
  assert.match(text, /Alpha \/ Fix the login page/u)
})

test('the slash command is registered under the documented name', async () => {
  const { fake } = setup()
  assert.equal(fake.commands.length, 1)
  const [command] = fake.commands
  assert.equal(command.name, RESTART_COMMAND)
  assert.equal(command.description.includes('\n'), false)

  const result = await command.handler({ agent: { id: 's1' }, rawInput: '', attachments: [], signal: new AbortController().signal })
  assert.equal(result.kind, 'success')
  assert.match(result.text, /These sessions will continue after it reopens/u)
})

test('a command reports an unsupported platform as an error result, not a thrown one', async () => {
  const { fake } = setup({ desktop: false })
  const [command] = fake.commands
  const result = await command.handler({})
  assert.equal(result.kind, 'error')
  assert.match(result.text, /desktop app/u)
})
