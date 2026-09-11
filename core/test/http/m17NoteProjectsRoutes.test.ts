/**
 * M17 HTTP surface tests (PLAN-M17): project-scoped note lists + graph and
 * the note-folder membership route. Every route authed; unknown folders are
 * 400 folder_not_found, unknown notes 404; scope requests 501 when the
 * folder manager is unwired. Audit carries ids/counts only.
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

async function makeFolder(h: Harness, token: string, name: string): Promise<string> {
  const res = await request(h.app)
    .post('/v1/folders')
    .set(authed(token))
    .send({ name });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

async function makeNote(
  h: Harness,
  token: string,
  body: Record<string, unknown>,
): Promise<string> {
  const res = await request(h.app).post('/v1/notes').set(authed(token)).send(body);
  expect(res.status).toBe(201);
  return res.body.id as string;
}

describe('M17 note projects routes', () => {
  it('401s without a token for the new routes', async () => {
    const h = demoHarness();
    try {
      const cases: Array<[string, string]> = [
        ['get', '/v1/notes?folderId=f1'],
        ['get', '/v1/notes?folderId=none'],
        ['get', '/v1/notes/graph?folderId=f1'],
        ['put', '/v1/notes/n-1/folders'],
      ];
      for (const [method, path] of cases) {
        const res = await request(h.app)[method as 'get' | 'put'](path)
          .set('Host', ALLOWED_HOST)
          .send({ folderIds: [] });
        expect(res.status, `${method} ${path}`).toBe(401);
      }
    } finally {
      h.close();
    }
  });

  it('scopes the note list to a project subtree and to Inbox', async () => {
    const h = demoHarness();
    try {
      const token = await pairToken(h);
      const work = await makeFolder(h, token, 'Work');
      const sub = await request(h.app)
        .post('/v1/folders')
        .set(authed(token))
        .send({ name: 'Sub', parentId: work });
      expect(sub.status).toBe(201);
      const subId = sub.body.id as string;

      const inWork = await makeNote(h, token, { title: 'W', folderIds: [work] });
      const inSub = await makeNote(h, token, { title: 'S', folderIds: [subId] });
      const unfiled = await makeNote(h, token, { title: 'U' });

      const scoped = await request(h.app)
        .get(`/v1/notes?folderId=${work}`)
        .set(authed(token));
      expect(scoped.status).toBe(200);
      expect(scoped.body.notes.map((n: { id: string }) => n.id).sort()).toEqual(
        [inWork, inSub].sort(),
      );
      expect(
        scoped.body.notes.find((n: { id: string }) => n.id === inWork)?.folderIds,
      ).toEqual([work]);

      const inbox = await request(h.app).get('/v1/notes?folderId=none').set(authed(token));
      expect(inbox.status).toBe(200);
      expect(inbox.body.notes.map((n: { id: string }) => n.id)).toEqual([unfiled]);

      const all = await request(h.app).get('/v1/notes').set(authed(token));
      expect(all.body.notes).toHaveLength(3);

      const unknown = await request(h.app)
        .get('/v1/notes?folderId=ghost')
        .set(authed(token));
      expect(unknown.status).toBe(400);
      expect(unknown.body.error).toBe('folder_not_found');
    } finally {
      h.close();
    }
  });

  it('scopes the graph and returns external ghost nodes + boundary edges', async () => {
    const h = demoHarness();
    try {
      const token = await pairToken(h);
      const a = await makeFolder(h, token, 'A');
      const b = await makeFolder(h, token, 'B');
      const nA = await makeNote(h, token, { title: 'Alpha', folderIds: [a] });
      const nB = await makeNote(h, token, { title: 'Beta', folderIds: [b] });
      await request(h.app)
        .put(`/v1/notes/${nA}`)
        .set(authed(token))
        .send({ content: 'see [[Beta]]' });
      await request(h.app)
        .put(`/v1/notes/${nB}`)
        .set(authed(token))
        .send({ content: 'see [[Alpha]]' });

      const scoped = await request(h.app)
        .get(`/v1/notes/graph?folderId=${a}`)
        .set(authed(token));
      expect(scoped.status).toBe(200);
      expect(scoped.body.nodes.map((n: { id: string }) => n.id)).toEqual([nA]);
      expect(scoped.body.externalNodes.map((n: { id: string }) => n.id)).toEqual([nB]);
      expect(scoped.body.externalNodes[0].external).toBe(true);
      const boundary = scoped.body.edges.filter(
        (e: { source: string; target: string }) =>
          (e.source === nA && e.target === nB) || (e.source === nB && e.target === nA),
      );
      expect(boundary).toHaveLength(1);
      expect(boundary[0].bidirectional).toBe(true);

      // Unscoped keeps the M16 shape: no externalNodes.
      const all = await request(h.app).get('/v1/notes/graph').set(authed(token));
      expect(all.status).toBe(200);
      expect(all.body.externalNodes).toBeUndefined();
      expect(all.body.nodes).toHaveLength(2);
    } finally {
      h.close();
    }
  });

  it('PUT /v1/notes/:id/folders replaces membership; 400/404 on bad input', async () => {
    const h = demoHarness();
    try {
      const token = await pairToken(h);
      const a = await makeFolder(h, token, 'A');
      const b = await makeFolder(h, token, 'B');
      const note = await makeNote(h, token, { title: 'N' });

      const assigned = await request(h.app)
        .put(`/v1/notes/${note}/folders`)
        .set(authed(token))
        .send({ folderIds: [a, b] });
      expect(assigned.status).toBe(200);
      expect(assigned.body.folderIds).toEqual([a, b]);

      const cleared = await request(h.app)
        .put(`/v1/notes/${note}/folders`)
        .set(authed(token))
        .send({ folderIds: [] });
      expect(cleared.status).toBe(200);
      expect(cleared.body.folderIds).toEqual([]);

      const unknownFolder = await request(h.app)
        .put(`/v1/notes/${note}/folders`)
        .set(authed(token))
        .send({ folderIds: ['ghost'] });
      expect(unknownFolder.status).toBe(400);
      expect(unknownFolder.body.error).toBe('folder_not_found');

      const unknownNote = await request(h.app)
        .put('/v1/notes/ghost/folders')
        .set(authed(token))
        .send({ folderIds: [a] });
      expect(unknownNote.status).toBe(404);

      const badBody = await request(h.app)
        .put(`/v1/notes/${note}/folders`)
        .set(authed(token))
        .send({ folderIds: 'nope' });
      expect(badBody.status).toBe(400);
      expect(badBody.body.error).toBe('invalid_input');

      // Membership writes are audited with ids/counts only.
      const rows = h.audit.query({ limit: 20, action: 'note.folders' });
      expect(rows.length).toBeGreaterThan(0);
      const details = JSON.parse(rows[0]?.details ?? '{}') as Record<string, unknown>;
      expect(details).toHaveProperty('count');
      expect(JSON.stringify(details)).not.toContain('N');
    } finally {
      h.close();
    }
  });

  it('501s project scope when the folder manager is unwired', async () => {
    const h = demoHarness({ personas: false });
    try {
      const token = await pairToken(h);
      const list = await request(h.app).get('/v1/notes?folderId=x').set(authed(token));
      expect(list.status).toBe(501);
      expect(list.body.error).toBe('not_configured');

      const graph = await request(h.app).get('/v1/notes/graph?folderId=x').set(authed(token));
      expect(graph.status).toBe(501);

      const folders = await request(h.app)
        .put('/v1/notes/n-1/folders')
        .set(authed(token))
        .send({ folderIds: [] });
      expect(folders.status).toBe(501);
    } finally {
      h.close();
    }
  });
});
