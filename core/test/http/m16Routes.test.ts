/**
 * M16 routes (PLAN-M16.md) over the demo harness: notes graph + positions,
 * version history + restore, brainstorm (persona seed-on-demand), asset
 * Discuss (continue/fork with conversation lineage) and lineage passthrough
 * on conversation create.
 */
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { demoHarness, ALLOWED_HOST } from '../helpers.js';
import type { Harness } from '../helpers.js';
import { BRAINSTORM_PERSONA_ID } from '../../src/notes/index.js';

async function pairToken(h: Harness): Promise<string> {
  const code = await h.pairing.issue();
  const pairRes = await request(h.app).post('/v1/pair').set('Host', ALLOWED_HOST).send({ code });
  expect(pairRes.status).toBe(200);
  return pairRes.body.token as string;
}

function authed(token: string): Record<string, string> {
  return { Host: ALLOWED_HOST, Authorization: `Bearer ${token}` };
}

describe('M16 notes graph + versions routes', () => {
  it('GET /v1/notes/graph returns nodes + directed edges; positions persist', async () => {
    const h = demoHarness();
    try {
      const token = await pairToken(h);
      const beta = await request(h.app).post('/v1/notes').set(authed(token)).send({ title: 'Beta', content: '' });
      const alpha = await request(h.app).post('/v1/notes').set(authed(token)).send({ title: 'Alpha', content: 'see [[Beta]]' });
      const betaId = beta.body.id as string;
      const alphaId = alpha.body.id as string;

      const graph = await request(h.app).get('/v1/notes/graph').set(authed(token));
      expect(graph.status).toBe(200);
      expect(graph.body.nodes.map((n: { id: string }) => n.id)).toEqual(expect.arrayContaining([alphaId, betaId]));
      const edge = graph.body.edges.find(
        (e: { source: string; target: string }) => e.source === alphaId && e.target === betaId,
      );
      expect(edge).toMatchObject({ bidirectional: false });

      const put = await request(h.app)
        .put('/v1/notes/graph/positions')
        .set(authed(token))
        .send({ positions: [{ noteId: alphaId, x: 42, y: -7 }] });
      expect(put.status).toBe(204);

      const after = await request(h.app).get('/v1/notes/graph').set(authed(token));
      const node = after.body.nodes.find((n: { id: string }) => n.id === alphaId);
      expect(node).toMatchObject({ x: 42, y: -7 });
    } finally {
      h.close();
    }
  });

  it('note versions list/get + undoable restore', async () => {
    const h = demoHarness();
    try {
      const token = await pairToken(h);
      const created = await request(h.app).post('/v1/notes').set(authed(token)).send({ title: 'Orig', content: 'v1 body' });
      const id = created.body.id as string;
      await request(h.app).put(`/v1/notes/${id}`).set(authed(token)).send({ content: 'v2 body' });

      const versionsRes = await request(h.app).get(`/v1/notes/${id}/versions`).set(authed(token));
      expect(versionsRes.status).toBe(200);
      expect(versionsRes.body.versions).toHaveLength(2);
      const versions = versionsRes.body.versions as Array<{ id: string; seq: number; titleChanged: boolean }>;
      const newest = versions.find((entry) => entry.seq === 2)!;
      const oldest = versions.find((entry) => entry.seq === 1)!;
      expect(newest.seq).toBe(2);
      expect(oldest.seq).toBe(1);

      const detail = await request(h.app)
        .get(`/v1/notes/${id}/versions/${oldest.id}`)
        .set(authed(token));
      expect(detail.body.version).toMatchObject({ seq: 1, content: 'v1 body' });

      const restore = await request(h.app)
        .post(`/v1/notes/${id}/restore`)
        .set(authed(token))
        .send({ versionId: oldest.id });
      expect(restore.status).toBe(200);
      expect(restore.body.note.content).toBe('v1 body');

      const after = await request(h.app).get(`/v1/notes/${id}/versions`).set(authed(token));
      expect(after.body.versions[0].writer).toBe('restore');
    } finally {
      h.close();
    }
  });

  it('guards: restore validates versionId; graph positions validate payload', async () => {
    const h = demoHarness();
    try {
      const token = await pairToken(h);
      const created = await request(h.app).post('/v1/notes').set(authed(token)).send({ title: 'A', content: 'x' });
      const id = created.body.id as string;

      const badRestore = await request(h.app).post(`/v1/notes/${id}/restore`).set(authed(token)).send({});
      expect(badRestore.status).toBe(400);
      const badVersion = await request(h.app)
        .get(`/v1/notes/${id}/versions/nope`)
        .set(authed(token));
      expect(badVersion.status).toBe(404);
      const badPos = await request(h.app)
        .put('/v1/notes/graph/positions')
        .set(authed(token))
        .send({ positions: [] });
      expect(badPos.status).toBe(400);
    } finally {
      h.close();
    }
  });
});

describe('M16 brainstorm route', () => {
  it('POST /v1/notes/brainstorm creates a persona-bound conversation', async () => {
    const h = demoHarness();
    try {
      const token = await pairToken(h);
      const n1 = await request(h.app).post('/v1/notes').set(authed(token)).send({ title: 'Fruit', content: 'apples' });
      const n2 = await request(h.app).post('/v1/notes').set(authed(token)).send({ title: 'Trees', content: 'oaks' });
      const persona = h.personas!.get(BRAINSTORM_PERSONA_ID)!;
      h.personas!.remove(persona.id);

      const res = await request(h.app)
        .post('/v1/notes/brainstorm')
        .set(authed(token))
        .send({ noteIds: [n1.body.id as string, n2.body.id as string] });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ personaId: BRAINSTORM_PERSONA_ID, used: 2, truncated: 0 });

      const detail = h.conversations!.get(res.body.conversationId as string);
      expect(detail.messages[0]!.content).toContain('### Fruit');
      expect(detail.messages).toHaveLength(2);
      // Persona re-created on demand, exactly once.
      expect(h.personas!.list().filter((p) => p.id === BRAINSTORM_PERSONA_ID)).toHaveLength(1);
    } finally {
      h.close();
    }
  });

  it('POST /v1/notes/brainstorm guards: empty ids -> 400, unknown note -> 404', async () => {
    const h = demoHarness();
    try {
      const token = await pairToken(h);
      const empty = await request(h.app).post('/v1/notes/brainstorm').set(authed(token)).send({ noteIds: [] });
      expect(empty.status).toBe(400);
      const unknown = await request(h.app)
        .post('/v1/notes/brainstorm')
        .set(authed(token))
        .send({ noteIds: ['nope'] });
      expect(unknown.status).toBe(404);
    } finally {
      h.close();
    }
  });
});

describe('M16 asset Discuss + conversation lineage', () => {
  async function seedAsset(h: Harness, token: string): Promise<{ conversationId: string; assetId: string }> {
    const conv = await request(h.app).post('/v1/conversations').set(authed(token)).send({});
    const conversationId = conv.body.id as string;
    const saved = await request(h.app)
      .post(`/v1/conversations/${conversationId}/assets`)
      .set(authed(token))
      .send([{ kind: 'table', title: 'Costs', body: 'a,b\n1,2' }]);
    const assetId = (saved.body.assets as Array<{ id: string }>)[0]!.id;
    return { conversationId, assetId };
  }

  it('discuss continue returns the origin conversation; fork creates a lineage child', async () => {
    const h = demoHarness();
    try {
      const token = await pairToken(h);
      const { conversationId, assetId } = await seedAsset(h, token);

      const cont = await request(h.app)
        .post(`/v1/conversations/${conversationId}/assets/${assetId}/discuss`)
        .set(authed(token))
        .send({ mode: 'continue' });
      expect(cont.status).toBe(200);
      expect(cont.body).toMatchObject({ conversationId, mode: 'continue', assetId, originConversationId: conversationId });

      const fork = await request(h.app)
        .post(`/v1/conversations/${conversationId}/assets/${assetId}/discuss`)
        .set(authed(token))
        .send({ mode: 'fork' });
      expect(fork.status).toBe(201);
      expect(fork.body.mode).toBe('fork');
      expect(fork.body.conversationId).not.toBe(conversationId);

      const child = h.conversations!.get(fork.body.conversationId as string).summary;
      expect(child.parentId).toBe(conversationId);
      expect(child.sourceAssetId).toBe(assetId);
      expect(child.title).toContain('Discuss — Costs');
    } finally {
      h.close();
    }
  });

  it('discuss validates the asset; conversation create passes lineage through', async () => {
    const h = demoHarness();
    try {
      const token = await pairToken(h);
      const { conversationId } = await seedAsset(h, token);

      const missing = await request(h.app)
        .post(`/v1/conversations/${conversationId}/assets/nope/discuss`)
        .set(authed(token))
        .send({ mode: 'fork' });
      expect(missing.status).toBe(404);

      const created = await request(h.app)
        .post('/v1/conversations')
        .set(authed(token))
        .send({ parentId: conversationId, sourceAssetId: 'asset-x' });
      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({ parentId: conversationId, sourceAssetId: 'asset-x' });

      const badParent = await request(h.app)
        .post('/v1/conversations')
        .set(authed(token))
        .send({ parentId: 'nope' });
      expect(badParent.status).toBe(400);
    } finally {
      h.close();
    }
  });
});
