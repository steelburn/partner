/**
 * M6 theme helpers (PLAN-M6.md) — DOM-free logic for the Theme Studio.
 *
 * Kept out of the component so every merge/name/parse/report rule is unit-
 * testable in the node vitest env (no jsdom). Rendering is presentational.
 * Redaction discipline: theme bodies are NOT secrets (they are the user's
 * own color tokens, shown back to them in the studio) — but nothing here
 * logs or echoes them either; audit/errors carry ids, names and token KEYS
 * only, never whole bodies.
 *
 * The canonical var-name mapping (TOKEN_VAR_NAMES) mirrors cssVars() in
 * shared/src/theme.ts EXACTLY; tokensToCssVars() is verified by test to
 * equal cssVars(mode) when fed the canonical TOKENS, so the studio can never
 * drift from the single source of truth.
 */

import {
  SHARED_TOKENS,
  TOKENS,
  cssVars,
  type ThemeMode,
  type ThemeTokens,
} from '@partner/shared';
import type { ThemeProfile, ThemeReport, ThemeReportIssue } from '@partner/shared';

/** The 16 color token keys, in a stable display order (DESIGN.md order). */
export const THEME_COLOR_KEYS = [
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
] as const satisfies readonly (keyof ThemeTokens)[];

export type ThemeColorKey = (typeof THEME_COLOR_KEYS)[number];

/**
 * ThemeTokens key -> the CSS custom property cssVars() binds it to. Single
 * mapping used by BOTH the token editor and the runtime var builder so a
 * renamed key can never silently disconnect the editor from the page.
 */
export const TOKEN_VAR_NAMES: Record<ThemeColorKey, string> = {
  bg: '--bg',
  surface: '--surface',
  surface2: '--surface-2',
  text: '--text',
  textMuted: '--text-muted',
  textFaint: '--text-faint',
  accent: '--accent',
  accentHover: '--accent-hover',
  accentEmphasis: '--accent-emphasis',
  accentEmphasisHover: '--accent-emphasis-hover',
  accentContrast: '--accent-contrast',
  border: '--border',
  danger: '--danger',
  warning: '--warning',
  success: '--success',
  focus: '--focus',
};

/** Short human label for a color token (DESIGN.md "Use" column). */
export const TOKEN_LABELS: Record<ThemeColorKey, string> = {
  bg: 'Background',
  surface: 'Card surface',
  surface2: 'Nested surface',
  text: 'Primary text',
  textMuted: 'Muted text',
  textFaint: 'Faint text',
  accent: 'Accent',
  accentHover: 'Accent hover',
  accentEmphasis: 'Accent emphasis',
  accentEmphasisHover: 'Accent emphasis hover',
  accentContrast: 'On emphasis',
  border: 'Border',
  danger: 'Danger',
  warning: 'Warning',
  success: 'Success',
  focus: 'Focus ring',
};

/**
 * Editor grouping: the light and dark modes each show the same groups. The
 * accent family is listed together so users tune hover/emphasis in context.
 */
export interface ColorTokenGroup {
  group: string;
  keys: readonly ThemeColorKey[];
}

export const COLOR_TOKEN_GROUPS: readonly ColorTokenGroup[] = [
  { group: 'Surfaces', keys: ['bg', 'surface', 'surface2'] },
  { group: 'Text', keys: ['text', 'textMuted', 'textFaint'] },
  { group: 'Accent', keys: ['accent', 'accentHover', 'accentEmphasis', 'accentEmphasisHover', 'accentContrast'] },
  { group: 'Semantic & chrome', keys: ['border', 'danger', 'warning', 'success', 'focus'] },
];

// ---------------------------------------------------------------------------
// Shape guards
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Full-token shape guard: every color key present with a string value. */
export function isThemeTokens(value: unknown): value is ThemeTokens {
  if (!isRecord(value)) return false;
  for (const key of THEME_COLOR_KEYS) {
    if (typeof value[key] !== 'string') return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Merge + var builder
// ---------------------------------------------------------------------------

/**
 * Complete a (possibly partial) token set for `mode`: every missing or empty
 * value falls back to the canonical TOKENS[mode] value. Never mutates the
 * canonical record. Used for preview overlays, save payloads and arbitrary
 * server themes that may predate a key.
 */
export function mergeTokensWithDefaults(
  partial: Partial<ThemeTokens> | ThemeTokens | null | undefined,
  mode: ThemeMode,
): ThemeTokens {
  const merged: ThemeTokens = { ...TOKENS[mode] };
  if (!isRecord(partial)) return merged;
  for (const key of THEME_COLOR_KEYS) {
    const value = partial[key];
    if (typeof value === 'string' && value.length > 0) merged[key] = value;
  }
  return merged;
}

/**
 * CSS custom properties for an arbitrary light/dark token pair in `mode`:
 * the color vars come from the mode's (default-merged) tokens mapped through
 * TOKEN_VAR_NAMES; every non-color var (space/type/radius/elevation/motion)
 * is taken unchanged from the shared cssVars() output, so the shared system
 * constants stay in exactly one place.
 */
export function tokensToCssVars(
  light: Partial<ThemeTokens> | ThemeTokens | null | undefined,
  dark: Partial<ThemeTokens> | ThemeTokens | null | undefined,
  mode: ThemeMode,
): Record<string, string> {
  const source = mergeTokensWithDefaults(mode === 'dark' ? dark : light, mode);
  const variables = cssVars(mode); // shared non-color vars + canonical colors
  for (const key of THEME_COLOR_KEYS) {
    variables[TOKEN_VAR_NAMES[key]] = source[key];
  }
  return variables;
}

/** True when two token sets agree on every color key (dirty check). */
export function sameColorTokens(a: ThemeTokens, b: Partial<ThemeTokens>): boolean {
  for (const key of THEME_COLOR_KEYS) {
    const value = b[key];
    if (typeof value === 'string' ? a[key] !== value : false) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Color input validation (client hint only — the core lint is authoritative)
// ---------------------------------------------------------------------------

const HEX_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
/** Loose oklch() shape; the core lint parses the real syntax on save. */
const OKLCH_RE = /^oklch\([^()\n]*\)$/i;

/**
 * Canonicalize a color input to '#rrggbb' (accepts #rgb/#rrggbb, bare 3/6
 * hex, any case). Returns null when the value is not hex-shaped — the value
 * may still be a valid oklch() color (see colorValueHint).
 */
export function normalizeHexColor(value: string): string | null {
  const trimmed = value.trim();
  const body = trimmed.startsWith('#') ? trimmed.slice(1) : trimmed;
  if (!/^[0-9a-f]{3}$/i.test(body) && !/^[0-9a-f]{6}$/i.test(body)) return null;
  if (body.length === 3) {
    return `#${body[0]}${body[0]}${body[1]}${body[1]}${body[2]}${body[2]}`.toLowerCase();
  }
  return `#${body.toLowerCase()}`;
}

/**
 * Per-input hint under a color field. Returns null when the value is a
 * plausible color (hex or oklch); otherwise a short message. Empty strings
 * are reported separately so the fallback-to-default behavior stays visible.
 */
export function colorValueHint(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return 'Enter a color — blank fields keep the default.';
  if (HEX_RE.test(trimmed)) return null;
  if (OKLCH_RE.test(trimmed)) {
    return 'oklch() previews live but themes save as #hex only — the server lint accepts hex.';
  }
  return 'Not a valid color — use a hex like #1f6f43.';
}

/**
 * Subset of a draft whose values are plausible colors (hex/oklch). Used for
 * the live preview ONLY: an in-progress invalid value must never be applied
 * to the document — the missing key falls back to the mode default instead.
 */
export function plausibleColorOverrides(
  draft: Partial<ThemeTokens> | ThemeTokens,
): Partial<ThemeTokens> {
  const out: Partial<ThemeTokens> = {};
  if (!isRecord(draft)) return out;
  const plausible = (value: string): boolean =>
    HEX_RE.test(value.trim()) || OKLCH_RE.test(value.trim());
  for (const key of THEME_COLOR_KEYS) {
    const value = draft[key];
    if (typeof value === 'string' && plausible(value)) {
      out[key] = value;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Save reports (server gate output)
// ---------------------------------------------------------------------------

export interface ReportIssueBrief {
  token: string;
  message: string;
}

export interface ThemeReportSummary {
  /** Number of blocking errors in the report. */
  errorCount: number;
  /** The first few errors as {token, message} (bounded, for banners). */
  firstErrors: ReportIssueBrief[];
}

/** How many errors reportSummary surfaces in firstErrors. */
export const REPORT_FIRST_ERRORS_LIMIT = 3;

/**
 * Compact view of a save report: total blocking errors plus the first few,
 * each reduced to its token path and message. Full detail (per-token groups,
 * apca/wcag metrics) is available via reportTokenGroups for inline rendering.
 */
export function reportSummary(report: ThemeReport): ThemeReportSummary {
  const errors = Array.isArray(report.errors) ? report.errors : [];
  return {
    errorCount: errors.length,
    firstErrors: errors.slice(0, REPORT_FIRST_ERRORS_LIMIT).map((issue) => ({
      token: issue.token,
      message: issue.message,
    })),
  };
}

/**
 * Errors grouped by their dot-path token ('dark.textMuted'), preserving
 * first-appearance order. The studio renders one block per token so the user
 * can fix the single offending input and see every pair it failed.
 */
export function reportTokenGroups(
  report: ThemeReport,
): Array<{ token: string; issues: ThemeReportIssue[] }> {
  const groups: Array<{ token: string; issues: ThemeReportIssue[] }> = [];
  for (const issue of report.errors) {
    const existing = groups.find((g) => g.token === issue.token);
    if (existing) existing.issues.push(issue);
    else groups.push({ token: issue.token, issues: [issue] });
  }
  return groups;
}

/**
 * Split a report issue token path ('light.accent', 'dark.textMuted') into
 * its mode + color key. Returns null when the token does not name a color
 * token in either mode (defensive — the core only reports color tokens).
 */
export function parseIssueToken(token: string): { mode: ThemeMode; key: ThemeColorKey } | null {
  const dot = token.indexOf('.');
  if (dot < 1) return null;
  const mode = token.slice(0, dot);
  if (mode !== 'light' && mode !== 'dark') return null;
  const key = token.slice(dot + 1);
  if (!Object.prototype.hasOwnProperty.call(TOKEN_VAR_NAMES, key)) return null;
  return { mode, key: key as ThemeColorKey };
}

// ---------------------------------------------------------------------------
// Names + export/import
// ---------------------------------------------------------------------------

/** A theme id -> its display name; '' when no id given; a neutral fallback otherwise. */
export function themeName(id: string | null, list: readonly ThemeProfile[]): string {
  if (id === null || id.length === 0) return '';
  const profile = list.find((theme) => theme.id === id);
  return profile ? profile.name : 'Removed theme';
}

/** File schema marker for exported theme JSON (checked on import). */
export const THEME_FILE_SCHEMA = 'theme/v1';

/** Reasonable ceiling for an imported theme file (themes are tiny). */
export const THEME_FILE_MAX_CHARS = 500_000;

/** Pretty JSON payload for the downloadable theme file. */
export function themeExportFile(payload: { name: string; light: ThemeTokens; dark: ThemeTokens }): string {
  return `${JSON.stringify(
    { schema: THEME_FILE_SCHEMA, name: payload.name, light: payload.light, dark: payload.dark },
    null,
    2,
  )}\n`;
}

/** Guard run BEFORE an import POST. Returns an error message or null. */
export function validateThemeFile(value: unknown): string | null {
  if (!isRecord(value)) {
    return 'This is not a Partner theme file — expected an object exported from the Theme studio.';
  }
  if (value.schema !== THEME_FILE_SCHEMA) {
    return 'This is not a Partner theme export (missing the theme/v1 schema marker).';
  }
  if (typeof value.name !== 'string' || value.name.trim().length === 0) {
    return 'The theme file has no name.';
  }
  if (!isThemeTokens(value.light) || !isThemeTokens(value.dark)) {
    return 'The theme file is missing color tokens — it may be from a different app.';
  }
  return null;
}

/** Reject oversized files early (keeps the guard cheap and the UI honest). */
export function validateThemeFileSize(jsonText: string): string | null {
  if (jsonText.length > THEME_FILE_MAX_CHARS) {
    return 'The theme file is too large to import.';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Read-only metadata for the fixed (non-color) system tokens
// ---------------------------------------------------------------------------

export interface TokenReadoutRow {
  name: string;
  value: string;
}

export interface TokenReadoutSection {
  title: string;
  rows: TokenReadoutRow[];
}

/**
 * The shared non-color tokens, flattened into read-only rows for the studio.
 * M6 edits COLOR tokens only; spacing/type/radius/elevation/motion stay the
 * fixed system constants from shared/src/theme.ts.
 */
export function sharedTokenReadout(): TokenReadoutSection[] {
  const rows = (source: Record<string, string>, prefix: string): TokenReadoutRow[] =>
    Object.entries(source).map(([name, value]) => ({ name: `${prefix}${name}`, value }));
  return [
    { title: 'Spacing (8px grid)', rows: rows(SHARED_TOKENS.space as unknown as Record<string, string>, '--space-') },
    { title: 'Type scale', rows: rows(SHARED_TOKENS.fontSize as unknown as Record<string, string>, '--fs-') },
    { title: 'Type weight', rows: rows(SHARED_TOKENS.fontWeight as unknown as Record<string, string>, '--fw-') },
    { title: 'Radius', rows: rows(SHARED_TOKENS.radius as unknown as Record<string, string>, '--radius-') },
    { title: 'Elevation', rows: rows(SHARED_TOKENS.elevation as unknown as Record<string, string>, '--elevation-') },
    { title: 'Motion', rows: rows(SHARED_TOKENS.motion as unknown as Record<string, string>, '--motion-') },
    {
      title: 'Font family',
      rows: [{ name: '--font-family', value: String(SHARED_TOKENS.fontFamily) }],
    },
  ];
}

/** Resolved light+dark token pair (what the runtime actually applies). */
export interface ThemeTokenPair {
  light: ThemeTokens;
  dark: ThemeTokens;
}
