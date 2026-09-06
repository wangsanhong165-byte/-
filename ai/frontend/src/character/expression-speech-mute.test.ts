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

test('pout has its own face: 鼓嘴+轻生气眉, never the full angry face', () => {
  const pout = getExpression('pout')
  const angry = getExpression('angry')
  // The separation lock: pout must be visibly lighter than angry — lighter
  // brows (0.45 vs 1.0) and NO face-darkening (Param39) — while keeping the
  // pouty mouth (Param216 鼓嘴).
  const poutBrow = pout.params.find(param => param.id === 'Param212')?.value ?? 0
  const angryBrow = 1 // the model 生气表情 sets Param212=1
  const poutMouth = pout.params.find(param => param.id === 'Param216')?.value ?? 0
  const poutDarkening = pout.params.find(param => param.id === 'Param39')
  assert.ok(poutMouth >= 0.9, `pout must keep the pouty mouth (Param216=${poutMouth})`)
  assert.ok(poutBrow < angryBrow, `pout brow must be lighter than angry (${poutBrow} vs ${angryBrow})`)
  assert.equal(poutDarkening, undefined, 'pout must not darken the face (Param39)')
  assert.notEqual(
    pout.params.map(param => param.id).sort().join(','),
    angry.params.map(param => param.id).sort().join(','),
    'pout and angry must not be the same parameter set',
  )
})
