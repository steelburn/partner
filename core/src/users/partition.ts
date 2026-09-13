/**
 * Per-app-user database partitions (PLAN-M20-B S1).
 *
 * One core with N app users holds up to N open databases — each user's own
 * encrypted FILE in `<dataRoot>/users/<userId>/`, opened with that user's own
 * keychain-held cipher key (see {@link ./paths.js} and
 * {@link ../keychain/dbKey.js}). This module is that open/close cache:
 *
 *  - `open(userId)` derives the user's paths, ensures their key and opens
 *    their database — reusing the handle while it stays open, and sharing one
 *    in-flight open between concurrent callers (so two requests for the same
 *    user never race into two connections on one file).
 *  - The cache is BOUNDED to `maxOpen` handles (LRU): opening user N+1 past
 *    the bound closes the least recently used handle, and `close`/`closeAll`
 *    make the release of a signed-out user's partition explicit.
 *
 * Eviction closes a connection, so a caller holding a handle past its
 * eviction must treat it as closed — the bound has to cover the users this
 * core serves concurrently.
 */
import type Database from 'better-sqlite3';
import type { Keychain } from '@partner/shared';
import { dbKeyAccount, ensureDbKey } from '../keychain/dbKey.js';
import { openEncryptedDatabase } from '../stores/db.js';
import { assertValidUserId, userDbPath, userSkillsDir } from './paths.js';

/** Handles one boot keeps open by default (S3 may tighten it per deployment). */
export const DEFAULT_MAX_OPEN_PARTITIONS = 8;

/** One user's open partition: where it lives and the live connection. */
export interface UserPartitionHandle {
  userId: string;
  dbPath: string;
  skillsDir: string;
  db: Database.Database;
}

export interface UserPartitionsOptions {
  /** Parent of the users tree (`data/users/<userId>/…`). */
  dataRoot: string;
  /** Holds every user's cipher key (service `partner`, account `db-key:<id>`). */
  keychain: Keychain;
  /** Maximum open handles before the least recently used one is closed. */
  maxOpen?: number;
  /**
   * M20-B S9: the partition key to open with, when the caller holds one (an
   * unlocked session).  falls back to the keychain — which is what a
   * pairing-mode install and a keep-unlocked user rely on, and what makes a
   * signed-out user with a WRAPPED key unopenable rather than merely unread.
   */
  keyFor?: (userId: string) => Promise<string | undefined>;
}

export interface UserPartitions {
  readonly dataRoot: string;
  /** Open (or reuse) this user's partition. Rejects for an invalid id. */
  open(userId: string): Promise<UserPartitionHandle>;
  /** Close ONE open partition; false when it was not open. */
  close(userId: string): boolean;
  /** Close every open partition (shutdown / user-management sweep). */
  closeAll(): void;
  /** Open user ids, least recently used first. */
  openUserIds(): string[];
  readonly size: number;
}

export function createUserPartitions(options: UserPartitionsOptions): UserPartitions {
  const { dataRoot, keychain } = options;
  const maxOpen = options.maxOpen ?? DEFAULT_MAX_OPEN_PARTITIONS;
  if (!Number.isInteger(maxOpen) || maxOpen < 1) {
    throw new Error(`maxOpen must be a positive integer (got ${String(options.maxOpen)})`);
  }

  const handles = new Map<string, UserPartitionHandle>();
  const opening = new Map<string, Promise<UserPartitionHandle>>();
  /**
   * Ids a caller asked to CLOSE while their open was still in flight.
   *
   * Without this, `close` found no registered handle, returned false, and the
   * pending open then registered anyway — leaving the partition open after an
   * explicit release request.
   */
  const pendingClose = new Set<string>();

  function evictOverflow(): void {
    while (handles.size > maxOpen) {
      const oldest = handles.entries().next();
      if (oldest.done === true) return;
      const [userId, handle] = oldest.value;
      handles.delete(userId);
      handle.db.close();
    }
  }

  async function openAndRegister(userId: string): Promise<UserPartitionHandle> {
    try {
      // An unlocked session hands the key in; otherwise the keychain answers (or
      // refuses, because the key is wrapped and nobody has signed in).
      const held = await options.keyFor?.(userId);
      const keyHex = held ?? (await ensureDbKey(keychain, dbKeyAccount(userId)));
      const dbPath = userDbPath(dataRoot, userId);
      const handle: UserPartitionHandle = {
        userId,
        dbPath,
        skillsDir: userSkillsDir(dataRoot, userId),
        db: openEncryptedDatabase(dbPath, keyHex),
      };
      // A close may have been requested WHILE this open was in flight. Honouring
      // it here is the whole point of the tombstone: registering regardless left
      // the partition OPEN after a close — the opposite of why this cache exists,
      // and it made releasing a signed-out user's database unreliable under a
      // race.
      if (pendingClose.has(userId)) {
        pendingClose.delete(userId);
        handle.db.close();
        return handle;
      }
      handles.set(userId, handle);
      evictOverflow();
      return handle;
    } finally {
      opening.delete(userId);
    }
  }

  function touch(userId: string, handle: UserPartitionHandle): void {
    // Re-insert to move this user to the most-recently-used end of the map.
    handles.delete(userId);
    handles.set(userId, handle);
  }

  return {
    dataRoot,
    async open(userId: string): Promise<UserPartitionHandle> {
      // Validating inside the async body makes a bad id a REJECTED promise
      // (and keeps `opening` free of ids that never opened).
      assertValidUserId(userId);
      // A fresh open cancels an earlier close: the user is signing back in, so
      // the tombstone must not close the handle we are about to hand out.
      pendingClose.delete(userId);
      const existing = handles.get(userId);
      if (existing !== undefined) {
        touch(userId, existing);
        return existing;
      }
      const inFlight = opening.get(userId);
      if (inFlight !== undefined) return inFlight;
      const promise = openAndRegister(userId);
      opening.set(userId, promise);
      return promise;
    },
    close(userId: string): boolean {
      const handle = handles.get(userId);
      if (handle !== undefined) {
        handles.delete(userId);
        pendingClose.delete(userId);
        handle.db.close();
        return true;
      }
      // No registered handle: either it never opened, or an open is IN FLIGHT.
      // In the latter case record the intent so the pending open closes what it
      // creates instead of registering it.
      if (opening.has(userId)) {
        pendingClose.add(userId);
        return true;
      }
      return false;
    },
    closeAll(): void {
      for (const handle of handles.values()) handle.db.close();
      handles.clear();
      // In-flight opens must also end closed, so tombstone everything still
      // opening rather than only what has registered.
      for (const userId of opening.keys()) pendingClose.add(userId);
    },
    openUserIds(): string[] {
      return [...handles.keys()];
    },
    get size(): number {
      return handles.size;
    },
  };
}
