// Expression Controller — manages emotion-to-expression mapping and blending
// Takes abstract emotion names and translates them to Live2D expression presets.
// Uses model-specific .exp3.json presets (via emotion_map) with hardcoded fallback.

import { getExpression, EXPRESSION_PRESETS } from './live2d/expression.ts'
import type { ParameterController } from './ExpressionParameterController.ts'

export interface ExpressionBlend {
  name: string
  weight: number
}

export class ExpressionController {
  private paramCtrl: ParameterController
  private currentExpression = 'neutral'
  private currentIntensity = 1
  private _enabled = true
  /** emotion → expression name map from live2d_models.json */
  private emotionMap: Record<string, string> = {}
  /** Set of model-specific expression names loaded from .exp3.json files */
  private modelExpressionNames: string[] = []

  constructor(paramCtrl: ParameterController) {
    this.paramCtrl = paramCtrl
  }

  /** Enable/disable expression application */
  setEnabled(enabled: boolean): void {
    this._enabled = enabled
    if (!enabled) {
      this.paramCtrl.applyExpression('neutral', 1, 200)
    }
  }

  /** Inject model-specific config after model loads */
  setModelConfig(emotionMap: Record<string, string>, modelExpressionNames: string[]): void {
    this.emotionMap = emotionMap || {}
    this.modelExpressionNames = modelExpressionNames || []
    // A newly attached model still needs its first expression applied when its
    // semantic name matches the previous model's last expression.
    this.currentExpression = ''
    this.currentIntensity = -1
    console.log('[EXPRESSION] setModelConfig: map=%s, exprs=%s',
      Object.keys(this.emotionMap).length, this.modelExpressionNames.length)
  }

  /** Resolve an expression name through emotion_map, with debug logging */
  private resolveExpressionName(name: string): string {
    // Step 1: Check emotion_map for model-specific expression file name
    const mapped = this.emotionMap[name] || this.emotionMap[name.toLowerCase()]
    if (mapped) {
      // Verify the mapped expression name exists in presets
      if (EXPRESSION_PRESETS[mapped]) {
        console.log('[EXPRESSION] %s → emotion_map → %s (found in presets)', name, mapped)
        return mapped
      }
      // Model presets loaded but this expression is not among them
      console.log('[EXPRESSION] %s → emotion_map → %s (NOT in presets, falling back)', name, mapped)
    }

    // Step 2: Try to use the semantic name directly
    const lower = name.toLowerCase()
    if (EXPRESSION_PRESETS[lower]) {
      console.log('[EXPRESSION] %s → direct hit on hardcoded preset', name)
      return lower
    }

    // Step 3: Neutral fallback
    console.log('[EXPRESSION] %s → fallback to neutral', name)
    return 'neutral'
  }

  /** Apply an expression by name with smooth transition */
  apply(name: string, intensity = 1, duration = 400): void {
    if (!this._enabled) return
    const resolved = this.resolveExpressionName(name)

    // Skip if the same expression and intensity are already active
    if (this.currentExpression === resolved && this.currentIntensity === intensity) {
      return
    }

    this.currentExpression = resolved
    this.currentIntensity = intensity
    this.paramCtrl.applyExpression(resolved, intensity, duration)
    console.log('[EXPRESSION APPLIED] %s → %s (intensity=%s)', name, resolved, intensity)
  }

  /** Blend multiple expressions together by weighted parameter merging */
  blend(expressions: ExpressionBlend[], duration = 300): void {
    if (expressions.length === 0) return

    // Collect all unique parameter keys across all expressions
    const merged = new Map<string, number>()
    let totalWeight = 0

    for (const { name, weight } of expressions) {
      if (weight <= 0) continue
      const preset = getExpression(name)
      totalWeight += weight
      for (const p of preset.params) {
        const current = merged.get(p.id) || 0
        merged.set(p.id, current + p.value * weight)
      }
    }

    // Normalize by total weight
    if (totalWeight > 0) {
      for (const [id, value] of merged) {
        this.paramCtrl.setSmooth(id, value / totalWeight, duration)
      }
    }
  }

  /**
   * While speech audio is active, mouth parameters belong to lip-sync alone.
   * Muting removes them from expression ownership; unmuting force-re-applies
   * the standing expression so the mouth blends back instead of snapping.
   */
  setSpeechMouthMute(on: boolean, ids: string[] = []): void {
    this.paramCtrl.setSpeechMouthExclusion(on ? ids : [])
    if (!on && this.speechMutedMouth) {
      const name = this.currentExpression || 'neutral'
      const intensity = this.currentIntensity < 0 ? 1 : this.currentIntensity
      this.currentExpression = ''
      this.currentIntensity = -1
      this.apply(name, intensity, 400)
    }
    this.speechMutedMouth = on
  }
  private speechMutedMouth = false

  /** Get the current expression name */
  getCurrent(): string {
    return this.currentExpression
  }

  /** Get the current intensity */
  getIntensity(): number {
    return this.currentIntensity
  }

  /** List all available expression names */
  listExpressions(): string[] {
    return Object.keys(EXPRESSION_PRESETS)
  }
}
