import { describe, expect, it } from 'vitest';
import type {
  EpisodeSummary,
  MemoryExportBundle,
  MemorySearchHit,
  ProfileEntry,
} from '@partner/shared';
import { ApiRequestError, type FetchLike } from '../src/lib/api.js';
import {
  addProfileEntry,
  exportMemory,
  forgetMemory,
  getMemorySettings,
  importMemory,
  listEpisodes,
  listProfile,
  parseEpisode,
  parseEpisodeList,
  parseImportResult,
  parseMemorySettings,
  parseProfileEntry,
  parseProfileList,
  parseSearchHits,
  removeEpisode,
  removeProfileEntry,
  searchMemory,
  summarizeEpisode,
  updateMemorySettings,
  updateProfileEntry,
  type MemoryImportResult,
} from '../src/lib/memory.js';

const TOKEN = 'tok-secret';

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

function entry(overrides: Partial<ProfileEntry> = {}): ProfileEntry {
  return {
    id: 'pe-1',
    kind: 'preference',
    key: null,
    value: 'I prefer concise replies.',
    evidence: null,
    source: 'user',
    status: 'confirmed',
    personaScope: null,
    createdAt: 100,
    updatedAt: 200,
    ...overrides,
  };
}

function episode(overrides: Partial<EpisodeSummary> = {}): EpisodeSummary {
  return {
    id: 'ep-1',
    conversationId: 'c-1',
    personaId: 'p-1',
    title: 'Drafting the brief',
    summary: 'We drafted a release brief and agreed on the tone.',
    model: 'gpt-4o-mini',
    createdAt: 300,
    updatedAt: 400,
    ...overrides,
  };
}

function bundle(overrides: Partial<MemoryExportBundle> = {}): MemoryExportBundle {
  return {
    schema: 'memory/v1',
    exportedAt: 500,
    profile: [entry()],
    episodes: [episode()],
    ...overrides,
  };
}

const AUTH = { authorization: 'Bearer tok-secret' };

describe('profile API client', () => {
  it('listProfile GETs /v1/memory/profile and reads the {profile: [...]} envelope', async () => {
    const { fetchImpl, calls } = recordFetch(() =>
      jsonResponse({ profile: [entry(), entry({ id: 'pe-2', value: 'Plain English.' })] }),
    );
    const result = await listProfile(TOKEN, { fetchImpl });
    expect(result).toHaveLength(2);
    expect(calls[0]?.input).toBe('/v1/memory/profile');
    expect(calls[0]?.init?.method).toBe('GET');
    expect(calls[0]?.init?.headers).toMatchObject(AUTH);
  });

  it('listProfile tolerates a bare array', async () => {
    const { fetchImpl } = recordFetch(() => jsonResponse([entry({ id: 'pe-2' })]));
    const result = await listProfile(TOKEN, { fetchImpl });
    expect(result.map((row) => row.id)).toEqual(['pe-2']);
  });

  it('addProfileEntry POSTs the input and parses a bare entry', async () => {
    const { fetchImpl, calls } = recordFetch(() =>
      jsonResponse(entry({ id: 'pe-new', status: 'confirmed' })),
    );
    const result = await addProfileEntry(
      TOKEN,
      { kind: 'identity', value: 'Maya', source: 'user', status: 'confirmed' },
      { fetchImpl },
    );
    expect(result.id).toBe('pe-new');
    expect(calls[0]?.input).toBe('/v1/memory/profile');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(calls[0]?.init?.headers).toMatchObject({ 'content-type': 'application/json' });
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      kind: 'identity',
      value: 'Maya',
      source: 'user',
      status: 'confirmed',
    });
  });

  it('addProfileEntry surfaces a 400 (invalid kind) with the server message', async () => {
    const { fetchImpl } = recordFetch(() =>
      jsonResponse({ error: { message: 'kind must be preference|identity|rule|style' } }, 400),
    );
    await expect(
      addProfileEntry(TOKEN, { kind: 'preference', value: 'x' }, { fetchImpl }),
    ).rejects.toMatchObject({
      name: 'ApiRequestError',
      status: 400,
      message: /kind must be/,
    });
  });

  it('updateProfileEntry PUTs to /v1/memory/profile/:id', async () => {
    const { fetchImpl, calls } = recordFetch(() =>
      jsonResponse(entry({ id: 'pe-1', value: 'edited', updatedAt: 999 })),
    );
    const result = await updateProfileEntry(
      TOKEN,
      'pe-1',
      { kind: 'preference', value: 'edited', status: 'confirmed', source: 'user' },
      { fetchImpl },
    );
    expect(result.value).toBe('edited');
    expect(calls[0]?.input).toBe('/v1/memory/profile/pe-1');
    expect(calls[0]?.init?.method).toBe('PUT');
  });

  it('removeProfileEntry resolves on 204 and rejects on 404', async () => {
    const ok = recordFetch(() => new Response(null, { status: 204 }));
    await expect(removeProfileEntry(TOKEN, 'pe-1', { fetchImpl: ok.fetchImpl })).resolves.toBeUndefined();
    const missing = recordFetch(() => jsonResponse({ error: 'not found' }, 404));
    await expect(removeProfileEntry(TOKEN, 'pe-x', { fetchImpl: missing.fetchImpl })).rejects.toMatchObject({
      name: 'ApiRequestError',
      status: 404,
    });
  });

  it('parseProfileEntry accepts bare + {entry}/{profile} envelopes, rejects garbage', () => {
    expect(parseProfileEntry(entry()).id).toBe('pe-1');
    expect(parseProfileEntry({ entry: entry() }).id).toBe('pe-1');
    expect(parseProfileEntry({ profile: entry() }).id).toBe('pe-1');
    expect(() => parseProfileEntry({ nope: true })).toThrow(ApiRequestError);
    expect(() => parseProfileEntry(entry({ kind: 'bogus' }))).toThrow(ApiRequestError);
    expect(() => parseProfileEntry(entry({ status: 'bogus' }))).toThrow(ApiRequestError);
  });

  it('parseProfileList accepts envelopes/arrays and rejects wrong shapes', () => {
    expect(parseProfileList({ profile: [entry()] })).toHaveLength(1);
    expect(parseProfileList([entry()])).toHaveLength(1);
    expect(() => parseProfileList({ entries: [] })).toThrow(ApiRequestError);
    expect(() => parseProfileList([{ id: 7 }])).toThrow(ApiRequestError);
  });
});

describe('episodes API client', () => {
  it('listEpisodes GETs /v1/memory/episodes and reads the envelope', async () => {
    const { fetchImpl, calls } = recordFetch(() => jsonResponse({ episodes: [episode()] }));
    const result = await listEpisodes(TOKEN, { fetchImpl });
    expect(result[0]?.conversationId).toBe('c-1');
    expect(calls[0]?.input).toBe('/v1/memory/episodes');
    expect(calls[0]?.init?.headers).toMatchObject(AUTH);
  });

  it('summarizeEpisode POSTs /v1/memory/episodes/:conversationId', async () => {
    const { fetchImpl, calls } = recordFetch(() =>
      jsonResponse(episode({ id: 'ep-new', model: 'gpt-4o' })),
    );
    const result = await summarizeEpisode(TOKEN, 'c-42', { fetchImpl });
    expect(result.id).toBe('ep-new');
    expect(calls[0]?.input).toBe('/v1/memory/episodes/c-42');
    expect(calls[0]?.init?.method).toBe('POST');
  });

  it('removeEpisode deletes by episode id (not conversation id)', async () => {
    const { fetchImpl, calls } = recordFetch(() => new Response(null, { status: 204 }));
    await expect(removeEpisode(TOKEN, 'ep-1', { fetchImpl })).resolves.toBeUndefined();
    expect(calls[0]?.input).toBe('/v1/memory/episodes/ep-1');
    expect(calls[0]?.init?.method).toBe('DELETE');
  });

  it('parseEpisode/parseEpisodeList tolerate bare + enveloped and reject garbage', () => {
    expect(parseEpisode(episode()).id).toBe('ep-1');
    expect(parseEpisode({ episode: episode() }).id).toBe('ep-1');
    expect(parseEpisodeList({ episodes: [episode()] })).toHaveLength(1);
    expect(parseEpisodeList([episode()])).toHaveLength(1);
    expect(() => parseEpisode(episode({ summary: 3 }))).toThrow(ApiRequestError);
    expect(() => parseEpisodeList({ nope: [] })).toThrow(ApiRequestError);
  });
});

describe('search API client', () => {
  it('searchMemory GETs with an encoded q and reads {hits: [...]}', async () => {
    const { fetchImpl, calls } = recordFetch(() =>
      jsonResponse({
        hits: [
          { kind: 'profile', refId: 'pe-1', snippet: '…prefers concise…', rank: 1.2 },
          { kind: 'episode', refId: 'ep-1', snippet: '…concise brief…', rank: 3.1 },
        ],
      }),
    );
    const result = await searchMemory(TOKEN, 'concise replies', { fetchImpl });
    expect(result).toHaveLength(2);
    expect(calls[0]?.input).toBe('/v1/memory/search?q=concise%20replies');
    expect(calls[0]?.init?.headers).toMatchObject(AUTH);
  });

  it('searchMemory accepts a bare array and normalizes a missing rank', async () => {
    const { fetchImpl } = recordFetch(() =>
      jsonResponse([{ kind: 'episode', refId: 'ep-2', snippet: 'x' }]),
    );
    const result = await searchMemory(TOKEN, 'x', { fetchImpl });
    expect(result[0]?.rank).toBe(0);
  });

  it('parseSearchHits rejects malformed hits and foreign kinds', () => {
    const hit: MemorySearchHit = { kind: 'profile', refId: 'pe-1', snippet: 's', rank: 1 };
    expect(parseSearchHits([hit])).toHaveLength(1);
    expect(parseSearchHits({ hits: [hit] })).toHaveLength(1);
    expect(() => parseSearchHits([{ kind: 'note', refId: 'n', snippet: 's' }])).toThrow(
      ApiRequestError,
    );
    expect(() => parseSearchHits([{ kind: 'profile', snippet: 'no ref' }])).toThrow(
      ApiRequestError,
    );
    expect(() => parseSearchHits({ results: [] })).toThrow(ApiRequestError);
  });
});

describe('forget API client', () => {
  it('forgetMemory POSTs {what} to /v1/memory/forget', async () => {
    const { fetchImpl, calls } = recordFetch(() => new Response(null, { status: 204 }));
    await forgetMemory(TOKEN, { what: 'all' }, { fetchImpl });
    expect(calls[0]?.input).toBe('/v1/memory/forget');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ what: 'all' });
  });

  it('forgetMemory includes before/id in the body', async () => {
    const { fetchImpl, calls } = recordFetch(() => jsonResponse({ ok: true }));
    await forgetMemory(TOKEN, { what: 'entry', id: 'pe-1' }, { fetchImpl });
    await forgetMemory(TOKEN, { what: 'all', before: '2024-01-01T00:00:00.000Z' }, { fetchImpl });
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ what: 'entry', id: 'pe-1' });
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({
      what: 'all',
      before: '2024-01-01T00:00:00.000Z',
    });
  });

  it('forgetMemory surfaces a 400 (empty before range)', async () => {
    const { fetchImpl } = recordFetch(() => jsonResponse({ error: 'nothing to forget' }, 400));
    await expect(forgetMemory(TOKEN, { what: 'all' }, { fetchImpl })).rejects.toMatchObject({
      name: 'ApiRequestError',
      status: 400,
    });
  });
});

describe('export API client', () => {
  it('exportMemory GETs /v1/memory/export and returns the validated bundle', async () => {
    const { fetchImpl, calls } = recordFetch(() => jsonResponse(bundle()));
    const result = await exportMemory(TOKEN, { fetchImpl });
    expect(result.schema).toBe('memory/v1');
    expect(result.profile).toHaveLength(1);
    expect(result.episodes).toHaveLength(1);
    expect(calls[0]?.input).toBe('/v1/memory/export');
    expect(calls[0]?.init?.headers).toMatchObject(AUTH);
  });

  it('exportMemory tolerates a {bundle: …} wrapper', async () => {
    const { fetchImpl } = recordFetch(() => jsonResponse({ bundle: bundle() }));
    const result = await exportMemory(TOKEN, { fetchImpl });
    expect(result.profile[0]?.id).toBe('pe-1');
  });

  it('exportMemory throws ApiRequestError when the body fails the schema guard', async () => {
    const { fetchImpl } = recordFetch(() =>
      jsonResponse({ schema: 'memory/v2', profile: [], episodes: [] }),
    );
    await expect(exportMemory(TOKEN, { fetchImpl })).rejects.toMatchObject({
      name: 'ApiRequestError',
      message: /invalid/i,
    });
  });
});

describe('import API client', () => {
  it('importMemory POSTs {bundle} and reads flat counts', async () => {
    const { fetchImpl, calls } = recordFetch(() =>
      jsonResponse({ profileImported: 1, episodesImported: 1 }),
    );
    const result = await importMemory(TOKEN, bundle(), { fetchImpl });
    expect(result).toEqual({ profileImported: 1, episodesImported: 1 });
    expect(calls[0]?.input).toBe('/v1/memory/import');
    expect(calls[0]?.init?.method).toBe('POST');
    const body = JSON.parse(String(calls[0]?.init?.body)) as { bundle: MemoryExportBundle };
    expect(body.bundle.schema).toBe('memory/v1');
  });

  it('importMemory reads nested {imported: {profile, episodes}} counts', async () => {
    const { fetchImpl } = recordFetch(() =>
      jsonResponse({ imported: { profile: 2, episodes: 3 } }),
    );
    const result = await importMemory(TOKEN, bundle(), { fetchImpl });
    expect(result).toEqual({ profileImported: 2, episodesImported: 3 });
  });

  it('importMemory returns null counts on 204 / empty / garbage bodies', async () => {
    const noContent = recordFetch(() => new Response(null, { status: 204 }));
    const empty: MemoryImportResult = { profileImported: null, episodesImported: null };
    expect(await importMemory(TOKEN, bundle(), { fetchImpl: noContent.fetchImpl })).toEqual(empty);
    const garbage = recordFetch(() => jsonResponse('nope'));
    expect(await importMemory(TOKEN, bundle(), { fetchImpl: garbage.fetchImpl })).toEqual(empty);
  });

  it('importMemory refuses an invalid bundle BEFORE fetching (400)', async () => {
    const bad = { schema: 'memory/v2', profile: [], episodes: [] };
    let fetched = false;
    const fetchImpl: FetchLike = () => {
      fetched = true;
      return Promise.resolve(new Response(null, { status: 204 }));
    };
    await expect(importMemory(TOKEN, bad, { fetchImpl })).rejects.toMatchObject({
      name: 'ApiRequestError',
      status: 400,
    });
    expect(fetched).toBe(false);
  });

  it('importMemory surfaces a server 400 with the readable message', async () => {
    const { fetchImpl } = recordFetch(() =>
      jsonResponse({ error: { message: 'bundle too large' } }, 400),
    );
    await expect(importMemory(TOKEN, bundle(), { fetchImpl })).rejects.toMatchObject({
      name: 'ApiRequestError',
      status: 400,
      message: 'bundle too large',
    });
  });

  it('parseImportResult handles every count shape defensively', () => {
    expect(parseImportResult({ profileImported: 4, episodesImported: 5 })).toEqual({
      profileImported: 4,
      episodesImported: 5,
    });
    expect(parseImportResult({ imported: { profile: 1, episodes: 2 } })).toEqual({
      profileImported: 1,
      episodesImported: 2,
    });
    expect(parseImportResult({ ok: true })).toEqual({
      profileImported: null,
      episodesImported: null,
    });
    expect(parseImportResult(null)).toEqual({ profileImported: null, episodesImported: null });
  });
});

describe('auth / envelope robustness', () => {
  it('a dead session surfaces 401 like every other client', async () => {
    const { fetchImpl } = recordFetch(() => jsonResponse({ error: 'no session' }, 401));
    await expect(listEpisodes('stale', { fetchImpl })).rejects.toMatchObject({
      name: 'ApiRequestError',
      status: 401,
    });
  });
});

describe('memory settings (M19 follow-up)', () => {
  it('parses the settings response and rejects unexpected shapes', () => {
    expect(parseMemorySettings({ autoRememberGlobal: true })).toEqual({
      autoRememberGlobal: true,
    });
    expect(() => parseMemorySettings({ autoRememberGlobal: 'on' })).toThrow(ApiRequestError);
    expect(() => parseMemorySettings(null)).toThrow(ApiRequestError);
  });

  it('GETs the setting with a bearer token and no body', async () => {
    const { fetchImpl, calls } = recordFetch(() => jsonResponse({ autoRememberGlobal: false }));
    await expect(getMemorySettings(TOKEN, { fetchImpl })).resolves.toEqual({
      autoRememberGlobal: false,
    });
    expect(calls[0]?.input).toBe('/v1/memory/settings');
    expect(calls[0]?.init?.method).toBe('GET');
    expect(new Headers(calls[0]?.init?.headers).get('authorization')).toBe(`Bearer ${TOKEN}`);
  });

  it('PUTs the boolean and returns the stored value', async () => {
    const { fetchImpl, calls } = recordFetch((_input, init) => {
      const body = JSON.parse(String(init?.body)) as { autoRememberGlobal?: unknown };
      expect(body).toEqual({ autoRememberGlobal: true });
      return jsonResponse({ autoRememberGlobal: true });
    });
    await expect(
      updateMemorySettings(TOKEN, { autoRememberGlobal: true }, { fetchImpl }),
    ).resolves.toEqual({ autoRememberGlobal: true });
    expect(calls[0]?.init?.method).toBe('PUT');
  });
});
