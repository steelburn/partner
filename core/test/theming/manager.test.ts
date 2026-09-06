/**
 * M6 theme manager tests (PLAN-M6.md §"Tests"): save/update run the
 * lint+contrast gate (a failing theme throws a typed ThemeError carrying the
 * report; nothing is stored); presets are immutable; delete is refused while
 * a theme is active; activate() writes the settings active_theme key;
 * persona binding via the REAL persona manager resolves persona -> global ->
 * preset-default, and clearing returns to the global theme. Audit rows carry
 * ids/names only — never token bodies.
 */
import { describe, expect, it } from 'vitest';
import type { ThemeSaveInput } from '@partner/shared';
import { TOKENS } from '@partner/shared';
import { ThemeError } from '../../src/theming/index.js';
import { makeThemingEnv } from './themingEnv.js';
import { sequentialClock } from '../notes/notesEnv.js';

function validSave(name = 'Forest'): ThemeSaveInput {
  return { name, light: { ...TOKENS.light }, dark: { ...TOKENS.dark } };
}

function brokenSave(name = 'Broken'): ThemeSaveInput {
  return { name, light: TOKENS.light, dark: { ...TOKENS.dark, textMuted: TOKENS.dark.surface } };
}

describe('theme manager — save + gate', () => {
  it('save stores a valid custom theme and returns its profile', () => {
    const env = makeThemingEnv({ now: sequentialClock() });
    try {
      const profile = env.themes.save(validSave('  Forest  '));
      expect(profile).toMatchObject({ source: 'custom', name: 'Forest' });
      expect(profile.id.startsWith('custom-')).toBe(true);
      expect(profile.light).toEqual(TOKENS.light);
      expect(profile.dark).toEqual(TOKENS.dark);
      expect(env.themes.get(profile.id)).toEqual(profile);
      expect(env.stores.themes.count()).toBe(3);
      // Custom rows land after the presets in list().
      expect(env.themes.list().map((p) => p.source)).toEqual(['preset', 'preset', 'custom']);
    } finally {
      env.close();
    }
  });

  it('save refuses a gate-failing theme with a typed error + report, storing nothing', () => {
    const env = makeThemingEnv();
    try {
      try {
        env.themes.save(brokenSave());
        expect.unreachable('broken theme should be refused');
      } catch (err) {
        expect(err).toBeInstanceOf(ThemeError);
        const themeErr = err as ThemeError;
        expect(themeErr.code).toBe('invalid_input');
        expect(themeErr.report?.ok).toBe(false);
        expect(themeErr.report?.errors.some((e) => e.token === 'dark.textMuted')).toBe(true);
      }
      expect(env.stores.themes.count()).toBe(2);
    } finally {
      env.close();
    }
  });

  it('save refuses a blank name and a structurally garbage body', () => {
    const env = makeThemingEnv();
    try {
      try {
        env.themes.save({ name: '   ' } as ThemeSaveInput);
        expect.unreachable('blank name should be refused');
      } catch (err) {
        expect(err).toBeInstanceOf(ThemeError);
        expect((err as ThemeError).code).toBe('invalid_input');
        expect((err as ThemeError).message).toContain('name');
      }
      try {
        env.themes.save({ name: 'X', light: 'nope' } as unknown as ThemeSaveInput);
        expect.unreachable('garbage tokens should be refused');
      } catch (err) {
        expect((err as ThemeError).report?.ok).toBe(false);
      }
      expect(env.stores.themes.count()).toBe(2);
    } finally {
      env.close();
    }
  });
});

describe('theme manager — update/remove rules', () => {
  it('update renames + edits tokens under the same gate (partial ok)', () => {
    const env = makeThemingEnv({ now: sequentialClock() });
    try {
      const saved = env.themes.save(validSave('Forest'));
      const renamed = env.themes.update(saved.id, { name: 'Moss' } as ThemeSaveInput);
      expect(renamed.name).toBe('Moss');
      // Omitted modes keep the stored tokens.
      expect(renamed.dark).toEqual(saved.dark);
      const recolored = env.themes.update(saved.id, {
        light: { ...TOKENS.light, accent: '#195936' },
      } as ThemeSaveInput);
      expect(recolored.light.accent).toBe('#195936');
      expect(recolored.dark).toEqual(TOKENS.dark);
      expect(env.themes.get(saved.id)?.light.accent).toBe('#195936');
    } finally {
      env.close();
    }
  });

  it('update runs the gate on the MERGED theme and refuses a broken edit', () => {
    const env = makeThemingEnv();
    try {
      const saved = env.themes.save(validSave('Forest'));
      try {
        env.themes.update(saved.id, {
          dark: { ...TOKENS.dark, textMuted: TOKENS.dark.surface },
        } as ThemeSaveInput);
        expect.unreachable('broken update should be refused');
      } catch (err) {
        expect(err).toBeInstanceOf(ThemeError);
        expect((err as ThemeError).code).toBe('invalid_input');
        expect((err as ThemeError).report?.ok).toBe(false);
      }
      expect(env.themes.get(saved.id)?.dark.textMuted).toBe(TOKENS.dark.textMuted);
    } finally {
      env.close();
    }
  });

  it('update/remove: unknown id -> not_found; presets -> conflict', () => {
    const env = makeThemingEnv();
    try {
      try {
        env.themes.update('custom-nope', validSave('X'));
        expect.unreachable('missing theme update should 404');
      } catch (err) {
        expect((err as ThemeError).code).toBe('not_found');
      }
      try {
        env.themes.remove('custom-nope');
        expect.unreachable('missing theme delete should 404');
      } catch (err) {
        expect((err as ThemeError).code).toBe('not_found');
      }
    } finally {
      env.close();
    }
  });

  it('delete refuses the ACTIVE theme and a preset; allows an inactive custom', () => {
    const env = makeThemingEnv({ now: sequentialClock() });
    try {
      const saved = env.themes.save(validSave('Temporary'));
      env.themes.activate(saved.id);
      try {
        env.themes.remove(saved.id);
        expect.unreachable('active theme delete should be refused');
      } catch (err) {
        expect(err).toBeInstanceOf(ThemeError);
        expect((err as ThemeError).code).toBe('conflict');
        expect((err as ThemeError).message).toContain('active');
      }
      // Activate a preset first, then the delete goes through.
      env.themes.activate('preset-default');
      env.themes.remove(saved.id);
      expect(env.themes.get(saved.id)).toBeNull();
    } finally {
      env.close();
    }
  });
});

describe('theme manager — activation + persona binding resolution', () => {
  it('activate writes settings active_theme and returns {id, source}', () => {
    const env = makeThemingEnv();
    try {
      const activation = env.themes.activate('preset-midnight');
      expect(activation).toEqual({ id: 'preset-midnight', source: 'preset' });
      expect(env.stores.settings.get('active_theme')).toBe('preset-midnight');
      // Unknown activation -> not_found.
      try {
        env.themes.activate('custom-nope');
        expect.unreachable('unknown activation should 404');
      } catch (err) {
        expect((err as ThemeError).code).toBe('not_found');
      }
    } finally {
      env.close();
    }
  });

  it('active() resolves persona binding -> global -> preset-default', () => {
    const env = makeThemingEnv();
    try {
      // Empty state: default preset.
      expect(env.themes.active().themeId).toBe('preset-default');

      // Global activation applies everywhere there is no binding.
      env.themes.activate('preset-midnight');
      expect(env.themes.active().themeId).toBe('preset-midnight');
      expect(env.themes.active('p-researcher').themeId).toBe('preset-midnight');

      // Persona binding wins over the global theme.
      env.themes.bindPersonaTheme('p-builder', 'preset-default');
      expect(env.themes.active('p-builder').themeId).toBe('preset-default');
      expect(env.themes.active('p-researcher').themeId).toBe('preset-midnight');

      // Clearing returns the persona to the global theme.
      env.themes.bindPersonaTheme('p-builder', null);
      expect(env.themes.active('p-builder').themeId).toBe('preset-midnight');

      // An unknown persona id is treated as unbound (global).
      expect(env.themes.active('p-missing').themeId).toBe('preset-midnight');
    } finally {
      env.close();
    }
  });

  it('binds through the REAL persona manager (colorTheme column round-trip)', () => {
    const env = makeThemingEnv();
    try {
      env.personas.update('p-builder', { colorTheme: 'preset-midnight' });
      expect(env.personas.get('p-builder')?.colorTheme).toBe('preset-midnight');
      expect(env.themes.active('p-builder').themeId).toBe('preset-midnight');
      // Unbound personas stay on the global theme.
      expect(env.themes.active().themeId).toBe('preset-default');
    } finally {
      env.close();
    }
  });

  it('bindPersonaTheme validates persona + theme existence', () => {
    const env = makeThemingEnv();
    try {
      try {
        env.themes.bindPersonaTheme('p-missing', 'preset-midnight');
        expect.unreachable('missing persona should 404');
      } catch (err) {
        expect((err as ThemeError).code).toBe('not_found');
      }
      try {
        env.themes.bindPersonaTheme('p-builder', 'custom-nope');
        expect.unreachable('missing theme should 404');
      } catch (err) {
        expect((err as ThemeError).code).toBe('not_found');
      }
      expect(env.personas.get('p-builder')?.colorTheme).toBeUndefined();
    } finally {
      env.close();
    }
  });

  it('resolution falls back when the bound theme was deleted', () => {
    const env = makeThemingEnv({ now: sequentialClock() });
    try {
      const saved = env.themes.save(validSave('Transient'));
      env.themes.bindPersonaTheme('p-builder', saved.id);
      expect(env.themes.active('p-builder').themeId).toBe(saved.id);
      // Deleting an inactive custom is allowed; the persona then falls back.
      env.themes.remove(saved.id);
      expect(env.themes.active('p-builder').themeId).toBe('preset-default');
    } finally {
      env.close();
    }
  });
});

describe('theme manager — audit discipline', () => {
  it('audits create/update/delete/activate/bind with ids and names only', () => {
    const env = makeThemingEnv();
    try {
      const saved = env.themes.save(validSave('Audited'));
      env.themes.update(saved.id, { name: 'Audited v2' } as ThemeSaveInput);
      env.themes.activate(saved.id);
      env.themes.bindPersonaTheme('p-builder', saved.id);
      env.themes.activate('preset-default');
      env.themes.remove(saved.id);

      const rows = env.audit.list(100);
      const actions = rows
        .filter((r) => r.action.startsWith('theme.'))
        .map((r) => r.action);
      for (const expected of ['theme.create', 'theme.update', 'theme.activate', 'theme.bind', 'theme.delete']) {
        expect(actions, expected).toContain(expected);
      }
      const create = rows.find((r) => r.action === 'theme.create');
      const details = JSON.parse(create?.details ?? '{}') as Record<string, unknown>;
      expect(details).toMatchObject({ name: 'Audited', source: 'custom' });
      const serialized = JSON.stringify(rows);
      // Token BODIES never cross audit (ids/names only) — no hex colors.
      expect(serialized).not.toContain('#1f6f43');
      const bind = rows.find((r) => r.action === 'theme.bind');
      expect(JSON.parse(bind?.details ?? '{}')).toMatchObject({ themeName: 'Audited v2' });
    } finally {
      env.close();
    }
  });
});

describe('theme manager — D6 conversation binding', () => {
  it('conversation override wins over persona + global; clearing falls back', () => {
    const env = makeThemingEnv();
    try {
      env.themes.activate('preset-midnight');
      env.themes.bindPersonaTheme('p-researcher', 'preset-default');
      // Conversation override beats the persona binding.
      env.themes.bindConversationTheme('c-1', 'preset-midnight');
      expect(env.themes.active('p-researcher', 'c-1').themeId).toBe('preset-midnight');
      // Other conversations keep the persona resolution.
      expect(env.themes.active('p-researcher', 'c-2').themeId).toBe('preset-default');
      // Clearing the conversation override falls back to the persona binding.
      env.themes.bindConversationTheme('c-1', null);
      expect(env.themes.active('p-researcher', 'c-1').themeId).toBe('preset-default');
      // Unknown theme to bind -> not_found.
      try {
        env.themes.bindConversationTheme('c-1', 'custom-nope');
        expect.unreachable('unknown theme should 404');
      } catch (err) {
        expect((err as ThemeError).code).toBe('not_found');
      }
    } finally {
      env.close();
    }
  });
});
