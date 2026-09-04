/**
 * M7 site-scope manager (PLAN-M7.md).
 *
 * Per-origin consent for browser capture/action, resolved against a built-in
 * hard blocklist of banking / payment / account origins:
 *
 *   policy(origin) = blocklist match  -> { scope:'off', blocked:true,
 *                                          reason:'blocked_origin' }
 *                     stored row       -> { scope: stored, blocked:false,
 *                                          reason:null }
 *                     otherwise        -> { scope:'ask', blocked:false,
 *                                          reason:null }
 *
 * The blocklist is immutable BY CONSTRUCTION: mutations of a blocked origin
 * are refused with a typed BrowserError('not_found') and policy() consults
 * the blocklist BEFORE the store, so a stored row can never override a hard
 * block (defense in depth even if a row is written around the manager).
 *
 * Redaction discipline: origins are ids — page text never reaches the store,
 * audit rows or errors (the extension keeps page text in the browser).
 */
import type { ResolvedPolicy, SiteScope, SiteScopeRecord } from '@partner/shared';
import type { SiteScopeStore } from '../stores/types.js';
import type { AuditService } from '../services/redaction.js';
import { browserError } from './errors.js';

// ---------------------------------------------------------------------------
// Constants shared by the manager, the HTTP surface and the native session.
// ---------------------------------------------------------------------------

/** Every scope a user may assign, in least->most permissive order. */
export const SITE_SCOPES: readonly SiteScope[] = [
  'off',
  'ask',
  'read',
  'read+act',
  'trusted',
];

/** Scopes that permit page capture / analyze (the extension's main action). */
export const CAPTURE_SCOPES: readonly SiteScope[] = ['read+act', 'trusted'];

/**
 * Built-in hard-off origins: banking, payments and account/identity consoles.
 * Entries are host suffixes (a leading '*.' is allowed for readability but
 * every entry also matches its apex host) so `paypal.com` blocks
 * `www.paypal.com` and `*.wellsfargo.com` blocks `wellsfargo.com` too. No
 * stored scope can ever override an entry here — PLAN-M7 "blocked origins
 * immutable".
 */
export const SITE_BLOCKLIST: readonly string[] = [
  // Banking.
  '*.wellsfargo.com',
  '*.chase.com',
  '*.bankofamerica.com',
  '*.citibank.com',
  '*.usbank.com',
  '*.capitalone.com',
  // Payments.
  'paypal.com',
  '*.paypal.com',
  '*.stripe.com',
  '*.venmo.com',
  '*.coinbase.com',
  // Accounts / identity consoles.
  'accounts.google.com',
  'appleid.apple.com',
  'login.microsoftonline.com',
  'account.microsoft.com',
  'login.live.com',
];

function blockSuffix(entry: string): string {
  return entry.startsWith('*.') ? entry.slice(2) : entry;
}

/** True when a normalized host matches the built-in blocklist. */
export function isBlockedHost(host: string): boolean {
  const h = host.toLowerCase();
  return SITE_BLOCKLIST.some((entry) => {
    const suffix = blockSuffix(entry);
    return h === suffix || h.endsWith(`.${suffix}`);
  });
}

const DEFAULT_PORTS: Readonly<Record<string, number>> = { 'http:': 80, 'https:': 443 };

/**
 * Normalize a page URL or bare origin to the canonical stored origin:
 * lowercased hostname, plus the explicit port when one is present (so
 * loopback/dev origins like `localhost:4390` stay distinct). Scheme, path
 * and query are dropped — `https://Example.COM/a/b?x=1` and `example.com`
 * both resolve to `example.com`.
 *
 * Throws BrowserError('invalid_input') when nothing usable can be parsed.
 */
export function normalizeOrigin(input: string): string {
  const raw = String(input ?? '').trim();
  if (raw === '') {
    throw browserError('invalid_input', 'origin is required');
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
    // A bare `host:8080` parses as scheme `host:` with no hostname — retry.
    if (parsed.hostname === '') throw new Error('no hostname');
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('bad scheme');
  } catch {
    // An input that ALREADY declares a scheme but failed to parse (e.g.
    // "http://" with no host) is genuinely invalid — never reinterpret it.
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
      throw browserError('invalid_input', `origin is not a valid URL ("${raw.slice(0, 64)}")`);
    }
    try {
      parsed = new URL(`https://${raw}`);
    } catch {
      throw browserError('invalid_input', `origin is not a valid URL or host ("${raw.slice(0, 64)}")`);
    }
  }
  const hostname = parsed.hostname.toLowerCase();
  if (hostname === '') {
    throw browserError('invalid_input', `origin has no host ("${raw.slice(0, 64)}")`);
  }
  const port = parsed.port;
  if (port === '') return hostname;
  // A default port is redundant after the scheme is dropped.
  if (DEFAULT_PORTS[parsed.protocol] === Number(port)) return hostname;
  return `${hostname}:${port}`;
}

// ---------------------------------------------------------------------------
// Manager.
// ---------------------------------------------------------------------------

export interface SiteScopeManagerOptions {
  store: SiteScopeStore;
  audit: AuditService;
  /** Injectable clock (epoch ms). */
  now?: () => number;
}

export interface SiteScopeManager {
  /** Every configured (non-default) origin mapping, ascending by origin. */
  list(): SiteScopeRecord[];
  /**
   * Store a per-origin scope. invalid_input for a scope outside the union or
   * an unparseable origin; not_found when the origin is on the built-in
   * blocklist (hard-blocked origins are immutable).
   */
  set(origin: string, scope: SiteScope): SiteScopeRecord;
  /** Remove a mapping (back to the default 'ask'). Idempotent for ordinary
   *  origins; not_found for hard-blocked origins. */
  clear(origin: string): void;
  /**
   * Resolved policy for an origin: built-in blocklist wins over any stored
   * scope; otherwise the stored scope; otherwise the default 'ask'.
   */
  policy(origin: string): ResolvedPolicy;
}

export function createSiteScopeManager(
  options: SiteScopeManagerOptions,
): SiteScopeManager {
  const { store, audit } = options;
  const now = options.now ?? Date.now;

  function requireScope(scope: unknown): asserts scope is SiteScope {
    if (!SITE_SCOPES.includes(scope as SiteScope)) {
      throw browserError(
        'invalid_input',
        `scope must be one of ${SITE_SCOPES.join('|')} (got "${String(scope)}")`,
      );
    }
  }

  return {
    list(): SiteScopeRecord[] {
      return store.list();
    },

    set(origin: string, scope: SiteScope): SiteScopeRecord {
      const host = normalizeOrigin(origin);
      requireScope(scope);
      if (isBlockedHost(host)) {
        throw browserError(
          'not_found',
          'origin is on the built-in blocklist and cannot be configured',
        );
      }
      const at = now();
      store.upsert({ origin: host, scope, updatedAt: at });
      // Origins are ids — never page content (audit safe).
      audit.log('web', 'scope.set', host, { scope });
      return { origin: host, scope, updatedAt: at };
    },

    clear(origin: string): void {
      const host = normalizeOrigin(origin);
      if (isBlockedHost(host)) {
        throw browserError(
          'not_found',
          'origin is on the built-in blocklist and cannot be configured',
        );
      }
      const existed = store.findByOrigin(host) !== undefined;
      store.remove(host);
      if (existed) audit.log('web', 'scope.clear', host, {});
    },

    policy(origin: string): ResolvedPolicy {
      const host = normalizeOrigin(origin);
      if (isBlockedHost(host)) {
        // Blocklist FIRST — a stored row can never override a hard block.
        return { origin: host, scope: 'off', blocked: true, reason: 'blocked_origin' };
      }
      const row = store.findByOrigin(host);
      if (row) return { origin: host, scope: row.scope, blocked: false, reason: null };
      return { origin: host, scope: 'ask', blocked: false, reason: null };
    },
  };
}
