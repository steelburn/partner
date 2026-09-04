/**
 * M6 cross-cutting e2e over a spawned demo core (PLAN-M6.md exit): a valid
 * custom theme is created, activated, and returned by /v1/theme/active; a
 * broken theme (muted == background) is refused with a contrast report.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const root = `${here}..`;
const corePort = 40_000 + (process.pid % 10_000);

let core: ChildProcess;
let base: string;
let token = '';
let coreOut = '';

async function waitForHealth(timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/v1/health`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('core never became healthy');
}

function authed(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${base}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  });
}

beforeAll(async () => {
  core = spawn(process.execPath, ['--import', 'tsx', 'core/src/index.ts'], {
    cwd: root,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      PORT: String(corePort),
      DEMO_MODE: '1',
      DB_PATH: ':memory:',
      HOST: '127.0.0.1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  core.stdout?.on('data', (d: Buffer) => {
    coreOut += d.toString();
  });
  core.stderr?.on('data', (d: Buffer) => {
    coreOut += d.toString();
  });
  base = `http://127.0.0.1:${corePort}`;
  try {
    await waitForHealth();
    const code = ((await (await fetch(`${base}/v1/dev/pair-code`)).json()) as { code: string }).code;
    const pair = await fetch(`${base}/v1/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    expect(pair.status).toBe(200);
    token = ((await pair.json()) as { token: string }).token;
  } catch (err) {
    core.kill('SIGTERM');
    throw new Error(`core setup failed:\n${coreOut}\n${String(err)}`);
  }
}, 25_000);

afterAll(async () => {
  core?.kill('SIGTERM');
});

type Tokens = Record<string, string>;

interface ThemeProfile {
  id: string;
  name: string;
  source: string;
  light: Tokens;
  dark: Tokens;
}

describe('M6 e2e: theme gates + activation', () => {
  it('lists seeded presets including Midnight', async () => {
    const themes = ((await (await authed('/v1/themes')).json()) as {
      themes: ThemeProfile[];
    }).themes;
    expect(themes.some((t) => t.id === 'preset-default')).toBe(true);
    expect(themes.some((t) => t.id === 'preset-midnight')).toBe(true);
  });

  it('creates + activates a valid custom theme and serves it as active', async () => {
    const themes = ((await (await authed('/v1/themes')).json()) as { themes: ThemeProfile[] })
      .themes;
    const preset = themes.find((t) => t.id === 'preset-default') as ThemeProfile;

    const light = { ...preset.light, accent: '#1a6e4b', accentHover: '#145a3c' };
    const created = await authed('/v1/themes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'E2E Sage', light, dark: preset.dark }),
    });
    expect(created.status).toBe(201);
    const profile = (await created.json()) as ThemeProfile;
    expect(profile.source).toBe('custom');
    expect(profile.light.accent).toBe('#1a6e4b');

    const activated = await authed(`/v1/themes/${profile.id}/activate`, { method: 'POST' });
    expect(activated.status).toBe(200);

    const active = ((await (await authed('/v1/theme/active')).json()) as {
      themeId: string;
      light: Tokens;
    });
    expect(active.themeId).toBe(profile.id);
    expect(active.light.accent).toBe('#1a6e4b');
  });

  it('refuses a broken theme with a contrast report', async () => {
    const themes = ((await (await authed('/v1/themes')).json()) as { themes: ThemeProfile[] })
      .themes;
    const preset = themes.find((t) => t.id === 'preset-default') as ThemeProfile;

    // Muted text == surface background in both modes -> the gate must refuse.
    const broken = {
      ...preset.light,
      textMuted: preset.light.bg,
    };
    const res = await authed('/v1/themes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Broken', light: broken, dark: preset.dark }),
    });
    expect(res.status).toBe(400);
    const report = (await res.json()) as { report?: { ok: boolean; errors: unknown[] } };
    expect(report.report?.ok).toBe(false);
    expect((report.report?.errors ?? []).length).toBeGreaterThan(0);
  });
});
