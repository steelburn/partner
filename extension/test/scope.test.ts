import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SCOPE,
  SITE_SCOPES,
  canAct,
  decisionForCapture,
  hostOf,
  isHostBlocked,
  isSiteScope,
  resolveScopeForUrl,
  scopeLabel,
} from '../src/lib/scope.js';
import type { ResolvedPolicy, SiteScope } from '../src/lib/scope.js';

const EMPTY: Record<string, SiteScope> = {};

describe('resolveScopeForUrl', () => {
  it('defaults to ask for an unknown origin', () => {
    const p = resolveScopeForUrl('https://example.com/articles/1', EMPTY);
    expect(p).toEqual({ origin: 'example.com', scope: 'ask', blocked: false, reason: 'no_scope' });
  });

  it('applies a stored read+act scope', () => {
    const p = resolveScopeForUrl('https://example.com/x', { 'example.com': 'read+act' });
    expect(p).toEqual({ origin: 'example.com', scope: 'read+act', blocked: false, reason: null });
  });

  it('applies stored off', () => {
    const p = resolveScopeForUrl('https://quiet.example.org/', { 'quiet.example.org': 'off' });
    expect(p.scope).toBe('off');
    expect(p.blocked).toBe(false);
    expect(p.reason).toBeNull();
  });

  it('normalises hostname case in the URL', () => {
    const p = resolveScopeForUrl('HTTPS://Example.COM/Path', { 'example.com': 'read' });
    expect(p.origin).toBe('example.com');
    expect(p.scope).toBe('read');
  });

  it('normalises stored keys are matched on lowercase hostname', () => {
    expect(resolveScopeForUrl('https://Sub.Example.com/x', { 'sub.example.com': 'trusted' }).scope).toBe('trusted');
  });

  it('ignores stored values that are not valid scopes', () => {
    const p = resolveScopeForUrl('https://example.com/', { 'example.com': 'read-all-the-things' } as never);
    expect(p.scope).toBe(DEFAULT_SCOPE);
  });

  it('returns an unscoped off policy for non-http(s) and unparsable URLs', () => {
    for (const url of ['chrome://extensions/', 'about:blank', 'file:///etc/hosts', 'not a url']) {
      const p = resolveScopeForUrl(url, EMPTY);
      expect(p).toEqual({ origin: '', scope: 'off', blocked: false, reason: null });
    }
  });

  it('strips the port and ignores it for matching', () => {
    const p = resolveScopeForUrl('http://localhost:8080/app', EMPTY);
    expect(p.origin).toBe('localhost');
  });

  it('does not match subdomains across registrable boundary when no entry exists', () => {
    // something.example.com is NOT blocked by entry 'example.com'? It is a
    // subdomain — but only entries on the blocklist use suffix matching;
    // stored scopes are exact-host.
    const p = resolveScopeForUrl('https://app.example.com/', { 'example.com': 'read+act' });
    expect(p.scope).toBe('ask');
    expect(p.origin).toBe('app.example.com');
  });
});

describe('blocklist (built-in hard off)', () => {
  it('blocks known banking hosts regardless of stored scope', () => {
    for (const host of ['chase.com', 'bankofamerica.com', 'wellsfargo.com']) {
      const p = resolveScopeForUrl(`https://${host}/`, { [host]: 'read+act' });
      expect(p).toEqual({ origin: host, scope: 'off', blocked: true, reason: 'blocked_origin' });
    }
  });

  it('blocks subdomains of blocklisted hosts', () => {
    const p = resolveScopeForUrl('https://online.chase.com/login', { 'online.chase.com': 'trusted' });
    expect(p.blocked).toBe(true);
    expect(p.scope).toBe('off');
  });

  it('blocks payments and password managers', () => {
    expect(resolveScopeForUrl('https://www.paypal.com/', EMPTY).blocked).toBe(true);
    expect(resolveScopeForUrl('https://vault.bitwarden.com/', EMPTY).blocked).toBe(true);
  });

  it('blocklist is immovable even with trusted', () => {
    const p = resolveScopeForUrl('https://chase.com/', { 'chase.com': 'trusted' });
    expect(decisionForCapture(p)).toBe(false);
    expect(canAct('trusted')).toBe(true); // the scope itself is fine elsewhere
  });

  it('does not block lookalikes (exact suffix only)', () => {
    expect(isHostBlocked('notchase.com')).toBe(false);
    expect(isHostBlocked('chase.com.evil.test')).toBe(false);
  });

  it('case-normalises before block matching', () => {
    expect(isHostBlocked('CHASE.COM')).toBe(true);
    expect(resolveScopeForUrl('https://Chase.com/', EMPTY).blocked).toBe(true);
  });
});

describe('decisionForCapture / canAct', () => {
  it('truth table mirrors core page.capture policy', () => {
    const policy = (scope: SiteScope, blocked = false): ResolvedPolicy => ({
      origin: 'x.com',
      scope,
      blocked,
      reason: blocked ? 'blocked_origin' : null,
    });
    expect(decisionForCapture(policy('read+act'))).toBe(true);
    expect(decisionForCapture(policy('trusted'))).toBe(true);
    expect(decisionForCapture(policy('read'))).toBe(false);
    expect(decisionForCapture(policy('ask'))).toBe(false);
    expect(decisionForCapture(policy('off'))).toBe(false);
    expect(decisionForCapture(policy('read+act', true))).toBe(false);
  });

  it('canAct accepts only acting scopes', () => {
    expect(canAct('read+act')).toBe(true);
    expect(canAct('trusted')).toBe(true);
    expect(canAct('read')).toBe(false);
    expect(canAct('ask')).toBe(false);
    expect(canAct('off')).toBe(false);
  });

  it('hostOf returns null for unusable URLs', () => {
    expect(hostOf('https://Example.com:8443/a')).toBe('example.com');
    expect(hostOf('chrome://settings')).toBeNull();
    expect(hostOf('about:blank')).toBeNull();
    expect(hostOf('')).toBeNull();
  });
});

describe('scope vocabulary helpers', () => {
  it('enumerates the closed scope set in order', () => {
    expect(SITE_SCOPES).toEqual(['off', 'ask', 'read', 'read+act', 'trusted']);
  });

  it('isSiteScope validates values', () => {
    expect(isSiteScope('read+act')).toBe(true);
    expect(isSiteScope('Read+Act')).toBe(false);
    expect(isSiteScope(undefined)).toBe(false);
  });

  it('scopeLabel renders human labels', () => {
    expect(scopeLabel('read+act')).toBe('Read + act');
    expect(scopeLabel('off')).toBe('Off');
  });
});
