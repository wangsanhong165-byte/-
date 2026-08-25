import {
  EVENT_TYPES,
  type EventSource,
  type EventType,
  type RuntimeEvent,
} from './event-types.ts'
import { validateVersion } from './envelope.ts'

export { EVENT_TYPES }

type FieldKind = 'string' | 'number' | 'boolean' | 'array' | 'object'
type PayloadRule = {
  required: Readonly<Record<string, FieldKind>>
  optional?: Readonly<Record<string, FieldKind>>
}

const failure = { required: { code: 'string', message: 'string' } } as const
const cancelled = { required: {}, optional: { reason: 'string' } } as const

const EVENT_RULES: Record<EventType, PayloadRule> = {
  'session.open': { required: {}, optional: { capabilities: 'array' } },
  'session.opened': { required: {}, optional: { capabilities: 'array', config: 'object' } },
  'session.closed': { required: { reason: 'string' } },
  'session.ping': { required: {}, optional: { nonce: 'string' } },
  'session.pong': { required: {}, optional: { nonce: 'string' } },
  'runtime.status': { required: { state: 'string' }, optional: { message: 'string' } },
  'runtime.ready': { required: {}, optional: { services: 'array' } },
  'runtime.degraded': { required: { reason: 'string' }, optional: { services: 'array' } },
  'service.status': {
    required: { service: 'string', state: 'string' },
    optional: { detail: 'string' },
  },
  'configuration.updated': { required: { config: 'object' } },
  'protocol.error': {
    required: { code: 'string', message: 'string' },
    optional: { requestId: 'string', offendingEventId: 'string' },
  },
  'user.text': { required: { text: 'string' } },
  'user.visual': { required: { attachments: 'array' }, optional: { text: 'string' } },
  'user.audio.started': {
    required: { sampleRate: 'number' },
    optional: { channels: 'number', format: 'string' },
  },
  'user.audio.chunk': { required: { samples: 'array' } },
  'user.audio.completed': { required: {}, optional: { sampleRate: 'number' } },
  'user.audio.cancelled': cancelled,
  'turn.started': { required: {}, optional: { origin: 'string', inputMode: 'string' } },
  'turn.progress': { required: { stage: 'string' }, optional: { message: 'string' } },
  'turn.completed': { required: {}, optional: { reason: 'string' } },
  'turn.failed': failure,
  'turn.cancelled': cancelled,
  'asr.started': { required: {}, optional: { language: 'string' } },
  'asr.result': {
    required: { text: 'string' },
    optional: { confidence: 'number', language: 'string' },
  },
  'asr.failed': failure,
  'assistant.text.started': { required: {} },
  'assistant.text.chunk': { required: { delta: 'string', text: 'string' } },
  'assistant.text.completed': {
    required: { text: 'string' },
    optional: { reasoning: 'string', segments: 'array' },
  },
  'assistant.failed': failure,
  'character.intent': {
    required: { emotion: 'string', behavior: 'string', energy: 'number' },
    optional: {
      attention: 'string',
      intensity: 'number',
      durationMs: 'number',
      naturalVAD: 'object',
      contextTags: 'array',
      motionPlan: 'object',
      segments: 'array',
    },
  },
  'character.expression': {
    required: { name: 'string' },
    optional: { intensity: 'number', controller: 'string', priority: 'number' },
  },
  'character.motion': {
    required: { name: 'string' },
    optional: { controller: 'string', priority: 'number', loop: 'boolean' },
  },
  'character.component': {
    required: { name: 'string', enabled: 'boolean' },
    optional: {
      displayName: 'string',
      controller: 'string',
      priority: 'number',
      expression: 'string',
      paramIds: 'array',
    },
  },
  'character.snapshot': {
    required: { components: 'object' },
    optional: { expression: 'string', expressionIntensity: 'number', motion: 'string' },
  },
  'character.suggestion': {
    required: {
      suggestionId: 'string',
      target: 'string',
      name: 'string',
      action: 'string',
      reason: 'string',
    },
  },
  'character.control.requested': {
    required: { action: 'string', requestId: 'string' },
    optional: { params: 'object' },
  },
  'character.suggestion.accepted': { required: { suggestionId: 'string' } },
  'character.suggestion.rejected': {
    required: { suggestionId: 'string' },
    optional: { reason: 'string' },
  },
  'tts.started': {
    required: {},
    optional: { format: 'string', audioSequence: 'number' },
  },
  'tts.audio': {
    required: { data: 'string' },
    optional: { format: 'string', audioSequence: 'number', volumes: 'array' },
  },
  'tts.completed': { required: {}, optional: { reason: 'string' } },
  'tts.failed': failure,
  'tts.cancelled': cancelled,
  'tool.requested': {
    required: { requestId: 'string', tool: 'string', args: 'object', risk: 'string' },
  },
  'tool.started': { required: { requestId: 'string', tool: 'string' } },
  'tool.result': {
    required: { requestId: 'string', tool: 'string', result: 'object' },
  },
  'tool.failed': {
    required: { requestId: 'string', tool: 'string', code: 'string', message: 'string' },
  },
  'management.requested': {
    required: { requestId: 'string', action: 'string' },
    optional: { params: 'object' },
  },
  'management.result': {
    required: { requestId: 'string', action: 'string', data: 'object' },
  },
  'management.failed': {
    required: { requestId: 'string', action: 'string', code: 'string', message: 'string' },
  },
  'telemetry.batch': { required: { events: 'array' } },
}

const TURN_EVENTS = new Set<EventType>([
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
  'tts.started',
  'tts.audio',
  'tts.completed',
  'tts.failed',
  'tts.cancelled',
  'tool.requested',
  'tool.started',
  'tool.result',
  'tool.failed',
])

const ENVELOPE_FIELDS = new Set([
  'protocolVersion',
  'eventId',
  'eventType',
  'sessionId',
  'turnId',
  'sequence',
  'source',
  'timestamp',
  'payload',
])

const SOURCES = new Set<EventSource>(['frontend', 'runtime', 'bridge', 'lifecycle', 'platform'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function matchesKind(value: unknown, kind: FieldKind): boolean {
  if (kind === 'array') return Array.isArray(value)
  if (kind === 'object') return isRecord(value)
  return typeof value === kind
}

function validatePayload(eventType: EventType, payload: unknown): void {
  if (!isRecord(payload)) throw new Error('payload must be an object')
  const rule = EVENT_RULES[eventType]
  const allowed = new Set([...Object.keys(rule.required), ...Object.keys(rule.optional ?? {})])

  for (const [field, kind] of Object.entries(rule.required)) {
    if (!(field in payload)) throw new Error(`payload.${field} is required`)
    if (!matchesKind(payload[field], kind)) throw new Error(`payload.${field} must be ${kind}`)
  }
  for (const [field, value] of Object.entries(payload)) {
    if (!allowed.has(field)) throw new Error(`payload.${field} is unexpected`)
    const kind = rule.required[field] ?? rule.optional?.[field]
    if (value !== null && kind && !matchesKind(value, kind)) {
      throw new Error(`payload.${field} must be ${kind}`)
    }
  }
}

export function parseRuntimeEvent(raw: unknown): RuntimeEvent {
  if (!isRecord(raw)) throw new Error('event envelope must be an object')
  for (const field of ENVELOPE_FIELDS) {
    if (!(field in raw)) throw new Error(`${field} is required`)
  }
  for (const field of Object.keys(raw)) {
    if (!ENVELOPE_FIELDS.has(field)) throw new Error(`${field} is unexpected`)
  }

  validateVersion(raw.protocolVersion)
  if (typeof raw.eventId !== 'string' || !raw.eventId) throw new Error('eventId is required')
  if (typeof raw.eventType !== 'string' || !EVENT_TYPES.includes(raw.eventType as EventType)) {
    throw new Error(`Unsupported eventType: ${String(raw.eventType)}`)
  }
  const eventType = raw.eventType as EventType
  if (typeof raw.sessionId !== 'string' || !raw.sessionId) throw new Error('sessionId is required')
  if (raw.turnId !== null && typeof raw.turnId !== 'string') throw new Error('turnId must be string or null')
  if (TURN_EVENTS.has(eventType) && !raw.turnId) throw new Error(`turnId is required for ${eventType}`)
  if (!Number.isInteger(raw.sequence) || Number(raw.sequence) < 1) throw new Error('sequence must be >= 1')
  if (typeof raw.source !== 'string' || !SOURCES.has(raw.source as EventSource)) throw new Error('source is invalid')
  if (typeof raw.timestamp !== 'number' || raw.timestamp <= 0) throw new Error('timestamp must be > 0')
  validatePayload(eventType, raw.payload)

  return raw as RuntimeEvent
}
