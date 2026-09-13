/**
 * Which gate this core uses (M22) — cached, content-free UI metadata.
 *
 * A hosted core authenticates with a user login; the desktop core keeps the
 * pairing ceremony. Every "your session expired" surface has to name the action
 * the user will actually be offered, and those surfaces live far from the
 * `/v1/health` fetch (the audit view, the chat strip, the files view, the
 * provider panel). Rather than thread `authMode` through the whole component
 * tree, `PairGate` — the one place that fetches health — records the mode here.
 *
 * Storage holds ONE string, `'pairing' | 'login'`, and nothing else: no content,
 * no identity. It is on the storage allowlist for that reason (see
 * web/test/security-guards.test.ts). An absent or unrecognised value reads as
 * `pairing`, which is what an older core is.
 */
import { readLocal, writeLocal } from './storage.js';

export const AUTH_MODE_KEY = 'partner.authMode';

export type AuthMode = 'pairing' | 'login';

/** Remember what this core uses (called from the health probe in PairGate). */
export function rememberAuthMode(mode: AuthMode): void {
  writeLocal(AUTH_MODE_KEY, mode);
}

/** The cached mode; `pairing` when unknown (an older or unreachable core). */
export function cachedAuthMode(): AuthMode {
  return readLocal(AUTH_MODE_KEY) === 'login' ? 'login' : 'pairing';
}

/** What the user must do again: `Sign in again` or `Pair again`. */
export function sessionLostAction(): string {
  return cachedAuthMode() === 'login' ? 'Sign in again' : 'Pair again';
}

/** The full sentence, naming what the action gets them back to. */
export function sessionLostSentence(what: string): string {
  return `Your session with the Partner core has expired. ${sessionLostAction()} to ${what}.`;
}
