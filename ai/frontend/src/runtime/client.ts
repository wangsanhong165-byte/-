import { createEnvelope, SequenceTracker } from './envelope.ts'
import type {
  EventPayloadMap,
  EventType,
  JsonObject,
  RuntimeEvent,
} from './event-types.ts'
import { parseRuntimeEvent } from './registry.ts'

export function runtimeWebSocketUrl(
  page: { protocol: string; host: string },
): string {
  const protocol = page.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${page.host}/client-ws`
}

export type ClientProtocolError = {
  code: string
  message: string
}

export type RuntimeClientHandlers = {
  onEvent: (event: RuntimeEvent) => void
  onConnectionChange?: (connected: boolean) => void
  onProtocolError?: (error: ClientProtocolError) => void
}

export type AvatarOutboundEvent =
  | {
      eventType: 'character.control.requested'
      payload: EventPayloadMap['character.control.requested']
    }
  | {
      eventType: 'character.suggestion.accepted'
      payload: EventPayloadMap['character.suggestion.accepted']
    }
  | {
      eventType: 'character.suggestion.rejected'
      payload: EventPayloadMap['character.suggestion.rejected']
    }

export class RuntimeClient {
  private ws: WebSocket | null = null
  private readonly url: string
  private readonly handlers: RuntimeClientHandlers
  private reconnectBaseDelay = 1000
  private reconnectMaxDelay = 30000
  private reconnectAttempts = 0
  private reconnectMaxAttempts = 20
  private reconnectLimitReported = false
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private intentionalClose = false
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private pongPending = false
  private sessionId = ''
  private sequenceTracker = new SequenceTracker()
  private sequenceCounter = 0
  private seenEventIds = new Set<string>()
  private eventIdOrder: string[] = []
  private currentTurnId: string | null = null
  private currentAudioTurnId: string | null = null

  constructor(url: string, handlers: RuntimeClientHandlers) {
    this.url = url
    this.handlers = handlers
  }

  connect(): void {
    if (this.ws?.readyState === WebSocket.OPEN) return
    this.intentionalClose = false
    this.handlers.onConnectionChange?.(false)

    try {
      this.ws = new WebSocket(this.url)
    } catch {
      this.scheduleReconnect()
      return
    }

    this.ws.onopen = () => {
      this.reconnectAttempts = 0
      this.reconnectLimitReported = false
      this.sequenceTracker.reset()
      this.sequenceCounter = 0
      this.seenEventIds.clear()
      this.eventIdOrder = []
      this.sessionId = `ses_${crypto.randomUUID()}`
      this.currentTurnId = null
      this.currentAudioTurnId = null
      this.sendEvent(
        'session.open',
        { capabilities: ['text', 'visual', 'audio', 'character', 'tts'] },
        null,
      )
      this.startPing()
    }

    this.ws.onclose = () => {
      this.handlers.onConnectionChange?.(false)
      this.stopPing()
      if (!this.intentionalClose) this.scheduleReconnect()
    }

    this.ws.onmessage = (message: MessageEvent) => {
      let raw: unknown
      try {
        raw = JSON.parse(String(message.data))
      } catch (error) {
        this.reportProtocolError('invalid_json', String(error))
        return
      }
      this.handleIncoming(raw)
    }
  }

  disconnect(): void {
    this.intentionalClose = true
    this.reconnectAttempts = this.reconnectMaxAttempts
    this.stopPing()
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.ws?.close()
    this.ws = null
    this.handlers.onConnectionChange?.(false)
  }

  handleIncoming(raw: unknown): boolean {
    let event: RuntimeEvent
    try {
      event = parseRuntimeEvent(raw)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.reportProtocolError(this.classifyParseError(message), message)
      return false
    }

    if (this.sessionId && event.sessionId !== this.sessionId) {
      this.reportProtocolError(
        'session_mismatch',
        `Expected sessionId ${this.sessionId}, got ${event.sessionId}`,
      )
      return false
    }
    if (this.seenEventIds.has(event.eventId)) {
      this.reportProtocolError('duplicate_event', `Duplicate eventId ${event.eventId}`)
      return false
    }

    const sequenceState = this.sequenceTracker.classify(
      event.sessionId,
      event.sequence,
    )
    if (sequenceState !== 'accepted') {
      this.reportProtocolError(
        sequenceState === 'gap' ? 'sequence_gap' : 'out_of_order',
        `Rejected sequence ${event.sequence} for ${event.sessionId}`,
      )
      return false
    }
    this.rememberEventId(event.eventId)

    if (event.eventType === 'session.ping') {
      this.sendEvent('session.pong', { nonce: event.payload.nonce }, null)
      return true
    }
    if (event.eventType === 'session.pong') {
      this.pongPending = false
      return true
    }
    this.handlers.onEvent(event)
    return true
  }

  private classifyParseError(message: string): string {
    if (message.includes('Unsupported protocolVersion')) {
      return 'unsupported_protocol_version'
    }
    if (message.includes('eventType')) return 'unsupported_event'
    if (message.includes('payload')) return 'invalid_payload'
    return 'invalid_envelope'
  }

  private reportProtocolError(code: string, message: string): void {
    this.handlers.onProtocolError?.({ code, message })
  }

  private rememberEventId(eventId: string): void {
    this.seenEventIds.add(eventId)
    this.eventIdOrder.push(eventId)
    while (this.eventIdOrder.length > 2048) {
      const expired = this.eventIdOrder.shift()
      if (expired) this.seenEventIds.delete(expired)
    }
  }

  private sendEvent<K extends EventType>(
    eventType: K,
    payload: EventPayloadMap[K],
    turnId: string | null,
  ): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false
    this.sequenceCounter += 1
    this.ws.send(JSON.stringify(createEnvelope(eventType, payload, {
      sessionId: this.sessionId,
      turnId,
      sequence: this.sequenceCounter,
      source: 'frontend',
    })))
    return true
  }

  sendText(text: string): boolean {
    const turnId = `turn_${crypto.randomUUID()}`
    this.currentTurnId = turnId
    return this.sendEvent('user.text', { text }, turnId)
  }

  sendVisual(text: string, attachments: EventPayloadMap['user.visual']['attachments']): boolean {
    const turnId = `turn_${crypto.randomUUID()}`
    this.currentTurnId = turnId
    return this.sendEvent('user.visual', {
      text,
      attachments: attachments.map(({ id, mimeType, width, height, sizeBytes }) => ({
        id, mimeType, width, height, sizeBytes,
      })),
    }, turnId)
  }

  sendInterrupt(): void {
    const turnId = this.currentAudioTurnId ?? this.currentTurnId
    if (!turnId) return
    this.sendEvent('turn.cancelled', { reason: 'user_interrupt' }, turnId)
  }

  sendCommand(
    action: string,
    params: Record<string, unknown> = {},
    requestId?: string,
  ): void {
    this.sendEvent('management.requested', {
      action,
      params: params as JsonObject,
      requestId: requestId ?? `request_${crypto.randomUUID()}`,
    }, null)
  }

  sendAudioSamples(samples: Float32Array, sampleRate: number): void {
    if (!this.currentAudioTurnId) {
      this.currentAudioTurnId = `turn_${crypto.randomUUID()}`
      this.currentTurnId = this.currentAudioTurnId
      this.sendEvent('user.audio.started', {
        sampleRate,
        channels: 1,
        format: 'pcm_f32',
      }, this.currentAudioTurnId)
    }
    this.sendEvent(
      'user.audio.chunk',
      { samples: Array.from(samples) },
      this.currentAudioTurnId,
    )
  }

  sendAudioEnd(): void {
    if (!this.currentAudioTurnId) return
    this.sendEvent('user.audio.completed', {}, this.currentAudioTurnId)
    this.currentAudioTurnId = null
  }

  sendAvatarEvent(event: AvatarOutboundEvent): void {
    const turnId = event.eventType === 'character.control.requested'
      ? this.currentTurnId
      : null
    this.sendEvent(event.eventType, event.payload as never, turnId)
  }

  private startPing(): void {
    this.stopPing()
    this.pongPending = false
    this.pingTimer = setInterval(() => {
      if (this.pongPending) {
        this.ws?.close()
        return
      }
      this.pongPending = true
      this.sendEvent('session.ping', { nonce: '' }, null)
    }, 30000)
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer)
      this.pingTimer = null
    }
    this.pongPending = false
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return
    if (this.reconnectAttempts >= this.reconnectMaxAttempts) {
      if (!this.reconnectLimitReported) {
        this.reconnectLimitReported = true
        this.reportProtocolError(
          'MAX_RECONNECT',
          'Fast reconnect budget exhausted; continuing slow recovery',
        )
      }
    }
    const delay = Math.min(
      this.reconnectBaseDelay * Math.pow(
        2,
        Math.min(this.reconnectAttempts, this.reconnectMaxAttempts),
      ),
      this.reconnectMaxDelay,
    )
    this.reconnectAttempts = Math.min(
      this.reconnectAttempts + 1,
      this.reconnectMaxAttempts,
    )
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, delay)
  }
}
