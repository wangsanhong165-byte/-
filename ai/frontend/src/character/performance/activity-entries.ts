// Shared activity-entry performances — the per-activity behaviors that both
// the live controller (controllers.ts onActivityChange) and the pipeline
// harness (performance-pipeline-harness.ts ctx.transition) must execute
// IDENTICALLY. Each entry lives here so the two callers can never drift.
import type { MotionArbiter } from '../MotionArbiter.ts'
import type { AttentionController } from './AttentionController.ts'

/** Thinking entry: recall glance + authored thinking motion. The glance tracks
 *  the authored thinking motion length (Neuro reference: recall is preceded by
 *  a visible gaze-away beat) so both always end together. */
export function enterThinking(
  attention: AttentionController,
  arbiter: MotionArbiter,
  turnId: string | undefined,
): void {
  attention.set('away', arbiter.getPresetDuration('thinking') ?? 2_400)
  arbiter.request({
    name: 'thinking',
    owner: `state:${turnId ?? 'local'}`,
    source: 'system',
    priority: 55,
    channels: ['head', 'gaze'],
    turnId,
    intensity: 0.3,
  })
}
