/**
 * M11 F11 folder HTTP surface tests (PLAN-M11.md).
 *
 * /v1/folders CRUD with cycle-guarded moves; conversations created in /
 * moved between folders; folder delete reparents children and chats; auth
 * and error codes; audit rows carry ids/names only.
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

describe('folders routes', () => {
  it('401 without a token on the whole surface', async () => {
    const h = demoHarness();
    try {
      for (const [method, path] of [
        ['get', '/v1/folders'],
        ['post', '/v1/folders'],
        ['put', '/v1/folders/x'],
        ['delete', '/v1/folders/x'],
      ] as const) {
        const res = await request(h.app)[method](path).set('Host', ALLOWED_HOST);
        expect(res.status).toBe(401);
      }
      const move = await request(h.app)
        .put('/v1/conversations/x')
        .set('Host', ALLOWED_HOST)
        .send({ folderId: 'f' });
      expect(move.status).toBe(401);
    } finally {
      h.close();
    }
  });

  it('creates nested folders; moves are cycle-guarded; errors are typed', async () => {
    const h = demoHarness();
    try {
      const token = await pairToken(h);
      const root = await request(h.app)
        .post('/v1/folders')
        .set(authed(token))
        .send({ name: 'Work' });
      expect(root.status).toBe(201);
      expect(root.body.chatCount).toBe(0);
      const rootId = root.body.id as string;

      const child = await request(h.app)
        .post('/v1/folders')
        .set(authed(token))
        .send({ name: 'Alpha', parentId: rootId });
      expect(child.status).toBe(201);
      expect(child.body.parentId).toBe(rootId);

      const cycle = await request(h.app)
        .put(`/v1/folders/${rootId}`)
        .set(authed(token))
        .send({ parentId: child.body.id });
      expect(cycle.status).toBe(409);
      expect(cycle.body.error).toBe('cycle');

      const missing = await request(h.app)
        .post('/v1/folders')
        .set(authed(token))
        .send({ name: 'X', parentId: 'ghost' });
      expect(missing.status).toBe(404);

      const blank = await request(h.app)
        .post('/v1/folders')
        .set(authed(token))
        .send({ name: '  ' });
      expect(blank.status).toBe(400);

      const list = await request(h.app).get('/v1/folders').set(authed(token));
      expect(list.status).toBe(200);
      const names = (list.body.folders as Array<{ name: string }>).map((f) => f.name);
      expect(names).toContain('Work');
      expect(names).toContain('Alpha');
    } finally {
      h.close();
    }
  });

  it('conversations move between folders via PUT /v1/conversations/:id', async () => {
    const h = demoHarness();
    try {
      const token = await pairToken(h);
      const folder = await request(h.app)
        .post('/v1/folders')
        .set(authed(token))
        .send({ name: 'Project' });
      const folderId = folder.body.id as string;

      const created = await request(h.app)
        .post('/v1/conversations')
        .set(authed(token))
        .send({ title: 'c1', folderId });
      expect(created.status).toBe(201);
      expect(created.body.folderId).toBe(folderId);

      const badFolder = await request(h.app)
        .post('/v1/conversations')
        .set(authed(token))
        .send({ title: 'c2', folderId: 'ghost' });
      expect(badFolder.status).toBe(400);
      expect(badFolder.body.error).toBe('folder_not_found');

      // Move to Inbox (folderId null), then rename.
      const moved = await request(h.app)
        .put(`/v1/conversations/${created.body.id}`)
        .set(authed(token))
        .send({ folderId: null, title: 'renamed' });
      expect(moved.status).toBe(200);
      expect(moved.body.conversation.folderId).toBeNull();
      expect(moved.body.conversation.title).toBe('renamed');

      const list = await request(h.app).get('/v1/folders').set(authed(token));
      const f = (list.body.folders as Array<{ id: string; chatCount: number }>).find(
        (x) => x.id === folderId,
      );
      expect(f?.chatCount).toBe(0);
    } finally {
      h.close();
    }
  });

  it('delete reparents children and chats to the removed parent', async () => {
    const h = demoHarness();
    try {
      const token = await pairToken(h);
      const root = await request(h.app).post('/v1/folders').set(authed(token)).send({ name: 'R' });
      const child = await request(h.app)
        .post('/v1/folders')
        .set(authed(token))
        .send({ name: 'C', parentId: root.body.id });
      const chat = await request(h.app)
        .post('/v1/conversations')
        .set(authed(token))
        .send({ title: 'in-root', folderId: root.body.id });

      const del = await request(h.app).delete(`/v1/folders/${root.body.id}`).set(authed(token));
      expect(del.status).toBe(204);

      const folders = await request(h.app).get('/v1/folders').set(authed(token));
      const childRow = (folders.body.folders as Array<{ id: string; parentId: string | null }>).find(
        (f) => f.id === child.body.id,
      );
      expect(childRow?.parentId).toBeNull();

      const convs = await request(h.app).get('/v1/conversations').set(authed(token));
      const convRow = (convs.body.conversations as Array<{ id: string; folderId: string | null }>).find(
        (c) => c.id === chat.body.id,
      );
      expect(convRow?.folderId).toBeNull();

      const delMissing = await request(h.app).delete('/v1/folders/ghost').set(authed(token));
      expect(delMissing.status).toBe(404);

      const audit = h.audit.query({ limit: 20, action: 'folder' });
      expect(audit.some((r) => r.action === 'folder.create')).toBe(true);
      expect(audit.some((r) => r.action === 'folder.delete')).toBe(true);
    } finally {
      h.close();
    }
  });
});
