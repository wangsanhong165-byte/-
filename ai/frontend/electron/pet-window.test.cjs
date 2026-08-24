const assert = require('node:assert/strict')
const test = require('node:test')

const {
  DEFAULT_CONVERSATION_SIZE,
  DEFAULT_MODEL_SIZE,
  fitBoundsToWorkArea,
  getPetBounds,
  getPetConversationBounds,
  selectRestorableBounds,
} = require('./pet-window.cjs')

test('pet model is a compact lower-right surface instead of a display overlay', () => {
  assert.deepEqual(
    getPetBounds({ x: 0, y: 0, width: 1920, height: 1080 }),
    { x: 1476, y: 436, ...DEFAULT_MODEL_SIZE },
  )
})

test('pet conversation is a small optional lower-left popup', () => {
  const bounds = getPetConversationBounds({ x: 0, y: 0, width: 1920, height: 1080 })

  assert.deepEqual(DEFAULT_CONVERSATION_SIZE, { width: 360, height: 176 })
  assert.deepEqual(bounds, { x: 32, y: 872, ...DEFAULT_CONVERSATION_SIZE })
})

test('compact surfaces stay fitted inside a tiny offset work area', () => {
  const area = { x: 100, y: 50, width: 300, height: 400 }
  const model = getPetBounds(area)
  const conversation = getPetConversationBounds(area)

  assert.deepEqual(model, area)
  assert.deepEqual(conversation, { x: 100, y: 242, width: 300, height: 176 })
})

test('normal bounds are fitted back onto the current display', () => {
  assert.deepEqual(
    fitBoundsToWorkArea(
      { x: 2400, y: -300, width: 1200, height: 800 },
      { x: 0, y: 0, width: 1920, height: 1040 },
    ),
    { x: 720, y: 0, width: 1200, height: 800 },
  )
})

test('maximized windows preserve their pre-maximize normal bounds', () => {
  assert.deepEqual(
    selectRestorableBounds({
      current: { x: 0, y: 0, width: 1920, height: 1080 },
      normal: { x: 220, y: 140, width: 1200, height: 800 },
      maximized: true,
      fullScreen: false,
    }),
    { x: 220, y: 140, width: 1200, height: 800 },
  )
})
