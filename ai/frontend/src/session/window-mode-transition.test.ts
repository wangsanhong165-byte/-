import assert from 'node:assert/strict'
import test from 'node:test'

import { persistAndApplyWindowMode } from './window-mode-transition.ts'

test('persists pet mode before rebuilding the Electron window', async () => {
  const calls: string[] = []

  await persistAndApplyWindowMode(
    { windowMode: 'window', voiceInputEnabled: true },
    'pet',
    {
      async persist(settings) {
        calls.push(`persist:${settings.windowMode}`)
      },
      async setPetMode(enabled) {
        calls.push(`apply:${enabled}`)
      },
    },
  )

  assert.deepEqual(calls, ['persist:pet', 'apply:true'])
})

test('does not rebuild when the authoritative settings save fails', async () => {
  let applied = false

  await assert.rejects(() => persistAndApplyWindowMode(
    { windowMode: 'window' },
    'pet',
    {
      async persist() {
        throw new Error('settings unavailable')
      },
      async setPetMode() {
        applied = true
      },
    },
  ), /settings unavailable/)

  assert.equal(applied, false)
})
