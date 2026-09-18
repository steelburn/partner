/**
 * The system database's store set (PLAN-M20-B S2, §2a).
 *
 * Exactly four tables must be readable before any app user is resolved, so
 * these four are the ones that live in `data/system.db` (opened by
 * `core/src/system/db.ts` with the keychain account `system-key`) rather than
 * in a per-user partition:
 *
 *  - `users` + `user_credentials` — resolving and proving a user cannot depend
 *    on a database that is chosen BY the user.
 *  - `pairings` — a device pairs before anyone has identified themselves.
 *  - `sessions` — an enrolled device record exists before (and without) an
 *    acting user; the acting-session mint is S3's, and a session gains its
 *    `user_id` only from an authentication event (§2a).
 *
 * This is the single spelling of that split: a caller wires the system DB once
 * and gets all four, so no boot can accidentally put `users` in a partition or
 * `sessions` in both. Every partition database also carries these tables
 * (schemas are additive and shared — one migration path); this bundle is what
 * makes the system DB's copy the one that is actually used.
 *
 * See `core/src/users/manager.ts` for the account semantics (first run, the
 * disabled gate) and `core/src/users/credentials.ts` for passphrase checks.
 */
import type Database from 'better-sqlite3';
import {
  createInviteStore,
  createKeyWrapStore,
  createPairingStore,
  createSessionStore,
  createShareStore,
  createSharedAccessStore,
  createUserCredentialStore,
  createUserStore,
} from '../stores/db.js';
import type {
  InviteStore,
  KeyWrapStore,
  PairingStore,
  SessionStore,
  ShareStore,
  SharedAccessStore,
  UserCredentialStore,
  UserStore,
} from '../stores/types.js';

export interface SystemStores {
  /** `users` rows — the app-user registry (`users/manager.ts`). */
  users: UserStore;
  /** Per-user passphrase records (`users/credentials.ts`). */
  credentials: UserCredentialStore;
  /** Pairing codes; enrollment precedes any user. */
  pairings: PairingStore;
  /** Enrolled device/session records; the acting session is S3's. */
  sessions: SessionStore;
  /** S9: passphrase-wrapped partition keys (the at-rest promise). */
  keyWraps: KeyWrapStore;
  /** M29: single-use invitations minted by an owner. */
  invites: InviteStore;
  /** M29: cross-user note/asset shares (snapshot copies). */
  shares: ShareStore;
  /** M29: the deployment's published provider/search configuration. */
  sharedAccess: SharedAccessStore;
}

/** Wire the pre-user stores over one system database handle. */
export function createSystemStores(db: Database.Database): SystemStores {
  return {
    users: createUserStore(db),
    credentials: createUserCredentialStore(db),
    pairings: createPairingStore(db),
    sessions: createSessionStore(db),
    keyWraps: createKeyWrapStore(db),
    invites: createInviteStore(db),
    shares: createShareStore(db),
    sharedAccess: createSharedAccessStore(db),
  };
}
