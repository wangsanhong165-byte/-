import assert from 'node:assert/strict'
import test from 'node:test'

import { assistantPlaceholderForTurn } from './turn-messages.ts'

test('initiative turns get their own assistant message placeholder', () => {
  assert.deepEqual(
    assistantPlaceholderForTurn('initiative', 'turn-7', 1234),
    {
      id: 'assistant_turn-7',
      role: 'assistant',
      text: '',
      timestamp: 1234,
    },
  )
  assert.equal(assistantPlaceholderForTurn('user', 'turn-8', 1234), null)
})
