/**
 * M16 pure-logic unit tests (PLAN-M16.md): graph layout determinism,
 * native-save bridge routing, and the asset discuss quote builder. No DOM —
 * these run under the node environment like the rest of the web suite.
 */
import { describe, expect, it } from 'vitest';
import { layOutGraph } from '../src/lib/graph-layout.js';
import { isPartnerShell, saveTextFileNative } from '../src/lib/download.js';
import { buildAssetDiscussQuote, DISCUSS_QUOTE_CHARS } from '../src/lib/asset-quote.js';
import type { Asset } from '@partner/shared';
import { ApiRequestError } from '../src/lib/api.js';
import { browseDirectories, parseBrowseResult } from '../src/lib/tools.js';
import {
  concludeBrainstorm,
  fetchBrainstormSession,
  fetchBrainstormSessions,
  reopenBrainstorm,
} from '../src/lib/notes.js';
import {
  appendWikiLink,
  hasWikiLink,
  isLinkedAlready,
  isLinkableTitle,
} from '../src/lib/note-relate.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('M16 F7 filesystem browse client', () => {
  it('normalizes a browse response (directories only, parent optional)', () => {
    const parsed = parseBrowseResult({
      path: '/home/me',
      parent: '/home',
      entries: [
        { name: 'docs', isDir: true },
        { name: 'code', isDir: true },
      ],
      truncated: false,
    });
    expect(parsed.path).toBe('/home/me');
    expect(parsed.entries.map((entry) => entry.name)).toEqual(['docs', 'code']);
  });

  it('accepts a null parent (filesystem top) and rejects malformed shapes', () => {
    const top = parseBrowseResult({ path: '/', parent: null, entries: [], truncated: false });
    expect(top.parent).toBeNull();
    expect(() => parseBrowseResult({ path: '/', entries: 'nope' })).toThrow(ApiRequestError);
  });

  it('calls GET /v1/files/browse with the encoded path', async () => {
    let url = '';
    const fetchImpl = async (input: string): Promise<Response> => {
      url = input;
      return {
        status: 200,
        ok: true,
        json: async () => ({ path: '/tmp/x', parent: '/tmp', entries: [], truncated: false }),
        text: async () => '',
      } as unknown as Response;
    };
    const result = await browseDirectories('tok', '/tmp/x y', { fetchImpl });
    expect(url).toBe('/v1/files/browse?path=%2Ftmp%2Fx%20y');
    expect(result.path).toBe('/tmp/x');
  });
});

describe('M16 F1 graph layout', () => {
  it('ranks referencers before their targets (left to right flow)', () => {
    const nodes = [
      { id: 'a', title: 'Alpha', x: null, y: null },
      { id: 'b', title: 'Beta', x: null, y: null },
      { id: 'c', title: 'Gamma', x: null, y: null },
    ];
    const edges = [
      { source: 'a', target: 'b' },
      { source: 'b', target: 'c' },
    ];
    const layout = layOutGraph(nodes, edges);
    const pos = new Map(layout.map((entry) => [entry.id, entry]));
    expect(pos.get('a')!.x).toBeLessThan(pos.get('b')!.x);
    expect(pos.get('b')!.x).toBeLessThan(pos.get('c')!.x);
  });

  it('is deterministic for identical input and folds mutual links', () => {
    const nodes = [
      { id: 'a', title: 'A', x: null, y: null },
      { id: 'b', title: 'B', x: null, y: null },
    ];
    const edges = [
      { source: 'a', target: 'b' },
      { source: 'b', target: 'a' }, // mutual — cycle folds instead of diverging
    ];
    const first = layOutGraph(nodes, edges);
    const second = layOutGraph(nodes, edges);
    expect(first).toEqual(second);
  });

  it('honours stored user positions and only arranges the rest', () => {
    const nodes = [
      { id: 'fixed', title: 'Fixed', x: 500, y: -200 },
      { id: 'loose', title: 'Loose', x: null, y: null },
    ];
    const layout = layOutGraph(nodes, []);
    const fixed = layout.find((entry) => entry.id === 'fixed');
    const loose = layout.find((entry) => entry.id === 'loose');
    expect(fixed).toMatchObject({ x: 500, y: -200 });
    expect(loose!.x).not.toBeNaN();
  });
});

describe('M16 F5 native save bridge', () => {
  it('detects the Tauri shell bridge only when invoke exists', () => {
    expect(isPartnerShell({})).toBe(false);
    expect(isPartnerShell({ __TAURI__: { core: {} } })).toBe(false);
    expect(isPartnerShell({ __TAURI__: { core: { invoke: () => Promise.resolve({}) } } })).toBe(true);
    expect(isPartnerShell(null)).toBe(false);
  });

  it('routes content through the native save command', async () => {
    let called: { defaultName: string; content: string } | null = null;
    const invoke = async (command: string, args: unknown): Promise<{ saved: boolean }> => {
      expect(command).toBe('save_text_file');
      called = args as { defaultName: string; content: string };
      return { saved: true };
    };
    const saved = await saveTextFileNative('ideas.md', '# hi', { invoke });
    expect(saved).toBe(true);
    expect(called).toEqual({ defaultName: 'ideas.md', content: '# hi' });
  });

  it('reports cancellation (no path) as not saved', async () => {
    const invoke = async (): Promise<{ saved: boolean }> => ({ saved: false });
    await expect(saveTextFileNative('x.md', 'y', { invoke })).resolves.toBe(false);
  });

  it('refuses oversized payloads (kept out of the native dialog)', async () => {
    const invoke = async (): Promise<{ saved: boolean }> => ({ saved: true });
    const huge = 'x'.repeat(50 * 1024 * 1024 + 1);
    await expect(saveTextFileNative('x.md', huge, { invoke })).rejects.toThrow(/browser path/);
  });
});

describe('M16 follow-up brainstorm session clients', () => {
  it('lists sessions (optionally for one note) with the bearer token', async () => {
    const calls: Array<{ url: string; auth: string | undefined }> = [];
    const fetchImpl = async (input: string, init?: RequestInit): Promise<Response> => {
      calls.push({ url: input, auth: (init?.headers as Record<string, string> | undefined)?.authorization });
      return jsonResponse({ sessions: [] });
    };
    await fetchBrainstormSessions('tok', undefined, { fetchImpl });
    await fetchBrainstormSessions('tok', 'note 1/x', { fetchImpl });
    expect(calls[0]!.url).toBe('/v1/notes/brainstorm');
    expect(calls[1]!.url).toBe('/v1/notes/brainstorm?noteId=note%201%2Fx');
    expect(calls[0]!.auth).toBe('Bearer tok');
  });

  it('fetches one conversation\'s session and tolerates null', async () => {
    const calls: string[] = [];
    const fetchImpl = async (input: string): Promise<Response> => {
      calls.push(input);
      return input.includes('nope')
        ? jsonResponse({ session: null })
        : jsonResponse({ session: { conversationId: 'c1', concluded: true } });
    };
    const found = await fetchBrainstormSession('tok', 'c1', { fetchImpl });
    const missing = await fetchBrainstormSession('tok', 'nope', { fetchImpl });
    expect(calls).toEqual([
      '/v1/notes/brainstorm?conversationId=c1',
      '/v1/notes/brainstorm?conversationId=nope',
    ]);
    expect(found).toMatchObject({ conversationId: 'c1', concluded: true });
    expect(missing).toBeNull();
  });

  it('concludes and reopens with POST and unwraps the session', async () => {
    const calls: Array<{ url: string; method: string | undefined }> = [];
    const fetchImpl = async (input: string, init?: RequestInit): Promise<Response> => {
      calls.push({ url: input, method: init?.method });
      return jsonResponse({ session: { conversationId: 'c1', concluded: true } });
    };
    const concluded = await concludeBrainstorm('tok', 'c1', { fetchImpl });
    const reopened = await reopenBrainstorm('tok', 'c1', { fetchImpl });
    expect(calls[0]).toEqual({ url: '/v1/notes/brainstorm/c1/conclude', method: 'POST' });
    expect(calls[1]).toEqual({ url: '/v1/notes/brainstorm/c1/reopen', method: 'POST' });
    expect(concluded.conversationId).toBe('c1');
    expect(reopened.conversationId).toBe('c1');
  });
});

describe('M16 F4 asset discuss quote', () => {
  function asset(over: Partial<Asset>): Asset {
    return {
      id: 'a1',
      conversationId: 'c1',
      messageId: null,
      kind: 'table',
      title: 'Costs',
      tags: [],
      createdAt: 1,
      body: 'a,b\n1,2',
      ...over,
    };
  }

  it('prepends provenance and keeps the full body when small', () => {
    const quote = buildAssetDiscussQuote(asset({}));
    expect(quote).toContain('Discussing asset “Costs” (table)');
    expect(quote).toContain('a,b\n1,2');
  });

  it('truncates oversized bodies with an ellipsis', () => {
    const quote = buildAssetDiscussQuote(asset({ body: 'z'.repeat(DISCUSS_QUOTE_CHARS + 500) }));
    expect(quote.length).toBeLessThan(DISCUSS_QUOTE_CHARS + 400);
    expect(quote.endsWith('…')).toBe(true);
  });
});

describe('M16 F1 graph connectors (wiki-link writes)', () => {
  it('appends the link as its own trailing paragraph', () => {
    expect(appendWikiLink('Body text', 'Beta')).toBe('Body text\n\n[[Beta]]');
  });

  it('links an empty body and trims the title', () => {
    expect(appendWikiLink('   ', '  Beta  ')).toBe('[[Beta]]');
  });

  it('detects an existing link case-insensitively', () => {
    expect(hasWikiLink('see [[beta]] here', 'Beta')).toBe(true);
    expect(hasWikiLink('see [[Gamma]] here', 'Beta')).toBe(false);
    expect(hasWikiLink('[[Beta prime]]', 'Beta')).toBe(false);
  });

  it('refuses titles the wiki-link grammar cannot resolve', () => {
    expect(isLinkableTitle('Beta')).toBe(true);
    expect(isLinkableTitle('  ')).toBe(false);
    expect(isLinkableTitle('Broken] title')).toBe(false);
  });

  it('treats the same arrow or a bidirectional edge as already linked', () => {
    const edges = [{ source: 'a', target: 'b', bidirectional: false }];
    expect(isLinkedAlready(edges, 'a', 'b')).toBe(true);
    expect(isLinkedAlready(edges, 'b', 'a')).toBe(false); // reverse arrow = a real edit
    expect(isLinkedAlready([{ source: 'a', target: 'b', bidirectional: true }], 'b', 'a')).toBe(true);
    expect(isLinkedAlready([], 'a', 'b')).toBe(false);
  });
});

describe('M17 scoped graph layout (ghost nodes)', () => {
  it('lays out external (null-position) nodes deterministically alongside in-scope nodes', () => {
    const nodes = [
      { id: 'a', title: 'Alpha', x: null, y: null },
      { id: 'b', title: 'Ghost', x: null, y: null },
    ];
    const edges = [{ source: 'a', target: 'b' }];
    const first = layOutGraph(nodes, edges);
    const second = layOutGraph(nodes, edges);
    expect(first).toEqual(second);
    const pos = new Map(first.map((entry) => [entry.id, entry]));
    // The ghost sits one rank right of its in-scope source.
    expect(pos.get('a')!.x).toBeLessThan(pos.get('b')!.x);
    expect(Number.isFinite(pos.get('b')!.y)).toBe(true);
  });
});
