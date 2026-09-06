export interface ScalarKeyframe {
  time: number
  value: number
}

/**
 * Shape-preserving cubic Hermite sampling.
 *
 * Two-point tracks ease in and out. Tracks with same-direction interior
 * keyframes carry velocity through the knot instead of stopping there, while
 * reversals keep moving: their tangent is a bounded Catmull-Rom momentum, so a
 * turning point follows through with a small overshoot-and-settle instead of
 * decelerating to a dead hover. The bound (2x the gentler neighbor slope)
 * keeps that overshoot a feel upgrade, not a slingshot past the authored
 * range — and per-frame continuity stays inside the scenario flash budget.
 */
export function sampleMotionCurve(
  unsorted: readonly ScalarKeyframe[],
  time: number,
): number {
  const frames = normalizeFrames(unsorted)
  if (!frames.length) return 0
  if (frames.length === 1 || time <= frames[0].time) return frames[0].value
  if (time >= frames[frames.length - 1].time) return frames[frames.length - 1].value

  const nextIndex = frames.findIndex(frame => frame.time >= time)
  const previousIndex = Math.max(0, nextIndex - 1)
  const previous = frames[previousIndex]
  const next = frames[nextIndex]
  const duration = Math.max(0.000001, next.time - previous.time)
  const progress = clamp((time - previous.time) / duration, 0, 1)
  const previousTangent = tangentAt(frames, previousIndex)
  const nextTangent = tangentAt(frames, nextIndex)
  const t2 = progress * progress
  const t3 = t2 * progress
  const h00 = 2 * t3 - 3 * t2 + 1
  const h10 = t3 - 2 * t2 + progress
  const h01 = -2 * t3 + 3 * t2
  const h11 = t3 - t2
  return h00 * previous.value
    + h10 * duration * previousTangent
    + h01 * next.value
    + h11 * duration * nextTangent
}

function normalizeFrames(frames: readonly ScalarKeyframe[]): ScalarKeyframe[] {
  const ordered = [...frames]
    .filter(frame => Number.isFinite(frame.time) && Number.isFinite(frame.value))
    .sort((left, right) => left.time - right.time)
  const unique: ScalarKeyframe[] = []
  for (const frame of ordered) {
    if (unique.at(-1)?.time === frame.time) unique[unique.length - 1] = frame
    else unique.push(frame)
  }
  return unique
}

function tangentAt(frames: readonly ScalarKeyframe[], index: number): number {
  if (index <= 0 || index >= frames.length - 1) return 0
  const previousDuration = Math.max(0.000001, frames[index].time - frames[index - 1].time)
  const nextDuration = Math.max(0.000001, frames[index + 1].time - frames[index].time)
  const previousSlope = (frames[index].value - frames[index - 1].value) / previousDuration
  const nextSlope = (frames[index + 1].value - frames[index].value) / nextDuration
  if (previousSlope === 0 || nextSlope === 0) return 0
  if (Math.sign(previousSlope) === Math.sign(nextSlope)) {
    // Same direction: carry velocity through the knot (harmonic mean).
    const leftWeight = 2 * nextDuration + previousDuration
    const rightWeight = nextDuration + 2 * previousDuration
    return (leftWeight + rightWeight)
      / (leftWeight / previousSlope + rightWeight / nextSlope)
  }
  // Reversal: momentum keeps flowing through the turn (Catmull-Rom over the
  // neighbor samples), bounded to 2x the gentler neighbor slope so the
  // follow-through dip stays a settle, never a slingshot past both extremes.
  const span = Math.max(0.000001, frames[index + 1].time - frames[index - 1].time)
  const momentum = (frames[index + 1].value - frames[index - 1].value) / span
  const bound = 2 * Math.min(Math.abs(previousSlope), Math.abs(nextSlope))
  return clamp(momentum, -bound, bound)
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}
