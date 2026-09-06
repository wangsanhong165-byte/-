
import assert from 'node:assert/strict'
import { runScenario } from './performance-pipeline-harness.ts'

// 300s pure idle through the FULL pipeline (engine → idle controller → resolver)
const r = runScenario({ durationSeconds: 300 })
const s = r.series

// 1) sleep machine: drowsy at ~150s, asleep at ~240s (plus ~10s smoothing lag)
const sleepAt120 = s[Math.floor(120 * 60)].values
const sleepAt200 = s[Math.floor(200 * 60)].values
const sleepAt290 = s[Math.floor(290 * 60)].values
// sleepAmount is not in POSE_KEYS series? check by sampling keys present
const keys = Object.keys(s[0].values)
console.log('series keys:', keys.join(','))
// eyeClose is the observable of sleep: awake ~0.1-0.2, asleep ≥0.94
const eye = (t) => s[Math.floor(t * 60)].values['eye.close'] ?? s[Math.floor(t*60)].values['eyeClose'] ?? null
console.log('eyeClose@30s:', eye(30), ' @200s:', eye(200), ' @290s:', eye(290))

// 2) forward-lean ban across the FULL 300s (awake AND asleep)
let minY = 0, minT = 0
for (const sample of s) {
  const y = sample.values['body.y'] ?? 0
  if (y < minY) { minY = y; minT = sample.t }
}
console.log('bodyY min over 300s:', minY.toFixed(3), 'at t=', minT.toFixed(0), minY > -0.9 ? 'PASS' : 'FAIL')

// 3) look-around actually fires during awake idle
const actions = new Set()
for (const sample of s) {
  const a = sample.values['activeAction'] ?? null
  if (a) actions.add(a)
}
console.log('actions seen:', [...actions].join(','))

// 4) never-still floor: longest run with all pose axes static
let longest = 0, run = 0
for (let i = 1; i < s.length; i++) {
  const a = s[i].values, b = s[i-1].values
  const moved = ['head.x','head.y','head.z','body.x','body.y','eye.x']
    .some(k => Math.abs((a[k] ?? 0) - (b[k] ?? 0)) > 0.02)
  if (moved) { longest = Math.max(longest, run); run = 0 } else run += 1/60
}
console.log('longest still run:', longest.toFixed(1) + 's', longest <= 13 ? 'PASS' : 'FAIL')
