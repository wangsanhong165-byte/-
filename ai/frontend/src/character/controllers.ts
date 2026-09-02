// Character Controller — coordinates Live2D subsystems
// All parameter writes go through ParameterMixer → Live2DModelAdapter.
// No business controller may hold CubismModelHandle directly.

import { eventBus } from '../core/event-bus'
import { isPerFrameGazeLoggingEnabled } from './performance-policy'
import { getExpression } from './live2d/expression'
import { ExpressionController } from './ExpressionController'
import { MotionArbiter } from './MotionArbiter'
import { resolveAccessoryParameterState } from './AccessoryState.ts'
import { CharacterBehaviorResolver, type CharacterBehaviorConfig } from './CharacterBehaviorResolver'
import { CharacterPerformancePolicy } from './CharacterPerformancePolicy'
import { shouldStartAuthoredIdle, type AvatarCapabilityProfile } from './AvatarCapabilityProfile'
import { AvatarParameterResolver } from './AvatarParameterResolver'
import { ParameterMixer } from './ParameterMixer'
import { LipSyncController, LIP_SYNC_PRIORITY } from './LipSyncController'
import { resolveMotionStyle } from './performance/MotionStyle'
import { VADState } from './performance/VADState'
import { PrivateEmotionOverlay } from './performance/PrivateEmotionOverlay'
import type { AmbientPerformanceChannel } from './performance/AmbientPerformanceEngine'
import type { PerformanceMode } from './AvatarCapabilityProfile'
import type { NativeMotionPlayer } from './live2d/NativeMotionPlayer'
import type { Live2DModelAdapter } from './Live2DModelAdapter'
import { InteractionPerformancePolicy } from './performance/InteractionPerformancePolicy'
import { CharacterStateMachine, type CharacterActivity } from './CharacterStateMachine'
import { CalibrationController } from './CalibrationController'
import { AttentionController } from './performance/AttentionController'
import { ParameterController } from './ExpressionParameterController'
import { FrameTimingMonitor, type FrameTimingSample } from './FrameTimingMonitor'
import { EmbodiedTrackingController } from './performance/EmbodiedTrackingController'
import { PerformanceDirector } from './performance/PerformanceDirector'
import { PerformanceCoordinator } from './performance/PerformanceCoordinator'
import { PresentationIngress, type PresentationChannel, type PresentationRequest } from './performance/PresentationIngress'
export { ParameterController, expressionTargetForBlend } from './ExpressionParameterController'
import {
  compileMotionAction,
  compileMotionPlanForModel,
  normalizeLogicalMotionPresets,
  normalizeMotionActions,
  type MotionActionDefinition,
} from './MotionAction'

// ── Idle Animation (blink + breath) ──

export class IdleController {
  constructor(private readonly parameters: AvatarParameterResolver) {}
  private time = 0
  private breathing = true
  private breathWeight = 1
  private breathTarget = 1
  private blinking = true
  private idleEnabled = true
  private nextBlink = 0
  private blinkState = 0
  private blinkPhase = 0
  private _eyeOpenValue = 1
  private _blinkBreathValue = 0.5
  // Human blink cadence is 3-6s (10-20/min). 4.7 lands the presets in that
  // band: lively 3.0-4.5s, default 3.4-5.0s, calm 4.0-5.0s. The old 2.8
  // blinked ~24/min — visibly twitchy against any human reference.
  private static readonly BASE_BLINK_INTERVAL = 4.7
  private static readonly BLINK_VARIATION = 0.6
  private static readonly BREATH_FREQ = 1.7
  private blinkRate = 1
  private breathRate = 1
  private breathVariance = 0.42
  private breathMotionGain = 1

  setTiming(blinkRate = 1, breathRate = 1, breathVariance = 0.42): void {
    this.blinkRate = Math.max(0.25, Math.min(2.5, blinkRate))
    this.breathRate = Math.max(0.5, Math.min(1.8, breathRate))
    this.breathVariance = Math.max(0, Math.min(1, breathVariance))
  }

  /**
   * Expression-linked blink modulation: surprised holds a wide-eyed stare
   * (rate < 1), happy blinks a touch faster. Overrides the style rate until
   * cleared — applyIntent sets it per emotion and clears it on neutral.
   */
  setBlinkRateOverride(rate: number): void {
    this.blinkRateOverride = Math.max(0.4, Math.min(1.6, rate))
  }

  clearBlinkRateOverride(): void {
    this.blinkRateOverride = 1
  }

  private blinkRateOverride = 1

  setBreathMotionGain(gain = 1): void {
    this.breathMotionGain = Math.max(0.25, Math.min(3, gain))
  }

  attach(): void {
    this.time = 0
    this.nextBlink = IdleController.BASE_BLINK_INTERVAL
      * (0.72 + Math.random() * IdleController.BLINK_VARIATION * this.breathVariance)
      / (this.blinkRate * this.blinkRateOverride)
  }

  detach(): void {
    // nothing to clean up — no handle reference
  }

  setBreathing(enabled: boolean): void {
    this.breathing = enabled
    this.breathTarget = enabled ? 1 : 0.35
  }

  setBlinking(enabled: boolean): void {
    this.blinking = enabled
    if (!enabled) { this._eyeOpenValue = 1 }
  }

  setIdleEnabled(enabled: boolean): void {
    this.idleEnabled = enabled
    if (!enabled) { this._eyeOpenValue = 1; this._blinkBreathValue = 0.5 }
  }

  getBlinkParams(externalEyeClose = 0): Record<string, number> {
    const eyeOpen = Math.min(this._eyeOpenValue, 1 - Math.max(0, Math.min(1, externalEyeClose)))
    return this.parameters.values({ 'blink.left': eyeOpen, 'blink.right': eyeOpen })
  }

  getBreathParams(): Record<string, number> {
    return this.parameters.values({
      // ParamBreath is the model's physical breathing input. Torso axes all
      // belong to AmbientPerformanceEngine so there is only one body rhythm.
      breath: this._blinkBreathValue,
    })
  }

  update(dt: number): void {
    if (!this.idleEnabled) return
    this.time += dt
    this.breathWeight += (this.breathTarget - this.breathWeight)
      * (1 - Math.exp(-dt * 3.5))

    if (this.breathing || this.breathWeight > 0.01) {
      const phase = this.time * IdleController.BREATH_FREQ * this.breathRate
      // A small incommensurate harmonic keeps shared cloth/tail physics alive
      // without scheduling a separate periodic motion that seizes ParamBreath.
      const breath = Math.sin(phase) * 0.86
        + Math.sin(phase * 0.43 + 1.1) * 0.14
      const amplitude = Math.min(0.45, 0.18 * this.breathMotionGain)
      this._blinkBreathValue = 0.5 + breath * amplitude * this.breathWeight
    }

    if (!this.blinking) return
    if (this.time >= this.nextBlink && this.blinkState === 0) {
      this.blinkState = 1
      this.blinkPhase = 0
    }

    if (this.blinkState > 0) {
      this.blinkPhase += dt * 15
      if (this.blinkState === 1) {
        this._eyeOpenValue = Math.max(0, 1 - this.blinkPhase)
        if (this._eyeOpenValue <= 0) {
          this.blinkState = 2
          this.blinkPhase = 0
        }
      } else {
        this._eyeOpenValue = Math.min(1, this.blinkPhase)
        if (this._eyeOpenValue >= 1) {
          this.blinkState = 0
          this._eyeOpenValue = 1
          this.nextBlink = this.time + IdleController.BASE_BLINK_INTERVAL
            * (0.72 + Math.random() * IdleController.BLINK_VARIATION * this.breathVariance)
            / (this.blinkRate * this.blinkRateOverride)
        }
      }
    }
  }
}

// ── Character Controller (top-level coordinator) ──

const MODEL_PARAM_CONFIG: Record<string, {
  angleXSign: number
  angleYSign: number
  eyeBallYSign: number
}> = {
  'Design_genius_White': { angleXSign: 1, angleYSign: 1, eyeBallYSign: 1 },
  'youxiaomiao':         { angleXSign: 1, angleYSign: 1, eyeBallYSign: 1 },
  'ariu':                { angleXSign: 1, angleYSign: 1, eyeBallYSign: 1 },
  'mao_zh-Hans':         { angleXSign: 1, angleYSign: 1, eyeBallYSign: 1 },
  'hiyori_zh-Hans':      { angleXSign: 1, angleYSign: 1, eyeBallYSign: 1 },
}

function getModelParamConfig(modelName: string) {
  return MODEL_PARAM_CONFIG[modelName] ?? MODEL_PARAM_CONFIG['Design_genius_White']
}

export class CharacterController {
  paramCtrl = new ParameterController(getExpression)
  parameterResolver = new AvatarParameterResolver()
  idleCtrl = new IdleController(this.parameterResolver)
  exprCtrl = new ExpressionController(this.paramCtrl)
  motionArbiter = new MotionArbiter()
  behaviorResolver = new CharacterBehaviorResolver()
  performancePolicy = new CharacterPerformancePolicy()
  performanceCoordinator = new PerformanceCoordinator()
  mixer = new ParameterMixer()
  lipSync = new LipSyncController()
  vad = new VADState()
  interactionPolicy = new InteractionPerformancePolicy()
  privateEmotion = new PrivateEmotionOverlay()
  stateMachine = new CharacterStateMachine()
  calibration = new CalibrationController()
  attention = new AttentionController()
  frameTiming = new FrameTimingMonitor()
  embodiedTracking = new EmbodiedTrackingController()
  performanceDirector = new PerformanceDirector()
  presentationIngress = new PresentationIngress()

  // References set externally by the animation loop
  private adapter: Live2DModelAdapter | null = null
  private cleanupFns: (() => void)[] = []
  private get currentActivity(): string {
    return this.stateMachine.activity
  }
  private previousActivity = 'idle'
  private activityEnteredAt = performance.now()
  private activityBlend = 0
  private audioPlaybackActive = false
  private lastDebugEmitAt = 0
  private headTrackingEnabled = true
  private _modelName = 'Design_genius_White'
  private _modelGeneration = 0
  private _profile: AvatarCapabilityProfile | undefined
  private _style = resolveMotionStyle()
  private _performanceMode: PerformanceMode = 'enhanced'
  private _parameterGain = 1.45
  private _bodyMotionGain = 1.25
  private _currentEmotion = 'neutral'
  private _currentEmotionIntensity = 0
  private _nativeExpressions: string[] = []
  private _expressionEmotions: string[] = []
  private _emotionResolution: Record<string, string> = {}
  private _nativeMotions: string[] = []
  private _performanceResetTimer: ReturnType<typeof setTimeout> | null = null
  private _audioEndTimer: ReturnType<typeof setTimeout> | null = null
  private _turnCompletionTimer: ReturnType<typeof setTimeout> | null = null
  private _lastIntentAudit: Record<string, unknown> = {}
  private _performanceTrace: Array<Record<string, unknown>> = []

  // Tracks motion arbiter transitions for idle restart guard
  private _wasPlaying = false
  private _lastMotionEnded = false
  private _baseMotionPresets: Record<string, import('./MotionArbiter').MotionPreset> = {}
  private _actionsByModel = new Map<string, MotionActionDefinition[]>()
  // Accessory state
  private _accessoryParts: Record<string, string> = {}
  private _accessoryState: Record<string, boolean> = {}
  private _accessoryParameterIds = new Set<string>()
  private _onAccessoryChange: ((label: string, enabled: boolean) => void) | null = null

  setModelName(name: string, modelExpressionNames: string[] = []): void {
    this._modelName = name
    const configs = (window as any).__INITIAL_MODEL_INFO__?.behaviorConfig as Record<string, CharacterBehaviorConfig> | undefined
    const config = configs?.[name]
    const profiles = (window as any).__INITIAL_MODEL_INFO__?.avatarProfiles as Record<string, AvatarCapabilityProfile> | undefined
    this._profile = profiles?.[name]
    this.paramCtrl.configurePolicy(this._profile?.expressionParameterPolicy)
    this.parameterResolver.setProfile(this._profile)
    this.lipSync.configure(this.parameterResolver.getLipSyncConfig())
    this.performanceCoordinator.configure(
      this._profile?.motionStyle,
      this._profile?.personality,
      this._profile?.capabilities,
    )
    this._style = resolveMotionStyle(this._profile?.motionStyle)
    this.idleCtrl.setTiming(this._style.blinkRate, this._style.breathRate, this._style.breathVariance)
    this.idleCtrl.setBreathMotionGain(this._profile?.breathMotionGain ?? 1)
    this._performanceMode = this._profile?.performanceMode ?? 'enhanced'
    this.performanceCoordinator.setLegacy(this._performanceMode === 'legacy')
    this.performanceCoordinator.setActivity(this.currentActivity)
    this._parameterGain = this._profile?.parameterGain ?? 1.45
    this._bodyMotionGain = this._profile?.bodyMotionGain ?? 1.25
    this.applyOutputGains()
    this._baseMotionPresets = (window as any).__INITIAL_MODEL_INFO__?.motionPresets ?? {}
    this.refreshMotionPresets()
    this.behaviorResolver.setConfig(config)
    // Per-emotion resolved target: emotionMap → profile expressionMap → '' when
    // the key exists in the vocabulary but resolves to nothing distinctive.
    // UIs dedupe by target so preview buttons only show visible outcomes.
    const mergedEmotionMap: Record<string, string> = {
      ...(config?.emotionMap ?? {}),
      ...(this._profile?.expressionMap ?? {}),
    }
    this._expressionEmotions = Object.keys(mergedEmotionMap)
    this._emotionResolution = Object.fromEntries(
      Object.entries(mergedEmotionMap).map(([emotion, target]) => [emotion, target || '']),
    )
    this.exprCtrl.setModelConfig(mergedEmotionMap, modelExpressionNames)
    this._nativeExpressions = modelExpressionNames
    this.emitNativeCatalog()
  }

  setNativeMotionPlayer(player: NativeMotionPlayer | null): void {
    this.motionArbiter.setNativeMotionPlayer(
      player,
      this._profile?.motionMap,
      this._profile?.nativeMotionChannels,
    )
    this._nativeMotions = player?.list() ?? []
    this.emitNativeCatalog()
    this.startNativeIdleIfAvailable()
  }

  private refreshMotionPresets(): void {
    const authored = this._actionsByModel.get(this._modelName) ?? []
    const authoredPresets = Object.fromEntries(
      authored.map(action => {
        const preset = compileMotionAction(action)
        return [preset.name.toLowerCase(), preset]
      }),
    )
    const profilePresets = Object.fromEntries(
      normalizeLogicalMotionPresets(this._profile?.logicalMotionPresets)
        .map(preset => [preset.name.toLowerCase(), preset]),
    )
    this.motionArbiter.setPresets({
      ...this._baseMotionPresets,
      ...profilePresets,
      ...authoredPresets,
    })
  }

  /** Set the adapter reference and attach sub-controllers. */
  attach(adapter: Live2DModelAdapter, generation = 0): void {
    this.adapter = adapter
    this._modelGeneration = generation
    adapter.configureMixerBaseline(this.mixer)
    this.paramCtrl.attach(adapter, this.mixer)
    this.idleCtrl.attach()
    this.lipSync.reset()
    this.performanceCoordinator.reset()
    this.embodiedTracking.reset()
    this.performanceDirector.reset()
    this.presentationIngress.reset()
    this._lastIntentAudit = {}
    this._performanceTrace = []
    ;(globalThis as unknown as {
      __SOULLINK_PERFORMANCE_TRACE__?: Array<Record<string, unknown>>
    }).__SOULLINK_PERFORMANCE_TRACE__ = []
    this.emitModelCapability()

    // Register mixer owners with priorities
    const ids = (...keys: string[]) => keys.map(key => this.parameterResolver.resolve(key)).filter((id): id is string => Boolean(id))
    this.mixer.registerOwner('blink', ids('blink.left', 'blink.right'), 40)
    this.mixer.registerOwner('breath', ids('breath'), 20)
    // Lip-sync must beat the expression layer (75) on mouth.open, otherwise a
    // always-on expression preset pins the mouth shut while audio is playing.
    this.mixer.registerOwner('lip_sync', ids('mouth.open'), LIP_SYNC_PRIORITY)

    // Subscribe to event bus
    this.cleanupFns.push(
      eventBus.on('character:emotion', ({ emotion, intensity }) => {
        this.submitPresentation({ source: 'explicit', owner: 'manual:emotion', leaseMs: 1_500, intent: { emotion, intensity } })
      }),
    )

    this.cleanupFns.push(
      eventBus.on('character:intent', ({ emotion, behavior, intensity }) => {
        this.submitPresentation({ source: 'explicit', owner: 'manual:intent', leaseMs: 1_500, intent: { emotion, behavior, intensity } })
      }),
    )

    this.cleanupFns.push(
      eventBus.on('character:interaction', (interaction) => {
        const decision = this.interactionPolicy.resolve(interaction)
        if (decision) this.submitPresentation({ source: 'interaction', owner: `interaction:${interaction.type}`, leaseMs: 850, intent: decision.intent })
      }),
    )

    this.cleanupFns.push(
      eventBus.on('character:performance_tuning', ({ mode, parameterGain, bodyMotionGain }) => {
        if (mode) this._performanceMode = mode
        if (parameterGain !== undefined) this._parameterGain = parameterGain
        if (bodyMotionGain !== undefined) this._bodyMotionGain = bodyMotionGain
        this.performanceCoordinator.setLegacy(this._performanceMode === 'legacy')
        this.applyOutputGains()
      }),
    )

    this.cleanupFns.push(
      eventBus.on('character:native_preview', ({ type, name }) => {
        if (type === 'motion') this.motionArbiter.play(name, 'system', 0.8)
        else this.exprCtrl.apply(name, 0.9, 180)
      }),
    )

    this.cleanupFns.push(
      eventBus.on('character:parameter_probe', ({ parameterId, value, clear }) => {
        if (clear) {
          this.calibration.clearRaw()
          return
        }
        if (!parameterId || value === undefined || !this.adapter?.hasParameter(parameterId)) return
        const metadata = this.adapter.getParameterMetadata([parameterId])[0]
        if (!metadata) return
        this.calibration.setRaw(
          parameterId,
          Math.max(metadata.minimum, Math.min(metadata.maximum, value)),
          metadata.value,
        )
      }),
    )

    this.cleanupFns.push(
      eventBus.on('character:part_probe', ({ partId, opacity, clear }) => {
        if (clear) {
          this.calibration.clearRawParts()
          return
        }
        if (!partId || opacity === undefined) return
        const metadata = this.adapter?.getPartMetadata().find(part => part.id === partId)
        if (!metadata) return
        this.calibration.setRawPart(partId, opacity, metadata.opacity)
      }),
    )

    this.cleanupFns.push(
      eventBus.on('character:model_capability_request', () => this.emitModelCapability()),
    )

    this.cleanupFns.push(
      eventBus.on('character:actions_update', ({ model, actions }) => {
        this._actionsByModel.set(model, normalizeMotionActions(actions))
        if (model === this._modelName) this.refreshMotionPresets()
      }),
      eventBus.on('character:action_preview', ({ action }) => {
        const normalized = normalizeMotionActions([action])[0]
        if (!normalized) return
        const preset = compileMotionAction(normalized)
        this.motionArbiter.registerPreset(preset)
        this.motionArbiter.request({
          name: preset.name,
          owner: 'ui:action-preview',
          source: 'system',
          priority: 70,
          durationMs: preset.duration,
          timeoutMs: preset.duration + (preset.recoveryMs ?? 0) + 250,
        })
      }),
    )

    this.cleanupFns.push(
      eventBus.on('audio:stop', ({ turnId }) => {
        if (turnId && !this.stateMachine.isCurrentTurn(turnId)) return
        const activeTurnId = turnId || this.stateMachine.turnId
        if (activeTurnId) {
          this.performanceDirector.cancelTurn(activeTurnId)
          this.motionArbiter.cancelTurn(activeTurnId)
        }
        this.audioPlaybackActive = false
        this.lipSync.setSpeaking(false)
        this.exprCtrl.setSpeechMouthMute(false)
        if (this.currentActivity === 'speaking') this.onActivityChange('idle', activeTurnId)
      }),
    )

    this.cleanupFns.push(
      eventBus.on('audio:start', ({ turnId, durationMs, sequence }) => {
        if (!this.stateMachine.isCurrentTurn(turnId)) return
        if (this._turnCompletionTimer) clearTimeout(this._turnCompletionTimer)
        this._turnCompletionTimer = null
        this.performanceDirector.onAudioStart(turnId, durationMs, sequence)
        this.audioPlaybackActive = true
        this.lipSync.setSpeaking(true)
        // Mouth belongs to lip-sync while audio plays; some expression presets
        // pin mouth parameters and freeze speech otherwise. Beyond mouth.open
        // this releases mouth.form and any model-specific mouth-deforming
        // expression params declared by the profile (e.g. shirone's 鼓嘴
        // asset draws a closed pout mouth that visually swallows lip-sync).
        // Profile params are already Cubism ids and bypass logical resolution.
        const muteIds = Object.keys(this.parameterResolver.values({
          'mouth.open': 0,
          'mouth.form': 0,
        }))
        for (const id of this._profile?.speechMouthParams ?? []) muteIds.push(id)
        this.exprCtrl.setSpeechMouthMute(true, muteIds)
        this.onActivityChange('speaking', turnId)
      }),
    )

    this.cleanupFns.push(
      eventBus.on('character:calibration_override', ({ logicalParameter, value, clear }) => {
        if (clear) {
          this.calibration.clear()
          return
        }
        if (!logicalParameter) return
        if (value === undefined) this.calibration.remove(logicalParameter)
        else this.calibration.set(logicalParameter, value)
      }),
    )

    this.cleanupFns.push(
      eventBus.on('audio:end', ({ turnId }) => {
        if (!this.stateMachine.isCurrentTurn(turnId)) return
        this.performanceDirector.onAudioEnd(turnId)
        this.audioPlaybackActive = false
        this.lipSync.setSpeaking(false)
        this.exprCtrl.setSpeechMouthMute(false)
        this.presentationIngress.releaseTurn(turnId)
        if (this.currentActivity === 'speaking') {
          if (this._audioEndTimer) clearTimeout(this._audioEndTimer)
          this._audioEndTimer = setTimeout(() => {
            if (!this.audioPlaybackActive) {
              this.onActivityChange('idle', turnId)
            }
          }, 400)
        }
      }),
    )

    this.cleanupFns.push(
      eventBus.on('audio:volume', ({ volume }) => {
        this.lipSync.setVolume(volume)
      }),
    )

    this.cleanupFns.push(
      eventBus.on('runtime:turn.started', ({ turnId, inputMode }) => {
        if (this._turnCompletionTimer) clearTimeout(this._turnCompletionTimer)
        this._turnCompletionTimer = null
        this.setTurnId(turnId)
        this.onActivityChange(inputMode === 'audio' ? 'listening' : 'thinking', turnId)
      }),
    )

    this.cleanupFns.push(
      eventBus.on('runtime:asr.result', ({ turnId, text: _text }) => {
        if (!this.stateMachine.isCurrentTurn(turnId)) return
        this.submitPresentation({
          source: 'lifecycle', owner: `turn:${turnId}:asr`, turnId, leaseMs: 500,
          channels: ['expression', 'attention'],
          intent: { turnId, emotion: 'neutral', behavior: 'listen', intensity: 0.35, attention: 'user', energy: 0.25 },
        })
        this.onActivityChange('thinking', turnId)
      }),
    )

    this.cleanupFns.push(
      eventBus.on('runtime:character.intent', ({ turnId, emotion, behavior, attention, energy, intensity, durationMs, naturalVAD, contextTags, motionPlan, segments }) => {
        if (!this.stateMachine.isCurrentTurn(turnId)) return
        this.performanceDirector.stage(
          { turnId, emotion, behavior, attention: attention as any, energy, intensity, durationMs, naturalVAD, contextTags, motionPlan },
          segments,
        )
      }),
    )

    this.cleanupFns.push(
      eventBus.on('runtime:turn.completed', ({ turnId }) => {
        if (!this.stateMachine.isCurrentTurn(turnId) || this.audioPlaybackActive) return
        if (!this.performanceDirector.isAwaitingAudio(turnId)) {
          this.onActivityChange('idle', turnId)
          return
        }
        // Completion is emitted immediately after tts.audio, while decoded
        // playback starts asynchronously. Preserve the staged expression and
        // choreography through that gap; fall back to idle if audio never starts.
        if (this._turnCompletionTimer) clearTimeout(this._turnCompletionTimer)
        this._turnCompletionTimer = setTimeout(() => {
          this._turnCompletionTimer = null
          if (!this.audioPlaybackActive && this.stateMachine.isCurrentTurn(turnId)) {
            this.onActivityChange('idle', turnId)
            this.performanceDirector.onAudioUnavailable(turnId)
          }
        }, 1_000)
      }),
      eventBus.on('runtime:turn.failed', ({ turnId }) => {
        this.presentationIngress.releaseTurn(turnId)
        this.performanceDirector.cancelTurn(turnId)
        this.motionArbiter.cancelTurn(turnId)
        if (this.stateMachine.isCurrentTurn(turnId)) this.onActivityChange('idle', turnId)
      }),
      eventBus.on('runtime:turn.cancelled', ({ turnId }) => {
        this.presentationIngress.releaseTurn(turnId)
        this.performanceDirector.cancelTurn(turnId)
        this.motionArbiter.cancelTurn(turnId)
        if (this.stateMachine.isCurrentTurn(turnId)) this.onActivityChange('idle', turnId)
      }),
    )
  }

  /** Set the current turnId for stale event rejection. */
  setTurnId(turnId: string): void {
    const previousTurnId = this.stateMachine.turnId
    if (previousTurnId && previousTurnId !== turnId) {
      this.presentationIngress.releaseTurn(previousTurnId)
      this.performanceDirector.cancelTurn(previousTurnId)
      this.motionArbiter.cancelTurn(previousTurnId)
    }
    this.stateMachine.force(this.stateMachine.activity, turnId)
  }

  private onActivityChange(activity: string, turnId = ''): void {
    if (activity === 'idle' && this.audioPlaybackActive) return
    if (!activity || activity === this.currentActivity) return
    // Reject stale events from previous turns
    if (turnId && !this.stateMachine.isCurrentTurn(turnId)) {
      eventBus.emit('character:runtime-telemetry', { type: 'runtime.stale-event-rejected', metadata: { turnId, currentTurnId: this.stateMachine.turnId, activity } })
      return
    }
    const from = this.stateMachine.activity
    const to = activity as CharacterActivity
    if (!this.stateMachine.transition(to)) return
    this.previousActivity = from
    this.activityEnteredAt = performance.now()
    this.activityBlend = 0
    // State motions are phase-scoped. In particular, the higher-priority
    // thinking pose must release before speaking or semantic performance cues
    // can own the same head/gaze channels.
    this.motionArbiter.releaseState(turnId || this.stateMachine.turnId)
    this.performanceCoordinator.setActivity(activity)
    // Emit telemetry event
    eventBus.emit('character:runtime-telemetry', { type: 'state.transition', metadata: { from, to } })
    // Emit activity change so the React Store mirrors StateMachine state
    eventBus.emit('character:activity', { activity })
    switch (activity) {
      case 'idle':
        this.idleCtrl.setBreathing(true)
        this.idleCtrl.setBlinkRateOverride(1)
        this.exprCtrl.apply('neutral', 1, 520)
        this._currentEmotion = 'neutral'
        this._currentEmotionIntensity = 0
        this.vad.setEmotion('neutral', 1, 0)
        // Pipeline idle does not cancel a presentation motion already in flight.
        // Authored motions end at rest and MotionArbiter owns the continuous recovery.
        break
      case 'thinking':
        this.idleCtrl.setBreathing(true)
        // Thinking gaze drifts up/away before the answer (Neuro reference:
        // recall is preceded by a visible gaze-away beat).
        this.attention.set('away', 2_400)
        this.motionArbiter.request({
          name: 'thinking',
          owner: `state:${turnId || this.stateMachine.turnId || 'local'}`,
          source: 'system',
          priority: 55,
          channels: ['head', 'gaze'],
          turnId: turnId || this.stateMachine.turnId,
          intensity: 0.3,
        })
        break
      case 'speaking':
        this.idleCtrl.setBreathing(true)
        // SpeechPerformanceController already supplies continuous voice-driven
        // posture. Do not reserve head/body here: semantic beats and embodied
        // mouse tracking must remain able to recruit those channels.
        break
      case 'listening':
        this.idleCtrl.setBreathing(true)
        // Listening only retires authored idle. Clearing the whole arbiter here
        // made unrelated semantic gestures disappear in one frame. The native
        // idle fades out over ~320ms instead of snapping mid-pose.
        this.motionArbiter.cancelOwner('idle:native', 320)
        break
    }
  }

  private submitPresentation(request: PresentationRequest): void {
    const accepted = this.presentationIngress.submit(request)
    if (accepted) this.applyIntent(accepted.intent, accepted.channels)
  }

  /** Preserve avatar-protocol expression names while enforcing ingress ownership. */
  applyAvatarExpression(
    name: string,
    intensity: number,
    controller = 'avatar',
    authority = 100,
    transitionMs = 500,
  ): boolean {
    const accepted = this.presentationIngress.submit({
      source: 'explicit',
      owner: `avatar:${controller}:expression`,
      authority,
      leaseMs: 1_500,
      channels: ['expression'],
      intent: { emotion: name, intensity },
    })
    if (!accepted?.channels.has('expression')) return false
    this.exprCtrl.apply(name, intensity, transitionMs)
    return true
  }

  /** Preserve authored avatar motion names while enforcing ingress ownership. */
  applyAvatarMotion(
    name: string,
    controller = 'avatar',
    authority = 100,
  ): boolean {
    const accepted = this.presentationIngress.submit({
      source: 'explicit',
      owner: `avatar:${controller}:motion`,
      authority,
      leaseMs: 1_500,
      channels: ['motion'],
      intent: { behavior: name },
    })
    if (!accepted?.channels.has('motion')) return false
    this.motionArbiter.play(name)
    return true
  }

  /** Execute one accepted semantic plan through existing expression/motion controllers. */
  private applyIntent(
    intent: import('./CharacterBehaviorResolver').CharacterIntent,
    channels: ReadonlySet<PresentationChannel> = new Set(['expression', 'motion', 'attention']),
  ): void {
    const activeIntent = {
      ...intent,
      // Runtime/audio state is the sole activity authority. Presentation
      // requests may shape expression, motion, and attention only.
      activity: this.currentActivity,
    }
    if (channels.has('expression')) {
      this._currentEmotion = activeIntent.emotion || 'neutral'
      this._currentEmotionIntensity = Math.max(0, Math.min(1, activeIntent.intensity ?? 1))
      this.vad.setEmotion(activeIntent.emotion, activeIntent.intensity ?? 1)
    }
    eventBus.emit('character:runtime-telemetry', {
      type: 'intent.received',
      metadata: {
        emotion: intent.emotion,
        behavior: intent.behavior,
        intensity: intent.intensity ?? 0.5,
        energy: intent.energy ?? 0.5,
        attention: intent.attention ?? 'user',
      },
    })
    if (channels.has('expression') && activeIntent.naturalVAD) {
      this.vad.setTarget(activeIntent.naturalVAD, Math.max(0.6, (activeIntent.durationMs ?? 2400) / 1000))
    }
    const basePlan = this.behaviorResolver.resolve(activeIntent)
    const policy = this.performancePolicy.evaluate(activeIntent, basePlan, this.behaviorResolver.getConfig(), this._profile)
    if (policy.expressionFallbackReason) {
      eventBus.emit('character:runtime-telemetry', {
        type: 'expression.fallback',
        turnId: intent.turnId,
        metadata: {
          requested: policy.requestedExpression,
          resolved: policy.expression,
          reason: policy.expressionFallbackReason,
          model: this._profile?.model || this._modelName,
        },
      })
    }
    if (channels.has('attention')) {
      this.attention.set(
        policy.modifiers.attention,
        activeIntent.durationMs ?? (policy.holdMs > 0 ? policy.holdMs : undefined),
      )
    }
    if (channels.has('expression')) {
      this.exprCtrl.apply(policy.expression, policy.expressionIntensity, policy.transitionMs)
      // Consume the previously dead modifiers.blinkRate: expression-linked
      // blink pacing (surprised stare / happy quicker), cleared on neutral.
      if (policy.modifiers.blinkRate !== 1) {
        this.idleCtrl.setBlinkRateOverride(policy.modifiers.blinkRate)
      } else {
        this.idleCtrl.clearBlinkRateOverride()
      }
    }
    const plannedMotion = intent.motionPlan
      ? compileMotionPlanForModel(
          intent.motionPlan,
          `ai_${intent.turnId || this.stateMachine.turnId || 'local'}`,
          this._modelName,
          'AI 动作',
        )
      : null
    let motionDecision: {
      requested: boolean
      source: string
      accepted: boolean
      reason: string
      name?: string
      durationMs?: number | null
    } = intent.motionPlan
      ? { requested: true, source: 'motionPlan', accepted: false, reason: 'compile_rejected' }
      : { requested: false, source: 'none', accepted: false, reason: 'no_motion_requested' }
    if (channels.has('motion') && plannedMotion) {
      this.motionArbiter.registerPreset(plannedMotion)
      const accepted = this.motionArbiter.request({
        name: plannedMotion.name,
        owner: `intent-plan:${intent.turnId || this.stateMachine.turnId || 'local'}`,
        source: 'ai',
        priority: 52,
        turnId: intent.turnId || this.stateMachine.turnId,
        durationMs: plannedMotion.duration,
        timeoutMs: plannedMotion.duration + (plannedMotion.recoveryMs ?? 0) + 250,
        intensity: 1,
      })
      motionDecision = {
        requested: true,
        source: 'motionPlan',
        accepted,
        reason: accepted ? 'accepted' : 'arbiter_rejected',
        name: plannedMotion.name,
        durationMs: plannedMotion.duration,
      }
    } else if (channels.has('motion') && policy.motion && Math.random() <= policy.motionProbability) {
      const accepted = this.motionArbiter.request({
        name: policy.motion,
        owner: `intent:${intent.turnId || this.stateMachine.turnId || 'local'}`,
        source: 'ai',
        priority: 50,
        turnId: intent.turnId || this.stateMachine.turnId,
        timeoutMs: intent.durationMs,
        intensity: policy.motionIntensity,
      })
      motionDecision = {
        requested: true,
        source: 'policy',
        accepted,
        reason: accepted ? 'accepted' : 'arbiter_rejected',
        name: policy.motion,
        durationMs: intent.durationMs ?? null,
      }
    }
    this._lastIntentAudit = {
      turnId: intent.turnId ?? this.stateMachine.turnId,
      emotion: intent.emotion ?? 'neutral',
      behavior: intent.behavior ?? '',
      requestedExpression: policy.requestedExpression,
      expression: this.exprCtrl.getCurrent(),
      expressionFallbackReason: policy.expressionFallbackReason,
      expressionIntensity: this.exprCtrl.getIntensity(),
      durationMs: intent.durationMs ?? null,
      motion: motionDecision,
      naturalVAD: intent.naturalVAD ?? null,
      contextTags: intent.contextTags ?? [],
      receivedAt: performance.now(),
    }
    eventBus.emit('character:performance', {
      emotion: intent.emotion || 'neutral', behavior: intent.behavior || '',
      requestedExpression: policy.requestedExpression, expression: policy.expression,
      expressionFallbackReason: policy.expressionFallbackReason,
      motion: policy.motion || '', profile: this._profile?.model || this._modelName,
      transitionMs: policy.transitionMs, holdMs: policy.holdMs, motionProbability: policy.motionProbability,
      modifiers: { ...policy.modifiers },
    })
    if (this._performanceResetTimer) clearTimeout(this._performanceResetTimer)
    if (channels.has('expression') && policy.holdMs > 0 && activeIntent.activity !== 'speaking') {
      this._performanceResetTimer = setTimeout(() => {
        if (this.currentActivity === 'idle') {
          this.exprCtrl.apply('neutral', 1, Math.max(420, policy.transitionMs))
          this._currentEmotion = 'neutral'
          this._currentEmotionIntensity = 0
          this.vad.setEmotion('neutral', 1, 0)
        }
      }, policy.holdMs)
    }
  }

  private applyOutputGains(): void {
    const modeGain = this._performanceMode === 'legacy' ? 1
      : this._performanceMode === 'calibration' ? 1.35 : 1
    this.parameterResolver.setOutputGains(
      this._performanceMode === 'legacy' ? 1 : this._parameterGain * modeGain,
      this._performanceMode === 'legacy' ? 1 : this._bodyMotionGain,
    )
  }

  private emitNativeCatalog(): void {
    eventBus.emit('character:native_catalog', {
      motions: this._nativeMotions,
      expressions: this._nativeExpressions,
    })
  }

  private startNativeIdleIfAvailable(): void {
    if (this.currentActivity !== 'idle' || this.motionArbiter.isPlaying()) return
    if (!shouldStartAuthoredIdle(this._profile)) return
    this.motionArbiter.request({
      name: 'idle',
      owner: 'idle:native',
      source: 'idle',
      priority: 10,
      intensity: 0.7,
    })
  }

  private submitLogicalLayer(
    source: string,
    values: Record<string, number>,
    priority: number,
  ): void {
    for (const [parameterId, value] of Object.entries(this.parameterResolver.values(values))) {
      this.mixer.submit({
        id: `${source}:${parameterId}`,
        parameterId,
        source,
        channel: parameterId.toLowerCase().includes('body') ? 'body' : 'head',
        value,
        mode: 'add',
        priority,
        createdAt: performance.now(),
      })
    }
  }

  detach(): void {
    this.cleanupFns.forEach((fn) => fn())
    this.cleanupFns = []
    this.paramCtrl.detach()
    this.idleCtrl.detach()
    if (this._performanceResetTimer) clearTimeout(this._performanceResetTimer)
    if (this._audioEndTimer) clearTimeout(this._audioEndTimer)
    if (this._turnCompletionTimer) clearTimeout(this._turnCompletionTimer)
    this._performanceResetTimer = null
    this._audioEndTimer = null
    this._turnCompletionTimer = null
    this.motionArbiter.stop()
    this.calibration.clear()
    this.attention.reset()
    this.lipSync.reset()
    this.performanceCoordinator.reset()
    this.embodiedTracking.reset()
    this.performanceDirector.reset()
    this.mixer.setBaselineProvider(null)
    this.adapter = null
  }

  recordFrameTiming(sample: FrameTimingSample): void {
    this.frameTiming.record(sample)
  }

  private emitModelCapability(): void {
    if (!this.adapter) return
      const capability = {
        model: this._modelName,
        generation: this._modelGeneration,
        supportedMotions: [...(this._profile?.motions ?? [])],
        supportedExpressions: [...(this._profile?.expressions ?? [])],
        // Semantic emotion vocabulary this model can actually render (the
        // merged emotionMap keys) plus each key's resolved target, for UIs
        // that preview expressions and must dedupe visually-identical ones.
        supportedEmotions: [...this._expressionEmotions],
        emotionResolution: { ...this._emotionResolution },
        parameters: this.adapter.getParameterMetadata(),
      parts: this.adapter.getPartMetadata(),
    }
    ;(globalThis as unknown as { __SOULLINK_MODEL_CAPABILITY__?: typeof capability })
      .__SOULLINK_MODEL_CAPABILITY__ = capability
    eventBus.emit('character:model_capability', capability)
  }

  // ── Accessory control ──

  setAccessoryParts(parts: Record<string, string>): void {
    this.removeAccessoryContributions()
    this._accessoryParts = this._modelName === 'Design_genius_White'
      ? Object.fromEntries(Object.entries(parts).filter(([, expression]) => (
        expression !== '14'
        && expression !== '144'
        && expression !== '中指'
        && expression !== '中指2'
      )))
      : parts
    this.paramCtrl.setExcludedParameterIds(new Set(
      Object.values(this._accessoryParts).flatMap(expression =>
        (getExpression(expression)?.params ?? []).map(parameter => parameter.id)),
    ))
    this._accessoryState = {}
    for (const label of Object.keys(this._accessoryParts)) {
      this._accessoryState[label] = true
    }
  }

  clearAccessories(): void {
    this.removeAccessoryContributions()
    this.paramCtrl.setExcludedParameterIds([])
    this._accessoryParts = {}
    this._accessoryState = {}
    this._onAccessoryChange = null
  }

  private removeAccessoryContributions(): void {
    for (const parameterId of this._accessoryParameterIds) {
      this.mixer.removeContribution(`accessory:state:${parameterId}`)
    }
    this._accessoryParameterIds.clear()
    for (const [label, expression] of Object.entries(this._accessoryParts)) {
      const preset = getExpression(expression)
      for (const parameter of preset?.params ?? []) {
        this.mixer.removeContribution(`accessory:${label}:${parameter.id}`)
      }
    }
  }

  setAccessoryEnabled(label: string, enabled: boolean): boolean {
    const exprName = this._accessoryParts[label]
    if (!exprName || !this.adapter) {
      console.warn('[Accessory] setAccessoryEnabled failed: label=%s exprName=%s', label, exprName)
      return false
    }
    this._accessoryState[label] = enabled
    this.refreshAccessoryContributions()
    this._onAccessoryChange?.(label, enabled)
    return true
  }

  private refreshAccessoryContributions(): void {
    for (const parameterId of this._accessoryParameterIds) {
      this.mixer.removeContribution(`accessory:state:${parameterId}`)
    }
    this._accessoryParameterIds.clear()
    const merged = resolveAccessoryParameterState(
      this._accessoryParts,
      this._accessoryState,
      getExpression,
      parameterId => this.mixer.getBaseline(parameterId),
    )
    for (const [parameterId, state] of merged) {
      this._accessoryParameterIds.add(parameterId)
      this.mixer.submit({
        id: `accessory:state:${parameterId}`,
        parameterId,
        source: state.labels.length
          ? `accessory:${state.labels.join('+')}`
          : 'accessory:baseline',
        channel: 'accessory',
        value: state.value,
        mode: 'override',
        priority: 60,
        createdAt: performance.now(),
        persistent: true,
      })
    }
  }

  toggleAccessory(label: string): boolean {
    const current = this._accessoryState[label] ?? true
    return this.setAccessoryEnabled(label, !current)
  }

  getAccessoryState(): Record<string, boolean> { return { ...this._accessoryState } }
  getAccessoryParts(): Record<string, string> { return { ...this._accessoryParts } }

  onAccessoryChange(cb: (label: string, enabled: boolean) => void): void {
    this._onAccessoryChange = cb
  }

  resetAccessories(): void {
    for (const [label, enabled] of Object.entries(this._accessoryState)) {
      this.setAccessoryEnabled(label, enabled)
    }
  }

  // ── Mouse tracking ──

  setMouseTracking(enabled: boolean): void { this.headTrackingEnabled = enabled }

  resetMousePosition(): void {
    this.embodiedTracking.release()
  }

  setMousePos(x: number, y: number): void {
    this.embodiedTracking.setTarget(x, y)
  }

  // ── Per-frame update ──

  /**
   * Main per-frame update. SUBMITS contributions to the mixer.
   * The caller (animation loop) is responsible for:
   *   mixer.resolve()
   *   mixer.apply(adapter)
   *   adapter.updateModel()
   *   render(handle)
   */
  update(dt: number): void {
    if (!this.adapter) return

    // Step 1: Reset mixer frame
    this.mixer.resetFrame()
      for (const pose of this.adapter.getPoseContributions()) {
      this.mixer.submitPartOpacity({
        id: `pose:${pose.partId}`,
        partId: pose.partId,
        opacity: pose.opacity,
        priority: 10,
      })
    }

    for (const cue of this.performanceDirector.update()) {
      this.submitPresentation({
        source: 'llm', owner: `turn:${cue.turnId || this.stateMachine.turnId}:performance`,
        turnId: cue.turnId || this.stateMachine.turnId, leaseMs: cue.durationMs ?? 1_200,
        intent: cue,
      })
    }
    const vadSnapshot = this.vad.update(dt)
    const trackingPose: Record<string, number> = {}
    if (this.headTrackingEnabled) {
      const cfg = getModelParamConfig(this._modelName)
      const sample = this.embodiedTracking.update(dt)
      Object.assign(trackingPose, {
        ...sample,
        'eye.y': cfg.eyeBallYSign * sample['eye.y'],
        'head.x': cfg.angleXSign * sample['head.x'],
        'head.y': cfg.angleYSign * sample['head.y'],
      })
      if (PER_FRAME_GAZE_LOGGING) {
        console.debug('[Gaze]', sample)
      }
    }
    const explicitAttention = this.attention.update(dt)
    const blockedAmbientChannels = new Set<AmbientPerformanceChannel>()
    for (const channel of ['head', 'body', 'gaze'] as const) {
      if (this.motionArbiter.ownsExclusiveChannel(channel)) blockedAmbientChannels.add(channel)
    }
    const canControlHead = this._profile?.capabilities?.headControl !== false
    const canControlGaze = this._profile?.capabilities?.gazeControl !== false
    const lipSyncFrame = this.lipSync.update(dt)
    const ambientFrame = this.performanceCoordinator.update(dt, {
      activity: this.currentActivity,
      emotion: this._currentEmotion,
      vad: vadSnapshot.current,
      audioLevel: lipSyncFrame.value,
      enabled: true,
      blockedChannels: blockedAmbientChannels,
      tracking: trackingPose,
      trackingEngagement: this.headTrackingEnabled
        ? this.embodiedTracking.getEngagementState().weight
        : 0,
      explicitAttention,
      canControlHead,
      canControlGaze,
      gain: this._performanceMode === 'calibration' ? 1.45 : 1,
    })
    this.submitLogicalLayer('ambient_performance', ambientFrame.values, 24)
    if (this._performanceMode === 'calibration') {
      this.submitLogicalLayer('calibration', this.calibration.values(), 90)
    }
      for (const [parameterId, value] of Object.entries(this.calibration.takeRawRestores())) {
        this.mixer.submit({
          id: `calibration_raw_restore:${parameterId}`,
          parameterId,
          source: 'calibration_raw_restore',
          channel: 'calibration',
          value,
          priority: 95,
          createdAt: performance.now(),
        })
      }
      for (const [parameterId, value] of Object.entries(this.calibration.rawValues())) {
      this.mixer.submit({
        id: `calibration_raw:${parameterId}`,
        parameterId,
        source: 'calibration_raw',
        channel: 'calibration',
        value,
        priority: 95,
        createdAt: performance.now(),
      })
    }
    const expressionOwned = this.paramCtrl.getOwnedParameterIds()
    const privateParams = this.privateEmotion.update(
      this._performanceMode === 'legacy' ? 'neutral' : this._currentEmotion,
      this._performanceMode === 'legacy' ? 0 : this._currentEmotionIntensity,
      this._performanceMode === 'legacy'
        ? { valence: 0, arousal: 0, dominance: 0 }
        : vadSnapshot.current,
      this._profile?.privateEmotionMap,
      dt,
    )
    for (const [parameterId, value] of Object.entries(privateParams)) {
      if (!this.adapter.hasParameter(parameterId)) continue
      if (expressionOwned.has(parameterId)) continue
      this.mixer.submit({
        id: `private_emotion:${parameterId}`,
        parameterId,
        source: 'private_emotion',
        channel: 'expression',
        value,
        mode: 'add',
        priority: 42,
        createdAt: performance.now(),
      })
    }
    this.activityBlend = Math.min(1, (performance.now() - this.activityEnteredAt) / 420)

    // Step 2: Expression interpolation contributions
    const exprContribs = this.paramCtrl.update()
    for (const c of exprContribs) {
      this.mixer.submit({
        id: `expr:${c.parameterId}`,
        parameterId: c.parameterId,
        source: c.source,
        channel: 'expression',
        value: c.value,
        priority: c.priority,
        createdAt: performance.now(),
      })
    }

    // Step 3: Idle animations
    this.idleCtrl.update(dt)

    // Step 4: Submit per-frame behaviors to mixer

    // 4a: Blink (priority 40)
    for (const [parameterId, value] of Object.entries(
      this.idleCtrl.getBlinkParams(ambientFrame.eyeClose),
    )) {
      this.mixer.submit({
        id: `blink:${parameterId}`,
        parameterId,
        source: 'blink',
        channel: 'blink',
        value,
        mode: 'multiply',
        priority: 40,
        createdAt: performance.now(),
      })
    }

    // 4b: Breath (priority 20)
    this.mixer.setParams('breath', this.idleCtrl.getBreathParams())

    const facsFace = this.parameterResolver.values(ambientFrame.faceValues)
    for (const [parameterId, value] of Object.entries(facsFace)) {
      if (expressionOwned.has(parameterId)) continue
      this.mixer.submit({
        id: `facs:${parameterId}`,
        parameterId,
        source: 'facs_face',
        channel: 'expression',
        value,
        mode: 'add',
        priority: 72,
        createdAt: performance.now(),
      })
    }
    // 4c: Lip-sync owns mouth.open above expression while audio is active.
    if (lipSyncFrame.value > 0.0001) {
      this.mixer.setParams('lip_sync', this.parameterResolver.values({ 'mouth.open': lipSyncFrame.value }))
    }

    // 4d: Raw part probes share the same adapter write boundary.
    for (const [partId, opacity] of Object.entries(this.calibration.takeRawPartRestores())) {
      this.mixer.submitPartOpacity({
        id: `calibration_part_restore:${partId}`,
        partId,
        opacity,
        priority: 95,
      })
    }
    for (const [partId, opacity] of Object.entries(this.calibration.rawPartValues())) {
      this.mixer.submitPartOpacity({
        id: `calibration_part:${partId}`,
        partId,
        opacity,
        priority: 95,
      })
    }

    // Step 5: Motion contributions
    for (const step of this.motionArbiter.drainDueSteps()) {
      if (step.type === 'expression') this.exprCtrl.apply(step.value, 1, 220)
      else if (step.type === 'motion') this.motionArbiter.enqueue(step.value)
      else if (step.type === 'attention') this.attention.set(
        step.value === 'away' ? 'away' : step.value === 'screen' ? 'screen' : 'user',
      )
      else if (step.type === 'behavior') this.submitPresentation({
        source: 'explicit', owner: 'authored:behavior', leaseMs: 800,
        intent: { emotion: 'neutral', behavior: step.value, intensity: 0.5 },
      })
    }
    const motionContribs = this.motionArbiter.update(dt)
    for (const contribution of motionContribs) {
      const resolved = this.parameterResolver.resolveMotionDeltas({
        [contribution.logicalParameter]: contribution.value,
      })
      for (const [parameterId, value] of Object.entries(resolved)) {
        this.mixer.submit({
          id: `${contribution.source}:${parameterId}`,
          parameterId,
          source: contribution.source,
          channel: 'motion',
          value,
          mode: contribution.mode,
          weight: contribution.weight,
          priority: contribution.priority,
          createdAt: performance.now(),
        })
      }
    }
    for (const contribution of this.motionArbiter.drainNativeContributions()) {
      if (contribution.target === 'parameter') {
        if (this.parameterResolver.isProtectedMotionTarget(contribution.parameterId)) continue
        this.mixer.submit({
          id: `native-motion:${contribution.parameterId}`,
          parameterId: contribution.parameterId,
          source: `native-motion:${this.motionArbiter.currentMotion ?? 'unknown'}`,
          channel: 'motion',
          value: contribution.value,
          weight: contribution.weight,
          priority: 50,
          createdAt: performance.now(),
        })
      } else {
        this.mixer.submitPartOpacity({
          id: `native-motion:${contribution.partId}`,
          partId: contribution.partId,
          opacity: contribution.opacity,
          weight: contribution.weight,
          priority: 50,
        })
      }
    }
    // Detect motion arbiter transition: playing → idle (for idle restart guard below)
    if (this._wasPlaying && !this.motionArbiter.isPlaying()) {
      this._lastMotionEnded = true
    }
    this._wasPlaying = this.motionArbiter.isPlaying()

    // Resume authored idle only once after motion completes, not every idle frame.
    if (this.currentActivity === 'idle' && !this.motionArbiter.isPlaying() && this._lastMotionEnded) {
      this._lastMotionEnded = false
      this.startNativeIdleIfAvailable()
    }
    // Fallback: if idle with no motion and no native idle started yet, start it.
    if (this.currentActivity === 'idle' && !this.motionArbiter.isPlaying()
        && !this.motionArbiter.currentMotion && !this._lastMotionEnded) {
      this.startNativeIdleIfAvailable()
    }
    if (
      this.currentActivity !== 'speaking'
      && this.motionArbiter.currentMotion?.toLowerCase() === 'native:idle'
      && (this._profile?.idleMouthOpen ?? 0) > 0
    ) {
      const idleMouth = this.parameterResolver.values({
        'mouth.open': this._profile!.idleMouthOpen!,
      })
      for (const [parameterId, value] of Object.entries(idleMouth)) {
        this.mixer.submit({
          id: `idle_mouth_baseline:${parameterId}`,
          parameterId,
          source: 'idle_mouth_baseline',
          channel: 'lip_sync',
          value,
          mode: 'add',
          priority: 18,
          createdAt: performance.now(),
        })
      }
    }

    const now = performance.now()
    if (now - this.lastDebugEmitAt >= 250) {
      this.lastDebugEmitAt = now
      const mixerFrame = this.mixer.debugFrame()
      // _resolved is written by the animation loop's resolve() AFTER this update
      // returns, so debugFrame()'s copy is always the previous frame (empty on
      // first tick). Re-resolve here: resolve() is a pure read of the frame's
      // contributions, so this neither mutates mixer state nor disturbs the
      // caller's later resolve()/apply() — it just snapshots what WOULD resolve.
      const resolvedNow = this.mixer.resolve()
      const contestedParameters = Object.fromEntries(
        Object.entries(mixerFrame.frameValues).filter(([, values]) =>
          values.filter(value => value.mode === 'override').length > 1),
      )
      const bindings = Object.entries(this.parameterResolver.getBindings())
      const missingBindings = bindings
        .filter(([, target]) => !this.adapter!.hasParameter(target))
        .map(([logical, target]) => ({ logical, target }))
      const resolvedCount = bindings.length - missingBindings.length
      const snapshot = {
        model: this._modelName,
        activity: this.currentActivity,
        previousActivity: this.previousActivity,
        transitionProgress: this.activityBlend,
        vad: this.vad.getSnapshot(),
        expression: {
          name: this.exprCtrl.getCurrent(),
          intensity: this.exprCtrl.getIntensity(),
        },
        motion: this.motionArbiter.getDebugState(),
        director: this.performanceDirector.getDebugState(),
        intentAudit: { ...this._lastIntentAudit },
        tracking: this.embodiedTracking.getDebugState(),
        ambient: {
          activity: ambientFrame.activity,
          values: { ...ambientFrame.values },
        },
        idle: { ...ambientFrame.idle },
        lipSync: { ...this.lipSync.getDebugInfo() },
        attention: {
          explicitWeight: explicitAttention.weight,
          ...ambientFrame.attention,
        },
        pose: this.adapter.getPoseDebug(),
        profileCoverage: {
          bindingCount: bindings.length,
          resolvedCount,
          coverage: bindings.length ? resolvedCount / bindings.length : 1,
          missingBindings,
        },
        performanceTuning: {
          mode: this._performanceMode,
          parameterGain: this._parameterGain,
          bodyMotionGain: this._bodyMotionGain,
        },
        contestedParameters,
        frame: this.frameTiming.snapshot(),
        activeChannels: this.motionArbiter.getActiveChannels(),
        resolvedParameters: resolvedNow,
      }
      ;(globalThis as unknown as { __SOULLINK_RUNTIME_SNAPSHOT__?: typeof snapshot })
        .__SOULLINK_RUNTIME_SNAPSHOT__ = snapshot
      this._performanceTrace.push({
        at: now,
        model: snapshot.model,
        activity: snapshot.activity,
        expression: snapshot.expression,
        motion: snapshot.motion,
        intentAudit: snapshot.intentAudit,
        tracking: snapshot.tracking,
        attention: snapshot.attention,
        idle: snapshot.idle,
        lipSync: snapshot.lipSync,
        resolvedParameters: snapshot.resolvedParameters,
      })
      if (this._performanceTrace.length > 240) {
        this._performanceTrace.splice(0, this._performanceTrace.length - 240)
      }
      ;(globalThis as unknown as {
        __SOULLINK_PERFORMANCE_TRACE__?: Array<Record<string, unknown>>
      }).__SOULLINK_PERFORMANCE_TRACE__ = this._performanceTrace.map(item => ({ ...item }))
      eventBus.emit('character:performance_debug', snapshot)
    }
  }

  getLipSyncDebug() {
    return this.lipSync.getDebugInfo()
  }

  getMixerDebug(): string {
    const info = this.mixer.debugFrame()
    return Object.entries(info.resolved)
      .map(([k, v]) => `${k}=${v.toFixed(3)}`)
      .join('  ')
  }
}
const PER_FRAME_GAZE_LOGGING = isPerFrameGazeLoggingEnabled(
  (globalThis as {
    __SOULLINK_DIAGNOSTICS__?: { gazeFrames?: boolean }
  }).__SOULLINK_DIAGNOSTICS__?.gazeFrames,
)
