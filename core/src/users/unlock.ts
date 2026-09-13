/**
 * The per-user key vault (M20-B S9) — when a partition key exists, and when it
 * does not.
 *
 * ## The three states of a user's partition key
 *
 * | state | where the key is | can the partition open? |
 * |---|---|---|
 * | **locked** (the default in login mode) | only inside the wrap in the system DB | no — not without the passphrase |
 * | **unlocked** (this session) | in this process's memory | yes |
 * | **kept unlocked** (explicit, audited, per user) | in the keychain, in plaintext | yes, even with nobody signed in |
 *
 * The third state is the one the plan describes as an *accepted, per-user* cost:
 * a user who wants their schedules to fire while they are away trades the
 * "signed out means unreadable" guarantee **for their own data only**.
 *
 * ## Lifecycle
 *
 * - **First sign-in after an upgrade** (`adopt`): the key is in the keychain from
 *   before this feature. It is wrapped under the presented passphrase and the
 *   plaintext is **removed** — otherwise the promise is decorative. Skipped for a
 *   user who has chosen to keep it unlocked.
 * - **Sign-in** (`unlock`): unwrap into memory. A wrong passphrase is `false`
 *   (GCM's tag check), and the partition stays closed.
 * - **Sign-out / idle** (`lock`): drop it from memory. The partition closes; the
 *   next request must sign in again.
 *
 * ## What this module deliberately does NOT do
 *
 * It does not authenticate. Proving the passphrase is `users/credentials.ts`; this
 * only decides whether a **key** is available. Keeping the two apart is what lets
 * the wrap use its own salt (so the stored verifier cannot unwrap it) without
 * duplicating the lockout logic.
 */
import type { Keychain } from '@partner/shared';
import { dbKeyAccount, ensureDbKey } from '../keychain/dbKey.js';
import { deriveWrappingKey, newWrapSalt, unwrapKeyHex, wrapKeyHex } from './keyWrap.js';
import type { KeyWrap } from './keyWrap.js';
import type { KeyWrapStore, UserStore } from '../stores/types.js';

export interface KeyVaultOptions {
  /** Holds the partition key when a user has chosen to keep it unlocked. */
  keychain: Keychain;
  /** Wrapped keys (system DB). */
  wraps: KeyWrapStore;
  /** Users, for the per-user `keepUnlocked` policy. */
  users: UserStore;
  /** Injectable clock (epoch ms). */
  now?: () => number;
}

export interface KeyVault {
  /**
   * Wrap this user's existing keychain key under their passphrase and drop the
   * plaintext. `true` when a wrap now exists (or already did).
   */
  adopt(userId: string, passphrase: string): Promise<boolean>;
  /** Unwrap into memory for this process. `false` on a wrong passphrase. */
  unlock(userId: string, passphrase: string): Promise<boolean>;
  /** Drop the in-memory key (sign-out, idle). Idempotent. */
  lock(userId: string): boolean;
  /** True while the key is held in memory. */
  isUnlocked(userId: string): boolean;
  /**
   * The key to open this user's partition with, or `undefined` when it is locked.
   * Resolves the kept-unlocked case from the keychain, and caches what it finds.
   */
  keyFor(userId: string): Promise<string | undefined>;
  /** True when a wrap exists (i.e. the key is protected by the passphrase). */
  hasWrap(userId: string): boolean;
  /** Users whose key is held in memory right now. */
  unlockedIds(): string[];
}

export function createKeyVault(options: KeyVaultOptions): KeyVault {
  const { keychain, wraps, users } = options;
  const now = options.now ?? Date.now;

  /** userId → partition key, ONLY while unlocked in this process. */
  const unlocked = new Map<string, string>();

  function store(userId: string, wrap: KeyWrap): void {
    const at = now();
    const existing = wraps.findByUser(userId);
    wraps.upsert({ userId, purpose: 'vault', ...wrap, createdAt: existing?.createdAt ?? at, updatedAt: at });
  }

  function keepUnlocked(userId: string): boolean {
    return users.findById(userId)?.keepUnlocked === true;
  }

  return {
    async adopt(userId: string, passphrase: string): Promise<boolean> {
      if (wraps.findByUser(userId) !== undefined) return true;
      // Ensure, don't just read: on a FRESH install the partition key does not
      // exist until someone opens the partition, and the first sign-in is exactly
      // when it must be created and wrapped (otherwise the plaintext would be
      // minted later, by the rails, and never protected).
      const plaintext = await ensureDbKey(keychain, dbKeyAccount(userId));
      const salt = newWrapSalt();
      const kek = await deriveWrappingKey(passphrase, salt);
      store(userId, wrapKeyHex(kek, plaintext, salt));
      // The plaintext goes away unless the user asked to keep it unlocked — the
      // whole point is that being signed out means being unreadable.
      if (!keepUnlocked(userId)) await keychain.delete('partner', dbKeyAccount(userId));
      unlocked.set(userId, plaintext);
      return true;
    },

    async unlock(userId: string, passphrase: string): Promise<boolean> {
      const row = wraps.findByUser(userId);
      if (row === undefined) {
        // No wrap: a pairing-mode install, or a user who keeps their key
        // unlocked. Either way the keychain answers (and may create the key).
        const key = await ensureDbKey(keychain, dbKeyAccount(userId));
        unlocked.set(userId, key);
        return true;
      }
      const kek = await deriveWrappingKey(passphrase, row.salt);
      const key = unwrapKeyHex(kek, row);
      if (key === null) return false;
      unlocked.set(userId, key);
      return true;
    },

    lock(userId: string): boolean {
      return unlocked.delete(userId);
    },

    isUnlocked(userId: string): boolean {
      return unlocked.has(userId);
    },

    async keyFor(userId: string): Promise<string | undefined> {
      const held = unlocked.get(userId);
      if (held !== undefined) return held;
      if (keepUnlocked(userId)) {
        const fromKeychain = await ensureDbKey(keychain, dbKeyAccount(userId));
        unlocked.set(userId, fromKeychain);
        return fromKeychain;
      }
      return undefined;
    },

    hasWrap(userId: string): boolean {
      return wraps.findByUser(userId) !== undefined;
    },

    unlockedIds(): string[] {
      return [...unlocked.keys()];
    },
  };
}
