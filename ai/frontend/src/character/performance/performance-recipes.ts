// Single registry for emotion-driven body language.
//
// Three mechanisms read this file:
//   - AmbientPerformanceEngine holds `posture` as a sustained stance while the
//     emotion is active (ramped in/out, never snapped). The set is picked by
//     the avatar's motionStyle preset (see POSTURE_SETS below).
//   - AmbientPerformanceEngine also samples `POSTURE_SCRIPTS` for emotions
//     with a phased timeline (approach → settle → living hold, optional
//     beats like the shy look-back): the stance becomes a short performance
//     instead of one frozen pose.
//   - PerformanceDirector falls back to `beats` when the LLM motion plan is
//     thin or missing (co-speech beat primitives).
//
// Adding or retuning an emotion's body language happens HERE and nowhere else;
// all mechanisms pick it up on the next frame. Values are calibrated against
// the reference performance — retune deliberately, and extend the scenario
// baselines (performance-scenarios.test.ts) in the same change.
//
// WHY SETS EXIST: shirone's expressionMap collapses emotion families onto one
// face (joyful/cheerful/laughing→星星眼, love/shy/embarrassed→心心眼,
// angry/pout→生气表情, calm/neutral→重置) — body language is the ONLY
// differentiator inside a family. Postures within a family are therefore
// authored to read apart; `calm` MUST have a stance or it is visually
// identical to neutral.
import type { MotionPrimitive } from '../MotionAction.ts'

export type PostureSetName = 'lively' | 'natural'

/** Sustained stance: logical parameter offsets held while the emotion is active. */
type Posture = Readonly<Record<string, number>>

/**
 * Phased posture timeline: the emotion's stance as a short performance.
 *
 * Each phase is a keyframe at `atMs` (milliseconds since the emotion became
 * active). Parameters absent from a phase carry the previous phase's value
 * forward; the LAST phase is the living hold (looped by `holdLoopMs` if set,
 * with the listed `loop` amplitudes added on top — the stance breathes).
 * Logical ear./tail. channels are legal here and reach the model through
 * the same resolver path as head./body. — shirone has no arms, her
 * embarrassment/joy accessories live on those channels.
 */
export interface PostureScriptPhase {
  atMs: number
  values: Readonly<Record<string, number>>
  /** Optional overlay loop (phase-relative, applied while this phase is the
   *  hold): key → ±amplitude, looping at holdLoopMs per cycle. */
  loop?: Readonly<Record<string, number>>
  holdLoopMs?: number
}

export interface PostureScript {
  phases: readonly PostureScriptPhase[]
}

// `cry` and `crying` are two spellings of the same body language — the LLM
// emits both; they must never drift apart.
const CRYING_POSTURE = { 'head.y': -2.4, 'body.y': -1.8, 'head.z': 1.8 } as const

/**
 * Primary set (shirone ships motionStyle.preset = 'lively'). Family members
 * that share one face are separated on the body axes:
 *   joy family   — joyful leans in and opens, cheerful stays upright bright,
 *                  laughing rocks forward with the head thrown back;
 *   love family  — love leans in warmly, shy/embarrassed turn away and drop;
 *   angry/pout   — angry squares up leaning in, pout turns away sulking;
 *   calm/neutral — neutral has no stance, calm settles softly downward.
 */
const LIVELY_POSTURES: Readonly<Record<string, Posture>> = {
  angry: { 'head.y': -2.4, 'body.y': 2.4, 'head.z': -1.2 },
  calm: { 'head.y': -0.9, 'head.z': 0.5, 'body.y': 0.6 },
  cheerful: { 'body.y': 1.0, 'head.z': 1.2, 'head.y': 0.5 },
  cry: CRYING_POSTURE,
  crying: CRYING_POSTURE,
  embarrassed: { 'head.y': -2.6, 'head.x': -1.4, 'body.x': -1.2 },
  happy: { 'head.z': 1.3, 'body.x': 0.9, 'head.y': 0.7 },
  joyful: { 'head.z': 1.8, 'body.x': 1.3, 'head.y': 0.9 },
  laughing: { 'head.z': 2.2, 'body.y': 1.4 },
  love: { 'head.z': 1.5, 'body.x': 1.3 },
  pout: { 'head.z': -3.0, 'head.y': 1.2, 'body.x': -2.0 },
  sad: { 'head.y': -2.6, 'body.y': -2.0, 'head.z': 1.6 },
  shy: { 'head.y': -3.0, 'head.x': -1.6, 'body.x': -1.3 },
  sleepy: { 'head.y': -1.7 },
  smile: { 'head.z': 1.0, 'head.y': 0.5 },
  surprised: { 'head.y': 2.0, 'body.y': -1.3 },
  worried: { 'head.y': -1.3, 'head.z': 1.4 },
}

/** Soft set for the natural/calm/shy style presets: same body-language
 *  grammar at ~0.72 amplitude so moods read as texture, not pantomime. */
const NATURAL_POSTURES: Readonly<Record<string, Posture>> = scalePostures(LIVELY_POSTURES, 0.72)

export const POSTURE_SETS: Readonly<Record<PostureSetName, Readonly<Record<string, Posture>>>> = {
  lively: LIVELY_POSTURES,
  natural: NATURAL_POSTURES,
}

/**
 * Phased timelines for the emotion FAMILIES (one script per family head;
 * family members without their own script inherit the head's). A script
 * replaces the flat stance while its emotion is active — the approach beat
 * (fast commitment, ~200-400ms), the settle (overshoot-recover), then the
 * living hold with a small breathing loop. Channels: head./body. as before,
 * plus ear./tail. accessory channels (shirone: ears pin, tail curls — her
 * only "hands").
 *
 * Authoring rules:
 *   - Phase 0 starts from rest (all values from neutral) — the engine ramps
 *     from wherever the body currently is, so never author a "jump".
 *   - Hold phase values are the sustained stance: keep them near the old
 *     flat-posture numbers so family separation is preserved.
 *   - holdLoopMs ≈ 3-5s: a slow breath, NOT a visible wag.
 */
const POSTURE_SCRIPTS: Readonly<Record<string, PostureScript>> = {
  // LOVE family head: warm approach — head turns aside + drops, ears soften
  // back, a small settle breath on arrival.
  love: {
    phases: [
      { atMs: 0, values: {} },
      { atMs: 260, values: { 'head.z': 1.5, 'head.y': -0.6, 'body.x': 2.2, 'ear.right.forward': -2.4 } },
      { atMs: 640, values: { 'head.z': 2.2, 'head.y': -1.2, 'body.x': 2.6, 'tail.z': 2.6 },
        loop: { 'head.z': 0.5, 'body.x': 0.4, 'tail.z': 1.2 }, holdLoopMs: 4200 },
    ],
  },
  // LOVE family, bashful branch: glance away fast, ears pin down, a stolen
  // look-back beat (~1.6s in) then away again — the shy signature.
  shy: {
    phases: [
      { atMs: 0, values: {} },
      { atMs: 220, values: { 'head.y': -3.0, 'head.x': -2.6, 'body.x': -2.2, 'ear.left.forward': -3.2, 'ear.right.forward': -3.6 } },
      { atMs: 1500, values: { 'head.y': -2.2, 'head.x': -0.9, 'ear.left.forward': -1.4, 'ear.right.forward': -1.8 } },
      { atMs: 2050, values: { 'head.y': -3.2, 'head.x': -3.2, 'ear.left.forward': -3.6, 'ear.right.forward': -4.0, 'tail.z': -2.8 } },
      { atMs: 2600, values: { 'head.y': -2.8, 'head.x': -2.4, 'body.x': -2.0, 'ear.left.forward': -2.6, 'ear.right.forward': -3.0, 'tail.z': -2.2 },
        loop: { 'head.y': 0.4, 'tail.z': 0.8 }, holdLoopMs: 4800 },
    ],
  },
  // JOY family head (joyful): bright forward open — the bounce up into the
  // stance IS the joy; ears perk, tail lifts.
  joyful: {
    phases: [
      { atMs: 0, values: {} },
      { atMs: 240, values: { 'head.z': 2.4, 'body.x': 2.2, 'head.y': 1.3, 'ear.left.forward': 4.2, 'ear.right.forward': 4.6 } },
      { atMs: 560, values: { 'head.z': 1.8, 'body.x': 2.2, 'head.y': 0.9, 'ear.left.forward': 3.2, 'ear.right.forward': 3.4, 'tail.z': 3.4 },
        loop: { 'head.z': 0.6, 'body.y': 0.5, 'tail.z': 1.4 }, holdLoopMs: 3400 },
    ],
  },
  // PLAYFUL (teasing): one WHOLE-BODY sly tilt, not local twitching. The head
  // leans to one side TOGETHER with the torso (body.x rides the same beat),
  // one ear stands then tips, the tail settles into a slow wide swing. Hard
  // rule from live feedback: NEVER author fast small-amplitude oscillation of
  // a single part (the "rapid head flick" report) — every phase is a single
  // committed pose the whole figure travels to, and the hold loop breathes
  // slowly (≥3s period). Direction mirrors per play like every other script.
  playful: {
    phases: [
      { atMs: 0, values: {} },
      { atMs: 320, values: { 'head.z': 2.8, 'head.y': 0.8, 'body.x': 2.0, 'body.z': 1.0, 'ear.left.forward': 4.4, 'ear.right.forward': 1.2 } },
      { atMs: 900, values: { 'head.z': 2.2, 'head.y': 0.6, 'body.x': 1.8, 'body.z': 0.8, 'ear.left.forward': 3.2, 'ear.right.forward': 2.4, 'tail.z': 3.0 },
        loop: { 'head.z': 0.5, 'body.x': 0.4, 'tail.z': 1.5 }, holdLoopMs: 3800 },
    ],
  },
  // JOY family, laughing branch: rock back — head thrown, ears flick wide,
  // tail swings; hold rocks gently.
  laughing: {
    phases: [
      { atMs: 0, values: {} },
      { atMs: 200, values: { 'head.z': 1.6, 'head.y': 2.6, 'body.y': 1.8, 'ear.left.forward': 5.0, 'ear.right.forward': 5.4 } },
      { atMs: 460, values: { 'head.z': 2.6, 'head.y': 1.6, 'body.y': 1.4, 'ear.left.forward': 3.4, 'ear.right.forward': 3.6, 'tail.z': 4.2 },
        loop: { 'head.z': 0.8, 'body.y': 0.6, 'tail.z': 1.8 }, holdLoopMs: 2800 },
    ],
  },
  // ANGRY family head: square up — sharp forward lean, chin down, ears pin
  // flat (cat anger), tail lashes once then holds high tension.
  angry: {
    phases: [
      { atMs: 0, values: {} },
      { atMs: 180, values: { 'head.y': -1.4, 'body.y': 3.4, 'head.z': -0.6, 'ear.left.forward': -4.6, 'ear.right.forward': -5.0 } },
      { atMs: 380, values: { 'head.y': -2.4, 'body.y': 3.6, 'head.z': -1.2, 'ear.left.forward': -3.4, 'ear.right.forward': -3.8, 'tail.z': -3.6 } },
      { atMs: 620, values: { 'head.y': -2.4, 'body.y': 2.4, 'head.z': -1.2, 'ear.left.forward': -3.0, 'ear.right.forward': -3.4, 'tail.z': -2.4 },
        loop: { 'tail.z': 1.6, 'body.y': 0.4 }, holdLoopMs: 2200 },
    ],
  },
  // ANGRY family, pout branch: turn away and sulk — slow deliberate turn,
  // ears droop sideways (not pinned), tail wraps.
  pout: {
    phases: [
      { atMs: 0, values: {} },
      { atMs: 420, values: { 'head.z': -3.0, 'head.y': 1.2, 'body.x': -3.2, 'ear.left.forward': 1.2, 'ear.right.forward': -1.6 } },
      { atMs: 1050, values: { 'head.z': -3.4, 'head.y': 0.8, 'body.x': -3.6, 'ear.left.forward': 0.8, 'ear.right.forward': -1.2, 'tail.z': -3.2 },
        loop: { 'head.z': 0.4, 'tail.z': 0.6 }, holdLoopMs: 5200 },
    ],
  },
  // SAD family head: sink — collapse arrives in two waves (drop, then
  // smaller settle), ears fall, tail lies still.
  sad: {
    phases: [
      { atMs: 0, values: {} },
      { atMs: 380, values: { 'head.y': -2.6, 'body.y': -3.2, 'head.z': 1.2, 'ear.left.forward': -2.0, 'ear.right.forward': -2.4 } },
      { atMs: 820, values: { 'head.y': -3.2, 'body.y': -3.6, 'head.z': 1.6, 'ear.left.forward': -2.8, 'ear.right.forward': -3.2, 'tail.z': -1.8 } },
      { atMs: 1180, values: { 'head.y': -2.6, 'body.y': -3.2, 'head.z': 1.6, 'ear.left.forward': -2.4, 'ear.right.forward': -2.8, 'tail.z': -1.4 },
        loop: { 'head.y': 0.3, 'body.y': 0.3 }, holdLoopMs: 5000 },
    ],
  },
  // SURPRISE family: pop up and back — fast up, then ease to alert hold;
  // ears snap up, tail jerks. Short by design: surprise resolves quickly.
  surprised: {
    phases: [
      { atMs: 0, values: {} },
      { atMs: 140, values: { 'head.y': 3.2, 'body.y': -1.8, 'ear.left.forward': 6.2, 'ear.right.forward': 6.6 } },
      { atMs: 420, values: { 'head.y': 2.0, 'body.y': -1.3, 'ear.left.forward': 4.4, 'ear.right.forward': 4.8, 'tail.z': 3.0 } },
      { atMs: 900, values: { 'head.y': 1.2, 'body.y': -0.7, 'ear.left.forward': 3.2, 'ear.right.forward': 3.4 },
        loop: { 'head.y': 0.3 }, holdLoopMs: 3600 },
    ],
  },
}

/** Script inheritance: family members resolve to their family head's script. */
const SCRIPT_FAMILY: Readonly<Record<string, string>> = {
  embarrassed: 'shy',
  cheerful: 'joyful',
  cry: 'sad',
  crying: 'sad',
  worried: 'sad',
}

/**
 * Target stance for an emotion at `elapsedMs` since activation, sampling the
 * phased script when one exists (family-inherited included) and falling back
 * to the flat posture otherwise. Mirrored emotions flip x/z/turn axes —
 * the caller (AmbientPerformanceEngine) owns that, mirroring the RETURNED
 * map the same way it mirrors flat postures.
 */
export function emotionPostureAt(
  emotion: string | undefined,
  preset: string = 'lively',
  elapsedMs: number = Number.POSITIVE_INFINITY,
): Readonly<Record<string, number>> | null {
  const key = emotion ?? ''
  const scriptName = key in POSTURE_SCRIPTS
    ? key
    : SCRIPT_FAMILY[key]
  if (scriptName) {
    const script = POSTURE_SCRIPTS[scriptName]!
    const sampled = samplePostureScript(script, elapsedMs)
    // The soft (natural) set keeps the same grammar at ~0.72 amplitude —
    // scripts must honor it too or the natural voice plays at full volume.
    if (preset === 'lively') return sampled
    return Object.fromEntries(Object.entries(sampled).map(([parameter, value]) => [
      parameter,
      Math.round(value * 0.72 * 10) / 10,
    ]))
  }
  return emotionPosture(emotion, preset)
}

/** Interpolate a phased script at `elapsedMs` (phase-relative linear). */
function samplePostureScript(script: PostureScript, elapsedMs: number): Record<string, number> {
  const phases = script.phases
  // Accumulate: each phase starts from the previous phase's resolved values.
  let accumulated: Record<string, number> = {}
  let holdIndex = phases.length - 1
  for (let index = 0; index < phases.length; index += 1) {
    const phase = phases[index]!
    accumulated = { ...accumulated, ...phase.values }
    if (elapsedMs <= phase.atMs || index === phases.length - 1) {
      holdIndex = index
      break
    }
  }
  // Interpolate between the previous phase's accumulated values and this one.
  const phase = phases[holdIndex]!
  const previous = phases[holdIndex - 1]
  if (previous) {
    const before: Record<string, number> = {}
    const keys = new Set([...Object.keys(previous.values), ...Object.keys(phase.values)])
    for (const parameter of keys) {
      before[parameter] = accumulatedBefore(phases, holdIndex, parameter)
    }
    const span = Math.max(1, phase.atMs - previous.atMs)
    const progress = clamp((elapsedMs - previous.atMs) / span, 0, 1)
    // Smoothstep the approach: fast commitment, soft landing.
    const eased = progress * progress * (3 - 2 * progress)
    const result: Record<string, number> = {}
    for (const [parameter, value] of Object.entries(accumulated)) {
      const from = before[parameter] ?? 0
      result[parameter] = from + (value - from) * eased
    }
    if (elapsedMs >= phase.atMs && phase.loop && phase.holdLoopMs) {
      applyHoldLoop(result, phase, elapsedMs - phase.atMs)
    }
    return result
  }
  // Single-phase script (rare): apply loop directly past its time.
  if (elapsedMs >= phase.atMs && phase.loop && phase.holdLoopMs) {
    const result = { ...accumulated }
    applyHoldLoop(result, phase, elapsedMs - phase.atMs)
    return result
  }
  return { ...accumulated }
}

function accumulatedBefore(
  phases: readonly PostureScriptPhase[],
  index: number,
  parameter: string,
): number {
  let value = 0
  for (let i = 0; i < index; i += 1) {
    const phaseValue = phases[i]!.values[parameter]
    if (phaseValue !== undefined) value = phaseValue
  }
  return value
}

function applyHoldLoop(
  target: Record<string, number>,
  phase: PostureScriptPhase,
  sinceHoldMs: number,
): void {
  const period = phase.holdLoopMs ?? 4000
  const phase01 = (Math.sin(sinceHoldMs / period * Math.PI * 2) + 1) / 2
  for (const [parameter, amplitude] of Object.entries(phase.loop ?? {})) {
    target[parameter] = (target[parameter] ?? 0) + amplitude * phase01
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function scalePostures(
  source: Readonly<Record<string, Posture>>,
  factor: number,
): Record<string, Posture> {
  return Object.fromEntries(Object.entries(source).map(([emotion, posture]) => [
    emotion,
    Object.fromEntries(Object.entries(posture).map(([parameter, value]) => [
      parameter,
      Math.round(value * factor * 10) / 10,
    ])),
  ]))
}

/** Authored behavior beats, keyed by behavior name (greet/agree/...). Behaviors
 *  are actions rather than moods, so they keep their own namespace.
 *
 *  NOT a motion alias table: semanticMotionMap (profile) decides WHICH preset
 *  plays for a behavior; BEHAVIOR_BEATS feeds PerformanceDirector's beat
 *  scheduling — the TIMED primitive sequence used to complete/supplement LLM
 *  motion plans during speech. Two concerns, two tables. */
export const BEHAVIOR_BEATS: Readonly<Record<string, readonly MotionPrimitive[]>> = {
  greet: ['lean_forward', 'tilt_right', 'nod'],
  agree: ['nod', 'lean_forward', 'nod'],
  disagree: ['tilt_left', 'lean_back', 'tilt_right'],
  think: ['look_left', 'tilt_right', 'breathe'],
  laugh: ['lean_forward', 'sway', 'nod'],
  comfort: ['lean_forward', 'breathe', 'tilt_left'],
  wave: ['sway', 'lean_forward', 'tilt_right'],
  nod: ['nod', 'lean_forward', 'nod'],
  tilt: ['tilt_left', 'lean_forward', 'tilt_right'],
  shrug: ['shrug', 'lean_back', 'tilt_left'],
}

/** Co-speech beats per emotion, keyed by the LLM's emotion label. */
const EMOTION_BEATS: Readonly<Record<string, readonly MotionPrimitive[]>> = {
  neutral: ['lean_forward', 'tilt_left', 'nod'],
  calm: ['breathe', 'tilt_right', 'lean_forward'],
  happy: ['lean_forward', 'tilt_right', 'nod'],
  playful: ['tilt_right', 'sway', 'nod'],
  love: ['lean_forward', 'tilt_left', 'breathe'],
  joyful: ['lean_forward', 'sway', 'nod'],
  cheerful: ['nod', 'sway', 'lean_forward'],
  surprised: ['lean_back', 'tilt_left', 'breathe'],
  shy: ['tilt_left', 'lean_back', 'breathe'],
  embarrassed: ['tilt_right', 'lean_back', 'breathe'],
  sad: ['breathe', 'lean_back', 'tilt_left'],
  cry: ['breathe', 'lean_back', 'tilt_left'],
  worried: ['lean_forward', 'tilt_right', 'breathe'],
  angry: ['lean_forward', 'nod', 'lean_back'],
  pout: ['lean_back', 'tilt_right', 'breathe'],
  confused: ['tilt_left', 'look_right', 'breathe'],
}

/** Sustained stance for an emotion in the given set, or null when it has none. */
export function emotionPosture(
  emotion: string | undefined,
  preset: string = 'lively',
): Readonly<Record<string, number>> | null {
  const set = preset === 'lively' ? POSTURE_SETS.lively : POSTURE_SETS.natural
  return set[emotion ?? ''] ?? null
}

/** Co-speech beats for an emotion, when authored. */
export function emotionBeats(emotion: string): readonly MotionPrimitive[] | undefined {
  return EMOTION_BEATS[emotion]
}

/**
 * Idle-beat tinting: per-emotion multipliers over the idle action pick pool,
 * so a mood keeps performing while "just standing there". Multipliers, not
 * overrides — personality/VAD weights keep their vote (see weightedPick).
 * Labels are IdleActionScheduler's (accessory phrases included: playful
 * idles tease with the ears, angry ones flick the tail).
 */
export const IDLE_TINTS: Readonly<Record<string, Readonly<Record<string, number>>>> = {
  // joy family: lively, teasing
  joyful: { 'small-nod': 1.8, 'ear-flick': 2.2, 'tail-sweep': 1.8, 'sigh-sink': 0.2, 'look-back': 0.5 },
  cheerful: { 'small-nod': 1.6, 'ear-flick': 1.6, 'tail-sweep': 1.5, 'sigh-sink': 0.3 },
  laughing: { 'ear-flick': 2.0, 'tail-sweep': 2.2, 'big-tilt': 1.2, 'sigh-sink': 0.1 },
  happy: { 'small-nod': 1.4, 'tail-sweep': 1.3, 'sigh-sink': 0.4 },
  playful: { 'ear-flick': 2.6, 'tail-sweep': 1.6, 'big-tilt': 1.4, 'sigh-sink': 0.1 },
  // love family: soft, stolen glances
  love: { 'look-back': 2.2, 'look-around': 1.6, 'big-tilt': 0.5, 'ear-flick': 0.6 },
  shy: { 'look-back': 2.4, 'slow-blink': 1.8, 'look-around': 1.2, 'ear-flick': 0.4, 'big-tilt': 0.4 },
  embarrassed: { 'look-back': 2.0, 'slow-blink': 1.6, 'ear-flick': 0.5 },
  // angry family: tension, no softness
  angry: { 'ear-flick': 1.8, 'tail-sweep': 1.7, 'look-around': 0.4, 'sigh-sink': 0.2, 'look-back': 0.3 },
  pout: { 'look-back': 1.8, 'slow-blink': 1.5, 'look-around': 0.6, 'small-nod': 0.3 },
  // sad family: sinking
  sad: { 'sigh-sink': 2.4, 'look-back': 1.4, 'micro-stretch': 0.3, 'ear-flick': 0.2, 'big-tilt': 0.2 },
  cry: { 'sigh-sink': 2.6, 'slow-blink': 1.4, 'ear-flick': 0.2, 'micro-stretch': 0.2 },
  worried: { 'sigh-sink': 1.6, 'look-back': 1.8, 'tail-sweep': 0.4 },
  // surprise resolves quickly; curious idles while it lasts
  surprised: { 'small-nod': 1.2, 'ear-flick': 1.6, 'look-around': 0.6 },
  confused: { 'look-back': 1.8, 'head-tilt': 1.8, 'sigh-sink': 0.5 },
  calm: { 'slow-blink': 1.6, 'micro-stretch': 1.4, 'look-around': 1.2, 'big-tilt': 0.4 },
  sleepy: { 'slow-blink': 2.2, 'sigh-sink': 1.5, 'micro-stretch': 0.5, 'ear-flick': 0.2 },
}
