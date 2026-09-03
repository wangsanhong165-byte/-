import type {
  AvatarPerformanceCapabilities,
  CharacterPerformancePersonality,
} from './AvatarCapabilityProfile'
import { BodySwayController } from './performance/BodySwayController.ts'
import { createSeededRandom } from './performance/SeededRandom.ts'
import { IdleActionScheduler, type IdleActionLabel } from './performance/IdleActionScheduler.ts'
import { deriveMotionSeed, resolveMotionStyle, type MotionStyleOptions } from './performance/MotionStyle.ts'
import type { VADVector } from './performance/VADState.ts'

export interface IdleBehaviorSnapshot {
  headX: number
  headY: number
  headZ: number
  eyeX: number
  eyeY: number
  bodyX: number
  bodyY: number
  eyeClose: number
  activeAction: IdleActionLabel | null
  actionProgress: number
  energy: number
  transitionProgress: number
}

export class IdleBehaviorController {
  private _elapsedMs = 0
  private _style = resolveMotionStyle()
  private _phase = createSeededRandom(deriveMotionSeed(this._style.seed, 7))() * Math.PI * 2
  private _bodySway = new BodySwayController(deriveMotionSeed(this._style.seed, 5))
  private _actions = new IdleActionScheduler(
    deriveMotionSeed(this._style.seed, 6),
      this._style.spontaneity * this._style.gestureFrequency,
    this._style.idleActionGain,
    this._style.avoidRepeatWindow,
  )
  private _personality: CharacterPerformancePersonality | undefined
  private _capabilities: AvatarPerformanceCapabilities | undefined
  private _vad: VADVector = { valence: 0, arousal: 0, dominance: 0 }
  private _legacy = false
  private _snapshot: IdleBehaviorSnapshot = {
    headX: 0, headY: 0, headZ: 0, eyeX: 0, eyeY: 0,
    bodyX: 0, bodyY: 0, eyeClose: 0,
    activeAction: null, actionProgress: 0,
    energy: 0.22, transitionProgress: 0,
  }

  reset(): void {
    this._elapsedMs = 0
    this._snapshot.transitionProgress = 0
    this._bodySway.reset(deriveMotionSeed(this._style.seed, 5))
  }

  setMotionStyle(
    options: MotionStyleOptions | undefined,
    personality?: CharacterPerformancePersonality,
    capabilities?: AvatarPerformanceCapabilities,
  ): void {
    this._style = resolveMotionStyle(options)
    this._phase = createSeededRandom(deriveMotionSeed(this._style.seed, 7))() * Math.PI * 2
    this._personality = personality
    this._capabilities = capabilities
    this._actions = new IdleActionScheduler(
      deriveMotionSeed(this._style.seed, 6),
      this._style.spontaneity * this._style.gestureFrequency,
      this._style.idleActionGain,
      this._style.avoidRepeatWindow,
    )
    this.reset()
  }

  setVAD(vad: VADVector): void {
    this._vad = { ...vad }
  }

  setLegacy(enabled: boolean): void {
    if (this._legacy === enabled) return
    this._legacy = enabled
    this._actions = new IdleActionScheduler(
      deriveMotionSeed(this._style.seed, 6),
      this._style.spontaneity * (enabled ? 1 : this._style.gestureFrequency),
      this._style.idleActionGain,
      this._style.avoidRepeatWindow,
    )
  }

  update(
    dt: number,
    allowed: boolean,
    focusWeights: { head: number; body: number; gaze: number } = { head: 0, body: 0, gaze: 0 },
  ): void {
    this._elapsedMs += dt * 1000
    const seconds = this._elapsedMs / 1000
    const targetWeight = allowed ? 1 : 0
    const blend = 1 - Math.exp(-dt * (allowed ? 1.8 : 4.5))
    const weight = this._snapshot.transitionProgress
      + (targetWeight - this._snapshot.transitionProgress) * blend
    // BodySway wanders organically regardless of activity — its output is
    // only consumed by logicalIdlePose (when activity is 'idle'), but keeping
    // it running through thinking/listening prevents a jarring re-expansion
    // when the character returns to idle (the "snap to center" artifact).
    const sway = this._bodySway.update(seconds, 0, this._style.bodyMotionGain)
    const focus = Math.max(focusWeights.head, focusWeights.gaze)
    const action = this._actions.update(seconds, {
      // SoulLink-style interruption: an interaction cancels an idle action
      // instead of letting its hidden phase advance behind pointer tracking.
      allowed: allowed && focus < 0.08,
      focusLevel: allowed ? 0 : 1,
      capabilities: this._capabilities,
      personality: this._personality,
      vad: this._vad,
    })
    const actionState = this._actions.getState()
    const microGain = this._legacy ? 1 : this._style.microMotionGain
    const amplitude = this._legacy
      ? { headX: 0.18, headY: 0.12, headZ: 0.12, eyeX: 0.18, eyeY: 0.1 }
      : { headX: 0.7, headY: 0.55, headZ: 0.6, eyeX: 0.3, eyeY: 0.18 }
    // Tracking still owns gaze/head priority, but idle body language keeps
    // most of its weight — a full suppress reads as a statue the instant the
    // pointer moves.
    const headWeight = weight * (1 - clamp(focusWeights.head, 0, 1) * 0.45)
    const gazeWeight = weight * (1 - clamp(focusWeights.gaze, 0, 1))
    const bodyWeight = weight * (1 - clamp(focusWeights.body, 0, 1) * 0.35)
    this._snapshot = {
      headX: (sway.headX + action.headX + Math.sin(seconds * 0.29 + this._phase) * amplitude.headX * microGain) * headWeight,
      headY: (sway.headY + action.headY + Math.sin(seconds * 0.21 + 1.2) * amplitude.headY * microGain) * headWeight,
      headZ: (sway.headZ + action.headZ + Math.sin(seconds * 0.17 + 0.4) * amplitude.headZ * microGain) * headWeight,
      eyeX: (Math.sin(seconds * 0.13 + 2.1) * amplitude.eyeX * microGain + action.eyeX) * gazeWeight,
      eyeY: (Math.sin(seconds * 0.09 + 0.8) * amplitude.eyeY * microGain + action.eyeY) * gazeWeight,
      bodyX: (sway.bodyX + action.bodyX) * bodyWeight,
      bodyY: (sway.bodyY + action.bodyY) * bodyWeight,
      eyeClose: action.eyeClose * gazeWeight,
      activeAction: actionState.activeAction,
      actionProgress: actionState.progress,
      energy: 0.22 * weight,
      transitionProgress: weight,
    }
  }

  getSnapshot(): IdleBehaviorSnapshot { return { ...this._snapshot } }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}
