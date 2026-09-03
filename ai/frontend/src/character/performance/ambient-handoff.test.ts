import assert from 'node:assert/strict'
import test from 'node:test'

import {
  AmbientPerformanceEngine,
  approachPose,
  type AmbientPerformanceChannel,
  type AmbientPerformanceInput,
} from './AmbientPerformanceEngine.ts'

function speechInput(audioLevel: number): AmbientPerformanceInput {
  return {
    emotion: 'neutral',
    vad: { valence: 0.2, arousal: 0.3, dominance: 0 },
    audioLevel,
    enabled: true,
    blockedChannels: new Set<AmbientPerformanceChannel>(),
    tracking: {},
    gain: 1,
  }
}

test('speaking to idle activity switch never snaps the pose between frames', () => {
  const engine = new AmbientPerformanceEngine(11)
  engine.setActivity('speaking')
  let current = 0
  // Settle into the speaking rhythm first.
  for (let frame = 0; frame < 240; frame += 1) {
    const frameOut = engine.update(1 / 60, speechInput(0.8))
    current = Math.max(current, Math.abs(frameOut.values['head.x'] ?? 0))
  }
  assert.ok(current > 0.5, 'fixture must reach a visible speaking pose')
  // Baseline from the LAST rendered frame, not the settle peak — comparing
  // against a sinusoid peak manufactured phantom 3° deltas at phase shifts.
  current = Math.abs(engine.update(1 / 60, speechInput(0.8)).values['head.x'] ?? 0)
  let maxDelta = 0
  for (let frame = 0; frame < 120; frame += 1) {
    const activity = frame < 60 ? 'idle' : frame < 90 ? 'speaking' : 'idle'
    engine.setActivity(activity)
    const values = engine.update(
      1 / 60,
      speechInput(activity === 'speaking' ? 0.8 : 0),
    ).values
    const next = Math.abs(values['head.x'] ?? 0)
    maxDelta = Math.max(maxDelta, Math.abs(next - current))
    current = next
  }
  // approachPose bounds the ambient layer at ~8.3% of pose per frame (attack
  // 5.2/s at 60fps); with ≤5° speaking poses the bound is well under 0.75°.
  assert.ok(
    maxDelta <= 0.75,
    `activity switch must glide: worst per-frame head.x delta ${maxDelta.toFixed(3)}`,
  )
})

test('whole speaking-to-idle transition stays under per-frame motion bound', () => {
  const engine = new AmbientPerformanceEngine(12)
  engine.setActivity('speaking')
  for (let frame = 0; frame < 240; frame += 1) {
    engine.update(1 / 60, speechInput(0.8))
  }
  let maxDelta = 0
  let previous = Math.abs(engine.update(1 / 60, speechInput(0.8)).values['body.x'] ?? 0)
  for (let frame = 0; frame < 180; frame += 1) {
    const activity = frame < 90 ? 'speaking' : 'idle'
    engine.setActivity(activity)
    const values = engine.update(
      1 / 60,
      speechInput(activity === 'speaking' ? 0.8 : 0),
    ).values
    const next = Math.abs(values['body.x'] ?? 0)
    maxDelta = Math.max(maxDelta, Math.abs(next - previous))
    previous = next
  }
  assert.ok(
    maxDelta <= 0.75,
    `body must stay continuous across the boundary: ${maxDelta.toFixed(3)}`,
  )
})

test('post-switch handoff slows the release direction without touching attack', () => {
  const pose = { 'head.x': 4.8 }
  const center = { 'head.x': 0.5 }
  const glideDelta = Math.abs(
    approachPose(pose, center, 1 / 60, true)['head.x'] - pose['head.x'],
  )
  const fastDelta = Math.abs(
    approachPose(pose, center, 1 / 60, false)['head.x'] - pose['head.x'],
  )
  assert.ok(
    glideDelta > 0 && glideDelta < fastDelta * 0.6,
    `handoff must glide: glide ${glideDelta.toFixed(3)} vs normal ${fastDelta.toFixed(3)}`,
  )
  const growing = approachPose({ 'head.x': 0.5 }, { 'head.x': 4.8 }, 1 / 60, true)
  assert.ok(
    growing['head.x'] > 0.85,
    'attack direction keeps its crisp response even in the handoff window',
  )
})

test('segment emotion holds a distinct body stance (pout turns away and stays)', () => {
  const engine = new AmbientPerformanceEngine(31)
  const emoInput = (emotion: string): AmbientPerformanceInput => ({
    emotion,
    vad: { valence: -0.4, arousal: 0.2, dominance: -0.3 },
    audioLevel: 0,
    enabled: true,
    blockedChannels: new Set<AmbientPerformanceChannel>(),
    tracking: {},
    gain: 1,
  })

  // Sample each phase from a freshly reset engine: the idle sway trajectory
  // is seeded, so resetting makes the neutral baseline identical across
  // samples and the measured delta isolates the emotion pose itself.
  const sample = (emotion: string, frames: number): Record<string, number> => {
    engine.reset()
    engine.setActivity('idle')
    for (let frame = 0; frame < frames; frame += 1) {
      engine.update(1 / 60, emoInput(emotion))
    }
    return engine.update(1 / 60, emoInput(emotion)).values
  }

  const neutral = sample('neutral', 120)
  const pout = sample('pout', 120)
  const zDelta = (pout['head.z'] ?? 0) - (neutral['head.z'] ?? 0)
  const bodyDelta = (pout['body.x'] ?? 0) - (neutral['body.x'] ?? 0)
  // pout holds a turned-away stance: head.z ~ -3, body.x ~ -2, both as a
  // DELTA from the same fresh baseline (absolute values drift with idle sway).
  assert.ok(zDelta < -1.5 && zDelta > -4.5, `pout head.z delta ${zDelta.toFixed(2)} (expect ~-3)`)
  assert.ok(bodyDelta < -0.8 && bodyDelta > -3.2, `pout body.x delta ${bodyDelta.toFixed(2)} (expect ~-2)`)

  // Melting back to neutral recovers the fresh baseline within a small window.
  const back = sample('neutral', 120)
  const zBack = (back['head.z'] ?? 0) - (neutral['head.z'] ?? 0)
  assert.ok(Math.abs(zBack) < 1.0, `stance must melt back on neutral (z delta ${zBack.toFixed(2)})`)
})