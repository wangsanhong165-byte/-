import assert from 'node:assert/strict'
import test from 'node:test'

import { RuntimeClient, runtimeWebSocketUrl } from './client.ts'
import type { RuntimeEvent } from './event-types.ts'

function envelope(overrides: Partial<RuntimeEvent> = {}): RuntimeEvent {
  return {
    protocolVersion: '3.0',
    eventId: 'event-1',
    eventType: 'runtime.status',
    sessionId: 'session-1',
    turnId: null,
    sequence: 1,
    source: 'runtime',
    timestamp: 1,
    payload: { state: 'idle', message: '' },
    ...overrides,
  } as RuntimeEvent
}

type SentFrame = { eventType: string; turnId: string | null }

class FakeSocket {
  static OPEN = 1
  readyState = FakeSocket.OPEN
  sent: string[] = []
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null

  constructor(_url: string, sockets: FakeSocket[]) {
    sockets.push(this)
  }

  send(raw: string): void {
    this.sent.push(raw)
  }

  close(): void {
    this.readyState = 3
  }
}

function installFakeWebSocket(): {
  sockets: FakeSocket[]
  framesOf: (client: RuntimeClient) => SentFrame[]
  restore: () => void
} {
  const originalWebSocket = globalThis.WebSocket
  const sockets: FakeSocket[] = []

  globalThis.WebSocket = class extends FakeSocket {
    constructor(url: string) {
      super(url, sockets)
    }
  } as unknown as typeof WebSocket
  return {
    sockets,
    framesOf(client) {
      const ws = (client as unknown as { ws: FakeSocket | null }).ws
      return (ws?.sent ?? []).map(raw => JSON.parse(raw) as SentFrame)
    },
    restore() {
      globalThis.WebSocket = originalWebSocket
    },
  }
}

test('runtime websocket follows the origin that served the desktop UI', () => {
  assert.equal(
    runtimeWebSocketUrl({ protocol: 'http:', host: '127.0.0.1:19306' }),
    'ws://127.0.0.1:19306/client-ws',
  )
  assert.equal(
    runtimeWebSocketUrl({ protocol: 'https:', host: 'localhost:19406' }),
    'wss://localhost:19406/client-ws',
  )
})

test('client accepts only validated V3 envelopes and rejects flat V2 frames', () => {
  const events: RuntimeEvent[] = []
  const errors: string[] = []
  const client = new RuntimeClient('ws://test', {
    onEvent: event => events.push(event),
    onProtocolError: error => errors.push(error.code),
  })

  assert.equal(client.handleIncoming(envelope()), true)
  assert.equal(client.handleIncoming({ type: 'runtime_status', state: 'idle' }), false)
  assert.equal(events.length, 1)
  assert.deepEqual(errors, ['invalid_envelope'])
})

test('client deduplicates eventId and rejects sequence gaps or older frames', () => {
  const events: RuntimeEvent[] = []
  const errors: string[] = []
  const client = new RuntimeClient('ws://test', {
    onEvent: event => events.push(event),
    onProtocolError: error => errors.push(error.code),
  })

  assert.equal(client.handleIncoming(envelope()), true)
  assert.equal(client.handleIncoming(envelope({ eventId: 'event-1', sequence: 2 })), false)
  assert.equal(client.handleIncoming(envelope({ eventId: 'event-3', sequence: 3 })), false)
  assert.equal(client.handleIncoming(envelope({ eventId: 'event-0', sequence: 1 })), false)
  assert.equal(events.length, 1)
  assert.deepEqual(errors, ['duplicate_event', 'sequence_gap', 'out_of_order'])
})

test('unknown versions, event names and invalid payloads surface explicit protocol errors', () => {
  const errors: string[] = []
  const client = new RuntimeClient('ws://test', {
    onEvent: () => {},
    onProtocolError: error => errors.push(error.code),
  })

  client.handleIncoming({ ...envelope(), protocolVersion: '2.0' })
  client.handleIncoming({ ...envelope(), eventType: 'assistant_message' })
  client.handleIncoming({ ...envelope(), payload: { state: 42 } })

  assert.deepEqual(errors, [
    'unsupported_protocol_version',
    'unsupported_event',
    'invalid_payload',
  ])
})

test('a new connection gets a new sessionId and restarts outbound sequence at one', () => {
  const originalWebSocket = globalThis.WebSocket
  const sockets: FakeWebSocket[] = []

  class FakeWebSocket {
    static OPEN = 1
    readyState = FakeWebSocket.OPEN
    sent: string[] = []
    onopen: (() => void) | null = null
    onclose: (() => void) | null = null
    onmessage: ((event: MessageEvent) => void) | null = null

    constructor(_url: string) {
      sockets.push(this)
    }

    send(raw: string): void {
      this.sent.push(raw)
    }

    close(): void {
      this.readyState = 3
    }
  }

  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket
  try {
    const client = new RuntimeClient('ws://test', { onEvent: () => {} })
    client.connect()
    sockets[0].onopen?.()
    const first = JSON.parse(sockets[0].sent[0])
    client.disconnect()

    client.connect()
    sockets[1].onopen?.()
    const second = JSON.parse(sockets[1].sent[0])
    client.disconnect()

    assert.notEqual(first.sessionId, second.sessionId)
    assert.equal(first.sequence, 1)
    assert.equal(second.sequence, 1)
    assert.equal(first.eventType, 'session.open')
    assert.equal(second.eventType, 'session.open')
  } finally {
    globalThis.WebSocket = originalWebSocket
  }
})

test('client keeps a capped recovery timer after the fast reconnect budget is exhausted', () => {
  const errors: string[] = []
  const client = new RuntimeClient('ws://test', {
    onEvent: () => {},
    onProtocolError: error => errors.push(error.code),
  })
  const internal = client as unknown as {
    reconnectAttempts: number
    reconnectTimer: ReturnType<typeof setTimeout> | null
    scheduleReconnect: () => void
  }
  internal.reconnectAttempts = 20

  internal.scheduleReconnect()

  assert.notEqual(internal.reconnectTimer, null)
  assert.deepEqual(errors, ['MAX_RECONNECT'])
  client.disconnect()
})

test('stale_turn rejection clears the live audio binding, suspends capture and notifies', () => {
  const fake = installFakeWebSocket()
  try {
    const staleTurns: string[] = []
    const client = new RuntimeClient('ws://test', {
      onEvent: () => {},
      onAudioTurnStale: turnId => staleTurns.push(turnId),
    })
    try {
      client.connect()
      fake.sockets[0]?.onopen?.()
      // After onopen the client owns a fresh sessionId; envelopes must carry it
      // or handleIncoming bounces them as session_mismatch.
      const sessionId = (client as unknown as { sessionId: string }).sessionId

      client.sendAudioSamples(new Float32Array(8), 16000)
      const started = fake.framesOf(client).at(-2)!
      assert.equal(started.eventType, 'user.audio.started')
      const oldId = started.turnId as string

      // The runtime must accept one normal event first so the sequence tracker
      // has a baseline before protocol.error arrives with sequence 2.
      client.handleIncoming(envelope({ sessionId }))
      client.handleIncoming(
        envelope({
          eventId: 'evt-stale-1',
          eventType: 'protocol.error',
          sessionId,
          turnId: oldId,
          sequence: 2,
          payload: {
            code: 'stale_turn',
            message: `Event belongs to inactive turn ${oldId}`,
          },
        }),
      )

      assert.deepEqual(staleTurns, [oldId])

      const framesAfterStale = fake.framesOf(client).length
      client.sendAudioSamples(new Float32Array(8), 16000)
      client.sendAudioSamples(new Float32Array(8), 16000)
      assert.equal(fake.framesOf(client).length, framesAfterStale)

      client.sendAudioEnd()
      const framesAfterEnd = fake.framesOf(client).length
      client.sendAudioSamples(new Float32Array(8), 16000)
      const frames = fake.framesOf(client)
      assert.equal(frames.length, framesAfterEnd + 2)
      assert.equal(frames.at(-2)!.eventType, 'user.audio.started')
      assert.notEqual(frames.at(-2)!.turnId, oldId)
    } finally {
      client.disconnect()
    }
  } finally {
    fake.restore()
  }
})

test('stale_turn for an unrelated turn leaves the live audio session untouched', () => {
  const fake = installFakeWebSocket()
  try {
    const staleTurns: string[] = []
    const client = new RuntimeClient('ws://test', {
      onEvent: () => {},
      onAudioTurnStale: turnId => staleTurns.push(turnId),
    })
    try {
      client.connect()
      fake.sockets[0]?.onopen?.()
      const sessionId = (client as unknown as { sessionId: string }).sessionId

      client.sendAudioSamples(new Float32Array(8), 16000)
      const started = fake.framesOf(client).at(-2)!
      const oldId = started.turnId as string

      client.handleIncoming(envelope({ sessionId }))
      client.handleIncoming(
        envelope({
          eventId: 'evt-stale-other',
          eventType: 'protocol.error',
          sessionId,
          turnId: 'turn_unrelated-0000',
          sequence: 2,
          payload: {
            code: 'stale_turn',
            message: 'Event belongs to inactive turn turn_unrelated-0000',
          },
        }),
      )

      assert.deepEqual(staleTurns, [])

      client.sendAudioSamples(new Float32Array(8), 16000)
      const last = fake.framesOf(client).at(-1)!
      assert.equal(last.eventType, 'user.audio.chunk')
      assert.equal(last.turnId, oldId)
    } finally {
      client.disconnect()
    }
  } finally {
    fake.restore()
  }
})
