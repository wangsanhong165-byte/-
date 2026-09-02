import assert from 'node:assert/strict'
import test from 'node:test'

import {
  compileMotionAction,
  compileMotionPlanForModel,
  MOTION_PRIMITIVES,
  normalizeLogicalMotionPresets,
  normalizeMotionAction,
  validateMotionPlan,
} from './MotionAction.ts'
import { MotionArbiter, sampleMotionKeyframes } from './MotionArbiter.ts'

test('motion plan rejects renderer parameters and unknown primitives', () => {
  const result = validateMotionPlan({
    durationMs: 1200,
    steps: [
      { atMs: 0, durationMs: 500, primitive: 'nod', intensity: 0.7 },
      { atMs: 100, durationMs: 400, primitive: 'ParamAngleX', intensity: 1 },
    ],
    keyframes: [{ parameter: 'mouth.open', time: 0, value: 1 }],
  })

  assert.equal(result.ok, false)
  assert.match(result.errors.join(' '), /primitive|keyframes|mouth|renderer/i)
})

test('normalizes an authored action and compiles primitives to safe logical keyframes', () => {
  const action = normalizeMotionAction({
    version: 1,
    id: 'gentle_agree',
    name: 'Gentle Agree',
    durationMs: 1400,
    steps: [
      { atMs: 0, durationMs: 700, primitive: 'lean_forward', intensity: 0.25 },
      { atMs: 350, durationMs: 650, primitive: 'nod', intensity: 0.6 },
    ],
  })

  assert.equal(action.id, 'gentle_agree')
  assert.equal(action.steps.length, 2)
  const preset = compileMotionAction(action)
  assert.equal(preset.name, 'gentle_agree')
  assert.equal(preset.duration, 1400)
  assert.ok(preset.keyframes.some(frame => frame.parameter === 'body.y'))
  assert.ok(preset.keyframes.some(frame => frame.parameter === 'head.y'))
  assert.equal(preset.keyframes.some(frame => frame.parameter.startsWith('mouth.')), false)
  assert.equal(preset.keyframes.every(frame => frame.time >= 0 && frame.time <= 1400), true)
})

test('overlapping action steps compose into one continuous parameter track', () => {
  const action = normalizeMotionAction({
    version: 1,
    id: 'double_lean',
    name: 'Double lean',
    durationMs: 1200,
    steps: [
      { atMs: 0, durationMs: 1000, primitive: 'lean_forward', intensity: 0.5 },
      { atMs: 0, durationMs: 1000, primitive: 'lean_forward', intensity: 0.5 },
    ],
  })
  const preset = compileMotionAction(action)
  const peak = sampleMotionKeyframes(preset.keyframes, 300)
  const trackKeys = preset.keyframes.map(frame => `${frame.parameter}:${frame.time}`)

  assert.equal(peak['body.y'], 6)
  assert.equal(peak['head.y'], 3)
  assert.equal(new Set(trackKeys).size, trackKeys.length)
})

test('motion plans are bounded in duration, step count, and intensity', () => {
  const result = validateMotionPlan({
    durationMs: 99_000,
    steps: Array.from({ length: 20 }, (_, index) => ({
      atMs: index * 100,
      durationMs: 100,
      primitive: 'nod',
      intensity: 8,
    })),
  })

  assert.equal(result.ok, false)
  assert.match(result.errors.join(' '), /duration|steps|intensity/i)
})

test('LLM plans stay concise without truncating authored multi-step actions', () => {
  const steps = Array.from({ length: 4 }, (_, index) => ({
    atMs: index * 300,
    durationMs: 300,
    primitive: index % 2 === 0 ? 'nod' : 'tilt_left',
    intensity: 0.45,
  }))
  assert.equal(validateMotionPlan({ durationMs: 1200, steps }).ok, false)
  const action = normalizeMotionAction({
    version: 1,
    id: 'authored_sequence',
    name: 'Authored sequence',
    durationMs: 1200,
    steps,
  })
  assert.equal(action.steps.length, 4)
})

test('unrigged appendage gestures are not advertised as safe primitives', () => {
  assert.equal(MOTION_PRIMITIVES.includes('arm_wave' as never), false)
  assert.equal(MOTION_PRIMITIVES.includes('tail_sway' as never), false)
  assert.throws(() => normalizeMotionAction({
    version: 1,
    id: 'old_fake_wave',
    name: 'Old fake wave',
    durationMs: 1000,
    steps: [{ atMs: 0, durationMs: 800, primitive: 'arm_wave', intensity: 0.8 }],
  }), /primitive/i)
})

test('Design Genius compiler adds restrained torso load without writing physics outputs', () => {
  const preset = compileMotionPlanForModel({
    durationMs: 900,
    steps: [{ atMs: 0, durationMs: 700, primitive: 'nod', intensity: 0.7 }],
  }, 'ai_turn', 'Design_genius_White')

  assert.ok(preset)
  assert.ok(preset!.keyframes.some(frame => frame.parameter === 'body.y'))
  assert.equal(preset!.keyframes.some(frame => frame.parameter.startsWith('Param')), false)
  assert.equal(preset!.keyframes.some(frame => frame.parameter.includes('tail')), false)
})

test('shirone tail coupling remains part of the body channel instead of seizing full motion', () => {
  const compiled = compileMotionPlanForModel({
    durationMs: 1_000,
    steps: [{ atMs: 0, durationMs: 600, primitive: 'tilt_left', intensity: 0.5 }],
  }, 'shirone-tail', 'shirone')!
  const arbiter = new MotionArbiter(() => 0)
  arbiter.registerPreset(compiled)
  assert.equal(arbiter.request({
    name: compiled.name,
    owner: 'intent:shirone',
    source: 'ai',
    priority: 50,
  }), true)

  assert.deepEqual(arbiter.getActiveChannels().sort(), ['body', 'head'])
})

test('model-authored logical timelines allow staggered multi-channel gestures without renderer IDs', () => {
  const presets = normalizeLogicalMotionPresets([{
    name: 'hand_on_head',
    duration: 1_800,
    recoveryMs: 520,
    keyframes: [
      { time: 0, parameter: 'head.z', value: 0 },
      { time: 180, parameter: 'head.z', value: -2 },
      { time: 0, parameter: 'arm.right.upper', value: 0 },
      { time: 420, parameter: 'arm.right.upper', value: -14 },
      { time: 0, parameter: 'hand.right', value: 0 },
      { time: 700, parameter: 'hand.right', value: 10 },
    ],
  }])

  assert.equal(presets.length, 1)
  assert.deepEqual(
    new Set(presets[0].keyframes.map(frame => frame.parameter)),
    new Set(['head.z', 'arm.right.upper', 'hand.right']),
  )
  assert.equal(normalizeLogicalMotionPresets([{
    name: 'unsafe',
    duration: 900,
    keyframes: [
      { time: 0, parameter: 'ParamAngleX', value: 0 },
      { time: 900, parameter: 'ParamAngleX', value: 20 },
    ],
  }]).length, 0)
})
