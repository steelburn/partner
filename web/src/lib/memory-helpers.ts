/**
 * DOM-free logic for the M4 Memory screen (PLAN-M4.md).
 *
 * Kept out of the component so every label/decision/sort rule is unit-
 * testable in the node vitest env (no jsdom). Rendering is presentational.
 * Secrets/redaction discipline: memory content is user data that may be
 * shown to the OWNER in the UI, but nothing in this module logs or echoes it
 * into errors — validation errors name the offending field/index, never the
 * value itself.
 */

import type {
  EpisodeSummary,
  MemoryExportBundle,
  ProfileEntry,
  ProfileEntryKind,
  ProfileEntryStatus,
} from '@partner/shared';

// ---------------------------------------------------------------------------
// Kind labels + tone (PLAN-M4: confirmed entry rows carry a kind chip)
// ---------------------------------------------------------------------------

export const KIND_LABELS: Record<ProfileEntryKind, string> = {
  preference: 'Preference',
  identity: 'Identity',
  rule: 'Rule',
  style: 'Style',
};

/** Short human label for a profile-entry kind. */
export function kindLabel(kind: ProfileEntryKind): string {
  return KIND_LABELS[kind];
}

/**
 * Contrast-safe semantic tone for a kind chip.
 *
 * Only three text tones are usable at chip size in both themes (measured:
 * accent/danger small text fail APCA on --surface-2 in light mode, so tone
 * text always sits on a --bg chip). Descriptive kinds (identity, style)
 * stay neutral; directive kinds get a semantic tone: preference = accent
 * (actively honoured), rule = danger (a boundary).
 */
export type KindTone = 'neutral' | 'accent' | 'danger';

export function kindTone(kind: ProfileEntryKind): KindTone {
  switch (kind) {
    case 'preference':
      return 'accent';
    case 'rule':
      return 'danger';
    default:
      return 'neutral';
  }
}

// ---------------------------------------------------------------------------
// Status labels
// ---------------------------------------------------------------------------

export const STATUS_LABELS: Record<ProfileEntryStatus, string> = {
  confirmed: 'Confirmed',
  suggested: 'Suggested',
  rejected: 'Rejected',
};

/** Short human label for a profile-entry status. */
export function statusLabel(status: ProfileEntryStatus): string {
  return STATUS_LABELS[status];
}

// ---------------------------------------------------------------------------
// Scope + persona naming
// ---------------------------------------------------------------------------

export interface PersonaLike {
  id: string;
  name: string;
  /** M19: private-memory toggle (absent = off). */
  memory?: { personaMemory?: 'on' | 'off' };
}

/**
 * Persona ids an entry is scoped to. Defensive on purpose: a payload that
 * skipped `parseProfileEntry` (tests, a pre-M33 core) may still carry the old
 * single `personaScope` field, and `[]` must mean "every persona".
 */
export function scopesOf(entry: ProfileEntry): string[] {
  const entryScopes = (entry as { personaScopes?: unknown }).personaScopes;
  if (Array.isArray(entryScopes)) {
    return entryScopes.filter((id): id is string => typeof id === 'string' && id.trim() !== '');
  }
  const legacy = (entry as { personaScope?: unknown }).personaScope;
  return typeof legacy === 'string' && legacy.trim() !== '' ? [legacy.trim()] : [];
}

/** True when the entry applies to every persona (an empty scope set). */
export function isGlobalScope(scopes: readonly string[]): boolean {
  return scopes.length === 0;
}

/**
 * Full, readable description of a scope set — used for tooltips and
 * accessible names, where length is not a layout constraint.
 *
 * `[]` reads "All personas"; each id resolves to a persona name, or a neutral
 * fallback when the persona no longer exists (the id itself is a core id and
 * is never revealed).
 */
export function scopedLabel(
  scopes: readonly string[],
  personas: readonly PersonaLike[] = [],
): string {
  if (scopes.length === 0) return 'All personas';
  return scopes.map((id) => personaName(id, personas)).join(', ');
}

/**
 * Compact scope text for a row's meta line: a single persona is named, two or
 * more collapse to a count (the full list rides the element's title).
 */
export function scopedSummary(
  scopes: readonly string[],
  personas: readonly PersonaLike[] = [],
): string {
  if (scopes.length === 0) return 'All personas';
  if (scopes.length === 1) return personaName(scopes[0] as string, personas);
  return `${scopes.length} personas`;
}

/** A scoped persona that no longer exists locally (its id is still kept). */
export function removedScopes(
  scopes: readonly string[],
  personas: readonly PersonaLike[] = [],
): string[] {
  return scopes.filter((id) => !personas.some((persona) => persona.id === id));
}

function personaName(id: string, personas: readonly PersonaLike[]): string {
  return personas.find((persona) => persona.id === id)?.name ?? 'Removed persona';
}

/**
 * Pure picker transition. Selecting a persona adds it; selecting it again
 * removes it. Removing the last one falls back to the empty set, which is the
 * canonical "All personas" state — the UI never leaves zero boxes ticked with
 * no meaning.
 */
export function toggleScope(scopes: readonly string[], id: string): string[] {
  return scopes.includes(id) ? scopes.filter((scope) => scope !== id) : [...scopes, id];
}

/**
 * Set equality for two scope sets — order-insensitive, so re-checking an
 * already-selected persona is a no-op rather than a pointless write.
 */
export function sameScopes(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((id) => b.includes(id));
}

/**
 * The "in use" indicator. The server injects at most the 8 NEWEST confirmed
 * GLOBAL entries into every persona, plus — when a persona has private memory
 * on — the 8 newest of [globals + that persona's own scoped entries]. This
 * returns the union across the personas passed in (newest-first, capped),
 * which equals the old global-only set when none has private memory on.
 */
export const TAILORING_ENTRY_LIMIT = 8;

export function tailoringInUseIds(
  entries: readonly ProfileEntry[],
  personas: readonly PersonaLike[] = [],
): ReadonlySet<string> {
  const confirmed = entries.filter((entry) => entry.status === 'confirmed');
  const newest = (list: readonly ProfileEntry[]): ProfileEntry[] =>
    [...list].sort((a, b) => b.createdAt - a.createdAt).slice(0, TAILORING_ENTRY_LIMIT);

  const ids = new Set(
    newest(confirmed.filter((entry) => isGlobalScope(scopesOf(entry)))).map((e) => e.id),
  );
  for (const persona of personas) {
    if (persona.memory?.personaMemory !== 'on') continue;
    const scoped = confirmed.filter((entry) => {
      const scopes = scopesOf(entry);
      return scopes.length === 0 || scopes.includes(persona.id);
    });
    for (const entry of newest(scoped)) ids.add(entry.id);
  }
  return ids;
}

/** Single-entry predicate: confirmed, and honored by at least one persona. */
export function isEntryInUse(entry: ProfileEntry, personas: readonly PersonaLike[] = []): boolean {
  if (entry.status !== 'confirmed') return false;
  const scopes = scopesOf(entry);
  if (scopes.length === 0) return true;
  return personas.some(
    (persona) => scopes.includes(persona.id) && persona.memory?.personaMemory === 'on',
  );
}

/** How many of the given entries are actually injected (capped, newest-first). */
export function countEntriesInUse(
  entries: readonly ProfileEntry[],
  personas: readonly PersonaLike[] = [],
): number {
  return tailoringInUseIds(entries, personas).size;
}

/** M19: a partner-suggested entry was detected by the model, not typed by the
 *  user. The UI labels these so provenance is never ambiguous. */
export function isAutoDetected(entry: ProfileEntry): boolean {
  return entry.source === 'partner_suggestion';
}

// ---------------------------------------------------------------------------
// Episodes
// ---------------------------------------------------------------------------

/**
 * Sort episode summaries most-recent first by updatedAt; equal timestamps
 * fall back to createdAt (also descending), then id, for determinism.
 */
export function sortEpisodes(list: readonly EpisodeSummary[]): EpisodeSummary[] {
  return [...list].sort(
    (a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt || a.id.localeCompare(b.id),
  );
}

/** Title that always has text for an episode row. */
export function episodeTitle(episode: EpisodeSummary): string {
  const title = (episode.title ?? '').trim();
  return title.length > 0 ? title : 'Untitled conversation';
}

/**
 * Clamp a summary for list rows. Stops on a code-point boundary so no
 * surrogate pair is split; appends an ellipsis when truncated.
 */
export function clampText(text: string, max = 220): string {
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  return `${chars.slice(0, max).join('')}…`;
}

// ---------------------------------------------------------------------------
// Export / import (PLAN-M4: bundle <-> file)
// ---------------------------------------------------------------------------

export const MEMORY_BUNDLE_FILE = 'partner-memory.json';

/** JSON payload for the downloadable memory file (pretty-printed). */
export function bundleToFile(bundle: MemoryExportBundle): string {
  return `${JSON.stringify(bundle, null, 2)}\n`;
}

const MAX_BUNDLE_CHARS = 900_000; // below the core's 1 MiB JSON body cap

/**
 * Schema guard run BEFORE an import POST (and on export responses). Returns
 * a human error message, or null when the value is a plausible memory/v1
 * bundle. Element errors name the row index, never content.
 */
export function validateBundle(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return 'This is not a Partner memory file — expected an object exported from Memory.';
  }
  const bundle = value as Record<string, unknown>;
  if (bundle.schema !== 'memory/v1') {
    return 'This is not a Partner memory export (missing the memory/v1 schema marker).';
  }
  if (!Array.isArray(bundle.profile)) {
    return 'The memory file has no profile list — it may be from a different app.';
  }
  if (!Array.isArray(bundle.episodes)) {
    return 'The memory file has no episodes list — it may be from a different app.';
  }
  for (let i = 0; i < bundle.profile.length; i += 1) {
    const entryError = entryShapeError(bundle.profile[i], 'profile', i);
    if (entryError) return entryError;
  }
  for (let i = 0; i < bundle.episodes.length; i += 1) {
    const episodeError = episodeShapeError(bundle.episodes[i], 'episodes', i);
    if (episodeError) return episodeError;
  }
  return null;
}

/** Reject oversized files early (keeps the guard cheap and the UI honest). */
export function validateBundleSize(jsonText: string): string | null {
  if (jsonText.length > MAX_BUNDLE_CHARS) {
    return 'The memory file is too large to import.';
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function entryShapeError(row: unknown, listName: string, index: number): string | null {
  if (!isRecord(row)) return `${listName}[${index}] is not an entry object.`;
  if (typeof row.id !== 'string' || row.id.length === 0) {
    return `${listName}[${index}] is missing its id.`;
  }
  if (typeof row.value !== 'string' || row.value.length === 0) {
    return `${listName}[${index}] is missing its value text.`;
  }
  if (typeof row.createdAt !== 'number' || typeof row.updatedAt !== 'number') {
    return `${listName}[${index}] is missing its timestamps.`;
  }
  return null;
}

function episodeShapeError(row: unknown, listName: string, index: number): string | null {
  if (!isRecord(row)) return `${listName}[${index}] is not an episode object.`;
  if (typeof row.id !== 'string' || row.id.length === 0) {
    return `${listName}[${index}] is missing its id.`;
  }
  if (typeof row.conversationId !== 'string' || row.conversationId.length === 0) {
    return `${listName}[${index}] is missing its conversation id.`;
  }
  if (typeof row.summary !== 'string' || row.summary.length === 0) {
    return `${listName}[${index}] is missing its summary text.`;
  }
  if (typeof row.createdAt !== 'number' || typeof row.updatedAt !== 'number') {
    return `${listName}[${index}] is missing its timestamps.`;
  }
  return null;
}

/**
 * A <input type="date"> value ("YYYY-MM-DD") to the ISO instant sent as
 * ForgetRequest.before: local midnight at the START of the chosen day, so
 * "forget before <date>" keeps everything from that day onward. Returns null
 * for malformed or impossible dates (e.g. 2023-02-31).
 */
export function dateValueToForgetIso(dateValue: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateValue.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1970 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(year, month - 1, day, 0, 0, 0, 0);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return null; // rolled over (e.g. Feb 30) — not a real date
  }
  return date.toISOString();
}
