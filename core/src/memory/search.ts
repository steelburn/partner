/**
 * Search manager (M4, PLAN-M4.md §"search").
 *
 * Keyword retrieval over profile + episode searchable text via the FTS5
 * mirror. Every user-supplied term is wrapped in double quotes (embedded
 * quotes doubled) so FTS metacharacters (`*`, `-`, `:`, `"`, parens, …)
 * can never crash or hijack the query — quoted terms match literally and are
 * AND-ed. Hits are ranked by bm25 ascending (lower = better) and capped at
 * 50. An empty query is a typed invalid_input.
 *
 * Snippets come from the LIVE row (never the FTS tokenizer): profile = the
 * value truncated; episode = the summary truncated to 200 chars. Hits whose
 * backing row vanished (forgotten between index and query) are skipped.
 */
import type { MemorySearchHit } from '@partner/shared';
import type { EpisodeStore, MemoryFtsStore, ProfileEntryStore } from '../stores/types.js';
import { memoryError } from './errors.js';

export const SEARCH_HIT_CAP = 50;
export const EPISODE_SNIPPET_CAP = 200;
export const PROFILE_SNIPPET_CAP = 200;
export const ELLIPSIS = '\u2026';

export interface SearchManagerOptions {
  stores: { fts: MemoryFtsStore; profile: ProfileEntryStore; episodes: EpisodeStore };
}

export interface SearchManager {
  /** Full-text query -> ranked hits (cap 50). Empty query -> invalid_input. */
  query(q: string): MemorySearchHit[];
}

/**
 * Escape a raw user query for FTS5 MATCH: split on whitespace and wrap each
 * term in double quotes with embedded quotes doubled, joined by spaces
 * (implicit AND of phrase terms). Returns '' for an empty input.
 */
export function escapeFtsQuery(raw: string): string {
  const terms = raw
    .trim()
    .split(/\s+/)
    .filter((term) => term !== '');
  return terms.map((term) => `"${term.replace(/"/g, '""')}"`).join(' ');
}

function truncate(text: string, cap: number): string {
  return text.length <= cap ? text : `${text.slice(0, cap)}${ELLIPSIS}`;
}

export function createSearchManager(options: SearchManagerOptions): SearchManager {
  const { stores } = options;

  function query(raw: string): MemorySearchHit[] {
    if (typeof raw !== 'string' || raw.trim() === '') {
      throw memoryError('invalid_input', 'q must be a non-empty string');
    }
    const escaped = escapeFtsQuery(raw);
    if (escaped === '') {
      throw memoryError('invalid_input', 'q must be a non-empty string');
    }
    const rawHits = stores.fts.match(escaped, SEARCH_HIT_CAP);
    const hits: MemorySearchHit[] = [];
    for (const hit of rawHits) {
      if (hit.kind === 'profile') {
        const row = stores.profile.findById(hit.refId);
        if (!row) continue; // forgotten between index and query
        hits.push({ kind: 'profile', refId: hit.refId, snippet: truncate(row.value, PROFILE_SNIPPET_CAP), rank: hit.rank });
      } else {
        const row = stores.episodes.findById(hit.refId);
        if (!row) continue;
        hits.push({ kind: 'episode', refId: hit.refId, snippet: truncate(row.summary, EPISODE_SNIPPET_CAP), rank: hit.rank });
      }
    }
    return hits;
  }

  return { query };
}
