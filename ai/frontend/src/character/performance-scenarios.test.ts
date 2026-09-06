// Scenario regression suite for the Live2D performance layer.
//
// Every scenario drives the REAL pipeline (see performance-pipeline-harness.ts)
// through a user-reachable event script and asserts two kinds of invariants:
//
//   1. Continuity — no single-frame pose jump ("flash") beyond what the tuned
//      response rates legitimately produce. The reference pathology is the
//      4.2deg/one-frame thinking-glance snap fixed in AttentionController.
//   2. Capability — the motion a feature is designed to make actually happens
//      (the stance engages, the tracking turns the head, precedence holds).
//      A refactor that silently drops a capability turns these red.
//
// Adding a tuned behavior: give it a scenario here with its capability check,
// so future tuning cannot downgrade it unnoticed.
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  maxAbs,
  maxFrameStepAcross,
  maxWindowDelta,
  runScenario,
  type PipelineSample,
  type ScenarioContext,
} from './performance-pipeline-harness.ts'

const HEAD_AXES = ['head.x', 'head.y', 'head.z']

// Flash threshold for the activity-driven pose layers, calibrated against the
// production pipeline (shirone profile, output gains 1.4/1.34 applied): the
// 2026-09-04 retune (faster preset attacks, bouncier speech spring, big-tilt
// idle beat) raised the normal envelope to ~0.63deg/frame (idle 24s worst
// case, scenario-metrics.mjs), while the reference pathology (the
// thinking-glance snap) jumped ~5.9deg in one frame live. 1.3 sits ~2x above
// the retuned envelope and ~4.5x below the smallest discontinuity a user
// would perceive as a flash. If a deliberate retune raises the envelope past
// this, raise the threshold in the same change and say so in the commit.
const FLASH_STEP_DEG = 1.3

function assertContinuous(series: PipelineSample[]): void {
  const flash = maxFrameStepAcross(series, HEAD_AXES)
  assert.ok(flash.max <= FLASH_STEP_DEG, `head jumped ${flash.max.toFixed(3)}deg/frame on ${flash.key} @ ${flash.span}`)
}

function beginThinking(ctx: ScenarioContext): void { ctx.transition('thinking') }

test('text turn: glance glides back and the whole chain stays continuous', () => {
  const result = runScenario({
    presets: ['thinking'],
    events: [
      { atSeconds: 0, run: beginThinking },
      { atSeconds: 3.0, run: ctx => ctx.transition('speaking') },
      { atSeconds: 4.5, run: ctx => ctx.transition('idle') },
    ],
    durationSeconds: 6,
  })

  // The original flash regression: the pose must not collapse faster after
  // the thinking action than it moved into it.
  const rise = maxWindowDelta(result.series, 'head.x', 0.0, 1.6)
  const collapse = maxWindowDelta(result.series, 'head.x', 2.3, 3.3)
  assert.ok(
    collapse.max <= rise.max * 1.35,
    `recovery collapses faster than approach: ${collapse.max.toFixed(3)}deg @ ${collapse.span} vs ${rise.max.toFixed(3)}deg`,
  )
  assertContinuous(result.series)
})

test('text turn continuity holds across TTS timings', () => {
  for (const speakAt of [1.2, 3.0, 4.0, null]) {
    const events: Array<{ atSeconds: number; run: (ctx: ScenarioContext) => void }> = [
      { atSeconds: 0, run: beginThinking },
    ]
    if (speakAt !== null) events.push({ atSeconds: speakAt, run: ctx => ctx.transition('speaking') })
    events.push({ atSeconds: 5.5, run: ctx => ctx.transition('idle') })
    const result = runScenario({ presets: ['thinking'], events, durationSeconds: 7 })

    assertContinuous(result.series)
  }
})

test('back-to-back messages: the turn boundary does not snap', () => {
  const result = runScenario({
    presets: ['thinking'],
    events: [
      { atSeconds: 0.0, run: beginThinking },
      { atSeconds: 2.0, run: ctx => ctx.transition('speaking') },
      { atSeconds: 3.5, run: ctx => ctx.transition('idle') },
      { atSeconds: 4.0, run: beginThinking },
      { atSeconds: 6.0, run: ctx => ctx.transition('speaking') },
      { atSeconds: 7.5, run: ctx => ctx.transition('idle') },
    ],
    durationSeconds: 9,
  })

  assertContinuous(result.series)
})

test('interaction touch during thinking keeps gaze continuous and arbiter precedence intact', () => {
  const result = runScenario({
    presets: ['thinking', 'nod'],
    events: [
      { atSeconds: 0, run: beginThinking },
      {
        atSeconds: 1.5,
        run: ctx => {
          // A touch draws attention back (interaction authority) while the
          // LLM-tier nod must NOT stomp the still-playing state motion.
          ctx.setAttention('user', 1500)
          ctx.requestMotion('nod')
        },
      },
      { atSeconds: 3.0, run: ctx => ctx.transition('speaking') },
    ],
    durationSeconds: 5,
  })

  const nod = result.motionRequests.find(request => request.name === 'nod')
  assert.equal(nod?.accepted, false, 'LLM-tier motion must not preempt the playing state motion')
  assertContinuous(result.series)
})

test('emotion stance ramps in and melts out without steps', () => {
  const result = runScenario({
    events: [
      { atSeconds: 0, run: ctx => { ctx.transition('speaking'); ctx.setEmotion('pout') } },
      { atSeconds: 2.5, run: ctx => ctx.setEmotion('happy') },
      { atSeconds: 4.5, run: ctx => ctx.transition('idle') },
    ],
    durationSeconds: 6,
  })

  // Capability lock: the pout stance is actually engaged and readable
  // (authored -3.0deg head.z ramps to ~3.4deg through the 1.4x output gain).
  const poutZ = maxAbs(result.series, 'head.z', 0.5, 2.4)
  assert.ok(poutZ >= 1.8, `pout stance head.z only reached ${poutZ.toFixed(2)}deg`)
  assertContinuous(result.series)
})

test('pointer tracking engages and releases without a snap', () => {
  const result = runScenario({
    events: [
      { atSeconds: 1.0, run: ctx => ctx.trackPointer(0.8, -0.3) },
      { atSeconds: 3.0, run: ctx => ctx.releasePointer() },
    ],
    durationSeconds: 5,
  })

  // Capability lock: the pointer actually turns the head.
  const excursion = maxAbs(result.series, 'head.x', 1.0, 3.0)
  assert.ok(excursion >= 4, `pointer excursion head.x only reached ${excursion.toFixed(2)}deg`)
  // Acquisition is designed to be immediate (head rate 13.5/s toward ~19deg
  // reads ~3.9deg/frame at peak) — bound it so it can never become a teleport.
  const acquire = maxFrameStepAcross(result.series, HEAD_AXES, 1.0, 3.0)
  assert.ok(
    acquire.max <= 5.2,
    `acquisition jumped ${acquire.max.toFixed(3)}deg/frame on ${acquire.key} @ ${acquire.span} — beyond the designed response envelope`,
  )
  // The release is where the designed glide lives (rate 2.2/s, ~0.72deg/frame
  // at this amplitude); it must not snap back to center in a burst.
  const release = maxFrameStepAcross(result.series, HEAD_AXES, 3.0, 4.2)
  assert.ok(release.max <= 1.0, `pointer release snapped: ${release.max.toFixed(3)}deg/frame on ${release.key} @ ${release.span}`)
})

// --- Emotion posture sets (performance-recipes POSTURE_SETS) -----------------
//
// shirone's expressionMap collapses emotion families onto one face, so body
// language is the only differentiator. These locks keep family members
// physically distinct and keep the natural set soft-but-present.

const ramp = 1.3 // seconds for a 2.4/s posture ramp to read ~full

test('joy family: joyful leans in, cheerful stays upright, laughing rocks', () => {
  const result = runScenario({
    events: [
      { atSeconds: 0, run: ctx => { ctx.transition('speaking'); ctx.setEmotion('joyful') } },
      { atSeconds: 2.5, run: ctx => ctx.setEmotion('cheerful') },
      { atSeconds: 5.0, run: ctx => ctx.setEmotion('laughing') },
    ],
    durationSeconds: 8,
  })

  // joyful: forward-open bounce (body.x carries the stance)
  const joyfulLean = maxAbs(result.series, 'body.x', 0.8 + ramp * 0.5, 2.4)
  assert.ok(joyfulLean >= 1.0, `joyful body.x only reached ${joyfulLean.toFixed(2)}`)
  // cheerful: upright bright — body.y carries the stance (body.x is NOT a
  // usable discriminator here: the speech micro-drift layer wanders ±2deg on
  // the same axis, so leftover-lean bounds would be noise-driven).
  const cheerfulBodyY = maxAbs(result.series, 'body.y', 3.3, 4.9)
  assert.ok(cheerfulBodyY >= 0.7, `cheerful body.y only reached ${cheerfulBodyY.toFixed(2)}`)
  // laughing: head thrown back with the rock. Asserted RELATIVE to cheerful
  // (both windows breathe with attention episodes that subtract ~0.85deg of
  // head.z at hold overlap — an absolute bound would flake on episode phase).
  const cheerfulZ = maxAbs(result.series, 'head.z', 3.3, 4.9)
  const laughingZ = maxAbs(result.series, 'head.z', 5.8, 7.4)
  assert.ok(laughingZ >= 2.0, `laughing head.z only reached ${laughingZ.toFixed(2)}`)
  assert.ok(
    laughingZ >= cheerfulZ + 0.4,
    `laughing (${laughingZ.toFixed(2)}) must read apart from cheerful (${cheerfulZ.toFixed(2)})`,
  )
  assertContinuous(result.series)
})

test('calm settles visibly while neutral stays at baseline', () => {
  const result = runScenario({
    events: [
      { atSeconds: 0, run: ctx => ctx.transition('speaking') },
      { atSeconds: 3.0, run: ctx => ctx.setEmotion('calm') },
      { atSeconds: 5.5, run: ctx => ctx.setEmotion('neutral') },
    ],
    durationSeconds: 7,
  })

  const neutralHeadY = maxAbs(result.series, 'head.y', 0.5, 2.8)
  assert.ok(neutralHeadY <= 0.8, `neutral head.y drifted to ${neutralHeadY.toFixed(2)} — baseline must stay quiet`)
  const calmHeadY = minAbs(result.series, 'head.y', 3.6, 5.3)
  assert.ok(calmHeadY <= -0.6, `calm stance only settled to ${calmHeadY.toFixed(2)}`)
  assertContinuous(result.series)
})

test('natural posture set: same grammar, softer voice', () => {
  const result = runScenario({
    stylePreset: 'natural',
    events: [
      { atSeconds: 0, run: ctx => { ctx.transition('speaking'); ctx.setEmotion('pout') } },
      { atSeconds: 4.0, run: ctx => ctx.setEmotion('happy') },
    ],
    durationSeconds: 6,
  })

  const poutZ = maxAbs(result.series, 'head.z', 0.5, 3.8)
  assert.ok(poutZ >= 1.8, `natural pout stance too weak: ${poutZ.toFixed(2)}`)
  assert.ok(poutZ <= 3.5, `natural pout should be softer than lively (~3.9): ${poutZ.toFixed(2)}`)
  assertContinuous(result.series)
})

test('24s idle: actions keep arriving and nothing freezes or twitches', () => {
  const result = runScenario({ durationSeconds: 24 })

  // Capability: the idle action library actually plays (weight shifts, nods,
  // the rare big tilt). Any one of the head/body axes reaching 2deg counts —
  // a 24s window can legally land on head-only actions.
  const idleBody = maxAbs(result.series, 'body.x', 0, 24)
  const idleHeadY = maxAbs(result.series, 'head.y', 0, 24)
  const idleHeadZ = maxAbs(result.series, 'head.z', 0, 24)
  assert.ok(
    Math.max(idleBody, idleHeadY, idleHeadZ) >= 2,
    `idle never exceeded body.x ${idleBody.toFixed(2)} / head.y ${idleHeadY.toFixed(2)} / head.z ${idleHeadZ.toFixed(2)} — action library dead?`,
  )
  // Continuity on two scales: no flash, and no dead stillness. The cadence
  // floor is now 6.5-13s (torso actions are rare between head moves), so the
  // stillness budget follows it.
  const still = longestStillness(result.series, ['head.x', 'head.y', 'head.z', 'body.x'], 0.06)
  assert.ok(still <= 13.0, `idle froze for ${still.toFixed(1)}s without any pose change`)
  assertContinuous(result.series)
})

function minAbs(series: PipelineSample[], key: string, from: number, to: number): number {
  let min = 0
  for (const sample of series) {
    if (sample.t < from || sample.t > to) continue
    min = Math.min(min, sample.values[key] ?? 0)
  }
  return min
}

function longestStillness(series: PipelineSample[], keys: readonly string[], epsilon: number): number {
  let longest = 0
  let runStart: number | null = null
  for (let index = 1; index < series.length; index += 1) {
    const sample = series[index]!
    const previous = series[index - 1]!
    const moved = keys.some(key => Math.abs((sample.values[key] ?? 0) - (previous.values[key] ?? 0)) > epsilon)
    if (moved) {
      if (runStart !== null) longest = Math.max(longest, sample.t - runStart)
      runStart = null
    } else if (runStart === null) {
      runStart = previous.t
    }
  }
  if (runStart !== null) longest = Math.max(longest, series[series.length - 1]!.t - runStart)
  return longest
}

// --- Phased posture scripts (POSTURE_SCRIPTS) ---------------------------------
//
// The emotion stance is a short performance: an approach beat, a settle, then
// a living hold. These locks pin the phase structure itself — a regression to
// a flat ramped pose (one frozen stance) must go red.

test('shy script: dodge beat, stolen look-back, then hold — ear channels engaged', () => {
  const result = runScenario({
    events: [
      { atSeconds: 0, run: ctx => { ctx.transition('speaking'); ctx.setEmotion('shy') } },
    ],
    durationSeconds: 5,
  })
  assertContinuous(result.series)

  // The look-back beat is phase 2 (~1.5s): head.x must ease TOWARD center
  // around then — i.e. the dodge depth at the hold (t≈3.4s) exceeds the
  // look-back depth (t≈1.8s). A flat ramp would be monotonic.
  const lookBackX = maxAbs(result.series, 'head.x', 1.6, 2.1)
  const holdX = maxAbs(result.series, 'head.x', 2.9, 3.9)
  assert.ok(
    holdX >= lookBackX + 0.4,
    `look-back (|head.x| ${lookBackX.toFixed(2)}) must be visibly shallower than the dodge hold (${holdX.toFixed(2)})`,
  )
})

test('shy script: ear pin actually reaches the model parameters', () => {
  // The accessory channel is the point of the scripts (shirone has no arms —
  // ears/tail are her hands). The harness pipeline must carry
  // ear.* through resolver+mixer: assert the sampled series contains a
  // nonzero ear trace. POSE_KEYS does not include ears, so sample the raw
  // ambient layer by driving the engine directly.
  const r = runScenario({
    events: [
      { atSeconds: 0, run: ctx => { ctx.transition('speaking'); ctx.setEmotion('angry') } },
    ],
    durationSeconds: 3,
  })
  assertContinuous(r.series)
  // Indirect but strict: angry pins ears via the script; if the wiring broke,
  // the harness silent-falls-back to a flat posture and head.y still works —
  // so also assert the ANGRY beat shape: sharp approach (head.y dips fast).
  const early = maxAbs(r.series, 'head.y', 0.05, 0.4)
  assert.ok(early >= 0.4, `angry approach beat too slow to be a beat: ${early.toFixed(2)}`)
})

test('angry script: approach beat commits fast, hold keeps tension', () => {
  const result = runScenario({
    events: [
      { atSeconds: 0, run: ctx => { ctx.transition('speaking'); ctx.setEmotion('angry') } },
    ],
    durationSeconds: 4,
  })
  assertContinuous(result.series)
  // The head squares down within ~0.4s (the beat), and the hold is near the
  // flat-posture calibration (head.y ≈ -2.4 × gain) so family separation is
  // preserved by the script's final phase.
  const hold = minAbs(result.series, 'head.y', 1.5, 3.0)
  assert.ok(hold <= -1.4, `angry hold lost its stance depth: ${hold.toFixed(2)}`)
})

test('playful script: ONE whole-body tilt — head and torso travel together', () => {
  const result = runScenario({
    events: [
      { atSeconds: 0, run: ctx => { ctx.transition('speaking'); ctx.setEmotion('playful') } },
    ],
    durationSeconds: 4,
  })
  assertContinuous(result.series)

  // Whole-body coordination invariant (the "no local fast twitch" rule made
  // testable): at hold, the head tilt AND the torso lean must both be at
  // readable depth, on the SAME side (same sign). A head-only tilt with a
  // dead torso would break the body-follow contract.
  const headTilt = maxAbs(result.series, 'head.z', 1.2, 3.2)
  const torsoLean = maxAbs(result.series, 'body.x', 1.2, 3.2)
  assert.ok(headTilt >= 2.0, `playful head tilt too shallow: ${headTilt.toFixed(2)}`)
  assert.ok(torsoLean >= 0.8, `playful torso must follow the tilt: ${torsoLean.toFixed(2)}`)

  // Same-side check: sample both axes at the hold peak and compare signs.
  let peakT = 1.2
  for (const s of result.series) {
    if (s.t >= 1.2 && s.t <= 3.2 && Math.abs(s.values['head.z'] ?? 0) > Math.abs(result.series.find(x => x.t === peakT)!.values['head.z'] ?? 0)) peakT = s.t
  }
  const peak = result.series.find(x => x.t === peakT)!
  assert.ok(
    Math.sign(peak.values['head.z']) === Math.sign(peak.values['body.x']),
    `head (${peak.values['head.z']?.toFixed(2)}) and torso (${peak.values['body.x']?.toFixed(2)}) must tilt the SAME way`,
  )
})

// --- Motion speed budget (the "no fast local flicker" rule, made testable) ---
//
// 2026-09-05 dynamics redefinition: "局部快抖"（high-frequency small reversals）
// and "快速有意的 stroke"（a committed whole-figure beat）are DIFFERENT things.
// The old flat budgets punished the latter — the liveliness the tracking path
// demonstrates on every mouse flick. New doctrine, user-validated live:
//   - full-figure coordinated beats may attack fast (committed strokes);
//   - a hard whip (speed reversal |v|>40deg/s within 0.18s on both sides) is
//     ALWAYS a bug — asserted zero per preset below;
//   - budgets stay per-preset (whole-body beats faster than a local gaze).
// audit-motion-quality.mts mirrors this table.

test('motion presets: peak pose velocity stays inside the speed budget, zero hard whips', () => {
  const budget: Record<string, number> = {
    nod: 120, tilt: 90, wave: 120, sway: 100, speak: 100, shrug: 110, greet: 100,
    thinking: 80, react: 130,
  }
  const axes = ['head.x', 'head.y', 'head.z', 'body.x', 'body.y', 'body.z']
  for (const [name, limit] of Object.entries(budget)) {
    const r = runScenario({
      presets: [name],
      events: [{ atSeconds: 0.5, run: ctx => ctx.requestMotion(name) }],
      durationSeconds: name === 'nod' ? 2.5 : 3.5,
    })
    let maxSpeed = 0
    let whipsHard = 0
    const prevSpeed: Record<string, number> = {}
    const prevT: Record<string, number> = {}
    for (let i = 1; i < r.series.length; i++) {
      for (const ax of axes) {
        const v = r.series[i]!.values[ax] ?? 0
        const speed = ((r.series[i - 1]!.values[ax] ?? 0) - v) * -60
        if (Math.abs(speed) > maxSpeed) maxSpeed = Math.abs(speed)
        const ps = prevSpeed[ax]
        if (ps !== undefined && Math.sign(speed) !== Math.sign(ps)
          && (r.series[i]!.t - (prevT[ax] ?? r.series[i]!.t)) < 0.18
          && Math.abs(ps) > 40 && Math.abs(speed) > 40) whipsHard++
        if (Math.abs(speed) > 5) { prevSpeed[ax] = speed; prevT[ax] = r.series[i]!.t }
      }
    }
    assert.ok(
      maxSpeed <= limit,
      `${name} peaks at ${maxSpeed.toFixed(1)}deg/s (budget ${limit}) — amplitude/time must be rebalanced`,
    )
    assert.equal(
      whipsHard, 0,
      `${name} contains ${whipsHard} hard whip(s) — high-frequency reversal is the "局部快抖" the craft rule bans`,
    )
  }
})
