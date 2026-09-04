/**
 * M6 preset tests (PLAN-M6.md §"Tests"): the two presets seed idempotently
 * (only when the themes table is empty), Midnight passes the contrast gate,
 * preset rows are immutable through the manager (update/delete -> conflict
 * 409), and a copy of a preset saves cleanly as a custom theme.
 */
import { describe, expect, it } from 'vitest';
import type { ThemeSaveInput } from '@partner/shared';
import { TOKENS } from '@partner/shared';
import { validateTheme } from '../../src/theming/index.js';
import { PRESET_DEFAULT, PRESET_MIDNIGHT, THEME_PRESETS } from '../../src/theming/index.js';
import { ThemeError } from '../../src/theming/index.js';
import { makeThemingEnv } from './themingEnv.js';

describe('theme presets', () => {
  it('seed exactly once (idempotent by construction) in preset order', () => {
    const env = makeThemingEnv();
    try {
      expect(env.themes.list().map((p) => p.id)).toEqual(['preset-default', 'preset-midnight']);
      expect(env.stores.themes.count()).toBe(2);
      // A second seed is a no-op.
      expect(env.themes.seedIfEmpty()).toBe(0);
      expect(env.stores.themes.count()).toBe(2);
      // Rows carry the frozen shipped token documents.
      const midnight = env.stores.themes.findById('preset-midnight');
      expect(midnight).toMatchObject({ name: 'Midnight', source: 'preset' });
      expect(JSON.parse(midnight?.darkJson ?? '{}')).toMatchObject({
        bg: '#0b0d0f',
        surface2: '#20252a',
      });
      expect(JSON.parse(midnight?.lightJson ?? '{}')).toEqual(TOKENS.light);
    } finally {
      env.close();
    }
  });

  it('Default and Midnight definitions pass the full gate', () => {
    for (const preset of THEME_PRESETS) {
      const report = validateTheme({ light: preset.light, dark: preset.dark });
      expect(report.ok, `${preset.name} must pass the gate`).toBe(true);
      expect(report.errors).toHaveLength(0);
    }
    // Midnight really is a dark-forward variant of the same token set.
    expect(PRESET_MIDNIGHT.dark.bg).toBe('#0b0d0f');
    expect(PRESET_MIDNIGHT.light).toEqual(PRESET_DEFAULT.light);
    expect(PRESET_MIDNIGHT.dark).not.toEqual(PRESET_DEFAULT.dark);
  });

  it('preset rows are immutable through the manager (update/delete -> 409)', () => {
    const env = makeThemingEnv();
    try {
      const input: ThemeSaveInput = { name: 'X', light: TOKENS.light, dark: TOKENS.dark };
      for (const id of ['preset-default', 'preset-midnight']) {
        try {
          env.themes.update(id, input);
          expect.unreachable('preset update should throw conflict');
        } catch (err) {
          expect(err).toBeInstanceOf(ThemeError);
          expect((err as ThemeError).code).toBe('conflict');
        }
        try {
          env.themes.remove(id);
          expect.unreachable('preset delete should throw conflict');
        } catch (err) {
          expect(err).toBeInstanceOf(ThemeError);
          expect((err as ThemeError).code).toBe('conflict');
        }
      }
      // Unchanged: presets still present.
      expect(env.stores.themes.count()).toBe(2);
    } finally {
      env.close();
    }
  });

  it('a copy of a preset saves cleanly as a custom theme', () => {
    const env = makeThemingEnv();
    try {
      const copy = env.themes.save({
        name: 'My Midnight',
        light: PRESET_MIDNIGHT.light,
        dark: PRESET_MIDNIGHT.dark,
      });
      expect(copy).toMatchObject({ source: 'custom', name: 'My Midnight' });
      expect(copy.id.startsWith('custom-')).toBe(true);
      expect(env.themes.list().map((p) => p.source)).toEqual(['preset', 'preset', 'custom']);
    } finally {
      env.close();
    }
  });
});
