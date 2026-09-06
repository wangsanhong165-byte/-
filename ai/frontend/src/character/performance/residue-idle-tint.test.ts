import assert from 'node:assert/strict'
import test from 'node:test'
import {
  configureResidueRequest,
  getResidueProfile,
  refreshResidueTint,
  resetResidueForTests,
  residueEnergyScale,
  residuePoolEmotion,
} from './ResidueIdleTint.ts'

const MATCHED = {
  matched: true,
  label: 'playful_residue',
  idle_profile: { energy: 0.7, expression_hint: 'playful', gesture_tendency: 'bouncy' },
}

// Real-scale epoch base: _lastRefreshAt starts at 0, so small fake "now"
// values would fall inside the 90s throttle window and never fire.
const T = 1_700_000_000_000

test('refresh stores a matched profile', async () => {
  resetResidueForTests()
  configureResidueRequest(async () => ({ ...MATCHED }))
  assert.equal(await refreshResidueTint(T), true)
  assert.deepEqual(getResidueProfile(), {
    label: 'playful_residue',
    energy: 0.7,
    expressionHint: 'playful',
    gestureTendency: 'bouncy',
  })
})

test('throttled to one request per interval', async () => {
  resetResidueForTests()
  let calls = 0
  configureResidueRequest(async () => { calls += 1; return { matched: false } })
  assert.equal(await refreshResidueTint(T), false)
  assert.equal(await refreshResidueTint(T + 2000), false, 'inside interval → throttled')
  assert.equal(calls, 1)
  assert.equal(await refreshResidueTint(T + 90_001), false)
  assert.equal(calls, 2, 'past interval → fired again')
})

test('timeout abandons a hanging request and keeps the old tint', async () => {
  resetResidueForTests()
  configureResidueRequest(async () => ({ ...MATCHED }))
  assert.equal(await refreshResidueTint(T), true)
  const previous = getResidueProfile()
  configureResidueRequest(() => new Promise(() => {})) // never resolves
  assert.equal(await refreshResidueTint(T + 90_001, 10), false)
  assert.deepEqual(getResidueProfile(), previous)
})

test('matched=false clears the profile; errors keep it', async () => {
  resetResidueForTests()
  configureResidueRequest(async () => ({ ...MATCHED }))
  await refreshResidueTint(T)
  assert.ok(getResidueProfile())
  configureResidueRequest(async () => ({ matched: false }))
  await refreshResidueTint(T + 90_001)
  assert.equal(getResidueProfile(), null)
  configureResidueRequest(async () => { throw new Error('boom') })
  assert.equal(await refreshResidueTint(T + 180_002), false)
  assert.equal(getResidueProfile(), null)
})

test('energy scale maps profile energy around the 0.5 base', () => {
  assert.equal(residueEnergyScale(null), 1)
  assert.ok(Math.abs(residueEnergyScale({ label: 'x', energy: 0.3, expressionHint: 'worried', gestureTendency: 'tired' }) - 0.6) < 1e-9)
  assert.equal(residueEnergyScale({ label: 'x', energy: 0.5, expressionHint: 'neutral', gestureTendency: 'ambient' }), 1)
  assert.ok(Math.abs(residueEnergyScale({ label: 'x', energy: 0.7, expressionHint: 'playful', gestureTendency: 'bouncy' }) - 1.4) < 1e-9)
  assert.equal(residueEnergyScale({ label: 'x', energy: 0.95, expressionHint: 'playful', gestureTendency: 'bouncy' }), 1.5, 'clamped at 1.5')
})

test('pool emotion: segment emotion wins, residue hint is the base layer', () => {
  const profile = { label: 'x', energy: 0.5, expressionHint: 'playful', gestureTendency: 'bouncy' }
  assert.equal(residuePoolEmotion(profile, 'happy'), 'happy')
  assert.equal(residuePoolEmotion(profile, 'neutral'), 'playful')
  assert.equal(residuePoolEmotion(null, 'neutral'), 'neutral')
  assert.equal(residuePoolEmotion(null, ''), 'neutral')
})
