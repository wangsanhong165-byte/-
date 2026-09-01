import { createSeededRandom, type RandomSource } from './SeededRandom.ts'

export type AutonomousAttentionPhase = 'waiting' | 'acquire' | 'hold' | 'release'

export interface AutonomousAttentionContext {
  enabled: boolean
  activity: string
  /** Pointer/user focus suspends autonomous gaze even while activity is idle. */
  interactionEngaged?: boolean
  /**
   * Speaking glances are peeks, not stares: scale every emitted value so the
   * episode structure (acquire/hold/release) stays but its amplitude drops
   * well below idle gaze-away moves. 1 = idle strength.
   */
  strengthScale?: number
}

export interface AutonomousAttentionSample {
  values: Record<string, number>
  weight: number
  channelWeights: AttentionChannelWeights
  phase: AutonomousAttentionPhase
  episode: number
}

export interface AttentionChannelWeights {
  head: number
  gaze: number
}

export interface AttentionBlendSample {
  values: Record<string, number>
  weight: number
  channelWeights?: AttentionChannelWeights
}

/** Eye-led idle attention episodes that temporarily own gaze and head. */
export class AutonomousAttentionController {
  private random: RandomSource
  private phase: AutonomousAttentionPhase = 'waiting'
  private elapsed = 0
  private phaseDuration = 0
  private nextEpisodeIn = 0
  private direction: -1 | 1 = 1
  private vertical = 0
  private strength = 1
  private strengthScale = 1
  private prevSpeaking = false
  private episode = 0
  private lastWeight = 0
  private eyeProgress = 0
  private headProgress = 0
  private releaseEyeStart = 0
  private releaseHeadStart = 0

  constructor(seed = 1) {
    this.random = createSeededRandom(seed)
    this.scheduleWaiting(true)
  }

  reset(seed?: number): void {
    if (seed !== undefined) this.random = createSeededRandom(seed)
    this.phase = 'waiting'
    this.elapsed = 0
    this.episode = 0
    this.lastWeight = 0
    this.eyeProgress = 0
    this.headProgress = 0
    this.releaseEyeStart = 0
    this.releaseHeadStart = 0
    this.strengthScale = 1
    this.prevSpeaking = false
    this.scheduleWaiting(true)
  }

  update(dt: number, context: AutonomousAttentionContext): AutonomousAttentionSample {
    const delta = clamp(dt, 0, 0.1)
    this.strengthScale = clamp(context.strengthScale ?? 1, 0.1, 1)
    const allowed = context.enabled
      && (context.activity === 'idle' || context.activity === 'speaking')
      && context.interactionEngaged !== true
    // Speaking episodes run at reduced strength and hold for half as long:
    // a glance away mid-sentence, not a distracted stare.
    const speaking = context.activity === 'speaking'
    // A speech turn is shorter than the idle gaze cadence: when speech begins,
    // pull the next episode forward so at least one glance lands mid-turn
    // instead of the countdown outliving the utterance.
    if (speaking && !this.prevSpeaking) this.nextEpisodeIn = Math.min(this.nextEpisodeIn, 0.8 + this.random() * 1.4)
    this.prevSpeaking = speaking
    if (!allowed && this.phase !== 'waiting' && this.phase !== 'release') {
      this.beginPhase('release', 0.55)
    }
    if (!allowed && this.phase === 'waiting') {
      this.nextEpisodeIn = Math.max(this.nextEpisodeIn, 2.5)
      return this.sample(0, 0)
    }

    this.elapsed += delta
    if (this.phase === 'waiting') {
      this.nextEpisodeIn -= delta
      if (allowed && this.nextEpisodeIn <= 0) this.startEpisode()
      return this.sample(0, 0)
    }

    const progress = clamp(this.elapsed / Math.max(0.001, this.phaseDuration), 0, 1)
    if (this.phase === 'acquire') {
      this.eyeProgress = smoothstep(clamp(progress / 0.58, 0, 1))
      this.headProgress = smoothstep(clamp((progress - 0.18) / 0.82, 0, 1))
      this.lastWeight = Math.max(this.eyeProgress, this.headProgress)
      if (progress >= 1) this.beginPhase('hold', (speaking ? 0.35 : 0.75) + this.random() * (speaking ? 0.5 : 1.15))
    } else if (this.phase === 'hold') {
      this.eyeProgress = 1
      this.headProgress = 1
      this.lastWeight = 1
      if (progress >= 1) this.beginPhase('release', 0.58 + this.random() * 0.28)
    } else {
      const release = 1 - smoothstep(progress)
      this.eyeProgress = this.releaseEyeStart * release
      this.headProgress = this.releaseHeadStart * release * release
      this.lastWeight = Math.max(this.eyeProgress, this.headProgress)
      if (progress >= 1) {
        this.phase = 'waiting'
        this.elapsed = 0
        this.lastWeight = 0
        this.eyeProgress = 0
        this.headProgress = 0
        this.scheduleWaiting(false)
      }
    }
    return this.sample(this.eyeProgress, this.headProgress)
  }

  getDebugState(): Record<string, unknown> {
    return {
      phase: this.phase,
      episode: this.episode,
      weight: this.lastWeight,
      nextEpisodeIn: this.nextEpisodeIn,
      direction: this.direction,
    }
  }

  private startEpisode(): void {
    this.episode += 1
    this.direction = this.direction === 1 ? -1 : 1
    if (this.random() > 0.72) this.direction = this.direction === 1 ? -1 : 1
    this.vertical = (this.random() - 0.58) * 0.16
    this.strength = 0.82 + this.random() * 0.28
    this.beginPhase('acquire', 0.32 + this.random() * 0.16)
  }

  private beginPhase(phase: Exclude<AutonomousAttentionPhase, 'waiting'>, duration: number): void {
    if (phase === 'release') {
      this.releaseEyeStart = this.eyeProgress
      this.releaseHeadStart = this.headProgress
    }
    this.phase = phase
    this.elapsed = 0
    this.phaseDuration = duration
  }

  private scheduleWaiting(initial: boolean): void {
    this.nextEpisodeIn = (initial ? 4.2 : 5.5) + this.random() * (initial ? 3.2 : 5.5)
  }

  private sample(eyeProgress: number, headProgress: number): AutonomousAttentionSample {
    if (this.phase === 'waiting' && this.lastWeight === 0) {
      return {
        values: {},
        weight: 0,
        channelWeights: { head: 0, gaze: 0 },
        phase: this.phase,
        episode: this.episode,
      }
    }
    const scale = this.strengthScale
    return {
      values: {
        'eye.x': this.direction * 0.62 * this.strength * scale,
        'eye.y': this.vertical * scale,
        'head.x': this.direction * 5.2 * this.strength * scale,
        'head.y': this.vertical * 8 * scale,
        'head.z': -this.direction * 0.85 * this.strength * scale,
      },
      weight: this.lastWeight,
      channelWeights: { head: headProgress, gaze: eyeProgress },
      phase: this.phase,
      episode: this.episode,
    }
  }
}

/** Cross-fade attention against the live tracking pose so ownership handoff cannot snap. */
export function blendAttentionWithTracking(
  attention: Readonly<Record<string, number>>,
  tracking: Readonly<Record<string, number>>,
  weight: number,
  channelWeights?: Readonly<AttentionChannelWeights>,
): Record<string, number> {
  const keys = new Set([...Object.keys(tracking), ...Object.keys(attention)])
  return Object.fromEntries([...keys]
    .filter(key => key.startsWith('head.') || key.startsWith('eye.'))
    .map(key => {
      const channel = key.startsWith('eye.') ? 'gaze' : 'head'
      const amount = clamp(channelWeights?.[channel] ?? weight, 0, 1)
      return [
        key,
        (tracking[key] ?? 0) * (1 - amount) + (attention[key] ?? 0) * amount,
      ]
    }))
}

/** Let an explicit target take over an autonomous episode without replacing it in one frame. */
export function mergeAttentionSamples(
  explicit: Readonly<AttentionBlendSample>,
  autonomous: Readonly<AttentionBlendSample>,
): AttentionBlendSample {
  const weights = {
    head: mergeWeight(channelWeight(explicit, 'head'), channelWeight(autonomous, 'head')),
    gaze: mergeWeight(channelWeight(explicit, 'gaze'), channelWeight(autonomous, 'gaze')),
  }
  const weight = Math.max(weights.head, weights.gaze)
  if (weight <= 0.0001) return { values: {}, weight: 0 }
  const keys = new Set([...Object.keys(explicit.values), ...Object.keys(autonomous.values)])
  const values = Object.fromEntries([...keys].map(key => {
    const channel = key.startsWith('eye.') ? 'gaze' : 'head'
    const explicitWeight = channelWeight(explicit, channel)
    const autonomousWeight = channelWeight(autonomous, channel)
    const channelMergedWeight = weights[channel]
    return [
      key,
      channelMergedWeight <= 0.0001 ? 0 : (
        (autonomous.values[key] ?? 0) * autonomousWeight * (1 - explicitWeight)
        + (explicit.values[key] ?? 0) * explicitWeight
      ) / channelMergedWeight,
    ]
  }))
  return { values, weight, channelWeights: weights }
}

function channelWeight(sample: Readonly<AttentionBlendSample>, channel: keyof AttentionChannelWeights): number {
  return clamp(sample.channelWeights?.[channel] ?? sample.weight, 0, 1)
}

function mergeWeight(primary: number, secondary: number): number {
  return 1 - (1 - primary) * (1 - secondary)
}

function smoothstep(value: number): number {
  const t = clamp(value, 0, 1)
  return t * t * (3 - 2 * t)
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}
