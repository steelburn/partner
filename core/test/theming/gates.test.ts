/**
 * M6 theme gate tests (PLAN-M6.md §"Tests"): the embedded APCA/WCAG math
 * matches the known audit pairs within tolerance (the numbers the M0-M2
 * design audits used — e.g. dark muted #cbd1d8 on #191c1f ≈ Lc 76.7 and
 * ratio 11.12); the token lint flags missing/unparseable values; the
 * contrast report rejects deliberately weak themes (e.g. dark muted equal to
 * dark surface) and passes the shipped default tokens with zero errors.
 */
import { describe, expect, it } from 'vitest';
import type { ThemeReportIssue, ThemeTokens } from '@partner/shared';
import { TOKENS } from '@partner/shared';
import {
  apcaLc,
  wcagRatio,
  lintTokens,
  contrastReport,
  validateTheme,
  parseHex,
  relativeLuminance,
  THEME_TOKEN_KEYS,
  MIN_APCA_LC,
  MIN_WCAG_RATIO,
} from '../../src/theming/index.js';

/** APCA/WCAG calibration pairs from the M0-M2 design audits (±3 Lc, ±0.3). */
const APCA_CALIBRATION: Array<{
  fg: string;
  bg: string;
  lc: number;
  ratio: number;
}> = [
  { fg: '#cbd1d8', bg: '#191c1f', lc: 76.7, ratio: 11.12 },
  { fg: '#eaf6ef', bg: '#1a5b37', lc: 84.5, ratio: 7.29 },
  { fg: '#6aedb6', bg: '#191c1f', lc: 80.3, ratio: 11.73 },
  // Filled-emphasis pair (white contrast text on the green button).
  { fg: '#ffffff', bg: '#1f6f43', lc: 85.5, ratio: 6.15 },
  // Near-black body text on white.
  { fg: '#16181d', bg: '#ffffff', lc: 105.2, ratio: 17.76 },
];

describe('embedded contrast math', () => {
  it.each(APCA_CALIBRATION)('apcaLc($fg, $bg) ≈ $lc within ±3', ({ fg, bg, lc }) => {
    const value = apcaLc(fg, bg);
    expect(Math.abs(value - lc)).toBeLessThanOrEqual(3);
  });

  it.each(APCA_CALIBRATION)('wcagRatio($fg, $bg) ≈ $ratio within ±0.3', ({ fg, bg, ratio }) => {
    const value = wcagRatio(fg, bg);
    expect(Math.abs(value - ratio)).toBeLessThanOrEqual(0.3);
  });

  it('is symmetric for the ratio and reports ~0 Lc for equal colors', () => {
    expect(Math.abs(wcagRatio('#ffffff', '#1f6f43') - wcagRatio('#1f6f43', '#ffffff'))).toBeLessThan(
      0.001,
    );
    expect(apcaLc('#191c1f', '#191c1f')).toBeLessThan(MIN_APCA_LC);
  });

  it('parseHex + relativeLuminance basics (black ~0, white ~1)', () => {
    expect(parseHex('nope')).toBeNull();
    expect(parseHex('#fff')).toBeNull(); // strict #rrggbb only for now
    expect(parseHex('#FFFFFF')).toEqual({ r: 255, g: 255, b: 255 });
    expect(relativeLuminance('#000000')).toBeLessThan(0.001);
    expect(relativeLuminance('#ffffff')).toBeGreaterThan(0.99);
    expect(relativeLuminance('#ffffff')).toBeGreaterThan(relativeLuminance('#16181d'));
  });
});

describe('lintTokens', () => {
  it('passes a complete hex token document with zero issues', () => {
    expect(lintTokens('light', TOKENS.light)).toHaveLength(0);
    expect(lintTokens('dark', TOKENS.dark)).toHaveLength(0);
  });

  it('flags a missing key', () => {
    const { textMuted: _omitted, ...doc } = TOKENS.dark;
    const issues = lintTokens('dark', doc);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ token: 'dark.textMuted', mode: 'dark' });
  });

  it('flags an unparseable / non-hex color', () => {
    const odd = { ...TOKENS.light, accent: '#fff', danger: 'rgb(1,2,3)' } as unknown as ThemeTokens;
    const issues = lintTokens('light', odd);
    const tokens = issues.map((i) => i.token);
    expect(tokens).toContain('light.accent');
    expect(tokens).toContain('light.danger');
    expect(issues.every((i) => i.message.includes('#rrggbb'))).toBe(true);
  });

  it('flags a non-object document', () => {
    const issues = lintTokens('dark', 'not-an-object');
    expect(issues).toHaveLength(1);
    expect(issues[0]?.token).toBe('dark');
  });
});

describe('contrastReport + validateTheme', () => {
  it('default tokens (shared TOKENS) pass with zero errors and no warnings', () => {
    const report = contrastReport(TOKENS.light, TOKENS.dark);
    expect(report.ok).toBe(true);
    expect(report.errors).toHaveLength(0);
    expect(report.warnings).toHaveLength(0);
    const full = validateTheme({ light: TOKENS.light, dark: TOKENS.dark });
    expect(full).toEqual(report);
    expect(full.ok).toBe(true);
  });

  it('flags dark muted == dark surface (deliberately broken theme)', () => {
    const dark = { ...TOKENS.dark, textMuted: TOKENS.dark.surface };
    const report = contrastReport(TOKENS.light, dark);
    expect(report.ok).toBe(false);
    const error = report.errors.find((e) => e.token === 'dark.textMuted');
    expect(error).toBeDefined();
    expect(error?.apca).toBeLessThan(MIN_APCA_LC);
    expect(error?.wcag).toBeLessThan(MIN_WCAG_RATIO);
    expect(error?.message).toContain('muted text');
    const full = validateTheme({ light: TOKENS.light, dark });
    expect(full.ok).toBe(false);
    expect(full.errors.some((e) => e.token === 'dark.textMuted')).toBe(true);
  });

  it('flags a light-mode failure too (body text == background)', () => {
    const light = { ...TOKENS.light, text: TOKENS.light.bg };
    const report = validateTheme({ light, dark: TOKENS.dark });
    expect(report.ok).toBe(false);
    const error = report.errors.find((e) => e.token === 'light.text');
    expect(error).toMatchObject({ mode: 'light' });
  });

  it('warns (non-blocking) when accent equals the page background', () => {
    const light = { ...TOKENS.light, accent: TOKENS.light.bg };
    const report = contrastReport(light, TOKENS.dark);
    const warning = report.warnings.find((w) => w.token === 'light.accent');
    expect(warning).toBeDefined();
    expect(warning?.message).toContain('accent equals the page background');
    // The pair itself fails the gate (invisible links) -> still an error.
    expect(report.errors.some((e) => e.token === 'light.accent')).toBe(true);
  });

  it('validateTheme reports structural garbage instead of throwing', () => {
    const garbage = validateTheme({ light: 'nope', dark: null });
    expect(garbage.ok).toBe(false);
    expect(garbage.errors.length).toBeGreaterThanOrEqual(2);
    expect(garbage.errors.some((e) => e.token === 'light')).toBe(true);
    // A non-object doc reports one structural issue per mode...
    const empty = validateTheme({});
    expect(empty.ok).toBe(false);
    expect(empty.errors.length).toBeGreaterThanOrEqual(2);
    // ...and an empty object doc reports every required key of both modes.
    const missing = validateTheme({ light: {}, dark: {} });
    expect(missing.errors.length).toBeGreaterThanOrEqual(2 * THEME_TOKEN_KEYS.length);
    expect(missing.errors.every((e) => e.message.includes('#rrggbb'))).toBe(true);
  });

  it('reports at least the strongest failure per broken pair', () => {
    const issues: ThemeReportIssue[] = validateTheme({
      light: TOKENS.light,
      dark: { ...TOKENS.dark, textMuted: '#191c1f' },
    }).errors;
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toContain('< 75');
  });
});
