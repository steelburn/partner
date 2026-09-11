/**
 * M17 e2e over a spawned demo core (PLAN-M17 exit): projects shared with
 * chats, many-to-many note membership, project-scoped lists + graph, and
 * cross-project ghosts with boundary edges.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const root = `${here}..`;
const corePort = 43_000 + (process.pid % 10_000);

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

async function json<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await authed(path, init);
  expect(res.status, `${init.method ?? 'GET'} ${path}`).toBeLessThan(400);
  return (await res.json()) as T;
}

function post(path: string, body: unknown): Promise<Response> {
  return authed(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
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

interface NoteJson {
  id: string;
  title: string;
  folderIds: string[];
}
interface FolderJson {
  id: string;
  name: string;
  noteCount: number;
}

describe('M17 e2e: note projects, scoped graph, ghosts', () => {
  it('assigns notes to multiple projects and scopes lists', async () => {
    const a = (await (await post('/v1/folders', { name: 'Project A' })).json()) as FolderJson;
    const b = (await (await post('/v1/folders', { name: 'Project B' })).json()) as FolderJson;

    const nA = (await (await post('/v1/notes', { title: 'Alpha', folderIds: [a.id] })).json()) as NoteJson;
    const nB = (await (await post('/v1/notes', { title: 'Beta', folderIds: [b.id] })).json()) as NoteJson;
    const shared = (await (
      await post('/v1/notes', { title: 'Shared', folderIds: [a.id, b.id] })
    ).json()) as NoteJson;
    const unfiled = (await (await post('/v1/notes', { title: 'Loose' })).json()) as NoteJson;

    expect(shared.folderIds.sort()).toEqual([a.id, b.id].sort());

    const scopedA = await json<{ notes: NoteJson[] }>(`/v1/notes?folderId=${a.id}`);
    expect(scopedA.notes.map((n) => n.id).sort()).toEqual([nA.id, shared.id].sort());

    const inbox = await json<{ notes: NoteJson[] }>('/v1/notes?folderId=none');
    expect(inbox.notes.map((n) => n.id)).toEqual([unfiled.id]);

    // Move `unfiled` into B via the dedicated membership route.
    const moved = await json<NoteJson>(`/v1/notes/${unfiled.id}/folders`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ folderIds: [b.id] }),
    });
    expect(moved.folderIds).toEqual([b.id]);

    const folders = await json<{ folders: FolderJson[] }>('/v1/folders');
    const folderA = folders.folders.find((f) => f.id === a.id);
    const folderB = folders.folders.find((f) => f.id === b.id);
    expect(folderA?.noteCount).toBe(2); // nA + shared
    expect(folderB?.noteCount).toBe(3); // nB + shared + moved

    // Track ids for the next case.
    storedA = a.id;
    storedB = b.id;
    storedAlpha = nA.id;
    storedBeta = nB.id;
  });

  it('returns cross-project ghosts in both scopes with boundary edges', async () => {
    // Alpha (A) links out to Beta (B); Beta (B) links back into Alpha.
    await json(`/v1/notes/${storedAlpha}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'see [[Beta]]' }),
    });
    await json(`/v1/notes/${storedBeta}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'see [[Alpha]]' }),
    });

    interface GraphJson {
      nodes: Array<{ id: string }>;
      edges: Array<{ source: string; target: string; bidirectional: boolean }>;
      externalNodes?: Array<{ id: string; external?: boolean; folderIds: string[] }>;
    }

    const graphA = await json<GraphJson>(`/v1/notes/graph?folderId=${storedA}`);
    expect(graphA.nodes.map((n) => n.id)).toContain(storedAlpha);
    expect(graphA.externalNodes?.map((n) => n.id)).toContain(storedBeta);
    expect(graphA.externalNodes?.every((n) => n.external === true)).toBe(true);

    const graphB = await json<GraphJson>(`/v1/notes/graph?folderId=${storedB}`);
    expect(graphB.externalNodes?.map((n) => n.id)).toContain(storedAlpha);

    const boundary = graphA.edges.filter(
      (edge) =>
        (edge.source === storedAlpha && edge.target === storedBeta) ||
        (edge.source === storedBeta && edge.target === storedAlpha),
    );
    expect(boundary).toHaveLength(1);
    expect(boundary[0]?.bidirectional).toBe(true);

    // Unscoped stays backward compatible.
    const all = await json<GraphJson>('/v1/notes/graph');
    expect(all.externalNodes).toBeUndefined();
  });

  it('deleting a project clears membership but keeps the notes', async () => {
    const before = await json<{ notes: NoteJson[] }>('/v1/notes');
    const idsBefore = before.notes.map((n) => n.id).sort();

    const del = await authed(`/v1/folders/${storedB}`, { method: 'DELETE' });
    expect(del.status).toBe(204);

    const after = await json<{ notes: NoteJson[] }>('/v1/notes');
    expect(after.notes.map((n) => n.id).sort()).toEqual(idsBefore);
    // Beta was only in B -> now unfiled.
    expect(after.notes.find((n) => n.id === storedBeta)?.folderIds).toEqual([]);
    expect(after.notes.find((n) => n.id === storedAlpha)?.folderIds).toEqual([storedA]);
  });
});

let storedA = '';
let storedB = '';
let storedAlpha = '';
let storedBeta = '';
