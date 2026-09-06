/**
 * Leak arc scheduler — the timing skeleton of the dual-emotion performance.
 *
 * A long segment with a "true feeling under the surface" (leak) plays three
 * faces: the surface holds past the midpoint, the leak slips through at ~55%
 * (0.45× intensity, floored at 0.3), then the surface reasserts at ~90%
 * (0.8×) for the exit. Extracted from controllers.ts so the TIMING CONTRACT
 * is unit-testable without the whole controller.
 *
 * Short segments (< minDurationMs) get no arc — the surface face holds.
 */
export interface LeakArcSpec {
  /** Surface expression (what words and the first half project). */
  surface: string
  /** True feeling that slips through mid-segment. */
  leak: string
  /** Segment-level expression intensity (already personality-scaled). */
  surfaceIntensity: number
  durationMs: number
}

export interface LeakArcHooks {
  apply: (expression: string, intensity: number, blendMs: number) => void
  schedule: (fn: () => void, delayMs: number) => ReturnType<typeof setTimeout>
  cancel: (handle: ReturnType<typeof setTimeout>) => void
}

export const LEAK_MIN_DURATION_MS = 1800

export function scheduleLeakArc(
  spec: LeakArcSpec,
  hooks: LeakArcHooks,
): Array<ReturnType<typeof setTimeout>> | null {
  if (spec.durationMs <= LEAK_MIN_DURATION_MS) return null
  const leakIntensity = Math.max(0.3, spec.surfaceIntensity * 0.45)
  const at = Math.round(spec.durationMs * 0.55)
  const back = Math.round(spec.durationMs * 0.9)
  return [
    hooks.schedule(() => hooks.apply(spec.leak, leakIntensity, 900), at),
    hooks.schedule(() => hooks.apply(spec.surface, spec.surfaceIntensity * 0.8, 700), back),
  ]
}

export function cancelLeakArc(
  handles: Array<ReturnType<typeof setTimeout>> | null,
  hooks: LeakArcHooks,
): void {
  handles?.forEach(handle => hooks.cancel(handle))
}
