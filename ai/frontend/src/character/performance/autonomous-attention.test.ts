import assert from 'node:assert/strict'
import test from 'node:test'

import {
  AutonomousAttentionController,
  blendAttentionWithTracking,
  mergeAttentionSamples,
} from './AutonomousAttentionController.ts'

test('idle attention forms distinct eye-led episodes and returns control to tracking', () => {
  const attention = new AutonomousAttentionController(17)
  let starts = 0
  let previousEpisode = 0
  let sawEyeLead = false
  let released = false

  for (let frame = 0; frame < 60 * 60; frame += 1) {
    const sample = attention.update(1 / 60, { enabled: true, activity: 'idle' })
    if (sample.episode > previousEpisode) {
      starts += 1
      previousEpisode = sample.episode
    }
    if (sample.phase === 'acquire' && sample.channelWeights.gaze > sample.channelWeights.head) {
      sawEyeLead = true
    }
    if (starts > 0 && sample.phase === 'waiting' && sample.weight === 0) released = true
  }

  assert.ok(starts >= 3, `expected multiple attention episodes, got ${starts}`)
  assert.equal(sawEyeLead, true)
  assert.equal(released, true)
})

test('speaking or explicit focus cancels autonomous attention smoothly', () => {
  const attention = new AutonomousAttentionController(3)
  let active = false
  let activeWeight = 0
  for (let frame = 0; frame < 60 * 30; frame += 1) {
    const sample = attention.update(1 / 60, { enabled: true, activity: 'idle' })
    if (sample.weight > 0.2) {
      active = true
      activeWeight = sample.weight
      break
    }
  }
  assert.equal(active, true)

  let sample = attention.update(1 / 60, { enabled: false, activity: 'speaking' })
  const firstReleaseWeight = sample.weight
  assert.ok(firstReleaseWeight > 0)
  assert.ok(firstReleaseWeight <= activeWeight, 'cancellation must not jump toward full attention')
  for (let frame = 0; frame < 90; frame += 1) {
    sample = attention.update(1 / 60, { enabled: false, activity: 'speaking' })
  }
  assert.equal(sample.weight, 0)
})

test('speaking runs reduced-strength gaze episodes instead of none', () => {
  const attention = new AutonomousAttentionController(5)
  let sawEpisode = false
  let peakEyeX = 0
  let idlePeakEyeX = 0
  // Speaking: episodes must still occur (Neuro reference: gaze rhythm
  // continues during speech) but with smaller values than idle glances.
  for (let frame = 0; frame < 60 * 40 && !sawEpisode; frame += 1) {
    const sample = attention.update(1 / 60, { enabled: true, activity: 'speaking', strengthScale: 0.35 })
    peakEyeX = Math.max(peakEyeX, Math.abs(sample.values['eye.x'] ?? 0))
    if (sample.weight > 0.5) sawEpisode = true
  }
  assert.equal(sawEpisode, true, 'speaking must still produce gaze episodes')
  const idle = new AutonomousAttentionController(5)
  for (let frame = 0; frame < 60 * 40; frame += 1) {
    const sample = idle.update(1 / 60, { enabled: true, activity: 'idle' })
    idlePeakEyeX = Math.max(idlePeakEyeX, Math.abs(sample.values['eye.x'] ?? 0))
    if (idlePeakEyeX > 0.2) break
  }
  assert.ok(peakEyeX > 0, 'speaking episodes must emit eye values')
  assert.ok(peakEyeX < idlePeakEyeX * 0.6, `speaking glances (${peakEyeX.toFixed(2)}) must be visibly quieter than idle (${idlePeakEyeX.toFixed(2)})`)
})

test('mid-episode activity flips glide instead of jumping the gaze pose', () => {
  const attention = new AutonomousAttentionController(7)
  let peakHeadX = 0
  for (let frame = 0; frame < 60 * 40; frame += 1) {
    const sample = attention.update(1 / 60, { enabled: true, activity: 'idle' })
    peakHeadX = Math.max(peakHeadX, Math.abs(sample.values['head.x'] ?? 0))
    if (sample.weight >= 0.99) break
  }
  assert.ok(peakHeadX > 1, 'fixture must reach a real idle glance')
  let maxFrameDelta = 0
  for (let frame = 0; frame < 90; frame += 1) {
    const previous = attention.update(1 / 60, { enabled: true, activity: 'idle' }).values['head.x'] ?? 0
    const activity = frame < 30 ? 'speaking' : frame < 60 ? 'idle' : 'speaking'
    const strengthScale = activity === 'speaking' ? 0.35 : 1
    const current = attention.update(1 / 60, { enabled: true, activity, strengthScale }).values['head.x'] ?? 0
    maxFrameDelta = Math.max(maxFrameDelta, Math.abs(current - previous))
  }
  assert.ok(
    maxFrameDelta < 0.8,
    `activity flips must glide: worst per-frame head.x delta ${maxFrameDelta.toFixed(2)}`,
  )
})
test('attention release cross-fades back to the current tracking pose', () => {
  const tracking = { 'eye.x': 0.6, 'head.x': 10, 'head.y': -3 }
  const attention = { 'eye.x': -0.4, 'head.x': -5, 'head.y': 1 }
  const beforeThreshold = blendAttentionWithTracking(attention, tracking, 0.051)
  const afterThreshold = tracking

  assert.ok(Math.abs(beforeThreshold['head.x'] - afterThreshold['head.x']) < 1)
  assert.ok(Math.abs(beforeThreshold['eye.x'] - afterThreshold['eye.x']) < 0.1)
})

test('explicit attention takes over an autonomous hold without a threshold jump', () => {
  const autonomous = { values: { 'eye.x': 0.6, 'head.x': 5 }, weight: 1 }
  const initial = mergeAttentionSamples(
    { values: { 'eye.x': -0.35, 'head.x': -6 }, weight: 0.051 },
    autonomous,
  )
  const settled = mergeAttentionSamples(
    { values: { 'eye.x': -0.35, 'head.x': -6 }, weight: 1 },
    { values: autonomous.values, weight: 0 },
  )

  assert.ok(initial.values['head.x'] > 4, 'early explicit acquire must retain the current autonomous pose')
  assert.equal(settled.values['head.x'], -6)
  assert.equal(settled.weight, 1)
})

test('eye-led attention does not suppress tracking on a head-only model', () => {
  const tracking = { 'head.x': 10 }
  const attention = { 'head.x': -5 }
  const early = blendAttentionWithTracking(attention, tracking, 1, { head: 0.04, gaze: 0.8 })

  assert.ok(early['head.x'] > 9, 'gaze acquire must not borrow weight from a disabled eye channel')
})
