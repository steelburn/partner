/**
 * Profile manager (M4, PLAN-M4.md §"profile manager").
 *
 * Explicit, user-visible memory facts. Owns validation (kind whitelist,
 * non-empty value), the status lifecycle (suggested -> confirmed/rejected ->
 * confirmed again), persona scoping (personaScope null = global), and the FTS
 * mirror: every write re-indexes the entry's searchable text (value), and
 * rejected entries are un-indexed so search never surfaces them.
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
  /** Restrict to one persona scope. Pass a NON-NULL persona id to read only
   *  that persona's entries plus... see below. */
  personaScope?: string;
}

/** Partial update; fields validate like create. */
export type ProfileEntryPatch = Partial<
  Pick<ProfileEntryInput, 'kind' | 'key' | 'value' | 'evidence' | 'source' | 'status' | 'personaScope'>
>;

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
function toEntry(row: ProfileEntryRow): ProfileEntry {
  return {
    id: row.id,
    kind: row.kind as ProfileEntryKind,
    key: row.key,
    value: row.value,
    evidence: row.evidence,
    source: row.source as ProfileEntry['source'],
    status: row.status as ProfileEntryStatus,
    personaScope: row.personaScope,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
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
  personaScope: string | null;
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
    personaScope: optionalNullableString(body.personaScope, 'personaScope'),
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
          if (row.personaScope !== optionsIn.personaScope && row.personaScope !== null) {
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
      ...normalized,
      createdAt: at,
      updatedAt: at,
    };
    store.insert(row);
    syncFts(row);
    audit.log('web', 'profile.add', id, {
      kind: row.kind,
      source: row.source,
      status: row.status,
      personaScope: row.personaScope,
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
    if (patch.personaScope !== undefined) {
      current.personaScope = optionalNullableString(patch.personaScope, 'personaScope');
    }

    const updatedAt = now();
    store.update(id, {
      kind: current.kind,
      key: current.key,
      value: current.value,
      evidence: current.evidence,
      source: current.source,
      status: current.status,
      personaScope: current.personaScope,
      updatedAt,
    });
    const updated = store.findById(id);
    if (!updated) throw memoryError('not_found', 'profile entry not found');
    syncFts(updated);
    audit.log('web', 'profile.update', id, {
      kind: updated.kind,
      status: updated.status,
      personaScope: updated.personaScope,
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
