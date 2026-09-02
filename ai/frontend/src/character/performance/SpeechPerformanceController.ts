import type { ResolvedMotionStyle } from './MotionStyle'
import { createSeededRandom, type RandomSource } from './SeededRandom.ts'

export interface SpeechPerformanceSample {
  headX: number
  headY: number
  headZ: number
  bodyX: number
  bodyY: number
  bodyZ: number
  weight: number
  state: 'idle' | 'speaking' | 'releasing'
}

/**
 * Continuous speech posture, v2: organic micro-drift instead of fixed
 * sinusoids. A slow spring wanders toward random per-axis targets (same
 * architecture as the validated BodySwayController) while a phrase-energy
 * envelope breathes the amplitude with the voice. Prosody accent nods are
 * kept from v1. Together this removes the periodic left-right swing that
 * read as mechanical.
 */
export class SpeechPerformanceController {
  private elapsed = 0
  private releaseStartedAt = 0
  private previousAudioLevel = 0
  private levelEnvelope = 0
  private state: SpeechPerformanceSample['state'] = 'idle'
  private style: Pick<ResolvedMotionStyle, 'speechAccentGain'> = { speechAccentGain: 1 }
  private beatPhase = 0
  private primaryPhase = 0
  private random: RandomSource
  private baseSeed: number
  private micro: Record<string, number> = { 'head.x': 0, 'head.y': 0, 'head.z': 0, 'body.x': 0, 'body.y': 0, 'body.z': 0 }
  private microVelocity: Record<string, number> = { 'head.x': 0, 'head.y': 0, 'head.z': 0, 'body.x': 0, 'body.y': 0, 'body.z': 0 }
  private microTarget: Record<string, number> = { 'head.x': 0, 'head.y': 0, 'head.z': 0, 'body.x': 0, 'body.y': 0, 'body.z': 0 }
  private microHoldUntil = 0
  private microFreq = 0.38

  constructor(seed = 1) {
    this.baseSeed = seed
    this.random = createSeededRandom(seed)
  }
  configure(style: Pick<ResolvedMotionStyle, 'speechAccentGain'>): void {
    this.style = style
  }

  setSpeaking(speaking: boolean): void {
    if (speaking) {
      if (this.state !== 'speaking') this.elapsed = 0
      this.state = 'speaking'
    } else if (this.state === 'speaking') {
      this.state = 'releasing'
      this.releaseStartedAt = this.elapsed
    }
  }

  reset(): void {
    this.elapsed = 0
    this.releaseStartedAt = 0
    this.previousAudioLevel = 0
    this.levelEnvelope = 0
    this.beatPhase = 0
    this.state = 'idle'
    this.random = createSeededRandom(this.baseSeed)
    for (const key of Object.keys(this.micro)) {
      this.micro[key] = 0
      this.microVelocity[key] = 0
      this.microTarget[key] = 0
    }
    this.microHoldUntil = 0
  }

  update(dt: number, audioLevel: number): SpeechPerformanceSample {
    this.elapsed += Math.max(0, dt)
    const delta = Math.max(0, dt)
    const level = clamp(audioLevel, 0, 1)
    // Phrase-energy envelope: fast attack, slow release. The sway amplitude
    // breathes with the voice instead of running at a constant volume.
    const envRate = level > this.levelEnvelope ? 3.2 : 1.4
    this.levelEnvelope += (level - this.levelEnvelope) * (1 - Math.exp(-delta * envRate))
    const swayScale = 0.55 + 0.45 * this.levelEnvelope
    const onsetEnvelope = this.state === 'speaking'
      ? smoothstep(Math.min(1, this.elapsed / 0.22))
      : 0
    const releaseElapsed = this.state === 'releasing'
      ? this.elapsed - this.releaseStartedAt
      : 0
    const releaseEnvelope = this.state === 'releasing'
      ? 1 - smoothstep(Math.min(1, releaseElapsed / 0.48))
      : this.state === 'speaking' ? 1 : 0
    if (this.state === 'releasing' && releaseEnvelope <= 0.001) this.state = 'idle'

    // Organic micro-drift: pick a fresh random stance every 1.4-2.6s and let
    // the spring carry the pose there. No two visits look alike, so nothing
    // loops.
    if (this.elapsed >= this.microHoldUntil) {
      const pick = (range: number) => (this.random() * 2 - 1) * range
      this.microTarget['head.x'] = pick(3.5)
      this.microTarget['head.y'] = pick(0.9)
      this.microTarget['head.z'] = pick(2.4)
      this.microTarget['body.x'] = pick(2.6)
      this.microTarget['body.y'] = pick(1.0)
      this.microTarget['body.z'] = pick(1.4)
      this.microFreq = 0.34 + this.random() * 0.12
      this.microHoldUntil = this.elapsed + 1.4 + this.random() * 1.2
    }
    const omega = Math.PI * 2 * this.microFreq
    for (const key of Object.keys(this.micro)) {
      const acceleration = (this.microTarget[key] - this.micro[key]) * omega * omega
        - 2 * 0.85 * omega * this.microVelocity[key]
      this.microVelocity[key] += acceleration * delta
      this.micro[key] += this.microVelocity[key] * delta
    }

    // Primary sway: phase-accumulator oscillator with a slowly drifting rate
    // (never a fixed period), guaranteeing visible presence while the random
    // walk removes exact repetition.
    const primaryRate = 1.15 + Math.sin(this.elapsed * 0.31) * 0.25
    this.primaryPhase += primaryRate * delta
    const primary = Math.sin(this.primaryPhase)
    const levelRise = Math.max(0, level - this.previousAudioLevel)
    const beatRate = 2.15 + Math.sin(this.elapsed * 0.37) * 0.55
    this.beatPhase += Math.PI * 2 * beatRate * Math.max(0, dt)
    const beat = Math.max(0, Math.sin(this.beatPhase))
    const accentEnvelope = clamp(levelRise * 2.8 + level * beat * 0.32, 0, 1)
      * this.style.speechAccentGain * (0.4 + 0.6 * this.levelEnvelope)
    this.previousAudioLevel += (level - this.previousAudioLevel)
      * (1 - Math.exp(-delta * 12))

    const weight = this.state === 'speaking'
      ? onsetEnvelope
      : this.state === 'releasing' ? releaseEnvelope : 0
    const voiceEnergy = 0.72 + level * 0.68
    const amp = swayScale * voiceEnergy * weight
    const accentY = accentEnvelope * 3.6
    const accentBody = accentEnvelope * 1.3
    return {
      headX: (primary * 2.2 + this.micro['head.x'] * 1.5) * amp,
      headY: (this.micro['head.y'] * swayScale + accentY) * weight,
      headZ: (Math.sin(this.primaryPhase * 0.5 + 1.1) * 1.2 + this.micro['head.z'] * 1.5) * amp,
      bodyX: (-primary * 1.3 + this.micro['body.x'] * 1.6) * amp,
      bodyY: (this.micro['body.y'] * swayScale + accentBody) * weight,
      bodyZ: (-primary * 0.8 + this.micro['body.z'] * 1.2) * amp,
      weight,
      state: this.state,
    }
  }
}

function smoothstep(value: number): number {
  const t = clamp(value, 0, 1)
  return t * t * (3 - 2 * t)
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}
