/**
 * M11 F2 search HTTP surface tests (PLAN-M11.md). Manager-level behaviour is
 * covered against fake upstreams; here: auth, default-deny config shape,
 * validation, key lifecycle, and the disabled-query refusal (no network).
 */
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { demoHarness, ALLOWED_HOST } from '../helpers.js';
import type { Harness } from '../helpers.js';

async function pairToken(h: Harness): Promise<string> {
  const code = await h.pairing.issue();
  const pairRes = await request(h.app).post('/v1/pair').set('Host', ALLOWED_HOST).send({ code });
  expect(pairRes.status).toBe(200);
  return pairRes.body.token as string;
}

function authed(token: string): Record<string, string> {
  return { Host: ALLOWED_HOST, Authorization: `Bearer ${token}` };
}

describe('M11 F2 search routes', () => {
  it('401 without a token; default config is OFF and keyless', async () => {
    const h = demoHarness();
    try {
      const unauth = await request(h.app).get('/v1/search/config').set('Host', ALLOWED_HOST);
      expect(unauth.status).toBe(401);

      const token = await pairToken(h);
      const cfg = await request(h.app).get('/v1/search/config').set(authed(token));
      expect(cfg.status).toBe(200);
      expect(cfg.body.enabled).toBe(false);
      expect(cfg.body.hasKey).toBe(false);
    } finally {
      h.close();
    }
  });

  it('validates config, stores the key, and refuses queries while disabled', async () => {
    const h = demoHarness();
    try {
      const token = await pairToken(h);
      const bad = await request(h.app)
        .put('/v1/search/config')
        .set(authed(token))
        .send({ provider: 'yandex' });
      expect(bad.status).toBe(400);

      const blocked = await request(h.app)
        .post('/v1/search/query')
        .set(authed(token))
        .send({ query: 'hello' });
      expect(blocked.status).toBe(409);
      expect(blocked.body.error).toBe('disabled');

      const key = await request(h.app)
        .put('/v1/search/key')
        .set(authed(token))
        .send({ key: 'sk-route-key-0000000000' });
      expect(key.status).toBe(204);

      const cfg = await request(h.app).get('/v1/search/config').set(authed(token));
      expect(cfg.body.hasKey).toBe(true);
      // Still disabled -> the query stays refused (no network ever fires).
      const stillBlocked = await request(h.app)
        .post('/v1/search/query')
        .set(authed(token))
        .send({ query: 'hello' });
      expect(stillBlocked.status).toBe(409);

      const removed = await request(h.app).delete('/v1/search/key').set(authed(token));
      expect(removed.status).toBe(204);
      const after = await request(h.app).get('/v1/search/config').set(authed(token));
      expect(after.body.hasKey).toBe(false);
    } finally {
      h.close();
    }
  });

  it('keeps a Tavily and a Brave key side by side and removes them independently', async () => {
    const h = demoHarness();
    try {
      const token = await pairToken(h);
      const tavily = await request(h.app)
        .put('/v1/search/key')
        .set(authed(token))
        .send({ key: 'sk-tavily-0000000000', provider: 'tavily' });
      expect(tavily.status).toBe(204);
      const brave = await request(h.app)
        .put('/v1/search/key')
        .set(authed(token))
        .send({ key: 'sk-brave-0000000000', provider: 'brave' });
      expect(brave.status).toBe(204);

      // Both keys survive; the active provider's hasKey stays true.
      const cfg = await request(h.app).get('/v1/search/config').set(authed(token));
      expect(cfg.body.keys).toEqual({ tavily: true, brave: true });
      expect(cfg.body.hasKey).toBe(true);

      const badProvider = await request(h.app)
        .put('/v1/search/key')
        .set(authed(token))
        .send({ key: 'sk-x', provider: 'yandex' });
      expect(badProvider.status).toBe(400);

      const removed = await request(h.app)
        .delete('/v1/search/key?provider=brave')
        .set(authed(token));
      expect(removed.status).toBe(204);
      const after = await request(h.app).get('/v1/search/config').set(authed(token));
      expect(after.body.keys).toEqual({ tavily: true, brave: false });
    } finally {
      h.close();
    }
  });
});
