import assert from 'node:assert/strict'
import test from 'node:test'

import { AudioAnalyzer } from './AudioAnalyzer.ts'
import { VoiceWaitingMotionController } from './performance/VoiceWaitingMotionController.ts'
import { resolveMotionStyle } from './performance/MotionStyle.ts'
import { ParameterMixer } from './ParameterMixer.ts'
import { ParameterController, expressionTargetForBlend } from './ExpressionParameterController.ts'
import { LatestModelLoadCoordinator } from './live2d/ModelLoadCoordinator.ts'
import { AttentionController } from './performance/AttentionController.ts'
import { shouldStartAuthoredIdle } from './AvatarCapabilityProfile.ts'
import { FrameTimingMonitor } from './FrameTimingMonitor.ts'
import { AmbientPerformanceEngine } from './performance/AmbientPerformanceEngine.ts'
import { BodySwayController } from './performance/BodySwayController.ts'
import { getExpression } from './live2d/expression.ts'
import { semanticPostureFromVAD } from './performance/SemanticPosture.ts'
import { mergeAccessoryParameterState, resolveAccessoryParameterState } from './AccessoryState.ts'

test('lip-sync noise gate stays closed and calibrated output never exceeds model maximum', () => {
  const analyzer = new AudioAnalyzer()
  analyzer.configure({
    min: 0,
    max: 0.6,
    inputGain: 5,
    noiseGate: 0.02,
    attackMs: 40,
    releaseMs: 120,
    peakBoost: 0.2,
  })

  assert.equal(analyzer.analyze(0.01, 1 / 60), 0)
  const loud = analyzer.analyze(0.4, 1 / 60, 0.7)
  assert.ok(loud > 0.1)
  assert.ok(loud <= 0.6)
})

test('lip-sync releases to a closed mouth after speech stops', () => {
  const analyzer = new AudioAnalyzer()
  analyzer.configure({
    max: 0.7,
    noiseGate: 0.015,
    attackMs: 35,
    releaseMs: 90,
  })
  analyzer.analyze(0.3, 1 / 60)
  let mouth = 1
  for (let index = 0; index < 30; index += 1) {
    mouth = analyzer.analyze(0, 1 / 60)
  }
  assert.ok(mouth < 0.02)
})

test('waiting motion releases smoothly instead of snapping to zero', () => {
  const controller = new VoiceWaitingMotionController(9)
  const thinking = controller.update(0.2, 'thinking', 1)
  const releasing = controller.update(0.05, 'idle', 1)

  assert.ok(Math.abs(thinking['head.z'] ?? 0) > 0.01)
  assert.ok(Math.abs(releasing['head.z'] ?? 0) > 0.001)
  for (let index = 0; index < 30; index += 1) controller.update(0.05, 'idle', 1)
  assert.deepEqual(controller.update(0.05, 'idle', 1), {})
})

test('ambient performance emits one coordinated pose and yields owned channels', () => {
  const engine = new AmbientPerformanceEngine(17)
  engine.configure({ preset: 'lively', seed: 17 }, {
    expressiveness: 0.78, softness: 0.68, shyness: 0.42,
  }, { headControl: true, bodyControl: true, gazeControl: true })
  engine.setActivity('idle')

  let frame = engine.update(1 / 60, {
    vad: { valence: 0.35, arousal: 0.28, dominance: 0.12 },
    audioLevel: 0,
    enabled: true,
    blockedChannels: new Set(),
  })
  for (let index = 0; index < 180; index += 1) {
    frame = engine.update(1 / 60, {
      vad: { valence: 0.35, arousal: 0.28, dominance: 0.12 },
      audioLevel: 0,
      enabled: true,
      blockedChannels: new Set(),
    })
  }
  assert.ok(Object.keys(frame.values).some(key => key.startsWith('head.')))
  assert.ok(Object.keys(frame.values).some(key => key.startsWith('body.')))

  const blocked = engine.update(1 / 60, {
    vad: { valence: 0.35, arousal: 0.28, dominance: 0.12 },
    audioLevel: 0,
    enabled: true,
    blockedChannels: new Set(['head', 'body', 'gaze']),
  })
  assert.equal(Object.keys(blocked.values).length, 0)
})

test('attention ownership leaves the unowned torso rhythm alive', () => {
  const engine = new AmbientPerformanceEngine(17)
  engine.configure({ preset: 'lively', seed: 17 }, undefined, {
    headControl: true, bodyControl: true, gazeControl: true,
  })
  engine.setActivity('idle')

  let bodyPeak = 0
  for (let frameIndex = 0; frameIndex < 60 * 20; frameIndex += 1) {
    const frame = engine.update(1 / 60, {
      vad: { valence: 0, arousal: 0, dominance: 0 },
      audioLevel: 0,
      enabled: true,
      blockedChannels: new Set(['head', 'gaze']),
    })
    assert.equal(Object.keys(frame.values).some(key => key.startsWith('head.') || key.startsWith('eye.')), false)
    bodyPeak = Math.max(
      bodyPeak,
      ...Object.entries(frame.values)
        .filter(([key]) => key.startsWith('body.'))
        .map(([, value]) => Math.abs(value)),
    )
  }
  assert.ok(bodyPeak > 0.2, 'looking around should not freeze the shoulders and torso')
})

test('ambient activity transitions keep velocity bounded instead of restarting at zero', () => {
  const engine = new AmbientPerformanceEngine(23)
  engine.configure({ preset: 'natural', seed: 23 }, undefined, undefined)
  engine.setActivity('speaking')
  let previous = engine.update(1 / 60, {
    vad: { valence: 0.2, arousal: 0.4, dominance: 0.1 },
    audioLevel: 0.45,
    enabled: true,
    blockedChannels: new Set(),
  })
  for (let index = 0; index < 60; index += 1) {
    previous = engine.update(1 / 60, {
      vad: { valence: 0.2, arousal: 0.4, dominance: 0.1 },
      audioLevel: 0.45,
      enabled: true,
      blockedChannels: new Set(),
    })
  }

  engine.setActivity('idle')
  const next = engine.update(1 / 60, {
    vad: { valence: 0.2, arousal: 0.4, dominance: 0.1 },
    audioLevel: 0,
    enabled: true,
    blockedChannels: new Set(),
  })
  for (const key of new Set([...Object.keys(previous.values), ...Object.keys(next.values)])) {
    assert.ok(Math.abs((next.values[key] ?? 0) - (previous.values[key] ?? 0)) < 0.8)
  }
})

test('unknown profile motion-style presets fall back to natural instead of crashing', () => {
  const style = resolveMotionStyle({ preset: 'friendly' as any })
  assert.equal(style.preset, 'natural')
  assert.equal(style.spontaneity, 1)
})

test('expression blend semantics use the real Cubism baseline', () => {
  assert.equal(expressionTargetForBlend(0.4, 0.5, 'add', 0.2), 0.4)
  assert.ok(Math.abs(expressionTargetForBlend(0.5, 0.5, 'multiply', 0.8) - 0.6) < 1e-9)
  assert.equal(expressionTargetForBlend(1, 0.25, 'overwrite', 0.2), 0.4)
})

test('semantic face presets never seize head or torso locomotion channels', () => {
  for (const name of [
    'neutral', 'happy', 'sad', 'angry', 'surprised', 'shy', 'thinking',
    'curious', 'confused', 'smile', 'excited', 'tired', 'sleepy', 'playful',
  ]) {
    const ids = getExpression(name).params.map(param => param.id)
    assert.equal(
      ids.some(id => id.startsWith('ParamAngle') || id.startsWith('ParamBodyAngle')),
      false,
      `${name} must leave posture to the coordinated performance layer`,
    )
  }
})

test('semantic posture coordinates emotion across head and torso', () => {
  const happy = semanticPostureFromVAD({ valence: 0.72, arousal: 0.35, dominance: 0.28 })
  const sad = semanticPostureFromVAD({ valence: -0.72, arousal: -0.28, dominance: -0.56 })
  const angry = semanticPostureFromVAD({ valence: -0.72, arousal: 0.78, dominance: 0.68 })

  assert.ok(happy['head.y'] > 1 && happy['body.y'] > 0.5)
  assert.ok(sad['head.y'] < -2 && sad['body.y'] < -1.5)
  assert.ok(angry['body.y'] > 0, 'dominant anger should lean into the statement')
  assert.equal('eye.x' in happy, false, 'semantic posture must not fight attention ownership')
})

test('expression release keeps submitting until the real baseline is restored', () => {
  const presets: Record<string, { params: Array<{ id: string; value: number; blend?: 'overwrite' }> }> = {
    test_shy: { params: [
      { id: 'ParamCheek', value: 0.8, blend: 'overwrite' },
      { id: 'ParamPoseHand', value: 1, blend: 'overwrite' },
    ] },
    test_neutral: { params: [] },
  }
  const mixer = new ParameterMixer()
  const adapter = {
    configureMixerBaseline(target: ParameterMixer) {
      target.setBaselineProvider((id: string) => id === 'ParamCheek' ? 0.15 : 0)
    },
  } as any
  const controller = new ParameterController(name => presets[name])
  controller.attach(adapter, mixer)

  controller.applyExpression('test_shy', 1, 100, 0)
  controller.update(100)
  controller.applyExpression('test_neutral', 1, 100, 100)
  const releasing = controller.update(150)
  const finalFrame = controller.update(200)
  const afterRelease = controller.update(201)

  assert.ok(releasing.some(item => item.parameterId === 'ParamCheek' && item.value > 0.15))
  assert.ok(Math.abs((finalFrame.find(item => item.parameterId === 'ParamCheek')?.value ?? 0) - 0.15) < 1e-9)
  assert.equal(finalFrame.find(item => item.parameterId === 'ParamPoseHand')?.value, 0)
  assert.equal(afterRelease.some(item => item.parameterId === 'ParamCheek'), false)
})

test('cat-tail secondary motion is visible, continuous, and coupled to the living pose', () => {
  const engine = new AmbientPerformanceEngine(31)
  engine.configure({ preset: 'natural', seed: 31 }, undefined, {
    headControl: true, bodyControl: true, gazeControl: true,
  })
  engine.setActivity('idle')

  const previous = Array.from({ length: 15 }, () => 0)
  let segmentPeak = 0
  let rootPeak = 0
  let maxFrameDelta = 0
  let maxSpatialSpread = 0
  for (let index = 0; index < 60 * 18; index += 1) {
    const frame = engine.update(1 / 60, {
      vad: { valence: 0.2, arousal: 0.15, dominance: 0 },
      audioLevel: 0,
      enabled: true,
      blockedChannels: new Set(),
    })
    const segments = previous.map((_, segmentIndex) => (
      frame.values[`tail.segment${String(segmentIndex + 1).padStart(2, '0')}`] ?? 0
    ))
    rootPeak = Math.max(rootPeak, Math.abs(frame.values['tail.z'] ?? 0))
    segmentPeak = Math.max(segmentPeak, ...segments.map(Math.abs))
    maxSpatialSpread = Math.max(maxSpatialSpread, Math.max(...segments) - Math.min(...segments))
    segments.forEach((value, segmentIndex) => {
      maxFrameDelta = Math.max(maxFrameDelta, Math.abs(value - previous[segmentIndex]))
      previous[segmentIndex] = value
    })
  }

  assert.ok(segmentPeak > 4, `tail segment peak ${segmentPeak} should be visibly larger than controller noise`)
  assert.ok(rootPeak < segmentPeak * 0.4, `root ${rootPeak} should guide rather than rigidly swing the tail`)
  assert.ok(maxSpatialSpread > 0.8, `segment spread ${maxSpatialSpread} should create visible curvature`)
  assert.ok(maxFrameDelta < 0.45, `tail frame delta ${maxFrameDelta} should remain spring-continuous`)
})

test('expression presets cannot seize parameters reserved for accessory state', () => {
  const presets = {
    test_neutral: { params: [
      { id: 'ParamCatTailVisible', value: 0, blend: 'overwrite' as const },
      { id: 'ParamFaceSmile', value: 0, blend: 'overwrite' as const },
    ] },
  }
  const mixer = new ParameterMixer()
  const adapter = {
    configureMixerBaseline(target: ParameterMixer) {
      target.setBaselineProvider(() => 0)
    },
  } as any
  const controller = new ParameterController(name => presets[name as keyof typeof presets])
  controller.attach(adapter, mixer)
  controller.setExcludedParameterIds(['ParamCatTailVisible'])
  controller.applyExpression('test_neutral', 1, 0, 0)

  const output = controller.update(0)
  assert.equal(output.some(item => item.parameterId === 'ParamCatTailVisible'), false)
  assert.equal(output.some(item => item.parameterId === 'ParamFaceSmile'), true)
})

test('overlapping accessories produce one bounded state owner per parameter', () => {
  const presets = {
    cat: { params: [{ id: 'ParamShared', value: 1 }, { id: 'ParamTail', value: 1 }] },
    hair: { params: [{ id: 'ParamShared', value: 1 }, { id: 'ParamIgnoredZero', value: 0 }] },
  }
  const merged = mergeAccessoryParameterState(
    { 猫耳: 'cat', 丸子头: 'hair' },
    { 猫耳: true, 丸子头: true },
    name => presets[name as keyof typeof presets],
  )

  assert.deepEqual(merged.get('ParamShared'), { value: 1, labels: ['猫耳', '丸子头'] })
  assert.equal(merged.has('ParamIgnoredZero'), false)
  assert.equal(merged.size, 2)
})

test('accessory state restores every owned parameter to baseline when switched off', () => {
  const presets = {
    cat: { params: [{ id: 'ParamCatVisible', value: 1 }, { id: 'ParamTailVisible', value: 1 }] },
  }
  const resolve = (name: string) => presets[name as keyof typeof presets]

  const enabled = resolveAccessoryParameterState(
    { 猫耳: 'cat' }, { 猫耳: true }, resolve, () => 0,
  )
  const disabled = resolveAccessoryParameterState(
    { 猫耳: 'cat' }, { 猫耳: false }, resolve, () => 0,
  )
  const enabledAgain = resolveAccessoryParameterState(
    { 猫耳: 'cat' }, { 猫耳: true }, resolve, () => 0,
  )

  assert.equal(enabled.get('ParamCatVisible')?.value, 1)
  assert.equal(enabled.get('ParamTailVisible')?.value, 1)
  assert.equal(disabled.get('ParamCatVisible')?.value, 0)
  assert.equal(disabled.get('ParamTailVisible')?.value, 0)
  assert.equal(enabledAgain.get('ParamCatVisible')?.value, 1)
})

test('discrete replacement expressions switch atomically at full opacity', () => {
  const presets = {
    surprised: { params: [{ id: 'ParamRingEyes', value: 1 }] },
    shy: { params: [{ id: 'ParamShyEyes', value: 1 }, { id: 'ParamShyAux', value: 0.5 }] },
  }
  const mixer = new ParameterMixer()
  const adapter = {
    configureMixerBaseline(target: ParameterMixer) {
      target.setBaselineProvider(() => 0)
    },
  } as any
  const controller = new ParameterController(name => presets[name as keyof typeof presets])
  controller.attach(adapter, mixer)
  controller.configurePolicy({
    discreteParameterIds: ['ParamRingEyes', 'ParamShyEyes', 'ParamShyAux'],
    exclusiveParameterGroups: [['ParamRingEyes', 'ParamShyEyes', 'ParamShyAux']],
  })

  controller.applyExpression('surprised', 0.35, 400, 0)
  const surprised = controller.update(0)
  controller.applyExpression('shy', 0.25, 400, 100)
  const switched = controller.update(100)

  assert.equal(surprised.find(item => item.parameterId === 'ParamRingEyes')?.value, 1)
  assert.equal(switched.find(item => item.parameterId === 'ParamRingEyes')?.value ?? 0, 0)
  assert.equal(switched.find(item => item.parameterId === 'ParamShyEyes')?.value, 1)
  assert.equal(switched.find(item => item.parameterId === 'ParamShyAux')?.value, 0.5)
})

test('replacement eyes wait for the facial blend before switching without overlap', () => {
  const presets = {
    surprised: { params: [
      { id: 'ParamRingEyes', value: 1 },
      { id: 'ParamSurprisedBrow', value: 0.8 },
    ] },
    shy: { params: [
      { id: 'ParamShyEyes', value: 1 },
      { id: 'ParamShyBrow', value: 0.6 },
    ] },
  }
  const mixer = new ParameterMixer()
  const adapter = {
    configureMixerBaseline(target: ParameterMixer) {
      target.setBaselineProvider(() => 0)
    },
  } as any
  const controller = new ParameterController(name => presets[name as keyof typeof presets])
  controller.attach(adapter, mixer)
  controller.configurePolicy({
    discreteParameterIds: ['ParamRingEyes', 'ParamShyEyes'],
    exclusiveParameterGroups: [['ParamRingEyes', 'ParamShyEyes']],
    discreteSwitchDelayMs: 220,
    minimumBlendDurationMs: 520,
  })

  controller.applyExpression('surprised', 1, 480, 0)
  controller.update(220)
  controller.applyExpression('shy', 1, 480, 300)
  const blending = controller.update(380)
  const neutralBridge = controller.update(420)
  const switched = controller.update(520)

  assert.equal(blending.find(item => item.parameterId === 'ParamRingEyes')?.value, 1)
  assert.equal(blending.find(item => item.parameterId === 'ParamShyEyes')?.value, 0)
  assert.ok((blending.find(item => item.parameterId === 'ParamShyBrow')?.value ?? 0) > 0)
  assert.equal(neutralBridge.find(item => item.parameterId === 'ParamRingEyes')?.value ?? 0, 0)
  assert.equal(neutralBridge.find(item => item.parameterId === 'ParamShyEyes')?.value ?? 0, 0)
  assert.equal(switched.find(item => item.parameterId === 'ParamRingEyes')?.value ?? 0, 0)
  assert.equal(switched.find(item => item.parameterId === 'ParamShyEyes')?.value, 1)
})

test('partial override fades from the baseline while full override is exclusive', () => {
  const mixer = new ParameterMixer()
  const submit = (id: string, value: number, priority: number, weight: number) => mixer.submit({
    id,
    parameterId: 'ParamArm',
    source: id,
    channel: 'motion',
    value,
    priority,
    weight,
    createdAt: 0,
  })
  submit('idle', 10, 10, 1)
  submit('gesture', 30, 50, 0.25)
  // Winner (priority 50) fades from the model baseline, not from the lower
  // layer's pose: 0 + (30 - 0) * 0.25 = 7.5. Old in-between behaviour was 15.
  assert.equal(mixer.resolve().ParamArm, 7.5)

  mixer.resetFrame()
  submit('idle', 10, 10, 1)
  submit('gesture', 30, 50, 1)
  assert.equal(mixer.resolve().ParamArm, 30)
})

test('latest model load coordinator coalesces duplicates and supersedes older generations', async () => {
  const coordinator = new LatestModelLoadCoordinator<string>()
  let resolveA!: (value: string) => void
  let resolveB!: (value: string) => void
  const a = coordinator.run('A', () => new Promise(resolve => { resolveA = resolve }))
  const duplicateA = coordinator.run('A', () => Promise.resolve('unexpected'))
  const b = coordinator.run('B', () => new Promise(resolve => { resolveB = resolve }))

  assert.equal(a, duplicateA)
  resolveA('A-ready')
  resolveB('B-ready')
  assert.deepEqual(await a, { status: 'superseded', modelName: 'A', generation: 1 })
  assert.deepEqual(await b, { status: 'loaded', modelName: 'B', generation: 2, value: 'B-ready' })
})

test('attention produces bounded away gaze, centers screen gaze, and releases neutral ownership', () => {
  const attention = new AttentionController(1)
  attention.set('away')
  const away = attention.update(0.5)
  assert.ok(Math.abs(away.values['head.x'] ?? 0) <= 8)
  assert.ok(Math.abs(away.values['eye.x'] ?? 0) <= 0.45)
  assert.ok(away.weight > 0)

  attention.set('screen')
  const screen = attention.update(0.5)
  assert.equal(screen.values['head.x'], 0)
  assert.equal(screen.values['eye.x'], 0)

  attention.set('neutral')
  for (let index = 0; index < 20; index += 1) attention.update(0.05)
  assert.deepEqual(attention.update(0.05), { values: {}, weight: 0 })
})

test('authored idle requires explicit profile opt-in', () => {
  assert.equal(shouldStartAuthoredIdle(undefined), false)
  assert.equal(shouldStartAuthoredIdle({ motions: ['speak', 'greet'] }), false)
  assert.equal(shouldStartAuthoredIdle({ motions: ['idle'] }), true)
})

test('frame timing monitor keeps a bounded rolling window and reports long frames', () => {
  const monitor = new FrameTimingMonitor(30)
  for (let index = 0; index < 35; index += 1) {
    monitor.record({
      intervalMs: index === 34 ? 45 : 10,
      workMs: 5,
      controllerMs: 1,
      mixMs: 1,
      modelMs: 1,
      renderMs: 2,
    })
  }
  const snapshot = monitor.snapshot()
  assert.equal(snapshot.sampleCount, 30)
  assert.equal(snapshot.intervalMs, 45)
  assert.equal(snapshot.maxIntervalMs, 45)
  assert.equal(snapshot.longFrameCount, 1)
})

test('frame timing monitor reports average p95 and p99 for every render phase', () => {
  const monitor = new FrameTimingMonitor(30)
  for (let index = 1; index <= 30; index += 1) {
    monitor.record({
      intervalMs: index,
      workMs: index * 0.5,
      controllerMs: index * 0.1,
      mixMs: index * 0.05,
      modelMs: index * 0.2,
      renderMs: index * 0.15,
    })
  }

  const snapshot = monitor.snapshot()
  assert.equal(snapshot.p99IntervalMs, 30)
  assert.equal(snapshot.phases.work.averageMs, 7.75)
  assert.ok(Math.abs(snapshot.phases.controller.p95Ms - 2.9) < 1e-9)
  assert.equal(snapshot.phases.model.p99Ms, 6)
  assert.equal(snapshot.phases.render.maxMs, 4.5)
})

test('autonomous torso sway carries velocity and recenters through inertia', () => {
  const sway = new BodySwayController(29)
  let sample = sway.update(0, 0, 1)
  let peakBody = 0
  for (let frame = 1; frame <= 720; frame += 1) {
    sample = sway.update(frame / 60, 0, 1)
    peakBody = Math.max(peakBody, Math.abs(sample.bodyX), Math.abs(sample.bodyY))
  }
  const moving = sway.getKinematics()

  assert.ok(peakBody > 0.3, 'idle torso should visibly leave neutral over time')
  assert.ok(Object.values(moving.velocity).some(value => Math.abs(value) > 0.005))

  const beforeFocus = { ...sample }
  const firstFocused = sway.update(721 / 60, 1, 1)
  assert.ok(
    Math.abs(firstFocused.bodyX) > Math.abs(beforeFocus.bodyX) * 0.35,
    'focus should not snap an already moving torso to zero',
  )
  for (let frame = 722; frame <= 900; frame += 1) sway.update(frame / 60, 1, 1)
  const centered = sway.update(901 / 60, 1, 1)
  assert.ok(Math.abs(centered.bodyX) < 0.12)
  assert.ok(Math.abs(centered.bodyY) < 0.12)
})
