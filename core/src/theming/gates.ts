/**
 * Pure theme gates (PLAN-M6.md §"Shared contracts") — dependency-free.
 *
 * Three layers, each deterministic:
 *  1. apcaLc() / wcagRatio() — the embedded contrast math. APCA is
 *     implemented "0.0.98G-style": sRGB -> linear RGB (exact sRGB transfer)
 *     -> Y (Rec.709-style weights 0.2126729/0.7151522/0.0721750), a soft
 *     black clamp below Y=0.022 (Y += (0.022 − Y)^1.414), polarity-aware
 *     exponents — 0.56/0.57 for dark text on a light background, 0.62/0.65
 *     for light text on a dark background — scaled by 1.14 and expressed as
 *     Lc (×100). The magnitudes are calibrated in core/test/theming against
 *     the known audit pairs (e.g. #cbd1d8 on #191c1f ≈ Lc 76.7, WCAG 11.12).
 *  2. lintTokens() — structural lint: every ThemeTokens key present and a
 *     parseable #rrggbb hex color (oklch allowed in a later release).
 *  3. contrastReport() — the FIXED assertion pairs both modes must pass
 *     (mirror DESIGN.md): body text vs bg, muted vs surface, accentContrast
 *     on accentEmphasis (filled), accent link vs bg, danger vs bg. Each pair
 *     asserts APCA Lc >= 75 AND WCAG >= 4.5. textFaint/placeholder and
 *     disabled are EXEMPT (never asserted — DESIGN.md).
 *
 * validateTheme() composes lint (both modes) + contrast into a ThemeReport.
 * These functions never touch storage, the clock, or the audit.
 */
import type { ThemeMode, ThemeReport, ThemeReportIssue, ThemeTokens } from '@partner/shared';

/** Every ThemeTokens key the lint requires present + hex-parseable. */
export const THEME_TOKEN_KEYS: readonly (keyof ThemeTokens)[] = [
  'bg',
  'surface',
  'surface2',
  'text',
  'textMuted',
  'textFaint',
  'accent',
  'accentHover',
  'accentEmphasis',
  'accentEmphasisHover',
  'accentContrast',
  'border',
  'danger',
  'warning',
  'success',
  'focus',
];

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

/** Body-text floors (DESIGN.md): every asserted pair needs both. */
export const MIN_APCA_LC = 75;
export const MIN_WCAG_RATIO = 4.5;

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** Strict #rrggbb hex parse (case-insensitive); null when not parseable. */
export function parseHex(color: string): Rgb | null {
  if (!HEX_RE.test(color)) return null;
  const value = Number.parseInt(color.slice(1), 16);
  return { r: (value >> 16) & 0xff, g: (value >> 8) & 0xff, b: value & 0xff };
}

function isHex(color: unknown): color is string {
  return typeof color === 'string' && HEX_RE.test(color.trim());
}

/** sRGB channel (0..1) -> linear light via the exact sRGB transfer. */
function linearChannel(channel: number): number {
  const x = channel / 255;
  return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
}

/** Relative luminance Y (sRGB -> linear -> Rec.709-ish weights). */
export function relativeLuminance(color: string): number {
  const rgb = parseHex(color);
  if (rgb === null) return 0;
  return (
    0.2126729 * linearChannel(rgb.r) +
    0.7151522 * linearChannel(rgb.g) +
    0.0721750 * linearChannel(rgb.b)
  );
}

/** APCA soft-black clamp for Y < 0.022 (0.0.98G). */
function clampBlack(y: number): number {
  if (y > 0.022) return y;
  return y + Math.pow(0.022 - y, 1.414);
}

/**
 * APCA contrast magnitude (Lc) for a text color on a background color.
 * Polarity-aware: dark text on light bg uses 0.56/0.57; light text on a dark
 * background uses 0.62/0.65. Returns 0 for equal/near-equal colors.
 * Inputs must be parseable hex (lint guarantees that before the gate runs).
 *
 * Calibration vs the canonical apca-w3 0.0.98G: this embedded implementation
 * runs ~2.7 Lc high (missing canonical low-level clamps). We subtract a
 * fixed 2.0 headroom + the 0.027 polarity offset so borderline themes FAIL
 * CLOSED against the documented 75 body floor (M6 review finding 2).
 */
export function apcaLc(fg: string, bg: string): number {
  const txtY = clampBlack(relativeLuminance(fg));
  const bgY = clampBlack(relativeLuminance(bg));
  let out: number;
  if (bgY >= txtY) {
    // Dark text on a light background.
    out = (Math.pow(bgY, 0.56) - Math.pow(txtY, 0.57)) * 1.14;
  } else {
    // Light text on a dark background.
    out = (Math.pow(txtY, 0.62) - Math.pow(bgY, 0.65)) * 1.14;
  }
  if (out < 0.027) return 0;
  const scaled = out * 100;
  // Canonical polarity offsets + conservative headroom (see JSDoc).
  const adjusted = scaled > 0 ? scaled - 2.027 : scaled + 2.027;
  return adjusted < 0 ? 0 : adjusted;
}

/**
 * WCAG 2.x contrast ratio (1..21): (L1 + 0.05) / (L2 + 0.05), L1 the lighter.
 * Inputs must be parseable hex.
 */
export function wcagRatio(fg: string, bg: string): number {
  const l1 = relativeLuminance(fg);
  const l2 = relativeLuminance(bg);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

/** Same displayed color (two spellings of one hex compare equal). */
function sameColor(a: string, b: string): boolean {
  const ra = parseHex(a.trim());
  const rb = parseHex(b.trim());
  if (ra === null || rb === null) return false;
  return ra.r === rb.r && ra.g === rb.g && ra.b === rb.b;
}

// ---------------------------------------------------------------------------
// Lint — structural check of ONE mode's token doc (hex only for now).
// ---------------------------------------------------------------------------

function recordOf(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/**
 * Lint one mode's token document. Returns an issue per missing/unparseable
 * ThemeTokens key (empty = clean). `mode` labels the issue paths
 * ('dark.textMuted'). Extra keys are tolerated (they round-trip harmlessly).
 */
export function lintTokens(mode: ThemeMode, tokens: unknown): ThemeReportIssue[] {
  const doc = recordOf(tokens);
  if (doc === null) {
    return [
      {
        token: mode,
        mode,
        message: `${mode} tokens must be an object of #rrggbb color values`,
      },
    ];
  }
  const issues: ThemeReportIssue[] = [];
  for (const key of THEME_TOKEN_KEYS) {
    const value = doc[key];
    if (!isHex(value)) {
      issues.push({
        token: `${mode}.${key}`,
        mode,
        message: `${mode}.${key} must be a #rrggbb hex color (got ${typeof value})`,
      });
    }
  }
  return issues;
}

// ---------------------------------------------------------------------------
// Contrast — the FIXED assertion pairs per mode (DESIGN.md token table).
// textFaint / placeholder / disabled are EXEMPT and never appear here.
// ---------------------------------------------------------------------------

interface ContrastPair {
  /** Dot-path token the failure is reported against. */
  tokenKey: keyof ThemeTokens;
  label: string;
  fgKey: keyof ThemeTokens;
  bgKey: keyof ThemeTokens;
}

const CONTRAST_PAIRS: readonly ContrastPair[] = [
  { tokenKey: 'text', label: 'body text on the page background', fgKey: 'text', bgKey: 'bg' },
  { tokenKey: 'textMuted', label: 'muted text on a surface', fgKey: 'textMuted', bgKey: 'surface' },
  {
    tokenKey: 'accentContrast',
    label: 'text on a filled emphasis surface',
    fgKey: 'accentContrast',
    bgKey: 'accentEmphasis',
  },
  { tokenKey: 'accent', label: 'accent link on the page background', fgKey: 'accent', bgKey: 'bg' },
  { tokenKey: 'danger', label: 'danger text on the page background', fgKey: 'danger', bgKey: 'bg' },
];

function pairFailure(pair: ContrastPair, mode: ThemeMode, apca: number, ratio: number): ThemeReportIssue {
  const failed: string[] = [];
  if (apca < MIN_APCA_LC) failed.push(`APCA Lc ${apca.toFixed(1)} < ${MIN_APCA_LC}`);
  if (ratio < MIN_WCAG_RATIO) failed.push(`WCAG ${ratio.toFixed(2)} < ${MIN_WCAG_RATIO}`);
  return {
    token: `${mode}.${pair.tokenKey}`,
    mode,
    message: `${mode}: ${pair.label} — ${failed.join(', ')}`,
    apca,
    wcag: ratio,
  };
}

/**
 * Run the fixed assertion pairs against BOTH supplied token docs. Pairs whose
 * referenced color is missing/unparseable are skipped — lintTokens() already
 * reports those keys (validateTheme runs lint first, so nothing is lost).
 * Non-blocking warnings note semantic oddities (accent equal to the page bg).
 */
export function contrastReport(light: unknown, dark: unknown): ThemeReport {
  const errors: ThemeReportIssue[] = [];
  const warnings: ThemeReportIssue[] = [];
  const docs: Array<{ mode: ThemeMode; tokens: unknown }> = [
    { mode: 'light', tokens: light },
    { mode: 'dark', tokens: dark },
  ];

  for (const { mode, tokens } of docs) {
    const doc = recordOf(tokens);
    if (doc === null) continue;
    for (const pair of CONTRAST_PAIRS) {
      const fg = doc[pair.fgKey];
      const bg = doc[pair.bgKey];
      if (!isHex(fg) || !isHex(bg)) continue; // lint reports the key.
      const lc = apcaLc(fg, bg);
      const ratio = wcagRatio(fg, bg);
      if (lc < MIN_APCA_LC || ratio < MIN_WCAG_RATIO) {
        errors.push(pairFailure(pair, mode, lc, ratio));
      }
    }
    // Lenient semantic sanity (DESIGN.md): a link color that equals the page
    // background would be invisible — but the accent-on-bg contrast pair
    // ALREADY blocks that (Lc 0), so a separate warning here is redundant
    // (M6 review finding 5) and is intentionally NOT emitted.
    void doc;
  }

  return { ok: errors.length === 0, errors, warnings };
}

/**
 * Full save/update gate: lint BOTH modes + the contrast report. ok = no
 * errors at all (warnings never block). Input may be anything the wire sends
 * — garbage bodies come back as a report with structural lint issues.
 */
export function validateTheme(input: unknown): ThemeReport {
  const body = recordOf(input);
  const light = body?.light;
  const dark = body?.dark;
  const errors = [...lintTokens('light', light), ...lintTokens('dark', dark)];
  const contrast = contrastReport(light, dark);
  errors.push(...contrast.errors);
  return { ok: errors.length === 0, errors, warnings: contrast.warnings };
}
