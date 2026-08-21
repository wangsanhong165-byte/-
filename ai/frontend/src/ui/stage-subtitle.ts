export const STAGE_SUBTITLE_DURATION_MS = 4500

export function isStageSubtitleVisible(
  shownAt: number,
  now: number,
  durationMs = STAGE_SUBTITLE_DURATION_MS,
): boolean {
  return now - shownAt < durationMs
}

export function stageSubtitleAutoHideDelay(speaking: boolean): number | null {
  return speaking ? null : STAGE_SUBTITLE_DURATION_MS
}

export function toStageSubtitle(text: string): string {
  return text.trim()
}
