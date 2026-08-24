import assert from 'node:assert/strict'
import test from 'node:test'

import { AudioPlaybackQueue, AudioPlayer } from './player.ts'

test('audio queue emits contiguous sequence order for the active turn', () => {
  const queue = new AudioPlaybackQueue()
  queue.beginTurn('turn-1', 0)

  assert.equal(queue.push({ audio: 'two', format: 'wav', turnId: 'turn-1', sequence: 2 }), true)
  assert.deepEqual(queue.drainReady(), [])
  assert.equal(queue.push({ audio: 'zero', format: 'wav', turnId: 'turn-1', sequence: 0 }), true)
  assert.deepEqual(queue.drainReady().map(item => item.sequence), [0])
  assert.equal(queue.push({ audio: 'one', format: 'wav', turnId: 'turn-1', sequence: 1 }), true)
  assert.deepEqual(queue.drainReady().map(item => item.sequence), [1, 2])
})

test('audio queue rejects stale and duplicate turn audio', () => {
  const queue = new AudioPlaybackQueue()
  queue.beginTurn('turn-new', 4)

  assert.equal(queue.push({ audio: 'stale', format: 'wav', turnId: 'turn-old', sequence: 4 }), false)
  assert.equal(queue.push({ audio: 'current', format: 'wav', turnId: 'turn-new', sequence: 4 }), true)
  assert.equal(queue.push({ audio: 'duplicate', format: 'wav', turnId: 'turn-new', sequence: 4 }), false)
  assert.deepEqual(queue.drainReady().map(item => item.audio), ['current'])
})

test('stopping one turn does not cancel a newer owner', () => {
  const queue = new AudioPlaybackQueue()
  queue.beginTurn('turn-new', 0)

  assert.equal(queue.stopTurn('turn-old'), false)
  assert.equal(queue.activeTurnId, 'turn-new')
  assert.equal(queue.stopTurn('turn-new'), true)
  assert.equal(queue.activeTurnId, null)
})

test('volume sampling reuses its analyser buffer across animation frames', () => {
  const player = new AudioPlayer()
  const sampledBuffers: Uint8Array[] = []
  const analyser = {
    frequencyBinCount: 4,
    getByteTimeDomainData(buffer: Uint8Array) {
      sampledBuffers.push(buffer)
      buffer.set([128, 144, 128, 112])
    },
  }

  Object.assign(player, { analyserNode: analyser, _isPlaying: true })

  assert.equal(player.getCurrentVolume(), 0.0625)
  assert.equal(player.getCurrentVolume(), 0.0625)
  assert.equal(sampledBuffers.length, 2)
  assert.strictEqual(sampledBuffers[0], sampledBuffers[1])
})
