/**
 * Account rules shared by the core and the browser (M22 sign-up) — PURE.
 *
 * Why this is shared rather than duplicated: the SPA validates what a person
 * types *before* spending a request, and the core validates the same fields
 * again because a request is not a form. If those two disagree, the UI either
 * promises something the server refuses ("that name looks fine" → 400) or hides
 * a rule the server enforces, and the person sees a failure they cannot act on.
 * So the length/charset rules and their wording live here, once.
 *
 * The username is not decoration: a user is ALSO a partition directory
 * (`<dataRoot>/users/<id>/`, `core/src/users/paths.ts`) and the id is derived
 * from the name by slugging it. That is why the charset is narrow, why a name
 * that slugs to nothing is refused, and why the messages say what the name
 * becomes rather than just "invalid".
 */

/** Shortest passphrase an account may be created with. */
export const MIN_PASSPHRASE_LENGTH = 10;
/** Shortest and longest account name, in characters. */
export const MIN_USERNAME_LENGTH = 2;
export const MAX_USERNAME_LENGTH = 40;
/** Longest derived partition id (mirrors `MAX_USER_ID_LENGTH` in the core). */
export const MAX_ACCOUNT_ID_LENGTH = 64;

/**
 * Windows reserves these stems as device names, so a partition directory called
 * `con` would address the console device instead of a directory. Mirrors
 * `core/src/users/paths.ts` (the core refuses the id; this refuses the name
 * earlier, with a message a person can act on).
 */
const RESERVED_NAMES = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  ...Array.from({ length: 9 }, (_unused, index) => `com${index + 1}`),
  ...Array.from({ length: 9 }, (_unused, index) => `lpt${index + 1}`),
]);

/** The id charset a partition directory accepts, mirrored for early refusal. */
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** A refusal sentence, or `null` when the name is usable. */
export function usernameProblem(raw: string): string | null {
  const value = raw.trim();
  if (value.length < MIN_USERNAME_LENGTH) {
    return `Enter a name of at least ${MIN_USERNAME_LENGTH} characters.`;
  }
  if (value.length > MAX_USERNAME_LENGTH) {
    return `Keep the name to ${MAX_USERNAME_LENGTH} characters or fewer.`;
  }
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    return 'Use letters, digits, dots, dashes or underscores — the name becomes this account’s folder.';
  }
  const id = accountIdForUsername(value);
  if (RESERVED_NAMES.has(id)) {
    return `“${value}” is a name your operating system reserves. Pick another.`;
  }
  if (!isUsableAccountId(id)) {
    // Covers "nothing survived the slug" ('!!!') AND shapes that would not be a
    // usable partition directory ('...' slugs to dots, which `..` makes invalid).
    return 'Use at least one letter or digit, and no “..”, in the name — it becomes this account’s folder.';
  }
  return null;
}

/** A refusal sentence for a passphrase, or `null` when it is usable. */
export function passphraseProblem(value: string): string | null {
  if (value.trim().length === 0) return 'Enter a passphrase.';
  if (value.length < MIN_PASSPHRASE_LENGTH) {
    return `Use at least ${MIN_PASSPHRASE_LENGTH} characters. A phrase you can remember beats a short password.`;
  }
  return null;
}

/**
 * The partition id a name slugs to: lower case, one dash per run of characters
 * that cannot appear in a directory name, trimmed of dashes, capped at the id
 * limit. Mirrors `idFor()` in `docker/server/tools/user.mjs`, which is what the
 * operator CLI has always done — a name created either way lands on the same
 * kind of directory.
 *
 * Returns `''` when nothing survives (e.g. a name of only punctuation); callers
 * refuse that rather than inventing an id.
 */
export function accountIdForUsername(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_ACCOUNT_ID_LENGTH)
    .replace(/-+$/g, '');
}

/** True when `id` is usable verbatim as one partition directory name. */
export function isUsableAccountId(id: unknown): id is string {
  if (typeof id !== 'string' || id.length === 0 || id.length > MAX_ACCOUNT_ID_LENGTH) {
    return false;
  }
  if (!ID_RE.test(id) || id.includes('..') || id.includes(':')) return false;
  return !RESERVED_NAMES.has(id);
}
