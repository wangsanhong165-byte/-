import assert from 'node:assert/strict'
import test from 'node:test'

import { eventBus } from '../core/event-bus.ts'
import { RuntimeEventAdapter } from './adapter.ts'
import type { EventPayloadMap, EventType, RuntimeEvent } from './event-types.ts'

let sequence = 0
function runtimeEvent<K extends EventType>(
  eventType: K,
  payload: EventPayloadMap[K],
  turnId: string | null,
): RuntimeEvent {
  sequence += 1
  return {
    protocolVersion: '3.0',
    eventId: `event-${sequence}`,
    eventType,
    sessionId: 'session-1',
    turnId,
    sequence,
    source: 'runtime',
    timestamp: 1,
    payload,
  } as RuntimeEvent
}

test('adapter routes V3 turn, character and audio events without V2 payload recovery', () => {
  const adapter = new RuntimeEventAdapter()
  const received: string[] = []
  let receivedIntent: { intensity: number; energy: number; attention: string } | null = null
  let audioOwner: { turnId: string; sequence: number } | null = null
  const unsubs = [
    eventBus.on('runtime:turn.started', () => received.push('turn')),
    eventBus.on('runtime:character.intent', (intent) => {
      received.push('intent')
      receivedIntent = {
        intensity: intent.intensity,
        energy: intent.energy,
        attention: intent.attention,
      }
    }),
    eventBus.on('audio:play', ({ turnId, sequence }) => {
      received.push('audio')
      audioOwner = { turnId, sequence }
    }),
  ]

  adapter.dispatch(runtimeEvent(
    'turn.started',
    { origin: 'user', inputMode: 'text' },
    'turn-1',
  ))
  adapter.dispatch(runtimeEvent(
    'character.intent',
    {
      emotion: 'happy',
      behavior: 'greet',
      attention: 'user',
      intensity: 0.65,
      energy: 0.8,
      durationMs: null,
      naturalVAD: null,
      contextTags: [],
    },
    'turn-1',
  ))
  adapter.dispatch(runtimeEvent(
    'tts.audio',
    { data: 'AAAA', format: 'wav', audioSequence: 0, volumes: [] },
    'turn-1',
  ))

  assert.deepEqual(received, ['turn', 'intent', 'audio'])
  assert.deepEqual(receivedIntent, { intensity: 0.65, energy: 0.8, attention: 'user' })
  assert.deepEqual(audioOwner, { turnId: 'turn-1', sequence: 0 })
  unsubs.forEach(unsub => unsub())
})

test('adapter rejects stale assistant, character and audio events after a new turn starts', () => {
  const adapter = new RuntimeEventAdapter()
  const received: string[] = []
  const unsubs = [
    eventBus.on('runtime:message', () => received.push('message')),
    eventBus.on('runtime:character.intent', () => received.push('intent')),
    eventBus.on('audio:play', () => received.push('audio')),
  ]

  adapter.dispatch(runtimeEvent(
    'turn.started',
    { origin: 'user', inputMode: 'text' },
    'turn-new',
  ))
  adapter.dispatch(runtimeEvent(
    'assistant.text.completed',
    { text: 'stale', reasoning: '', segments: [] },
    'turn-old',
  ))
  adapter.dispatch(runtimeEvent(
    'character.intent',
    {
      emotion: 'sad',
      behavior: 'idle',
      attention: 'user',
      intensity: 0.4,
      energy: 0.2,
      durationMs: null,
      naturalVAD: null,
      contextTags: [],
    },
    'turn-old',
  ))
  adapter.dispatch(runtimeEvent(
    'tts.audio',
    { data: 'AAAA', format: 'wav', audioSequence: 0, volumes: [] },
    'turn-old',
  ))

  assert.deepEqual(received, [])
  unsubs.forEach(unsub => unsub())
})

test('cancel stops current audio generation', () => {
  const adapter = new RuntimeEventAdapter()
  let stops = 0
  let stoppedTurn = ''
  const unsub = eventBus.on('audio:stop', ({ turnId }) => {
    stops += 1
    stoppedTurn = turnId ?? ''
  })
  adapter.dispatch(runtimeEvent(
    'turn.started',
    { origin: 'user', inputMode: 'text' },
    'turn-1',
  ))
  adapter.dispatch(runtimeEvent('tts.cancelled', { reason: 'interrupted' }, 'turn-1'))
  assert.equal(stops, 1)
  assert.equal(stoppedTurn, 'turn-1')
  unsub()
})

test('lifecycle text and full readiness are exposed as runtime ready', () => {
  const adapter = new RuntimeEventAdapter()
  const statuses: string[] = []
  const unsub = eventBus.on('runtime:status', ({ status }) => statuses.push(status))

  adapter.dispatchLifecycleSnapshot({ availability: 'TEXT_READY' })
  adapter.dispatchLifecycleSnapshot({ availability: 'FULL_READY' })
  adapter.dispatchLifecycleSnapshot({ availability: 'VOICE_READY' })

  assert.deepEqual(statuses, ['ready', 'ready', 'degraded'])
  unsub()
})
