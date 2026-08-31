import type { CharacterIntent } from '../CharacterBehaviorResolver.ts'
import type { MotionPrimitive } from '../MotionAction.ts'

export interface PerformanceDirectorOptions {
  audioWaitMs?: number
  repeatWindowMs?: number
}

interface StagedPerformance {
  turnId: string
  base: CharacterIntent
  segments: Array<Record<string, unknown>>
  stagedAt: number
}

interface AudioTiming {
  turnId: string
  startedAt: number
  durationMs: number
}

interface ScheduledCue {
  dueAt: number
  intent: CharacterIntent
}

/**
 * Turn-scoped semantic performance scheduler.
 *
 * It adopts Soullink's duration scheduling principle: LLM semantics are
 * aligned to the real decoded audio duration, while renderer parameters and
 * per-frame curves remain owned by the existing Live2D control chain.
 */
export class PerformanceDirector {
  private readonly now: () => number
  private readonly audioWaitMs: number
  private readonly repeatWindowMs: number
  private staged: StagedPerformance | null = null
  private audio: AudioTiming | null = null
  private cues: ScheduledCue[] = []
  private emittedCueCount = 0
  private readonly recentGestures = new Map<string, number>()

  constructor(
    now: () => number = () => performance.now(),
    options: PerformanceDirectorOptions = {},
  ) {
    this.now = now
    this.audioWaitMs = clamp(options.audioWaitMs ?? 240, 80, 800)
    this.repeatWindowMs = clamp(options.repeatWindowMs ?? 6_000, 0, 30_000)
  }

  stage(base: CharacterIntent, segments?: Array<Record<string, unknown>>): void {
    const turnId = base.turnId || ''
    this.staged = {
      turnId,
      base: { ...base, turnId },
      segments: segments?.length ? segments.map(segment => ({ ...segment })) : [],
      stagedAt: this.now(),
    }
    this.cues = []
    this.emittedCueCount = 0
    if (this.audio?.turnId === turnId) this.scheduleFromAudio(this.staged, this.audio)
  }

  onAudioStart(turnId: string, durationMs: number, sequence = 0): void {
    this.audio = {
      turnId,
      startedAt: this.now(),
      durationMs: clamp(durationMs, 120, 120_000),
    }
    if (this.staged?.turnId !== turnId) return
    // Per-segment playback (one clip per semantic segment): clip N's start IS
    // segment N's cue time — no proportional estimation needed. Re-anchor the
    // remaining cues so segment N fires now and later segments follow the real
    // measured clip lengths carried in segments[].durationMs.
    if (sequence > 0) {
      this.reanchorCuesFrom(sequence)
      return
    }
    if (this.hasMeasuredSegments()) {
      this.scheduleFromMeasuredSegments(this.staged, this.audio)
      return
    }
    this.scheduleFromAudio(this.staged, this.audio)
  }

  /** True when every staged segment carries a backend-measured durationMs. */
  private hasMeasuredSegments(): boolean {
    const segments = this.staged?.segments ?? []
    return segments.length > 0 && segments.every(
      segment => typeof segment?.durationMs === 'number' && Number.isFinite(segment.durationMs),
    )
  }

  /**
   * Real-clip timeline: cue i fires at startedAt + Σ(durationMs of clips 0..i-1).
   * Durations come from the synthesized WAVs (TTSStep), not character counts.
   */
  private scheduleFromMeasuredSegments(staged: StagedPerformance, audio: AudioTiming): void {
    const intents = this.buildIntents(staged)
    let cursor = audio.startedAt
    this.cues = intents.map((intent, index) => {
      const raw = staged.segments[index]?.durationMs
      const durationMs = clamp(typeof raw === 'number' && Number.isFinite(raw) ? raw : 1_200, 300, 30_000)
      const cue = { dueAt: cursor, intent: alignIntentToDuration(intent, durationMs) }
      cursor += durationMs
      return cue
    }).slice(this.emittedCueCount)
  }

  /**
   * Sequential playback: clip `sequence` just started, so segment `sequence`'s
   * cue is due NOW (its audio is the live clock — measured durations only pace
   * the future). Earlier segments are dropped; later ones accumulate from here.
   *
   * A cue whose segment already fired (measurement drift fired it early) must
   * NOT be regenerated: rebuilding from `sequence` alone would rewind the
   * counter and re-apply an expression/motion the previous cue already drove.
   */
  private reanchorCuesFrom(sequence: number): void {
    const staged = this.staged
    if (!staged) return
    const intents = this.buildIntents(staged)
    if (!intents.length) return
    const anchor = this.now()
    const current = clamp(Math.max(sequence, this.emittedCueCount), 0, intents.length)
    let cursor = anchor
    this.cues = intents.slice(current).map((intent, offset) => {
      const raw = staged.segments[current + offset]?.durationMs
      const durationMs = clamp(typeof raw === 'number' && Number.isFinite(raw) ? raw : 1_200, 300, 30_000)
      const cue = { dueAt: cursor, intent: alignIntentToDuration(intent, durationMs) }
      cursor += durationMs
      return cue
    })
    this.emittedCueCount = current
  }

  onAudioEnd(turnId: string): void {
    if (this.audio?.turnId === turnId) this.audio = null
    if (this.staged?.turnId === turnId) this.cues = []
  }

  /** Release a staged visual response only after playback is known unavailable. */
  onAudioUnavailable(turnId: string): void {
    if (this.staged?.turnId !== turnId || this.audio?.turnId === turnId) return
    this.scheduleFallback(this.staged)
  }

  cancelTurn(turnId: string): void {
    if (this.audio?.turnId === turnId) this.audio = null
    if (this.staged?.turnId !== turnId) return
    this.staged = null
    this.cues = []
    this.emittedCueCount = 0
  }

  reset(): void {
    this.staged = null
    this.audio = null
    this.cues = []
    this.emittedCueCount = 0
    this.recentGestures.clear()
  }

  update(): CharacterIntent[] {
    const timestamp = this.now()
    const due: CharacterIntent[] = []
    while (this.cues.length && this.cues[0].dueAt <= timestamp) {
      const scheduled = this.cues.shift()!
      if (!this.staged || scheduled.intent.turnId !== this.staged.turnId) continue
      this.emittedCueCount += 1
      const accepted = this.suppressRepeatedGesture(scheduled.intent, timestamp)
      // A repeated LLM gesture may be removed, but speech must never become
      // visually silent: deterministic local choreography remains available.
      due.push(withLocalSemanticChoreography(accepted))
    }
    return due
  }

  getDebugState(): Record<string, unknown> {
    return {
      turnId: this.staged?.turnId ?? null,
      audio: this.audio ? { ...this.audio } : null,
      pendingCues: this.cues.map(cue => ({
        dueAt: cue.dueAt,
        emotion: cue.intent.emotion,
        behavior: cue.intent.behavior,
        hasMotionPlan: Boolean(cue.intent.motionPlan),
      })),
      emittedCueCount: this.emittedCueCount,
      recentGestureCount: this.recentGestures.size,
    }
  }

  isAwaitingAudio(turnId: string): boolean {
    return this.staged?.turnId === turnId && this.audio?.turnId !== turnId
  }

  private scheduleFallback(staged: StagedPerformance): void {
    const intents = this.buildIntents(staged)
    let dueAt = staged.stagedAt + this.audioWaitMs
    this.cues = intents.map((intent, index) => {
      const durationMs = estimateSegmentMs(staged.segments[index])
      const cue = { dueAt, intent: alignIntentToDuration(intent, durationMs) }
      if (index < intents.length - 1) dueAt += durationMs
      return cue
    })
  }

  private scheduleFromAudio(staged: StagedPerformance, audio: AudioTiming): void {
    const intents = this.buildIntents(staged)
    const weights = intents.map((_, index) => segmentWeight(staged.segments[index]))
    const totalWeight = weights.reduce((sum, value) => sum + value, 0) || 1
    let elapsedWeight = 0
    this.cues = intents.map((intent, index) => {
      const dueAt = audio.startedAt + audio.durationMs * elapsedWeight / totalWeight
      const durationMs = Math.max(300, Math.round(audio.durationMs * weights[index] / totalWeight))
      elapsedWeight += weights[index]
      return { dueAt, intent: alignIntentToDuration(intent, durationMs) }
    }).slice(this.emittedCueCount)
  }

  private buildIntents(staged: StagedPerformance): CharacterIntent[] {
    if (!staged.segments.length) return [{ ...staged.base }]
    // Sequential inheritance: a segment without an explicit emotion continues
    // the previous segment's mood (Amica's prevExpression rule). Without this,
    // an unlabeled closing segment snaps back to the base (dominant-segment)
    // emotion mid-speech — e.g. a pout→softening reply re-pouts at the softening.
    let previousEmotion = staged.base.emotion
    return staged.segments.map((segment, index) => {
      const emotion = typeof segment.emotion === 'string' && segment.emotion
        ? segment.emotion
        : previousEmotion
      previousEmotion = emotion
      return {
        ...staged.base,
        ...segment,
        emotion,
        turnId: staged.turnId,
        motionPlan: segment.motionPlan ?? (index === 0 ? staged.base.motionPlan : undefined),
      } as CharacterIntent
    })
  }

  private suppressRepeatedGesture(intent: CharacterIntent, timestamp: number): CharacterIntent {
    if (!intent.motionPlan) return intent
    const signature = motionSignature(intent.motionPlan)
    if (!signature) return { ...intent, motionPlan: undefined }
    const previous = this.recentGestures.get(signature) ?? -Infinity
    this.pruneRecentGestures(timestamp)
    if (timestamp - previous < this.repeatWindowMs) return { ...intent, motionPlan: undefined }
    this.recentGestures.set(signature, timestamp)
    return intent
  }

  private pruneRecentGestures(timestamp: number): void {
    for (const [signature, acceptedAt] of this.recentGestures) {
      if (timestamp - acceptedAt >= this.repeatWindowMs) this.recentGestures.delete(signature)
    }
  }
}

function motionSignature(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ''
  const steps = (value as Record<string, unknown>).steps
  if (!Array.isArray(steps)) return ''
  return steps.map(step => {
    if (!step || typeof step !== 'object') return ''
    const record = step as Record<string, unknown>
    return `${String(record.primitive ?? '')}:${Math.round(Number(record.intensity ?? 0) * 4)}`
  }).filter(Boolean).join('|')
}

function withLocalSemanticChoreography(intent: CharacterIntent): CharacterIntent {
  if (!intent.behavior || ['idle', 'listen'].includes(intent.behavior)) return intent
  const emotion = (intent.emotion || 'neutral').toLowerCase()
  const behavior = intent.behavior.toLowerCase()
  const behaviorRecipes: Record<string, MotionPrimitive[]> = {
    greet: ['lean_forward', 'tilt_right', 'nod'],
    agree: ['nod', 'lean_forward', 'nod'],
    disagree: ['tilt_left', 'lean_back', 'tilt_right'],
    think: ['look_left', 'tilt_right', 'breathe'],
    laugh: ['lean_forward', 'sway', 'nod'],
    comfort: ['lean_forward', 'breathe', 'tilt_left'],
    wave: ['sway', 'lean_forward', 'tilt_right'],
    nod: ['nod', 'lean_forward', 'nod'],
    tilt: ['tilt_left', 'lean_forward', 'tilt_right'],
    shrug: ['shrug', 'lean_back', 'tilt_left'],
  }
  const emotionRecipes: Record<string, MotionPrimitive[]> = {
    neutral: ['lean_forward', 'tilt_left', 'nod'],
    calm: ['breathe', 'tilt_right', 'lean_forward'],
    happy: ['lean_forward', 'tilt_right', 'nod'],
    playful: ['tilt_right', 'sway', 'nod'],
    love: ['lean_forward', 'tilt_left', 'breathe'],
    joyful: ['lean_forward', 'sway', 'nod'],
    cheerful: ['nod', 'sway', 'lean_forward'],
    surprised: ['lean_back', 'tilt_left', 'breathe'],
    shy: ['tilt_left', 'lean_back', 'breathe'],
    embarrassed: ['tilt_right', 'lean_back', 'breathe'],
    sad: ['breathe', 'lean_back', 'tilt_left'],
    cry: ['breathe', 'lean_back', 'tilt_left'],
    worried: ['lean_forward', 'tilt_right', 'breathe'],
    angry: ['lean_forward', 'nod', 'lean_back'],
    pout: ['lean_back', 'tilt_right', 'breathe'],
    confused: ['tilt_left', 'look_right', 'breathe'],
  }
  const candidates = behaviorRecipes[behavior] ?? emotionRecipes[emotion] ?? emotionRecipes.neutral
  const hash = [...(intent.turnId || emotion)]
    .reduce((value, character) => ((value * 31) + character.charCodeAt(0)) >>> 0, 7)
  const ordered = candidates.map((_, index) => candidates[(index + hash) % candidates.length])
  const durationMs = Math.round(clamp(intent.durationMs ?? 1_800, 600, 30_000))
  const beatCount = durationMs >= 5_500 ? 3 : durationMs >= 1_800 ? 2 : 1
  const fractions = beatCount === 3 ? [0.06, 0.42, 0.72]
    : beatCount === 2 ? [0.08, 0.58] : [0.12]
  const baseIntensity = clamp(
    (intent.intensity ?? 0.5) * 0.5 + (intent.energy ?? 0.5) * 0.24,
    0.34,
    0.76,
  )
  let sourceSteps = [...(intent.motionPlan?.steps ?? [])]
    .sort((left, right) => left.atMs - right.atMs)
    .slice(0, 3)
  const needsCompletion = sourceSteps.length < beatCount
    || (sourceSteps.at(-1)?.atMs ?? 0) < durationMs * 0.48
  if (intent.motionPlan && !needsCompletion) return intent
  // A full three-step LLM plan can still be front-loaded. Keep its first two
  // semantic choices and reserve one slot for a later conversational beat.
  if (sourceSteps.length >= beatCount && (sourceSteps.at(-1)?.atMs ?? 0) < durationMs * 0.48) {
    sourceSteps = sourceSteps.slice(0, Math.max(0, beatCount - 1))
  }
  const occupied = new Set(sourceSteps.map(step => step.primitive))
  const missingCount = Math.max(0, beatCount - sourceSteps.length)
  const supplementalFractions = fractions
    .filter(fraction => !sourceSteps.some(step =>
      Math.abs(step.atMs - durationMs * fraction) <= durationMs * 0.14))
    .sort((left, right) => right - left)
    .slice(0, missingCount)
    .sort((left, right) => left - right)
  const steps = supplementalFractions.map((fraction, index) => {
    const atMs = Math.round(durationMs * fraction)
    const available = Math.max(120, durationMs - atMs)
    const primitive = ordered.find(candidate => !occupied.has(candidate))
      ?? ordered[index % ordered.length]
    occupied.add(primitive)
    return {
      atMs,
      durationMs: Math.round(Math.min(2_200, Math.max(900, durationMs * 0.18), available)),
      primitive,
      intensity: clamp(baseIntensity * (index === 0 ? 0.9 : index === 1 ? 1 : 0.82), 0, 1),
    }
  })
  return {
    ...intent,
    motionPlan: {
      durationMs,
      steps: [...sourceSteps, ...steps]
        .sort((left, right) => left.atMs - right.atMs)
        .slice(0, 3),
    },
  }
}

function alignIntentToDuration(intent: CharacterIntent, durationMs: number): CharacterIntent {
  const decodedDuration = Math.round(clamp(durationMs, 300, 120_000))
  if (!intent.motionPlan) return { ...intent, durationMs: decodedDuration }
  const planDuration = Math.round(clamp(decodedDuration, 300, 30_000))
  const sourceDuration = Math.max(300, intent.motionPlan.durationMs)
  const scale = planDuration / sourceDuration
  const steps = intent.motionPlan.steps.map(step => {
    const atMs = Math.round(clamp(step.atMs * scale, 0, planDuration - 120))
    const available = Math.max(120, planDuration - atMs)
    return {
      ...step,
      atMs,
      durationMs: Math.round(Math.min(2_500, Math.max(120, step.durationMs * scale), available)),
    }
  })
  return {
    ...intent,
    durationMs: decodedDuration,
    motionPlan: { durationMs: planDuration, steps },
  }
}

function segmentWeight(segment: Record<string, unknown> | undefined): number {
  const text = typeof segment?.text === 'string' ? segment.text.trim() : ''
  return Math.max(1, Math.sqrt(Math.max(1, [...text].length)))
}

function estimateSegmentMs(segment: Record<string, unknown> | undefined): number {
  const explicit = typeof segment?.durationMs === 'number' ? segment.durationMs : NaN
  if (Number.isFinite(explicit)) return clamp(explicit, 300, 30_000)
  const text = typeof segment?.text === 'string' ? [...segment.text].length : 8
  return clamp(320 + text * 95, 500, 3_200)
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}
