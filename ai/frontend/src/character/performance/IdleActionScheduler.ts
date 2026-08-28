import type {
  AvatarPerformanceCapabilities,
  CharacterPerformancePersonality,
} from '../AvatarCapabilityProfile'
import { createSeededRandom, type RandomSource } from './SeededRandom.ts'
import { sampleMotionCurve } from './MotionCurve.ts'
import type { VADVector } from './VADState'

export type IdleActionLabel =
  | 'small-nod'
  | 'head-tilt'
  | 'weight-shift'
  | 'gentle-lean'
  | 'sigh-sink'
  | 'slow-blink'
  | 'reposition'

export interface IdleActionPose {
  headX: number
  headY: number
  headZ: number
  bodyX: number
  bodyY: number
  eyeX: number
  eyeY: number
  eyeClose: number
}

interface PoseKeyframe {
  progress: number
  pose: Partial<IdleActionPose>
}

interface ActiveAction {
  label: IdleActionLabel
  direction: -1 | 0 | 1
  startedAt: number
  duration: number
  keyframes: PoseKeyframe[]
}

export interface IdleActionContext {
  allowed: boolean
  focusLevel: number
  capabilities?: AvatarPerformanceCapabilities
  personality?: CharacterPerformancePersonality
  vad: VADVector
}

export interface IdleActionState {
  activeAction: IdleActionLabel | null
  direction: -1 | 0 | 1
  progress: number
  nextActionAt: number
  recentActions: IdleActionLabel[]
  recentDirections: Array<-1 | 1>
}

const labels: IdleActionLabel[] = [
  'small-nod', 'head-tilt', 'weight-shift',
  'gentle-lean', 'sigh-sink', 'slow-blink',
  'reposition',
]

export class IdleActionScheduler {
  private random: RandomSource
  private readonly spontaneity: number
  private readonly gain: number
  private readonly recentWindow: number
  private active: ActiveAction | null = null
  private nextActionAt = 8
  private recentActions: IdleActionLabel[] = []
  private recentDirections: Array<-1 | 1> = []
  private lastProgress = 0

  constructor(
    seed: number,
    spontaneity = 1,
    gain = 1,
    recentWindow = 3,
  ) {
    this.random = createSeededRandom(seed)
    this.spontaneity = spontaneity
    this.gain = gain
    this.recentWindow = recentWindow
  }

  update(timeSeconds: number, context: IdleActionContext): IdleActionPose {
    if (!context.allowed) {
      this.active = null
      this.nextActionAt = timeSeconds + this.sampleInterval(context.focusLevel)
      this.lastProgress = 0
      return neutralPose()
    }
    if (this.active) {
      const elapsed = timeSeconds - this.active.startedAt
      if (elapsed < this.active.duration) {
        this.lastProgress = clamp(elapsed / this.active.duration, 0, 1)
        return evaluateKeyframes(this.active.keyframes, this.lastProgress)
      }
      this.active = null
      this.lastProgress = 0
    }
    if (timeSeconds < this.nextActionAt) return neutralPose()

    const available = labels.filter(label => isAvailable(label, context.capabilities))
    const fresh = available.filter(label => !this.recentActions.includes(label))
    const pool = fresh.length ? fresh : available
    if (!pool.length) return neutralPose()
    const label = weightedPick(pool, context.personality, context.vad, this.random)
    const direction = isDirectional(label) ? this.pickDirection() : 0
    const duration = durationFor(label, this.random)
    this.active = {
      label,
      direction,
      duration,
      startedAt: timeSeconds,
      keyframes: buildKeyframes(label, direction, this.gain),
    }
    this.remember(label, direction)
    this.nextActionAt = timeSeconds + duration + this.sampleInterval(context.focusLevel)
    return evaluateKeyframes(this.active.keyframes, 0)
  }

  getState(): IdleActionState {
    return {
      activeAction: this.active?.label ?? null,
      direction: this.active?.direction ?? 0,
      progress: this.lastProgress,
      nextActionAt: this.nextActionAt,
      recentActions: [...this.recentActions],
      recentDirections: [...this.recentDirections],
    }
  }

  private pickDirection(): -1 | 1 {
    let direction: -1 | 1 = this.random() < 0.5 ? -1 : 1
    if (this.recentDirections.at(-1) === direction) direction = direction === -1 ? 1 : -1
    return direction
  }

  private remember(label: IdleActionLabel, direction: -1 | 0 | 1): void {
    this.recentActions.push(label)
    while (this.recentActions.length > this.recentWindow) this.recentActions.shift()
    if (direction) {
      this.recentDirections.push(direction)
      while (this.recentDirections.length > this.recentWindow) this.recentDirections.shift()
    }
  }

  private sampleInterval(focusLevel: number): number {
    const activity = clamp(this.spontaneity, 0.1, 1.25)
    // ~4.5-9s base cadence (was 8-16s) so idle behaviours are visible and the
    // character reads as "alive" rather than statue-like.
    return (4.5 + this.random() * 4.5) / activity + clamp(focusLevel, 0, 1) * 2
  }
}

function buildKeyframes(
  label: IdleActionLabel,
  direction: -1 | 0 | 1,
  gain: number,
): PoseKeyframe[] {
  const side = direction || 1
  let frames: PoseKeyframe[]
  if (label === 'small-nod') {
    frames = [frame(0, {}), frame(.2, { headY: 6.5, bodyY: 1 }),
      frame(.42, { headY: -2.2 }), frame(.68, { headY: 1.4 }), frame(1, {})]
  } else if (label === 'head-tilt') {
    frames = [frame(0, {}), frame(.28, { headX: side * 1.6, headZ: side * 8, eyeX: -side * .22 }),
      frame(.64, { headZ: side * 6.4 }), frame(1, {})]
  } else if (label === 'weight-shift') {
    frames = [frame(0, {}), frame(.34, { bodyX: side * 6.5, headX: -side * 1.6, headZ: -side * 3 }),
      frame(.7, { bodyX: side * 5.2, headZ: -side * 2.4 }), frame(1, {})]
  } else if (label === 'gentle-lean') {
    frames = [frame(0, {}), frame(.3, { bodyY: side * 3.8, headY: side * 3, eyeY: side * .15 }),
      frame(.58, { bodyY: side * 3.2, headY: side * 2.4 }),
      frame(.8, { bodyY: -side * .6 }), frame(1, {})]
  } else if (label === 'sigh-sink') {
    frames = [frame(0, {}), frame(.2, { eyeClose: .12 }),
      frame(.48, { headY: -5, bodyY: -2.9, eyeY: -.28, eyeClose: .34 }),
      frame(.73, { headY: -3.6, bodyY: -2.1, eyeClose: .1 }), frame(1, {})]
  } else if (label === 'reposition') {
    // Occasional large posture change — supplies the "long tail" of motion the
    // reference performance shows (rare 10°+ moves between many small ones).
    frames = [frame(0, {}), frame(.32, { bodyX: side * 9.5, headX: -side * 2.2, headZ: -side * 3.6 }),
      frame(.66, { bodyX: side * 7.6, headZ: -side * 2.8 }), frame(1, {})]
  } else {
    frames = [frame(0, {}), frame(.3, { eyeClose: .82, headY: -.55 }),
      frame(.47, { eyeClose: 1, headY: -.75 }),
      frame(.72, { eyeClose: .18 }), frame(1, {})]
  }
  return frames.map(item => ({
    progress: item.progress,
    pose: Object.fromEntries(
      Object.entries(item.pose).map(([key, value]) => [key, (value ?? 0) * gain]),
    ),
  }))
}

function frame(progress: number, pose: Partial<IdleActionPose>): PoseKeyframe {
  return { progress, pose }
}

function evaluateKeyframes(frames: PoseKeyframe[], progress: number): IdleActionPose {
  const result = neutralPose()
  for (const key of poseKeys) {
    result[key] = sampleMotionCurve(
      frames.map(frame => ({ time: frame.progress, value: frame.pose[key] ?? 0 })),
      progress,
    )
  }
  return result
}

function isAvailable(label: IdleActionLabel, capabilities?: AvatarPerformanceCapabilities): boolean {
  if (!capabilities) return true
  if (label === 'slow-blink') return capabilities.eyeBlink !== false
  if (label === 'weight-shift' || label === 'gentle-lean' || label === 'reposition') return capabilities.bodyControl !== false
  return capabilities.headControl !== false
}

function weightedPick(
  pool: IdleActionLabel[],
  personality: CharacterPerformancePersonality | undefined,
  vad: VADVector,
  random: RandomSource,
): IdleActionLabel {
  const expressive = personality?.expressiveness ?? .75
  const positive = Math.max(0, vad.valence)
  const negative = Math.max(0, -vad.valence)
  const active = Math.max(0, vad.arousal)
  const weights = pool.map(label => {
    if (label === 'small-nod') return .8 + expressive + positive * .4 + active * .35
    if (label === 'sigh-sink') return .55 + negative * .8 + Math.max(0, -vad.arousal) * .5
    if (label === 'gentle-lean') return .7 + positive * .45 + Math.max(0, vad.dominance) * .3
    return 1
  })
  let cursor = random() * weights.reduce((sum, value) => sum + value, 0)
  for (let index = 0; index < pool.length; index += 1) {
    cursor -= weights[index]
    if (cursor <= 0) return pool[index]
  }
  return pool[pool.length - 1]
}

function durationFor(label: IdleActionLabel, random: RandomSource): number {
  const ranges: Record<IdleActionLabel, readonly [number, number]> = {
    'small-nod': [.82, 1.2], 'head-tilt': [1.35, 2.15],
    'weight-shift': [1.65, 2.65], 'gentle-lean': [1.25, 2.05],
    'sigh-sink': [1.7, 2.8], 'slow-blink': [.72, 1.08],
    'reposition': [2.2, 3.4],
  }
  const [min, max] = ranges[label]
  return min + (max - min) * random()
}

const poseKeys: Array<keyof IdleActionPose> = [
  'headX', 'headY', 'headZ', 'bodyX', 'bodyY', 'eyeX', 'eyeY', 'eyeClose',
]
function neutralPose(): IdleActionPose {
  return { headX: 0, headY: 0, headZ: 0, bodyX: 0, bodyY: 0, eyeX: 0, eyeY: 0, eyeClose: 0 }
}
function isDirectional(label: IdleActionLabel): boolean {
  return ['head-tilt', 'weight-shift', 'gentle-lean', 'reposition'].includes(label)
}
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}
