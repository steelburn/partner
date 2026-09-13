/**
 * Per-app-user partition paths (PLAN-M20-B S1).
 *
 * M20.B generalizes today's per-OS-user isolation one level down: every app
 * user owns `<dataRoot>/users/<userId>/`, holding their own whole-file
 * encrypted database and their own installed-skill code. This module is PURE
 * — it derives paths and validates the id; it never touches the filesystem
 * (the cipher open in {@link ./partition.js} creates what it needs).
 *
 * The id is validated against a strict whitelist instead of being sanitized:
 * an id is either usable VERBATIM as one directory name under the users root,
 * or it is refused. Sanitizing would map two distinct ids onto one partition —
 * the exact failure that partitioning exists to prevent.
 */
import { join } from 'node:path';
import { LEGACY_USER_ID } from '@partner/shared';

/** Directory under the data root that holds every user's partition. */
export const USERS_DIRNAME = 'users';
/** Partition database file name (the same file name the legacy layout uses). */
export const PARTITION_DB_FILE = 'partner.db';
/** Partition directory holding installed skill code (env SKILLS_DIR target). */
export const PARTITION_SKILLS_DIRNAME = 'skills';
/** Longest accepted user id. */
export const MAX_USER_ID_LENGTH = 64;

/**
 * One directory name: letters/digits, then letters, digits, '.', '_' or '-'.
 * A leading alphanumeric rule rejects '.', '-' and '..' outright.
 */
const USER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Windows reserves these stems as device names, so a partition directory
 * called `con` would address the console device instead of a directory.
 */
const WINDOWS_RESERVED_NAMES = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  ...Array.from({ length: 9 }, (_unused, index) => `com${index + 1}`),
  ...Array.from({ length: 9 }, (_unused, index) => `lpt${index + 1}`),
]);

/** Raised for any id that is not usable verbatim as one partition directory. */
export class InvalidUserIdError extends Error {
  readonly userId: string;

  constructor(userId: string, reason: string) {
    super(`invalid user id ${JSON.stringify(userId)}: ${reason}`);
    this.name = 'InvalidUserIdError';
    this.userId = userId;
  }
}

/**
 * Assert that `userId` names exactly ONE directory under the users root.
 * Throws {@link InvalidUserIdError} (naming the refused id) otherwise.
 */
export function assertValidUserId(userId: unknown): asserts userId is string {
  if (typeof userId !== 'string') {
    throw new InvalidUserIdError(String(userId), 'must be a string');
  }
  if (userId.length === 0) throw new InvalidUserIdError(userId, 'must not be empty');
  if (userId.length > MAX_USER_ID_LENGTH) {
    throw new InvalidUserIdError(userId, `must be at most ${MAX_USER_ID_LENGTH} characters`);
  }
  if (userId.trim() !== userId) {
    throw new InvalidUserIdError(userId, 'must not have leading or trailing whitespace');
  }
  if (userId.includes('/') || userId.includes('\\')) {
    // Checked before the shape rule so the traversal shapes get a message
    // that names what is actually wrong.
    throw new InvalidUserIdError(userId, 'must not contain path separators');
  }
  if (userId.includes('..')) throw new InvalidUserIdError(userId, "must not contain '..'");
  if (userId.includes(':')) {
    throw new InvalidUserIdError(userId, 'must not contain a drive/stream separator');
  }
  if (!USER_ID_RE.test(userId)) {
    throw new InvalidUserIdError(
      userId,
      "must only contain letters, digits, '.', '_' and '-' and start with a letter or digit",
    );
  }
  if (userId.endsWith('.')) {
    // Windows silently strips trailing dots, so `alice` and `alice.` would
    // resolve to the same directory.
    throw new InvalidUserIdError(userId, 'must not end with a dot');
  }
  // Windows reserves the STEM, not the whole name: `con.txt` addresses the
  // console device just as `con` does, so checking the id alone lets device
  // names through whenever an extension is appended (measured: `con.txt`,
  // `nul.db`, `aux.partner`, `com1.bak` were all accepted).
  const stem = (userId.split('.')[0] ?? '').toLowerCase();
  if (WINDOWS_RESERVED_NAMES.has(stem)) {
    throw new InvalidUserIdError(userId, 'is a reserved Windows device name');
  }
}

/** The users tree itself (`<dataRoot>/users`) — every partition dir lives here. */
export function usersRoot(dataRoot: string): string {
  return join(dataRoot, USERS_DIRNAME);
}

/**
 * True for the user that owns the PRE-PARTITION layout (`<dataRoot>/partner.db`,
 * `<dataRoot>/skills`, legacy `db-key` account).
 *
 * M20-B's locked decision is that an existing install does not move, so this is
 * a deliberate back-compat carve-out: user #0's partition root is the data root
 * itself rather than `<dataRoot>/users/0/`.
 *
 * It is DETERMINISTIC rather than "alias only when the legacy file exists":
 * probing the filesystem would make a user's storage location depend on hidden
 * state, and would give a fresh install and an upgraded one different shapes for
 * the same user. Deterministic also means both converge on
 * `<dataRoot>/partner.db`, which is exactly what keeps an upgrade
 * byte-identical.
 */
export function isLegacyUser(userId: string): boolean {
  return userId === LEGACY_USER_ID;
}

/**
 * This user's partition directory.
 *
 * The legacy user's root IS `dataRoot` (the pre-partition layout); every other
 * user gets `<dataRoot>/users/<userId>`.
 */
export function userRoot(dataRoot: string, userId: string): string {
  assertValidUserId(userId);
  if (isLegacyUser(userId)) return dataRoot;
  return join(usersRoot(dataRoot), userId);
}

/**
 * This user's encrypted database file.
 *
 * For the legacy user this is `<dataRoot>/partner.db` — the pre-partition file
 * — so an existing install keeps its database where it already is.
 */
export function userDbPath(dataRoot: string, userId: string): string {
  return join(userRoot(dataRoot, userId), PARTITION_DB_FILE);
}

/**
 * This user's installed-skill code directory.
 *
 * For the legacy user this is `<dataRoot>/skills`, matching the historical
 * `skillsDir = dirname(dbPath)/skills` rule, so their installed skills are not
 * orphaned either.
 */
export function userSkillsDir(dataRoot: string, userId: string): string {
  return join(userRoot(dataRoot, userId), PARTITION_SKILLS_DIRNAME);
}
