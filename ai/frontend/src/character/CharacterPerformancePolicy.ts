import type { AvatarCapabilityProfile } from './AvatarCapabilityProfile.ts'
import { semanticMotionOf, supportsExpression, supportsMotion } from './AvatarCapabilityProfile.ts'
import { DEFAULT_BEHAVIORS, type CharacterIntent, type CharacterBehaviorConfig, type CharacterPresentationPlan } from './CharacterBehaviorResolver.ts'

export interface PerformanceModifiers {
  blinkRate: number
  bodyEnergy: number
  attention: 'user' | 'screen' | 'away' | 'neutral'
}

export interface PerformancePlan extends CharacterPresentationPlan {
  requestedExpression: string
  expressionFallbackReason: 'unsupported_emotion' | null
  transitionMs: number
  holdMs: number
  modifiers: PerformanceModifiers
  motionProbability: number
}

export class CharacterPerformancePolicy {
  evaluate(intent: CharacterIntent, base: CharacterPresentationPlan, config: CharacterBehaviorConfig, profile?: AvatarCapabilityProfile): PerformancePlan {
    const intensity = Math.max(0, Math.min(1, intent.intensity ?? 1))
    const emotion = (intent.emotion || 'neutral').toLowerCase()
    const behavior = (intent.behavior || '').toLowerCase()
    const contextTags = new Set((intent.contextTags ?? []).map(tag => tag.toLowerCase()))
    // Single source of truth: DEFAULT_BEHAVIORS lives in the resolver. The
    // policy must not keep a shadow subset — it silently lost the intensity
    // scales for laugh/comfort/shrug etc. that only existed in the resolver.
    const mapping = config.behaviorMap?.[behavior] ?? DEFAULT_BEHAVIORS[behavior] ?? {}
    // semanticMotionMap is THE model-specific motion table (2026-09-05
    // consolidation: live2d_models.json behavior_map retired for models using
    // it). Its object form carries the per-behavior modifiers the config
    // table used to hold.
    const semanticEntry = profile?.semanticMotionMap?.[behavior]
    const semanticMotion = semanticMotionOf(semanticEntry)
    const semanticIntensityScale = typeof semanticEntry === 'object' ? semanticEntry.intensityScale : undefined
    const semanticSuppressIdle = typeof semanticEntry === 'object' ? semanticEntry.suppressIdle === true : false
    const semanticExpression = typeof semanticEntry === 'object' ? semanticEntry.expression : undefined
    // 2026-09-05 dual-emotion: the true feeling under the surface emotion
    // (口是心非). Only surfaces when it differs from the shown emotion and
    // the model can render its face; sincere segments have none.
    const rawLeak = typeof intent.leak === 'string' ? intent.leak.toLowerCase() : ''
    const leakExpression = rawLeak && rawLeak !== emotion && supportsExpression(profile, rawLeak)
      ? rawLeak
      : undefined
    const personality = config.personality ?? {}
    const requestedExpression = emotion === 'neutral' && (semanticExpression ?? mapping.expression)
      ? (semanticExpression ?? mapping.expression)!
      : (base.expression ?? emotion)
    const expression = (
      Object.prototype.hasOwnProperty.call(config.emotionMap ?? {}, requestedExpression)
      || supportsExpression(profile, requestedExpression)
    ) ? requestedExpression : 'neutral'
    const expressionFallbackReason = expression === requestedExpression
      ? null
      : 'unsupported_emotion'
    // A profile sequence is descriptive metadata, not an executable motion.
    // The old shortcut replaced a valid model mapping such as `arm_wave` with
    // the literal name `greet`; unless a native motion or preset with that
    // exact name exists, MotionArbiter correctly rejects it and the intent
    // becomes visually silent.
    let contextualMotion: string | undefined
    for (const tag of contextTags) {
      const candidate = semanticMotionOf(profile?.semanticMotionMap?.[tag])
      if (candidate) {
        contextualMotion = candidate
        break
      }
    }
    const requestedMotion = semanticMotion
      ?? mapping.motion
      ?? base.motion
      ?? semanticMotionOf(profile?.semanticMotionMap?.[emotion])
      ?? contextualMotion
    const executableMotion = requestedMotion
      ? semanticMotionOf(profile?.semanticMotionMap?.[requestedMotion]) ?? requestedMotion
      : undefined
    const motion = executableMotion && supportsMotion(profile, executableMotion)
      ? executableMotion
      : undefined
    const tagEnergyScale = contextTags.has('whisper') ? 0.58
      : contextTags.has('somber') ? 0.5
      : contextTags.has('formal') ? 0.62
      : contextTags.has('excited') ? 1.18
      : contextTags.has('reassuring') ? 0.78 : 1
    const energy = Math.max(0.12, Math.min(1,
      (intent.energy ?? 0.5) * (personality.motionIntensityScale ?? 1)
      * (semanticIntensityScale ?? mapping.motionIntensityScale ?? 1) * tagEnergyScale,
    ))
    const transitionMs = contextTags.has('whisper') || contextTags.has('reassuring')
      ? 520 : emotion === 'surprised' || contextTags.has('excited') ? 140 : 360
    const baseMotionProbability = motion
      ? contextTags.has('interaction')
        ? 1
        // Neuro reference measures 8-11 salient head beats/min while talking.
        // The old min(0.75, 0.2 + intensity*0.5) silently dropped over half of
        // the policy's fallback gestures, which read as "the director does
        // nothing". Floor the speak behavior high and scale the rest on
        // intensity, keeping the arbiter and the director's repeat window as
        // the real de-duplicators.
        : behavior === 'speak' ? 1 : Math.min(0.9, 0.55 + intensity * 0.35)
      : 0
    const motionProbability = contextTags.has('close-up') || contextTags.has('whisper')
      ? baseMotionProbability * 0.55
      : contextTags.has('excited') ? Math.min(1, baseMotionProbability * 1.2) : baseMotionProbability
    return {
      requestedExpression,
      expressionFallbackReason,
      expression,
      leakExpression,
      expressionIntensity: Math.min(1, intensity * (personality.expressionIntensityScale ?? 1) * (mapping.expressionIntensityScale ?? 1)),
      motion,
      motionIntensity: energy,
      suppressIdle: base.suppressIdle || semanticSuppressIdle || mapping.suppressIdle === true || intent.activity === 'speaking',
      transitionMs,
      holdMs: intent.activity === 'speaking' ? 0 : 3000,
      modifiers: {
        blinkRate: emotion === 'surprised' ? 0.75 : emotion === 'happy' ? 1.2 : 1,
        bodyEnergy: energy,
        attention: intent.attention === 'screen' ? 'screen'
          : intent.attention === 'away' ? 'away'
          : intent.attention === 'neutral' ? 'neutral'
          : (behavior === 'think' || ['shy', 'embarrassed', 'confused'].includes(emotion))
              && !contextTags.has('close-up') ? 'away' : 'user',
      },
      motionProbability,
    }
  }
}
