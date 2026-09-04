import { describe, expect, it } from 'vitest';
import { TOKENS, cssVars } from '@partner/shared';
import type { ThemeMode, ThemeTokens } from '@partner/shared';
import type { ThemeReport, ThemeReportIssue } from '@partner/shared';
import {
  TOKEN_VAR_NAMES,
  THEME_COLOR_KEYS,
  colorValueHint,
  isThemeTokens,
  mergeTokensWithDefaults,
  normalizeHexColor,
  parseIssueToken,
  plausibleColorOverrides,
  reportSummary,
  reportTokenGroups,
  sameColorTokens,
  sharedTokenReadout,
  themeExportFile,
  themeName,
  tokensToCssVars,
  validateThemeFile,
  validateThemeFileSize,
  REPORT_FIRST_ERRORS_LIMIT,
  type ThemeTokenPair,
} from '../src/lib/theme-helpers.js';
import type { ThemeProfile } from '@partner/shared';

const MODES: ThemeMode[] = ['light', 'dark'];

function issue(overrides: Partial<ThemeReportIssue> = {}): ThemeReportIssue {
  return {
    token: 'dark.textMuted',
    mode: 'dark',
    message: 'text on surface Lc 51 < 75',
    ...overrides,
  };
}

describe('mergeTokensWithDefaults', () => {
  it('returns the canonical tokens untouched for an empty partial', () => {
    for (const mode of MODES) {
      expect(mergeTokensWithDefaults({}, mode)).toEqual(TOKENS[mode]);
      expect(mergeTokensWithDefaults(null, mode)).toEqual(TOKENS[mode]);
      expect(mergeTokensWithDefaults(undefined, mode)).toEqual(TOKENS[mode]);
    }
  });

  it('overrides only the provided keys and never mutates the canonical set', () => {
    const merged = mergeTokensWithDefaults({ accent: '#111111' }, 'light');
    expect(merged.accent).toBe('#111111');
    expect(merged.bg).toBe(TOKENS.light.bg);
    expect(merged.accentHover).toBe(TOKENS.light.accentHover);
    expect(TOKENS.light.accent).not.toBe('#111111');
  });

  it('falls back per mode (dark partial completes against dark defaults)', () => {
    const merged = mergeTokensWithDefaults({ bg: '#000000' }, 'dark');
    expect(merged.bg).toBe('#000000');
    expect(merged.text).toBe(TOKENS.dark.text);
    expect(merged.textMuted).toBe(TOKENS.dark.textMuted);
  });

  it('treats an empty string as missing (falls back)', () => {
    const merged = mergeTokensWithDefaults({ text: '', accent: '#010203' }, 'light');
    expect(merged.text).toBe(TOKENS.light.text);
    expect(merged.accent).toBe('#010203');
  });

  it('is the identity for a full canonical set', () => {
    expect(mergeTokensWithDefaults(TOKENS.light, 'light')).toEqual(TOKENS.light);
  });
});

describe('tokensToCssVars', () => {
  it('equals cssVars() exactly when fed the canonical tokens (light + dark)', () => {
    for (const mode of MODES) {
      const fromTheme = cssVars(mode);
      const fromHelper = tokensToCssVars(TOKENS.light, TOKENS.dark, mode);
      expect(Object.keys(fromHelper).sort()).toEqual(Object.keys(fromTheme).sort());
      expect(fromHelper).toEqual(fromTheme);
    }
  });

  it('maps every color key to the var name cssVars uses', () => {
    // The mapping table must line up with the shared builder 1:1.
    const canonical = cssVars('light');
    for (const key of THEME_COLOR_KEYS) {
      const varName = TOKEN_VAR_NAMES[key];
      expect(varName.startsWith('--')).toBe(true);
      expect(canonical[varName]).toBe(TOKENS.light[key]);
    }
  });

  it('carries arbitrary color values through to the mode var names', () => {
    const overrides: Partial<ThemeTokens> = {
      accent: '#a1b2c3',
      accentEmphasis: '#d1e2f3',
      accentEmphasisHover: '#e1f2a3',
      textMuted: '#445566',
      surface2: '#f0f0f0',
      accentContrast: '#000000',
    };
    const vars = tokensToCssVars(overrides, undefined, 'light');
    expect(vars['--accent']).toBe('#a1b2c3');
    expect(vars['--accent-emphasis']).toBe('#d1e2f3');
    expect(vars['--accent-emphasis-hover']).toBe('#e1f2a3');
    expect(vars['--text-muted']).toBe('#445566');
    expect(vars['--surface-2']).toBe('#f0f0f0');
    expect(vars['--accent-contrast']).toBe('#000000');
    // Untouched keys fall back to the canonical defaults for the mode.
    expect(vars['--bg']).toBe(TOKENS.light.bg);
    expect(vars['--danger']).toBe(TOKENS.light.danger);
  });

  it('selects the tokens of the requested mode only', () => {
    const light = tokensToCssVars({ accent: '#111111' }, { accent: '#222222' }, 'light');
    const dark = tokensToCssVars({ accent: '#111111' }, { accent: '#222222' }, 'dark');
    expect(light['--accent']).toBe('#111111');
    expect(dark['--accent']).toBe('#222222');
    expect(dark['--bg']).toBe(TOKENS.dark.bg);
  });

  it('keeps the shared non-color vars identical in both modes', () => {
    const light = tokensToCssVars(TOKENS.light, TOKENS.dark, 'light');
    const dark = tokensToCssVars(TOKENS.light, TOKENS.dark, 'dark');
    const nonColor = (vars: Record<string, string>): Record<string, string> => {
      const colorVars = new Set(Object.values(TOKEN_VAR_NAMES));
      return Object.fromEntries(Object.entries(vars).filter(([name]) => !colorVars.has(name)));
    };
    expect(nonColor(light)).toEqual(nonColor(dark));
    expect(light['--radius-md']).toBeDefined();
    expect(light['--space-4']).toBeDefined();
    expect(light['--fs-lg']).toBeDefined();
  });

  it('merges a partially-specified token set before mapping', () => {
    const vars = tokensToCssVars(undefined, { textMuted: '#101010' }, 'dark');
    expect(vars['--text-muted']).toBe('#101010');
    expect(vars['--text']).toBe(TOKENS.dark.text);
  });
});

describe('sameColorTokens', () => {
  it('reports equality and differences across every color key', () => {
    expect(sameColorTokens(TOKENS.light, TOKENS.light)).toBe(true);
    expect(sameColorTokens(TOKENS.light, { ...TOKENS.light, accent: '#000001' })).toBe(false);
    expect(sameColorTokens(TOKENS.light, {})).toBe(true);
    expect(sameColorTokens(TOKENS.light, { accent: TOKENS.light.accent })).toBe(true);
  });
});

describe('reportSummary', () => {
  it('summarizes an empty report', () => {
    const summary = reportSummary({ ok: true, errors: [], warnings: [] });
    expect(summary.errorCount).toBe(0);
    expect(summary.firstErrors).toEqual([]);
  });

  it('counts all errors and surfaces the first few as {token, message}', () => {
    const errors: ThemeReportIssue[] = [
      issue({ token: 'dark.text', message: 'a' }),
      issue({ token: 'dark.textMuted', message: 'b' }),
      issue({ token: 'light.accent', message: 'c' }),
      issue({ token: 'dark.surface2', message: 'd' }),
      issue({ token: 'light.danger', message: 'e' }),
    ];
    const summary = reportSummary({ ok: false, errors, warnings: [] });
    expect(summary.errorCount).toBe(5);
    expect(summary.firstErrors).toHaveLength(REPORT_FIRST_ERRORS_LIMIT);
    expect(summary.firstErrors[0]).toEqual({ token: 'dark.text', message: 'a' });
    expect(summary.firstErrors[2]).toEqual({ token: 'light.accent', message: 'c' });
  });

  it('tolerates a report without an errors array', () => {
    const summary = reportSummary({ ok: true, errors: [], warnings: [] });
    expect(summary.errorCount).toBe(0);
  });
});

describe('reportTokenGroups', () => {
  it('groups errors by token path in first-appearance order', () => {
    const errors: ThemeReportIssue[] = [
      issue({ token: 'dark.textMuted', message: 'first pair' }),
      issue({ token: 'light.textMuted', message: 'second pair' }),
      issue({ token: 'dark.textMuted', message: 'another pair for the same token' }),
    ];
    const groups = reportTokenGroups({ ok: false, errors, warnings: [] });
    expect(groups.map((g) => g.token)).toEqual(['dark.textMuted', 'light.textMuted']);
    expect(groups[0].issues).toHaveLength(2);
    expect(groups[0].issues[1].message).toBe('another pair for the same token');
  });
});

describe('parseIssueToken', () => {
  it('splits a valid dot-path token into mode + color key', () => {
    expect(parseIssueToken('dark.textMuted')).toEqual({ mode: 'dark', key: 'textMuted' });
    expect(parseIssueToken('light.bg')).toEqual({ mode: 'light', key: 'bg' });
    expect(parseIssueToken('light.accentEmphasisHover')).toEqual({
      mode: 'light',
      key: 'accentEmphasisHover',
    });
  });

  it('rejects tokens that are not light/dark color paths', () => {
    expect(parseIssueToken('')).toBeNull();
    expect(parseIssueToken('text')).toBeNull();
    expect(parseIssueToken('sepia.textMuted')).toBeNull();
    expect(parseIssueToken('dark.nope')).toBeNull();
    expect(parseIssueToken('dark.textMuted.extra')).toBeNull();
  });
});

describe('themeName', () => {
  const list: ThemeProfile[] = [
    {
      id: 'preset-default',
      name: 'Default',
      source: 'preset',
      light: TOKENS.light,
      dark: TOKENS.dark,
    },
    { id: 't1', name: 'Forest', source: 'custom', light: TOKENS.light, dark: TOKENS.dark },
  ];

  it('resolves ids and returns neutral fallbacks otherwise', () => {
    expect(themeName('preset-default', list)).toBe('Default');
    expect(themeName('t1', list)).toBe('Forest');
    expect(themeName('missing-id', list)).toBe('Removed theme');
    expect(themeName('', list)).toBe('');
    expect(themeName(null, list)).toBe('');
  });
});

describe('color input validation', () => {
  it('normalizes hex shapes to #rrggbb', () => {
    expect(normalizeHexColor('#fff')).toBe('#ffffff');
    expect(normalizeHexColor('#ABCDEF')).toBe('#abcdef');
    expect(normalizeHexColor('1f6f43')).toBe('#1f6f43');
    expect(normalizeHexColor('  #1F6F43  ')).toBe('#1f6f43');
    expect(normalizeHexColor('zzz')).toBeNull();
    expect(normalizeHexColor('#12345')).toBeNull();
    expect(normalizeHexColor('')).toBeNull();
  });

  it('accepts hex; hints that oklch previews but saves as hex only; hints on anything else', () => {
    expect(colorValueHint('#1f6f43')).toBeNull();
    expect(colorValueHint('oklch(45% 0.13 160)')).toMatch(/hex only/);
    expect(colorValueHint('')).toMatch(/Enter a color/);
    expect(colorValueHint('banana')).toMatch(/Not a valid color/);
    expect(colorValueHint('rgb(1,2,3)')).toMatch(/Not a valid color/);
  });

  it('keeps only plausible values for preview overrides', () => {
    const draft: Partial<ThemeTokens> = {
      accent: '#1f6f43',
      textMuted: 'oklch(70% 0.05 220)',
      bg: 'not-a-color',
      surface: '',
    };
    const kept = plausibleColorOverrides(draft);
    expect(kept.accent).toBe('#1f6f43');
    expect(kept.textMuted).toBe('oklch(70% 0.05 220)');
    expect(kept.bg).toBeUndefined();
    expect(kept.surface).toBeUndefined();
  });
});

describe('isThemeTokens', () => {
  it('accepts complete token records only', () => {
    expect(isThemeTokens(TOKENS.light)).toBe(true);
    const { bg: _bg, ...missingOne } = TOKENS.light;
    expect(isThemeTokens(missingOne)).toBe(false);
    expect(isThemeTokens({ ...TOKENS.light, accent: 42 })).toBe(false);
    expect(isThemeTokens(null)).toBe(false);
    expect(isThemeTokens([])).toBe(false);
  });
});

describe('theme file export/import guard', () => {
  const payload = { name: 'Forest', light: TOKENS.light, dark: TOKENS.dark };

  it('exports a schema-marked file that validates on round-trip', () => {
    const file = themeExportFile(payload);
    expect(file).toContain('"schema": "theme/v1"');
    expect(validateThemeFile(JSON.parse(file))).toBeNull();
  });

  it('rejects non-theme shapes', () => {
    expect(validateThemeFile(null)).toMatch(/not a Partner theme file/);
    expect(validateThemeFile([])).toMatch(/not a Partner theme file/);
    expect(validateThemeFile({})).toMatch(/missing the theme\/v1 schema marker/);
    expect(validateThemeFile({ schema: 'theme/v1', name: 'X' })).toMatch(/missing color tokens/);
    expect(
      validateThemeFile({ schema: 'theme/v1', name: '  ', light: TOKENS.light, dark: TOKENS.dark }),
    ).toMatch(/no name/);
  });

  it('rejects oversized files', () => {
    expect(validateThemeFileSize('x'.repeat(600_000))).toMatch(/too large/);
    expect(validateThemeFileSize(themeExportFile(payload))).toBeNull();
  });
});

describe('shared token readout (read-only metadata)', () => {
  it('flattens every shared constant section with named rows', () => {
    const sections = sharedTokenReadout();
    const titles = sections.map((s) => s.title);
    expect(titles).toContain('Spacing (8px grid)');
    expect(titles).toContain('Elevation');
    for (const section of sections) {
      expect(section.rows.length).toBeGreaterThan(0);
      for (const row of section.rows) {
        expect(row.name.startsWith('--')).toBe(true);
        expect(row.value.length).toBeGreaterThan(0);
      }
    }
    const spacing = sections.find((s) => s.title === 'Spacing (8px grid)');
    expect(spacing?.rows.some((r) => r.name === '--space-4')).toBe(true);
  });
});

describe('token pair typing', () => {
  it('ThemeTokenPair carries both modes of a resolved token set', () => {
    const pair: ThemeTokenPair = { light: TOKENS.light, dark: TOKENS.dark };
    expect(pair.light.bg).toBe('#ffffff');
    expect(pair.dark.bg).toBe('#101214');
  });
});
