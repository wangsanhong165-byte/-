import { eventBus } from '../core/event-bus.ts'
import { CommandBroker } from '../session/command-broker.ts'
import {
  RuntimeClient,
  type AvatarOutboundEvent,
} from './client.ts'
import type {
  EventPayloadMap,
  EventType,
  RuntimeEvent,
} from './event-types.ts'

export class RuntimeEventAdapter {
  private activeTurnId: string | null = null
  private closedTurnIds = new Set<string>()
  private closedTurnOrder: string[] = []
  private platformSequence = 0

  dispatchLifecycleSnapshot(snapshot: {
    availability?: string
    services?: Array<Record<string, unknown>>
  }): void {
    const services = snapshot.services ?? []
    for (const service of services) {
      const rawState = String(service.status ?? 'stopped').toLowerCase()
      const state = (
        ['starting', 'ready', 'degraded', 'failed', 'stopped'].includes(rawState)
          ? rawState
          : ['running', 'healthy', 'ok'].includes(rawState)
            ? 'ready'
            : 'degraded'
      ) as EventPayloadMap['service.status']['state']
      this.dispatch(this.platformEvent('service.status', {
        service: String(service.name ?? ''),
        state,
        detail: String(service.lastHealthError ?? ''),
      }))
    }
    const readyServices = services
      .filter(service => ['running', 'healthy', 'ok', 'ready'].includes(
        String(service.status ?? '').toLowerCase(),
      ))
      .map(service => String(service.name ?? ''))
    const availability = String(snapshot.availability ?? '').toUpperCase()
    if (['READY', 'TEXT_READY', 'FULL_READY'].includes(availability)) {
      this.dispatch(this.platformEvent('runtime.ready', { services: readyServices }))
    } else {
      this.dispatch(this.platformEvent('runtime.degraded', {
        services: readyServices,
        reason: String(snapshot.availability ?? 'degraded'),
      }))
    }
  }

  private platformEvent<K extends EventType>(
    eventType: K,
    payload: EventPayloadMap[K],
  ): RuntimeEvent {
    this.platformSequence += 1
    return {
      protocolVersion: '3.0',
      eventId: `platform_${crypto.randomUUID()}`,
      eventType,
      sessionId: 'desktop-lifecycle',
      turnId: null,
      sequence: this.platformSequence,
      source: 'platform',
      timestamp: Date.now() / 1000,
      payload,
    } as RuntimeEvent
  }

  dispatch(event: RuntimeEvent): void {
    const turnId = event.turnId
    if (turnId && event.eventType !== 'turn.started') {
      if (this.closedTurnIds.has(turnId)) return
      if (this.activeTurnId && this.activeTurnId !== turnId) {
        eventBus.emit('character:runtime-telemetry', {
          type: 'runtime.stale-event-rejected',
          turnId,
          metadata: { currentTurnId: this.activeTurnId, eventType: event.eventType },
        })
        return
      }
    }

    switch (event.eventType) {
      case 'session.opened':
        eventBus.emit('connection:change', { connected: true })
        eventBus.emit('runtime:session', {
          status: 'opened',
          config: event.payload.config,
        })
        return
      case 'session.closed':
        eventBus.emit('connection:change', { connected: false })
        return
      case 'runtime.status':
        eventBus.emit('runtime:status', {
          status: event.payload.state,
          message: event.payload.message,
        })
        return
      case 'runtime.ready':
        eventBus.emit('runtime:status', {
          status: 'ready',
          message: event.payload.services.join(', '),
        })
        return
      case 'runtime.degraded':
        eventBus.emit('runtime:status', {
          status: 'degraded',
          message: event.payload.reason,
        })
        return
      case 'service.status':
        eventBus.emit('runtime:service.status', event.payload)
        return
      case 'configuration.updated':
        eventBus.emit('runtime:configuration.updated', { config: event.payload.config })
        return
      case 'protocol.error':
        eventBus.emit('runtime:error', {
          code: event.payload.code,
          message: event.payload.message,
          requestId: event.payload.requestId ?? undefined,
        })
        return

      case 'turn.started':
        if (this.closedTurnIds.has(event.turnId!)) return
        if (this.activeTurnId && this.activeTurnId !== event.turnId) {
          eventBus.emit('audio:stop', {
            turnId: this.activeTurnId,
            reason: 'superseded',
          })
        }
        this.activeTurnId = event.turnId!
        eventBus.emit('runtime:turn.started', {
          turnId: event.turnId!,
          inputMode: event.payload.inputMode,
          origin: event.payload.origin,
        })
        return
      case 'turn.progress':
        eventBus.emit('runtime:status', {
          status: event.payload.stage,
          message: event.payload.message,
        })
        return
      case 'turn.completed':
        eventBus.emit('runtime:turn.completed', {
          turnId: event.turnId!,
          reason: event.payload.reason,
        })
        this.closeTurn(event.turnId!)
        return
      case 'turn.failed':
        eventBus.emit('runtime:turn.failed', {
          turnId: event.turnId!,
          code: event.payload.code,
          message: event.payload.message,
        })
        eventBus.emit('runtime:error', event.payload)
        this.closeTurn(event.turnId!)
        return
      case 'turn.cancelled':
        eventBus.emit('audio:stop', {
          turnId: event.turnId!,
          reason: event.payload.reason,
        })
        eventBus.emit('runtime:turn.cancelled', {
          turnId: event.turnId!,
          reason: event.payload.reason,
        })
        this.closeTurn(event.turnId!)
        return

      case 'asr.result':
        eventBus.emit('runtime:asr.result', {
          turnId: event.turnId!,
          text: event.payload.text,
        })
        return
      case 'asr.failed':
      case 'assistant.failed':
        eventBus.emit('runtime:error', event.payload)
        return
      case 'assistant.text.started':
        return
      case 'assistant.text.chunk':
        eventBus.emit('runtime:chunk', {
          text: event.payload.text,
          delta: event.payload.delta,
        })
        return
      case 'assistant.text.completed':
        eventBus.emit('runtime:message', {
          text: event.payload.text,
          reasoning: event.payload.reasoning,
          segments: event.payload.segments,
        })
        return

      case 'tts.started':
        eventBus.emit('runtime:tts.started', {
          turnId: event.turnId!,
          format: event.payload.format,
          sequence: event.payload.audioSequence,
        })
        return
      case 'tts.audio':
        eventBus.emit('audio:play', {
          audio: event.payload.data,
          format: event.payload.format,
          turnId: event.turnId!,
          sequence: event.payload.audioSequence,
          volumeArray: event.payload.volumes,
        })
        return
      case 'tts.completed':
        eventBus.emit('runtime:tts.completed', {
          turnId: event.turnId!,
          reason: event.payload.reason,
        })
        return
      case 'tts.failed':
        eventBus.emit('runtime:error', event.payload)
        return
      case 'tts.cancelled':
        eventBus.emit('audio:stop', {
          turnId: event.turnId!,
          reason: event.payload.reason,
        })
        return

      case 'character.intent':
        eventBus.emit('runtime:character.intent', {
          turnId: event.turnId!,
          emotion: event.payload.emotion,
          leak: event.payload.leak ?? undefined,
          behavior: event.payload.behavior,
          attention: event.payload.attention,
          energy: event.payload.energy,
          intensity: event.payload.intensity,
          durationMs: event.payload.durationMs ?? undefined,
          naturalVAD: event.payload.naturalVAD ?? undefined,
          contextTags: event.payload.contextTags,
          motionPlan: event.payload.motionPlan ?? undefined,
          segments: event.payload.segments,
        })
        return
      case 'character.expression':
        eventBus.emit('avatar:expression_update', event.payload)
        return
      case 'character.motion':
        eventBus.emit('avatar:motion_update', event.payload)
        return
      case 'character.component':
        eventBus.emit('avatar:component_update', event.payload)
        return
      case 'character.snapshot':
        eventBus.emit('avatar:state_restored', {
          components: event.payload.components,
          expression: event.payload.expression,
          intensity: event.payload.expressionIntensity,
          motion: event.payload.motion,
        })
        return
      case 'character.suggestion':
        eventBus.emit('avatar:suggestion', event.payload)
        return

      case 'tool.requested':
        eventBus.emit('runtime:permission.requested', {
          turnId: event.turnId!,
          requestId: event.payload.requestId,
          capability: event.payload.tool,
          args: event.payload.args,
          risk: event.payload.risk,
        })
        return
      case 'tool.failed':
        eventBus.emit('runtime:error', {
          code: event.payload.code,
          message: event.payload.message,
          requestId: event.payload.requestId,
        })
        return
      case 'management.result':
        eventBus.emit('runtime:management.result', event.payload)
        return
      case 'management.failed':
        eventBus.emit('runtime:management.failed', event.payload)
        eventBus.emit('runtime:error', {
          code: event.payload.code,
          message: event.payload.message,
          requestId: event.payload.requestId,
        })
        return
      case 'telemetry.batch':
        eventBus.emit('runtime:telemetry.batch', {
          events: event.payload.events,
        })
        return
      default:
        return
    }
  }

  private closeTurn(turnId: string): void {
    if (this.activeTurnId === turnId) this.activeTurnId = null
    this.closedTurnIds.add(turnId)
    this.closedTurnOrder.push(turnId)
    while (this.closedTurnOrder.length > 128) {
      const expired = this.closedTurnOrder.shift()
      if (expired) this.closedTurnIds.delete(expired)
    }
  }
}

export class RuntimeAdapter {
  private readonly client: RuntimeClient
  private readonly eventAdapter = new RuntimeEventAdapter()
  private readonly broker: CommandBroker
  private _connected = false
  private unsubscribers: Array<() => void>

  constructor(url: string) {
    this.client = new RuntimeClient(url, {
      onEvent: event => this.eventAdapter.dispatch(event),
      onConnectionChange: connected => {
        this._connected = connected
        eventBus.emit('connection:change', { connected })
      },
      onProtocolError: error => eventBus.emit('runtime:error', error),
      onAudioTurnStale: turnId => eventBus.emit('audio:turn-stale', { turnId }),
    })
    this.broker = new CommandBroker(message =>
      this.client.sendCommand(message.action, message.params, message.requestId))
    this.unsubscribers = [
      eventBus.on('runtime:management.result', event => {
        this.broker.resolve(event.requestId, event.data)
      }),
      eventBus.on('runtime:management.failed', event => {
        this.broker.reject(
          event.requestId,
          new Error(`${event.code}: ${event.message}`),
        )
      }),
      eventBus.on('connection:change', ({ connected }) => {
        this._connected = connected
        if (!connected) this.broker.dispose(new Error('runtime disconnected'))
      }),
      eventBus.on('avatar:send', event => {
        this.client.sendAvatarEvent(event as AvatarOutboundEvent)
      }),
    ]
    const unsubscribeLifecycle = typeof window !== 'undefined'
      ? window.electronAPI?.onLifecycleSnapshot?.(snapshot => {
          this.eventAdapter.dispatchLifecycleSnapshot(snapshot)
        })
      : undefined
    if (unsubscribeLifecycle) this.unsubscribers.push(unsubscribeLifecycle)
  }

  get connected(): boolean {
    return this._connected
  }

  connect(): void {
    this._connected = false
    this.client.connect()
  }

  disconnect(): void {
    this.client.disconnect()
    this.broker.dispose()
    this.unsubscribers.splice(0).forEach(unsubscribe => unsubscribe())
    this._connected = false
  }

  sendText(text: string): boolean {
    return this.client.sendText(text)
  }

  sendVisual(text: string, attachments: EventPayloadMap['user.visual']['attachments']): boolean {
    return this.client.sendVisual(text, attachments)
  }

  sendInterrupt(): void {
    this.client.sendInterrupt()
  }

  sendAudioSamples(samples: Float32Array, sampleRate: number): void {
    this.client.sendAudioSamples(samples, sampleRate)
  }

  sendAudioEnd(attachments: EventPayloadMap['user.audio.completed']['attachments'] = []): void {
    this.client.sendAudioEnd(attachments)
  }

  sendCommand(action: string, params: Record<string, unknown> = {}): void {
    this.client.sendCommand(action, params)
  }

  requestCommand(
    action: string,
    params: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    return this.broker.request(action, params)
  }
}
