/**
 * Profile manager (M4, PLAN-M4.md §"profile manager").
 *
 * Explicit, user-visible memory facts. Owns validation (kind whitelist,
 * non-empty value), the status lifecycle (suggested -> confirmed/rejected ->
 * confirmed again), persona scoping (M33: an EMPTY `personaScopes` array =
 * global, i.e. every persona), and the FTS mirror: every write re-indexes the
 * entry's searchable text (value), and rejected entries are un-indexed so
 * search never surfaces them.
 *
 * Scope storage: `profile_entries.persona_scopes` holds a JSON id array (or
 * NULL for global). This module owns the encoding, mirroring the
 * `providers.vision_models` split — the row store stays plain CRUD.
 *
 * Audit discipline: rows carry ids, kind, status, source, scope and LENGTHS —
 * never the value/evidence content (user data stays in the tables and in
 * responses to the OWNER only).
 */
import { randomUUID } from 'node:crypto';
import type { ProfileEntry, ProfileEntryInput, ProfileEntryKind, ProfileEntryStatus } from '@partner/shared';
import type { AuditService } from '../services/redaction.js';
import type { MemoryFtsStore, ProfileEntryRow, ProfileEntryStore } from '../stores/types.js';
import { memoryError } from './errors.js';

export const PROFILE_KINDS: readonly ProfileEntryKind[] = [
  'preference',
  'identity',
  'rule',
  'style',
];
export const PROFILE_STATUSES: readonly ProfileEntryStatus[] = [
  'confirmed',
  'suggested',
  'rejected',
];
export const PROFILE_SOURCES: readonly ProfileEntryInput['source'][] = [
  'user',
  'partner_suggestion',
];

export interface ProfileManagerOptions {
  store: ProfileEntryStore;
  /** FTS mirror — when wired, writes keep search in sync (always wired in
   *  production/harness; optional so store-only tests can omit it). */
  fts?: MemoryFtsStore;
  audit: AuditService;
  /** Injectable clock (epoch ms). */
  now?: () => number;
}

export interface ProfileListOptions {
  /** Include rejected entries (default false — rejected facts are hidden). */
  includeRejected?: boolean;
  /** Restrict to the entries one persona honors: global (empty scope) plus
   *  any entry whose scope includes this persona id. Pass a NON-NULL persona
   *  id; an absent option returns everything. */
  personaScope?: string;
}

/** Partial update; fields validate like create. */
export type ProfileEntryPatch = Partial<
  Pick<ProfileEntryInput, 'kind' | 'key' | 'value' | 'evidence' | 'source' | 'status'>
> & {
  /** New scope set; `[]` = every persona. */
  personaScopes?: string[];
  /** @deprecated legacy single scope (null = every persona). */
  personaScope?: string | null;
};

export interface ProfileManager {
  /** Confirmed + suggested by default; includeRejected to surface rejected. */
  list(options?: ProfileListOptions): ProfileEntry[];
  get(id: string): ProfileEntry | null;
  /**
   * Add an entry. Status defaults from source: 'partner_suggestion' ->
   * 'suggested' (user must confirm); 'user' -> 'confirmed'. An explicit
   * status is honored after validation.
   */
  add(input: ProfileEntryInput): ProfileEntry;
  /** Partial update with status transitions (rejected -> confirmed allowed). */
  update(id: string, patch: ProfileEntryPatch): ProfileEntry;
  /** Remove an entry (un-indexes it). Unknown id -> not_found. */
  remove(id: string): void;
}

/** Wire row -> ProfileEntry (values are already validated by the manager). */
export function profileRowToEntry(row: ProfileEntryRow): ProfileEntry {
  return {
    id: row.id,
    kind: row.kind as ProfileEntryKind,
    key: row.key,
    value: row.value,
    evidence: row.evidence,
    source: row.source as ProfileEntry['source'],
    status: row.status as ProfileEntryStatus,
    personaScopes: parsePersonaScopes(row.personaScopes),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
const toEntry = profileRowToEntry;

/**
 * Parse the stored JSON id array. TOLERANT by design: a NULL/blank column, a
 * malformed payload or non-string elements all read as `[]` (global) rather
 * than throwing — a corrupt scope must never make the whole Memory screen
 * unreadable. Duplicates are collapsed; blank ids are dropped.
 */
export function parsePersonaScopes(raw: string | null | undefined): string[] {
  if (raw === null || raw === undefined || raw.trim() === '') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const ids: string[] = [];
  for (const value of parsed) {
    if (typeof value !== 'string') continue;
    const id = value.trim();
    if (id === '' || ids.includes(id)) continue;
    ids.push(id);
  }
  return ids;
}

/** Serialize a scope set for the `persona_scopes` column; `[]` -> NULL. */
export function serializePersonaScopes(scopes: readonly string[]): string | null {
  const ids = normalizePersonaScopes(scopes, 'personaScopes');
  return ids.length === 0 ? null : JSON.stringify(ids);
}

/**
 * Normalize a scope set: every element must be a non-blank string. Throws
 * `invalid_input` on any other shape (a bad array is a client bug worth
 * surfacing, unlike a bad STORED value which is tolerated). Empty ids are
 * dropped and duplicates collapsed, order preserved.
 */
export function normalizePersonaScopes(raw: unknown, what: string): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw memoryError('invalid_input', `${what} must be an array of persona ids`);
  }
  const ids: string[] = [];
  for (const value of raw) {
    if (typeof value !== 'string') {
      throw memoryError('invalid_input', `${what} must be an array of persona ids`);
    }
    const id = value.trim();
    if (id === '' || ids.includes(id)) continue;
    ids.push(id);
  }
  return ids;
}

/**
 * Resolve the scope set an input carries. M33 canonical field is
 * `personaScopes`; the pre-M33 `personaScope` string/null is still honored
 * (null -> `[]`) so older callers and imported bundles keep working. When
 * both are present the array wins.
 */
function scopeFromInput(body: ProfileEntryInput): string[] {
  if (body.personaScopes !== undefined) {
    return normalizePersonaScopes(body.personaScopes, 'personaScopes');
  }
  const legacy = optionalNullableString(body.personaScope, 'personaScope');
  return legacy === null ? [] : [legacy];
}

function requireKind(raw: unknown): ProfileEntryKind {
  if (typeof raw !== 'string' || !(PROFILE_KINDS as readonly string[]).includes(raw)) {
    throw memoryError(
      'invalid_input',
      `kind must be one of ${PROFILE_KINDS.join('|')} (got ${JSON.stringify(raw)})`,
    );
  }
  return raw as ProfileEntryKind;
}

function requireStatus(raw: unknown): ProfileEntryStatus {
  if (typeof raw !== 'string' || !(PROFILE_STATUSES as readonly string[]).includes(raw)) {
    throw memoryError(
      'invalid_input',
      `status must be one of ${PROFILE_STATUSES.join('|')} (got ${JSON.stringify(raw)})`,
    );
  }
  return raw as ProfileEntryStatus;
}

function requireSource(raw: unknown): 'user' | 'partner_suggestion' {
  if (
    typeof raw !== 'string' ||
    !(PROFILE_SOURCES as readonly string[]).includes(raw as 'user' | 'partner_suggestion')
  ) {
    throw memoryError(
      'invalid_input',
      `source must be 'user' or 'partner_suggestion' (got ${JSON.stringify(raw)})`,
    );
  }
  return raw as 'user' | 'partner_suggestion';
}

function requireValue(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw memoryError('invalid_input', 'value must be a non-empty string');
  }
  const value = raw.trim();
  if (value === '') {
    throw memoryError('invalid_input', 'value must be a non-empty string');
  }
  return value;
}

function optionalNullableString(raw: unknown, what: string): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') {
    throw memoryError('invalid_input', `${what} must be a string`);
  }
  const trimmed = raw.trim();
  return trimmed === '' ? null : trimmed;
}

/** Normalize an input into canonical fields; throws invalid_input. Status
 *  defaults from source: partner suggestions land 'suggested' (a user must
 *  confirm), user entries land 'confirmed'. An explicit status is honored. */
export function normalizeProfileInput(
  input: ProfileEntryInput,
): {
  kind: ProfileEntryKind;
  key: string | null;
  value: string;
  evidence: string | null;
  source: 'user' | 'partner_suggestion';
  status: ProfileEntryStatus;
  personaScopes: string[];
} {
  const body = (input ?? {}) as ProfileEntryInput;
  const kind = requireKind(body.kind);
  const source = requireSource(body.source ?? 'user');
  const status =
    body.status !== undefined
      ? requireStatus(body.status)
      : source === 'partner_suggestion'
        ? 'suggested'
        : 'confirmed';
  return {
    kind,
    key: optionalNullableString(body.key, 'key'),
    value: requireValue(body.value),
    evidence: optionalNullableString(body.evidence, 'evidence'),
    source,
    status,
    personaScopes: scopeFromInput(body),
  };
}

/** The text search should index for an entry (value only — the fact itself). */
export function profileSearchText(entry: {
  value: string;
}): string {
  return entry.value;
}

export function createProfileManager(options: ProfileManagerOptions): ProfileManager {
  const { store, audit } = options;
  const fts = options.fts;
  const now = options.now ?? Date.now;

  /** Re-index an entry unless it is rejected (rejected facts never surface). */
  function syncFts(entry: ProfileEntryRow | ProfileEntry): void {
    if (!fts) return;
    if (entry.status === 'rejected') {
      fts.deleteRef('profile', entry.id);
      return;
    }
    fts.upsertProfile(entry.id, profileSearchText(entry));
  }

  function list(optionsIn: ProfileListOptions = {}): ProfileEntry[] {
    return store
      .list()
      .filter((row) => {
        if (!optionsIn.includeRejected && row.status === 'rejected') return false;
        if (optionsIn.personaScope !== undefined) {
          const scopes = parsePersonaScopes(row.personaScopes);
          if (scopes.length > 0 && !scopes.includes(optionsIn.personaScope)) {
            return false;
          }
        }
        return true;
      })
      .map(toEntry);
  }

  function get(id: string): ProfileEntry | null {
    const row = store.findById(id);
    return row ? toEntry(row) : null;
  }

  function add(input: ProfileEntryInput): ProfileEntry {
    const normalized = normalizeProfileInput(input);
    const at = now();
    const id = randomUUID();
    const row: ProfileEntryRow = {
      id,
      kind: normalized.kind,
      key: normalized.key,
      value: normalized.value,
      evidence: normalized.evidence,
      source: normalized.source,
      status: normalized.status,
      personaScopes: serializePersonaScopes(normalized.personaScopes),
      createdAt: at,
      updatedAt: at,
    };
    store.insert(row);
    syncFts(row);
    audit.log('web', 'profile.add', id, {
      kind: row.kind,
      source: row.source,
      status: row.status,
      personaScopes: parsePersonaScopes(row.personaScopes),
      valueLength: row.value.length,
    });
    return toEntry(row);
  }

  function update(id: string, patchIn: ProfileEntryPatch): ProfileEntry {
    const existing = store.findById(id);
    if (!existing) throw memoryError('not_found', 'profile entry not found');
    const patch = (patchIn ?? {}) as ProfileEntryPatch;
    const current = toEntry(existing);

    if (patch.kind !== undefined) current.kind = requireKind(patch.kind);
    if (patch.key !== undefined) current.key = optionalNullableString(patch.key, 'key');
    if (patch.value !== undefined) current.value = requireValue(patch.value);
    if (patch.evidence !== undefined) {
      current.evidence = optionalNullableString(patch.evidence, 'evidence');
    }
    if (patch.source !== undefined) current.source = requireSource(patch.source);
    if (patch.status !== undefined) current.status = requireStatus(patch.status);
    // `personaScopes` (M33) wins over the deprecated single `personaScope`.
    if (patch.personaScopes !== undefined) {
      current.personaScopes = normalizePersonaScopes(patch.personaScopes, 'personaScopes');
    } else if (patch.personaScope !== undefined) {
      const legacy = optionalNullableString(patch.personaScope, 'personaScope');
      current.personaScopes = legacy === null ? [] : [legacy];
    }

    const updatedAt = now();
    store.update(id, {
      kind: current.kind,
      key: current.key,
      value: current.value,
      evidence: current.evidence,
      source: current.source,
      status: current.status,
      personaScopes: serializePersonaScopes(current.personaScopes),
      updatedAt,
    });
    const updated = store.findById(id);
    if (!updated) throw memoryError('not_found', 'profile entry not found');
    syncFts(updated);
    audit.log('web', 'profile.update', id, {
      kind: updated.kind,
      status: updated.status,
      personaScopes: parsePersonaScopes(updated.personaScopes),
      valueLength: updated.value.length,
    });
    return toEntry(updated);
  }

  function remove(id: string): void {
    const row = store.findById(id);
    if (!row) throw memoryError('not_found', 'profile entry not found');
    store.remove(id);
    if (fts) fts.deleteRef('profile', id);
    audit.log('web', 'profile.delete', id, {
      kind: row.kind,
      status: row.status,
      valueLength: row.value.length,
    });
  }

  return { list, get, add, update, remove };
}
