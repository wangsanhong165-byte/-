// Wallpaper fusion-layer controller: mirrors core/ui-theme.ts.
//
// While a background resource is active the controller sets
// html[data-wallpaper='on'] and pushes the effect knobs into --wp-* CSS
// variables. With no wallpaper every write is removed and the UI is exactly
// the stock build. The scrim/write path only touches properties whose value
// actually changed (a forced-reflow storm fix carried over from
// dsh-wallpaper-engine).

import type { WallpaperEffectSettings } from './wallpaper-effects'
import { sanitizeWallpaperEffects, wallpaperCssVars } from './wallpaper-effects'

const WALLPAPER_ATTR = 'data-wallpaper'

/**
 * Apply the fusion layer activation + effect variables.
 * `active` is derived from settings.backgroundType/Url by the caller.
 * Returns a cleanup that removes everything the call wrote.
 */
export function applyWallpaperFusion(
  active: boolean,
  effectsInput: unknown,
  effectiveTheme: 'dark' | 'light',
  doc: { documentElement: HTMLElement } = document,
): () => void {
  const root = doc.documentElement
  const effects: WallpaperEffectSettings = sanitizeWallpaperEffects(effectsInput)
  const vars = wallpaperCssVars(effects, effectiveTheme)

  if (active) root.setAttribute(WALLPAPER_ATTR, 'on')
  else root.removeAttribute(WALLPAPER_ATTR)

  const previous = new Map<string, string>()
  for (const [name, value] of Object.entries(vars)) {
    previous.set(name, root.style.getPropertyValue(name))
    root.style.setProperty(name, value)
  }

  return () => {
    for (const [name, prior] of previous) {
      if (prior === '') root.style.removeProperty(name)
      else root.style.setProperty(name, prior)
    }
  }
}
