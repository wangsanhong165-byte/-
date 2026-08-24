// Lightweight typed event bus for decoupled communication

import type { MotionActionDefinition, MotionPlan } from '../character/MotionAction'

type Handler<T> = (event: T) => void

export interface RuntimeCharacterIntent {
  turnId: string
  emotion: string
  behavior: string
  attention: string
  energy: number
  intensity: number
  durationMs?: number
  naturalVAD?: { valence: number; arousal: number; dominance: number }
  contextTags?: string[]
  motionPlan?: MotionPlan
  /** Ordered semantic segments preserved from one LLM response. */
  segments?: Array<Record<string, unknown>>
}

export interface EventMap {
  'character:emotion': { emotion: string; intensity: number }
  'character:intent': { emotion: string; behavior: string; intensity: number }
  'character:interaction': { type: 'touch' | 'drag' | 'inactivity' | 'time' | 'presence' | 'scene'; phase?: 'start' | 'move' | 'end'; region?: 'head' | 'body' | 'unknown'; value?: string; intensity?: number }
  'character:performance_tuning': { mode?: 'legacy' | 'enhanced' | 'calibration'; parameterGain?: number; bodyMotionGain?: number }
  'character:calibration_override': { logicalParameter?: string; value?: number; clear?: boolean }
    'character:parameter_probe': { parameterId?: string; value?: number; clear?: boolean }
    'character:part_probe': { partId?: string; opacity?: number; clear?: boolean }
  'character:viewport_reset': void
  'character:render_environment_request': void
  'character:render_environment': {
    webglVendor: string
    webglRenderer: string
    webglVersion: string
    cssWidth: number
    cssHeight: number
    pixelWidth: number
    pixelHeight: number
    renderDpr: number
  }
  'character:native_catalog': { motions: string[]; expressions: string[] }
  'character:model_capability': {
      model: string
      generation: number
      supportedMotions: string[]
      supportedExpressions: string[]
      parameters: Array<{
      id: string
      displayName?: string
      groupName?: string
      minimum: number
      maximum: number
      defaultValue: number
      value: number
    }>
    parts: Array<{ id: string; displayName?: string; opacity: number; parentIndex: number }>
  }
  'character:model_capability_request': void
  'character:native_preview': { type: 'motion' | 'expression'; name: string }
  'character:actions_update': { model: string; actions: MotionActionDefinition[] }
  'character:action_preview': { action: MotionActionDefinition }
  'character:activity': { activity: string }
  'character:performance': { emotion: string; behavior: string; requestedExpression: string; expression: string; expressionFallbackReason: 'unsupported_emotion' | null; motion: string; profile: string; transitionMs: number; holdMs: number; motionProbability: number; modifiers: Record<string, unknown> }
  'character:performance_debug': {
    activity: string
    previousActivity: string
    transitionProgress: number
    vad: {
      current: { valence: number; arousal: number; dominance: number }
      target: { valence: number; arousal: number; dominance: number }
      baseline: { valence: number; arousal: number; dominance: number }
      holdRemaining: number
    }
    expression: { name: string; intensity: number }
    motion: Record<string, unknown>
    director: Record<string, unknown>
    tracking: Record<string, unknown>
    idle: Record<string, number | string | null>
    lipSync: Record<string, number | boolean>
    pose: Array<{ activeId: string; members: string[] }>
    profileCoverage: { bindingCount: number; resolvedCount: number; coverage: number; missingBindings: Array<{ logical: string; target: string }> }
    performanceTuning: { mode: 'legacy' | 'enhanced' | 'calibration'; parameterGain: number; bodyMotionGain: number }
    contestedParameters: Record<string, Array<{ source: string; value: number; priority: number }>>
    frame: {
      sampleCount: number
      intervalMs: number
      workMs: number
      controllerMs: number
      mixMs: number
      modelMs: number
      renderMs: number
      averageIntervalMs: number
      p95IntervalMs: number
      p99IntervalMs: number
      maxIntervalMs: number
      longFrameCount: number
      phases: Record<'work' | 'controller' | 'mix' | 'model' | 'render', {
        averageMs: number
        p95Ms: number
        p99Ms: number
        maxMs: number
      }>
    }
    activeChannels: string[]
    resolvedParameters: Record<string, number>
  }
  'audio:play': { audio: string; format: string; turnId: string; sequence: number; volumeArray?: number[] }
  'audio:stop': { turnId?: string; reason?: string }
  'audio:volume': { volume: number }
  'audio:start': { turnId: string; sequence: number; durationMs: number }
  'audio:end': { turnId: string }
  'audio:diagnostic.request': { requestId: string }
  'audio:diagnostic.result': {
    requestId: string
    phase: 'running' | 'passed' | 'failed'
    message: string
    peakVolume?: number
    peakMouth?: number
    finalMouth?: number
    volumeSamples?: number
  }
  'connection:change': { connected: boolean }
  'runtime:status': { status: string; message?: string }
  'runtime:error': { code: string; message: string; requestId?: string }
  'runtime:message': { text: string; reasoning?: string; segments?: Array<{ text: string; emotion: string; behavior: string }>; diagnostics?: Record<string, unknown> }
  'runtime:chunk': { text: string; delta: string }
  'runtime:tts.started': { turnId: string; format: string; sequence: number }
  'runtime:tts.completed': { turnId: string; reason: string }
  'runtime:management.result': { action: string; data: Record<string, unknown>; requestId: string }
  'runtime:management.failed': { action: string; code: string; message: string; requestId: string }
  'runtime:session': { status: string; config: Record<string, unknown> }
  'runtime:asr.result': { turnId: string; text: string }
  'runtime:permission.requested': {
    turnId: string
    requestId: string
    capability: string
    args: Record<string, unknown>
    risk: string
  }
  'runtime:character.intent': RuntimeCharacterIntent
  'runtime:telemetry.batch': { events: Array<Record<string, unknown>> }
  'runtime:turn.started': { turnId: string; inputMode: 'text' | 'audio' | 'initiative'; origin: 'user' | 'initiative' | 'tool' | 'system' }
  'runtime:turn.completed': { turnId: string; reason: string }
  'runtime:turn.failed': { turnId: string; code: string; message: string }
  'runtime:turn.cancelled': { turnId: string; reason: string }
  'runtime:service.status': { service: string; state: string; detail: string }
  'background:status': { state: 'loading' | 'ready' | 'error'; message?: string }
  'runtime:configuration.updated': { config: Record<string, unknown> }
  'character:runtime-telemetry': {
    type: string
    turnId?: string
    spanId?: string
    durationMs?: number
    metadata?: Record<string, unknown>
  }
  'character:switch_model': { name: string; requestId?: string }
  'character:model_load_result': {
    name: string
    requestId: string
    status: 'loaded' | 'failed' | 'superseded'
    message?: string
  }
  'accessory:loaded': { parts: Record<string, string>; state: Record<string, boolean> }
  'accessory:toggle': { label: string }
  'accessory:set': { label: string; enabled: boolean }
  'accessory:state_changed': { label: string; enabled: boolean; parts: Record<string, string>; state: Record<string, boolean> }
  'accessory:refresh': void
  // Avatar control layer events
  'avatar:component_update': { name: string; displayName: string; enabled: boolean; controller: string; priority: number; expression: string; paramIds: string[] }
  'avatar:expression_update': { name: string; intensity: number; controller: string; priority: number }
  'avatar:motion_update': { name: string; controller: string; priority: number; loop: boolean }
  'avatar:state_restored': { components: Record<string, boolean>; expression: string; intensity: number; motion: string }
  'avatar:suggestion': { target: string; name: string; action: string; reason: string; suggestionId: string }
  'avatar:send':
    | {
        eventType: 'character.control.requested'
        payload: { action: string; requestId: string; params: Record<string, unknown> }
      }
    | {
        eventType: 'character.suggestion.accepted'
        payload: { suggestionId: string }
      }
    | {
        eventType: 'character.suggestion.rejected'
        payload: { suggestionId: string; reason: string }
      }
}

export type EventName = keyof EventMap

export class EventBus {
  private listeners = new Map<string, Set<Handler<any>>>()

  on<K extends EventName>(event: K, handler: Handler<EventMap[K]>): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set())
    }
    this.listeners.get(event)!.add(handler)
    return () => this.listeners.get(event)?.delete(handler)
  }

  off<K extends EventName>(event: K, handler: Handler<EventMap[K]>): void {
    this.listeners.get(event)?.delete(handler)
  }

  emit<K extends EventName>(event: K, data: EventMap[K]): void {
    this.listeners.get(event)?.forEach((h) => h(data))
  }

  clear(): void {
    this.listeners.clear()
  }
}

// Singleton instance
export const eventBus = new EventBus()
