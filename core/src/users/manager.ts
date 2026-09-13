/**
 * App users (PLAN-M20-B S2) — provisioning, the disabled gate, first run.
 *
 * S2 provisions ACCOUNTS; proving which account a request is belongs to the
 * credential side (`users/credentials.ts`, S2a). A row here with no credential
 * is a valid state: on a single-user desktop the OS profile identifies the
 * holder, so pairing mints as user #0 with no sign-in at all (§2a), and the
 * PairGate stays byte-identical to today.
 *
 * Row storage is the system database (`data/system.db`, `users/store.ts`),
 * because a user list cannot live inside a per-user database.
 *
 * Creation is deliberately NOT implicit: {@link UserManager.ensureFirstUser}
 * creates user #0 only on a core that has NO users, from the OS profile of the
 * machine running the core. On a core that already has users, an unknown OS
 * profile resolves to `null` — no user is conjured for whoever happens to be
 * logged in, which is the whole point of Q2 (creation is an explicit,
 * local-only administrative act).
 *
 * Deletion is NOT a method here. Disabling is the reversible stop: the row
 * keeps its id, the user's partition directory, their databases and files on
 * disk, and re-enabling restores access. Removing a user for good means
 * removing the partition directory (the path helper in `users/paths.ts` says
 * where it is) and then this row — two deliberate steps, so no request path
 * can turn "disable this" into "delete their data".
 */
import type { UserRow, UserStore } from '../stores/types.js';
import { LEGACY_USER_ID } from '@partner/shared';
import { InvalidUserIdError, assertValidUserId } from './paths.js';
import { currentOsProfileUsername, osProfileKey } from './osProfile.js';

/**
 * The id of the first user, created from the OS profile on an empty core.
 *
 * Deliberately the SAME value as {@link LEGACY_USER_ID}: the first user also
 * owns the pre-partition layout, so an existing install's database is not
 * orphaned by partitioning. Deriving it means the two cannot drift apart — and
 * the failure mode of drift here is silent data disappearance on upgrade.
 */
export const FIRST_USER_ID = LEGACY_USER_ID;

export type UserCreateResult =
  | { ok: true; user: UserRow }
  | { ok: false; reason: 'invalid_id' | 'duplicate_id' | 'duplicate_os_profile' };

export type UserMutationResult =
  | { ok: true; user: UserRow }
  | { ok: false; reason: 'not_found' };

/**
 * The request-time answer to "who is this acting as?" — `disabled` is the
 * refusal a disabled user gets while every row and file of theirs is intact.
 */
export type UserResolution =
  | { ok: true; user: UserRow }
  | { ok: false; reason: 'unknown_user' | 'disabled' };

export interface UserManagerOptions {
  /** `users` rows in the system database. */
  store: UserStore;
  /**
   * The login name of the machine's holder — the injectable seam. Defaults to
   * {@link currentOsProfileUsername}; tests inject a constant so they never
   * depend on the account running them. The manager derives the key from it
   * (see {@link osProfileKey}), so a raw login name is what a caller supplies.
   */
  osProfileUsername?: () => string;
  /** Injectable clock (epoch ms). */
  now?: () => number;
}

export interface UserManager {
  /**
   * First run: with no users at all, create user {@link FIRST_USER_ID} mapped
   * to this OS profile and return it. Idempotent — a second call returns the
   * same row, because one OS user maps to one app user. Returns `null` when
   * the core already has users and none of them is this OS profile.
   */
  ensureFirstUser(): UserRow | null;
  /** Provision one user. The caller owns the id (validated as a partition name). */
  create(input: { id: string; label: string; osProfileKey?: string | null }): UserCreateResult;
  /** Every user, oldest first (disabled users included — see `disabledAt`). */
  list(): UserRow[];
  findById(id: string): UserRow | undefined;
  /** The gate a session/request path asks: unknown or disabled users refuse. */
  resolve(id: string): UserResolution;
  /** Stop a user without touching their data. Idempotent. */
  disable(id: string): UserMutationResult;
  /** Undo a disable (the point of disabling rather than deleting). Idempotent. */
  enable(id: string): UserMutationResult;
  /**
   * M20-B S9: the per-user at-rest policy.  keeps the partition key in the
   * keychain so this user's schedules run while nobody is signed in — an
   * explicit, AUDITED (by the caller), per-user weakening of the promise that
   * signing out makes the data unreadable. Returns false for an unknown id.
   */
  setKeepUnlocked(id: string, value: boolean): boolean;
}

export function createUserManager(options: UserManagerOptions): UserManager {
  const store = options.store;
  const readUsername = options.osProfileUsername ?? currentOsProfileUsername;
  const now = options.now ?? Date.now;

  return {
    ensureFirstUser(): UserRow | null {
      const username = readUsername().trim();
      const profileKey = osProfileKey(username);
      const mapped = store.findByOsProfileKey(profileKey);
      if (mapped !== undefined) return mapped;
      if (store.list().length > 0) return null;
      const at = now();
      // The label is the login name as the OS spells it; the key is folded.
      const user: UserRow = {
        id: FIRST_USER_ID,
        label: username,
        osProfileKey: profileKey,
        createdAt: at,
        disabledAt: null,
        keepUnlocked: false,
      };
      store.insert(user);
      return user;
    },

    create(input): UserCreateResult {
      try {
        assertValidUserId(input.id);
      } catch (error) {
        if (error instanceof InvalidUserIdError) return { ok: false, reason: 'invalid_id' };
        throw error;
      }
      if (store.findById(input.id) !== undefined) {
        return { ok: false, reason: 'duplicate_id' };
      }
      // One OS user maps to one app user: a second user cannot claim a profile
      // that already has an app-side user, or one person's data would fork.
      const profileKey =
        typeof input.osProfileKey === 'string' && input.osProfileKey.trim() !== ''
          ? osProfileKey(input.osProfileKey)
          : null;
      if (profileKey !== null && store.findByOsProfileKey(profileKey) !== undefined) {
        return { ok: false, reason: 'duplicate_os_profile' };
      }
      const user: UserRow = {
        id: input.id,
        label: input.label,
        osProfileKey: profileKey,
        createdAt: now(),
        disabledAt: null,
        keepUnlocked: false,
      };
      store.insert(user);
      return { ok: true, user };
    },

    list(): UserRow[] {
      return store.list();
    },

    findById(id: string): UserRow | undefined {
      return store.findById(id);
    },

    resolve(id: string): UserResolution {
      const user = store.findById(id);
      if (user === undefined) return { ok: false, reason: 'unknown_user' };
      if (user.disabledAt !== null) return { ok: false, reason: 'disabled' };
      return { ok: true, user };
    },

    disable(id: string): UserMutationResult {
      const user = store.findById(id);
      if (user === undefined) return { ok: false, reason: 'not_found' };
      // Idempotent: the first disable's timestamp stands, so a repeat call
      // neither moves the stamp nor returns a different user.
      if (user.disabledAt !== null) return { ok: true, user };
      const at = now();
      store.disable(id, at);
      return { ok: true, user: { ...user, disabledAt: at } };
    },

    setKeepUnlocked(id: string, value: boolean): boolean {
      return store.setKeepUnlocked(id, value);
    },

    enable(id: string): UserMutationResult {
      const user = store.findById(id);
      if (user === undefined) return { ok: false, reason: 'not_found' };
      if (user.disabledAt === null) return { ok: true, user };
      store.enable(id);
      return { ok: true, user: { ...user, disabledAt: null } };
    },
  };
}
