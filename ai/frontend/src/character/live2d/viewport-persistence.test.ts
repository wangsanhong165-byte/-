import assert from 'node:assert/strict'
import test from 'node:test'
import {
  getViewportStorageKey,
  readPersistedViewport,
  savePersistedViewport,
} from './viewport-persistence.ts'

function createStorage(): { values: Record<string, string>; getItem: (key: string) => string | null; setItem: (key: string, value: string) => void } {
  const values: Record<string, string> = {}
  return {
    values,
    getItem: (key) => values[key] ?? null,
    setItem: (key, value) => { values[key] = value },
  }
}

test('persists viewport transforms under a model-specific key', () => {
  const storage = createStorage()

  savePersistedViewport(storage, 'model-a', { x: 0.25, y: -0.4, scale: 1.35 })

  assert.equal(getViewportStorageKey('model-a'), 'live2d_viewport_model-a')
  assert.deepEqual(readPersistedViewport(storage, 'model-a'), {
    x: 0.25,
    y: -0.4,
    scale: 1.35,
  })
  assert.equal(readPersistedViewport(storage, 'model-b'), undefined)
})

test('normalizes out-of-range persisted values', () => {
  const storage = createStorage()
  storage.setItem(
    getViewportStorageKey('model-a'),
    JSON.stringify({ x: 9, y: -9, scale: 9 }),
  )

  assert.deepEqual(readPersistedViewport(storage, 'model-a'), {
    x: 1.5,
    y: -1.5,
    scale: 2.5,
  })
})

test('ignores malformed or non-finite persisted values', () => {
  const storage = createStorage()
  storage.setItem(getViewportStorageKey('model-a'), '{not-json')
  assert.equal(readPersistedViewport(storage, 'model-a'), undefined)

  storage.setItem(
    getViewportStorageKey('model-b'),
    JSON.stringify({ x: 'right', y: null, scale: Infinity }),
  )
  assert.equal(readPersistedViewport(storage, 'model-b'), undefined)
})

test('keeps stage and pet viewport transforms in separate namespaces', () => {
  const storage = createStorage()

  savePersistedViewport(storage, 'shirone', { x: 0.2, y: -0.1, scale: 1.25 }, 'stage')
  savePersistedViewport(storage, 'shirone', { x: 0, y: 0.15, scale: 0.72 }, 'pet')

  assert.equal(getViewportStorageKey('shirone', 'stage'), 'live2d_viewport_shirone')
  assert.equal(getViewportStorageKey('shirone', 'pet'), 'live2d_viewport_pet_shirone')
  assert.deepEqual(readPersistedViewport(storage, 'shirone', 'stage'), { x: 0.2, y: -0.1, scale: 1.25 })
  assert.deepEqual(readPersistedViewport(storage, 'shirone', 'pet'), { x: 0, y: 0.15, scale: 0.72 })
})
