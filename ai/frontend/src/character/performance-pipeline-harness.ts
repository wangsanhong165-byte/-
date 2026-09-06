// Pipeline-level scenario harness for the Live2D performance layer.
//
// Wires the REAL pipeline modules (AttentionController, PerformanceCoordinator,
// MotionArbiter, EmbodiedTrackingController, ParameterMixer) in the same
// per-frame order the AvatarController animation frame uses
// (controllers.ts:1090-1303) and drives them with declarative event scripts.
//
// Scope: pose/gaze/attention continuity — the layers where flash artifacts
// live. Face/expression layering stays covered by its unit tests.
//
// Scenarios + their invariants live in performance-scenarios.test.ts; this
// module is pure (no node:test) so it also runs single-process in restricted
// sandboxes.
//
// ANTI-DRIFT RULE: the per-frame wiring below mirrors controllers.ts's
// animation frame (and ctx.transition mirrors onActivityChange) BY HAND.
// Changing either side of controllers.ts requires diffing this file in the
// same commit — see docs/performance-recipes-sop.md §7. Shared logic (e.g.
// activity entries) must be extracted here and imported by production, never
// copied.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { enterThinking } from './performance/activity-entries.ts'
import { AttentionController, type AttentionTarget } from './performance/AttentionController.ts'
import { PerformanceCoordinator } from './performance/PerformanceCoordinator.ts'
import { MotionArbiter, type MotionPreset } from './MotionArbiter.ts'
import type { AmbientPerformanceChannel } from './performance/AmbientPerformanceEngine.ts'
import { EmbodiedTrackingController } from './performance/EmbodiedTrackingController.ts'
import { AvatarParameterResolver } from './AvatarParameterResolver.ts'
import type { AvatarCapabilityProfile } from './AvatarCapabilityProfile.ts'
import { ParameterMixer } from './ParameterMixer.ts'

export type ScenarioActivity = 'idle' | 'listening' | 'thinking' | 'speaking'

const FRAME_SECONDS = 1 / 60
const POSE_KEYS = ['head.x', 'head.y', 'head.z', 'body.x', 'body.y', 'body.z', 'eye.x', 'eye.y']
// The production model: data/settings.json live2dModel + app/bridge/server.py:47.
const PROFILE_NAME = 'shirone'
// Fixed motion-style seed: MotionStyle falls back to Date.now()+Math.random()
// (MotionStyle.createMotionSeed) which would make every scenario run peak
// slightly differently. Production stays random on purpose; scenarios pin the
// seed so thresholds are calibrated against ONE reproducible trajectory.
const SCENARIO_STYLE_SEED = 20260903

export interface PipelineSample { t: number; values: Record<string, number> }

export interface ScenarioContext {
  /** Canonical activity edge: releases the outgoing state motion, applies the
   *  per-activity effects (mirrors controllers.ts onActivityChange). */
  transition(activity: ScenarioActivity): void
  setEmotion(emotion: string): void
  setAttention(target: AttentionTarget, durationMs?: number): void
  /** LLM-tier motion request (priority 50); acceptance is arbitrated. */
  requestMotion(name: string, priority?: number): boolean
  trackPointer(x: number, y: number): void
  releasePointer(): void
}

export interface ScenarioEvent { atSeconds: number; run: (ctx: ScenarioContext) => void }

export interface ScenarioOptions {
  events?: ScenarioEvent[]
  durationSeconds?: number
  /** Shipped logical presets (config/motions/<name>.json) to register. */
  presets?: readonly string[]
  /** Motion-style preset override — selects the emotion posture set
   *  (performance-recipes POSTURE_SETS). Defaults to the profile's own. */
  stylePreset?: 'natural' | 'lively' | 'calm' | 'shy'
}

export interface ScenarioResult {
  series: PipelineSample[]
  motionRequests: Array<{ name: string; accepted: boolean }>
  activityLog: Array<{ at: number; activity: ScenarioActivity }>
}

export interface Metric { max: number; span: [number, number] | null; key?: string }

const PRESETS_DIR = new URL('../../../config/motions/', import.meta.url)

export function loadShippedPreset(name: string): MotionPreset {
  return JSON.parse(readFileSync(fileURLToPath(new URL(`${name}.json`, PRESETS_DIR)), 'utf8')) as MotionPreset
}

function loadProductionProfile(): AvatarCapabilityProfile {
  const path = fileURLToPath(new URL(`../../../config/avatar_profiles/${PROFILE_NAME}.json`, import.meta.url))
  return JSON.parse(readFileSync(path, 'utf8')) as AvatarCapabilityProfile
}

export function runScenario(options: ScenarioOptions): ScenarioResult {
  const durationSeconds = options.durationSeconds ?? 6
  const frames = Math.round(durationSeconds / FRAME_SECONDS)

  let simClockMs = 0
  const arbiter = new MotionArbiter(() => simClockMs)
  const mixer = new ParameterMixer()
  mixer.setBaselineProvider(() => 0)
  const attention = new AttentionController(1)
  const coordinator = new PerformanceCoordinator()
  // Production profile + output gains, resolved through the REAL parameter
  // resolver exactly as controllers.ts does (applyOutputGains + values()/
  // resolveMotionDeltas), so gains/binding scales/clamps match live behavior.
  const profile = loadProductionProfile()
  const resolver = new AvatarParameterResolver()
  resolver.setProfile(profile)
  resolver.setOutputGains(profile.parameterGain ?? 1, profile.bodyMotionGain ?? 1)
  coordinator.configure(
    { ...profile.motionStyle, seed: SCENARIO_STYLE_SEED, preset: options.stylePreset ?? profile.motionStyle?.preset },
    profile.personality,
    profile.capabilities,
  )
  const embodiedTracking = new EmbodiedTrackingController()
  for (const name of options.presets ?? []) arbiter.registerPreset(loadShippedPreset(name))

  let turnIndex = 0
  let motionSeq = 0
  let activity: ScenarioActivity = 'idle'
  let emotion = 'neutral'
  let pointerEnabled = false
  const series: PipelineSample[] = []
  const motionRequests: ScenarioResult['motionRequests'] = []
  const activityLog: ScenarioResult['activityLog'] = []
  const events = [...(options.events ?? [])].sort((left, right) => left.atSeconds - right.atSeconds)
  let eventIndex = 0

  const ctx: ScenarioContext = {
    // Canonical activity edge (controllers.ts:622-670): release the outgoing
    // state motion first, then switch, then apply per-activity effects.
    // releaseState takes a BARE turnId — it prepends `state:` itself
    // (MotionArbiter.releaseState); passing the prefixed owner silently
    // releases nothing.
    transition(next) {
      arbiter.releaseState(`turn${turnIndex}`)
      if (next === 'thinking') turnIndex += 1 // a new user turn starts
      coordinator.setActivity(next)
      activity = next
      activityLog.push({ at: simClockMs / 1000, activity: next })
      if (next === 'thinking') {
        // Shared activity entry — the exact code path controllers.ts executes.
        enterThinking(attention, arbiter, `turn${turnIndex}`)
      }
    },
    setEmotion(value) { emotion = value },
    setAttention(target, durationMs) { attention.set(target, durationMs) },
    requestMotion(name, priority = 50) {
      const accepted = arbiter.request({
        name,
        owner: `script:${name}:${motionSeq += 1}`,
        source: 'ai',
        priority,
      })
      motionRequests.push({ name, accepted })
      return accepted
    },
    trackPointer(x, y) { pointerEnabled = true; embodiedTracking.setTarget(x, y) },
    releasePointer() { embodiedTracking.release() },
  }

  for (let frame = 0; frame < frames; frame += 1) {
    const t = frame * FRAME_SECONDS
    simClockMs = Math.round(t * 1000)
    while (eventIndex < events.length && events[eventIndex]!.atSeconds <= t) {
      events[eventIndex]!.run(ctx)
      eventIndex += 1
    }

    mixer.resetFrame()

    const explicitAttention = attention.update(FRAME_SECONDS)
    // No native motions participate in scenarios, so no channel is ever
    // exclusively blocked (MotionArbiter.ownsExclusiveChannel is native-only).
    const blockedChannels = new Set<AmbientPerformanceChannel>()
    const trackingPose: Record<string, number> = {}
    let trackingEngagement = 0
    if (pointerEnabled) {
      Object.assign(trackingPose, embodiedTracking.update(FRAME_SECONDS))
      trackingEngagement = embodiedTracking.getEngagementState().weight
    }
    const ambientFrame = coordinator.update(FRAME_SECONDS, {
      activity,
      emotion,
      vad: { valence: 0, arousal: 0, dominance: 0 },
      audioLevel: 0,
      enabled: true,
      blockedChannels,
      tracking: trackingPose,
      trackingEngagement,
      explicitAttention,
      canControlHead: true,
      canControlGaze: true,
      gain: 1,
    })
    for (const [parameterId, value] of Object.entries(resolver.values(ambientFrame.values))) {
      mixer.submit({
        id: `ambient_performance:${parameterId}`,
        parameterId,
        source: 'ambient_performance',
        channel: parameterId.toLowerCase().includes('body') || parameterId.toLowerCase().includes('tail') ? 'body' : 'head',
        value,
        mode: 'add',
        priority: 24,
        createdAt: simClockMs,
      })
    }
    for (const contribution of arbiter.update(FRAME_SECONDS)) {
      for (const [parameterId, value] of Object.entries(resolver.resolveMotionDeltas({
        [contribution.logicalParameter]: contribution.value,
      }))) {
        mixer.submit({
          id: `${contribution.source}:${parameterId}`,
          parameterId,
          source: contribution.source,
          channel: 'motion',
          value,
          mode: contribution.mode,
          weight: contribution.weight,
          priority: contribution.priority,
          createdAt: simClockMs,
        })
      }
    }
    const resolved = mixer.resolve()
    const values: Record<string, number> = {}
    for (const key of POSE_KEYS) {
      const cubismId = resolver.resolve(key)
      values[key] = (cubismId ? resolved[cubismId] : undefined) ?? 0
    }
    series.push({ t, values })
  }

  return { series, motionRequests, activityLog }
}

/** Largest single-frame move of one logical parameter (the flash detector),
 *  optionally restricted to a time range. */
export function maxFrameStep(series: PipelineSample[], key: string, from = -Infinity, to = Infinity): Metric {
  let max = 0
  let span: [number, number] | null = null
  for (let index = 1; index < series.length; index += 1) {
    const at = series[index]!.t
    if (at < from || at > to) continue
    const delta = Math.abs(series[index]!.values[key]! - series[index - 1]!.values[key]!)
    if (delta > max) {
      max = delta
      span = [series[index - 1]!.t, series[index]!.t]
    }
  }
  return { max, span, key }
}

/** Largest single-frame move across several parameters. */
export function maxFrameStepAcross(series: PipelineSample[], keys: readonly string[], from = -Infinity, to = Infinity): Metric {
  let worst: Metric = { max: 0, span: null }
  for (const key of keys) {
    const metric = maxFrameStep(series, key, from, to)
    if (metric.max > worst.max) worst = metric
  }
  return worst
}

/** Largest move of one parameter within any sliding window. */
export function maxWindowDelta(
  series: PipelineSample[],
  key: string,
  from: number,
  to: number,
  windowSeconds = 0.15,
): Metric {
  let max = 0
  let span: [number, number] | null = null
  for (let i = 0; i < series.length; i += 1) {
    if (series[i]!.t < from) continue
    for (let j = i; j < series.length; j += 1) {
      if (series[j]!.t > series[i]!.t + windowSeconds) break
      if (series[j]!.t > to) break
      const delta = Math.abs(series[j]!.values[key]! - series[i]!.values[key]!)
      if (delta > max) {
        max = delta
        span = [series[i]!.t, series[j]!.t]
      }
    }
  }
  return { max, span, key }
}

/** Peak absolute value of one parameter inside a time range. */
export function maxAbs(series: PipelineSample[], key: string, from: number, to: number): number {
  let max = 0
  for (const sample of series) {
    if (sample.t < from || sample.t > to) continue
    max = Math.max(max, Math.abs(sample.values[key] ?? 0))
  }
  return max
}
