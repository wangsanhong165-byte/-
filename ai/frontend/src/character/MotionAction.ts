import type { MotionKeyframe, MotionPreset } from './MotionArbiter'
import type { AvatarLogicalMotionPreset } from './AvatarCapabilityProfile.ts'
import { sampleMotionCurve } from './performance/MotionCurve.ts'

export const MOTION_PRIMITIVES = [
  'nod',
  'tilt_left',
  'tilt_right',
  'lean_forward',
  'lean_back',
  'sway',
  'look_left',
  'look_right',
  'breathe',
  'shrug',
] as const

export type MotionPrimitive = typeof MOTION_PRIMITIVES[number]

export interface MotionActionStep {
  atMs: number
  durationMs: number
  primitive: MotionPrimitive
  intensity: number
}

export interface MotionPlan {
  durationMs: number
  steps: MotionActionStep[]
}

export interface MotionActionDefinition extends MotionPlan {
  version: 1
  id: string
  name: string
  recoveryMs?: number
}

export type Live2DActionsByModel = Record<string, MotionActionDefinition[]>

export interface MotionPlanValidation {
  ok: boolean
  errors: string[]
  plan?: MotionPlan
}

type PrimitiveFrame = {
  progress: number
  values: Record<string, number>
}

// LLM plans are still capped to 8s by the backend boundary. Locally generated
// speech choreography may span a longer decoded utterance.
const MAX_ACTION_DURATION_MS = 30_000
const MAX_LLM_STEPS = 3
const MAX_AUTHORED_STEPS = 16
const MAX_LOGICAL_PRESETS = 32
const MAX_LOGICAL_KEYFRAMES = 256
const SAFE_LOGICAL_PARAMETER = /^(head|body|eye|brow|mouth|blink|tail|arm|hand|ear|hair|accessory)\.[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)*$/

export function validateMotionPlan(
  value: unknown,
  maxSteps = MAX_LLM_STEPS,
): MotionPlanValidation {
  const errors: string[] = []
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, errors: ['motion plan must be an object'] }
  }
  const record = value as Record<string, unknown>
  if ('keyframes' in record || 'parameter' in record || 'parameters' in record) {
    errors.push('renderer parameters and keyframes are not allowed in a motion plan')
  }
  const durationMs = finiteNumber(record.durationMs)
  if (durationMs === null || durationMs < 300 || durationMs > MAX_ACTION_DURATION_MS) {
    errors.push(`durationMs must be between 300 and ${MAX_ACTION_DURATION_MS}`)
  }
  if (!Array.isArray(record.steps) || record.steps.length < 1 || record.steps.length > maxSteps) {
    errors.push(`steps must contain between 1 and ${maxSteps} entries`)
  }

  const steps: MotionActionStep[] = []
  if (Array.isArray(record.steps)) {
    record.steps.slice(0, maxSteps + 1).forEach((raw, index) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        errors.push(`steps[${index}] must be an object`)
        return
      }
      const step = raw as Record<string, unknown>
      if ('parameter' in step || 'value' in step || 'keyframes' in step) {
        errors.push(`steps[${index}] cannot contain renderer parameters or keyframes`)
      }
      const primitive = typeof step.primitive === 'string' ? step.primitive : ''
      if (!MOTION_PRIMITIVES.includes(primitive as MotionPrimitive)) {
        errors.push(`steps[${index}].primitive is not allowed`)
      }
      const atMs = finiteNumber(step.atMs)
      const stepDuration = finiteNumber(step.durationMs)
      const intensity = finiteNumber(step.intensity)
      if (atMs === null || atMs < 0 || (durationMs !== null && atMs > durationMs)) {
        errors.push(`steps[${index}].atMs is outside the action duration`)
      }
      if (stepDuration === null || stepDuration < 120 || stepDuration > 2_500) {
        errors.push(`steps[${index}].durationMs must be between 120 and 2500`)
      }
      if (
        atMs !== null
        && stepDuration !== null
        && durationMs !== null
        && atMs + stepDuration > durationMs
      ) {
        errors.push(`steps[${index}] ends after the action duration`)
      }
      if (intensity === null || intensity < 0 || intensity > 1) {
        errors.push(`steps[${index}].intensity must be between 0 and 1`)
      }
      if (
        MOTION_PRIMITIVES.includes(primitive as MotionPrimitive)
        && atMs !== null
        && stepDuration !== null
        && intensity !== null
      ) {
        steps.push({
          atMs: Math.round(atMs),
          durationMs: Math.round(stepDuration),
          primitive: primitive as MotionPrimitive,
          intensity,
        })
      }
    })
  }

  return {
    ok: errors.length === 0,
    errors,
    plan: errors.length === 0 && durationMs !== null
      ? { durationMs: Math.round(durationMs), steps }
      : undefined,
  }
}

export function normalizeMotionAction(value: unknown): MotionActionDefinition {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Action must be an object')
  }
  const record = value as Record<string, unknown>
  const validation = validateMotionPlan(record, MAX_AUTHORED_STEPS)
  if (!validation.ok || !validation.plan) {
    throw new Error(validation.errors.join('; '))
  }
  const id = normalizeActionId(record.id)
  const name = typeof record.name === 'string' && record.name.trim()
    ? record.name.trim().slice(0, 48)
    : id
  const recoveryMs = finiteNumber(record.recoveryMs)
  return {
    version: 1,
    id,
    name,
    durationMs: validation.plan.durationMs,
    steps: validation.plan.steps,
    ...(recoveryMs !== null
      ? { recoveryMs: Math.round(clamp(recoveryMs, 300, 600)) }
      : {}),
  }
}

export function normalizeMotionActions(value: unknown): MotionActionDefinition[] {
  if (!Array.isArray(value)) return []
  const actions: MotionActionDefinition[] = []
  const ids = new Set<string>()
  for (const raw of value.slice(0, 32)) {
    try {
      const action = normalizeMotionAction(raw)
      if (ids.has(action.id)) continue
      ids.add(action.id)
      actions.push(action)
    } catch {
      // Invalid persisted/imported actions are omitted rather than entering runtime.
    }
  }
  return actions
}

/**
 * Normalize trusted model-authored timelines. These are intentionally a
 * different boundary from LLM motion plans: they may contain many logical
 * keyframes, but never renderer IDs such as ParamAngleX.
 */
export function normalizeLogicalMotionPresets(value: unknown): AvatarLogicalMotionPreset[] {
  if (!Array.isArray(value)) return []
  const presets: AvatarLogicalMotionPreset[] = []
  const names = new Set<string>()
  for (const raw of value.slice(0, MAX_LOGICAL_PRESETS)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    const record = raw as Record<string, unknown>
    const name = normalizePresetName(record.name)
    const duration = finiteNumber(record.duration)
    const rawKeyframes = record.keyframes
    if (!name || duration === null || duration < 300 || duration > MAX_ACTION_DURATION_MS
        || !Array.isArray(rawKeyframes) || rawKeyframes.length < 2) continue
    if (names.has(name)) continue
    const keyframes: AvatarLogicalMotionPreset['keyframes'] = []
    for (const rawFrame of rawKeyframes.slice(0, MAX_LOGICAL_KEYFRAMES)) {
      if (!rawFrame || typeof rawFrame !== 'object' || Array.isArray(rawFrame)) continue
      const frame = rawFrame as Record<string, unknown>
      const time = finiteNumber(frame.time)
      const parameter = typeof frame.parameter === 'string' ? frame.parameter.trim().toLowerCase() : ''
      const value = finiteNumber(frame.value)
      if (time === null || value === null || !SAFE_LOGICAL_PARAMETER.test(parameter)) continue
      if (time < 0 || time > duration || value < -30 || value > 30) continue
      keyframes.push({ time: Math.round(time), parameter, value })
    }
    if (keyframes.length < 2) continue
    keyframes.sort((left, right) => left.time - right.time || left.parameter.localeCompare(right.parameter))
    names.add(name)
    const fadeInMs = finiteNumber(record.fadeInMs)
    const recoveryMs = finiteNumber(record.recoveryMs)
    presets.push({
      name,
      duration: Math.round(duration),
      keyframes,
      ...(fadeInMs !== null ? { fadeInMs: Math.round(clamp(fadeInMs, 0, 500)) } : {}),
      ...(recoveryMs !== null ? { recoveryMs: Math.round(clamp(recoveryMs, 300, 600)) } : {}),
    })
  }
  return presets
}

export function compileMotionAction(action: MotionActionDefinition): MotionPreset {
  const tracks = action.steps.map(step => ({
    start: step.atMs,
    end: step.atMs + step.durationMs,
    duration: step.durationMs,
    intensity: step.intensity,
    frames: primitiveFrames(step.primitive),
  }))
  const parameters = new Set(tracks.flatMap(track =>
    track.frames.flatMap(frame => Object.keys(frame.values))))
  const timeline = new Set<number>([0, action.durationMs])
  for (const track of tracks) {
    for (const frame of track.frames) {
      timeline.add(Math.round(clamp(
        track.start + track.duration * frame.progress,
        0,
        action.durationMs,
      )))
    }
  }
  const keyframes: MotionKeyframe[] = []
  for (const time of [...timeline].sort((left, right) => left - right)) {
    for (const parameter of parameters) {
      let value = 0
      for (const track of tracks) {
        if (time < track.start || time > track.end) continue
        const localProgress = clamp((time - track.start) / track.duration, 0, 1)
        const frames = track.frames
          .filter(frame => parameter in frame.values)
          .map(frame => ({ time: frame.progress, value: frame.values[parameter] }))
        if (frames.length) value += sampleMotionCurve(frames, localProgress) * track.intensity
      }
      keyframes.push({ time, parameter, value })
    }
  }
  return {
    name: action.id,
    duration: action.durationMs,
    recoveryMs: action.recoveryMs ?? 420,
    keyframes,
  }
}

export function compileMotionPlan(
  plan: unknown,
  id: string,
  name = 'AI 动作',
): MotionPreset | null {
  const validation = validateMotionPlan(plan)
  if (!validation.ok || !validation.plan) return null
  const action: MotionActionDefinition = {
    version: 1,
    id: normalizeActionId(id),
    name,
    ...validation.plan,
  }
  return compileMotionAction(action)
}

/** Compile semantic gestures through a restrained model-specific recipe. */
export function compileMotionPlanForModel(
  plan: unknown,
  id: string,
  modelName: string,
  name = 'AI 动作',
): MotionPreset | null {
  const preset = compileMotionPlan(plan, id, name)
  if (!preset) return null
  const normalizedModel = modelName.toLowerCase()
  if (!['design_genius_white', 'shirone'].includes(normalizedModel)) return preset

  const frames = preset.keyframes.map(frame => ({ ...frame }))
  const occupied = new Set(frames.map(frame => `${frame.time}:${frame.parameter}`))
  const couplings: Record<string, { parameter: string; scale: number }> = {
    'head.x': { parameter: 'body.x', scale: normalizedModel === 'shirone' ? -0.14 : -0.1 },
    'head.y': { parameter: 'body.y', scale: normalizedModel === 'shirone' ? -0.2 : -0.16 },
    'head.z': { parameter: 'body.z', scale: normalizedModel === 'shirone' ? -0.24 : -0.18 },
  }
  if (normalizedModel === 'shirone') {
    for (const frame of preset.keyframes) {
      if (!['body.x', 'body.y', 'body.z', 'head.z'].includes(frame.parameter)) continue
      const key = `${frame.time}:tail.z`
      if (occupied.has(key)) continue
      occupied.add(key)
      frames.push({
        time: frame.time,
        parameter: 'tail.z',
        value: frame.value * (frame.parameter === 'head.z' ? -0.22 : 0.16),
      })
    }
  }
  for (const frame of preset.keyframes) {
    const coupling = couplings[frame.parameter]
    if (!coupling) continue
    const key = `${frame.time}:${coupling.parameter}`
    if (occupied.has(key)) continue
    occupied.add(key)
    frames.push({
      time: frame.time,
      parameter: coupling.parameter,
      value: frame.value * coupling.scale,
    })
  }
  frames.sort((left, right) => left.time - right.time
    || left.parameter.localeCompare(right.parameter))
  return { ...preset, keyframes: frames }
}

function primitiveFrames(primitive: MotionPrimitive): PrimitiveFrame[] {
  // Peaks restore the Phase-A calibration baseline (docs/live2d-tuning-plan.md,
  // validated against the video reference) — the earlier +30% overshoot read as
  // overacted. Shape stays asymmetric: fast attack, settle, no metronome.
  switch (primitive) {
    case 'nod':
      return [
        { progress: 0, values: { 'head.y': 0 } },
        { progress: .28, values: { 'head.y': -9 } },
        { progress: .62, values: { 'head.y': 5 } },
        { progress: 1, values: { 'head.y': 0 } },
      ]
    case 'tilt_left':
      return axisFrames('head.z', -12)
    case 'tilt_right':
      return axisFrames('head.z', 12)
    case 'lean_forward':
      return combinedFrames({ 'body.y': 6, 'head.y': 3 })
    case 'lean_back':
      return combinedFrames({ 'body.y': -5, 'head.y': -2 })
    case 'sway':
      // Asymmetric travel with unequal endpoints: same time and distance
      // both ways reads as a metronome, not a weight shift.
      return [
        { progress: 0, values: { 'body.x': 0, 'head.z': 0 } },
        { progress: .32, values: { 'body.x': -7, 'head.z': -4 } },
        { progress: .7, values: { 'body.x': 6.4, 'head.z': 3.6 } },
        { progress: 1, values: { 'body.x': 0, 'head.z': 0 } },
      ]
    case 'look_left':
      return combinedFrames({ 'eye.x': -.75, 'head.x': -7 })
    case 'look_right':
      return combinedFrames({ 'eye.x': .75, 'head.x': 7 })
    case 'breathe':
      return axisFrames('body.y', 3.5)
    case 'shrug':
      return combinedFrames({ 'body.y': 3.5, 'head.z': 2.5 })
  }
}

function axisFrames(parameter: string, peak: number): PrimitiveFrame[] {
  return combinedFrames({ [parameter]: peak })
}

function combinedFrames(values: Record<string, number>): PrimitiveFrame[] {
  const zero = Object.fromEntries(Object.keys(values).map(key => [key, 0]))
  const settle = Object.fromEntries(
    Object.keys(values).map(key => [key, values[key] * -0.1]),
  )
  // Fast attack, slow release with a slight counter-sway settle: a symmetric
  // out-and-back arch reads as canned animation, real beats recoil a little.
  return [
    { progress: 0, values: zero },
    { progress: .3, values },
    { progress: .82, values: settle },
    { progress: 1, values: zero },
  ]
}

function normalizeActionId(value: unknown): string {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : ''
  const normalized = raw.replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40)
  if (!normalized) throw new Error('Action id is required')
  return normalized
}

function normalizePresetName(value: unknown): string {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return raw.replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48)
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}
