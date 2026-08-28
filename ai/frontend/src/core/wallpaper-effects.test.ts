import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  WALLPAPER_EFFECT_DEFAULTS,
  effectsToSliderPercents,
  glassSaturate,
  sanitizeWallpaperEffects,
  wallpaperCssVars,
  wallpaperFitMode,
  wallpaperMediaFilter,
  wallpaperTransform,
} from './wallpaper-effects.ts'

test('defaults match the tuned dsh-wallpaper-engine feel', () => {
  assert.equal(WALLPAPER_EFFECT_DEFAULTS.scrim, 0.25)
  assert.equal(WALLPAPER_EFFECT_DEFAULTS.glassBlur, 16)
  assert.equal(WALLPAPER_EFFECT_DEFAULTS.wallpaperBlur, 0)
  assert.equal(WALLPAPER_EFFECT_DEFAULTS.brightness, 100)
  assert.equal(WALLPAPER_EFFECT_DEFAULTS.contrast, 100)
  assert.equal(WALLPAPER_EFFECT_DEFAULTS.saturate, 100)
  assert.equal(WALLPAPER_EFFECT_DEFAULTS.flip, false)
})

test('sanitizer clamps out-of-range and garbage input to safe values', () => {
  const cleaned = sanitizeWallpaperEffects({
    scrim: 5, glassBlur: -10, wallpaperBlur: 999,
    brightness: 'x', contrast: 0, saturate: null, flip: 'yes',
  })
  assert.equal(cleaned.scrim, 1)
  assert.equal(cleaned.glassBlur, 0)
  assert.equal(cleaned.wallpaperBlur, 60)
  assert.equal(cleaned.brightness, 100)
  assert.equal(cleaned.contrast, 40)
  // null must fall back (Number(null)===0 would zero it silently).
  assert.equal(cleaned.saturate, 100)
  assert.equal(cleaned.flip, false)
  // Non-object garbage → full defaults.
  assert.deepEqual(sanitizeWallpaperEffects('junk'), WALLPAPER_EFFECT_DEFAULTS)
  assert.deepEqual(sanitizeWallpaperEffects(undefined), WALLPAPER_EFFECT_DEFAULTS)
})

test('media filter is exactly "none" at defaults (compositor red line)', () => {
  assert.equal(wallpaperMediaFilter(WALLPAPER_EFFECT_DEFAULTS), 'none')
})

test('media filter composes only non-default terms in order', () => {
  const filter = wallpaperMediaFilter({
    ...WALLPAPER_EFFECT_DEFAULTS,
    wallpaperBlur: 12,
    brightness: 120,
    contrast: 100,
    saturate: 80,
  })
  assert.equal(filter, 'blur(12px) brightness(120%) saturate(80%)')
})

test('transform is "none" without blur or flip (compositor red line)', () => {
  assert.equal(wallpaperTransform(WALLPAPER_EFFECT_DEFAULTS), 'none')
})

test('transform composes blur compensation scale with mirror', () => {
  const transform = wallpaperTransform({
    ...WALLPAPER_EFFECT_DEFAULTS,
    wallpaperBlur: 10,
    flip: true,
  })
  // scale = 1 + 10*0.006 = 1.06
  assert.equal(transform, 'scale(1.0600) scaleX(-1)')
})

test('glass saturation follows the 1.15 + blur*0.028 curve', () => {
  assert.equal(glassSaturate(0), 1.15)
  assert.equal(glassSaturate(16), 1.15 + 16 * 0.028)
})

test('css vars: scrim tracks the effective theme', () => {
  const dark = wallpaperCssVars(WALLPAPER_EFFECT_DEFAULTS, 'dark')
  const light = wallpaperCssVars(WALLPAPER_EFFECT_DEFAULTS, 'light')
  assert.match(dark['--wp-scrim-color'], /^rgba\(7, 8, 12, 0\.25\)$/)
  assert.match(light['--wp-scrim-color'], /^rgba\(255, 255, 255, 0\.25\)$/)
})

test('css vars: default state keeps filter/transform at none', () => {
  const vars = wallpaperCssVars(WALLPAPER_EFFECT_DEFAULTS, 'dark')
  assert.equal(vars['--wp-media-filter'], 'none')
  assert.equal(vars['--wp-media-transform'], 'none')
  assert.equal(vars['--wp-glass-blur'], '16px')
})

test('slider percents round-trip the scrim knob', () => {
  assert.equal(effectsToSliderPercents({ ...WALLPAPER_EFFECT_DEFAULTS, scrim: 0.55 }).scrim, 55)
})

test('fit mode: matches the reference 适配 semantics per kind', () => {
  // cover is the default (铺满裁切) for both media kinds.
  assert.equal(wallpaperFitMode('cover', 'image'), 'cover')
  assert.equal(wallpaperFitMode(undefined, 'video'), 'cover')
  // contain upscales to the nearer edge (填充); center never upscales (居中).
  assert.equal(wallpaperFitMode('contain', 'image'), 'contain')
  assert.equal(wallpaperFitMode('center', 'video'), 'center')
  // fill stretches.
  assert.equal(wallpaperFitMode('fill', 'image'), 'fill')
  // web iframes always fill regardless of the knob.
  assert.equal(wallpaperFitMode('contain', 'web'), 'cover')
  assert.equal(wallpaperFitMode('center', 'web'), 'cover')
  // unknown values fall back to cover.
  assert.equal(wallpaperFitMode('legacy-value', 'image'), 'cover')
})
