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
  /** The single accent family — interactive text/links on surfaces. */
  accent: string;
  /** Accent hover state. */
  accentHover: string;
  /** Filled emphasis surface (primary buttons, user bubbles). */
  accentEmphasis: string;
  /** Hover for the emphasis surface. */
  accentEmphasisHover: string;
  /** Text/icon on emphasis surfaces (accentEmphasis backgrounds). */
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
    accentEmphasis: '#1f6f43',
    accentEmphasisHover: '#195936',
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
    // Tuned for strict contrast (APCA Lc >= 75 body text, WCAG AA sidecar)
    // on dark surfaces — see DESIGN.md token table.
    textMuted: '#cbd1d8',
    textFaint: '#9aa1ab',
    accent: '#6aedb6',
    accentHover: '#84f6cb',
    accentEmphasis: '#1a5b37',
    accentEmphasisHover: '#14502f',
    accentContrast: '#eaf6ef',
    border: '#30353b',
    danger: '#ffc9b7',
    warning: '#f0ab41',
    success: '#6aedb6',
    focus: '#84f6cb',
  },
};

/** Shared non-color tokens (identical in both modes). */
export const SHARED_TOKENS = {
  /** 8px spacing grid. */
  space: { 0: '0', 1: '8px', 2: '16px', 3: '24px', 4: '32px', 5: '40px', 6: '48px', 7: '64px' },
  /** Modular-ish type scale. */
  fontSize: { xs: '12px', sm: '14px', md: '16px', lg: '20px', xl: '25px', xxl: '32px' },
  fontWeight: { regular: '400', medium: '500', semibold: '600', bold: '700' },
  /** Letter-spacing: label = uppercase context labels (kickers); head = xl/xxl titles. */
  tracking: { label: '0.08em', head: '-0.01em' },
  fontFamily:
    "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', sans-serif",
  /** Fixed-width family for code, paths and diffs (structural, never prose). */
  fontFamilyMono:
    "ui-monospace, 'SF Mono', SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace",
  radius: { sm: '6px', md: '10px', lg: '14px', full: '999px' },
  /**
   * Canvas for third-party document content (the sandboxed HTML/CSS preview).
   *
   * Deliberately NOT the theme background and deliberately identical in both
   * modes: the preview renders an arbitrary document, whose own colours were
   * authored against a white canvas. In dark mode a theme-tinted canvas would
   * put black authored text on a dark surface. This replaces a hardcoded
   * `#ffffff`, which was the only raw hex left in the stylesheet.
   */
  surfaceDoc: '#ffffff',
  /** Named elevation levels only — never invent blur/opacity. */
  elevation: {
    sm: '0 1px 2px rgba(16, 18, 20, 0.06)',
    md: '0 4px 12px rgba(16, 18, 20, 0.10)',
    lg: '0 12px 32px rgba(16, 18, 20, 0.16)',
  },
  focusRing: '2px solid',
  motion: { fast: '100ms', base: '180ms', slow: '280ms', ease: 'cubic-bezier(0.25, 0.1, 0.25, 1)' },
  /**
   * Responsive / touch profile (M20.A). ADDITIVE: no existing token value
   * changes, so user-authored themes stay valid.
   *
   * - `target.min` is the minimum touch hit area. 44px is the floor (Apple HIG
   *   44pt; Material asks 48dp) and the geometry gate asserts it on every
   *   visible control, so a control may look small but must never be
   *   *touchable-small*. Prefer `comfortable` for primary actions.
   * - `safe` reads the OS insets that `viewport-fit=cover` exposes (notch,
   *   home indicator, rounded corners). Zero on desktop, so the same rules
   *   work everywhere with no media query.
   * - `viewport.dvh` keeps the shell the size of the *visible* viewport so a
   *   mobile keyboard shrinks the layout instead of hiding the composer
   *   behind it; `vh` is the fallback for engines without dynamic units.
   */
  target: { min: '44px', comfortable: '48px' },
  chrome: { bottomNav: '56px', topbarCompact: '48px' },
  safe: {
    top: 'env(safe-area-inset-top, 0px)',
    right: 'env(safe-area-inset-right, 0px)',
    bottom: 'env(safe-area-inset-bottom, 0px)',
    left: 'env(safe-area-inset-left, 0px)',
  },
  viewport: { dvh: '100dvh', vh: '100vh' },
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
    '--accent-emphasis': t.accentEmphasis,
    '--accent-emphasis-hover': t.accentEmphasisHover,
    '--accent-contrast': t.accentContrast,
    '--border': t.border,
    '--danger': t.danger,
    '--warning': t.warning,
    '--success': t.success,
    '--focus': t.focus,
    '--radius-sm': SHARED_TOKENS.radius.sm,
    '--radius-md': SHARED_TOKENS.radius.md,
    '--radius-lg': SHARED_TOKENS.radius.lg,
    '--surface-doc': SHARED_TOKENS.surfaceDoc,
    '--elevation-sm': SHARED_TOKENS.elevation.sm,
    '--elevation-md': SHARED_TOKENS.elevation.md,
    '--elevation-lg': SHARED_TOKENS.elevation.lg,
    '--font-family': SHARED_TOKENS.fontFamily,
    '--font-mono': SHARED_TOKENS.fontFamilyMono,
    '--track-label': SHARED_TOKENS.tracking.label,
    '--track-head': SHARED_TOKENS.tracking.head,
    '--motion-fast': SHARED_TOKENS.motion.fast,
    '--motion-base': SHARED_TOKENS.motion.base,
    '--motion-slow': SHARED_TOKENS.motion.slow,
    '--motion-ease': SHARED_TOKENS.motion.ease,
    '--target-min': SHARED_TOKENS.target.min,
    '--target-comfortable': SHARED_TOKENS.target.comfortable,
    '--bottom-nav-h': SHARED_TOKENS.chrome.bottomNav,
    '--topbar-compact-h': SHARED_TOKENS.chrome.topbarCompact,
    '--safe-top': SHARED_TOKENS.safe.top,
    '--safe-right': SHARED_TOKENS.safe.right,
    '--safe-bottom': SHARED_TOKENS.safe.bottom,
    '--safe-left': SHARED_TOKENS.safe.left,
    '--app-dvh': SHARED_TOKENS.viewport.dvh,
    '--app-vh': SHARED_TOKENS.viewport.vh,
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
