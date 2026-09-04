/**
 * M7 browser scope + policy HTTP route tests (PLAN-M7.md): every
 * /v1/browser route is authed (401) and 501 not_configured when the scope
 * manager is not wired; happy-path list/put/delete/policy with origin
 * normalization, the default-'ask' resolution, and hard-blocked origin
 * immutability (404 on mutation).
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

const SCOPES_ROUTES: Array<[string, string]> = [
  ['get', '/v1/browser/scopes'],
  ['put', '/v1/browser/scopes/news.example'],
  ['delete', '/v1/browser/scopes/news.example'],
  ['get', '/v1/browser/policy/news.example'],
];

describe('M7 browser scope routes — auth + wiring gates', () => {
  it('returns 401 without a token on every scope route', async () => {
    const h = demoHarness();
    try {
      for (const [method, path] of SCOPES_ROUTES) {
        const res = await request(h.app)[method as 'get' | 'put' | 'delete'](path)
          .set('Host', ALLOWED_HOST)
          .send({ scope: 'read+act' });
        expect(res.status, `${method} ${path}`).toBe(401);
      }
    } finally {
      h.close();
    }
  });

  it('501s not_configured when the scope manager is not wired', async () => {
    const h = demoHarness({ browser: false });
    try {
      const token = await pairToken(h);
      for (const [method, path] of SCOPES_ROUTES) {
        const res = await request(h.app)[method as 'get' | 'put' | 'delete'](path)
          .set(authed(token))
          .send({ scope: 'read+act' });
        expect(res.status, `${method} ${path}`).toBe(501);
        expect(res.body.error).toBe('not_configured');
      }
    } finally {
      h.close();
    }
  });
});

describe('browser scope CRUD + policy routes', () => {
  it('PUT stores a normalized origin and GET lists it; policy resolves stored scope', async () => {
    const h = demoHarness();
    try {
      const token = await pairToken(h);

      const empty = await request(h.app).get('/v1/browser/scopes').set(authed(token));
      expect(empty.status).toBe(200);
      expect(empty.body.scopes).toEqual([]);

      const put = await request(h.app)
        .put('/v1/browser/scopes/Example.COM')
        .set(authed(token))
        .send({ scope: 'read+act' });
      expect(put.status).toBe(200);
      expect(put.body).toMatchObject({ origin: 'example.com', scope: 'read+act' });

      const list = await request(h.app).get('/v1/browser/scopes').set(authed(token));
      expect(list.body.scopes).toHaveLength(1);
      expect(list.body.scopes[0]).toMatchObject({ origin: 'example.com', scope: 'read+act' });

      const policy = await request(h.app).get('/v1/browser/policy/example.com').set(authed(token));
      expect(policy.status).toBe(200);
      expect(policy.body).toEqual({
        origin: 'example.com',
        scope: 'read+act',
        blocked: false,
        reason: null,
      });
      // The manager is shared: the route wrote through the same store.
      expect(h.scopes?.policy('https://example.com/a/b')).toMatchObject({ scope: 'read+act' });
    } finally {
      h.close();
    }
  });

  it('DELETE returns an origin to the default ask; unknown deletes are 204', async () => {
    const h = demoHarness();
    try {
      const token = await pairToken(h);
      await request(h.app)
        .put('/v1/browser/scopes/news.example')
        .set(authed(token))
        .send({ scope: 'read' });

      const del = await request(h.app)
        .delete('/v1/browser/scopes/News.Example')
        .set(authed(token));
      expect(del.status).toBe(204);

      const policy = await request(h.app).get('/v1/browser/policy/news.example').set(authed(token));
      expect(policy.body).toEqual({
        origin: 'news.example',
        scope: 'ask',
        blocked: false,
        reason: null,
      });

      const idempotent = await request(h.app).delete('/v1/browser/scopes/never.example').set(authed(token));
      expect(idempotent.status).toBe(204);
    } finally {
      h.close();
    }
  });

  it('rejects bad scope values and unparseable origins with 400 invalid_input', async () => {
    const h = demoHarness();
    try {
      const token = await pairToken(h);
      const badScope = await request(h.app)
        .put('/v1/browser/scopes/news.example')
        .set(authed(token))
        .send({ scope: 'super' });
      expect(badScope.status).toBe(400);
      expect(badScope.body.error).toBe('invalid_input');

      const emptyOrigin = await request(h.app).put('/v1/browser/scopes/%20').set(authed(token)).send({ scope: 'read' });
      expect(emptyOrigin.status).toBe(400);

      const badPolicy = await request(h.app).get('/v1/browser/policy/%3A%3A').set(authed(token));
      expect(badPolicy.status).toBe(400);
      expect(badPolicy.body.error).toBe('invalid_input');
    } finally {
      h.close();
    }
  });

  it('hard-blocked origins are immutable: policy reports blocked, mutations 404', async () => {
    const h = demoHarness();
    try {
      const token = await pairToken(h);
      const policy = await request(h.app)
        .get('/v1/browser/policy/www.wellsfargo.com')
        .set(authed(token));
      expect(policy.status).toBe(200);
      expect(policy.body).toEqual({
        origin: 'www.wellsfargo.com',
        scope: 'off',
        blocked: true,
        reason: 'blocked_origin',
      });

      const put = await request(h.app)
        .put('/v1/browser/scopes/www.wellsfargo.com')
        .set(authed(token))
        .send({ scope: 'trusted' });
      expect(put.status).toBe(404);
      expect(put.body.error).toBe('not_found');

      const del = await request(h.app).delete('/v1/browser/scopes/www.wellsfargo.com').set(authed(token));
      expect(del.status).toBe(404);

      // Nothing was stored and the policy is unchanged.
      const after = await request(h.app).get('/v1/browser/policy/www.wellsfargo.com').set(authed(token));
      expect(after.body.blocked).toBe(true);
      expect((await request(h.app).get('/v1/browser/scopes').set(authed(token))).body.scopes).toEqual([]);
    } finally {
      h.close();
    }
  });
});
