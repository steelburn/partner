/**
 * File-backed Keychain — the container/headless secret store (M21).
 *
 * WHY THIS EXISTS: live mode refuses to run without a keychain that can protect
 * a file database (`config.ts`), and the native keychain needs an OS keyring
 * daemon (libsecret / Keychain / DPAPI). A container has none, so a live core in
 * a container had exactly two options: refuse to boot, or run in demo mode with
 * an in-memory database — i.e. lose everything on restart. This is the third
 * option: a single JSON file, mounted on a volume, holding the same
 * `(service, account) → secret` map the native keychain holds.
 *
 * WHAT IT IS NOT: it is not isolation. The DB cipher key sits in the same volume
 * as the encrypted database, so it protects against a stolen/copied database
 * file and against backups — NOT against someone who can read the volume. The
 * native OS keychain is strictly better where one exists (hence `native` remains
 * the default); this kind is for deployments that have no keyring, and the file
 * must be treated as the crown jewel it is (0600, never in git, backed up
 * separately from nothing — losing it makes the database unreadable).
 *
 * FAIL-CLOSED RULES (each one is a data-loss guard):
 *  - A MISSING file is an empty store (first boot creates it on first write).
 *  - A MALFORMED file (bad JSON, a non-object, a non-string secret) THROWS. It
 *    is never "repaired" into an empty store: that would make `ensureDbKey`
 *    mint a fresh cipher key and leave the real database unopenable, which
 *    looks like silent data loss rather than a configuration error.
 *  - Writes are atomic (temp file in the same directory + rename), so a crash
 *    mid-write cannot truncate the only copy of the key material.
 *  - Writes are SERIALISED in-process: the HTTP routes, the scheduler and the
 *    brain can all store a secret concurrently, and read-modify-write on a file
 *    loses keys without it.
 *
 * SINGLE WRITER: one core per file. Two cores sharing a keychain file would each
 * keep their own in-memory copy and the last rename would win, dropping the
 * other's secrets. Nothing enforces it across processes; the deployment mounts
 * one file per core, and that is stated in the README.
 */
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Keychain } from '@partner/shared';

/**
 * Wrap a load failure with the FILE it came from. A boot that dies on a
 * malformed keychain file must name the path, or the operator is left guessing
 * which of several mounts is wrong.
 */
export function keychainFileError(cause: unknown, path: string): Error {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new Error(`keychain file ${path}: ${detail}`, { cause });
}

/** Read + validate the file. Throws on anything that is not the known shape. */
function loadStore(path: string): Record<string, Record<string, string>> {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (cause) {
    // Only "absent" is a legitimate empty store; EACCES and friends are not.
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw keychainFileError(cause, path);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw keychainFileError(new Error(`malformed JSON (${(cause as Error).message})`), path);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    // A bare array/string/number is not a store. Refuse rather than coerce.
    throw keychainFileError(new Error('content is not a JSON object'), path);
  }
  const store: Record<string, Record<string, string>> = {};
  for (const [service, accounts] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof accounts !== 'object' || accounts === null || Array.isArray(accounts)) {
      throw keychainFileError(new Error(`service "${service}" is not an object`), path);
    }
    const bucket: Record<string, string> = {};
    for (const [account, secret] of Object.entries(accounts as Record<string, unknown>)) {
      if (typeof secret !== 'string') {
        throw keychainFileError(
          new Error(`service "${service}" account "${account}" is not a string`),
          path,
        );
      }
      bucket[account] = secret;
    }
    store[service] = bucket;
  }
  return store;
}

/** Atomic, 0600, same-directory temp + rename. */
function persist(path: string, store: Record<string, Record<string, string>>): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = join(dirname(path), `.${randomBytes(6).toString('hex')}.keychain.tmp`);
  try {
    writeFileSync(temp, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
    renameSync(temp, path);
  } catch (cause) {
    // Never leave a half-written temp file behind on a failed write.
    try {
      unlinkSync(temp);
    } catch {
      /* the temp file may not exist; nothing to clean */
    }
    throw keychainFileError(cause, path);
  }
}

export function createKeychainFile(path: string): Keychain {
  if (typeof path !== 'string' || path.trim() === '') {
    throw new Error('keychain file path is required (KEYCHAIN_FILE)');
  }
  const store = loadStore(path);

  /**
   * Every mutation waits for the previous one. A plain await-free chain is the
   * whole mechanism: writers queue, each writes the state that includes all
   * earlier writes, and no read-modify-write can interleave.
   */
  let queue: Promise<void> = Promise.resolve();
  const enqueue = (mutate: () => void): Promise<void> => {
    const next = queue.then(() => {
      mutate();
      persist(path, store);
    });
    // Keep the chain alive after a failure (the caller still sees this one).
    queue = next.catch(() => undefined);
    return next;
  };

  return {
    async get(service, account) {
      return store[service]?.[account] ?? null;
    },
    async set(service, account, value) {
      await enqueue(() => {
        store[service] ??= {};
        store[service][account] = value;
      });
    },
    async delete(service, account) {
      // A no-op delete must not rewrite (and fsync) the file for nothing.
      if (store[service]?.[account] === undefined) return;
      await enqueue(() => {
        const bucket = store[service];
        if (bucket === undefined) return;
        delete bucket[account];
        if (Object.keys(bucket).length === 0) delete store[service];
      });
    },
  };
}
