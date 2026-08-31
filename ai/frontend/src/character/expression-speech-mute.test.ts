import assert from 'node:assert/strict'
import test from 'node:test'

import { ExpressionController } from './ExpressionController.ts'
import { ParameterController } from './ExpressionParameterController.ts'
import { getExpression } from './live2d/expression.ts'

test('speech mouth mute releases pinned params and restores the standing expression', () => {
  const paramCtrl = new ParameterController((name: string) => getExpression(name))
  const ctrl = new ExpressionController(paramCtrl)
  // Model attach: resets the standing expression so the first apply takes effect.
  ctrl.setModelConfig({}, [])
  ctrl.setEnabled(true)
  ctrl.apply('neutral', 1, 0)

  const ownedBefore = paramCtrl.getOwnedParameterIds()
  assert.ok(ownedBefore.size > 0, `standing expression should own parameters (got ${ownedBefore.size})`)

  // Speech: mouth params leave expression ownership
  ctrl.setSpeechMouthMute(true, ['mouth.open'])
  assert.ok(
    !paramCtrl.getOwnedParameterIds().has('mouth.open'),
    'mouth.open must be released during speech',
  )

  // After speech the standing expression re-applies and its other params return.
  ctrl.setSpeechMouthMute(false)
  const ownedAfter = paramCtrl.getOwnedParameterIds()
  assert.ok(ownedAfter.size > 0, 'restored expression should own parameters again')
  assert.equal(ctrl.getCurrent(), 'neutral')
})
