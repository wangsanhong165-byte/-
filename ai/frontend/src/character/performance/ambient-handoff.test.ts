import assert from 'node:assert/strict'
import test from 'node:test'

import { AmbientPerformanceEngine, approachPose } from './AmbientPerformanceEngine.ts'

function speechInput(activity: string) {
  return {
    activity,
    emotion: 'neutral',
    vad: { valence: 0.2, arousal: 0.3, dominance: 0 },
    audioLevel: activity === 'speaking' ? 0.8 : 0,
    enabled: true,
    blockedChannels: new Set(),
    tracking: {},
    trackingEngagement: 0,
    explicitAttention: { values: {}, weight: 0 },
    canControlHead: true,
    canControlGaze: true,
    gain: 1,
  }
}

test('speaking to idle activity switch never snaps the pose between frames', () => {
  const engine = new AmbientPerformanceEngine(11)
  let current = 0
  // Settle into the speaking rhythm first.
  for (let frame = 0; frame < 240; frame += 1) {
    const frameOut = engine.update(1 / 60, speechInput('speaking'))
    current = Math.max(current, Math.abs(frameOut.values['head.x'] ?? 0))
  }
  assert.ok(current > 0.5, 'fixture must reach a visible speaking pose')
  let maxDelta = 0
  for (let frame = 0; frame < 120; frame += 1) {
    const activity = frame < 60 ? 'idle' : frame < 90 ? 'speaking' : 'idle'
    const values = engine.update(1 / 60, speechInput(activity)).values
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
  for (let frame = 0; frame < 240; frame += 1) {
    engine.update(1 / 60, speechInput('speaking'))
  }
  let maxDelta = 0
  let previous = Math.abs(engine.update(1 / 60, speechInput('speaking')).values['body.x'] ?? 0)
  for (let frame = 0; frame < 180; frame += 1) {
    const activity = frame < 90 ? 'speaking' : 'idle'
    const values = engine.update(1 / 60, speechInput(activity)).values
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