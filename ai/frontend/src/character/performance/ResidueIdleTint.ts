/** Backend classify_residue → idle tint. The frontend never holds the
 *  conversation transcript, so the command fires with NO payload and the
 *  backend self-serves the freshest turns from its own recorder
 *  (docs/semantic_services.md). Fail-open everywhere: throttle, 500ms
 *  timeout and any error keep the previous tint (null = current behavior).
 */

export interface ResidueIdleProfile {
  label: string
  energy: number
  expressionHint: string
  gestureTendency: string
}

export type ResidueRequest = (
  action: string,
  params?: Record<string, unknown>,
) => Promise<Record<string, unknown>>

const MIN_INTERVAL_MS = 90_000
const DEFAULT_TIMEOUT_MS = 500

let _request: ResidueRequest | null = null
let _profile: ResidueIdleProfile | null = null
let _lastRefreshAt = 0
let _inFlight = false

/** Inject the command transport once (session layer owns the client). */
export function configureResidueRequest(request: ResidueRequest | null): void {
  _request = request
}

export function getResidueProfile(): ResidueIdleProfile | null {
  return _profile
}

export function resetResidueForTests(): void {
  _request = null
  _profile = null
  _lastRefreshAt = 0
  _inFlight = false
}

/** Fire classify_residue (throttled to one request per idle episode's
 *  MIN_INTERVAL; resolved or abandoned within timeoutMs). Returns true when
 *  a fresh matched profile was stored. */
export async function refreshResidueTint(
  now: number = Date.now(),
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<boolean> {
  if (!_request || _inFlight) return false
  if (now - _lastRefreshAt < MIN_INTERVAL_MS) return false
  _inFlight = true
  _lastRefreshAt = now
  try {
    const data = await Promise.race([
      _request('classify_residue'),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
    ])
    if (data && data.matched === true) {
      const raw = (data.idle_profile ?? {}) as Record<string, unknown>
      _profile = {
        label: String(data.label ?? ''),
        energy: clampNumber(Number(raw.energy ?? 0.5), 0, 1),
        expressionHint: String(raw.expression_hint ?? 'neutral'),
        gestureTendency: String(raw.gesture_tendency ?? 'ambient'),
      }
      return true
    }
    if (data && data.matched === false) _profile = null
    return false
  } catch {
    return false
  } finally {
    _inFlight = false
  }
}

/** Idle energy scale from the residue profile: 0.3-0.7 profile energy maps
 *  to a 0.6-1.5 multiplier around the 0.5 neutral base. No profile → 1. */
export function residueEnergyScale(profile: ResidueIdleProfile | null): number {
  if (!profile) return 1
  return clampNumber(profile.energy / 0.5, 0.6, 1.5)
}

/** Idle action-pool tint emotion: a live segment emotion always wins; when
 *  the segment is neutral the residue expression hint becomes the base
 *  mood (the "leftover atmosphere" of the last exchange). */
export function residuePoolEmotion(
  profile: ResidueIdleProfile | null,
  segmentEmotion: string,
): string {
  const emotion = (segmentEmotion || 'neutral').trim()
  if (emotion !== 'neutral') return emotion
  return profile?.expressionHint || 'neutral'
}

function clampNumber(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Number.isFinite(value) ? value : lo))
}
