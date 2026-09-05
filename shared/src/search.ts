/**
 * M11 F2 internet search contracts (PLAN-M11.md).
 *
 * One optional, user-configured search backend (Tavily/Brave class, API-key
 * auth). OFF until the user enables it and stores a key (keychain-held —
 * never in the DB). Results are capped owner data; audit rows carry the
 * query LENGTH + hit count, never the query text or results.
 */
export type SearchProvider = 'tavily' | 'brave';

export interface SearchConfig {
  enabled: boolean;
  provider: SearchProvider;
  /** Defaults to the provider's endpoint when null. */
  endpoint: string | null;
}

export interface SearchConfigInput {
  enabled?: boolean;
  provider?: SearchProvider;
  endpoint?: string | null;
}

export interface SearchHit {
  title: string;
  url: string;
  snippet: string | null;
}

export interface SearchResult {
  query: string;
  hits: SearchHit[];
  provider: SearchProvider;
  ms: number;
}

export const SEARCH_PROVIDERS: readonly SearchProvider[] = ['tavily', 'brave'] as const;

export function isSearchProvider(value: unknown): value is SearchProvider {
  return typeof value === 'string' && (SEARCH_PROVIDERS as readonly string[]).includes(value);
}

/** Provider default endpoints (user may override, e.g. a self-hosted proxy). */
export const SEARCH_DEFAULT_ENDPOINTS: Record<SearchProvider, string> = {
  tavily: 'https://api.tavily.com/search',
  brave: 'https://api.search.brave.com/res/v1/web/search',
};
