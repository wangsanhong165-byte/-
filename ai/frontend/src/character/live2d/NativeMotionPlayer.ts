export type NativeMotionContribution =
  | {
      target: 'parameter'
      parameterId: string
      value: number
      weight: number
    }
  | {
      target: 'partOpacity'
      partId: string
      opacity: number
      weight: number
    }

interface NativeMotionCurve {
  Target: string
  Id: string
  Segments: number[]
  FadeInTime?: number
  FadeOutTime?: number
}

interface NativeMotionJson {
  Meta?: { Duration?: number; Loop?: boolean }
  FadeInTime?: number
  FadeOutTime?: number
  Curves?: NativeMotionCurve[]
}

interface RegisteredMotion {
  json: NativeMotionJson
  duration: number
  fadeIn: number
  fadeOut: number
  loop: boolean
}

export class NativeMotionPlayer {
  private motions = new Map<string, RegisteredMotion>()
  private active: RegisteredMotion | null = null
  private activeName: string | null = null
  private elapsed = 0
  private intensity = 1
  private hasLooped = false
  // Release mode: time freezes at the interrupt moment while the contribution
  // weight decays, so a cancelled motion glides out instead of snapping.
  private release: { fadeOutSeconds: number; releasedSeconds: number; frozenElapsed: number } | null = null

  register(name: string, json: NativeMotionJson, aliases: string[] = []): void {
    const motion: RegisteredMotion = {
      json,
      duration: Math.max(0.001, json.Meta?.Duration ?? inferDuration(json.Curves ?? [])),
      fadeIn: Math.max(0.18, json.FadeInTime ?? 0.25),
      fadeOut: Math.max(0.3, Math.min(0.6, json.FadeOutTime ?? 0.35)),
      loop: Boolean(json.Meta?.Loop),
    }
    for (const key of [name, ...aliases]) {
      if (key) this.motions.set(key.toLowerCase(), motion)
    }
  }

  has(name: string): boolean {
    return this.motions.has(name.toLowerCase())
  }

  list(): string[] {
    return [...this.motions.keys()]
  }

  play(name: string, intensity = 1): boolean {
    const motion = this.motions.get(name.toLowerCase())
    if (!motion) return false
    this.active = motion
    this.activeName = name
    this.elapsed = 0
    this.hasLooped = false
    this.intensity = clamp(intensity, 0, 2)
    this.release = null
    return true
  }

  stop(): void {
    this.active = null
    this.activeName = null
    this.elapsed = 0
    this.hasLooped = false
    this.release = null
  }

  /** Freeze the current pose and fade this motion's contributions to zero. */
  beginRelease(fadeOutMs: number): void {
    if (!this.active || this.release) return
    this.release = {
      fadeOutSeconds: clamp(fadeOutMs, 120, 600) / 1000,
      releasedSeconds: 0,
      frozenElapsed: this.elapsed,
    }
  }

  update(dt: number): { contributions: NativeMotionContribution[]; done: boolean } {
    if (!this.active) return { contributions: [], done: true }
    const motion = this.active
    let releaseWeight = 1
    if (this.release) {
      this.release.releasedSeconds += Math.max(0, dt)
      const progress = this.release.releasedSeconds / this.release.fadeOutSeconds
      if (progress >= 1) {
        this.stop()
        return { contributions: [], done: true }
      }
      releaseWeight = 1 - smoothstep(progress)
      this.elapsed = this.release.frozenElapsed
    } else {
      this.elapsed += Math.max(0, dt)
    }
    if (motion.loop && !this.release && this.elapsed >= motion.duration) {
      this.elapsed %= motion.duration
      this.hasLooped = true
    }
    const fadeInWeight = this.hasLooped ? 1 : smoothstep(this.elapsed / motion.fadeIn)
    const remaining = motion.duration - this.elapsed
    const fadeOutWeight = motion.loop ? 1 : smoothstep(remaining / motion.fadeOut)
    const weight = clamp(Math.min(fadeInWeight, fadeOutWeight) * this.intensity * releaseWeight, 0, 1)
    const contributions: NativeMotionContribution[] = []
    for (const curve of motion.json.Curves ?? []) {
      const value = sampleCurve(curve.Segments, Math.min(this.elapsed, motion.duration))
      const contributionWeight = curveWeight(
        curve, this.elapsed, motion.duration, motion.loop, this.hasLooped,
      ) * weight
      if (curve.Target === 'Parameter') {
        contributions.push({
          target: 'parameter',
          parameterId: curve.Id,
          value,
          weight: contributionWeight,
        })
      } else if (curve.Target === 'PartOpacity') {
        contributions.push({
          target: 'partOpacity',
          partId: curve.Id,
          opacity: clamp(value, 0, 1),
          weight: contributionWeight,
        })
      }
    }
    const done = !this.release && !motion.loop && this.elapsed >= motion.duration
    if (done) this.stop()
    return { contributions, done }
  }

  getDebugState(): Record<string, unknown> {
    return {
      name: this.activeName,
      elapsed: this.elapsed,
      available: this.motions.size,
    }
  }
}

export function sampleCurve(segments: number[], time: number): number {
  if (segments.length < 2) return 0
  let previousTime = segments[0]
  let previousValue = segments[1]
  let index = 2
  while (index < segments.length) {
    const segmentType = segments[index++]
    if (segmentType === 0) {
      const nextTime = segments[index++]
      const nextValue = segments[index++]
      if (time <= nextTime) return lerp(previousValue, nextValue, ratio(time, previousTime, nextTime))
      previousTime = nextTime
      previousValue = nextValue
    } else if (segmentType === 1) {
      const c1Time = segments[index++]
      const c1Value = segments[index++]
      const c2Time = segments[index++]
      const c2Value = segments[index++]
      const nextTime = segments[index++]
      const nextValue = segments[index++]
      if (time <= nextTime) {
        const t = solveBezierTime(time, previousTime, c1Time, c2Time, nextTime)
        return cubic(previousValue, c1Value, c2Value, nextValue, t)
      }
      previousTime = nextTime
      previousValue = nextValue
    } else if (segmentType === 2) {
      const nextTime = segments[index++]
      const nextValue = segments[index++]
      if (time <= nextTime) return previousValue
      previousTime = nextTime
      previousValue = nextValue
    } else if (segmentType === 3) {
      const nextTime = segments[index++]
      const nextValue = segments[index++]
      if (time <= nextTime) return nextValue
      previousTime = nextTime
      previousValue = nextValue
    } else {
      break
    }
  }
  return previousValue
}

function curveWeight(
  curve: NativeMotionCurve,
  elapsed: number,
  duration: number,
  loop: boolean,
  hasLooped: boolean,
): number {
  const fadeIn = curve.FadeInTime
  const fadeOut = curve.FadeOutTime
  const inWeight = hasLooped || fadeIn === undefined || fadeIn < 0
    ? 1 : smoothstep(elapsed / Math.max(.18, fadeIn))
  const outWeight = loop || fadeOut === undefined || fadeOut < 0
    ? 1 : smoothstep((duration - elapsed) / Math.max(.3, Math.min(.6, fadeOut)))
  return clamp(Math.min(inWeight, outWeight), 0, 1)
}
function inferDuration(curves: NativeMotionCurve[]): number {
  let duration = 0
  for (const curve of curves) {
    const values = curve.Segments
    for (let index = 0; index < values.length; index += 1) {
      if (Number.isFinite(values[index])) duration = Math.max(duration, values[index])
    }
  }
  return duration || 1
}
function solveBezierTime(target: number, p0: number, p1: number, p2: number, p3: number): number {
  let low = 0
  let high = 1
  for (let index = 0; index < 10; index += 1) {
    const mid = (low + high) / 2
    if (cubic(p0, p1, p2, p3, mid) < target) low = mid
    else high = mid
  }
  return (low + high) / 2
}
function cubic(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const u = 1 - t
  return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3
}
function ratio(value: number, min: number, max: number): number {
  return clamp((value - min) / Math.max(.000001, max - min), 0, 1)
}
function lerp(from: number, to: number, amount: number): number {
  return from + (to - from) * amount
}
function smoothstep(value: number): number {
  const t = clamp(value, 0, 1)
  return t * t * (3 - 2 * t)
}
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}
