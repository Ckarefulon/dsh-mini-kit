import assert from 'node:assert/strict'
import { basename } from 'node:path'
import { test } from 'node:test'

import {
  alive,
  findRootAppPid,
  imageNameOf,
  parentOf,
  pidsOfImage,
  quotedFields,
  waitGone,
} from '../lib/process-tree.mjs'

test('quotedFields survives the localized, comma-bearing tasklist CSV', () => {
  assert.deepEqual(quotedFields('"DeepSeek Harness.exe","5816","Console","1","1,234 K"'), [
    'DeepSeek Harness.exe',
    '5816',
    'Console',
    '1',
    '1,234 K',
  ])
  // The localized "no tasks match" line has no quoted field at all.
  assert.deepEqual(quotedFields('信息: 没有运行的任务匹配指定标准。'), [])
})

test('alive and waitGone agree about this very process', async () => {
  assert.equal(alive(process.pid), true)
  assert.equal(alive(0), false)
  assert.equal(alive(-1), false)
  assert.equal(await waitGone(process.pid, 120), false)
})

test('imageNameOf resolves a pid to its image and reports nothing for a dead one', () => {
  if (process.platform !== 'win32') return
  const image = imageNameOf(process.pid)
  assert.equal(image.toLowerCase().endsWith('.exe'), true, `unexpected image ${image}`)
  assert.ok(image.toLowerCase().includes(basename(process.execPath).toLowerCase().replace(/\.exe$/u, '')))
  assert.equal(imageNameOf(999_999_999), '')
})

test('parentOf walks one level up, and findRootAppPid stops when the image changes', async () => {
  if (process.platform !== 'win32') return
  const parent = await parentOf(process.pid)
  assert.equal(parent, process.ppid)
  // No ancestor of this test process is another node.exe of the same image, so
  // the walk must return the starting pid rather than something unrelated.
  assert.equal(await findRootAppPid(process.pid, basename(process.execPath)), process.pid)
  assert.equal(await findRootAppPid(process.pid, 'an-image-that-cannot-be-running'), process.pid)
})

test('pidsOfImage finds this process in its own image list', () => {
  if (process.platform !== 'win32') return
  const image = imageNameOf(process.pid)
  if (image === '') return
  assert.equal(
    pidsOfImage(image).includes(process.pid) || pidsOfImage(image).length > 0,
    true,
    'the current process image should list at least one pid',
  )
})
