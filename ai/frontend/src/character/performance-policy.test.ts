import assert from 'node:assert/strict'
import test from 'node:test'

import { isPerFrameGazeLoggingEnabled } from './performance-policy.ts'
import { CharacterPerformancePolicy } from './CharacterPerformancePolicy.ts'
import type { AvatarCapabilityProfile } from './AvatarCapabilityProfile.ts'
import { CharacterBehaviorResolver, type CharacterBehaviorConfig } from './CharacterBehaviorResolver.ts'

test('per-frame gaze logging is disabled unless diagnostics explicitly enable it', () => {
  assert.equal(isPerFrameGazeLoggingEnabled(undefined), false)
  assert.equal(isPerFrameGazeLoggingEnabled(false), false)
  assert.equal(isPerFrameGazeLoggingEnabled(true), true)
})

test('Design_genius_White semantics use honest executable gestures', () => {
  const profile: AvatarCapabilityProfile = {
    model: 'Design_genius_White',
    expressions: [],
    motions: ['tilt', 'nod', 'sway'],
    sequences: ['greet'],
    parameters: {},
    bindings: {},
    semanticMotionMap: { greet: 'tilt', wave: 'sway', agree: 'nod' },
  }
  const config: CharacterBehaviorConfig = {}
  const plan = new CharacterPerformancePolicy().evaluate(
    { emotion: 'happy', behavior: 'greet', intensity: 0.8, energy: 0.7 },
    { expression: 'happy', expressionIntensity: 0.8, motion: 'wave', motionIntensity: 0.7, suppressIdle: false },
    config,
    profile,
  )

  assert.equal(plan.motion, 'tilt')

  const touchPlan = new CharacterPerformancePolicy().evaluate(
    { emotion: 'happy', behavior: 'agree', intensity: 0.5, energy: 0.4 },
    { expression: 'happy', expressionIntensity: 0.5, motion: 'nod', motionIntensity: 0.4, suppressIdle: false },
    config,
    profile,
  )
  assert.equal(touchPlan.motion, 'nod')
})

test('direct interactions always deliver their mapped reaction motion', () => {
  const profile: AvatarCapabilityProfile = {
    model: 'Design_genius_White',
    expressions: [],
    motions: ['nod'],
    sequences: [],
    parameters: {},
    bindings: {},
    semanticMotionMap: { agree: 'nod' },
  }
  const plan = new CharacterPerformancePolicy().evaluate(
    {
      emotion: 'happy',
      behavior: 'agree',
      intensity: 0.42,
      energy: 0.4,
      contextTags: ['interaction', 'touch'],
    },
    { expression: 'happy', expressionIntensity: 0.42, motion: 'nod', motionIntensity: 0.4, suppressIdle: false },
    {},
    profile,
  )

  assert.equal(plan.motion, 'nod')
  assert.equal(plan.motionProbability, 1)
})

test('model emotion and context cues reach authored secondary body language', () => {
  const profile: AvatarCapabilityProfile = {
    model: 'shirone',
    expressions: ['neutral', 'playful'],
    motions: ['ear_flick', 'tail_sweep', 'nod'],
    sequences: [],
    parameters: {},
    bindings: {},
    semanticMotionMap: {
      playful: 'ear_flick',
      excited: 'tail_sweep',
      agree: 'nod',
    },
  }
  const policy = new CharacterPerformancePolicy()
  const base = {
    expression: 'playful',
    expressionIntensity: 0.7,
    motionIntensity: 0.6,
    suppressIdle: false,
  }

  const playful = policy.evaluate(
    { emotion: 'playful', behavior: 'speak', intensity: 0.7, energy: 0.6 },
    base,
    {},
    profile,
  )
  const excited = policy.evaluate(
    {
      emotion: 'neutral',
      behavior: 'speak',
      intensity: 0.7,
      energy: 0.6,
      contextTags: ['excited'],
    },
    { ...base, expression: 'neutral' },
    {},
    profile,
  )
  const explicitAgreement = policy.evaluate(
    {
      emotion: 'playful',
      behavior: 'agree',
      intensity: 0.7,
      energy: 0.6,
      contextTags: ['excited'],
    },
    { ...base, motion: 'nod' },
    {},
    profile,
  )

  assert.equal(playful.motion, 'ear_flick')
  assert.equal(excited.motion, 'tail_sweep')
  assert.equal(explicitAgreement.motion, 'nod')
})

test('an intentional empty emotion mapping selects the built-in semantic preset', () => {
  const profile: AvatarCapabilityProfile = {
    model: 'Design_genius_White',
    expressions: ['neutral', 'happy'],
    motions: [],
    sequences: [],
    parameters: {},
    bindings: {},
  }
  const config: CharacterBehaviorConfig = {
    emotionMap: { neutral: '', playful: '', confused: '' },
  }
  const policy = new CharacterPerformancePolicy()

  for (const emotion of ['playful', 'confused']) {
    const plan = policy.evaluate(
      { emotion, behavior: 'speak', intensity: 0.7 },
      { expression: emotion, expressionIntensity: 0.7, motionIntensity: 0.5, suppressIdle: false },
      config,
      profile,
    )
    assert.equal(plan.expression, emotion, `${emotion} must not collapse to neutral`)
  }
})

test('profile expression aliases survive capability filtering', () => {
  const profile: AvatarCapabilityProfile = {
    model: 'shirone',
    expressions: ['neutral', 'happy'],
    motions: [],
    sequences: [],
    parameters: {},
    bindings: {},
    expressionMap: {
      playful: '星星眼',
      embarrassed: '鸡爪眼',
    },
  }
  const policy = new CharacterPerformancePolicy()

  for (const emotion of ['playful', 'embarrassed']) {
    const plan = policy.evaluate(
      { emotion, behavior: 'speak', intensity: 0.7 },
      { expression: emotion, expressionIntensity: 0.7, motionIntensity: 0.5, suppressIdle: false },
      {},
      profile,
    )
    assert.equal(plan.expression, emotion, `${emotion} must resolve through profile.expressionMap`)
  }
})

test('an explicit segment emotion is not overwritten by a behavior default', () => {
  const profile: AvatarCapabilityProfile = {
    model: 'shirone',
    expressions: ['neutral', 'happy', 'shy'],
    motions: [], sequences: [], parameters: {}, bindings: {},
    expressionMap: { shy: '鸡爪眼', happy: '心心眼' },
  }
  const intent = { emotion: 'shy', behavior: 'greet', intensity: 0.4 } as const
  const resolver = new CharacterBehaviorResolver()
  const base = resolver.resolve(intent)
  const plan = new CharacterPerformancePolicy().evaluate(intent, base, {}, profile)

  assert.equal(base.expression, 'shy')
  assert.equal(plan.expression, 'shy')
})

test('unsupported expressions fall back explicitly and observably', () => {
  const profile: AvatarCapabilityProfile = {
    model: 'limited',
    expressions: ['neutral', 'happy'],
    motions: [], sequences: [], parameters: {}, bindings: {},
  }
  const plan = new CharacterPerformancePolicy().evaluate(
    { emotion: 'shy', behavior: 'speak', intensity: 0.7 },
    { expression: 'shy', expressionIntensity: 0.7, motionIntensity: 0.5, suppressIdle: false },
    {},
    profile,
  )

  assert.equal(plan.requestedExpression, 'shy')
  assert.equal(plan.expression, 'neutral')
  assert.equal(plan.expressionFallbackReason, 'unsupported_emotion')
})
