import assert from 'node:assert/strict'
import test from 'node:test'

import { SpeechPerformanceController } from './SpeechPerformanceController.ts'

test('speech posture visibly recruits head and torso without discontinuous frames', () => {
  const speech = new SpeechPerformanceController()
  speech.configure({ speechAccentGain: 1.08 })
  speech.setSpeaking(true)
  let previous = speech.update(1 / 60, 0)
  let headPeak = 0
  let bodyPeak = 0
  let maxDelta = 0
  for (let frame = 1; frame < 360; frame += 1) {
    const level = 0.16 + Math.max(0, Math.sin(frame * 0.21)) * 0.28
    const sample = speech.update(1 / 60, level)
    headPeak = Math.max(headPeak, Math.abs(sample.headX), Math.abs(sample.headY), Math.abs(sample.headZ))
    bodyPeak = Math.max(bodyPeak, Math.abs(sample.bodyX), Math.abs(sample.bodyY))
    maxDelta = Math.max(
      maxDelta,
      Math.abs(sample.headX - previous.headX),
      Math.abs(sample.headY - previous.headY),
      Math.abs(sample.bodyX - previous.bodyX),
    )
    previous = sample
  }

  assert.ok(headPeak >= 2.1, `speech head peak too subtle: ${headPeak}`)
  assert.ok(bodyPeak >= 0.9, `speech torso peak too subtle: ${bodyPeak}`)
  assert.ok(maxDelta < 1.1, `speech frame delta is too abrupt: ${maxDelta}`)
})

test('speech posture releases over time instead of snapping to neutral', () => {
  const speech = new SpeechPerformanceController()
  speech.setSpeaking(true)
  for (let frame = 0; frame < 90; frame += 1) speech.update(1 / 60, 0.35)
  speech.setSpeaking(false)
  const first = speech.update(1 / 60, 0)
  assert.ok(first.weight > 0.5)
  let final = first
  for (let frame = 0; frame < 45; frame += 1) final = speech.update(1 / 60, 0)
  assert.equal(final.state, 'idle')
  assert.ok(Math.abs(final.headX) < 0.01)
  assert.ok(Math.abs(final.bodyX) < 0.01)
})

test('head re-posing is accent-gated: a flat level never re-poses, a rising onset does', () => {
  // Deterministic seeded instance, driven by a scripted envelope.
  const speech = new SpeechPerformanceController(7)
  speech.setSpeaking(true)

  // Phase 1: constant mid level — no syllable onsets. The first pick happens
  // at t=0; the spring needs ~1.5s to arrive (0.48Hz near-critically
  // damped), so sample the SETTLED window t=2.0-2.1s: a flat level cannot
  // have re-posed the head, and the spring is done moving — any change here
  // is a re-pose, full stop. The first hold (2.2-4.5s) has not expired, so
  // no grace re-pick is legal either.
  for (let i = 0; i < 126; i += 1) speech.update(1 / 60, 0.3)
  const settledX = speech.update(1 / 60, 0.3).headX
  const stillX = speech.update(1 / 60, 0.3).headX
  assert.ok(
    Math.abs(stillX - settledX) < 0.05,
    `flat voice level re-posed the head (${settledX.toFixed(3)} -> ${stillX.toFixed(3)})`,
  )

  // Phase 2: an onset (0.2 -> 0.6 in one frame) is a prosodic accent — a new
  // stance is picked now, and the spring must be visibly MOVING toward it
  // within ~0.3s.
  speech.update(1 / 60, 0.6)
  let moved = 0
  for (let i = 0; i < 18; i += 1) {
    const sample = speech.update(1 / 60, 0.55)
    moved = Math.max(moved, Math.abs(sample.headX - stillX))
  }
  assert.ok(
    moved > 0.05,
    `an accent onset must commit the head toward a new stance (moved only ${moved.toFixed(3)})`,
  )
})
