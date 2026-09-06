import assert from 'node:assert/strict'
import test from 'node:test'
import {
  cancelLeakArc,
  scheduleLeakArc,
  type LeakArcHooks,
} from './performance/LeakArcScheduler.ts'

interface AppliedCall {
  expression: string
  intensity: number
  blendMs: number
}

interface ScheduledCall {
  fn: () => void
  delayMs: number
  cancelled: boolean
}

function makeFakeHooks() {
  const applied: AppliedCall[] = []
  const scheduled: ScheduledCall[] = []
  const hooks: LeakArcHooks = {
    apply: (expression, intensity, blendMs) => {
      applied.push({ expression, intensity, blendMs })
    },
    schedule: (fn, delayMs) => {
      const entry: ScheduledCall = { fn, delayMs, cancelled: false }
      scheduled.push(entry)
      return entry as unknown as ReturnType<typeof setTimeout>
    },
    cancel: handle => {
      const entry = scheduled.find(call => call === (handle as unknown as ScheduledCall))
      if (entry) entry.cancelled = true
    },
  }
  return { hooks, applied, scheduled }
}

test('long segment schedules leak at 55% and surface restore at 90%', () => {
  const { hooks, applied, scheduled } = makeFakeHooks()
  const handles = scheduleLeakArc({
    surface: 'pout',
    leak: 'shy',
    surfaceIntensity: 0.8,
    durationMs: 4000,
  }, hooks)

  assert.ok(handles && handles.length === 2)
  assert.equal(scheduled[0].delayMs, Math.round(4000 * 0.55))
  assert.equal(scheduled[1].delayMs, Math.round(4000 * 0.9))

  // 泄露拍：leak 表情，强度 = max(0.3, 0.8×0.45)
  scheduled[0].fn()
  assert.equal(applied[0].expression, 'shy')
  assert.ok(Math.abs(applied[0].intensity - 0.36) < 1e-9)
  assert.equal(applied[0].blendMs, 900)

  // 收回拍：surface 回归，0.8× 强度
  scheduled[1].fn()
  assert.ok(Math.abs(applied[1].intensity - 0.64) < 1e-9, `restore intensity ${applied[1].intensity}`)
  assert.equal(applied[1].expression, 'pout')
})

test('leak intensity floors at 0.3 for low-intensity segments', () => {
  const { hooks, applied, scheduled } = makeFakeHooks()
  scheduleLeakArc({
    surface: 'pout',
    leak: 'shy',
    surfaceIntensity: 0.4,
    durationMs: 3000,
  }, hooks)
  scheduled[0].fn()
  assert.ok(applied[0].intensity >= 0.3, `floor broken: ${applied[0].intensity}`)
})

test('short segments get no arc (surface face holds)', () => {
  const { hooks, applied, scheduled } = makeFakeHooks()
  const handles = scheduleLeakArc({
    surface: 'pout',
    leak: 'shy',
    surfaceIntensity: 0.8,
    durationMs: 1800,
  }, hooks)
  assert.equal(handles, null)
  assert.equal(scheduled.length, 0)
  assert.equal(applied.length, 0)
})

test('cancel prevents the scheduled faces from firing', () => {
  const { hooks, applied, scheduled } = makeFakeHooks()
  const handles = scheduleLeakArc({
    surface: 'pout',
    leak: 'shy',
    surfaceIntensity: 0.8,
    durationMs: 4000,
  }, hooks)
  cancelLeakArc(handles, hooks)
  assert.ok(scheduled.every(call => call.cancelled))
  // 清除后的 timeout 在运行时不会触发——只有未取消的才执行
  scheduled.forEach(call => { if (!call.cancelled) call.fn() })
  assert.equal(applied.length, 0)
})
