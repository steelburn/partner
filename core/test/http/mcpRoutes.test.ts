/**
 * M11 F2 MCP HTTP surface tests (PLAN-M11.md — slice 2). The spawn-level
 * behaviour is covered by the manager tests against a real stdio server;
 * here: auth gate, CRUD shape, and the disabled-server refusal that stops
 * any call before a process is ever spawned.
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

describe('M11 F2 MCP routes', () => {
  it('401 without a token on the surface', async () => {
    const h = demoHarness();
    try {
      const res = await request(h.app).get('/v1/mcp/servers').set('Host', ALLOWED_HOST);
      expect(res.status).toBe(401);
    } finally {
      h.close();
    }
  });

  it('CRUD round-trip; created servers are OFF; calls on disabled are 409', async () => {
    const h = demoHarness();
    try {
      const token = await pairToken(h);
      const created = await request(h.app)
        .post('/v1/mcp/servers')
        .set(authed(token))
        .send({ name: 'local fs', command: 'node', args: ['server.cjs'] });
      expect(created.status).toBe(201);
      expect(created.body.enabled).toBe(false);
      const id = created.body.id as string;

      const list = await request(h.app).get('/v1/mcp/servers').set(authed(token));
      expect(list.status).toBe(200);
      expect((list.body.servers as unknown[]).length).toBe(1);

      const deniedCall = await request(h.app)
        .post(`/v1/mcp/servers/${id}/call`)
        .set(authed(token))
        .send({ tool: 'echo' });
      expect(deniedCall.status).toBe(409);
      expect(deniedCall.body.error).toBe('disabled');

      const enabled = await request(h.app)
        .put(`/v1/mcp/servers/${id}`)
        .set(authed(token))
        .send({ enabled: true });
      expect(enabled.status).toBe(200);
      expect(enabled.body.enabled).toBe(true);

      const missing = await request(h.app)
        .put(`/v1/mcp/servers/${id}`)
        .set(authed(token))
        .send({});
      expect(missing.status).toBe(200);

      const del = await request(h.app)
        .delete(`/v1/mcp/servers/${id}`)
        .set(authed(token));
      expect(del.status).toBe(204);

      const gone = await request(h.app)
        .get(`/v1/mcp/servers/${id}/tools`)
        .set(authed(token));
      expect(gone.status).toBe(404);
    } finally {
      h.close();
    }
  });
});
