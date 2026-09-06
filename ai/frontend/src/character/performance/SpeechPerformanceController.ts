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
    const swayScale = 0.62 + 0.38 * this.levelEnvelope
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

    // Organic micro-drift: a fresh head stance every 1.8-3.4s — Neuro
    // reference (25-tile grids across 2 stream days): the HEAD re-poses
    // almost every sample (tilts ±10-15deg, chin up/down, turns) while the
    // TORSO stays put. So head ranges are generous and frequent, body ranges
    // stay small: motion density lives in the head, not the trunk.
    // Head re-posing is ACCENT-GATED, not timer-gated: a new head stance is
    // only picked when the voice energy is rising (a prosodic beat), with a
    // grace re-pick if silence stretches. Random head motion uncorrelated
    // with speech reads as baffling twitching; accent-locked motion reads as
    // the head punctuating the sentence. The 0.04 threshold sits just above
    // lip-sync noise on a held vowel so ordinary drift alone cannot re-pose
    // the head, but a genuine onset (any syllable attack) fires instantly.
    const levelRise = Math.max(0, level - this.previousAudioLevel)
    if (this.elapsed >= this.microHoldUntil
      && (levelRise > 0.04 || this.elapsed >= this.microHoldUntil + 1.6)) {
      const pick = (range: number) => (this.random() * 2 - 1) * range
      // Comfort-gated stance: cap the jump so a re-pose never becomes a whip.
      // A stance is a leaning, not a snap: when the new target is far from the
      // current stance, clamp the leap to a reachable band — the spring then
      // travels the rest through its normal rise, arriving as a glide.
      const retarget = (axis: string, range: number): number => {
        const chosen = pick(range)
        const from = this.micro[axis]
        const maxLeap = range * 1.1
        return from + Math.max(-maxLeap, Math.min(maxLeap, chosen - from))
      }
      // 2026-09-05 retiering (user-validated live via parameter probe): the
      // old stances (head.x 3.2, body.x 1.1) sat under the Neuro reference
      // this controller cites — speech read as "small head drifting". New
      // daily-speech tier: head re-poses reach the ±10-15deg reference band
      // (head.x 4.2 x2.6 scale ≈ ±11deg peak), torso is a first-class
      // channel (±6-7deg peaks); high-arousal energy gain lifts these into
      // the performance tier. head.y pitch stays small — vertical drift is
      // the accent channel's job (accentY), not the stance's. Cadence
      // tightened to 1.5-2.9s so the head re-poses ~2x more often.
      this.microTarget['head.x'] = retarget('head.x', 4.2)
      this.microTarget['head.y'] = retarget('head.y', 0.8)
      this.microTarget['head.z'] = retarget('head.z', 3.0)
      this.microTarget['body.x'] = retarget('body.x', 3.0)
      this.microTarget['body.y'] = retarget('body.y', 1.2)
      this.microTarget['body.z'] = retarget('body.z', 1.6)
      this.microFreq = 0.48 + this.random() * 0.1
      this.microHoldUntil = this.elapsed + 1.5 + this.random() * 1.4
    }
    const omega = Math.PI * 2 * this.microFreq
    for (const key of Object.keys(this.micro)) {
      // Damping 0.85: near-critical. The 0.72 "bounce" tuning measurably
      // whips the head (120deg/s velocity reversals in adjacent frames at
      // ±6deg stances — the live "snaps to one side then bounces back"
      // report). Real head re-poses commit quickly (0.48Hz puts arrival
      // ~1s out) but never overshoot hard enough to reverse direction
      // within two frames; they land and settle.
      const acceleration = (this.microTarget[key] - this.micro[key]) * omega * omega
        - 2 * 0.85 * omega * this.microVelocity[key]
      this.microVelocity[key] += acceleration * delta
      this.micro[key] += this.microVelocity[key] * delta
    }

    // Primary sway: a slow, small presence oscillator — visible only because
    // everything else is stiller now. Neuro reference: life lives in the face
    // and voice, not in a constantly swinging torso.
    const primaryRate = 0.9 + Math.sin(this.elapsed * 0.31) * 0.2
    this.primaryPhase += primaryRate * delta
    const primary = Math.sin(this.primaryPhase)
    const beatRate = 1.55 + Math.sin(this.elapsed * 0.37) * 0.4
    this.beatPhase += Math.PI * 2 * beatRate * Math.max(0, dt)
    const beat = Math.max(0, Math.sin(this.beatPhase))
    const accentEnvelope = clamp(levelRise * 2.8 + level * beat * 0.32, 0, 1)
      * this.style.speechAccentGain * (0.4 + 0.6 * this.levelEnvelope)
    this.previousAudioLevel += (level - this.previousAudioLevel)
      * (1 - Math.exp(-delta * 12))

    const weight = this.state === 'speaking'
      ? onsetEnvelope
      : this.state === 'releasing' ? releaseEnvelope : 0
    // Voice energy uses the SMOOTHED envelope, never the raw frame level:
    // raw level hops per frame (0.3 -> 0.55 on an accent, back the next
    // frame) and amplitude-modulating the settled micro stance by it
    // produced single-frame spikes of ~60deg/s — the live "head whips to
    // one side and bounces back" report. The envelope (attack 3.2/s,
    // release 1.4/s) follows prosody at human speed.
    const voiceEnergy = 0.72 + this.levelEnvelope * 0.68
    const amp = swayScale * voiceEnergy * weight
    const accentY = accentEnvelope * 2.6
    const accentBody = accentEnvelope * 1.2
    return {
      headX: (primary * 1.1 + this.micro['head.x'] * 2.6) * amp,
      headY: (this.micro['head.y'] * swayScale + accentY) * weight,
      headZ: (Math.sin(this.primaryPhase * 0.5 + 1.1) * 0.6 + this.micro['head.z'] * 1.7) * amp,
      bodyX: (-primary * 0.55 + this.micro['body.x'] * 2.2) * amp,
      bodyY: (this.micro['body.y'] * swayScale + accentBody) * weight,
      bodyZ: (-primary * 0.35 + this.micro['body.z'] * 1.6) * amp,
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
