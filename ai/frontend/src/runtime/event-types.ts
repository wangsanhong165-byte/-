import type { MotionPlan } from '../character/MotionAction'

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue }

export const EVENT_TYPES = [
  'session.open',
  'session.opened',
  'session.closed',
  'session.ping',
  'session.pong',
  'runtime.status',
  'runtime.ready',
  'runtime.degraded',
  'service.status',
  'configuration.updated',
  'protocol.error',
  'user.text',
  'user.visual',
  'user.audio.started',
  'user.audio.chunk',
  'user.audio.completed',
  'user.audio.cancelled',
  'turn.started',
  'turn.progress',
  'turn.completed',
  'turn.failed',
  'turn.cancelled',
  'asr.started',
  'asr.result',
  'asr.failed',
  'assistant.text.started',
  'assistant.text.chunk',
  'assistant.text.completed',
  'assistant.failed',
  'character.intent',
  'character.expression',
  'character.motion',
  'character.component',
  'character.snapshot',
  'character.suggestion',
  'character.control.requested',
  'character.suggestion.accepted',
  'character.suggestion.rejected',
  'tts.started',
  'tts.audio',
  'tts.completed',
  'tts.failed',
  'tts.cancelled',
  'tool.requested',
  'tool.started',
  'tool.result',
  'tool.failed',
  'management.requested',
  'management.result',
  'management.failed',
  'telemetry.batch',
] as const

export type EventType = (typeof EVENT_TYPES)[number]
export type EventSource = 'frontend' | 'runtime' | 'bridge' | 'lifecycle' | 'platform'
export type JsonObject = { [key: string]: JsonValue }

export interface FailurePayload {
  code: string
  message: string
}

export interface CancelledPayload {
  reason: string
}

export interface VisualAttachment {
  id: string
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp'
  width: number
  height: number
  sizeBytes: number
  source?: string
  sha256?: string
  expiresAt?: number
}

export interface EventPayloadMap {
  'session.open': { capabilities: string[] }
  'session.opened': { capabilities: string[]; config: JsonObject }
  'session.closed': { reason: string }
  'session.ping': { nonce: string }
  'session.pong': { nonce: string }
  'runtime.status': { state: string; message: string }
  'runtime.ready': { services: string[] }
  'runtime.degraded': { services: string[]; reason: string }
  'service.status': {
    service: string
    state: 'starting' | 'ready' | 'degraded' | 'failed' | 'stopped'
    detail: string
  }
  'configuration.updated': { config: JsonObject }
  'protocol.error': {
    code: string
    message: string
    requestId?: string | null
    offendingEventId?: string | null
  }
  'user.text': { text: string }
  'user.visual': { text: string; attachments: VisualAttachment[] }
  'user.audio.started': { sampleRate: number; channels: number; format: 'pcm_f32' | 'pcm_s16' | 'wav' }
  'user.audio.chunk': { samples: number[] }
  'user.audio.completed': { sampleRate?: number | null; attachments?: VisualAttachment[] }
  'user.audio.cancelled': CancelledPayload
  'turn.started': { origin: 'user' | 'initiative' | 'tool' | 'system'; inputMode: 'text' | 'audio' | 'visual' | 'initiative' }
  'turn.progress': { stage: string; message: string }
  'turn.completed': { reason: string }
  'turn.failed': FailurePayload
  'turn.cancelled': CancelledPayload
  'asr.started': { language?: string | null }
  'asr.result': { text: string; confidence?: number | null; language?: string | null }
  'asr.failed': FailurePayload
  'assistant.text.started': Record<string, never>
  'assistant.text.chunk': { delta: string; text: string }
  'assistant.text.completed': {
    text: string
    reasoning: string
    segments: Array<{ text: string; emotion: string; behavior: string }>
  }
  'assistant.failed': FailurePayload
    'character.intent': {
      emotion: string
      behavior: string
      intensity: number
      attention: 'user' | 'screen' | 'away' | 'neutral'
    energy: number
    durationMs?: number | null
    naturalVAD?: { valence: number; arousal: number; dominance: number } | null
    contextTags: string[]
    motionPlan?: MotionPlan | null
    segments?: Array<Record<string, unknown>>
  }
  'character.expression': { name: string; intensity: number; controller: string; priority: number }
  'character.motion': { name: string; controller: string; priority: number; loop: boolean }
  'character.component': {
    name: string
    enabled: boolean
    displayName: string
    controller: string
    priority: number
    expression: string
    paramIds: string[]
  }
  'character.snapshot': {
    components: Record<string, boolean>
    expression: string
    expressionIntensity: number
    motion: string
  }
  'character.suggestion': {
    suggestionId: string
    target: string
    name: string
    action: string
    reason: string
  }
  'character.control.requested': { action: string; params: JsonObject; requestId: string }
  'character.suggestion.accepted': { suggestionId: string }
  'character.suggestion.rejected': { suggestionId: string; reason: string }
  'tts.started': { format: string; audioSequence: number }
  'tts.audio': { data: string; format: string; audioSequence: number; volumes: number[] }
  'tts.completed': { reason: string }
  'tts.failed': FailurePayload
  'tts.cancelled': CancelledPayload
  'tool.requested': { requestId: string; tool: string; args: JsonObject; risk: string }
  'tool.started': { requestId: string; tool: string }
  'tool.result': { requestId: string; tool: string; result: JsonObject }
  'tool.failed': { requestId: string; tool: string; code: string; message: string }
  'management.requested': { requestId: string; action: string; params: JsonObject }
  'management.result': { requestId: string; action: string; data: JsonObject }
  'management.failed': { requestId: string; action: string; code: string; message: string }
  'telemetry.batch': { events: Array<{ name: string; timestamp: number; data: JsonObject }> }
}

export type RuntimeEventEnvelope<K extends EventType = EventType> = {
  protocolVersion: '3.0'
  eventId: string
  eventType: K
  sessionId: string
  turnId: string | null
  sequence: number
  source: EventSource
  timestamp: number
  payload: EventPayloadMap[K]
}

export type RuntimeEvent = {
  [K in EventType]: RuntimeEventEnvelope<K>
}[EventType]
