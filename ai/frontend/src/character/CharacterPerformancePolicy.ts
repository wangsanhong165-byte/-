import type { AvatarCapabilityProfile } from './AvatarCapabilityProfile.ts'
import { supportsExpression, supportsMotion } from './AvatarCapabilityProfile.ts'
import type { CharacterIntent, CharacterBehaviorConfig, CharacterPresentationPlan, BehaviorMapping } from './CharacterBehaviorResolver.ts'

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
    const defaults: Record<string, BehaviorMapping> = {
      speak: {},
      greet: { expression: 'happy', motion: 'wave' },
      agree: { motion: 'nod' },
      disagree: { motion: 'tilt' },
      think: { motion: 'thinking', suppressIdle: true },
      excited: { expression: 'happy', motion: 'wave', motionIntensityScale: 1.15 },
    }
    const mapping = config.behaviorMap?.[behavior] ?? defaults[behavior as keyof typeof defaults] ?? {}
    const personality = config.personality ?? {}
    const requestedExpression = emotion === 'neutral' && mapping.expression
      ? mapping.expression
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
      const candidate = profile?.semanticMotionMap?.[tag]
      if (candidate) {
        contextualMotion = candidate
        break
      }
    }
    const requestedMotion = profile?.semanticMotionMap?.[behavior]
      ?? mapping.motion
      ?? base.motion
      ?? profile?.semanticMotionMap?.[emotion]
      ?? contextualMotion
    const executableMotion = requestedMotion
      ? profile?.semanticMotionMap?.[requestedMotion] ?? requestedMotion
      : undefined
    const motion = executableMotion && supportsMotion(profile, executableMotion)
      ? executableMotion
      : undefined
    const tagEnergyScale = contextTags.has('whisper') ? 0.58
      : contextTags.has('excited') ? 1.18
      : contextTags.has('reassuring') ? 0.78 : 1
    const energy = Math.max(0.12, Math.min(1,
      (intent.energy ?? 0.5) * (personality.motionIntensityScale ?? 1)
      * (mapping.motionIntensityScale ?? 1) * tagEnergyScale,
    ))
    const transitionMs = contextTags.has('whisper') || contextTags.has('reassuring')
      ? 520 : emotion === 'surprised' || contextTags.has('excited') ? 140 : 360
    const baseMotionProbability = motion
      ? contextTags.has('interaction')
        ? 1
        : ((behavior === 'greet' || behavior === 'speak') ? 1 : Math.min(0.75, 0.2 + intensity * 0.5))
      : 0
    const motionProbability = contextTags.has('close-up') || contextTags.has('whisper')
      ? baseMotionProbability * 0.55
      : contextTags.has('excited') ? Math.min(1, baseMotionProbability * 1.2) : baseMotionProbability
    return {
      requestedExpression,
      expressionFallbackReason,
      expression,
      expressionIntensity: Math.min(1, intensity * (personality.expressionIntensityScale ?? 1) * (mapping.expressionIntensityScale ?? 1)),
      motion,
      motionIntensity: energy,
      suppressIdle: base.suppressIdle || mapping.suppressIdle === true || intent.activity === 'speaking',
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
