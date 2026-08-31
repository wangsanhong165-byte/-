import type { MotionStyleOptions } from './performance/MotionStyle'
import type { ExpressionParameterPolicy } from './ExpressionParameterController'

export interface CharacterPerformancePersonality {
  expressiveness: number
  softness: number
  shyness: number
  gazeStability?: number
}

export interface AvatarPerformanceCapabilities {
  headControl?: boolean
  bodyControl?: boolean
  gazeControl?: boolean
  browControl?: boolean
  eyeBlink?: boolean
  mouthControl?: boolean
  mouthForm?: boolean
  breathControl?: boolean
}

export interface AvatarParameterBinding {
  target: string
  neutral?: number
  scale?: number
  min?: number
  max?: number
  mode?: 'set' | 'add' | 'subtract'
  smoothing?: number
}

export type PerformanceMode = 'legacy' | 'enhanced' | 'calibration'

export interface AvatarLipSyncConfig {
  min?: number
  max?: number
  inputGain?: number
  noiseGate?: number
  attackMs?: number
  releaseMs?: number
  peakBoost?: number
}

export interface AvatarViewportConfig {
  x?: number
  y?: number
  scale?: number
}

/** Native motion ownership is separate from renderer parameter IDs. */
export type AvatarNativeMotionChannel =
  | 'head'
  | 'body'
  | 'gaze'
  | 'expression'
  | 'mouth'
  | 'arms'
  | 'accessory'
  | 'secondary'
  | 'full'

export interface AvatarLogicalMotionKeyframe {
  time: number
  parameter: string
  value: number
}

/** Authored model data uses stable logical names, never Cubism parameter IDs. */
export interface AvatarLogicalMotionPreset {
  name: string
  duration: number
  fadeInMs?: number
  recoveryMs?: number
  keyframes: AvatarLogicalMotionKeyframe[]
}

export interface AvatarPrivateEmotionBinding {
  target: string
  emotions?: string[]
  valence?: number
  arousal?: number
  dominance?: number
  threshold?: number
  neutral?: number
  scale?: number
  min?: number
  max?: number
}

export type AvatarPrivateEmotionMap = Record<string, AvatarPrivateEmotionBinding>

export interface AvatarCapabilityProfile {
  model: string
  expressions: string[]
  motions: string[]
  sequences?: string[]
  parameters: Record<string, Record<string, string>>
  bindings: Record<string, string | AvatarParameterBinding>
  motionStyle?: MotionStyleOptions
  personality?: CharacterPerformancePersonality
  capabilities?: AvatarPerformanceCapabilities
  motionMap?: Record<string, string>
  /** Semantic intent cues (behavior, emotion, or context tag) mapped to executable motions. */
  semanticMotionMap?: Record<string, string>
  /** Native motion ownership by semantic/native motion name. */
  nativeMotionChannels?: Record<string, AvatarNativeMotionChannel[]>
  /** Model-specific authored timelines expressed only in logical parameters. */
  logicalMotionPresets?: AvatarLogicalMotionPreset[]
  expressionMap?: Record<string, string>
  parameterGain?: number
  bodyMotionGain?: number
  performanceMode?: PerformanceMode
  privateEmotionMap?: AvatarPrivateEmotionMap
  /** Logical parameters that semantic/native motion plans may not own. */
  protectedMotionParameters?: string[]
  lipSync?: AvatarLipSyncConfig
  expressionParameterPolicy?: ExpressionParameterPolicy
  /** Small per-model silent opening used only while authored native idle is active. */
  idleMouthOpen?: number
  /**
   * Raw model params that mouth-deforming expression assets (pout faces etc.)
   * drive and that lip-sync must visually own during speech. Released from
   * expression ownership whenever audio plays, restored afterwards.
   */
  speechMouthParams?: string[]
  /** Model-specific gain for the logical breath input used by physics rigs. */
  breathMotionGain?: number
  /** Model-specific initial framing for assets whose Cubism canvas origin is off-center. */
  viewport?: AvatarViewportConfig
  /** Independent whole-character framing used by the transparent desktop-pet canvas. */
  petViewport?: AvatarViewportConfig
}

export function normalizeAvatarViewport(
  value: AvatarViewportConfig | undefined,
): { x: number; y: number; scale: number } {
  return {
    x: clampFinite(value?.x, -1.5, 1.5, 0),
    y: clampFinite(value?.y, -1.5, 1.5, 0),
    scale: clampFinite(value?.scale, 0.35, 2.5, 1),
  }
}

function clampFinite(
  value: number | undefined,
  min: number,
  max: number,
  fallback: number,
): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(min, Math.min(max, value))
    : fallback
}

export function supportsExpression(profile: AvatarCapabilityProfile | undefined, name: string): boolean {
  return !profile
    || profile.expressions.length === 0
    || profile.expressions.includes(name)
    || Object.prototype.hasOwnProperty.call(profile.expressionMap ?? {}, name)
}

export function supportsMotion(profile: AvatarCapabilityProfile | undefined, name: string): boolean {
  return !profile || profile.motions.length === 0 || profile.motions.includes(name)
}

export function shouldStartAuthoredIdle(
  profile: Pick<AvatarCapabilityProfile, 'motions'> | undefined,
): boolean {
  return Boolean(profile?.motions.includes('idle'))
}

export function supportsSequence(profile: AvatarCapabilityProfile | undefined, name: string): boolean {
  return Boolean(profile?.sequences?.includes(name))
}
