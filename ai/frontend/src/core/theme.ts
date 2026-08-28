// Design tokens for the Companion frontend.
//
// Color values are CSS variable references, so inline styles follow the
// active theme (html[data-theme='dark'|'light']) and the user's accent
// override injected by the ThemeController. Radius, spacing, and typography
// are theme-independent and stay as literal values; the radius scale mirrors
// the --r-* tokens in styles/index.css (4/6/8/12/16/full).

export const theme = {
  colors: {
    bg: {
      root: 'var(--bg)',
      panel: 'var(--surface)',
      surface: 'var(--surface-2)',
      hover: 'var(--surface-hover)',
      elevated: 'var(--surface-3)',
    },
    text: {
      primary: 'var(--text)',
      secondary: 'var(--muted)',
      muted: 'var(--faint)',
      accent: 'var(--accent)',
    },
    status: {
      connected: 'var(--good)',
      connecting: 'var(--warn)',
      disconnected: 'var(--danger)',
      thinking: 'var(--accent)',
      speaking: 'var(--info)',
      idle: 'var(--faint)',
    },
    border: 'var(--line)',
    accent: 'var(--accent)',
    danger: 'var(--danger)',
  },
  spacing: {
    xs: 4,
    sm: 8,
    md: 12,
    lg: 16,
    xl: 24,
  },
  radius: {
    xs: 4,
    sm: 6,
    md: 8,
    lg: 12,
    xl: 16,
    full: 9999,
  },
  fontSize: {
    xs: '0.7rem',
    sm: '0.8rem',
    md: '0.9rem',
    lg: '1.1rem',
    xl: '1.3rem',
  },
  fontWeight: {
    normal: 400,
    medium: 500,
    semibold: 600,
    bold: 700,
  },
  animation: {
    fast: '150ms',
    normal: '250ms',
    slow: '400ms',
  },
  icon: {
    nav: 18,
    action: 16,
    compact: 14,
    strokeWidth: 1.75,
  },
  zIndex: {
    dropdown: 100,
    modal: 200,
    tooltip: 300,
  },
  electron: {
    titleBarHeight: 36,
  },
} as const

export type Theme = typeof theme
