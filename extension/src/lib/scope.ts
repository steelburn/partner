/**
 * Per-site scope resolution — PURE (no chrome/DOM; runs under vitest/node and
 * in the MV3 service worker/popup).
 *
 * Mirrors the core's scope manager (PLAN-M7.md, shared/src/browser.ts): the
 * core is the authoritative resolver; this module keeps the extension's
 * offline view and the popup's quick read honest.
 *
 *  - hostnames are normalised to lowercase;
 *  - a small built-in blocklist (banking/payments/password managers) is hard
 *    `off` — no stored scope can override it (mirrors the core's own rules;
 *    KEEP IN SYNC with the core's blocklist);
 *  - otherwise: stored scope wins, default is `ask`.
 *
 * The blocklist below is intentionally small and is duplicated inline from
 * the core's rule set — if it changes on the core side, change it here too.
 */

export type SiteScope = 'off' | 'ask' | 'read' | 'read+act' | 'trusted';

export const SITE_SCOPES: readonly SiteScope[] = ['off', 'ask', 'read', 'read+act', 'trusted'];

export const DEFAULT_SCOPE: SiteScope = 'ask';

export interface ResolvedPolicy {
  origin: string;
  scope: SiteScope;
  /** True when the built-in blocklist forbids any action regardless of scope. */
  blocked: boolean;
  reason: 'blocked_origin' | 'no_scope' | null;
}

/** Scope a user may pick for one origin. */
export type ScopeChoice = Exclude<SiteScope, 'trusted'>;

/** Human label used by the popup quick view. */
export function scopeLabel(scope: SiteScope): string {
  switch (scope) {
    case 'off':
      return 'Off';
    case 'ask':
      return 'Ask';
    case 'read':
      return 'Read';
    case 'read+act':
      return 'Read + act';
    case 'trusted':
      return 'Trusted';
  }
}

export function isSiteScope(value: unknown): value is SiteScope {
  return typeof value === 'string' && (SITE_SCOPES as readonly string[]).includes(value);
}

/**
 * Built-in hard-off origins (hostnames). Matches exact host or any subdomain
 * (e.g. `chase.com` also blocks `online.chase.com`). KEEP IN SYNC with the
 * core scope manager's blocklist (PLAN-M7.md: banking, payments, password
 * managers are blocked by default from any autonomous action).
 */
/**
 * Hard-off origins — MIRROR of core/src/browser/scopes.ts SITE_BLOCKLIST.
 * The CORE list is the single source of truth; keep this array byte-identical
 * (a root-level test asserts the sync). Entries may carry a leading '*.' for
 * readability; every entry matches its apex host and all subdomains.
 */
export const BLOCKED_HOSTS: readonly string[] = [
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

/** Strip a leading '*.' readability prefix. */
function blockSuffix(entry: string): string {
  return entry.startsWith('*.') ? entry.slice(2) : entry;
}

/** True when `hostname` is on the hard blocklist (self or any subdomain). */
export function isHostBlocked(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return BLOCKED_HOSTS.some((entry) => {
    const suffix = blockSuffix(entry);
    return host === suffix || host.endsWith(`.${suffix}`);
  });
}

/**
 * Extract the normalised (lowercased, port-stripped) hostname from a URL.
 * Returns null for unparsable URLs and non-http(s) schemes (chrome://,
 * about:, file://… cannot be scoped).
 */
export function hostOf(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  return parsed.hostname.toLowerCase();
}

function storedScopeFor(
  stored: Record<string, SiteScope>,
  host: string,
): { scope: SiteScope; fromStore: boolean } {
  const raw = stored[host];
  if (isSiteScope(raw)) return { scope: raw, fromStore: true };
  return { scope: DEFAULT_SCOPE, fromStore: false };
}

/**
 * Resolve the effective policy for a URL against stored scopes (extension-
 * side mirror of the core's scope manager).
 *
 * @param url    absolute page URL
 * @param stored record of user-chosen scopes keyed by normalised hostname
 */
export function resolveScopeForUrl(url: string, stored: Record<string, SiteScope>): ResolvedPolicy {
  const host = hostOf(url);
  if (host === null) {
    // Not a scoped surface (unparsable, chrome://, about:, …).
    return { origin: '', scope: 'off', blocked: false, reason: null };
  }
  if (isHostBlocked(host)) {
    return { origin: host, scope: 'off', blocked: true, reason: 'blocked_origin' };
  }
  const { scope, fromStore } = storedScopeFor(stored, host);
  return { origin: host, scope, blocked: false, reason: fromStore ? null : 'no_scope' };
}

/** Scopes that may send a full page capture / run page.analyze. */
export function canAct(scope: SiteScope): boolean {
  return scope === 'read+act' || scope === 'trusted';
}

/**
 * True when the resolved policy permits a full page capture + analysis.
 * Mirrors the core's page.capture/page.analyze policy (read+act/trusted →
 * ok; off/ask/read → denied; a blocked origin is always denied).
 */
export function decisionForCapture(policy: ResolvedPolicy): boolean {
  if (policy.blocked) return false;
  return canAct(policy.scope);
}
