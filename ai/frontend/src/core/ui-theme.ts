// UI theme controller: mode (dark/light/auto) + accent presets.
//
// The renderer applies the theme by setting `data-theme` on <html> and, when
// the user picks a non-default accent, overriding `--accent` inline (inline
// custom-property overrides win over both theme blocks). Server-persisted
// settings are the source of truth; the localStorage copy only exists so the
// pre-mount script in index.html can paint the right background before React
// loads (anti-flash).

export type UiThemeMode = 'dark' | 'light' | 'auto'

export interface AccentPreset {
  key: string
  label: string
  /** Accent used while the effective theme is dark. */
  dark: string
  /** Accent used while the effective theme is light (darker for contrast). */
  light: string
}

// Preset scale: every dark variant keeps ≥3:1 contrast against white text on
// accent-filled buttons (matching the original orange), every light variant
// keeps ≥4.5:1 against white surfaces used as text/border color.
export const ACCENT_PRESETS: readonly AccentPreset[] = [
  { key: 'orange', label: '暖橘', dark: '#d97757', light: '#c15f3f' },
  { key: 'azure', label: '湛蓝', dark: '#4a8ec9', light: '#2f6db5' },
  { key: 'teal', label: '青绿', dark: '#35937d', light: '#1f7a63' },
  { key: 'violet', label: '雾紫', dark: '#8268c8', light: '#6d55b8' },
  { key: 'rose', label: '玫粉', dark: '#cc5f87', light: '#b04a70' },
  { key: 'forest', label: '墨绿', dark: '#5d945c', light: '#3f7a3d' },
]

export const DEFAULT_ACCENT_KEY = 'orange'
export const DEFAULT_THEME_MODE: UiThemeMode = 'dark'

export const THEME_MODE_OPTIONS: ReadonlyArray<{ value: UiThemeMode; label: string }> = [
  { value: 'dark', label: '深色' },
  { value: 'light', label: '浅色' },
  { value: 'auto', label: '跟随系统' },
]

const STORAGE_MODE_KEY = 'ui_theme_mode'
const STORAGE_ACCENT_KEY = 'ui_theme_accent'

export function isUiThemeMode(value: unknown): value is UiThemeMode {
  return value === 'dark' || value === 'light' || value === 'auto'
}

/** Resolve 'auto' against the system preference; explicit modes pass through. */
export function resolveThemeMode(mode: UiThemeMode, systemPrefersLight: boolean): 'dark' | 'light' {
  if (mode === 'auto') return systemPrefersLight ? 'light' : 'dark'
  return mode
}

export function findAccentPreset(key: string): AccentPreset {
  return ACCENT_PRESETS.find(preset => preset.key === key)
    ?? ACCENT_PRESETS.find(preset => preset.key === DEFAULT_ACCENT_KEY)!
}

/** The concrete accent hex for the effective (already resolved) theme. */
export function resolveAccentColor(accentKey: string, effectiveMode: 'dark' | 'light'): string {
  const preset = findAccentPreset(accentKey)
  return effectiveMode === 'light' ? preset.light : preset.dark
}

interface ThemeDocument {
  documentElement: HTMLElement
}

function systemPrefersLight(): boolean {
  return typeof matchMedia === 'function'
    && matchMedia('(prefers-color-scheme: light)').matches
}

/**
 * Apply mode + accent to the DOM and cache both in localStorage for the
 * pre-mount script. Returns a cleanup function that removes the system
 * preference listener installed for 'auto' mode.
 */
export function applyUiTheme(mode: UiThemeMode, accentKey: string, doc: ThemeDocument = document): () => void {
  const root = doc.documentElement
  const write = (prefersLight: boolean) => {
    const effective = resolveThemeMode(mode, prefersLight)
    root.dataset.theme = effective
    root.style.setProperty('--accent', resolveAccentColor(accentKey, effective))
    try {
      localStorage.setItem(STORAGE_MODE_KEY, mode)
      localStorage.setItem(STORAGE_ACCENT_KEY, accentKey)
    } catch {
      // localStorage can be unavailable (private modes); caching is best-effort.
    }
  }

  write(systemPrefersLight())

  if (mode !== 'auto' || typeof matchMedia !== 'function') return () => {}
  const query = matchMedia('(prefers-color-scheme: light)')
  const onChange = (event: MediaQueryListEvent) => write(event.matches)
  query.addEventListener('change', onChange)
  return () => query.removeEventListener('change', onChange)
}
