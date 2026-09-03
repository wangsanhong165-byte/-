// Expression presets — maps Runtime emotion names to Cubism parameter targets
// Supports both model-specific .exp3.json presets and hardcoded fallback presets.

import { PARAM_IDS as P } from './parameters.ts'

export interface ExpressionPreset {
  /** Target parameter values */
  params: Array<{
    id: string
    value: number
    blend?: 'add' | 'multiply' | 'overwrite'
  }>
  /** Part opacities to set */
  parts?: Array<{ id: string; opacity: number }>
}

// Common Cubism parameter ranges:
//   ParamMouthOpenY: 0 (closed) ~ 1 (open)
//   ParamEyeLOpen/R: 0 (closed) ~ 1 (open)
//   ParamBrowLY/R: -1 (down) ~ 0 (neutral) ~ 1 (up)
//   ParamAngleX: -30 (left) ~ 30 (right)
//   ParamAngleY: -30 (down) ~ 30 (up)
//   ParamAngleZ: -30 (left tilt) ~ 30 (right tilt)
//   ParamBodyAngleX: -30 ~ 30
//   ParamCheek: 0 ~ 1

// ── Built-in semantic presets (fallback when no model-specific expressions) ──

const HARDCODED_PRESETS: Record<string, ExpressionPreset> = {
  neutral: {
    params: [
      { id: P.BROW_L_Y, value: 0 },
      { id: P.BROW_R_Y, value: 0 },
      { id: P.EYE_L_OPEN, value: 1, blend: 'overwrite' },
      { id: P.EYE_R_OPEN, value: 1, blend: 'overwrite' },
      { id: P.MOUTH_OPEN_Y, value: 0 },
    ],
  },

  happy: {
    params: [
      { id: P.BROW_L_Y, value: 0.5 },
      { id: P.BROW_R_Y, value: 0.5 },
      { id: P.EYE_L_OPEN, value: 0.8, blend: 'overwrite' },
      { id: P.EYE_R_OPEN, value: 0.8, blend: 'overwrite' },
      { id: P.EYE_L_SMILE, value: 0.5 },
      { id: P.EYE_R_SMILE, value: 0.5 },
      { id: P.MOUTH_OPEN_Y, value: 0.2 },
      // Cheek is not a portable semantic parameter. On some models it is a
      // gentle blush; on this model it drives two oversized circular overlays.
      // Keep model-specific blush in the native expression map instead of
      // making the generic happy fallback write it.
    ],
  },

  calm: {
    params: [
      { id: P.BROW_L_Y, value: 0.12 },
      { id: P.BROW_R_Y, value: 0.12 },
      { id: P.EYE_L_OPEN, value: 0.78, blend: 'overwrite' },
      { id: P.EYE_R_OPEN, value: 0.78, blend: 'overwrite' },
      { id: P.EYE_L_SMILE, value: 0.18 },
      { id: P.EYE_R_SMILE, value: 0.18 },
      { id: P.MOUTH_OPEN_Y, value: 0.04 },
    ],
  },

  sad: {
    params: [
      // Presets tuned for perceptibility on shirone: the old -0.3 brow / 0.7
      // eye read as "nothing happened" against the standing reset face. Brow
      // shape curls the brow inward (grief), mouth form drops to a frown.
      { id: P.BROW_L_Y, value: -0.55 },
      { id: P.BROW_R_Y, value: -0.55 },
      { id: P.BROW_L_FORM, value: -0.6, blend: 'overwrite' },
      { id: P.BROW_R_FORM, value: -0.6, blend: 'overwrite' },
      { id: P.EYE_L_OPEN, value: 0.62, blend: 'overwrite' },
      { id: P.EYE_R_OPEN, value: 0.62, blend: 'overwrite' },
      { id: P.MOUTH_OPEN_Y, value: 0.1 },
      { id: P.MOUTH_FORM, value: -0.45, blend: 'overwrite' },
    ],
  },

  worried: {
    params: [
      { id: P.BROW_L_Y, value: 0.28 },
      { id: P.BROW_R_Y, value: 0.18 },
      { id: P.BROW_L_FORM, value: -0.4, blend: 'overwrite' },
      { id: P.BROW_R_FORM, value: -0.4, blend: 'overwrite' },
      { id: P.EYE_L_OPEN, value: 0.72, blend: 'overwrite' },
      { id: P.EYE_R_OPEN, value: 0.72, blend: 'overwrite' },
      { id: P.MOUTH_OPEN_Y, value: 0.08 },
      { id: P.MOUTH_FORM, value: -0.3, blend: 'overwrite' },
    ],
  },

  angry: {
    params: [
      { id: P.BROW_L_Y, value: -0.5 },
      { id: P.BROW_R_Y, value: -0.5 },
      { id: P.BROW_L_X, value: -0.3 },
      { id: P.BROW_R_X, value: 0.3 },
      { id: P.EYE_L_OPEN, value: 0.9, blend: 'overwrite' },
      { id: P.EYE_R_OPEN, value: 0.9, blend: 'overwrite' },
      { id: P.MOUTH_OPEN_Y, value: 0.3 },
    ],
  },

  surprised: {
    params: [
      { id: P.BROW_L_Y, value: 0.8 },
      { id: P.BROW_R_Y, value: 0.8 },
      { id: P.EYE_L_OPEN, value: 1.2, blend: 'overwrite' },
      { id: P.EYE_R_OPEN, value: 1.2, blend: 'overwrite' },
      { id: P.MOUTH_OPEN_Y, value: 0.5 },
    ],
  },

  shy: {
    params: [
      { id: P.BROW_L_Y, value: 0.2 },
      { id: P.BROW_R_Y, value: 0.2 },
      { id: P.EYE_L_OPEN, value: 0.6, blend: 'overwrite' },
      { id: P.EYE_R_OPEN, value: 0.6, blend: 'overwrite' },
      { id: P.MOUTH_OPEN_Y, value: 0.05 },
      { id: P.CHEEK, value: 0.6 },
    ],
  },

  thinking: {
    params: [
      { id: P.BROW_L_Y, value: 0.1 },
      { id: P.BROW_R_Y, value: 0.3 },
      { id: P.EYE_L_OPEN, value: 0.6, blend: 'overwrite' },
      { id: P.EYE_R_OPEN, value: 0.6, blend: 'overwrite' },
    ],
  },

  curious: {
    params: [
      { id: P.BROW_L_Y, value: 0.3 },
      { id: P.BROW_R_Y, value: 0.3 },
      { id: P.EYE_L_OPEN, value: 1.0, blend: 'overwrite' },
      { id: P.EYE_R_OPEN, value: 1.0, blend: 'overwrite' },
    ],
  },

  confused: {
    params: [
      { id: P.BROW_L_Y, value: -0.2 },
      { id: P.BROW_R_Y, value: 0.3 },
      { id: P.EYE_L_OPEN, value: 0.7, blend: 'overwrite' },
      { id: P.EYE_R_OPEN, value: 0.7, blend: 'overwrite' },
    ],
  },

  smile: {
    params: [
      { id: P.BROW_L_Y, value: 0.3 },
      { id: P.BROW_R_Y, value: 0.3 },
      { id: P.EYE_L_SMILE, value: 0.7 },
      { id: P.EYE_R_SMILE, value: 0.7 },
      { id: P.EYE_L_OPEN, value: 0.7, blend: 'overwrite' },
      { id: P.EYE_R_OPEN, value: 0.7, blend: 'overwrite' },
      { id: P.MOUTH_OPEN_Y, value: 0.15 },
    ],
  },

  excited: {
    params: [
      { id: P.BROW_L_Y, value: 0.6 },
      { id: P.BROW_R_Y, value: 0.6 },
      { id: P.EYE_L_OPEN, value: 1.1, blend: 'overwrite' },
      { id: P.EYE_R_OPEN, value: 1.1, blend: 'overwrite' },
      { id: P.MOUTH_OPEN_Y, value: 0.4 },
    ],
  },

  tired: {
    params: [
      { id: P.BROW_L_Y, value: -0.1 },
      { id: P.BROW_R_Y, value: -0.1 },
      { id: P.EYE_L_OPEN, value: 0.4, blend: 'overwrite' },
      { id: P.EYE_R_OPEN, value: 0.4, blend: 'overwrite' },
      { id: P.MOUTH_OPEN_Y, value: 0.05 },
    ],
  },

  sleepy: {
    params: [
      { id: P.BROW_L_Y, value: -0.1 },
      { id: P.BROW_R_Y, value: -0.1 },
      { id: P.EYE_L_OPEN, value: 0.2, blend: 'overwrite' },
      { id: P.EYE_R_OPEN, value: 0.2, blend: 'overwrite' },
      { id: P.MOUTH_OPEN_Y, value: 0 },
    ],
  },

  playful: {
    params: [
      { id: P.BROW_L_Y, value: 0.4 },
      { id: P.BROW_R_Y, value: 0.6 },
      { id: P.EYE_L_OPEN, value: 0.8, blend: 'overwrite' },
      { id: P.EYE_R_OPEN, value: 0.9, blend: 'overwrite' },
      { id: P.EYE_L_SMILE, value: 0.3 },
      { id: P.EYE_R_SMILE, value: 0.4 },
      { id: P.MOUTH_OPEN_Y, value: 0.3 },
    ],
  },
}

// ── Runtime presets (combined from hardcoded + model-specific) ──

export const EXPRESSION_PRESETS: Record<string, ExpressionPreset> = { ...HARDCODED_PRESETS }

/** Register model-specific expression presets loaded from .exp3.json files */
export function registerModelPresets(presets: Record<string, ExpressionPreset>): void {
  for (const [name, preset] of Object.entries(presets)) {
    EXPRESSION_PRESETS[name] = preset
  }
}

/** Reset to only hardcoded presets (called on model change) */
export function resetPresets(): void {
  for (const key of Object.keys(EXPRESSION_PRESETS)) {
    delete EXPRESSION_PRESETS[key]
  }
  for (const [key, val] of Object.entries(HARDCODED_PRESETS)) {
    EXPRESSION_PRESETS[key] = val
  }
}

/** Get expression preset by name, falling back to neutral */
export function getExpression(name: string): ExpressionPreset {
  return EXPRESSION_PRESETS[name.toLowerCase()] ?? EXPRESSION_PRESETS.neutral
}

