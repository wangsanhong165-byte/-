import type {
  AvatarPerformanceCapabilities,
  CharacterPerformancePersonality,
} from '../AvatarCapabilityProfile.ts'
import { IdleBehaviorController, type IdleBehaviorSnapshot } from '../IdleBehaviorController.ts'
import { getResidueProfile, refreshResidueTint } from './ResidueIdleTint.ts'
import { facsFromVAD, logicalFaceFromFACS } from './FACSState.ts'
import { resolveMotionStyle, type MotionStyleOptions, type ResolvedMotionStyle } from './MotionStyle.ts'
import { SpeechPerformanceController } from './SpeechPerformanceController.ts'
import type { VADVector } from './VADState.ts'
import { semanticPostureFromVAD } from './SemanticPosture.ts'
import { VoiceWaitingMotionController } from './VoiceWaitingMotionController.ts'
import { emotionPostureAt } from './performance-recipes.ts'

export type AmbientPerformanceChannel = 'head' | 'body' | 'gaze'

export interface AmbientPerformanceInput {
  /** Segment emotion name; keys the sustained body-language pose layer. */
  emotion?: string
  vad: VADVector
  audioLevel: number
  enabled: boolean
  blockedChannels: ReadonlySet<AmbientPerformanceChannel>
  tracking?: Record<string, number>
  focusWeights?: { head: number; body: number; gaze: number }
  /** USER-driven attention only (mouse/interaction/explicit) — excludes the
   *  autonomous gaze layer. Gates long-idle drowsiness: her own glances are
   *  life, the user's presence is what keeps her awake. */
  userDrivenFocus?: { head: number; body: number; gaze: number }
  gain?: number
}

export interface AmbientPerformanceFrame {
  values: Record<string, number>
  faceValues: Record<string, number>
  eyeClose: number
  idle: IdleBehaviorSnapshot
  activity: string
}

/**
 * Deep module for ambient character performance.
 *
 * Exactly one activity generator supplies the base rhythm at a time. VAD
 * posture, activity transitions, capability filtering and motion ownership
 * are resolved here so callers submit one coherent pose layer to the mixer.
 */

export class AmbientPerformanceEngine {
  private readonly idle = new IdleBehaviorController()
  private readonly speech = new SpeechPerformanceController()
  private readonly waiting: VoiceWaitingMotionController
  private style: ResolvedMotionStyle
  private activity = 'idle'
  /** Residue idle-entry edge: refresh the backend classify_residue tint once
   *  per idle episode (throttled inside ResidueIdleTint). */
  private residueWasIdle = false
  private clockSeconds = 0
  private lastSwitchAt = -10
  private emotionPose: Record<string, number> = {}
  private lastPostureEmotion: string | undefined
  private postureMirror = true
  /** Emotion activation clock (seconds): drives phased posture scripts. */
  private postureSince = 0
  private current: Record<string, number> = {}
  private eyeClose = 0
  private enhanced = true
  private tailPhase = 0
  private tailRootValue = 0
  private tailRootVelocity = 0
  private bodyEnvelope = 0
  private readonly tailSegmentValues = Array.from({ length: 15 }, () => 0)
  private readonly tailSegmentVelocities = Array.from({ length: 15 }, () => 0)
  private readonly faceSmooth = new Map<string, number>()

  constructor(seed = 1) {
    this.style = resolveMotionStyle({ seed })
    this.waiting = new VoiceWaitingMotionController(seed)
  }

  configure(
    options: MotionStyleOptions | undefined,
    personality?: CharacterPerformancePersonality,
    capabilities?: AvatarPerformanceCapabilities,
  ): void {
    this.style = resolveMotionStyle(options)
    this.idle.setMotionStyle({ ...options, seed: this.style.seed }, personality, capabilities)
    this.speech.configure(this.style)
    this.tailPhase = (this.style.seed % 17) * 0.37
    this.reset()
  }

  setActivity(activity: string): void {
    if (activity !== this.activity) this.lastSwitchAt = this.clockSeconds
    this.activity = activity
    this.speech.setSpeaking(activity === 'speaking')
  }

  /** Install the idle-phrase bridge: preset phrases (ear_flick, tail_sweep)
   *  play through the MotionArbiter instead of local keyframes. */
  setPhraseRequest(request: ((presetName: string) => boolean) | null): void {
    this.idle.setPhraseRequest(request)
  }

  setLegacy(enabled: boolean): void {
    this.enhanced = !enabled
    this.idle.setLegacy(enabled)
  }

  reset(): void {
    this.current = {}
    this.emotionPose = {}
    this.clockSeconds = 0
    this.lastSwitchAt = -10
    // Posture state must reset too: a stale lastPostureEmotion made a
    // same-emotion segment after reset resume its script MID-PHASE, and a
    // stale mirror flipped the stance sign across resets.
    this.lastPostureEmotion = undefined
    this.postureMirror = true
    this.eyeClose = 0
    this.postureSince = 0
    this.tailRootValue = 0
    this.tailRootVelocity = 0
    this.bodyEnvelope = 0
    this.tailSegmentValues.fill(0)
    this.tailSegmentVelocities.fill(0)
    this.idle.reset()
    this.speech.reset()
    this.speech.setSpeaking(this.activity === 'speaking')
    this.waiting.reset()
  }

  update(dt: number, input: AmbientPerformanceInput): AmbientPerformanceFrame {
    const delta = Math.max(0, Math.min(0.1, dt))
    this.clockSeconds += delta
    const gain = Math.max(0, Math.min(2.5, input.gain ?? 1))
    const idleAllowed = input.enabled
      && this.activity === 'idle'
    if (idleAllowed && !this.residueWasIdle) void refreshResidueTint()
    this.residueWasIdle = idleAllowed
    this.idle.setVAD(input.vad)
    this.idle.setEmotion(input.emotion ?? 'neutral')
    this.idle.setResidueTint(getResidueProfile())
    this.idle.update(delta, idleAllowed, input.focusWeights, input.userDrivenFocus)
    const idle = this.idle.getSnapshot()
    const speech = this.speech.update(delta, input.audioLevel)
    const waiting = this.waiting.update(
      delta,
      input.enabled && this.enhanced ? this.activity : 'idle',
      gain,
    )

    // Arousal is the LLM-facing energy dial: emotion/intensity/naturalVAD feed
    // VADState, and high-arousal states read as bigger body language while
    // low arousal contracts it. This is where body amplitude meets intent.
    // Speaking never freezes: the reference stays visibly alive even in blank
    // low-arousal moods, so the dial floors at 0.75 during speech.
    const arousal = Math.max(-1, Math.min(1, input.vad.arousal))
    const energyGain = this.activity === 'speaking'
      ? Math.max(0.75, 1 + arousal * 0.45)
      : 1 + arousal * 0.45
    let target: Record<string, number> = {}
    if (input.enabled) {
      if (this.activity === 'idle') target = logicalIdlePose(idle, gain * energyGain)
      else if (this.activity === 'speaking') {
        const pose = logicalSpeechPose(speech, gain * energyGain)
        // Script/stance cooperation: while an emotion posture script holds a
        // head opinion (this.emotionPose is the previous frame's live state),
        // the ambient lateral stance yields half its range so the script's
        // phase structure (dodge → look-back → hold) stays readable instead
        // of being drowned by stance drift of the same magnitude.
        if (Object.keys(this.emotionPose).some(key => key.startsWith('head.'))) {
          pose['head.x'] *= 0.55
          pose['head.z'] *= 0.55
        }
        target = pose
      }
      else if (this.activity === 'listening' || this.activity === 'thinking') target = waiting
    }
    if (input.enabled && this.enhanced) target = addLogical(target, vadPosture(input.vad, gain))
    // Sustained emotion posture: ramp toward the segment's stance so it reads
    // as mood settling in, and melt back on emotion change. Emotions with a
    // phased script (POSTURE_SCRIPTS) get their stance SAMPLED along the
    // timeline (approach beat → settle → living hold) instead of one frozen
    // pose. Each new emotion alternates a left/right mirror so pout-leaning
    // characters don't permanently turn one way.
    if (input.emotion !== this.lastPostureEmotion) {
      this.lastPostureEmotion = input.emotion
      this.postureMirror = !this.postureMirror
      this.postureSince = 0
    }
    this.postureSince += delta
    const rawPosture = emotionPostureAt(
      input.emotion,
      this.style.preset,
      this.postureSince * 1000,
    )
    // Mirror flips LATERAL axes only (yaw/roll/turn): pitch (head.y, body.y),
    // ear pinning and tail lift are semantically vertical/emphasis channels —
    // flipping them would turn "ears pin in anger" into "ears flare up".
    const poseTarget = rawPosture && this.postureMirror
      ? Object.fromEntries(Object.entries(rawPosture).map(([parameter, value]) => [
          parameter,
          lateralAxis(parameter) ? -value : value,
        ]))
      : rawPosture
    const poseKeys = new Set([...Object.keys(this.emotionPose), ...Object.keys(poseTarget ?? {})])
    const poseRate = poseTarget ? 2.4 : 3.0
    for (const key of poseKeys) {
      const from = this.emotionPose[key] ?? 0
      const to = (poseTarget && poseTarget[key]) ?? 0
      const value = from + (to - from) * (1 - Math.exp(-delta * poseRate))
      if (Math.abs(value) > 0.001) this.emotionPose[key] = value
      else delete this.emotionPose[key]
    }
    if (Object.keys(this.emotionPose).length) {
      // Living hold: the stance breathes ±12% at ~0.17Hz — a held pose that
      // freezes solid reads as mannequin, real posture keeps micro-adjusting.
      const hold = 1 + 0.12 * Math.sin(this.clockSeconds * 1.05 + 1.3)
      for (const key of Object.keys(this.emotionPose)) target[key] = (target[key] ?? 0) + this.emotionPose[key] * hold
    }
    target = filterChannels(target, input.blockedChannels)
    // Post-switch handoff: slow the release direction so the pose glides back
    // over ~1.5s instead of every idle layer collapsing to center in one beat.
    const handoff = this.clockSeconds - this.lastSwitchAt < 1.2
    this.current = approachPose(this.current, target, delta, handoff)
    // Tracking already owns a hierarchical response model (eyes -> head ->
    // torso). Filtering it again here recreates the slow, smooth stiffness
    // this engine is intended to avoid.
    const tracking = input.enabled && input.tracking
      ? filterChannels(input.tracking, input.blockedChannels)
      : {}
    const resolvedPose = addLogical(this.current, tracking)
    const tail = this.updateSecondaryTail(delta, resolvedPose, input.audioLevel, gain, input.enabled)
    if (input.enabled && !input.blockedChannels.has('body')) {
      // Coordination with emotion-posture tail channels: the posture script
      // expresses INTENT (tail curls when shy, lashes when angry) — the
      // inertial chain owns the tail only where the script has no opinion,
      // otherwise the two writers fight frame by frame.
      const emotionalTailKeys = new Set(
        Object.keys(this.emotionPose).filter(key => key.startsWith('tail.')),
      )
      for (const [key, value] of Object.entries(tail)) {
        if (emotionalTailKeys.has(key)) continue
        resolvedPose[key] = value
      }
    }

    const eyeCloseTarget = idleAllowed && !input.blockedChannels.has('gaze')
      ? idle.eyeClose * gain
      : 0
    const eyeResponse = 1 - Math.exp(-delta * (eyeCloseTarget > this.eyeClose ? 12 : 7))
    this.eyeClose += (eyeCloseTarget - this.eyeClose) * eyeResponse

    const facs = facsFromVAD(input.vad)
    // VAD can step the moment an intent lands; an unsmoothed additive face
    // layer then flashes the whole face in one frame while the expression
    // preset is still blending. Ease the projected face values instead.
    const rawFace = this.enhanced ? logicalFaceFromFACS(facs) : {}
    const faceSmoothed: Record<string, number> = {}
    for (const [key, value] of Object.entries(rawFace)) {
      const previous = this.faceSmooth.get(key) ?? 0
      const eased = previous + (value - previous) * (1 - Math.exp(-delta * 9))
      this.faceSmooth.set(key, Math.abs(eased) < 0.0005 && value === 0 ? 0 : eased)
      faceSmoothed[key] = eased
    }
    for (const [key] of this.faceSmooth) {
      if (!(key in rawFace)) this.faceSmooth.delete(key)
    }
    return {
      values: filterChannels(resolvedPose, input.blockedChannels),
      faceValues: faceSmoothed,
      eyeClose: this.eyeClose,
      idle,
      activity: this.activity,
    }
  }

  /**
   * Model-optional appendage chain driven as inertial secondary motion.
   *
   * It deliberately lives downstream of the body pose: the torso supplies
   * direction, a low-frequency phase prevents a mannequin hold, and fifteen
   * progressively softer followers turn that direction into curvature. The
   * overall root is deliberately small: large root-only rotation is exactly
   * what makes a segmented tail look like a rigid baton. Models without these
   * bindings simply discard the optional logical channels.
   */
  private updateSecondaryTail(
    dt: number,
    pose: Readonly<Record<string, number>>,
    audioLevel: number,
    gain: number,
    enabled: boolean,
  ): Record<string, number> {
    // Cadence: a real idle tail completes a sweep every 3-5s. The old rate
    // (0.74 rad/s ≈ 8.5s period) plus the slow 0.43× beat term let the
    // composite dwell in one direction for 20s+ — reading as a frozen pose.
    // Faster primary + weaker beat keeps the sweep regular.
    const activityRate = this.activity === 'speaking' ? 1.5 : 1.15
    this.tailPhase += dt * activityRate
    const autonomous = Math.sin(this.tailPhase) * 5.4
      + Math.sin(this.tailPhase * 0.43 + 1.3) * 0.9
    // Body motion reaches the tail through a lagged, compressed envelope —
    // a real tail lags and softens torso/head swings instead of mirroring
    // them (mirroring tracking motion reads as the tail being yanked by the
    // cursor, which is exactly the artifact body-follow coupling produced).
    this.bodyEnvelope += (clamp(Math.abs(pose['body.x'] ?? 0) + Math.abs(pose['head.z'] ?? 0), 0, 10) - this.bodyEnvelope)
      * (1 - Math.exp(-dt * 2.2))
    const bodyInertia = -Math.sign(pose['body.x'] ?? 0) * this.bodyEnvelope * 0.34
      - (pose['head.z'] ?? 0) * 0.18
    const speechPulse = this.activity === 'speaking'
      ? Math.sin(this.tailPhase * 2.35 + 0.4) * (0.8 + clamp(audioLevel, 0, 1) * 2.4)
      : 0
    const driver = enabled
      ? clamp((autonomous + bodyInertia + speechPulse) * gain, -10, 10)
      : 0

    // Root establishes direction only. Most of the silhouette change belongs
    // to the skinning chain below.
    const rootTarget = driver * 0.18
    const rootAcceleration = (rootTarget - this.tailRootValue) * 15 - this.tailRootVelocity * 6.6
    this.tailRootVelocity += rootAcceleration * dt
    this.tailRootValue = clamp(this.tailRootValue + this.tailRootVelocity * dt, -3, 3)

    let parent = driver * 0.82
    for (let index = 0; index < this.tailSegmentValues.length; index += 1) {
      // Each stage follows the previous stage rather than the shared driver.
      // The attenuation stays strictly below 1 (chain gain < 1 — a per-stage
      // gain ≥ 1 ratchets the chain into its clamp); the tip's extra swing
      // comes from the travelling wave, which grows toward the free end and
      // is what makes the tail whip out instead of folding in.
      const progress = index / Math.max(1, this.tailSegmentValues.length - 1)
      const attenuation = 0.97
      const travellingWave = Math.sin(this.tailPhase * 1.08 - index * 0.21)
        * (0.3 + progress * 0.85)
      const counterWave = Math.sin(this.tailPhase * 0.51 + index * 0.11 + 0.8)
        * (0.08 + progress * 0.24)
      const desired = clamp(parent * attenuation + travellingWave + counterWave, -10, 10)
      // Damping stays above ζ≈0.7 at every stage: below that the chain
      // ring-resonates against the slow wave and rails into its clamp.
      // Follow-through comes from the wave's tip growth, not from bounce.
      const stiffness = Math.max(8.4, 15.5 - index * 0.35)
      const damping = Math.max(4.2, 6.15 - index * 0.13)
      const acceleration = (desired - this.tailSegmentValues[index]) * stiffness
        - this.tailSegmentVelocities[index] * damping
      this.tailSegmentVelocities[index] += acceleration * dt
      let next = this.tailSegmentValues[index] + this.tailSegmentVelocities[index] * dt
      // Kill velocity into the wall: without this the segment ping-pongs
      // against the clamp (position pinned at ±10 while velocity keeps
      // pushing) and the tail reads as frozen at full deflection.
      if ((next <= -10 && this.tailSegmentVelocities[index] < 0)
        || (next >= 10 && this.tailSegmentVelocities[index] > 0)) {
        this.tailSegmentVelocities[index] = 0
        next = clamp(next, -10, 10)
      }
      this.tailSegmentValues[index] = next
      parent = this.tailSegmentValues[index]
    }

    const output: Record<string, number> = { 'tail.z': this.tailRootValue }
    this.tailSegmentValues.forEach((value, index) => {
      output[`tail.segment${String(index + 1).padStart(2, '0')}`] = value
    })
    return output
  }
}

function logicalIdlePose(snapshot: IdleBehaviorSnapshot, gain: number): Record<string, number> {
  return {
    'head.x': snapshot.headX * gain,
    'head.y': snapshot.headY * gain,
    'head.z': snapshot.headZ * gain,
    'eye.x': snapshot.eyeX * gain,
    'eye.y': snapshot.eyeY * gain,
    // Whole-body linkage: torso follows head rotation so the character moves
    // as a connected figure, not a floating head on a static body.
    'body.x': (snapshot.bodyX + snapshot.headX * 0.32) * gain,
    // F2: clamp the head-pitch coupling so headY sway overshoot cannot leak
    // a forward body pitch into idle (the 120s no-forward-lean lock).
    'body.y': (snapshot.bodyY + clamp(snapshot.headY * 0.18, -0.3, 0.3)) * gain,
    'body.z': (-snapshot.bodyX * 0.18 + snapshot.headZ * 0.24 + snapshot.headX * 0.12) * gain,
    // Deep torso output axes (shirone ParamBodyAngleY2/Z2): secondary layers
    // that add depth to the same lean. A fraction of the primary axes so the
    // rig's two torso stages bend together instead of only the first.
    'body.y2': (snapshot.bodyY + snapshot.headY * 0.18) * 0.6 * gain,
    'body.z2': (-snapshot.bodyX * 0.18 + snapshot.headZ * 0.24 + snapshot.headX * 0.12) * 0.6 * gain,
  }
}

function logicalSpeechPose(
  sample: ReturnType<SpeechPerformanceController['update']>,
  gain: number,
): Record<string, number> {
  return {
    'head.x': sample.headX * gain,
    'head.y': sample.headY * gain,
    'head.z': sample.headZ * gain,
    // Torso follows head rotation (30%) and head pitch (15%) for whole-body
    // linkage — the character speaks with their body, not just their face.
    'body.x': (sample.bodyX + sample.headX * 0.30) * gain,
    'body.y': (sample.bodyY + sample.headY * 0.15) * gain,
    'body.z': (sample.bodyZ + sample.headZ * 0.18) * gain,
    // Deep torso output axes follow the primary lean at 60% (depth layers).
    'body.y2': (sample.bodyY + sample.headY * 0.15) * 0.6 * gain,
    'body.z2': (sample.bodyZ + sample.headZ * 0.18) * 0.6 * gain,
  }
}

function vadPosture(vad: VADVector, gain: number): Record<string, number> {
  return semanticPostureFromVAD(vad, gain)
}

function addLogical(
  base: Record<string, number>,
  addition: Record<string, number>,
): Record<string, number> {
  const result = { ...base }
  for (const [key, value] of Object.entries(addition)) result[key] = (result[key] ?? 0) + value
  return result
}

export function approachPose(
  current: Record<string, number>,
  target: Record<string, number>,
  dt: number,
  handoff = false,
): Record<string, number> {
  const result: Record<string, number> = {}
  for (const key of new Set([...Object.keys(current), ...Object.keys(target)])) {
    const from = current[key] ?? 0
    const to = target[key] ?? 0
    // Release slows during the post-switch handoff; attack keeps its crisp
    // response so speech ramp-up is never delayed.
    // Faster rates for livelier transitions: attack 6.8 (was 5.2), release 5.0 (was 3.8).
    // Handoff release 2.8 (was 1.7) — still gliding but noticeably quicker settle.
    const baseRate = Math.abs(to) > Math.abs(from) ? 6.8 : 5.0
    const response = 1 - Math.exp(-dt * (handoff && baseRate === 5.0 ? 2.8 : baseRate))
    const value = from + (to - from) * response
    if (Math.abs(value) > 0.0001 || key in target) result[key] = value
  }
  return result
}

function filterChannels(
  values: Record<string, number>,
  blocked: ReadonlySet<AmbientPerformanceChannel>,
): Record<string, number> {
  return Object.fromEntries(Object.entries(values).filter(([key]) => {
    if (key.startsWith('head.')) return !blocked.has('head')
    if (key.startsWith('body.') || key.startsWith('tail.')) return !blocked.has('body')
    if (key.startsWith('ear.')) return !blocked.has('head')
    if (key.startsWith('eye.')) return !blocked.has('gaze')
    return true
  }))
}

/** Lateral (left/right) axes flip under posture mirroring; vertical and
 *  emphasis axes (pitch, ear pin, tail lift) keep their sign. */
function lateralAxis(parameter: string): boolean {
  if (parameter.startsWith('ear.')) {
    // ear.<side>.<axis>: the forward/back pin is an emphasis axis — only the
    // side pairing swaps meaning under a mirror. shirone's authored channels
    // are all forward pins, so no ear axis flips.
    return false
  }
  if (parameter.startsWith('tail.')) return false
  return parameter.endsWith('.x') || parameter.endsWith('.z')
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}
