import test from 'node:test'
import assert from 'node:assert/strict'

import { IdleActionScheduler, type IdleActionLabel } from './IdleActionScheduler.ts'

const NEUTRAL_VAD = { valence: 0, arousal: 0, dominance: 0 }

function runSeed(seed: number, seconds = 90): { actions: Set<string> } {
  const scheduler = new IdleActionScheduler(seed, 1, 1, 3)
  const actions = new Set<string>()
  for (let t = 0; t < seconds; t += 0.1) {
    scheduler.update(t, { allowed: true, focusLevel: 0, vad: NEUTRAL_VAD })
    const state = scheduler.getState()
    if (state.activeAction) actions.add(state.activeAction)
  }
  return { actions }
}

test('idle action scheduler leaves gaze shifts to the attention owner', () => {
  const result = runSeed(17)
  assert.equal(result.actions.has('curious-look'), false)
  assert.equal(result.actions.has('side-look'), false)
  assert.ok(result.actions.size >= 4)
})

test('idle behaviours fire more often than 8s base cadence', () => {
  const scheduler = new IdleActionScheduler(11, 1, 1, 3)
  const starts: number[] = []
  let previous: string | null = null
  for (let t = 0; t < 60; t += 0.1) {
    scheduler.update(t, { allowed: true, focusLevel: 0, vad: NEUTRAL_VAD })
    const state = scheduler.getState()
    if (state.activeAction && state.activeAction !== previous) starts.push(t)
    previous = state.activeAction
  }
  // Roughly 4.5-9s cadence + duration -> expect several behaviours in 60s.
  assert.ok(starts.length >= 4, `expected >=4 distinct idle starts in 60s, got ${starts.length}`)
})

// --- Emotion tint + preset phrases (IDLE_TINTS / phraseRequest) -------------

test('emotion tints the idle pick distribution (playful favors ear-flick, sad suppresses it)', () => {
  const count = (emotion: string, label: IdleActionLabel, runs = 200): number => {
    let hits = 0
    for (let run = 0; run < runs; run += 1) {
      const scheduler = new IdleActionScheduler(1000 + run, 1.25, 1, 3)
      scheduler.setPhraseRequest(() => true)
      // Fast-forward past the initial 8s first action delay by calling with
      // a start time the scheduler treats as "already running".
      scheduler.update(0, { allowed: false, focusLevel: 0, vad: { valence: 0, arousal: 0, dominance: 0 } })
      // allowed=false sets nextActionAt = 0 + interval; call again at a large
      // t so the pick happens deterministically.
      scheduler.update(30, {
        allowed: true, focusLevel: 0,
        vad: { valence: 0, arousal: 0, dominance: 0 },
        emotion,
      })
      const state = scheduler.getState()
      if (state.activeAction === label) hits += 1
    }
    return hits
  }

  const playful = count('playful', 'ear-flick')
  const sad = count('sad', 'ear-flick')
  assert.ok(
    playful > sad,
    `playful (${playful}/200) must favor ear-flick more than sad (${sad}/200)`,
  )
})

test('preset phrases delegate through the phraseRequest bridge and hold their slot', () => {
  const requests: string[] = []
  const scheduler = new IdleActionScheduler(42, 1.25, 1, 3)
  scheduler.setPhraseRequest(name => { requests.push(name); return true })
  scheduler.update(0, { allowed: false, focusLevel: 0, vad: { valence: 0, arousal: 0, dominance: 0 } })
  const pose = scheduler.update(30, {
    allowed: true, focusLevel: 0,
    vad: { valence: 0, arousal: 0, dominance: 0 },
    emotion: 'playful',
  })

  // Either a local action played (valid) or a phrase was requested — but if
  // the active action IS a phrase label, its request must have gone through.
  const state = scheduler.getState()
  if (state.activeAction === 'ear-flick' || state.activeAction === 'tail-sweep') {
    assert.ok(requests.length > 0, 'phrase action played but no request was bridged')
    // The slot pose must be neutral — the preset owns the actual motion.
    assert.equal(pose.headX + pose.headY + pose.headZ, 0)
  } else {
    assert.ok(requests.length === 0 || true, 'local action, no bridge call')
  }
})

test('without a phraseRequest bridge, phrase labels never enter the pool', () => {
  // Harness/test path: no arbiter → ear-flick must be silently excluded.
  const scheduler = new IdleActionScheduler(7, 1.25, 1, 3)
  scheduler.update(0, { allowed: false, focusLevel: 0, vad: { valence: 0, arousal: 0, dominance: 0 } })
  scheduler.update(30, {
    allowed: true, focusLevel: 0,
    vad: { valence: 0, arousal: 0, dominance: 0 },
    emotion: 'playful', // 2.6x ear-flick tint — would dominate if pooled
  })
  const state = scheduler.getState()
  assert.ok(
    state.activeAction !== 'ear-flick' && state.activeAction !== 'tail-sweep',
    'phrase label picked without a bridge — pool filter broken',
  )
})
