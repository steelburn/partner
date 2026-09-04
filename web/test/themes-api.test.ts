import { describe, expect, it } from 'vitest';
import { TOKENS } from '@partner/shared';
import type { ActiveTheme, Persona, ThemeProfile, ThemeTokens } from '@partner/shared';
import { ApiRequestError, type FetchLike } from '../src/lib/api.js';
import {
  activateTheme,
  bindPersonaTheme,
  createTheme,
  deleteTheme,
  getActiveTheme,
  listThemes,
  parseActivation,
  parseActiveTheme,
  parseThemeList,
  parseThemeProfile,
  parseThemeReport,
  updateTheme,
} from '../src/lib/themes.js';

const TOKEN = 'tok-secret';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function textResponse(text: string, status = 200): Response {
  return new Response(text, { status, headers: { 'content-type': 'application/json' } });
}

function recordFetch(fn: (input: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ input: string; init?: RequestInit }> = [];
  const fetchImpl: FetchLike = (input, init) => {
    calls.push({ input, init });
    return Promise.resolve(fn(input, init));
  };
  return { fetchImpl, calls };
}

function tokens(overrides: Partial<ThemeTokens> = {}): ThemeTokens {
  return { ...TOKENS.light, ...overrides };
}

function profile(overrides: Partial<ThemeProfile> = {}): ThemeProfile {
  return {
    id: 't1',
    name: 'Forest',
    source: 'custom',
    light: TOKENS.light,
    dark: TOKENS.dark,
    ...overrides,
  };
}

function persona(overrides: Partial<Persona> = {}): Persona {
  return {
    id: 'p1',
    name: 'Maya',
    isDefault: false,
    paused: false,
    createdAt: 1,
    updatedAt: 2,
    character: { voice: 'warm', language: 'en', systemPrompt: '', temperature: 0.6 },
    model: { taskClasses: {} },
    independence: { level: 'assist', requireHumanFor: [], autoScopes: [] },
    memory: { userProfile: 'none', episodes: 'none' },
    ...overrides,
  };
}

const AUTH = { authorization: `Bearer ${TOKEN}` };

describe('theme list + profile parsing', () => {
  it('GET /v1/themes accepts a bare array or a {themes} envelope', async () => {
    const profiles = [profile({ source: 'preset', id: 'preset-default' }), profile({ id: 'c1' })];
    for (const body of [profiles, { themes: profiles }]) {
      const { fetchImpl, calls } = recordFetch(() => jsonResponse(body));
      const result = await listThemes(TOKEN, { fetchImpl });
      expect(result).toHaveLength(2);
      expect(result[0].source).toBe('preset');
      expect(calls[0].input).toBe('/v1/themes');
      expect(calls[0].init?.method).toBe('GET');
      expect(calls[0].init?.headers).toMatchObject(AUTH);
    }
  });

  it('throws a readable error for a non-list response', async () => {
    const { fetchImpl } = recordFetch(() => jsonResponse({ nope: true }));
    await expect(listThemes(TOKEN, { fetchImpl })).rejects.toThrow(
      'The themes response had an unexpected shape.',
    );
  });

  it('surfaces non-2xx as ApiRequestError', async () => {
    const { fetchImpl } = recordFetch(() => jsonResponse({ error: 'nope' }, 500));
    await expect(listThemes(TOKEN, { fetchImpl })).rejects.toThrow(ApiRequestError);
  });

  it('normalizes profiles bare or wrapped, defaulting a missing source to custom', () => {
    expect(parseThemeProfile(profile(), 200).source).toBe('custom');
    expect(parseThemeProfile({ theme: profile({ source: 'preset' }) }, 200).source).toBe('preset');
    const missingSource = profile();
    delete (missingSource as { source?: string }).source;
    expect(parseThemeProfile({ profile: missingSource }, 200).source).toBe('custom');
    expect(() => parseThemeProfile({ id: 'x' }, 400)).toThrow(ApiRequestError);
    expect(parseThemeList([profile(), profile({ id: 'p' })]).map((p) => p.id)).toEqual(['t1', 'p']);
  });
});

describe('theme create/update (gate reports)', () => {
  it('POST /v1/themes -> profile on success (bare or wrapped)', async () => {
    const input = { name: 'Forest', light: TOKENS.light, dark: TOKENS.dark };
    for (const body of [profile(), { profile: profile() }]) {
      const { fetchImpl, calls } = recordFetch(() => jsonResponse(body, 201));
      const result = await createTheme(TOKEN, input, { fetchImpl });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.profile.id).toBe('t1');
      expect(calls[0].input).toBe('/v1/themes');
      expect(calls[0].init?.method).toBe('POST');
      expect(JSON.parse(String(calls[0].init?.body))).toEqual(input);
    }
  });

  it('PUT /v1/themes/:id routes the id and parses the updated profile', async () => {
    const { fetchImpl, calls } = recordFetch(() => jsonResponse({ profile: profile() }));
    const result = await updateTheme(TOKEN, 't1', { name: 'x', light: TOKENS.light, dark: TOKENS.dark }, { fetchImpl });
    expect(result.ok).toBe(true);
    expect(calls[0].input).toBe('/v1/themes/t1');
    expect(calls[0].init?.method).toBe('PUT');
  });

  it('maps a 400 report body to {ok:false, report} without throwing', async () => {
    const reportBody = {
      ok: false,
      errors: [
        {
          token: 'dark.textMuted',
          mode: 'dark',
          message: 'text on surface Lc 51 < 75',
          apca: 51.2,
          wcag: 2.1,
        },
      ],
      warnings: [],
    };
    for (const body of [reportBody, { report: reportBody }, { error: { report: reportBody } }]) {
      const { fetchImpl } = recordFetch(() => jsonResponse(body, 400));
      const result = await createTheme(TOKEN, { name: 'x', light: TOKENS.light, dark: TOKENS.dark }, { fetchImpl });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.status).toBe(400);
        expect(result.report).not.toBeNull();
        expect(result.report?.errors).toHaveLength(1);
        expect(result.report?.errors[0]).toMatchObject({
          token: 'dark.textMuted',
          mode: 'dark',
          apca: 51.2,
          wcag: 2.1,
        });
        expect(result.message.length).toBeGreaterThan(0);
      }
    }
  });

  it('a 400 without report fields falls back to the error message', async () => {
    const { fetchImpl } = recordFetch(() =>
      jsonResponse({ error: { message: 'A lint rule failed.' } }, 400),
    );
    const result = await createTheme(TOKEN, { name: 'x', light: TOKENS.light, dark: TOKENS.dark }, { fetchImpl });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.report).toBeNull();
      expect(result.message).toContain('A lint rule failed.');
    }
  });

  it('throws for non-400 failures and for empty success bodies', async () => {
    const { fetchImpl: f500 } = recordFetch(() => jsonResponse({ error: 'boom' }, 500));
    await expect(
      createTheme(TOKEN, { name: 'x', light: TOKENS.light, dark: TOKENS.dark }, { fetchImpl: f500 }),
    ).rejects.toThrow(ApiRequestError);
    const { fetchImpl: fEmpty } = recordFetch(() => textResponse('', 201));
    await expect(
      createTheme(TOKEN, { name: 'x', light: TOKENS.light, dark: TOKENS.dark }, { fetchImpl: fEmpty }),
    ).rejects.toThrow(/empty/);
  });

  it('throws when a success body is not profile-shaped', async () => {
    const { fetchImpl } = recordFetch(() => jsonResponse({ id: 42 }, 201));
    await expect(
      createTheme(TOKEN, { name: 'x', light: TOKENS.light, dark: TOKENS.dark }, { fetchImpl }),
    ).rejects.toThrow('The theme response had an unexpected shape.');
  });
});

describe('delete + activate', () => {
  it('DELETE /v1/themes/:id resolves on 2xx and throws otherwise', async () => {
    const { fetchImpl, calls } = recordFetch(() => new Response(null, { status: 204 }));
    await expect(deleteTheme(TOKEN, 't1', { fetchImpl })).resolves.toBeUndefined();
    expect(calls[0].init?.method).toBe('DELETE');
    expect(calls[0].input).toBe('/v1/themes/t1');

    const { fetchImpl: fErr } = recordFetch(() => jsonResponse({ error: 'active' }, 409));
    await expect(deleteTheme(TOKEN, 't1', { fetchImpl: fErr })).rejects.toThrow(ApiRequestError);
  });

  it('POST /v1/themes/:id/activate returns the activation or null on 204', async () => {
    const { fetchImpl: fJson, calls } = recordFetch(() =>
      jsonResponse({ id: 'preset-default', source: 'preset' }),
    );
    await expect(activateTheme(TOKEN, 'preset-default', { fetchImpl: fJson })).resolves.toEqual({
      id: 'preset-default',
      source: 'preset',
    });
    expect(calls[0].init?.method).toBe('POST');
    expect(calls[0].input).toBe('/v1/themes/preset-default/activate');

    const { fetchImpl: f204 } = recordFetch(() => new Response(null, { status: 204 }));
    await expect(activateTheme(TOKEN, 't1', { fetchImpl: f204 })).resolves.toBeNull();
  });

  it('parses activations bare or wrapped', () => {
    expect(parseActivation({ id: 'x', source: 'custom' })).toEqual({ id: 'x', source: 'custom' });
    expect(parseActivation({ activation: { id: 'y', source: 'preset' } })).toEqual({
      id: 'y',
      source: 'preset',
    });
    expect(parseActivation({ id: 'z' }, 200).source).toBe('custom');
    expect(() => parseActivation({}, 200)).toThrow(ApiRequestError);
  });
});

describe('active theme resolution', () => {
  it('GET /v1/theme/active adds the persona query when one is given', async () => {
    const body: ActiveTheme = {
      themeId: 'preset-default',
      source: 'preset',
      light: TOKENS.light,
      dark: TOKENS.dark,
    };
    const { fetchImpl, calls } = recordFetch(() => jsonResponse(body));
    const result = await getActiveTheme(TOKEN, 'p1', { fetchImpl });
    expect(result.themeId).toBe('preset-default');
    expect(calls[0].input).toBe('/v1/theme/active?personaId=p1');
    expect(calls[0].init?.headers).toMatchObject(AUTH);

    const { fetchImpl: f2, calls: calls2 } = recordFetch(() => jsonResponse({ active: body }));
    await getActiveTheme(TOKEN, null, { fetchImpl: f2 });
    expect(calls2[0].input).toBe('/v1/theme/active');
    await getActiveTheme(TOKEN, undefined, { fetchImpl: f2 });
    expect(calls2[1].input).toBe('/v1/theme/active');
  });

  it('parses active themes bare or wrapped, and rejects malformed ones', () => {
    const body: ActiveTheme = { themeId: 't1', source: 'custom', light: TOKENS.light, dark: TOKENS.dark };
    expect(parseActiveTheme(body).themeId).toBe('t1');
    expect(parseActiveTheme({ theme: body }).source).toBe('custom');
    expect(parseActiveTheme({ active: { ...body, source: 'preset' } }).source).toBe('preset');
    expect(() => parseActiveTheme({ themeId: 't1' }, 200)).toThrow(ApiRequestError);
    expect(() => parseActiveTheme({}, 200)).toThrow(ApiRequestError);
  });

  it('throws ApiRequestError when the core session is gone', async () => {
    const { fetchImpl } = recordFetch(() => jsonResponse({ error: 'unauthorized' }, 401));
    await expect(getActiveTheme(TOKEN, undefined, { fetchImpl })).rejects.toThrow(ApiRequestError);
  });
});

describe('per-persona theme binding', () => {
  it('POST /v1/personas/:id/theme sends themeId null when clearing', async () => {
    const { fetchImpl, calls } = recordFetch(() => new Response(null, { status: 204 }));
    await expect(bindPersonaTheme(TOKEN, 'p1', null, { fetchImpl })).resolves.toBeNull();
    expect(calls[0].init?.method).toBe('POST');
    expect(calls[0].input).toBe('/v1/personas/p1/theme');
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ themeId: null });
  });

  it('sends the theme id and parses an updated persona body', async () => {
    const updated = persona({ colorTheme: 't1' });
    const { fetchImpl, calls } = recordFetch(() => jsonResponse({ persona: updated }));
    const result = await bindPersonaTheme(TOKEN, 'p1', 't1', { fetchImpl });
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ themeId: 't1' });
    expect(result?.colorTheme).toBe('t1');
    expect(result?.id).toBe('p1');
  });

  it('propagates API failures', async () => {
    const { fetchImpl } = recordFetch(() => jsonResponse({ error: 'no such theme' }, 404));
    await expect(bindPersonaTheme(TOKEN, 'p1', 't9', { fetchImpl })).rejects.toThrow(
      'no such theme',
    );
  });
});

describe('parseThemeReport envelope tolerance', () => {
  it('finds the report in every wrapper and derives ok when absent', () => {
    const errors = [{ token: 'light.text', mode: 'light', message: 'bad pair' }];
    expect(parseThemeReport({ ok: false, errors, warnings: [] })?.errors).toHaveLength(1);
    expect(parseThemeReport({ report: { ok: false, errors, warnings: [] } })?.ok).toBe(false);
    expect(parseThemeReport({ error: { report: { ok: false, errors, warnings: [] } } })?.errors).toHaveLength(1);
    // {errors} alone derives ok=false when errors exist.
    expect(parseThemeReport({ errors })?.ok).toBe(false);
    // Warnings only -> ok=true.
    expect(parseThemeReport({ warnings: [{ token: 'x', mode: 'light', message: 'w' }] })?.ok).toBe(true);
    expect(parseThemeReport({})).toBeNull();
    expect(parseThemeReport('nope')).toBeNull();
  });

  it('drops malformed issues and keeps finite numeric metrics', () => {
    const report = parseThemeReport({
      ok: false,
      errors: [
        { token: 'dark.textMuted', mode: 'dark', message: 'ok', apca: 51.2, wcag: 2.1 },
        { token: 'dark.textMuted', mode: 'dark', message: 42 },
        { token: 'no-dot', mode: 'light', message: 'missing dot' },
        { mode: 'light', message: 'missing token' },
        { token: 'dark.accent', mode: 'sepia', message: 'bad mode' },
      ],
      warnings: [],
    });
    expect(report?.errors).toHaveLength(2);
    expect(report?.errors[0].apca).toBe(51.2);
    expect(report?.errors[0].wcag).toBe(2.1);
    // Token PATH content is not re-validated here (the studio's
    // parseIssueToken falls back gracefully for display); shape only.
    expect(report?.errors[1].token).toBe('no-dot');
  });

  it('extracts plain error messages from 400s that are not reports', async () => {
    const { fetchImpl } = recordFetch(() =>
      textResponse(JSON.stringify({ error: { message: 'Name is taken' } }), 400),
    );
    const result = await createTheme(TOKEN, { name: 'x', light: TOKENS.light, dark: TOKENS.dark }, { fetchImpl });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.report).toBeNull();
      expect(result.message).toContain('Name is taken');
    }
  });
});
