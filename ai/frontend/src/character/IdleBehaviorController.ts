import type {
  AvatarPerformanceCapabilities,
  CharacterPerformancePersonality,
} from './AvatarCapabilityProfile'
import { BodySwayController } from './performance/BodySwayController.ts'
import { createSeededRandom } from './performance/SeededRandom.ts'
import { IdleActionScheduler, type IdleActionLabel } from './performance/IdleActionScheduler.ts'
import { deriveMotionSeed, resolveMotionStyle, type MotionStyleOptions } from './performance/MotionStyle.ts'
import type { VADVector } from './performance/VADState.ts'
import {
  residueEnergyScale,
  residuePoolEmotion,
  type ResidueIdleProfile,
} from './performance/ResidueIdleTint.ts'

export interface IdleBehaviorSnapshot {
  headX: number
  headY: number
  headZ: number
  eyeX: number
  eyeY: number
  bodyX: number
  bodyY: number
  eyeClose: number
  /** 2026-09-05 long-idle drowsiness: 0 awake, 1 asleep (see configureSleep). */
  sleepAmount: number
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
  private _emotion: string = 'neutral'
  private _residueProfile: ResidueIdleProfile | null = null
  private _legacy = false
  // 2026-09-05 long-idle sleep: calm seconds accumulate while idle with no
  // focus and a quiet affect; past drowsyAt she gets heavy-lidded and slow,
  // past asleepAt she dozes off (eyes closed, head settled to one side, body
  // nearly still). Speech, focus or interaction reset immediately.
  private _calmSeconds = 0
  private _sleepAmount = 0
  // Drowsy time-dilation: idle actions play in slow motion as sleep rises
  // (真机反馈：快睡着还快速偏头——小幅度快攻在半闭眼下读作抽搐).
  private _actionClock = 0
  // Two-stage eyelids (真机反馈：慢慢闭眼没必要): drowsy eases to a half-closed
  // 酝酿 hold, then the asleep moment CLOSES directly (fast rate).
  private _lidAmount = 0
  private _sleepSide = createSeededRandom(deriveMotionSeed(this._style.seed, 9))() < 0.5 ? -1 : 1
  private _drowsyAfterSec = 150
  private _asleepAfterSec = 240
  private _snapshot: IdleBehaviorSnapshot = {
    headX: 0, headY: 0, headZ: 0, eyeX: 0, eyeY: 0,
    bodyX: 0, bodyY: 0, eyeClose: 0,
    sleepAmount: 0,
    activeAction: null, actionProgress: 0,
    energy: 0.22, transitionProgress: 0,
  }

  /** Override the long-idle sleep thresholds (seconds). Defaults: drowsy at
   *  2.5min, asleep at 4min. */
  configureSleep(drowsyAfterSec: number, asleepAfterSec: number): void {
    this._drowsyAfterSec = Math.max(1, drowsyAfterSec)
    this._asleepAfterSec = Math.max(this._drowsyAfterSec + 1, asleepAfterSec)
  }

  reset(): void {
    this._elapsedMs = 0
    this._calmSeconds = 0
    this._sleepAmount = 0
    this._actionClock = 0
    this._lidAmount = 0
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

  /** Current segment emotion: tints the idle action pick pool (IDLE_TINTS)
   *  so the mood keeps performing during idle. */
  setEmotion(emotion: string): void {
    this._emotion = emotion
  }

  /** Residue idle tint (backend classify_residue): the leftover atmosphere
   *  of the last exchange scales idle energy and tints the action pool
   *  whenever no live segment emotion is present. Null = current behavior. */
  setResidueTint(profile: ResidueIdleProfile | null): void {
    this._residueProfile = profile
  }

  /** Forward the arbiter bridge for preset-backed idle phrases. */
  setPhraseRequest(request: ((presetName: string) => boolean) | null): void {
    this._actions.setPhraseRequest(request)
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
    userDrivenFocus?: { head: number; body: number; gaze: number },
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
    // 2026-09-05 long-idle drowsiness: calm time accumulates only while idle,
    // unfocused and affect-quiet; speech, focus or interaction reset it.
    // The SLEEP gate reads USER-DRIVEN focus only (mouse/interaction/explicit
    // attention) — her own autonomous glance episodes are life, not presence,
    // and must not keep resetting the drowsiness clock (F1: the autonomous
    // attention layer runs exactly during idle, which made sleep unreachable
    // through the real pipeline).
    const calmAffect = Math.abs(this._vad.arousal) < 0.35
    const userFocus = Math.max(
      userDrivenFocus?.head ?? 0,
      userDrivenFocus?.body ?? 0,
      userDrivenFocus?.gaze ?? 0,
    )
    if (allowed && userFocus < 0.08 && calmAffect) {
      this._calmSeconds += dt
    } else if (!allowed || userFocus >= 0.5) {
      this._calmSeconds = 0
    }
    const sleepTarget = this._calmSeconds >= this._asleepAfterSec
      ? 1
      : this._calmSeconds >= this._drowsyAfterSec
        ? (this._calmSeconds - this._drowsyAfterSec) / Math.max(1, this._asleepAfterSec - this._drowsyAfterSec)
        : 0
    // Drift into sleep slowly, snap out of it quickly.
    this._sleepAmount += (sleepTarget - this._sleepAmount)
      * (1 - Math.exp(-dt * (sleepTarget > this._sleepAmount ? 0.35 : 2.6)))
    const sleep = this._sleepAmount
    // Two-stage eyelids: drowsy brews at half-closed, the asleep moment
    // closes DIRECTLY (fast rate) — no slow-mo eyelid drift (真机反馈).
    const lidTarget = this._calmSeconds >= this._asleepAfterSec ? 1
      : this._calmSeconds >= this._drowsyAfterSec ? 0.5 : 0
    const lidRate = lidTarget === 1 && this._lidAmount < 1 ? 6 : 3
    this._lidAmount += (lidTarget - this._lidAmount) * (1 - Math.exp(-dt * lidRate))
    // Drowsy slow-motion: the action clock dilates with sleep so any action
    // still playing drifts instead of snapping (半闭眼时快速偏头 = 抽搐).
    this._actionClock += dt * (1 - 0.75 * sleep)
    const actionAllowed = allowed && focus < 0.08 && sleep < 0.5
    const action = this._actions.update(this._actionClock, {
      // SoulLink-style interruption: an interaction cancels an idle action
      // instead of letting its hidden phase advance behind pointer tracking.
      allowed: actionAllowed,
      focusLevel: allowed ? 0 : 1,
      capabilities: this._capabilities,
      personality: this._personality,
      vad: this._vad,
      emotion: residuePoolEmotion(this._residueProfile, this._emotion),
    })
    // 2026-09-05 真机反馈：发困了还在歪头——待机动作随睡意平方淡出，
    // 深睡期动作自然消失而不是被门控突然掐断。
    const actionFade = (1 - sleep) * (1 - sleep)
    action.headX *= actionFade
    action.headY *= actionFade
    action.headZ *= actionFade
    action.eyeX *= actionFade
    action.eyeY *= actionFade
    action.bodyX *= actionFade
    action.bodyY *= actionFade
    if (action.eyeClose) action.eyeClose *= actionFade
    const actionState = this._actions.getState()
    const microGain = this._legacy ? 1 : this._style.microMotionGain
    const amplitude = this._legacy
      ? { headX: 0.18, headY: 0.12, headZ: 0.12, eyeX: 0.18, eyeY: 0.1 }
      : { headX: 0.7, headY: 0.55, headZ: 0.6, eyeX: 0.3, eyeY: 0.18 }
    // Tracking still owns gaze/head priority, but idle body language keeps
    // most of its weight — a full suppress reads as a statue the instant the
    // pointer moves.
    const headWeight = weight * (1 - clamp(focusWeights.head, 0, 1) * 0.45) * (1 - 0.7 * sleep)
    const gazeWeight = weight * (1 - clamp(focusWeights.gaze, 0, 1))
    const bodyWeight = weight * (1 - clamp(focusWeights.body, 0, 1) * 0.35) * (1 - 0.6 * sleep)
    // Sleep pose (2026-09-05 真机反馈重设计：睡姿不好看+眼睛没全闭)：
    // the head sinks INTO the tilt — deep chin tuck, pronounced side settle,
    // NO pitching bob (nodding while asleep read as eerie; breathing lives in
    // the chest dial). Eyelids reach FULL close at sleep=1 (was 0.94 — a
    // light slit the user flagged).
    const sleepQuiet = 1 - 0.7 * sleep
    this._snapshot = {
      headX: (sway.headX * sleepQuiet + action.headX + Math.sin(seconds * 0.29 + this._phase) * amplitude.headX * microGain) * headWeight,
      headY: (sway.headY * sleepQuiet + action.headY + Math.sin(seconds * 0.21 + 1.2) * amplitude.headY * microGain) * headWeight
        - 4.5 * sleep,
      headZ: (sway.headZ * sleepQuiet + action.headZ + Math.sin(seconds * 0.17 + 0.4) * amplitude.headZ * microGain) * headWeight
        + this._sleepSide * 7 * sleep,
      eyeX: (Math.sin(seconds * 0.13 + 2.1) * amplitude.eyeX * microGain + action.eyeX) * gazeWeight * (1 - sleep),
      eyeY: (Math.sin(seconds * 0.09 + 0.8) * amplitude.eyeY * microGain + action.eyeY) * gazeWeight * (1 - sleep),
      bodyX: (sway.bodyX * sleepQuiet + action.bodyX) * bodyWeight,
      // 真机反馈"睡着像死了一样"：睡眠呼吸必须可见——body.y 以 5.7s 睡眠
      // 周期（呼吸拨盘同步）缓慢起伏，均匀规律，加在抑制之后保持幅度。
      bodyY: (sway.bodyY * sleepQuiet + action.bodyY) * bodyWeight
        + Math.sin(seconds * 1.1) * 0.5 * sleep,
      eyeClose: Math.max(action.eyeClose * gazeWeight, this._lidAmount),
      sleepAmount: sleep,
      activeAction: actionState.activeAction,
      actionProgress: actionState.progress,
      energy: 0.22 * weight * (1 - 0.5 * sleep) * residueEnergyScale(this._residueProfile),
      transitionProgress: weight,
    }
  }

  getSnapshot(): IdleBehaviorSnapshot { return { ...this._snapshot } }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}
