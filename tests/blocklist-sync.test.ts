/**
 * M7 review fix: the extension's local blocklist MUST mirror the core's
 * SITE_BLOCKLIST exactly (single source of truth = core/src/browser/scopes.ts).
 * This test reads both sources and asserts the entry sets are identical, so
 * drift is caught the moment either side changes.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { SITE_BLOCKLIST } from '../core/src/browser/scopes.js';

function parseExtensionList(): string[] {
  const src = readFileSync(new URL('../extension/src/lib/scope.ts', import.meta.url), 'utf8');
  const match = src.match(/export const BLOCKED_HOSTS: readonly string\[\] = \[([\s\S]*?)\];/);
  expect(match, 'BLOCKED_HOSTS array literal not found in extension/src/lib/scope.ts').not.toBeNull();
  const body = (match as RegExpMatchArray)[1] as string;
  const entries = [...body.matchAll(/'([^']+)'/g)].map((m) => m[1] as string);
  return entries;
}

describe('blocklist single-source sync (M7)', () => {
  it('extension BLOCKED_HOSTS equals the core SITE_BLOCKLIST', () => {
    expect(new Set(parseExtensionList())).toEqual(new Set(SITE_BLOCKLIST));
    expect(parseExtensionList().length).toBe(SITE_BLOCKLIST.length);
  });
});
