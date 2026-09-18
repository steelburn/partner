/**
 * Per-user partition RAILS (M22/R1) — one core, N users, N databases.
 *
 * ## The problem this solves
 *
 * `createCore` builds ~40 stores over ONE database handle, and ~200 routes close
 * over them. Routing each request to a per-user database would mean rewriting
 * every route to look its stores up per request — a change big enough to be
 * dangerous, and one that has nothing to do with the feature.
 *
 * ## The shape used instead
 *
 * A user's partition is a **complete single-user core**: building one is the same
 * `createCore` call the single-user product makes, over that user's file, key and
 * skills directory. So "add users" becomes "build the app we already build, once
 * per user", and **not one route changes**. The listening app authenticates
 * (sessions live in the system DB, so they are shared) and then hands the request
 * to that user's own app — see `delegate` in `http/server.ts`.
 *
 * ## What is shared, and what is not
 *
 * | Shared (system DB) | Per user (their partition) |
 * |---|---|
 * | `users`, `user_credentials` | every store: notes, plans, memory, chat, attachments, assets, skills, grants, roots, themes, settings, spend, audit… |
 * | `sessions`, `pairings` | their own whole-file-encrypted `partner.db` |
 * | sign-in audit rows (operator-level) | their own `skills/` directory |
 *
 * That split is what makes "a query cannot cross users" structural rather than a
 * property of remembering to filter: two users never open the same database, so
 * there is no query to forget.
 *
 * ## Lifecycle
 *
 * Handles are bounded (`PARTITION_MAX_OPEN`, default 8) and evicted least-
 * recently-used first. A partition's **scheduler runs only while it is open**,
 * which is M20 §16's stated cost: a signed-in user's schedules fire, an absent
 * user's do not. `PARTITION_IDLE_MS` closes a partition that has been idle — R3:
 * the key material leaves memory; the next request re-opens it from the keychain,
 * which is stated plainly rather than dressed up as cryptographic re-locking.
 */
import type { Keychain } from '@partner/shared';
import type { CoreBundle, CoreConfig } from '../index.js';
import { createUserPartitions } from './partition.js';
import type { UserPartitions } from './partition.js';
import type { SystemStores } from './store.js';

/** Handles kept open by default, matching `partition.ts`. */
export const DEFAULT_PARTITION_MAX_OPEN = 8;

export interface UserRailsOptions {
  /** The boot config; database + skills paths are overridden per user. */
  config: CoreConfig;
  /** The system database's stores (users, credentials, sessions, pairings). */
  system: SystemStores;
  /** Holds every user's cipher key (`db-key:<id>`, one account each). */
  keychain: Keychain;
  /**
   * M20-B S9: the key vault. When present, opening a partition uses the key an
   * UNLOCKED session holds, and closing one locks it again — so "signed out"
   * really means "cannot be opened" rather than "should not be read".
   */
  vault?: {
    keyFor(userId: string): Promise<string | undefined>;
    lock(userId: string): boolean;
  };
  /**
   * Build one user's core from their partition. Injected by `index.ts` as
   * `createCore`, so this module has no import cycle with the boot path (and a
   * test can pass a spy).
   */
  build: (config: CoreConfig, db: unknown, system: SystemStores) => CoreBundle;
  /** Maximum open partitions before the least recently used is closed. */
  maxOpen?: number;
  /** Idle ms after which an open partition is closed (0 = never). R3. */
  idleMs?: number;
  /** Injectable clock (epoch ms). */
  now?: () => number;
}

interface RailEntry {
  userId: string;
  bundle: CoreBundle;
  lastUsedAt: number;
}

export interface UserRails {
  /**
   * The user's core, opening their partition if needed. `undefined` when the
   * partition cannot be opened — the HTTP layer answers 503 rather than ever
   * serving another user's data.
   */
  coreFor(userId: string): Promise<CoreBundle | undefined>;
  /** Close one partition now (shutdown, sign-out, eviction). */
  close(userId: string): boolean;
  closeAll(): void;
  /** Open user ids, least recently used first. */
  openUserIds(): string[];
  /** Drop partitions idle longer than `idleMs`; returns the ids closed. R3. */
  sweep(): string[];
  readonly size: number;
}

/**
 * One user's config: their own database file and skills directory.
 *
 * The paths come from the partition HANDLE (`users/partition.ts`, which derives
 * them with `users/paths.ts`), not from string building here, so there is exactly
 * one spelling of "where does this user's database live" — and the FIRST user
 * keeps the pre-partition database, so a hosted core that ran single-user does
 * not lose its data when partitions are switched on.
 */
export function partitionConfigFor(
  config: CoreConfig,
  userId: string,
  partition: { dbPath: string; skillsDir: string },
  /** M29: this account may use the deployment's published provider/search. */
  sharedAccess = false,
): CoreConfig {
  return { ...config, userId, dbPath: partition.dbPath, skillsDir: partition.skillsDir, sharedAccess };
}

export function createUserRails(options: UserRailsOptions): UserRails {
  const { config, system, keychain, build } = options;
  const maxOpen = options.maxOpen ?? config.partitionMaxOpen;
  const idleMs = options.idleMs ?? config.partitionIdleMs;
  const now = options.now ?? Date.now;

  const partitions: UserPartitions = createUserPartitions({
    dataRoot: config.dataRoot,
    keychain,
    maxOpen,
    ...(options.vault === undefined ? {} : { keyFor: (userId) => options.vault!.keyFor(userId) }),
  });

  /** userId → open rail, in LRU order (Map keeps insertion order). */
  const entries = new Map<string, RailEntry>();
  /** In-flight opens, so two concurrent requests never build two cores. */
  const pending = new Map<string, Promise<CoreBundle | undefined>>();

  function closeEntry(userId: string): boolean {
    const entry = entries.get(userId);
    if (entry === undefined) return false;
    entries.delete(userId);
    // The user's scheduler dies with their partition: an absent user's schedules
    // must not fire (M20 §16), and a tick against a closed handle would throw.
    entry.bundle.scheduler.stop();
    partitions.close(userId);
    // S9: the key goes with the session. Without this, closing the handle leaves
    // the key in memory for the next request to reuse.
    options.vault?.lock(userId);
    return true;
  }

  function evictIfNeeded(): void {
    while (entries.size > maxOpen) {
      const oldest = entries.keys().next();
      if (oldest.done === true) return;
      closeEntry(oldest.value);
    }
  }

  return {
    async coreFor(userId: string): Promise<CoreBundle | undefined> {
      const existing = entries.get(userId);
      if (existing !== undefined) {
        // S9: a key that has gone (signed out, idle-locked) takes the OPEN HANDLE
        // with it. A handle left open would keep decrypted pages in SQLite's
        // cache, so "the key is gone" would not actually mean unreadable.
        if (options.vault !== undefined && (await options.vault.keyFor(userId)) === undefined) {
          closeEntry(userId);
        } else {
          entries.delete(userId); // refresh recency
          existing.lastUsedAt = now();
          entries.set(userId, existing);
          return existing.bundle;
        }
      }
      const inFlight = pending.get(userId);
      if (inFlight !== undefined) return inFlight;

      const opening = partitions
        .open(userId)
        .then((handle) => {
          // M29: whether this account rides the deployment's published
          // provider/search configuration is read from the USER ROW at open
          // time, so an owner changing a member's access needs no restart.
          const sharedAccess = system.users.findById(userId)?.keyAccess === 'shared';
          const bundle = build(partitionConfigFor(config, userId, handle, sharedAccess), handle.db, system);
          bundle.scheduler.start();
          entries.set(userId, { userId, bundle, lastUsedAt: now() });
          evictIfNeeded();
          return bundle;
        })
        .catch(() => undefined) // the HTTP layer answers 503
        .finally(() => {
          pending.delete(userId);
        });
      pending.set(userId, opening);
      return opening;
    },

    close(userId: string): boolean {
      return closeEntry(userId);
    },

    closeAll(): void {
      for (const userId of [...entries.keys()]) closeEntry(userId);
      partitions.closeAll();
    },

    openUserIds(): string[] {
      return [...entries.keys()];
    },

    sweep(): string[] {
      if (idleMs <= 0) return [];
      const at = now();
      const closed: string[] = [];
      for (const [userId, entry] of [...entries]) {
        if (at - entry.lastUsedAt >= idleMs) {
          closeEntry(userId);
          closed.push(userId);
        }
      }
      return closed;
    },

    get size(): number {
      return entries.size;
    },
  };
}
