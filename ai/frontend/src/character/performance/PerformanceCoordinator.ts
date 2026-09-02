import type {
  AvatarPerformanceCapabilities,
  CharacterPerformancePersonality,
} from '../AvatarCapabilityProfile.ts'
import {
  AmbientPerformanceEngine,
  type AmbientPerformanceChannel,
  type AmbientPerformanceFrame,
} from './AmbientPerformanceEngine.ts'
import {
  AutonomousAttentionController,
  blendAttentionWithTracking,
  mergeAttentionSamples,
  type AttentionBlendSample,
} from './AutonomousAttentionController.ts'
import type { MotionStyleOptions } from './MotionStyle.ts'
import { resolveMotionStyle } from './MotionStyle.ts'
import type { VADVector } from './VADState.ts'

export interface PerformanceCoordinationInput {
  activity: string
  emotion: string
  vad: VADVector
  audioLevel: number
  enabled: boolean
  blockedChannels: ReadonlySet<AmbientPerformanceChannel>
  tracking: Record<string, number>
  trackingEngagement: number
  explicitAttention: AttentionBlendSample
  canControlHead: boolean
  canControlGaze: boolean
  gain?: number
}

export interface PerformanceCoordinationFrame extends AmbientPerformanceFrame {
  attention: {
    active: boolean
    headWeight: number
    gazeWeight: number
    trackingEngagement: number
    autonomous: Record<string, unknown>
  }
}

/**
 * Single choreography owner for ambient pose, pointer tracking and attention.
 *
 * Low-level controllers still generate motion, but they no longer submit
 * competing head/gaze layers. Their targets are combined here and emitted as
 * one continuous ambient pose.
 */
export class PerformanceCoordinator {
  private readonly ambient = new AmbientPerformanceEngine()
  private readonly autonomous = new AutonomousAttentionController()

  configure(
    options: MotionStyleOptions | undefined,
    personality?: CharacterPerformancePersonality,
    capabilities?: AvatarPerformanceCapabilities,
  ): void {
    this.ambient.configure(options, personality, capabilities)
    this.autonomous.reset(resolveMotionStyle(options).seed + 73)
  }

  setActivity(activity: string): void {
    this.ambient.setActivity(activity)
  }

  setLegacy(enabled: boolean): void {
    this.ambient.setLegacy(enabled)
  }

  reset(): void {
    this.ambient.reset()
    this.autonomous.reset()
  }

  update(dt: number, input: PerformanceCoordinationInput): PerformanceCoordinationFrame {
    const trackingEngagement = clamp(input.trackingEngagement, 0, 1)
    const supportedTracking = filterAttentionChannels(
      input.tracking,
      input.canControlHead,
      input.canControlGaze,
    )
    const autonomous = this.autonomous.update(dt, {
      enabled: input.enabled
        && (input.emotion === 'neutral' || input.activity === 'speaking')
        && input.explicitAttention.weight <= 0.05
        && trackingEngagement <= 0.02
        && (input.canControlHead || input.canControlGaze)
        && !input.blockedChannels.has('head')
        && !input.blockedChannels.has('gaze'),
      activity: input.activity,
      interactionEngaged: trackingEngagement > 0.02,
      // Speaking glances are peeks at ~1/3 idle strength (Neuro reference:
      // gaze rhythm continues during speech, quieter than idle episodes).
      strengthScale: input.activity === 'speaking' ? 0.35 : 1,
    })
    const attention = mergeAttentionSamples(input.explicitAttention, autonomous)
    const headWeight = attention.channelWeights?.head ?? attention.weight
    const gazeWeight = attention.channelWeights?.gaze ?? attention.weight
    const attentionActive = Math.max(headWeight, gazeWeight) > 0.001
    const supportedAttention = filterAttentionChannels(
      attention.values,
      input.canControlHead,
      input.canControlGaze,
    )
    const coordinatedFocus = attentionActive
      ? blendAttentionWithTracking(
          supportedAttention,
          supportedTracking,
          attention.weight,
          attention.channelWeights,
        )
      : supportedTracking

    const ambient = this.ambient.update(dt, {
      emotion: input.emotion,
      vad: input.vad,
      audioLevel: input.audioLevel,
      enabled: input.enabled,
      blockedChannels: input.blockedChannels,
      tracking: coordinatedFocus,
      focusWeights: {
        head: Math.max(trackingEngagement, headWeight),
        gaze: Math.max(trackingEngagement, gazeWeight),
        body: trackingEngagement,
      },
      gain: input.gain,
    })
    return {
      ...ambient,
      attention: {
        active: attentionActive,
        headWeight,
        gazeWeight,
        trackingEngagement,
        autonomous: this.autonomous.getDebugState(),
      },
    }
  }
}

function filterAttentionChannels(
  values: Readonly<Record<string, number>>,
  head: boolean,
  gaze: boolean,
): Record<string, number> {
  return Object.fromEntries(Object.entries(values).filter(([key]) => {
    if (key.startsWith('head.')) return head
    if (key.startsWith('eye.')) return gaze
    return key.startsWith('body.')
  }))
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}
