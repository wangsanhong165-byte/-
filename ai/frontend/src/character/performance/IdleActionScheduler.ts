import type {
  AvatarPerformanceCapabilities,
  CharacterPerformancePersonality,
} from '../AvatarCapabilityProfile'
import { createSeededRandom, type RandomSource } from './SeededRandom.ts'
import { sampleMotionCurve } from './MotionCurve.ts'
import { IDLE_TINTS } from './performance-recipes.ts'
import type { VADVector } from './VADState'

export type IdleActionLabel =
  | 'small-nod'
  | 'head-tilt'
  | 'weight-shift'
  | 'look-around'
  | 'sigh-sink'
  | 'slow-blink'
  | 'reposition'
  | 'big-tilt'
  | 'ear-flick'
  | 'tail-sweep'
  | 'micro-stretch'
  | 'look-back'

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
  /** Emotion-driven weight modifiers for the pick pool (see
   *  performance-recipes IDLE_TINTS): emotion colors which idle beats are
   *  likely, so even "standing there" keeps performing the mood. */
  emotion?: string
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
  'look-around', 'sigh-sink', 'slow-blink',
  'reposition', 'big-tilt', 'ear-flick', 'tail-sweep',
  'micro-stretch', 'look-back',
]

/** Local-pose idle actions: the scheduler animates them inline. */
const LOCAL_LABELS: ReadonlySet<string> = new Set([
  'small-nod', 'head-tilt', 'weight-shift', 'look-around',
  'sigh-sink', 'slow-blink', 'reposition', 'big-tilt',
  'micro-stretch', 'look-back',
])

/** Preset-backed idle phrases and the preset they request. */
const PHRASE_PRESETS: Readonly<Record<string, string>> = {
  'ear-flick': 'ear_flick',
  'tail-sweep': 'tail_sweep',
}

/** Scheduler → arbiter bridge: the engine installs this so preset phrases
 *  play through the real ownership/fade/release path. */
export type IdlePhraseRequest = (presetName: string) => boolean

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
  private phraseRequest: IdlePhraseRequest | null = null

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

  /** Install the arbiter bridge for preset-backed phrases (ear_flick etc.). */
  setPhraseRequest(request: IdlePhraseRequest | null): void {
    this.phraseRequest = request
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
    let pool = fresh.length ? fresh : available
    if (!pool.length) return neutralPose()
    // Preset phrases need the arbiter bridge — without it (harness paths,
    // tests without an arbiter) they are not in the pool at all.
    if (!this.phraseRequest) pool = pool.filter(label => LOCAL_LABELS.has(label))
    if (!pool.length) return neutralPose()
    const label = weightedPick(pool, context.personality, context.vad, this.random, context.emotion)
    const preset = PHRASE_PRESETS[label]
    if (preset) {
      // Preset-backed phrase: hand it to the arbiter. It plays through the
      // real ownership path; this scheduler only paces the slot.
      const started = this.phraseRequest?.(preset) ?? false
      const duration = durationFor(label, this.random)
      this.remember(label, 0)
      this.nextActionAt = timeSeconds + duration + this.sampleInterval(context.focusLevel)
      if (!started) return neutralPose()
      // Hold the slot open while the preset plays (head/body keys stay at
      // neutral — the preset owns them through the motion channel).
      this.active = { label, direction: 0, duration, startedAt: timeSeconds, keyframes: [frame(0, {}), frame(1, {})] }
      return neutralPose()
    }
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
    // ~6.5-13s base cadence. Neuro reference: torso-level repositioning is
    // RARE between many small head moves (head liveliness comes from the
    // speech micro layer and attention episodes, not from this scheduler).
    return (6.5 + this.random() * 6.5) / activity + clamp(focusLevel, 0, 1) * 2
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
    frames = [frame(0, {}), frame(.2, { headY: 5.6, bodyY: 1 }),
      frame(.42, { headY: -2 }), frame(.68, { headY: 1.3 }), frame(1, {})]
  } else if (label === 'head-tilt') {
    frames = [frame(0, {}), frame(.28, { headX: side * 1.4, headZ: side * 6, eyeX: -side * .2 }),
      frame(.64, { headZ: side * 4.8 }), frame(1, {})]
  } else if (label === 'weight-shift') {
    frames = [frame(0, {}), frame(.34, { bodyX: side * 5.5, headX: -side * 1.4, headZ: -side * 2.6 }),
      frame(.7, { bodyX: side * 4.4, headZ: -side * 2 }), frame(1, {})]
  } else if (label === 'look-around') {
    // 2026-09-05 redesign: replaces 'gentle-lean' — a slow pure body-pitch in
    // idle read as an eerie slouch (user report "大前倾不太好看"). A motivated
    // glance is lateral, COUPLED (eyes lead, head follows, chin stays level,
    // torso weight follows), and holds briefly like she noticed something.
    frames = [frame(0, {}), frame(.22, { eyeX: side * .3, headX: side * 2.4, headZ: side * 1.6 }),
      frame(.5, { eyeX: side * .38, headX: side * 6.4, headZ: side * 2.6, bodyX: side * 1.6 }),
      frame(.72, { eyeX: side * .3, headX: side * 5.2, headZ: side * 2.2 }),
      frame(.88, { eyeX: side * .1, headX: side * 1.6, headZ: side * .8 }), frame(1, {})]
  } else if (label === 'sigh-sink') {
    // Redesigned: the old slow -5deg head pitch + forward body slump read as
    // the "大前倾" slouch. A sigh now keeps the torso upright — head drop is
    // smaller and coupled with a side settle (slumping is never symmetric),
    // eyelids sink with it, and the hold breathes before returning.
    frames = [frame(0, {}), frame(.2, { eyeClose: .12 }),
      frame(.48, { headY: -3.2, headZ: side * 1.8, eyeY: -.22, eyeClose: .34 }),
      frame(.7, { headY: -2.6, headZ: side * 1.4, eyeClose: .12 }),
      frame(.86, { headY: -1.2, headZ: side * .6 }), frame(1, {})]
  } else if (label === 'big-tilt') {
    // The rare deliberate LARGE beat the reference performance shows (a
    // 30-40deg head smoosh moment): rare in the pick weights, big in shape.
    frames = [frame(0, {}), frame(.24, { headZ: side * 7, eyeX: -side * .3 }),
      frame(.5, { headZ: side * 16, headX: -side * 2.2, eyeX: -side * .22, bodyX: side * 2.2 }),
      frame(.72, { headZ: side * 12 }), frame(1, {})]
  } else if (label === 'reposition') {
    // Occasional large posture change — supplies the "long tail" of motion the
    // reference performance shows (rare 10°+ moves between many small ones).
    frames = [frame(0, {}), frame(.32, { bodyX: side * 8, headX: -side * 1.8, headZ: -side * 3 }),
      frame(.66, { bodyX: side * 6.4, headZ: -side * 2.4 }), frame(1, {})]
  } else if (label === 'micro-stretch') {
    // A small wake-up stretch: chest lifts, chin raises, slight side bend —
    // the "been standing a while" comfort move. Slow and round, never snappy.
    frames = [frame(0, {}), frame(.35, { bodyY: 2, headY: 2.2, bodyX: side * 1.4, headZ: side * 1.6 }),
      frame(.62, { bodyY: 1.7, headY: 1.8, bodyX: side * 1.1 }),
      frame(.85, { bodyY: .5, headY: .45 }), frame(1, {})]
  } else if (label === 'look-back') {
    // Head dips, gaze slides down-and-up as if checking something at waist
    // height, then returns — the quiet "thinking about you" idle beat.
    frames = [frame(0, {}), frame(.3, { headY: -3.2, eyeY: -.3, headZ: side * 1.2 }),
      frame(.58, { headY: -2.4, eyeY: -.16 }),
      frame(.8, { headY: -.6, eyeY: .1 }), frame(1, {})]
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
  if (label === 'weight-shift' || label === 'look-around' || label === 'reposition' || label === 'micro-stretch') return capabilities.bodyControl !== false
  // Accessory phrases need the accessory channels (ear/tail) to exist at all.
  if (label === 'ear-flick' || label === 'tail-sweep') return Boolean(capabilities.secondaryMotion)
  return capabilities.headControl !== false
}

function weightedPick(
  pool: IdleActionLabel[],
  personality: CharacterPerformancePersonality | undefined,
  vad: VADVector,
  random: RandomSource,
  emotion?: string,
): IdleActionLabel {
  const expressive = personality?.expressiveness ?? .75
  const positive = Math.max(0, vad.valence)
  const negative = Math.max(0, -vad.valence)
  const active = Math.max(0, vad.arousal)
  const weights = pool.map(label => {
    if (label === 'small-nod') return .8 + expressive + positive * .4 + active * .35
    if (label === 'sigh-sink') return .55 + negative * .8 + Math.max(0, -vad.arousal) * .5
    if (label === 'look-around') return .85 + positive * .5 + active * .3 + Math.max(0, vad.dominance) * .25
    if (label === 'big-tilt') return .3
    if (label === 'micro-stretch') return .4 + Math.max(0, -vad.arousal) * .6
    if (label === 'look-back') return .45
    if (label === 'ear-flick') return .7 + active * .5
    if (label === 'tail-sweep') return .7 + positive * .3
    return 1
  })
  // Emotion tint: the recipe registry colors the pick pool per emotion so a
  // mood keeps performing even while "just standing there" (playful idles
  // tease, sad idles sink). Multipliers, not overrides — personality and VAD
  // keep their vote.
  const tint = emotion ? IDLE_TINTS[emotion] : undefined
  const tinted = tint
    ? weights.map((weight, index) => weight * (tint[pool[index]] ?? 1))
    : weights
  let cursor = random() * tinted.reduce((sum, value) => sum + value, 0)
  for (let index = 0; index < pool.length; index += 1) {
    cursor -= tinted[index]
    if (cursor <= 0) return pool[index]
  }
  return pool[pool.length - 1]
}

function durationFor(label: IdleActionLabel, random: RandomSource): number {
  const ranges: Record<string, readonly [number, number]> = {
    'small-nod': [.82, 1.2], 'head-tilt': [1.35, 2.15],
    'weight-shift': [1.65, 2.65], 'look-around': [2.1, 3.2],
    'sigh-sink': [1.7, 2.8], 'slow-blink': [.72, 1.08],
    'reposition': [2.2, 3.4], 'big-tilt': [2.4, 3.4],
    'ear-flick': [1.3, 1.8], 'tail-sweep': [1.9, 2.4],
    'micro-stretch': [1.6, 2.6], 'look-back': [1.2, 2.0],
  }
  const [min, max] = ranges[label] ?? [1.2, 1.8]
  return min + (max - min) * random()
}

const poseKeys: Array<keyof IdleActionPose> = [
  'headX', 'headY', 'headZ', 'bodyX', 'bodyY', 'eyeX', 'eyeY', 'eyeClose',
]
function neutralPose(): IdleActionPose {
  return { headX: 0, headY: 0, headZ: 0, bodyX: 0, bodyY: 0, eyeX: 0, eyeY: 0, eyeClose: 0 }
}
function isDirectional(label: IdleActionLabel): boolean {
  return ['head-tilt', 'weight-shift', 'look-around', 'reposition', 'big-tilt',
    'micro-stretch', 'look-back'].includes(label)
}
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}
