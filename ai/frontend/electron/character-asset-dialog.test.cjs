const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { dialogOptionsFor } = require('./character-asset-dialog.cjs')

test('uses a directory picker for Live2D and constrained file pickers for voice assets', () => {
  assert.deepEqual(dialogOptionsFor('live2d_directory').properties, ['openDirectory'])
  assert.deepEqual(dialogOptionsFor('reference_audio').filters[0].extensions, [
    'wav', 'flac', 'mp3', 'ogg', 'm4a',
  ])
  assert.deepEqual(dialogOptionsFor('t2s_model').filters[0].extensions, ['ckpt'])
  assert.deepEqual(dialogOptionsFor('vits_model').filters[0].extensions, ['pth'])
  assert.throws(() => dialogOptionsFor('unknown'), /unsupported character asset kind/)
})

test('opens the picker in the conventional in-repo directory for each asset kind', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'char-asset-dialog-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const live2d = path.join(root, 'models', 'live2d-models')
  const model = path.join(root, 'config', 'characters', 'monika', 'model')
  fs.mkdirSync(live2d, { recursive: true })
  fs.mkdirSync(model, { recursive: true })

  assert.equal(
    dialogOptionsFor('live2d_directory', root).defaultPath,
    live2d,
  )
  assert.equal(dialogOptionsFor('reference_audio', root).defaultPath, model)
  assert.equal(dialogOptionsFor('t2s_model', root).defaultPath, model)
  assert.equal(dialogOptionsFor('vits_model', root).defaultPath, model)
})

test('omits defaultPath when the conventional directory is missing or root is unknown', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'char-asset-dialog-empty-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  assert.equal(dialogOptionsFor('live2d_directory', root).defaultPath, undefined)
  assert.equal(dialogOptionsFor('reference_audio').defaultPath, undefined)
})
