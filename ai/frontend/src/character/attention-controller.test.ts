// Regression test for the "thinking 态闪现回正" report. The away glance
// (controllers.ts:646 attention.set('away', 2400) on every thinking entry) must
// glide back out at the same tempo it turned in — expiry used to zero the
// offset in a single frame (AttentionController.update returned centered
// values with a decaying weight, which fades nothing).
import assert from 'node:assert/strict'
import test from 'node:test'

import { AttentionController } from './performance/AttentionController.ts'

test('away attention glides back out instead of teleporting to center on expiry', () => {
  const attention = new AttentionController(1)
  const dt = 1 / 60
  attention.set('away', 2400)

  const offsets: Array<{ t: number; value: number }> = []
  for (let frame = 0; frame < Math.round(4.0 / dt); frame += 1) {
    const sample = attention.update(dt)
    offsets.push({ t: frame * dt, value: Math.abs((sample.values['head.x'] ?? 0) * sample.weight) })
  }

  const peak = Math.max(...offsets.map(item => item.value))
  const peakIndex = offsets.findIndex(item => item.value === peak)
  // The glance must actually turn the head (rise) before the expiry beat.
  assert.ok(peak > 3.5, `away glance should reach ~4.2deg, peaked at ${peak.toFixed(2)}`)

  let maxStep = 0
  let maxStepAt = 0
  for (let index = 1; index < offsets.length; index += 1) {
    const step = Math.abs(offsets[index]!.value - offsets[index - 1]!.value)
    if (step > maxStep) {
      maxStep = step
      maxStepAt = offsets[index]!.t
    }
  }
  // rate 2.6 on a 4.2deg offset yields <= ~0.19deg per frame.
  assert.ok(
    maxStep <= 0.4,
    `attention offset jumped ${maxStep.toFixed(3)}deg in one frame at t=${maxStepAt.toFixed(2)}s`,
  )

  // The full return must be readable — roughly the mirror of the ~1s rise —
  // not instant and not a second slow stare.
  const settle = offsets.find(item => item.t > peakIndex * dt && item.value < peak * 0.05)
  assert.ok(settle, 'away offset never settles back to center')
  const returnSeconds = settle!.t - peakIndex * dt
  assert.ok(
    returnSeconds > 0.5 && returnSeconds < 2.2,
    `return took ${returnSeconds.toFixed(2)}s, expected a readable ~1s glide`,
  )
})

test('a fresh away set during the fade resumes the glance without stale offsets', () => {
  const attention = new AttentionController(1)
  const dt = 1 / 60
  attention.set('away', 600)
  for (let frame = 0; frame < Math.round(1.2 / dt); frame += 1) attention.update(dt)

  attention.set('away', 2400)
  const samples: Array<{ t: number; value: number }> = []
  for (let frame = 0; frame < Math.round(5.0 / dt); frame += 1) {
    const sample = attention.update(dt)
    samples.push({ t: 1.2 + frame * dt, value: Math.abs((sample.values['head.x'] ?? 0) * sample.weight) })
  }
  const peak = Math.max(...samples.map(item => item.value))
  assert.ok(peak > 3.5, `re-issued glance should rise again, peaked at ${peak.toFixed(2)}`)

  let maxStep = 0
  for (let index = 1; index < samples.length; index += 1) {
    maxStep = Math.max(maxStep, Math.abs(samples[index]!.value - samples[index - 1]!.value))
  }
  assert.ok(maxStep <= 0.4, `re-issued glance jumped ${maxStep.toFixed(3)}deg in one frame`)
})
