import assert from 'node:assert/strict'
import { test } from 'node:test'

import { theme } from './theme.ts'
import {
  ACCENT_PRESETS,
  DEFAULT_ACCENT_KEY,
  THEME_MODE_OPTIONS,
  findAccentPreset,
  isUiThemeMode,
  resolveAccentColor,
  resolveThemeMode,
} from './ui-theme.ts'

test('workspace theme colors map to live CSS tokens', () => {
  assert.equal(theme.colors.bg.root, 'var(--bg)')
  assert.equal(theme.colors.bg.panel, 'var(--surface)')
  assert.equal(theme.colors.bg.surface, 'var(--surface-2)')
  assert.equal(theme.colors.bg.hover, 'var(--surface-hover)')
  assert.equal(theme.colors.bg.elevated, 'var(--surface-3)')
  assert.equal(theme.colors.text.primary, 'var(--text)')
  assert.equal(theme.colors.text.secondary, 'var(--muted)')
  assert.equal(theme.colors.text.muted, 'var(--faint)')
  assert.equal(theme.colors.border, 'var(--line)')
  assert.equal(theme.colors.accent, 'var(--accent)')
  assert.equal(theme.colors.danger, 'var(--danger)')
})

test('workspace theme radius scale mirrors the CSS --r-* tokens', () => {
  assert.deepEqual(theme.radius, {
    xs: 4,
    sm: 6,
    md: 8,
    lg: 12,
    xl: 16,
    full: 9999,
  })
})

test('workspace theme exposes a consistent icon scale', () => {
  assert.deepEqual(theme.icon, {
    nav: 18,
    action: 16,
    compact: 14,
    strokeWidth: 1.75,
  })
})

test('theme modes cover dark, light, and auto', () => {
  assert.deepEqual(THEME_MODE_OPTIONS.map(option => option.value), ['dark', 'light', 'auto'])
  assert.equal(isUiThemeMode('dark'), true)
  assert.equal(isUiThemeMode('light'), true)
  assert.equal(isUiThemeMode('auto'), true)
  assert.equal(isUiThemeMode('sepia'), false)
  assert.equal(isUiThemeMode(null), false)
})

test('auto mode resolves against the system preference', () => {
  assert.equal(resolveThemeMode('auto', true), 'light')
  assert.equal(resolveThemeMode('auto', false), 'dark')
  assert.equal(resolveThemeMode('dark', true), 'dark')
  assert.equal(resolveThemeMode('light', false), 'light')
})

test('accent presets expose unique keys with dark and light variants', () => {
  assert.ok(ACCENT_PRESETS.length >= 6)
  const keys = ACCENT_PRESETS.map(preset => preset.key)
  assert.equal(new Set(keys).size, keys.length)
  for (const preset of ACCENT_PRESETS) {
    assert.match(preset.dark, /^#[0-9a-f]{6}$/i)
    assert.match(preset.light, /^#[0-9a-f]{6}$/i)
    assert.notEqual(preset.dark, preset.light)
    assert.ok(preset.label.length > 0)
  }
  assert.equal(DEFAULT_ACCENT_KEY, 'orange')
})

test('accent resolution follows the effective theme and falls back to default', () => {
  assert.equal(resolveAccentColor('orange', 'dark'), '#d97757')
  assert.equal(resolveAccentColor('orange', 'light'), '#c15f3f')
  // Unknown keys fall back to the default preset instead of throwing.
  assert.equal(resolveAccentColor('nope', 'dark'), findAccentPreset(DEFAULT_ACCENT_KEY).dark)
})
