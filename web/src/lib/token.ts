/**
 * Session-token persistence — the single chokepoint for the pairing token.
 *
 * M0 stores the token in localStorage because the SPA talks to the core
 * same-origin over the dev proxy / the loopback server. The token is never
 * logged, never rendered, and never sent anywhere except the Authorization
 * header of /v1/* calls (see lib/api.ts).
 */

import { readLocal, removeLocal, writeLocal } from './storage.js';

export const TOKEN_STORAGE_KEY = 'partner.token';

export function readStoredToken(): string | null {
  return readLocal(TOKEN_STORAGE_KEY);
}

/** Returns false when the browser refused to persist (e.g. private mode). */
export function storeToken(token: string): boolean {
  if (token.length === 0) return false;
  return writeLocal(TOKEN_STORAGE_KEY, token);
}

export function clearStoredToken(): void {
  removeLocal(TOKEN_STORAGE_KEY);
}
