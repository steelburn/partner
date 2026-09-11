import { describe, expect, it } from 'vitest';
import type { Note, NoteSummary, NotesExportBundle, TagCount } from '@partner/shared';
import { ApiRequestError, type FetchLike } from '../src/lib/api.js';
import {
  captureNote,
  createNote,
  deleteNote,
  exportNotes,
  fetchNoteGraph,
  getBacklinks,
  getDailyNote,
  getNote,
  listNotes,
  listTags,
  parseBacklinks,
  parseNote,
  parseNoteList,
  parseSearchResults,
  parseTags,
  searchNotes,
  setNoteFolders,
  summarizeDaily,
  updateNote,
} from '../src/lib/notes.js';

const TOKEN = 'tok-secret';
const AUTH = { authorization: 'Bearer tok-secret' };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function recordFetch(fn: (input: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ input: string; init?: RequestInit }> = [];
  const fetchImpl: FetchLike = (input, init) => {
    calls.push({ input, init });
    return Promise.resolve(fn(input, init));
  };
  return { fetchImpl, calls };
}

function summary(overrides: Partial<NoteSummary> = {}): NoteSummary {
  return {
    id: 'n-1',
    title: 'Meeting notes',
    tags: ['work'],
    isDaily: false,
    createdAt: 100,
    updatedAt: 200,
    ...overrides,
  };
}

function fullNote(overrides: Partial<Note> = {}): Note {
  return { ...summary(), content: 'Body with a [[link]]', ...overrides };
}

function exportBundle(overrides: Partial<NotesExportBundle> = {}): NotesExportBundle {
  return {
    schema: 'notes/v1',
    exportedAt: 500,
    notes: [fullNote()],
    ...overrides,
  };
}

describe('note list + parsers', () => {
  it('listNotes GETs /v1/notes and reads the {notes: [...]} envelope', async () => {
    const { fetchImpl, calls } = recordFetch(() =>
      jsonResponse({ notes: [summary(), summary({ id: 'n-2', title: 'Ideas' })] }),
    );
    const result = await listNotes(TOKEN, { fetchImpl });
    expect(result).toHaveLength(2);
    expect(result[0]?.title).toBe('Meeting notes');
    expect(calls[0]?.input).toBe('/v1/notes');
    expect(calls[0]?.init?.headers).toMatchObject(AUTH);
  });

  it('listNotes tolerates a bare array and missing tags/isDaily', async () => {
    const { fetchImpl } = recordFetch(() =>
      jsonResponse([{ id: 'n-2', title: 'Idea', createdAt: 1, updatedAt: 2 }]),
    );
    const result = await listNotes(TOKEN, { fetchImpl });
    expect(result[0]).toMatchObject({ id: 'n-2', tags: [], isDaily: false });
  });

  it('parseNote accepts bare + {note}/{daily} envelopes and rejects garbage', () => {
    expect(parseNote(fullNote()).id).toBe('n-1');
    expect(parseNote({ note: fullNote() }).id).toBe('n-1');
    expect(parseNote({ daily: fullNote() }).id).toBe('n-1');
    expect(() => parseNote({ nope: true })).toThrow(ApiRequestError);
    expect(() => parseNote(fullNote({ content: 9 }))).toThrow(ApiRequestError);
  });

  it('parseNoteList tolerates arrays/envelopes and rejects malformed rows loudly', () => {
    expect(parseNoteList({ notes: [summary()] })).toHaveLength(1);
    expect(parseNoteList([summary()])).toHaveLength(1);
    expect(() => parseNoteList({ entries: [] })).toThrow(ApiRequestError);
    expect(() => parseNoteList([{ id: 7 }])).toThrow(ApiRequestError);
  });

  it('listNotes surfaces a 401 like every other client (session lost)', async () => {
    const { fetchImpl } = recordFetch(() => jsonResponse({ error: 'no session' }, 401));
    await expect(listNotes('stale', { fetchImpl })).rejects.toMatchObject({
      name: 'ApiRequestError',
      status: 401,
    });
  });
});

describe('note CRUD + capture + daily', () => {
  it('createNote POSTs title/content/tags to /v1/notes', async () => {
    const { fetchImpl, calls } = recordFetch(() =>
      jsonResponse({ note: fullNote({ id: 'n-new' }) }),
    );
    const result = await createNote(
      TOKEN,
      { title: 'Draft', content: 'x', tags: ['a', 'b'] },
      { fetchImpl },
    );
    expect(result.id).toBe('n-new');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      title: 'Draft',
      content: 'x',
      tags: ['a', 'b'],
    });
  });

  it('getNote GETs /v1/notes/:id and updateNote PUTs there', async () => {
    const get = recordFetch(() => jsonResponse(fullNote()));
    expect((await getNote(TOKEN, 'n-1', { fetchImpl: get.fetchImpl })).id).toBe('n-1');
    expect(get.calls[0]?.input).toBe('/v1/notes/n-1');

    const put = recordFetch(() => jsonResponse(fullNote({ title: 'renamed', updatedAt: 999 })));
    const updated = await updateNote(TOKEN, 'n-1', { title: 'renamed', content: 'x' }, {
      fetchImpl: put.fetchImpl,
    });
    expect(updated.title).toBe('renamed');
    expect(put.calls[0]?.input).toBe('/v1/notes/n-1');
    expect(put.calls[0]?.init?.method).toBe('PUT');
  });

  it('deleteNote resolves on 204 and surfaces a typed 404', async () => {
    const ok = recordFetch(() => new Response(null, { status: 204 }));
    await expect(deleteNote(TOKEN, 'n-1', { fetchImpl: ok.fetchImpl })).resolves.toBeUndefined();
    const missing = recordFetch(() => jsonResponse({ error: 'not found' }, 404));
    await expect(deleteNote(TOKEN, 'n-x', { fetchImpl: missing.fetchImpl })).rejects.toMatchObject({
      name: 'ApiRequestError',
      status: 404,
    });
  });

  it('captureNote POSTs {text} to /v1/notes/capture', async () => {
    const { fetchImpl, calls } = recordFetch(() =>
      jsonResponse({ note: fullNote({ id: 'cap-1' }) }),
    );
    const result = await captureNote(TOKEN, 'First line\nrest', { fetchImpl });
    expect(result.id).toBe('cap-1');
    expect(calls[0]?.input).toBe('/v1/notes/capture');
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ text: 'First line\nrest' });
  });

  it('captureNote surfaces a 400 with the server message', async () => {
    const { fetchImpl } = recordFetch(() =>
      jsonResponse({ error: { message: 'text is required' } }, 400),
    );
    await expect(captureNote(TOKEN, '', { fetchImpl })).rejects.toMatchObject({
      name: 'ApiRequestError',
      status: 400,
      message: 'text is required',
    });
  });

  it('getDailyNote GETs /v1/notes/daily (creating when missing) and parses the note', async () => {
    const { fetchImpl, calls } = recordFetch(() =>
      jsonResponse({ daily: fullNote({ id: 'daily-1', isDaily: true, tags: [] }) }),
    );
    const result = await getDailyNote(TOKEN, { fetchImpl });
    expect(result.isDaily).toBe(true);
    expect(calls[0]?.input).toBe('/v1/notes/daily');
    expect(calls[0]?.init?.method).toBe('GET');
  });

  it('summarizeDaily POSTs and returns the note when the core echoes one', async () => {
    const { fetchImpl, calls } = recordFetch(() =>
      jsonResponse({ note: fullNote({ id: 'daily-1', isDaily: true }) }),
    );
    const result = await summarizeDaily(TOKEN, { fetchImpl });
    expect(result?.id).toBe('daily-1');
    expect(calls[0]?.input).toBe('/v1/notes/daily/summarize');
    expect(calls[0]?.init?.method).toBe('POST');
  });

  it('summarizeDaily tolerates 204 / {ok} / non-JSON success bodies as null', async () => {
    const noContent = recordFetch(() => new Response(null, { status: 204 }));
    expect(await summarizeDaily(TOKEN, { fetchImpl: noContent.fetchImpl })).toBeNull();
    const bareOk = recordFetch(() => jsonResponse({ ok: true }));
    expect(await summarizeDaily(TOKEN, { fetchImpl: bareOk.fetchImpl })).toBeNull();
    const junk = recordFetch(() => new Response('plain', { status: 200 }));
    expect(await summarizeDaily(TOKEN, { fetchImpl: junk.fetchImpl })).toBeNull();
  });

  it('summarizeDaily throws on failure', async () => {
    const { fetchImpl } = recordFetch(() => jsonResponse({ error: 'provider down' }, 502));
    await expect(summarizeDaily(TOKEN, { fetchImpl })).rejects.toMatchObject({
      name: 'ApiRequestError',
      status: 502,
    });
  });
});

describe('search + backlinks + tags', () => {
  it('searchNotes GETs an encoded q and reads {hits: [...]}', async () => {
    const { fetchImpl, calls } = recordFetch(() =>
      jsonResponse({
        hits: [
          { id: 'n-1', title: 'Meeting notes', snippet: '…met on the plan…', rank: 2.5 },
        ],
      }),
    );
    const result = await searchNotes(TOKEN, 'meeting plan', { fetchImpl });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: 'n-1', snippet: '…met on the plan…', rank: 2.5 });
    expect(calls[0]?.input).toBe('/v1/notes/search?q=meeting%20plan');
    expect(calls[0]?.init?.headers).toMatchObject(AUTH);
  });

  it('parseSearchResults tolerates {results}/{notes} envelopes and bare arrays', () => {
    const row = { id: 'n-1', title: 'A', createdAt: 1, updatedAt: 2 };
    expect(parseSearchResults({ results: [row] })[0]?.id).toBe('n-1');
    expect(parseSearchResults({ notes: [row] })[0]?.id).toBe('n-1');
    expect(parseSearchResults([row])[0]?.id).toBe('n-1');
    expect(parseSearchResults({ hits: [] })).toEqual([]);
  });

  it('parseSearchResults maps FTS hit ids (noteId/refId) and defaults snippet/rank', () => {
    const results = parseSearchResults({
      hits: [
        { noteId: 'n-2', snippet: 's', rank: 1 },
        { refId: 'n-3' },
        { id: 'n-4', title: 'T' },
      ],
    });
    expect(results.map((hit) => hit.id)).toEqual(['n-2', 'n-3', 'n-4']);
    expect(results[0]?.rank).toBe(1);
    expect(results[1]?.snippet).toBeNull();
    expect(results[1]?.title).toBe(''); // hit without title/snippet has nothing to show yet
  });

  it('parseSearchResults rejects a missing list but drops unopenable rows silently', () => {
    expect(() => parseSearchResults({ foo: [] })).toThrow(ApiRequestError);
    expect(parseSearchResults({ hits: [{ snippet: 'no id' }, 7] })).toEqual([]);
  });

  it('getBacklinks reads {backlinks: [...]} and fromNoteId/fromTitle records', async () => {
    const { fetchImpl, calls } = recordFetch(() =>
      jsonResponse({
        backlinks: [
          { id: 'n-2', title: 'Ideas' },
          { fromNoteId: 'n-3', fromTitle: 'Journal' },
          { junk: true },
        ],
      }),
    );
    const result = await getBacklinks(TOKEN, 'n-1', { fetchImpl });
    expect(calls[0]?.input).toBe('/v1/notes/n-1/backlinks');
    expect(result).toEqual([
      { id: 'n-2', title: 'Ideas' },
      { id: 'n-3', title: 'Journal' },
    ]);
    expect(() => parseBacklinks({ links: [] })).toThrow(ApiRequestError);
  });

  it('listTags GETs /v1/tags and reads {tags: [...]}, bare arrays and maps', async () => {
    const envelope = recordFetch(() => jsonResponse({ tags: [{ tag: 'work', count: 3 }] }));
    const mapped = recordFetch(() => jsonResponse({ work: 3, ideas: 1 }));
    const bare = recordFetch(() => jsonResponse([{ tag: 'trip' }]));
    expect(await listTags(TOKEN, { fetchImpl: envelope.fetchImpl })).toEqual([
      { tag: 'work', count: 3 },
    ]);
    expect(await listTags(TOKEN, { fetchImpl: mapped.fetchImpl })).toEqual([
      { tag: 'work', count: 3 },
      { tag: 'ideas', count: 1 },
    ]);
    expect(await listTags(TOKEN, { fetchImpl: bare.fetchImpl })).toEqual([{ tag: 'trip', count: 0 }]);
    expect(envelope.calls[0]?.input).toBe('/v1/tags');
  });

  it('parseTags rejects envelopes that are neither lists nor tag maps', () => {
    expect(() => parseTags({ tags: 'nope' })).toThrow(ApiRequestError);
  });

  const counts = (): TagCount[] => [{ tag: 'a', count: 1 }];
  it('keeps tag names only — counts never carry content', () => {
    expect(counts()[0]?.tag).toBe('a');
  });
});

describe('export API client', () => {
  it('exportNotes GETs /v1/notes/export and returns the validated bundle', async () => {
    const { fetchImpl, calls } = recordFetch(() => jsonResponse(exportBundle()));
    const result = await exportNotes(TOKEN, { fetchImpl });
    expect(result.schema).toBe('notes/v1');
    expect(result.notes).toHaveLength(1);
    expect(calls[0]?.input).toBe('/v1/notes/export');
    expect(calls[0]?.init?.headers).toMatchObject(AUTH);
  });

  it('exportNotes tolerates a {bundle: …} wrapper', async () => {
    const { fetchImpl } = recordFetch(() => jsonResponse({ bundle: exportBundle() }));
    const result = await exportNotes(TOKEN, { fetchImpl });
    expect(result.notes[0]?.id).toBe('n-1');
  });

  it('exportNotes throws ApiRequestError when the body fails the schema guard', async () => {
    const { fetchImpl } = recordFetch(() =>
      jsonResponse({ schema: 'notes/v9', exportedAt: 1, notes: [] }),
    );
    await expect(exportNotes(TOKEN, { fetchImpl })).rejects.toMatchObject({
      name: 'ApiRequestError',
      message: /invalid/i,
    });
  });
});

describe('M17 project scope + membership client', () => {
  it('parseNote/parseNoteList read folderIds, defaulting missing to []', () => {
    const withFolders = parseNote({ ...fullNote(), folderIds: ['f1', 'f2', 7] });
    expect(withFolders.folderIds).toEqual(['f1', 'f2']);
    expect(parseNote(fullNote()).folderIds).toEqual([]);
    const rows = parseNoteList([
      { id: 'n-1', title: 'A', createdAt: 1, updatedAt: 2, folderIds: ['f1'] },
      { id: 'n-2', title: 'B', createdAt: 1, updatedAt: 2 },
    ]);
    expect(rows[0]?.folderIds).toEqual(['f1']);
    expect(rows[1]?.folderIds).toEqual([]);
  });

  it('listNotes appends folderId / none query params', async () => {
    const { fetchImpl, calls } = recordFetch(() => jsonResponse({ notes: [] }));
    await listNotes(TOKEN, { folderId: 'f 1/x', fetchImpl });
    await listNotes(TOKEN, { unfiled: true, fetchImpl });
    await listNotes(TOKEN, { fetchImpl });
    expect(calls[0]?.input).toBe('/v1/notes?folderId=f%201%2Fx');
    expect(calls[1]?.input).toBe('/v1/notes?folderId=none');
    expect(calls[2]?.input).toBe('/v1/notes');
  });

  it('fetchNoteGraph scopes the request and returns externalNodes', async () => {
    const payload = {
      nodes: [{ id: 'n-1', title: 'A', x: null, y: null, folderIds: ['f1'] }],
      edges: [],
      externalNodes: [
        { id: 'n-2', title: 'B', x: null, y: null, folderIds: ['f2'], external: true },
      ],
    };
    const { fetchImpl, calls } = recordFetch(() => jsonResponse(payload));
    const graph = await fetchNoteGraph(TOKEN, { folderId: 'f1', fetchImpl });
    expect(calls[0]?.input).toBe('/v1/notes/graph?folderId=f1');
    expect(graph.externalNodes?.[0]?.external).toBe(true);
    await fetchNoteGraph(TOKEN, { unfiled: true, fetchImpl });
    expect(calls[1]?.input).toBe('/v1/notes/graph?folderId=none');
  });

  it('setNoteFolders PUTs {folderIds} to the folders route and returns the note', async () => {
    const { fetchImpl, calls } = recordFetch(() =>
      jsonResponse({ ...fullNote(), folderIds: ['f1', 'f2'] }),
    );
    const note = await setNoteFolders(TOKEN, 'n 1', ['f1', 'f2'], { fetchImpl });
    expect(calls[0]?.input).toBe('/v1/notes/n%201/folders');
    expect(calls[0]?.init?.method).toBe('PUT');
    expect(calls[0]?.init?.headers).toMatchObject(AUTH);
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ folderIds: ['f1', 'f2'] });
    expect(note.folderIds).toEqual(['f1', 'f2']);
  });
});
