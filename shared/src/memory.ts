/**
 * M4 memory + user-model wire contracts (PLAN-M4.md).
 *
 * Explicit, user-visible memory: profile facts (user-confirmed), episode
 * summaries (per conversation), full-text retrieval, forgetting, and
 * import/export. All data stays local to the core.
 */

export type ProfileEntryKind = 'preference' | 'identity' | 'rule' | 'style';

export type ProfileEntryStatus = 'confirmed' | 'suggested' | 'rejected';

export interface ProfileEntry {
  id: string;
  kind: ProfileEntryKind;
  /** Machine key when applicable (e.g. tone, language, tldr-first). */
  key: string | null;
  /** The human-readable fact/preference. */
  value: string;
  /** Why the partner thinks this (observed examples); optional. */
  evidence: string | null;
  source: 'user' | 'partner_suggestion';
  status: ProfileEntryStatus;
  /**
   * Persona ids this fact is scoped to. **EMPTY = applies to every persona**
   * (the global case). One id = private to that persona; two or more = shared
   * by exactly those personas (M33 multi-select). Ids of deleted personas are
   * preserved verbatim so an edit round-trip never silently widens a fact.
   */
  personaScopes: string[];
  createdAt: number;
  updatedAt: number;
}

export interface ProfileEntryInput {
  kind: ProfileEntryKind;
  key?: string;
  value: string;
  evidence?: string;
  source?: 'user' | 'partner_suggestion';
  status?: ProfileEntryStatus;
  /** Persona ids to scope to; omitted or `[]` = every persona. */
  personaScopes?: string[];
  /**
   * @deprecated Pre-M33 single-scope field. Still accepted on input (a `null`
   * maps to `[]` = all personas, a string to `[id]`) so existing callers and
   * exported bundles keep working; responses never carry it.
   */
  personaScope?: string | null;
}

export interface EpisodeSummary {
  id: string;
  conversationId: string;
  personaId: string | null;
  title: string;
  summary: string;
  model: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface MemorySearchHit {
  kind: 'profile' | 'episode';
  refId: string;
  snippet: string;
  /** FTS bm25-style rank (lower = better). */
  rank: number;
}

export interface MemoryExportBundle {
  schema: 'memory/v1';
  exportedAt: number;
  profile: ProfileEntry[];
  episodes: EpisodeSummary[];
}

export interface ForgetRequest {
  what: 'entry' | 'episode' | 'all';
  id?: string;
  /** ISO timestamp — forget everything (episodes/profile) before this. */
  before?: string;
}
