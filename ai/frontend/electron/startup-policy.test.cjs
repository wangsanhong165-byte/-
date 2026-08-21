const assert = require('node:assert/strict')
const test = require('node:test')

const { canEnterCompanion } = require('./startup-policy.cjs')

test('text ready is enough to enter companion; voice waits in background', () => {
  assert.equal(canEnterCompanion({ availability: 'BLOCKED' }), false)
  assert.equal(canEnterCompanion({ availability: 'TEXT_READY' }), true)
  assert.equal(canEnterCompanion({ availability: 'VOICE_READY' }), false)
  assert.equal(canEnterCompanion({ availability: 'FULL_READY' }), true)
})
