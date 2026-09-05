/**
 * M11 F2 search as a chat tool (PLAN-M11.md).
 *
 * The `search` tool only exists in a chat's catalog when the search manager
 * is wired, and `allow()` gates it on the backend being ENABLED (default
 * deny). Execution is async (network); results are capped and mapped to the
 * generic tool-result shape the tool pass summarizes into system notes.
 */
import type { ToolExecResponse, ToolId, ToolManifest } from '@partner/shared/tools.js';
import type { SearchManager } from './manager.js';
import { SearchError } from './errors.js';

export const SEARCH_MANIFEST: ToolManifest = {
  // The search tool is an EXTERNAL chat tool — it never enters the broker's
  // files-only catalog, so the closed ToolId union only needs a cast here.
  id: 'search' as ToolId,
  description: 'Search the web with the configured search backend. Args: {query}',
  risk: 'medium',
  confirm: 'once',
  network: true,
  scope: { kind: 'project' },
};

export interface SearchToolExternal {
  manifests: ReadonlyArray<ToolManifest>;
  allow(toolId: string): boolean;
  exec(toolId: string, args: Record<string, unknown>): Promise<ToolExecResponse>;
}

/** The chat-tool external executor for the configured search backend. */
export function searchToolExternal(search: SearchManager | undefined): SearchToolExternal | undefined {
  if (search === undefined) return undefined;
  return {
    manifests: [SEARCH_MANIFEST],
    allow: (toolId: string): boolean =>
      toolId === SEARCH_MANIFEST.id && search.config().enabled === true,
    exec: async (toolId: string, args: Record<string, unknown>): Promise<ToolExecResponse> => {
      if (toolId !== SEARCH_MANIFEST.id) {
        return { outcome: 'denied', reason: 'unknown_tool' };
      }
      const query = typeof args.query === 'string' ? args.query.trim() : '';
      if (query === '') return { outcome: 'denied', reason: 'missing_query' };
      try {
        const result = await search.search(query, 5);
        return {
          outcome: 'executed',
          result: {
            results: result.hits.map((hit) => ({
              title: hit.title,
              url: hit.url,
              content: hit.snippet,
            })),
          },
        };
      } catch (err) {
        return {
          outcome: 'denied',
          reason: err instanceof SearchError ? err.code : 'upstream',
        };
      }
    },
  };
}
