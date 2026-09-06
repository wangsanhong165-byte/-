// Shirone-calibrated metrics dump for the performance scenario library.
// Prints the normal peaks of every scenario so continuity/capability thresholds
// stay calibrated (normal envelope ~2x, perceptible flash ~1/7). Run from repo root:
//   node --experimental-strip-types scripts/scenario-metrics.mjs
// NOTE: the event scripts below mirror performance-scenarios.test.ts — when a
// scenario's events change there, update the matching block here in the same commit.
import {
  maxAbs,
  maxFrameStepAcross,
  maxWindowDelta,
  runScenario,
} from '../frontend/src/character/performance-pipeline-harness.ts'

const HEAD_AXES = ['head.x', 'head.y', 'head.z']

function show(label, metric) {
  console.log(`  ${label} = ${metric.max.toFixed(3)}deg on ${metric.key} @ ${JSON.stringify(metric.span)}`)
}

{
  console.log('--- text turn (thinking@0, speaking@3.0, idle@4.5) ---')
  const result = runScenario({
    presets: ['thinking'],
    events: [
      { atSeconds: 0, run: ctx => ctx.transition('thinking') },
      { atSeconds: 3.0, run: ctx => ctx.transition('speaking') },
      { atSeconds: 4.5, run: ctx => ctx.transition('idle') },
    ],
    durationSeconds: 6,
  })
  show('rise150', maxWindowDelta(result.series, 'head.x', 0.0, 1.6))
  show('collapse150', maxWindowDelta(result.series, 'head.x', 2.3, 3.3))
  show('flashAny', maxFrameStepAcross(result.series, HEAD_AXES))
}
{
  console.log('--- double message ---')
  const result = runScenario({
    presets: ['thinking'],
    events: [
      { atSeconds: 0.0, run: ctx => ctx.transition('thinking') },
      { atSeconds: 2.0, run: ctx => ctx.transition('speaking') },
      { atSeconds: 3.5, run: ctx => ctx.transition('idle') },
      { atSeconds: 4.0, run: ctx => ctx.transition('thinking') },
      { atSeconds: 6.0, run: ctx => ctx.transition('speaking') },
      { atSeconds: 7.5, run: ctx => ctx.transition('idle') },
    ],
    durationSeconds: 9,
  })
  show('flashAny', maxFrameStepAcross(result.series, HEAD_AXES))
}
{
  console.log('--- emotion pout -> happy ---')
  const result = runScenario({
    events: [
      { atSeconds: 0, run: ctx => { ctx.transition('speaking'); ctx.setEmotion('pout') } },
      { atSeconds: 2.5, run: ctx => ctx.setEmotion('happy') },
      { atSeconds: 4.5, run: ctx => ctx.transition('idle') },
    ],
    durationSeconds: 6,
  })
  console.log('  pout |head.z| peak (0.5-2.4s) =', maxAbs(result.series, 'head.z', 0.5, 2.4).toFixed(3))
  show('flashAny', maxFrameStepAcross(result.series, HEAD_AXES))
}
{
  console.log('--- pointer tracking ---')
  const result = runScenario({
    events: [
      { atSeconds: 1.0, run: ctx => ctx.trackPointer(0.8, -0.3) },
      { atSeconds: 3.0, run: ctx => ctx.releasePointer() },
    ],
    durationSeconds: 5,
  })
  console.log('  excursion |head.x| (1.0-3.0s) =', maxAbs(result.series, 'head.x', 1.0, 3.0).toFixed(3))
  show('acquire flash', maxFrameStepAcross(result.series, HEAD_AXES, 1.0, 3.0))
  show('release flash', maxFrameStepAcross(result.series, HEAD_AXES, 3.0, 4.2))
}
{
  console.log('--- joy family (joyful@0 -> cheerful@2.5 -> laughing@5.0) ---')
  const result = runScenario({
    events: [
      { atSeconds: 0, run: ctx => { ctx.transition('speaking'); ctx.setEmotion('joyful') } },
      { atSeconds: 2.5, run: ctx => ctx.setEmotion('cheerful') },
      { atSeconds: 5.0, run: ctx => ctx.setEmotion('laughing') },
    ],
    durationSeconds: 8,
  })
  console.log('  joyful |body.x| (1.45-2.4s) =', maxAbs(result.series, 'body.x', 1.45, 2.4).toFixed(3))
  console.log('  cheerful |body.y| (3.3-4.9s) =', maxAbs(result.series, 'body.y', 3.3, 4.9).toFixed(3))
  console.log('  cheerful |head.z| (3.3-4.9s) =', maxAbs(result.series, 'head.z', 3.3, 4.9).toFixed(3))
  console.log('  laughing |head.z| (5.8-7.4s) =', maxAbs(result.series, 'head.z', 5.8, 7.4).toFixed(3))
  show('flashAny', maxFrameStepAcross(result.series, HEAD_AXES))
}
{
  console.log('--- calm vs neutral (neutral@0 -> calm@3 -> neutral@5.5) ---')
  const result = runScenario({
    events: [
      { atSeconds: 0, run: ctx => ctx.transition('speaking') },
      { atSeconds: 3.0, run: ctx => ctx.setEmotion('calm') },
      { atSeconds: 5.5, run: ctx => ctx.setEmotion('neutral') },
    ],
    durationSeconds: 7,
  })
  console.log('  neutral |head.y| (0.5-2.8s) =', maxAbs(result.series, 'head.y', 0.5, 2.8).toFixed(3))
  console.log('  calm min head.y (3.6-5.3s)  =', minVal(result.series, 'head.y', 3.6, 5.3).toFixed(3))
  show('flashAny', maxFrameStepAcross(result.series, HEAD_AXES))
}
{
  console.log('--- natural set pout (pout@0 -> happy@4.0, stylePreset natural) ---')
  const result = runScenario({
    stylePreset: 'natural',
    events: [
      { atSeconds: 0, run: ctx => { ctx.transition('speaking'); ctx.setEmotion('pout') } },
      { atSeconds: 4.0, run: ctx => ctx.setEmotion('happy') },
    ],
    durationSeconds: 6,
  })
  console.log('  pout |head.z| peak (0.5-3.8s) =', maxAbs(result.series, 'head.z', 0.5, 3.8).toFixed(3))
  show('flashAny', maxFrameStepAcross(result.series, HEAD_AXES))
}
{
  console.log('--- idle 24s (no events) ---')
  const result = runScenario({ durationSeconds: 24 })
  console.log('  idle |body.x| (0-24s) =', maxAbs(result.series, 'body.x', 0, 24).toFixed(3))
  show('flashAny', maxFrameStepAcross(result.series, HEAD_AXES))
}

function minVal(series, key, from, to) {
  let min = 0
  for (const sample of series) {
    if (sample.t < from || sample.t > to) continue
    min = Math.min(min, sample.values[key] ?? 0)
  }
  return min
}
