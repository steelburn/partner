/**
 * M11 F2 search chat-tool adapter tests (PLAN-M11.md).
 *
 * searchToolExternal wraps the manager for the chat tool pass: default-deny
 * via allow() on the backend enabled flag; exec maps hits into the generic
 * tool-result shape and maps failures to coded denials.
 */
import { describe, expect, it } from 'vitest';
import { searchToolExternal } from '../../src/search/tool.js';
import type { SearchManager } from '../../src/search/manager.js';

function stubManager(over: Partial<SearchManager>): SearchManager {
  return {
    config: () => ({ enabled: true, provider: 'tavily', endpoint: null }),
    hasKey: async () => true,
    updateConfig: () => ({ enabled: true, provider: 'tavily', endpoint: null }),
    setKey: async () => undefined,
    removeKey: async () => undefined,
    search: async () => ({
      query: 'q',
      hits: [{ title: 'Hit A', url: 'https://a.example', snippet: 'a snippet' }],
      provider: 'tavily',
      ms: 12,
    }),
    ...over,
  };
}

describe('M11 F2 search chat tool', () => {
  it('is absent when no search manager is wired', () => {
    expect(searchToolExternal(undefined)).toBeUndefined();
  });

  it('allow() gates on the backend enabled flag (default deny)', () => {
    const on = searchToolExternal(stubManager({}));
    const off = searchToolExternal(stubManager({ config: () => ({ enabled: false, provider: 'tavily', endpoint: null }) }));
    expect(on?.allow('search')).toBe(true);
    expect(on?.allow('files.read')).toBe(false);
    expect(off?.allow('search')).toBe(false);
  });

  it('exec maps hits into the generic result shape', async () => {
    const external = searchToolExternal(stubManager({}));
    const response = await external?.exec('search', { query: 'pizza' });
    expect(response).toMatchObject({ outcome: 'executed' });
    if (response?.outcome === 'executed') {
      expect(String(response.result.query)).toBe('pizza');
      expect(String(response.result.result_1)).toContain('Hit A');
      expect(String(response.result.result_1)).toContain('https://a.example');
    }
  });

  it('exec denies a missing query and codes backend failures', async () => {
    const external = searchToolExternal(stubManager({}));
    const noQuery = await external?.exec('search', {});
    expect(noQuery).toMatchObject({ outcome: 'denied', reason: 'missing_query' });

    const failing = searchToolExternal(
      stubManager({
        search: async () => {
          throw Object.assign(new Error('nope'), { code: 'disabled' });
        },
      }),
    );
    const upstream = await failing?.exec('search', { query: 'x' });
    expect(upstream).toMatchObject({ outcome: 'denied', reason: 'upstream' });
  });
});
