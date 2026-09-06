import assert from 'node:assert/strict'
import test from 'node:test'
import { IdleBehaviorController } from './IdleBehaviorController.ts'

test('long calm idle drifts into drowsiness then sleep, and wakes on interruption', () => {
  const idle = new IdleBehaviorController()
  idle.configureSleep(2, 3) // 测试用短阈值：2s 起困，3s 入睡
  const focus = { head: 0, body: 0, gaze: 0 }

  let asleepEyeClose = 0
  for (let i = 0; i < 80; i++) {
    idle.update(0.1, true, focus)
    asleepEyeClose = idle.getSnapshot().eyeClose
  }
  // 8s calm with a 3s asleep threshold: sleepAmount ~0.83 → eyelids near shut
  assert.ok(idle.getSnapshot().sleepAmount > 0.8, `sleepAmount ${idle.getSnapshot().sleepAmount}`)
  assert.ok(asleepEyeClose > 0.7, `asleep eyeClose ${asleepEyeClose}`)
  // head settles to one side while dozing
  assert.ok(Math.abs(idle.getSnapshot().headZ) > 2, `sleep head settle ${idle.getSnapshot().headZ}`)

  // interruption (speech/interaction closes the idle gate) wakes her quickly
  for (let i = 0; i < 40; i++) idle.update(0.1, false, focus)
  assert.ok(
    idle.getSnapshot().sleepAmount < 0.2,
    `sleepAmount after wake ${idle.getSnapshot().sleepAmount}`,
  )
})

test('idle never produces a forward body pitch (no 大前倾)', () => {
  const idle = new IdleBehaviorController()
  const focus = { head: 0, body: 0, gaze: 0 }
  let minY = 0
  // 120s of idle: below the default drowsy threshold, awake the whole time
  for (let i = 0; i < 1200; i++) {
    idle.update(0.1, true, focus)
    minY = Math.min(minY, idle.getSnapshot().bodyY)
  }
  assert.ok(
    minY > -0.9,
    `idle bodyY drifted to ${minY} — forward slouch is banned in idle`,
  )
})

test('autonomous gaze episodes do not block drowsiness (F1 regression)', () => {
  // F1: the autonomous attention layer raises focusWeights during idle —
  // the sleep gate must read USER-driven focus, so her own glances never
  // reset the drowsiness clock.
  const idle = new IdleBehaviorController()
  idle.configureSleep(2, 3)
  const autonomousFocus = { head: 0.5, body: 0, gaze: 0.4 }
  const userDrivenFocus = { head: 0, body: 0, gaze: 0 }
  for (let i = 0; i < 80; i++) idle.update(0.1, true, autonomousFocus, userDrivenFocus)
  assert.ok(idle.getSnapshot().sleepAmount > 0.8,
    `sleep blocked by autonomous focus: ${idle.getSnapshot().sleepAmount}`)

  // user-driven focus (mouse/interaction) still blocks sleep immediately
  const awake = new IdleBehaviorController()
  awake.configureSleep(2, 3)
  const userPresent = { head: 0.6, body: 0.2, gaze: 0.6 }
  for (let i = 0; i < 40; i++) awake.update(0.1, true, userPresent, userPresent)
  assert.equal(awake.getSnapshot().sleepAmount, 0,
    `sleep accumulated under user-driven focus: ${awake.getSnapshot().sleepAmount}`)
})
