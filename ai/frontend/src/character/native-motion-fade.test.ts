import test from 'node:test'
import assert from 'node:assert/strict'
import { MotionArbiter } from './MotionArbiter.ts'
import { NativeMotionPlayer } from './live2d/NativeMotionPlayer.ts'

const idleJson = {
  Meta: { Duration: 4, Loop: true },
  FadeInTime: 0.2,
  FadeOutTime: 0.35,
  Curves: [{ Target: 'Parameter', Id: 'ParamAngleX', Segments: [0, 0, 4, 12] }],
}

test('native idle cancellation glides out instead of snapping', () => {
  const player = new NativeMotionPlayer()
  player.register('idle', idleJson, ['native:idle'])
  const arbiter = new MotionArbiter()
  arbiter.setNativeMotionPlayer(player, { idle: 'idle' }, { idle: ['head'] })
  assert.equal(arbiter.request({
    name: 'idle', owner: 'idle:native', source: 'idle', priority: 10,
  }), true)

  // Advance past fade-in into steady playback.
  for (let i = 0; i < 30; i += 1) {
    arbiter.update(1 / 60)
    arbiter.drainNativeContributions()
  }

  assert.equal(arbiter.cancelOwner('idle:native', 300), true)
  const fadeWeights: number[] = []
  let settled = false
  for (let i = 0; i < 90 && !settled; i += 1) {
    arbiter.update(1 / 60)
    for (const contribution of arbiter.drainNativeContributions()) {
      if (contribution.target === 'parameter') fadeWeights.push(contribution.weight)
    }
    settled = !arbiter.isPlaying()
  }

  assert.equal(settled, true)
  assert.ok(fadeWeights.length >= 10, `fade should span multiple frames, got ${fadeWeights.length}`)
  assert.ok(fadeWeights[0] > 0.5, `fade should start near full strength, got ${fadeWeights[0]}`)
  assert.ok(fadeWeights[fadeWeights.length - 1] < 0.2, 'fade should end near zero')
  arbiter.update(1 / 60)
  assert.deepEqual(arbiter.drainNativeContributions(), [])
})
