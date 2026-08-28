import { createSeededRandom, type RandomSource } from './SeededRandom.ts'

export interface BodySwaySample {
  headX: number
  headY: number
  headZ: number
  bodyX: number
  bodyY: number
}

interface BodySwayRanges {
  headX: readonly [number, number]
  headY: readonly [number, number]
  headZ: readonly [number, number]
  bodyX: readonly [number, number]
  bodyY: readonly [number, number]
}

const defaultRanges: BodySwayRanges = {
  headX: [-3, 3],
  headY: [-1.8, 1.9],
  headZ: [-3.5, 3.5],
  bodyX: [-4.5, 4.5],
  bodyY: [-1.8, 1.8],
}

export class BodySwayController {
  private random: RandomSource
  private readonly ranges: BodySwayRanges
  private current = neutralSample()
  private target = neutralSample()
  private velocity = neutralSample()
  private lastTime = 0
  private holdUntil = 0

  constructor(seed = 29, ranges = defaultRanges) {
    this.random = createSeededRandom(seed)
    this.ranges = ranges
  }

  reset(seed = 29): void {
    this.random = createSeededRandom(seed)
    this.current = neutralSample()
    this.target = neutralSample()
    this.velocity = neutralSample()
    this.lastTime = 0
    this.holdUntil = 0
  }

  update(timeSeconds: number, focusLevel: number, gain = 1): BodySwaySample {
    const focus = clamp(focusLevel, 0, 1)
    const weight = clamp(gain, 0, 2)
    const dt = clamp(this.lastTime > 0 ? timeSeconds - this.lastTime : 1 / 60, 0, 0.05)
    this.lastTime = timeSeconds
    if (focus > 0.5) {
      this.target = neutralSample()
    } else if (timeSeconds >= this.holdUntil) {
      this.pickNextTarget(timeSeconds)
    }

    const baseFrequency = focus > 0.5 ? 0.72 : 0.34
    for (const key of sampleKeys) {
      const frequency = key.startsWith('head') ? baseFrequency * 1.18 : baseFrequency
      stepSpring(this.current, this.velocity, this.target, key, dt, frequency, 0.82)
    }
    return scaleSample(this.current, weight)
  }

  getKinematics(): { value: BodySwaySample; velocity: BodySwaySample } {
    return { value: { ...this.current }, velocity: { ...this.velocity } }
  }

  private pickNextTarget(timeSeconds: number): void {
    const bodyX = this.pickValue('bodyX')
    const bodyY = this.pickValue('bodyY')
    this.target = {
      bodyX,
      bodyY,
      headX: clamp(this.pickValue('headX') - bodyX * 0.32, ...this.ranges.headX),
      headY: clamp(this.pickValue('headY') + bodyY * 0.42, ...this.ranges.headY),
      headZ: clamp(this.pickValue('headZ') - bodyX * 0.24, ...this.ranges.headZ),
    }
    this.holdUntil = timeSeconds + 1.8 + this.random() * 2.7
  }

  private pickValue(key: keyof BodySwayRanges): number {
    const [min, max] = this.ranges[key]
    const centerBias = this.random() < 0.22 ? 0.38 : 1
    const center = (min + max) / 2
    const half = ((max - min) / 2) * centerBias
    return center - half + this.random() * half * 2
  }
}

const sampleKeys: Array<keyof BodySwaySample> = [
  'headX', 'headY', 'headZ', 'bodyX', 'bodyY',
]

function neutralSample(): BodySwaySample {
  return { headX: 0, headY: 0, headZ: 0, bodyX: 0, bodyY: 0 }
}

function scaleSample(sample: BodySwaySample, weight: number): BodySwaySample {
  return {
    headX: sample.headX * weight,
    headY: sample.headY * weight,
    headZ: sample.headZ * weight,
    bodyX: sample.bodyX * weight,
    bodyY: sample.bodyY * weight,
  }
}

function stepSpring(
  value: BodySwaySample,
  velocity: BodySwaySample,
  target: BodySwaySample,
  key: keyof BodySwaySample,
  dt: number,
  frequencyHz: number,
  dampingRatio: number,
): void {
  const omega = Math.PI * 2 * frequencyHz
  const acceleration = (target[key] - value[key]) * omega * omega
    - 2 * dampingRatio * omega * velocity[key]
  velocity[key] += acceleration * dt
  value[key] += velocity[key] * dt
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}
