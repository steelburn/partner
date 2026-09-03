/**
 * Design tokens — the SINGLE source of truth for the Partner UI.
 *
 * DESIGN.md (repo root) is the human-readable rationale; the values here are
 * authoritative. Components never carry raw values: they reference CSS
 * variables produced by `cssVars(mode)` below. Theme studio (M6) will edit
 * this document shape, not component structure.
 *
 * Discipline (repo conventions):
 *  - 8px spacing grid; modular-ish type scale; 3 named elevation levels only.
 *  - One accent family; no purple/indigo gradients, no glow, no glass.
 *  - Borders are the LAST resort for separation (space -> bg shift -> shadow).
 *  - Every interactive element declares default/hover/focus-visible/active/
 *    disabled; error/empty/loading where relevant.
 */

export type ThemeMode = 'light' | 'dark';

export interface ThemeTokens {
  /** Base page background. */
  bg: string;
  /** Card / panel surface. */
  surface: string;
  /** Nested surface (inputs, wells). */
  surface2: string;
  /** Primary text. */
  text: string;
  /** Secondary text (labels, captions). */
  textMuted: string;
  /** Disabled / placeholder text. */
  textFaint: string;
  /** The single accent family. */
  accent: string;
  /** Accent hover state. */
  accentHover: string;
  /** Text/icon on accent surfaces. */
  accentContrast: string;
  /** Subtle divider/input stroke (last resort). */
  border: string;
  /** Semantic states. */
  danger: string;
  warning: string;
  success: string;
  /** Focus ring (2px) — required on every interactive element. */
  focus: string;
}

export const TOKENS: Record<ThemeMode, ThemeTokens> = {
  light: {
    bg: '#ffffff',
    surface: '#f6f6f4',
    surface2: '#ececea',
    text: '#16181d',
    textMuted: '#3f444c',
    textFaint: '#5d636e',
    accent: '#1f6f43',
    accentHover: '#195936',
    accentContrast: '#ffffff',
    border: '#d9dbd7',
    danger: '#b42318',
    warning: '#a15c00',
    success: '#1f6f43',
    focus: '#1f6f43',
  },
  dark: {
    bg: '#101214',
    surface: '#191c1f',
    surface2: '#22262a',
    text: '#e8eaed',
    textMuted: '#a2a7ad',
    textFaint: '#7c8289',
    accent: '#4caf7d',
    accentHover: '#66c191',
    accentContrast: '#0d1210',
    border: '#30353b',
    danger: '#f97066',
    warning: '#f0ab41',
    success: '#4caf7d',
    focus: '#66c191',
  },
};

/** Shared non-color tokens (identical in both modes). */
export const SHARED_TOKENS = {
  /** 8px spacing grid. */
  space: { 0: '0', 1: '8px', 2: '16px', 3: '24px', 4: '32px', 5: '40px', 6: '48px', 7: '64px' },
  /** Modular-ish type scale. */
  fontSize: { xs: '12px', sm: '14px', md: '16px', lg: '20px', xl: '25px' },
  fontWeight: { regular: '400', medium: '500', semibold: '600', bold: '700' },
  fontFamily:
    "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', sans-serif",
  radius: { sm: '6px', md: '10px', lg: '14px', full: '999px' },
  /** Named elevation levels only — never invent blur/opacity. */
  elevation: {
    sm: '0 1px 2px rgba(16, 18, 20, 0.06)',
    md: '0 4px 12px rgba(16, 18, 20, 0.10)',
    lg: '0 12px 32px rgba(16, 18, 20, 0.16)',
  },
  focusRing: '2px solid',
  motion: { fast: '100ms', base: '180ms', slow: '280ms', ease: 'cubic-bezier(0.25, 0.1, 0.25, 1)' },
} as const;

export type SharedTokens = typeof SHARED_TOKENS;

/** CSS variable map for one mode — components consume var(--…), never values. */
export function cssVars(mode: ThemeMode): Record<string, string> {
  const t = TOKENS[mode];
  const out: Record<string, string> = {
    '--bg': t.bg,
    '--surface': t.surface,
    '--surface-2': t.surface2,
    '--text': t.text,
    '--text-muted': t.textMuted,
    '--text-faint': t.textFaint,
    '--accent': t.accent,
    '--accent-hover': t.accentHover,
    '--accent-contrast': t.accentContrast,
    '--border': t.border,
    '--danger': t.danger,
    '--warning': t.warning,
    '--success': t.success,
    '--focus': t.focus,
    '--radius-sm': SHARED_TOKENS.radius.sm,
    '--radius-md': SHARED_TOKENS.radius.md,
    '--radius-lg': SHARED_TOKENS.radius.lg,
    '--elevation-sm': SHARED_TOKENS.elevation.sm,
    '--elevation-md': SHARED_TOKENS.elevation.md,
    '--elevation-lg': SHARED_TOKENS.elevation.lg,
    '--font-family': SHARED_TOKENS.fontFamily,
  };
  for (const [name, size] of Object.entries(SHARED_TOKENS.fontSize)) {
    out[`--fs-${name}`] = size;
  }
  for (const [name, weight] of Object.entries(SHARED_TOKENS.fontWeight)) {
    out[`--fw-${name}`] = weight;
  }
  for (const [name, v] of Object.entries(SHARED_TOKENS.space)) {
    out[`--space-${name}`] = v;
  }
  return out;
}
