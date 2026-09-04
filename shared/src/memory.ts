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
  /** null = applies to every persona; else a persona id. */
  personaScope: string | null;
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
