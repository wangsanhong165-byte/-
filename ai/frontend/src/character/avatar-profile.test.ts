import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  normalizeAvatarViewport,
  type AvatarCapabilityProfile,
} from './AvatarCapabilityProfile.ts'
import { AvatarParameterResolver } from './AvatarParameterResolver.ts'
import { logicalFaceFromFACS } from './performance/FACSState.ts'
import { computeDrawableBounds } from './live2d/viewport.ts'

function profile(
  overrides: Partial<AvatarCapabilityProfile> = {},
): AvatarCapabilityProfile {
  return {
    model: 'test',
    expressions: [],
    motions: [],
    parameters: {},
    bindings: {
      'head.x': { target: 'ParamAngleX', min: -8, max: 8 },
      'body.x': 'ParamBodyAngleX',
      'mouth.open': { target: 'ParamMouthOpenY', min: 0, max: 0.7 },
    },
    ...overrides,
  }
}

test('resolver clamps output to model binding range', () => {
  const resolver = new AvatarParameterResolver()
  resolver.setProfile(profile())

  assert.deepEqual(resolver.values({ 'head.x': 30, 'mouth.open': 1 }), {
    ParamAngleX: 8,
    ParamMouthOpenY: 0.7,
  })
})

test('resolver omits channels explicitly unsupported by the model', () => {
  const resolver = new AvatarParameterResolver()
  resolver.setProfile(profile({
    capabilities: { headControl: true, bodyControl: false },
  }))

  assert.deepEqual(resolver.values({ 'head.x': 2, 'body.x': 3 }), {
    ParamAngleX: 2,
  })
})

test('face expression channels are independent from gaze capability', () => {
  const resolver = new AvatarParameterResolver()
  resolver.setProfile(profile({
    capabilities: { gazeControl: false, browControl: true },
    bindings: {
      'eye.x': 'ParamEyeBallX',
      'eye.left.smile': { target: 'ParamEyeLSmile', min: 0, max: 1 },
      'brow.left.y': { target: 'ParamBrowLY', min: -1, max: 1 },
    },
  }))

  assert.deepEqual(resolver.values({
    'eye.x': 0.5,
    'eye.left.smile': 0.5,
    'brow.left.y': 0.5,
  }), {
    ParamEyeLSmile: 0.5,
    ParamBrowLY: 0.5,
  })
})

test('Design_genius_White routes body motion into its physical body inputs', () => {
  const profile = JSON.parse(readFileSync(
    new URL('../../../config/avatar_profiles/Design_genius_White.json', import.meta.url),
    'utf8',
  )) as { bindings: Record<string, string | { target: string }> }

  const target = (logical: string) => {
    const binding = profile.bindings[logical]
    return typeof binding === 'string' ? binding : binding?.target
  }

  assert.deepEqual(
    ['body.x', 'body.y', 'body.z'].map(target),
    ['ParamBodyAngleX', 'ParamBodyAngleY', 'ParamBodyAngleZ'],
  )
})

test('shirone profile exposes only real torso, face, ear, and tail controls', () => {
  const profile = JSON.parse(readFileSync(
    new URL('../../../config/avatar_profiles/shirone.json', import.meta.url),
    'utf8',
  )) as AvatarCapabilityProfile

  assert.equal(profile.bindings['body.z'], 'ParamBodyAngleZ')
  assert.equal(
    typeof profile.bindings['tail.z'] === 'string'
      ? profile.bindings['tail.z']
      : profile.bindings['tail.z']?.target,
    'Param_Angle_Rotation_1_ArtMesh572',
  )
  for (let index = 1; index <= 15; index += 1) {
    const key = `tail.segment${String(index).padStart(2, '0')}`
    const binding = profile.bindings[key]
    assert.equal(typeof binding === 'string' ? binding : binding?.target,
      `Param_Angle_Rotation_${index}_ArtMesh571`)
  }
  assert.equal(profile.bindings['body.y2'], 'ParamBodyAngleY2')
  assert.equal(profile.bindings['body.z2'], 'ParamBodyAngleZ2')
  assert.equal(
    typeof profile.bindings['brow.left.y'] === 'string'
      ? profile.bindings['brow.left.y']
      : profile.bindings['brow.left.y']?.target,
    'ParamBrowLY',
  )
  assert.equal(profile.bindings['arm.right.upper'], undefined)
  assert.equal(profile.bindings['hand.right'], undefined)
  assert.deepEqual(profile.motions, ['nod', 'tilt', 'sway', 'thinking', 'ear_flick', 'tail_sweep'])
  assert.deepEqual(
    profile.semanticMotionMap?.greet,
    { motion: 'sway', intensityScale: 0.92 },
  )
  assert.equal(profile.semanticMotionMap?.wave, 'sway')
  assert.equal(profile.semanticMotionMap?.excited, 'tail_sweep')
  assert.deepEqual(profile.nativeMotionChannels?.idle, ['secondary'])
  assert.deepEqual(
    profile.logicalMotionPresets?.map(preset => preset.name),
    ['ear_flick', 'tail_sweep'],
  )
  assert.deepEqual(profile.petViewport, { x: 0, y: 0.02, scale: 0.78 })
  assert.equal(profile.parameterGain, 1.4)
  assert.equal(profile.bodyMotionGain, 1.34)
  assert.equal(profile.expressionParameterPolicy?.minimumBlendDurationMs, 460)
  assert.equal(profile.expressionMap?.happy, 'happy')
  assert.equal(profile.expressionMap?.joyful, '星星眼')
  // pout must NOT share angry's face: a sulky pout wearing the full 生气表情
  // (脸黑+重眉+鼓嘴) reads as "always angry" — the 2026-09-04 separation.
  // pout resolves to the dedicated preset, angry to the model expression.
  assert.equal(profile.expressionMap?.pout, 'pout')
  assert.equal(profile.expressionMap?.angry, '生气表情')
  assert.notEqual(profile.expressionMap?.pout, profile.expressionMap?.angry)
  const model3 = JSON.parse(readFileSync(
    new URL('../../../models/live2d-models/shirone/shirone.model3.json', import.meta.url),
    'utf8',
  )) as { FileReferences: { Expressions: Array<{ Name: string }> } }
  const nativeExpressions = new Set(
    model3.FileReferences.Expressions.map(expression => expression.Name),
  )
  assert.ok(nativeExpressions.has(profile.expressionMap!.joyful))
  assert.ok(nativeExpressions.has(profile.expressionMap!.shy))
  const earFlick = profile.logicalMotionPresets?.find(preset => preset.name === 'ear_flick')
  const tailSweep = profile.logicalMotionPresets?.find(preset => preset.name === 'tail_sweep')
  assert.ok((earFlick?.duration ?? 0) >= 1_200, 'ear gesture should read as a pose, not a twitch')
  assert.ok((tailSweep?.duration ?? 0) >= 1_700, 'tail/body sweep should have a broad readable arc')
  assert.ok(
    (earFlick?.keyframes ?? []).some(frame =>
      frame.parameter === 'body.x' && Math.abs(frame.value) >= 1),
    'ear gesture needs a visible matching torso contribution',
  )
  assert.equal(
    profile.logicalMotionPresets?.some(preset => preset.keyframes.some(frame =>
      frame.parameter.startsWith('arm.') || frame.parameter.startsWith('hand.'))),
    false,
  )
})

test('Design_genius_White does not advertise body rotation as an arm wave', () => {
  const profile = JSON.parse(readFileSync(
    new URL('../../../config/avatar_profiles/Design_genius_White.json', import.meta.url),
    'utf8',
  )) as AvatarCapabilityProfile

  assert.equal(profile.motions.includes('arm_wave'), false)
  assert.deepEqual(profile.semanticMotionMap, {
    greet: 'tilt',
    wave: 'sway',
    agree: 'nod',
    excited: 'sway',
  })
  assert.equal(profile.motions.includes('tail_sway'), false)
})

test('Design_genius_White behavior config cannot reintroduce the ghosting arm pose', () => {
  const configs = JSON.parse(readFileSync(
    new URL('../../../config/live2d_models.json', import.meta.url),
    'utf8',
  )) as Record<string, {
    emotion_map: Record<string, string>
    behavior_map: Record<string, { motion?: string }>
    accessories: Record<string, string>
  }>
  const config = configs.Design_genius_White

  assert.equal(Object.values(config.emotion_map).includes('zs11'), false)
  assert.equal(Object.values(config.accessories).includes('14'), false)
  assert.equal(Object.values(config.accessories).includes('144'), false)
  const controllerSource = readFileSync(new URL('./controllers.ts', import.meta.url), 'utf8')
  for (const unsafeExpression of ['14', '144', '中指', '中指2']) {
    assert.ok(controllerSource.includes(`expression !== '${unsafeExpression}'`))
  }
  assert.deepEqual({
    greet: config.behavior_map.greet.motion,
    wave: config.behavior_map.wave.motion,
    agree: config.behavior_map.agree.motion,
    excited: config.behavior_map.excited.motion,
  }, {
    greet: 'tilt',
    wave: 'sway',
    agree: 'nod',
    excited: 'sway',
  })
})

test('shirone keeps the LLM emotion authoritative for neutral greetings', () => {
  const configs = JSON.parse(readFileSync(
    new URL('../../../config/live2d_models.json', import.meta.url),
    'utf8',
  )) as Record<string, {
    behavior_map?: Record<string, { motion?: string; expression?: string }>
    personality?: { expressionIntensityScale?: number }
  }>
  const profile = JSON.parse(readFileSync(
    new URL('../../../config/avatar_profiles/shirone.json', import.meta.url),
    'utf8',
  )) as {
    semanticMotionMap?: Record<string, { motion?: string; expression?: string } | string>
  }

  // behavior_map is retired for shirone (2026-09-05 consolidation into the
  // profile's semanticMotionMap). The lock survives: greet carries modifiers
  // but NO expression override — a neutral-emotion greeting never repaints
  // the LLM's chosen face.
  assert.equal(configs.shirone.behavior_map, undefined)
  assert.deepEqual(profile.semanticMotionMap?.greet, { motion: 'sway', intensityScale: 0.92 })
  assert.equal(configs.shirone.personality?.expressionIntensityScale, 1.12)
})

test('FACS face mapping stays subtle and avoids the model-specific cheek overlay', () => {
  assert.deepEqual(logicalFaceFromFACS({
    browInnerUp: 0.4,
    browOuterUp: 0.2,
    eyeSquint: 0.5,
    mouthSmile: 0.6,
    mouthPucker: 0.1,
  }), {
    'brow.left.y': 0.344,
    'brow.right.y': 0.344,
    'eye.left.smile': 0.5,
    'eye.right.smile': 0.5,
    'mouth.form': 0.5,
  })
})

test('motion parameter resolution protects lip-sync ownership', () => {
  const resolver = new AvatarParameterResolver()
  resolver.setProfile(profile())

  assert.deepEqual(
    resolver.resolveMotionParameters({ 'head.x': 3, 'mouth.open': 0.6 }),
    { ParamAngleX: 3 },
  )
  assert.equal(resolver.isProtectedMotionTarget('ParamMouthOpenY'), true)
  assert.equal(resolver.isProtectedMotionTarget('ParamAngleX'), false)
})

test('resolver exposes per-model lip-sync calibration with safe defaults', () => {
  const resolver = new AvatarParameterResolver()
  resolver.setProfile(profile({
    lipSync: {
      max: 0.64,
      inputGain: 5.2,
      noiseGate: 0.02,
      attackMs: 45,
      releaseMs: 135,
      peakBoost: 0.2,
    },
  }))

  assert.deepEqual(resolver.getLipSyncConfig(), {
    min: 0,
    max: 0.64,
    inputGain: 5.2,
    noiseGate: 0.02,
    attackMs: 45,
    releaseMs: 135,
    peakBoost: 0.2,
  })
})

test('model viewport framing is bounded and defaults to a centered view', () => {
  assert.deepEqual(normalizeAvatarViewport(undefined), { x: 0, y: 0, scale: 1 })
  assert.deepEqual(normalizeAvatarViewport({ x: 4, y: -4, scale: 0.1 }), {
    x: 1.5,
    y: -1.5,
    scale: 0.35,
  })
})

test('model framing centers drawable artwork instead of transparent canvas margins', () => {
  assert.deepEqual(computeDrawableBounds([
    [-8, -2, -4, -2, -4, 6, -8, 6],
    [2, -1, 6, -1, 6, 3, 2, 3],
  ]), {
    left: -8,
    right: 6,
    top: -2,
    bottom: 6,
    centerX: -1,
    centerY: 2,
  })
  assert.equal(computeDrawableBounds([]), null)
})
