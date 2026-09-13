/**
 * OS profile → app user key (PLAN-M20-B S2).
 *
 * A single-user install must keep today's experience: no sign-in, because the
 * OS profile already identifies who is holding the machine. The bridge is a
 * stable derived key — `users.os_profile_key` in the system DB — so "the OS
 * user who owns this core" can be looked up, and first run can create user #0
 * for them, without ever storing the OS account itself as the app user id.
 *
 * The key is the lowercased, trimmed login name. Case-folding is the point:
 * Windows and macOS resolve `Alice` and `alice` to one account, so mapping
 * them to two app users would silently split one person's data in two.
 *
 * Every read of the machine's own profile goes through
 * {@link currentOsProfileUsername}, and the callers that need to pin it (the
 * user manager, tests) take a `() => string` — so a test never depends on the
 * machine it runs on.
 */
import { userInfo } from 'node:os';

/**
 * The OS-profile key for a login name: trimmed, lowercased. Refuses an empty
 * name loudly instead of returning an empty key, because an empty key would
 * map EVERY profile to one app user (or create user #0 with no mapping at
 * all) — a silent merge where an error is the only safe outcome.
 */
export function osProfileKey(username: string): string {
  if (typeof username !== 'string') {
    throw new Error(`an OS profile key needs a login name, got ${typeof username}`);
  }
  const key = username.trim().toLowerCase();
  if (key === '') {
    throw new Error('an OS profile key cannot be derived from an empty login name');
  }
  return key;
}

/**
 * The login name of the account running this core. This is the injectable
 * seam: the manager takes a `() => string` of THIS shape (a raw login name)
 * and always derives the key through {@link osProfileKey}, so normalization
 * has exactly one spelling however it is wired.
 */
export function currentOsProfileUsername(): string {
  return userInfo().username;
}

/** The OS-profile key of the account running this core (`os.userInfo()`). */
export function currentOsProfileKey(): string {
  return osProfileKey(currentOsProfileUsername());
}
