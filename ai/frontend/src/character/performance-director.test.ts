import assert from 'node:assert/strict'
import test from 'node:test'

import { PerformanceDirector } from './performance/PerformanceDirector.ts'
import type { MotionPlan } from './MotionAction.ts'

const base = {
  turnId: 'turn-1',
  emotion: 'happy',
  behavior: 'speak',
  intensity: 0.55,
  attention: 'user' as const,
  energy: 0.55,
}

test('speech segments are anchored to actual playback duration', () => {
  let now = 1_000
  const director = new PerformanceDirector(() => now)
  director.stage(base, [
    { text: '短句。', emotion: 'happy', behavior: 'speak' },
    { text: '这是明显更长的第二句话，用来验证按文本权重分配真实音频时间。', emotion: 'playful', behavior: 'speak' },
  ])

  assert.deepEqual(director.update(), [], 'intent should wait briefly for real audio timing')
  director.onAudioStart('turn-1', 4_000)
  assert.equal(director.update()[0]?.emotion, 'happy')

  now += 700
  assert.deepEqual(director.update(), [])
  now += 500
  assert.equal(director.update()[0]?.emotion, 'playful')
})

test('staged speech performance does not start before decoded audio playback', () => {
  let now = 0
  const director = new PerformanceDirector(() => now, { audioWaitMs: 240 })
  director.stage(base)

  now = 5_000
  assert.deepEqual(director.update(), [])

  director.onAudioStart('turn-1', 2_000)
  assert.equal(director.update()[0]?.turnId, 'turn-1')
})

test('a newer turn cancels all pending cues from the superseded turn', () => {
  let now = 0
  const director = new PerformanceDirector(() => now)
  director.stage(base, [
    { text: 'first', emotion: 'happy', behavior: 'speak' },
    { text: 'second', emotion: 'surprised', behavior: 'speak' },
  ])
  director.onAudioStart('turn-1', 2_000)
  assert.equal(director.update().length, 1)

  director.stage({ ...base, turnId: 'turn-2', emotion: 'calm' }, [
    { text: 'replacement', emotion: 'calm', behavior: 'speak' },
  ])
  director.onAudioStart('turn-2', 800)
  assert.equal(director.update()[0]?.turnId, 'turn-2')

  now = 3_000
  assert.equal(director.update().some(cue => cue.turnId === 'turn-1'), false)
})

test('repeated LLM gestures are suppressed inside the Soullink-style repeat window', () => {
  let now = 0
  const director = new PerformanceDirector(() => now, { repeatWindowMs: 6_000 })
  const motionPlan: MotionPlan = {
    durationMs: 800,
    steps: [{ atMs: 0, durationMs: 600, primitive: 'nod', intensity: 0.6 }],
  }

  director.stage({ ...base, motionPlan })
  director.onAudioUnavailable('turn-1')
  now = 300
  const first = director.update()[0]
  assert.ok(first.motionPlan)

  now = 1_000
  director.stage({ ...base, turnId: 'turn-2', motionPlan })
  director.onAudioUnavailable('turn-2')
  now = 1_300
  const repeated = director.update()[0]
  assert.ok(repeated.motionPlan, 'a repeated LLM gesture must degrade to local choreography')
  assert.notDeepEqual(repeated.motionPlan, motionPlan)

  now = 7_100
  director.stage({ ...base, turnId: 'turn-3', motionPlan })
  director.onAudioUnavailable('turn-3')
  now = 7_400
  assert.ok(director.update()[0].motionPlan)
})

test('audio end drops future speech cues and stale audio cannot revive them', () => {
  let now = 0
  const director = new PerformanceDirector(() => now)
  director.stage(base, [
    { text: 'one', emotion: 'happy', behavior: 'speak' },
    { text: 'two', emotion: 'sad', behavior: 'speak' },
  ])
  director.onAudioStart('turn-1', 3_000)
  assert.equal(director.update().length, 1)

  director.onAudioEnd('turn-1')
  now = 4_000
  assert.deepEqual(director.update(), [])
  director.onAudioStart('turn-old', 1_000)
  assert.deepEqual(director.update(), [])
})

test('fast audio decode is retained when playback starts before intent delivery', () => {
  let now = 500
  const director = new PerformanceDirector(() => now)
  director.onAudioStart('turn-1', 2_400)
  now = 520
  director.stage(base, [
    { text: 'first', emotion: 'happy', behavior: 'speak' },
    { text: 'second sentence', emotion: 'surprised', behavior: 'speak' },
  ])

  assert.equal(director.update()[0]?.emotion, 'happy')
})

test('late audio timing does not replay a fallback cue that already fired', () => {
  let now = 0
  const director = new PerformanceDirector(() => now, { audioWaitMs: 240 })
  director.stage(base, [
    { text: 'first', emotion: 'happy', behavior: 'speak' },
    { text: 'second', emotion: 'surprised', behavior: 'speak' },
  ])
  director.onAudioUnavailable('turn-1')

  now = 260
  assert.equal(director.update()[0]?.emotion, 'happy')

  now = 400
  director.onAudioStart('turn-1', 2_000)
  assert.deepEqual(director.update(), [], 'the first semantic beat must not fire twice')

  now = 1_400
  assert.equal(director.update()[0]?.emotion, 'surprised')
})

test('speech gets duration-aware local choreography when the LLM omits motion', () => {
  let now = 0
  const director = new PerformanceDirector(() => now)
  director.stage(base)
  director.onAudioUnavailable('turn-1')
  now = 300
  const expressive = director.update()[0]

  assert.ok(expressive.motionPlan)
  assert.equal(expressive.motionPlan!.steps.length, 1)
  assert.ok(expressive.motionPlan!.steps[0].intensity <= 0.55)

  now = 1_000
  director.stage({ ...base, turnId: 'turn-neutral', emotion: 'neutral' })
  director.onAudioUnavailable('turn-neutral')
  now = 1_300
  const neutralIntent = director.update()[0]
  // Neutral speech still gets a gentle gesture so speaking never looks frozen.
  assert.ok(neutralIntent.motionPlan)
  assert.equal(neutralIntent.motionPlan!.steps.length, 1)
  assert.ok(neutralIntent.motionPlan!.steps[0].intensity <= 0.55)
})

test('ordinary decoded speech receives a second conversational beat before it becomes a monologue', () => {
  const director = new PerformanceDirector(() => 0)
  director.stage({ ...base, turnId: 'turn-medium', emotion: 'neutral' })
  director.onAudioStart('turn-medium', 2_600)

  const cue = director.update()[0]
  assert.equal(cue.motionPlan?.steps.length, 2)
  assert.ok((cue.motionPlan?.steps[1].atMs ?? 0) >= 1_200)
  assert.ok((cue.motionPlan?.steps[0].intensity ?? 0) >= 0.3)
  assert.ok(
    (cue.motionPlan?.steps[0].durationMs ?? 0) >= 850,
    'ordinary speech posture should remain readable instead of flicking',
  )
})

test('decoded long speech distributes multiple expression-compatible body beats', () => {
  let now = 0
  const director = new PerformanceDirector(() => now)
  director.stage({ ...base, turnId: 'turn-long', emotion: 'shy' })
  director.onAudioStart('turn-long', 9_000)

  const cue = director.update()[0]
  assert.equal(cue.durationMs, 9_000)
  assert.equal(cue.motionPlan?.durationMs, 9_000)
  assert.equal(cue.motionPlan?.steps.length, 3)
  assert.ok(cue.motionPlan!.steps.at(-1)!.atMs > 6_000)
  assert.ok(cue.motionPlan!.steps.every(step => step.durationMs >= 1_000))
})

test('sparse LLM choreography is completed through the later half of speech', () => {
  let now = 0
  const director = new PerformanceDirector(() => now)
  director.stage({
    ...base,
    turnId: 'turn-sparse',
    motionPlan: {
      durationMs: 1_200,
      steps: [{ atMs: 0, durationMs: 500, primitive: 'nod', intensity: 0.45 }],
    },
  })
  director.onAudioStart('turn-sparse', 9_000)

  const cue = director.update()[0]
  assert.equal(cue.motionPlan?.durationMs, 9_000)
  assert.ok((cue.motionPlan?.steps.length ?? 0) >= 2)
  assert.ok(
    (cue.motionPlan?.steps.at(-1)?.atMs ?? 0) >= 9_000 * 0.55,
    'speech should retain a restrained semantic beat after the midpoint',
  )
})

test('a fully populated but front-loaded LLM plan reserves a later speech beat', () => {
  const director = new PerformanceDirector(() => 0)
  director.stage({
    ...base,
    turnId: 'turn-front-loaded',
    motionPlan: {
      durationMs: 2_000,
      steps: [
        { atMs: 0, durationMs: 400, primitive: 'nod', intensity: 0.4 },
        { atMs: 300, durationMs: 400, primitive: 'tilt_left', intensity: 0.4 },
        { atMs: 700, durationMs: 400, primitive: 'lean_forward', intensity: 0.4 },
      ],
    },
  })
  director.onAudioStart('turn-front-loaded', 10_000)

  const cue = director.update()[0]
  assert.equal(cue.motionPlan?.steps.length, 3)
  assert.ok((cue.motionPlan?.steps.at(-1)?.atMs ?? 0) >= 7_000)
})

test('measured segment durations anchor cues exactly (per-clip playback)', () => {
  let now = 1_000
  const director = new PerformanceDirector(() => now)
  director.stage(base, [
    { text: '第一段。', emotion: 'shy', behavior: 'speak', durationMs: 1_500 },
    { text: '第二段。', emotion: 'angry', behavior: 'speak', durationMs: 2_500 },
  ])

  director.onAudioStart('turn-1', 1_500)
  // All-measured path: cue 0 at audio start, cue 1 at start + 1_500 exactly.
  assert.equal(director.update()[0]?.emotion, 'shy')
  assert.deepEqual(director.update(), [])
  now += 1_500
  assert.equal(director.update()[0]?.emotion, 'angry')
})

test('sequential per-clip playback: each clip start re-anchors its cue to now', () => {
  let now = 1_000
  const director = new PerformanceDirector(() => now)
  director.stage(base, [
    { text: '第一段。', emotion: 'shy', behavior: 'speak', durationMs: 1_500 },
    { text: '第二段。', emotion: 'angry', behavior: 'speak', durationMs: 2_500 },
    { text: '第三段。', emotion: 'calm', behavior: 'speak', durationMs: 900 },
  ])

  // Clip 0 starts → cue 0 (shy) fires immediately.
  director.onAudioStart('turn-1', 1_500, 0)
  assert.equal(director.update()[0]?.emotion, 'shy')

  // Clip 1 starts late (real playback ran 2_000ms, not the measured 1_500).
  now += 2_000
  director.onAudioStart('turn-1', 2_500, 1)
  // Cue 1 (angry) is re-anchored to NOW, and cue 2 (calm) follows after 2_500.
  const due = director.update()
  assert.equal(due[0]?.emotion, 'angry')

  now += 2_500
  assert.equal(director.update()[0]?.emotion, 'calm')
})

test('partial measurement falls back to weighted estimation', () => {
  let now = 1_000
  const director = new PerformanceDirector(() => now)
  director.stage(base, [
    { text: '有实测时长', emotion: 'shy', behavior: 'speak', durationMs: 1_000 },
    { text: '这段没有实测时长所以走权重估算', emotion: 'calm', behavior: 'speak' },
  ])
  director.onAudioStart('turn-1', 4_000)
  // Should not throw and should produce both cues via the weight path.
  assert.equal(director.update().length, 1)
})
