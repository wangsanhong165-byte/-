import type { AvatarPrivateEmotionMap } from '../AvatarCapabilityProfile'
import type { VADVector } from './VADState'

export class PrivateEmotionOverlay {
  // Emotion flips are discrete while the mixer has no temporal dimension;
  // smooth the projected values so overlays ride the expression transition
  // instead of flashing in a single frame.
  private smoothed = new Map<string, number>()

  update(
    emotion: string,
    emotionIntensity: number,
    vad: VADVector,
    mappings: AvatarPrivateEmotionMap = {},
    deltaSeconds = 1 / 60,
  ): Record<string, number> {
    const result: Record<string, number> = {}
    const requested = new Set<string>()
    for (const mapping of Object.values(mappings)) {
      const emotionMatch = !mapping.emotions?.length
        || mapping.emotions.some(item => item.toLowerCase() === emotion.toLowerCase())
      const activation = Math.max(
        emotionMatch ? Math.max(0, Math.min(1, emotionIntensity)) : 0,
        Math.max(0, vad.valence * (mapping.valence ?? 0)),
        Math.max(0, vad.arousal * (mapping.arousal ?? 0)),
        Math.max(0, vad.dominance * (mapping.dominance ?? 0)),
      )
      const active = activation >= (mapping.threshold ?? 0.35)
      const value = (mapping.neutral ?? 0) + (active ? activation * (mapping.scale ?? 1) : 0)
      const clamped = Math.max(mapping.min ?? -Infinity, Math.min(mapping.max ?? Infinity, value))
      requested.add(mapping.target)
      const previous = this.smoothed.get(mapping.target) ?? clamped
      const eased = previous + (clamped - previous) * (1 - Math.exp(-deltaSeconds * 8))
      if (Math.abs(eased - clamped) < 0.001) this.smoothed.set(mapping.target, clamped)
      else this.smoothed.set(mapping.target, eased)
      result[mapping.target] = eased
    }
    for (const key of this.smoothed.keys()) {
      if (!requested.has(key)) this.smoothed.delete(key)
    }
    return result
  }
}
