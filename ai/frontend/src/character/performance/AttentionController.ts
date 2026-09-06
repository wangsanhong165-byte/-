export type AttentionTarget = 'user' | 'screen' | 'away' | 'neutral'

export class AttentionController {
  private target: AttentionTarget = 'neutral'
  private weight = 0
  private awaySign: 1 | -1
  private remainingSeconds = Infinity
  /**
   * The away-offset values last emitted while turning away. When the away
   * glance ends (timer expiry or a retarget), these are held and faded out by
   * the weight instead of being zeroed — zeroing them teleported the head back
   * to center in a single frame (the "thinking 态闪现回正" report).
   */
  private lastAwayValues: Record<string, number> | null = null

  constructor(seed = 1) {
    this.awaySign = seed % 2 === 0 ? -1 : 1
  }

  set(target: AttentionTarget, durationMs?: number): void {
    if (target === 'away' && this.target !== 'away') this.awaySign = this.awaySign === 1 ? -1 : 1
    this.target = target
    this.remainingSeconds = durationMs === undefined ? Infinity : Math.max(0.3, durationMs / 1000)
  }

  reset(): void {
    this.target = 'neutral'
    this.weight = 0
    this.remainingSeconds = Infinity
    this.lastAwayValues = null
  }

  update(dt: number): { values: Record<string, number>; weight: number } {
    if (Number.isFinite(this.remainingSeconds)) {
      this.remainingSeconds -= Math.max(0, dt)
      if (this.remainingSeconds <= 0) this.target = 'neutral'
    }
    const ownsAttention = this.target === 'screen' || this.target === 'away'
    // Screen ownership zeroes the offset by design (its values are centered),
    // so a pending away-fade must not resurrect the stale glance afterwards.
    if (this.target === 'screen') this.lastAwayValues = null
    const targetWeight = ownsAttention ? 1 : 0
    // 'away' (thinking recall glance) rises gently so a mid-swing flip reads as
    // turning the head, not a whip-pan; the glide back out of 'away' uses the
    // same gentle rate so the return is the mirror of the turn. Other targets
    // keep the snappy response.
    const returningFromAway = !ownsAttention && this.lastAwayValues !== null
    const riseRate = this.target === 'away' || returningFromAway ? 2.6 : 8
    this.weight += (targetWeight - this.weight) * (1 - Math.exp(-Math.max(0, dt) * riseRate))
    if (this.weight < 0.001 && !ownsAttention) {
      this.weight = 0
      this.lastAwayValues = null
      return { values: {}, weight: 0 }
    }
    if (this.target === 'away') {
      this.lastAwayValues = {
        'eye.x': this.awaySign * 0.3,
        'eye.y': 0.04,
        'head.x': this.awaySign * 4.2,
        'head.y': 0.5,
      }
      return {
        values: this.lastAwayValues,
        weight: this.weight,
      }
    }
    if (returningFromAway) {
      // Hold the away offset while the weight glides it out. Returning zeros
      // here made the whole glance vanish in one frame.
      return {
        values: this.lastAwayValues!,
        weight: this.weight,
      }
    }
    return {
      values: { 'eye.x': 0, 'eye.y': 0, 'head.x': 0, 'head.y': 0 },
      weight: this.weight,
    }
  }
}
