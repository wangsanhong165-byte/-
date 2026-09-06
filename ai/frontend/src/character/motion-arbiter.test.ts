import assert from 'node:assert/strict'
import test from 'node:test'

import { MotionArbiter, sampleMotionKeyframes, type MotionPreset } from './MotionArbiter.ts'
import { NativeMotionPlayer } from './live2d/NativeMotionPlayer.ts'

const presets: Record<string, MotionPreset> = {
  nod: {
    name: 'nod',
    duration: 500,
    keyframes: [
      { time: 0, parameter: 'head.y', value: 0 },
      { time: 250, parameter: 'head.y', value: 4 },
      { time: 500, parameter: 'head.y', value: 0 },
    ],
  },
  sway: {
    name: 'sway',
    duration: 800,
    keyframes: [
      { time: 0, parameter: 'body.x', value: 0 },
      { time: 400, parameter: 'body.x', value: 3 },
      { time: 800, parameter: 'body.x', value: 0 },
    ],
  },
  fade: {
    name: 'fade',
    duration: 500,
    fadeInMs: 200,
    keyframes: [
      { time: 0, parameter: 'body.x', value: 4 },
      { time: 500, parameter: 'body.x', value: 0 },
    ],
  },
}

test('logical motions fade in from the model baseline', () => {
  let now = 0
  const arbiter = new MotionArbiter(() => now)
  arbiter.setPresets(presets)
  arbiter.request({ name: 'fade', owner: 'test:fade', source: 'system', priority: 20 })

  now = 100
  const contribution = arbiter.update(0)[0]
  assert.equal(contribution.value, 3.584)
  assert.equal(contribution.weight, 0.5)
})

test('motion curves carry non-zero velocity through same-direction keyframes', () => {
  const frames = [
    { time: 0, parameter: 'head.x', value: 0 },
    { time: 1000, parameter: 'head.x', value: 10 },
    { time: 2000, parameter: 'head.x', value: 20 },
  ]
  const before = sampleMotionKeyframes(frames, 990)['head.x']
  const at = sampleMotionKeyframes(frames, 1000)['head.x']
  const after = sampleMotionKeyframes(frames, 1010)['head.x']

  assert.ok(at - before > 0.05, 'incoming velocity must not collapse at the middle keyframe')
  assert.ok(after - at > 0.05, 'outgoing velocity must not restart from zero')
  assert.ok(Math.abs((at - before) - (after - at)) < 0.02)
})

test('motion curves do not overshoot a reversing keyframe', () => {
  const frames = [
    { time: 0, parameter: 'head.x', value: 0 },
    { time: 1000, parameter: 'head.x', value: 10 },
    { time: 2000, parameter: 'head.x', value: 0 },
  ]
  for (let time = 0; time <= 2000; time += 10) {
    const value = sampleMotionKeyframes(frames, time)['head.x']
    assert.ok(value >= 0 && value <= 10)
  }
})

test('motion requests coexist when their control channels do not overlap', () => {
  let now = 0
  const arbiter = new MotionArbiter(() => now)
  arbiter.setPresets(presets)

  assert.equal(arbiter.request({
    name: 'nod', owner: 'ai:head', source: 'ai', priority: 40,
    channels: ['head'], turnId: 'turn-1',
  }), true)
  assert.equal(arbiter.request({
    name: 'sway', owner: 'system:body', source: 'system', priority: 20,
    channels: ['body'], turnId: 'turn-1',
  }), true)

  now = 250
  const contributions = arbiter.update(0)
  assert.deepEqual(
    new Set(contributions.map(item => item.logicalParameter)),
    new Set(['head.y', 'body.x']),
  )
})

test('higher priority request preempts only overlapping channels', () => {
  const arbiter = new MotionArbiter(() => 0)
  arbiter.setPresets(presets)
  arbiter.request({
    name: 'nod', owner: 'ai:head', source: 'ai', priority: 40,
    channels: ['head'], turnId: 'turn-1',
  })
  arbiter.request({
    name: 'sway', owner: 'system:body', source: 'system', priority: 20,
    channels: ['body'], turnId: 'turn-1',
  })

  assert.equal(arbiter.request({
    name: 'nod', owner: 'idle:head', source: 'idle', priority: 10,
    channels: ['head'], turnId: 'turn-1',
  }), false)
  assert.equal(arbiter.request({
    name: 'nod', owner: 'ui:head', source: 'system', priority: 90,
    channels: ['head'], turnId: 'turn-2',
  }), true)

  const owners = arbiter.getDebugState().activeRequests.map(item => item.owner)
  assert.deepEqual(new Set(owners), new Set(['system:body', 'ui:head']))
})

test('turn cancellation fades the pose out and timeout releases ownership', () => {
  let now = 0
  const arbiter = new MotionArbiter(() => now)
  arbiter.setPresets(presets)
  arbiter.request({
    name: 'nod', owner: 'ai:head', source: 'ai', priority: 40,
    channels: ['head'], turnId: 'turn-1', timeoutMs: 100,
  })
  arbiter.request({
    name: 'sway', owner: 'system:body', source: 'system', priority: 20,
    channels: ['body'], turnId: 'turn-2',
  })

  assert.equal(arbiter.cancelTurn('turn-2'), 1)
  now = 101
  const fading = arbiter.update(0)
  // Cancelled motions glide out: decaying contributions instead of a snap.
  assert.ok(fading.length > 0, 'cancelled motion should emit fading contributions')
  assert.ok(fading.every(step => (step.weight ?? 0) > 0 && (step.weight ?? 1) < 1))
  assert.equal(arbiter.isPlaying(), false)
  now = 101 + 400
  assert.deepEqual(arbiter.update(0), [])
})

test('LLM motion preempts the lower-priority speaking background', () => {
  const arbiter = new MotionArbiter(() => 0)
  arbiter.setPresets(presets)
  assert.equal(arbiter.request({
    name: 'nod', owner: 'state:speaking', source: 'system', priority: 35,
    channels: ['head', 'body'], turnId: 'turn-1',
  }), true)
  assert.equal(arbiter.request({
    name: 'sway', owner: 'intent-plan:turn-1', source: 'ai', priority: 52,
    channels: ['full'], turnId: 'turn-1',
  }), true)
  assert.deepEqual(
    arbiter.getDebugState().activeRequests.map(item => item.owner),
    ['intent-plan:turn-1'],
  )
})

test('semantic motion can start after the previous thinking state releases its channels', () => {
  const arbiter = new MotionArbiter(() => 0)
  arbiter.setPresets(presets)
  assert.equal(arbiter.request({
    name: 'nod', owner: 'state:turn-1', source: 'system', priority: 55,
    channels: ['head', 'gaze'], turnId: 'turn-1',
  }), true)
  assert.equal(arbiter.request({
    name: 'sway', owner: 'intent-plan:turn-1', source: 'ai', priority: 52,
    channels: ['full'], turnId: 'turn-1',
  }), false)

  assert.equal(arbiter.releaseState('turn-1'), true)
  assert.equal(arbiter.request({
    name: 'sway', owner: 'intent-plan:turn-1', source: 'ai', priority: 52,
    channels: ['full'], turnId: 'turn-1',
  }), true)
})

test('active motion ownership is exposed per channel instead of suppressing all tracking', () => {
  const arbiter = new MotionArbiter(() => 0)
  arbiter.setPresets(presets)
  arbiter.request({
    name: 'sway', owner: 'system:body', source: 'system', priority: 20,
    channels: ['body'],
  })

  assert.equal(arbiter.ownsChannel('body'), true)
  assert.equal(arbiter.ownsChannel('head'), false)
  assert.equal(arbiter.ownsChannel('gaze'), false)
  assert.deepEqual(arbiter.getActiveChannels(), ['body'])
})

test('profile-scoped secondary native idle coexists with live head and gaze control', () => {
  const player = new NativeMotionPlayer()
  player.register('Idle', {
    Meta: { Duration: 1, Loop: true },
    Curves: [{ Target: 'Parameter', Id: 'ParamRibbon', Segments: [0, 0, 0, 1, 1] }],
  })
  const arbiter = new MotionArbiter(() => 0)
  arbiter.setNativeMotionPlayer(
    player,
    { idle: 'Idle' },
    { idle: ['secondary'] },
  )

  assert.equal(arbiter.request({
    name: 'idle', owner: 'idle:native', source: 'idle', priority: 10,
  }), true)
  assert.equal(arbiter.ownsExclusiveChannel('head'), false)
  assert.equal(arbiter.ownsExclusiveChannel('gaze'), false)
  assert.deepEqual(arbiter.getActiveChannels(), ['secondary'])
})

test('preempted logical motion crossfades out instead of disappearing in one frame', () => {
  let now = 0
  const arbiter = new MotionArbiter(() => now)
  arbiter.setPresets(presets)
  arbiter.request({
    name: 'sway', owner: 'state:body', source: 'system', priority: 20,
    channels: ['body'], turnId: 'turn-1',
  })
  now = 400
  const before = arbiter.update(0).find(item => item.logicalParameter === 'body.x')
  assert.ok(before && before.value > 2.5)

  assert.equal(arbiter.request({
    name: 'sway', owner: 'intent:body', source: 'ai', priority: 50,
    channels: ['body'], turnId: 'turn-1',
  }), true)
  const handoff = arbiter.update(0).filter(item => item.logicalParameter === 'body.x')
  assert.ok(handoff.some(item => item.source.includes('state:body') && (item.weight ?? 0) > 0.9))

  now += 140
  const releasing = arbiter.update(0).filter(item => item.logicalParameter === 'body.x')
  assert.ok(releasing.some(item => item.source.includes('state:body') && (item.weight ?? 0) > 0))
  now += 220
  assert.equal(
    arbiter.update(0).some(item => item.source.includes('state:body')),
    false,
  )
})

test('preemption preserves the currently faded-in strength instead of jumping to full pose', () => {
  let now = 0
  const arbiter = new MotionArbiter(() => now)
  arbiter.setPresets(presets)
  arbiter.request({
    name: 'sway', owner: 'state:body', source: 'system', priority: 20,
    channels: ['body'], turnId: 'turn-1', intensity: 0.5,
  })
  now = 90
  const before = arbiter.update(0).find(item => item.logicalParameter === 'body.x')!

  arbiter.request({
    name: 'sway', owner: 'intent:body', source: 'ai', priority: 50,
    channels: ['body'], turnId: 'turn-1',
  })
  const released = arbiter.update(0).find(item =>
    item.logicalParameter === 'body.x' && item.source.includes('state:body'))!

  assert.ok(Math.abs(before.value * (before.weight ?? 1) - released.value * (released.weight ?? 1)) < 0.0001)
})

// --- Mirror alternation -------------------------------------------------------
// Directional presets must alternate left/right across plays (the "always
// leans right" fix). The sign of yaw/roll axes flips while pitch is kept.

test('logical plays alternate a left/right mirror: yaw/roll flip, pitch kept', () => {
  const directional: MotionPreset = {
    name: 'directional',
    duration: 400,
    keyframes: [
      { time: 0, parameter: 'head.x', value: 0 },
      { time: 200, parameter: 'head.x', value: 5 },
      { time: 400, parameter: 'head.x', value: 0 },
      { time: 0, parameter: 'head.z', value: 0 },
      { time: 200, parameter: 'head.z', value: 3 },
      { time: 400, parameter: 'head.z', value: 0 },
      { time: 0, parameter: 'head.y', value: 0 },
      { time: 200, parameter: 'head.y', value: -2 },
      { time: 400, parameter: 'head.y', value: 0 },
    ],
  }
  let now = 0
  const arbiter = new MotionArbiter(() => now)
  arbiter.setPresets({ directional })

  const peak = (): { x: number; z: number; y: number } => {
    now += 200
    const contributions = arbiter.update(0)
    const find = (parameter: string) =>
      contributions.find(item => item.logicalParameter === parameter)?.value ?? 0
    return { x: find('head.x'), z: find('head.z'), y: find('head.y') }
  }

  // Three consecutive plays (distinct owners so each gets its own slot):
  // play #1 unmirrored, #2 mirrored, #3 unmirrored again. Between plays the
  // clock advances past duration+recovery so the previous motion is gone
  // before the next request (otherwise update() cancels the expired entry
  // mid-frame and the "contribution" read is from an already-dead play).
  arbiter.request({ name: 'directional', owner: 'a', source: 'ai', priority: 50 })
  const first = peak()
  now += 1000 // past 400ms duration + 600ms recovery ceiling
  arbiter.update(0)

  arbiter.request({ name: 'directional', owner: 'b', source: 'ai', priority: 50 })
  const second = peak()
  now += 1000
  arbiter.update(0)

  arbiter.request({ name: 'directional', owner: 'c', source: 'ai', priority: 50 })
  const third = peak()

  assert.ok(first.x > 0 && second.x < 0 && third.x > 0,
    `yaw must alternate: ${first.x} / ${second.x} / ${third.x}`)
  assert.ok(first.z > 0 && second.z < 0 && third.z > 0,
    `roll must alternate: ${first.z} / ${second.z} / ${third.z}`)
  // Pitch (head.y) is the same gesture both ways — it must NOT flip.
  assert.ok(Math.abs(first.y - second.y) < 0.0001,
    `pitch must be kept, not mirrored: ${first.y} vs ${second.y}`)
})
