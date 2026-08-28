import type { ResolvedMotionStyle } from './MotionStyle'

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

export class SpeechPerformanceController {
  private elapsed = 0
  private releaseStartedAt = 0
  private previousAudioLevel = 0
  private state: SpeechPerformanceSample['state'] = 'idle'
  private style: Pick<ResolvedMotionStyle, 'speechAccentGain'> = { speechAccentGain: 1 }
  // Phase accumulator for the accent beat. A fixed-frequency oscillator reads
  // as a metronome; the rate drifts slowly so nods land on slightly uneven
  // intervals while staying phase-continuous.
  private beatPhase = 0

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
    this.beatPhase = 0
    this.state = 'idle'
  }

  update(dt: number, audioLevel: number): SpeechPerformanceSample {
    this.elapsed += Math.max(0, dt)
    const level = clamp(audioLevel, 0, 1)
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

    const levelRise = Math.max(0, level - this.previousAudioLevel)
    const beatRate = 2.15 + Math.sin(this.elapsed * 0.37) * 0.55
    this.beatPhase += Math.PI * 2 * beatRate * Math.max(0, dt)
    const beat = Math.max(0, Math.sin(this.beatPhase))
    const accentEnvelope = clamp(levelRise * 2.8 + level * beat * 0.32, 0, 1)
      * this.style.speechAccentGain
    this.previousAudioLevel += (level - this.previousAudioLevel)
      * (1 - Math.exp(-dt * 12))

    const weight = this.state === 'speaking'
      ? onsetEnvelope
      : this.state === 'releasing' ? releaseEnvelope : 0
    const voiceEnergy = 0.72 + level * 0.68
    const phraseDrift = Math.sin(this.elapsed * 0.72 + 0.35)
    const counterDrift = Math.sin(this.elapsed * 1.18 + 1.6)
    return {
      headX: (Math.sin(this.elapsed * 1.92 + 0.7) * 3.2 + phraseDrift * 1.6)
        * voiceEnergy * weight,
      headY: (Math.sin(this.elapsed * 3.45) * 1.8 + accentEnvelope * 4.6)
        * weight,
      headZ: (Math.sin(this.elapsed * 2.35 + 0.25) * 1.8 + counterDrift * 0.6)
        * voiceEnergy * weight,
      bodyX: (-phraseDrift * 2 + counterDrift * 0.7) * voiceEnergy * weight,
      bodyY: (Math.sin(this.elapsed * 1.12) * 1 + accentEnvelope * 1.3)
        * weight,
      bodyZ: (-phraseDrift * 1.2 + counterDrift * 0.5) * voiceEnergy * weight,
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
