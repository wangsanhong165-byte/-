// 动作质量审计器 v2（2026-09-05 动力学重定义）
//   旧版问题：maxSpeed 一刀切（>30 可疑 >60 事故）把"快速有意的 stroke"和
//   "高频小抖 jitter"混为一谈——前者是生命感（鼠标甩动验证过），后者才该禁。
//   新判据：
//   1. 预算制 —— 每个动作预设的峰值速度上限与 performance-scenarios.test.ts
//      的锁定预算一致（全身协调节拍允许更快）
//   2. whips —— 0.18s 内速度反向且两侧 |v|>40°/s = 硬快抖（RED，必须为 0）；
//      15-40 = 软抖动（黄，人工复核）
//   3. sync —— 头.z 与 身.x 同向率（全身协调）
//   4. attack —— 从起势到峰值的时间（信息项：节拍承诺应在 ~100ms 量级）
import { runScenario } from './performance-pipeline-harness.ts'

const AXES = ['head.x', 'head.y', 'head.z', 'body.x', 'body.y', 'body.z'] as const

// 与 performance-scenarios.test.ts 的预算锁定保持一致
const BUDGETS: Record<string, number> = {
  nod: 120, tilt: 90, wave: 120, sway: 100, speak: 100, shrug: 110, greet: 100,
  thinking: 80, react: 130,
}

function metrics(series: Array<{ t: number; values: Record<string, number> }>) {
  let maxSpeed = 0, maxAxis = ''
  let whipsHard = 0, whipsSoft = 0
  const prevSpeed: Record<string, number> = {}
  const prevT: Record<string, number> = {}
  const peakOf: Record<string, { abs: number; t: number }> = {}
  let firstMoveT = Infinity
  for (let i = 1; i < series.length; i++) {
    for (const ax of AXES) {
      const v = series[i]!.values[ax] ?? 0
      const p = series[i - 1]!.values[ax] ?? 0
      const speed = (v - p) * 60
      const abs = Math.abs(speed)
      if (abs > Math.abs(maxSpeed)) { maxSpeed = speed; maxAxis = ax }
      const absV = Math.abs(v)
      if (absV > (peakOf[ax]?.abs ?? 0)) peakOf[ax] = { abs: absV, t: series[i]!.t }
      if (abs > 5 && firstMoveT === Infinity) firstMoveT = series[i]!.t
      const ps = prevSpeed[ax]
      if (ps !== undefined && Math.sign(speed) !== Math.sign(ps)) {
        const dt = series[i]!.t - (prevT[ax] ?? series[i]!.t)
        if (dt < 0.18 && Math.abs(ps) > 40 && abs > 40) whipsHard++
        else if (dt < 0.2 && Math.abs(ps) > 15 && abs > 15) whipsSoft++
      }
      if (abs > 5) { prevSpeed[ax] = speed; prevT[ax] = series[i]!.t }
    }
  }
  // headBodySync: head.z 与 body.x 同帧同向率（仅当两者都 |v|>0.3 时计）
  let both = 0, same = 0
  for (const s of series) {
    const hz = s.values['head.z'] ?? 0, bx = s.values['body.x'] ?? 0
    if (Math.abs(hz) > 0.3 && Math.abs(bx) > 0.3) { both++; if (Math.sign(hz) === Math.sign(bx)) same++ }
  }
  const peakAxis = peakOf[maxAxis]
  return {
    maxSpeed: +maxSpeed.toFixed(1), maxAxis,
    whipsHard, whipsSoft,
    sync: both ? Math.round(same / both * 100) + '%' : 'n/a',
    attackMs: peakAxis && firstMoveT < Infinity ? Math.round((peakAxis.t - firstMoveT) * 1000) : 0,
  }
}

type Row = { name: string; kind: 'motion' | 'ambient'; m: ReturnType<typeof metrics> }
const rows: Row[] = []

// --- 姿态脚本 ×9（speaking + 情绪，8s）---
for (const emo of ['love', 'shy', 'joyful', 'laughing', 'angry', 'pout', 'sad', 'surprised', 'playful']) {
  const r = runScenario({ events: [{ atSeconds: 0, run: ctx => { ctx.transition('speaking'); ctx.setEmotion(emo) } }], durationSeconds: 8 })
  rows.push({ name: 'script:' + emo, kind: 'ambient', m: metrics(r.series) })
}
// --- 基线：speaking 无情绪（说话层自身）---
rows.push({ name: 'BASELINE speech', kind: 'ambient', m: metrics(runScenario({ events: [{ atSeconds: 0, run: ctx => ctx.transition('speaking') }], durationSeconds: 10 }).series) })
// --- 动作预设 ×9（idle 中 requestMotion，5s）---
for (const name of ['nod', 'tilt', 'wave', 'sway', 'thinking', 'greet', 'react', 'speak', 'shrug']) {
  const r = runScenario({ presets: [name], events: [{ atSeconds: 0.5, run: ctx => ctx.requestMotion(name) }], durationSeconds: 5 })
  rows.push({ name: 'motion:' + name, kind: 'motion', m: metrics(r.series) })
}
// --- 待机 24s ---
rows.push({ name: 'IDLE 24s', kind: 'ambient', m: metrics(runScenario({ durationSeconds: 24 }).series) })
// --- thinking ---
rows.push({ name: 'THINKING', kind: 'ambient', m: metrics(runScenario({ presets: ['thinking'], events: [{ atSeconds: 0, run: ctx => ctx.transition('thinking') }], durationSeconds: 6 }).series) })

console.log('name'.padEnd(18), 'peak(budget)'.padEnd(18), 'whipsH/S'.padEnd(9), 'attack', 'sync')
for (const { name, kind, m } of rows) {
  let flag = ''
  if (kind === 'motion') {
    const budget = BUDGETS[name.slice('motion:'.length)] ?? 100
    if (m.whipsHard > 0) flag = ' !!WHIP'
    else if (m.maxSpeed > budget) flag = ' !!RED'
    else if (m.maxSpeed > budget * 0.85) flag = ' ?near'
  } else {
    if (m.whipsHard > 0) flag = ' !!WHIP'
    else if (m.maxSpeed > 40) flag = ' !!RED'
    else if (m.maxSpeed > 20) flag = ' ?yellow'
  }
  console.log(
    name.padEnd(18),
    `${m.maxSpeed} on ${m.maxAxis}`.padEnd(18),
    `${m.whipsHard}/${m.whipsSoft}`.padEnd(9),
    String(m.attackMs).padEnd(6),
    m.sync + flag,
  )
}
