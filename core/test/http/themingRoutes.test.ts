/**
 * M6 HTTP surface tests (PLAN-M6 wire spec): every /v1/themes,
 * /v1/theme/active and /v1/personas/:id/theme route is authed (401) and 501
 * not_configured when the theme manager is not wired; happy paths (list with
 * presets first, create/update/delete custom themes, activate, resolved
 * active theme) and typed errors — a gate-failing save returns 400 with the
 * full ThemeReport body; preset/active deletes return 409; unknown ids 404.
 * Per-persona resolution is proven against the REAL persona manager exposed
 * by the harness (bind 'p-builder' -> midnight).
 */
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import type { ThemeTokens } from '@partner/shared';
import { TOKENS } from '@partner/shared';
import { demoHarness, ALLOWED_HOST } from '../helpers.js';
import type { Harness } from '../helpers.js';

const defaults: { light: ThemeTokens; dark: ThemeTokens } = {
  light: TOKENS.light,
  dark: TOKENS.dark,
};

async function pairToken(h: Harness): Promise<string> {
  const code = await h.pairing.issue();
  const pairRes = await request(h.app).post('/v1/pair').set('Host', ALLOWED_HOST).send({ code });
  expect(pairRes.status).toBe(200);
  return pairRes.body.token as string;
}

function authed(token: string): Record<string, string> {
  return { Host: ALLOWED_HOST, Authorization: `Bearer ${token}` };
}

const THEME_ROUTES: Array<[string, string]> = [
  ['get', '/v1/themes'],
  ['post', '/v1/themes'],
  ['put', '/v1/themes/x'],
  ['delete', '/v1/themes/x'],
  ['post', '/v1/themes/x/activate'],
  ['get', '/v1/theme/active'],
  ['post', '/v1/personas/p-builder/theme'],
];

/** A body that always passes the gate (the shipped token documents). */
function goodBody(name = 'Forest'): Record<string, unknown> {
  return { name, light: { ...defaults.light }, dark: { ...defaults.dark } };
}


describe('M6 theme routes — auth + wiring gates', () => {
  it('returns 401 without a token on every theme route', async () => {
    const h = demoHarness();
    try {
      for (const [method, path] of THEME_ROUTES) {
        const res = await request(h.app)[method as 'get' | 'post' | 'put' | 'delete'](path)
          .set('Host', ALLOWED_HOST)
          .send({ themeId: 'preset-midnight', name: 'x', light: {}, dark: {} });
        expect(res.status, `${method} ${path}`).toBe(401);
      }
    } finally {
      h.close();
    }
  });

  it('501s not_configured when the theme manager is not wired', async () => {
    const h = demoHarness({ themes: false });
    try {
      const token = await pairToken(h);
      for (const [method, path] of THEME_ROUTES) {
        const res = await request(h.app)[method as 'get' | 'post' | 'put' | 'delete'](path)
          .set(authed(token))
          .send({ themeId: 'preset-midnight', name: 'x', light: defaults.light, dark: defaults.dark });
        expect(res.status, `${method} ${path}`).toBe(501);
        expect(res.body.error).toBe('not_configured');
      }
    } finally {
      h.close();
    }
  });
});

describe('theme CRUD routes', () => {
  it('GET lists the two seeded presets first with parsed token docs', async () => {
    const h = demoHarness();
    try {
      const token = await pairToken(h);
      const res = await request(h.app).get('/v1/themes').set(authed(token));
      expect(res.status).toBe(200);
      const themes = res.body.themes as Array<{
        id: string;
        name: string;
        source: string;
        light: ThemeTokens;
        dark: ThemeTokens;
      }>;
      expect(themes.map((t) => t.id)).toEqual(['preset-default', 'preset-midnight']);
      expect(themes.every((t) => t.source === 'preset')).toBe(true);
      expect(themes[0]?.light).toEqual(defaults.light);
      expect(themes[1]?.dark.bg).toBe('#0b0d0f');
    } finally {
      h.close();
    }
  });

  it('POST creates a custom theme -> 201 with the profile', async () => {
    const h = demoHarness();
    try {
      const token = await pairToken(h);
      const res = await request(h.app)
        .post('/v1/themes')
        .set(authed(token))
        .send(goodBody('Sage 2'));
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ name: 'Sage 2', source: 'custom' });
      expect((res.body.id as string).startsWith('custom-')).toBe(true);
      expect(res.body.light).toEqual(defaults.light);
      const list = await request(h.app).get('/v1/themes').set(authed(token));
      expect(list.body.themes).toHaveLength(3);
    } finally {
      h.close();
    }
  });

  it('POST of a gate-failing theme -> 400 with the report body', async () => {
    const h = demoHarness();
    try {
      const token = await pairToken(h);
      const res = await request(h.app)
        .post('/v1/themes')
        .set(authed(token))
        .send({ name: 'Broken', light: defaults.light, dark: { ...defaults.dark, textMuted: defaults.dark.surface } });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_input');
      expect(res.body.report).toBeDefined();
      expect(res.body.report.ok).toBe(false);
      const error = (res.body.report.errors as Array<{ token: string; message: string }>).find(
        (e) => e.token === 'dark.textMuted',
      );
      expect(error).toBeDefined();
      expect(error?.message).toContain('< 75');
      // Nothing was stored.
      const list = await request(h.app).get('/v1/themes').set(authed(token));
      expect(list.body.themes).toHaveLength(2);
    } finally {
      h.close();
    }
  });

  it('POST with a blank name -> 400 invalid_input', async () => {
    const h = demoHarness();
    try {
      const token = await pairToken(h);
      const res = await request(h.app)
        .post('/v1/themes')
        .set(authed(token))
        .send({ name: '   ', light: defaults.light, dark: defaults.dark });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_input');
    } finally {
      h.close();
    }
  });

  it('PUT updates a custom theme; preset PUT and unknown PUT are refused', async () => {
    const h = demoHarness();
    try {
      const token = await pairToken(h);
      const created = await request(h.app).post('/v1/themes').set(authed(token)).send(goodBody('Edit me'));
      const id = (created.body as { id: string }).id;

      const updated = await request(h.app)
        .put(`/v1/themes/${id}`)
        .set(authed(token))
        .send(goodBody('Edited'));
      expect(updated.status).toBe(200);
      expect(updated.body.name).toBe('Edited');

      const preset = await request(h.app)
        .put('/v1/themes/preset-default')
        .set(authed(token))
        .send(goodBody('nope'));
      expect(preset.status).toBe(409);
      expect(preset.body.error).toBe('conflict');

      const missing = await request(h.app)
        .put('/v1/themes/custom-nope')
        .set(authed(token))
        .send(goodBody('nope'));
      expect(missing.status).toBe(404);

      const broken = await request(h.app)
        .put(`/v1/themes/${id}`)
        .set(authed(token))
        .send({ name: 'X', light: defaults.light, dark: { ...defaults.dark, textMuted: defaults.dark.surface } });
      expect(broken.status).toBe(400);
      expect(broken.body.report.ok).toBe(false);
    } finally {
      h.close();
    }
  });

  it('DELETE refuses presets and the active theme; removes an inactive custom', async () => {
    const h = demoHarness();
    try {
      const token = await pairToken(h);
      const preset = await request(h.app).delete('/v1/themes/preset-default').set(authed(token));
      expect(preset.status).toBe(409);

      const created = await request(h.app).post('/v1/themes').set(authed(token)).send(goodBody('Temp'));
      const id = (created.body as { id: string }).id;
      await request(h.app).post(`/v1/themes/${id}/activate`).set(authed(token));
      const active = await request(h.app).delete(`/v1/themes/${id}`).set(authed(token));
      expect(active.status).toBe(409);

      await request(h.app).post('/v1/themes/preset-default/activate').set(authed(token));
      const gone = await request(h.app).delete(`/v1/themes/${id}`).set(authed(token));
      expect(gone.status).toBe(204);
      expect((await request(h.app).get('/v1/themes').set(authed(token))).body.themes).toHaveLength(2);

      const missing = await request(h.app).delete('/v1/themes/custom-nope').set(authed(token));
      expect(missing.status).toBe(404);
    } finally {
      h.close();
    }
  });
});

describe('activation + active resolution routes', () => {
  it('activate returns the activation and GET /v1/theme/active returns it', async () => {
    const h = demoHarness();
    try {
      const token = await pairToken(h);
      const active = await request(h.app).get('/v1/theme/active').set(authed(token));
      expect(active.status).toBe(200);
      expect(active.body).toMatchObject({ themeId: 'preset-default', source: 'preset' });

      const activated = await request(h.app)
        .post('/v1/themes/preset-midnight/activate')
        .set(authed(token))
        .send({});
      expect(activated.status).toBe(200);
      expect(activated.body).toEqual({ id: 'preset-midnight', source: 'preset' });

      const nowActive = await request(h.app).get('/v1/theme/active').set(authed(token));
      expect(nowActive.body).toMatchObject({ themeId: 'preset-midnight', source: 'preset' });
      expect(nowActive.body.dark.bg).toBe('#0b0d0f');
    } finally {
      h.close();
    }
  });

  it('binds a theme to a persona via the route and resolves per-persona', async () => {
    const h = demoHarness();
    try {
      const token = await pairToken(h);
      const bind = await request(h.app)
        .post('/v1/personas/p-builder/theme')
        .set(authed(token))
        .send({ themeId: 'preset-midnight' });
      expect(bind.status).toBe(200);
      expect(bind.body).toEqual({ personaId: 'p-builder', themeId: 'preset-midnight' });

      const builder = await request(h.app)
        .get('/v1/theme/active?personaId=p-builder')
        .set(authed(token));
      expect(builder.body.themeId).toBe('preset-midnight');
      // Unbound persona + no global activation -> default.
      const researcher = await request(h.app)
        .get('/v1/theme/active?personaId=p-researcher')
        .set(authed(token));
      expect(researcher.body.themeId).toBe('preset-default');

      // Clear the binding -> back to the global theme.
      const clear = await request(h.app)
        .post('/v1/personas/p-builder/theme')
        .set(authed(token))
        .send({ themeId: null });
      expect(clear.status).toBe(200);
      expect(clear.body.themeId).toBeNull();
      const afterClear = await request(h.app)
        .get('/v1/theme/active?personaId=p-builder')
        .set(authed(token));
      expect(afterClear.body.themeId).toBe('preset-default');
    } finally {
      h.close();
    }
  });

  it('persona resolution works through the REAL persona manager (helpers expose personas)', async () => {
    const h = demoHarness();
    try {
      const token = await pairToken(h);
      // Bind via the persona manager's update path (not the theme route).
      h.personas.update('p-builder', { colorTheme: 'preset-midnight' });
      const builder = await request(h.app)
        .get('/v1/theme/active?personaId=p-builder')
        .set(authed(token));
      expect(builder.body.themeId).toBe('preset-midnight');
      expect(builder.body.source).toBe('preset');
      // Everyone else and the anonymous request see the global default.
      const globalTheme = await request(h.app).get('/v1/theme/active').set(authed(token));
      expect(globalTheme.body.themeId).toBe('preset-default');
    } finally {
      h.close();
    }
  });

  it('bind to an unknown theme/persona -> 404; bad body -> 400', async () => {
    const h = demoHarness();
    try {
      const token = await pairToken(h);
      const noTheme = await request(h.app)
        .post('/v1/personas/p-builder/theme')
        .set(authed(token))
        .send({ themeId: 'custom-nope' });
      expect(noTheme.status).toBe(404);
      const noPersona = await request(h.app)
        .post('/v1/personas/p-missing/theme')
        .set(authed(token))
        .send({ themeId: 'preset-default' });
      expect(noPersona.status).toBe(404);
      const badBody = await request(h.app)
        .post('/v1/personas/p-builder/theme')
        .set(authed(token))
        .send({ themeId: 42 });
      expect(badBody.status).toBe(400);
      expect(h.personas.get('p-builder')?.colorTheme).toBeUndefined();
    } finally {
      h.close();
    }
  });
});
