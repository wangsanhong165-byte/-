export interface FrameTimingSample {
  intervalMs: number
  workMs: number
  controllerMs: number
  mixMs: number
  modelMs: number
  renderMs: number
}

export interface PhaseTimingStats {
  averageMs: number
  p95Ms: number
  p99Ms: number
  maxMs: number
}

export type FrameTimingPhase = 'work' | 'controller' | 'mix' | 'model' | 'render'

export interface FrameTimingSnapshot extends FrameTimingSample {
  sampleCount: number
  averageIntervalMs: number
  p95IntervalMs: number
  p99IntervalMs: number
  maxIntervalMs: number
  longFrameCount: number
  phases: Record<FrameTimingPhase, PhaseTimingStats>
}

const EMPTY_SAMPLE: FrameTimingSample = {
  intervalMs: 0,
  workMs: 0,
  controllerMs: 0,
  mixMs: 0,
  modelMs: 0,
  renderMs: 0,
}

const EMPTY_PHASE: PhaseTimingStats = {
  averageMs: 0,
  p95Ms: 0,
  p99Ms: 0,
  maxMs: 0,
}

/** Bounded recorder: every frame is observed, snapshots are emitted at 4 Hz. */
export class FrameTimingMonitor {
  private readonly samples: Array<FrameTimingSample | undefined>
  private readonly capacity: number
  private writeIndex = 0
  private sampleCount = 0

  constructor(capacity = 240) {
    this.capacity = Math.max(30, Math.round(capacity))
    this.samples = new Array(this.capacity)
  }

  record(sample: FrameTimingSample): void {
    this.samples[this.writeIndex] = {
      intervalMs: finite(sample.intervalMs),
      workMs: finite(sample.workMs),
      controllerMs: finite(sample.controllerMs),
      mixMs: finite(sample.mixMs),
      modelMs: finite(sample.modelMs),
      renderMs: finite(sample.renderMs),
    }
    this.writeIndex = (this.writeIndex + 1) % this.capacity
    this.sampleCount = Math.min(this.sampleCount + 1, this.capacity)
  }

  snapshot(): FrameTimingSnapshot {
    if (!this.sampleCount) {
      const latest = EMPTY_SAMPLE
      return {
        ...latest,
        sampleCount: 0,
        averageIntervalMs: 0,
        p95IntervalMs: 0,
        p99IntervalMs: 0,
        maxIntervalMs: 0,
        longFrameCount: 0,
        phases: {
          work: { ...EMPTY_PHASE },
          controller: { ...EMPTY_PHASE },
          mix: { ...EMPTY_PHASE },
          model: { ...EMPTY_PHASE },
          render: { ...EMPTY_PHASE },
        },
      }
    }
    const latestIndex = (this.writeIndex - 1 + this.capacity) % this.capacity
    const latest = this.samples[latestIndex] ?? EMPTY_SAMPLE
    const orderedSamples = new Array<FrameTimingSample>(this.sampleCount)
    for (let index = 0; index < this.sampleCount; index += 1) {
      const sampleIndex = (this.writeIndex - this.sampleCount + index + this.capacity) % this.capacity
      orderedSamples[index] = this.samples[sampleIndex] ?? EMPTY_SAMPLE
    }
    const intervals = orderedSamples.map(sample => sample.intervalMs).sort((a, b) => a - b)
    const total = intervals.reduce((sum, value) => sum + value, 0)
    return {
      ...latest,
      sampleCount: intervals.length,
      averageIntervalMs: total / intervals.length,
      p95IntervalMs: percentile(intervals, 0.95),
      p99IntervalMs: percentile(intervals, 0.99),
      maxIntervalMs: intervals.at(-1) ?? 0,
      longFrameCount: intervals.filter(value => value > 33.34).length,
      phases: {
        work: summarize(orderedSamples.map(sample => sample.workMs)),
        controller: summarize(orderedSamples.map(sample => sample.controllerMs)),
        mix: summarize(orderedSamples.map(sample => sample.mixMs)),
        model: summarize(orderedSamples.map(sample => sample.modelMs)),
        render: summarize(orderedSamples.map(sample => sample.renderMs)),
      },
    }
  }
}

function summarize(values: number[]): PhaseTimingStats {
  const ordered = values.sort((a, b) => a - b)
  const total = ordered.reduce((sum, value) => sum + value, 0)
  return {
    averageMs: total / ordered.length,
    p95Ms: percentile(ordered, 0.95),
    p99Ms: percentile(ordered, 0.99),
    maxMs: ordered.at(-1) ?? 0,
  }
}

function percentile(ordered: number[], ratio: number): number {
  if (!ordered.length) return 0
  return ordered[Math.min(ordered.length - 1, Math.floor(ordered.length * ratio))]
}

function finite(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0
}
