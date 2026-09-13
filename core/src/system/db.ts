/**
 * The SYSTEM database (PLAN-M20-B S2, §2a) — `data/system.db`.
 *
 * M20-B splits one SQLite file per OS user into one file per APP user
 * (`data/users/<userId>/partner.db`, see `users/partition.ts`). That split
 * cannot be total, because four tables have to be readable BEFORE a user is
 * resolved, and a per-user file is the wrong shape for all four:
 *
 *  - `users` — the list that resolves a user. Which file would hold it? The
 *    answer would have to precede the question, so it cannot live inside a
 *    per-user database.
 *  - `user_credentials` — the record that PROVES which user a request is.
 *    Same paradox: it is needed to open the partition it would live in.
 *  - `pairings` — enrollment happens before anyone has identified themselves
 *    (`POST /v1/pair`); the core must be able to pair with zero users.
 *  - `sessions` — a device record exists before (and without) an acting user.
 *
 * So these live in ONE small encrypted database at `<dataRoot>/system.db`,
 * opened with its OWN keychain key (account `system-key`). The key is separate
 * from every partition key on purpose: holding the system key must not open
 * anyone's partition, and a partition key must not open the user list.
 *
 * The system DB carries the SAME schema and SCHEMA_VERSION as a partition
 * (schemas are additive, one `applySchema`, one migration path). The four
 * pre-user tables are what actually lives in it; the rest are simply empty
 * there. Duplicating a narrowed schema would fork the migration surface and
 * the encryption/refusal matrix below, which is exactly the duplication that
 * makes a second database dangerous.
 *
 * `data/partner.db` does NOT move: the existing single-user layout stays user
 * #0's partition, byte-identical (PLAN-M20-B S2 "Legacy safety").
 */
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import type { Keychain } from '@partner/shared';
import { ensureDbKey } from '../keychain/dbKey.js';
import { openDatabase, openEncryptedDatabase } from '../stores/db.js';

/** File name of the system database under the data root. */
export const SYSTEM_DB_FILENAME = 'system.db';
/**
 * Keychain account holding the system DB's whole-file cipher key. Distinct
 * from the legacy `db-key` and from every `db-key:<userId>` partition account
 * (the keychain is namespaced by service+account, so this cannot collide).
 */
export const SYSTEM_KEY_ACCOUNT = 'system-key';

/** The system database path for a data root (`<dataRoot>/system.db`). */
export function systemDbPath(dataRoot: string): string {
  return join(dataRoot, SYSTEM_DB_FILENAME);
}

export interface OpenSystemDatabaseOptions {
  /** `<dataRoot>/system.db`, or ':memory:' for demo/unit runs. */
  location: string;
  /**
   * Holds (or receives) the system cipher key. Required for a file location:
   * a file database without a key would be plaintext user records + the
   * pairing/session tables.
   */
  keychain?: Keychain;
}

/**
 * Open (creating + keying on first use) the system database.
 *
 * - `':memory:'` opens plaintext in memory and needs NO keychain — the demo/
 *   test path, where nothing touches disk (the same rule `config.ts` applies
 *   to a demo `DB_PATH`: the in-memory fake keychain cannot protect a file).
 * - A file location is opened whole-file encrypted with the `system-key`
 *   keychain key, created on first use and reused after. The open reuses
 *   `openEncryptedDatabase`, so the refusal matrix is the partition one: a
 *   pre-M10 plaintext Partner DB is refused with a migration message, a wrong
 *   key is a clear error, and a re-open after a crash is safe.
 */
export async function openSystemDatabase(
  options: OpenSystemDatabaseOptions,
): Promise<Database.Database> {
  const { location, keychain } = options;
  if (location === ':memory:') return openDatabase(location);
  if (keychain === undefined) {
    throw new Error(
      `refusing to open the system database at ${location} without a keychain — ` +
        'the user list and the pairing/session tables must be encrypted at rest ' +
        "(pass DB_PATH=:memory: for a non-persistent run)",
    );
  }
  const keyHex = await ensureDbKey(keychain, SYSTEM_KEY_ACCOUNT);
  return openEncryptedDatabase(location, keyHex);
}
