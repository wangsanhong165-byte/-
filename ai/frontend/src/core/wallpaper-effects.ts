// Wallpaper fusion-layer effect model: defaults, sanitizing, and CSS-variable
// derivation shared by the settings UI, the effects controller, and tests.
//
// All knobs live in AppSettings (persisted via /api/settings like every other
// setting) and are pushed into CSS variables on <html>. The layer composition
// follows dsh-wallpaper-engine's proven model (MIT, elysia395):
//   wallpaper media (z-index -2, filterable) → scrim (-1) → glass panels.
// Compositor red lines honored from day one (learned from its kiosk white-flash
// post-mortems): no :has() selectors, `filter: none` and `transform: none` at
// default, scrim writes only on real change.

export interface WallpaperEffectSettings {
  /** Scrim strength 0–1 — dark veil between wallpaper and UI. */
  scrim: number
  /** Glass blur radius px on the five panels. */
  glassBlur: number
  /** Wallpaper's own blur px. */
  wallpaperBlur: number
  /** Media filter knobs, 100 = untouched. */
  brightness: number
  contrast: number
  saturate: number
  /** Horizontal mirror of the wallpaper media. */
  flip: boolean
}

export const WALLPAPER_EFFECT_DEFAULTS: WallpaperEffectSettings = {
  scrim: 0.25,
  glassBlur: 16,
  wallpaperBlur: 0,
  brightness: 100,
  contrast: 100,
  saturate: 100,
  flip: false,
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  // null/undefined must fall back — Number(null) === 0 would sneak through
  // the finite check and zero out knobs whose min is 0.
  if (value === null || value === undefined) return fallback
  const num = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(num)) return fallback
  return Math.min(max, Math.max(min, num))
}

export function sanitizeWallpaperEffects(input: unknown): WallpaperEffectSettings {
  const o = (input && typeof input === 'object') ? input as Record<string, unknown> : {}
  return {
    scrim: clampNumber(o.scrim, 0, 1, WALLPAPER_EFFECT_DEFAULTS.scrim),
    glassBlur: clampNumber(o.glassBlur, 0, 60, WALLPAPER_EFFECT_DEFAULTS.glassBlur),
    wallpaperBlur: clampNumber(o.wallpaperBlur, 0, 60, WALLPAPER_EFFECT_DEFAULTS.wallpaperBlur),
    brightness: clampNumber(o.brightness, 40, 160, WALLPAPER_EFFECT_DEFAULTS.brightness),
    contrast: clampNumber(o.contrast, 40, 200, WALLPAPER_EFFECT_DEFAULTS.contrast),
    saturate: clampNumber(o.saturate, 0, 200, WALLPAPER_EFFECT_DEFAULTS.saturate),
    flip: o.flip === true,
  }
}

/** One media element or nothing — `none` at default keeps Chromium from
 *  forcing an offscreen filter layer on the full-screen wallpaper video. */
export function wallpaperMediaFilter(effects: WallpaperEffectSettings): string {
  const terms: string[] = []
  if (effects.wallpaperBlur > 0) terms.push(`blur(${effects.wallpaperBlur}px)`)
  if (effects.brightness !== 100) terms.push(`brightness(${effects.brightness}%)`)
  if (effects.contrast !== 100) terms.push(`contrast(${effects.contrast}%)`)
  if (effects.saturate !== 100) terms.push(`saturate(${effects.saturate}%)`)
  return terms.length ? terms.join(' ') : 'none'
}

/** Blur reveals a transparent fringe at the viewport edges; scale the layer
 *  up slightly to hide it (mirror + compensation share one transform). */
export function wallpaperTransform(effects: WallpaperEffectSettings): string {
  if (effects.wallpaperBlur <= 0 && !effects.flip) return 'none'
  const scale = (1 + effects.wallpaperBlur * 0.006).toFixed(4)
  return `scale(${scale}) scaleX(${effects.flip ? -1 : 1})`
}

/** iOS-liquid-glass saturation: the colour "melt" scales with the blur radius
 *  (1.15 + blur×0.028 — dsh-wallpaper-engine's tuned curve). */
export function glassSaturate(glassBlur: number): number {
  return 1.15 + glassBlur * 0.028
}

/**
 * Derive every CSS custom property the fusion layer consumes. Keys map to
 * `--wp-*` variables; scrim color tracks the active theme so a light theme
 * gets a white-based veil instead of a gray wash.
 */
export function wallpaperCssVars(
  effects: WallpaperEffectSettings,
  effectiveTheme: 'dark' | 'light',
): Record<string, string> {
  const scrimRgb = effectiveTheme === 'light' ? '255, 255, 255' : '7, 8, 12'
  return {
    '--wp-scrim-color': `rgba(${scrimRgb}, ${effects.scrim})`,
    '--wp-glass-blur': `${effects.glassBlur}px`,
    '--wp-glass-saturate': String(Math.round(glassSaturate(effects.glassBlur) * 1000) / 1000),
    '--wp-media-filter': wallpaperMediaFilter(effects),
    '--wp-media-transform': wallpaperTransform(effects),
  }
}

/** Rounded slider-step values used by the settings UI (percent display). */
export function effectsToSliderPercents(effects: WallpaperEffectSettings): Record<'scrim', number> {
  return { scrim: Math.round(effects.scrim * 100) }
}
