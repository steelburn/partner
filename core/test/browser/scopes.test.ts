/**
 * M7 site-scope store + manager tests (PLAN-M7.md): the additive schema v8
 * site_scopes table (origin PK, scope default 'ask', updated_at stamping),
 * origin normalization, built-in blocklist precedence + immutability, CRUD
 * and the default-'ask' policy for unknown origins.
 */
import { describe, expect, it } from 'vitest';
import type { Database } from 'better-sqlite3';
import type { AuditRow } from '../../src/stores/types.js';
import {
  createSiteScopeManager,
  isBlockedHost,
  normalizeOrigin,
  SITE_BLOCKLIST,
  SITE_SCOPES,
} from '../../src/browser/scopes.js';
import { BrowserError, browserError } from '../../src/browser/errors.js';
import { createAuditStore, createSiteScopeStore, openDatabase } from '../../src/stores/db.js';
import { auditLog } from '../../src/services/redaction.js';

function tableNames(db: Database): string[] {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all() as Array<{ name: string }>;
  return rows.map((r) => r.name);
}

/** A real (in-memory) db with the scope store + audit wired like createCore. */
function scopeEnv(): {
  db: Database;
  store: ReturnType<typeof createSiteScopeStore>;
  auditRows: () => AuditRow[];
  manager: ReturnType<typeof createSiteScopeManager>;
} {
  const db = openDatabase(':memory:');
  const store = createSiteScopeStore(db);
  const audit = auditLog({ store: createAuditStore(db) });
  const manager = createSiteScopeManager({ store, audit });
  return {
    db,
    store,
    auditRows: () => createAuditStore(db).list(100),
    manager,
  };
}

describe('site_scopes schema + row store (schema v8)', () => {
  it('creates the additive site_scopes table with the origin PK + ask default', () => {
    const db = openDatabase(':memory:');
    try {
      expect(tableNames(db)).toContain('site_scopes');
      // The column default is 'ask' (a row inserted without a scope resolves ask).
      db.prepare("INSERT INTO site_scopes (origin, updated_at) VALUES ('raw.example', 5)").run();
      const row = db
        .prepare('SELECT origin, scope FROM site_scopes WHERE origin = ?')
        .get('raw.example') as { origin: string; scope: string };
      expect(row.scope).toBe('ask');
      // PK: re-inserting the same origin replaces rather than duplicating.
      db.prepare(
        "INSERT INTO site_scopes (origin, scope, updated_at) VALUES ('raw.example', 'trusted', 9) ON CONFLICT(origin) DO UPDATE SET scope = excluded.scope, updated_at = excluded.updated_at",
      ).run();
      const count = db.prepare('SELECT COUNT(*) AS n FROM site_scopes').get() as { n: number };
      expect(count.n).toBe(1);
    } finally {
      db.close();
    }
  });

  it('upserts on the origin PK, lists by origin and removes idempotently', () => {
    const env = scopeEnv();
    try {
      const { store } = env;
      store.upsert({ origin: 'zeta.example', scope: 'off', updatedAt: 100 });
      store.upsert({ origin: 'alpha.example', scope: 'read+act', updatedAt: 200 });
      // Conflict path: same origin keeps ONE row with the newest scope/time.
      store.upsert({ origin: 'zeta.example', scope: 'trusted', updatedAt: 300 });

      expect(store.findByOrigin('zeta.example')).toEqual({
        origin: 'zeta.example',
        scope: 'trusted',
        updatedAt: 300,
      });
      const rows = store.list();
      expect(rows.map((r) => r.origin)).toEqual(['alpha.example', 'zeta.example']);
      expect(rows[0]).toEqual({ origin: 'alpha.example', scope: 'read+act', updatedAt: 200 });

      store.remove('alpha.example');
      expect(store.findByOrigin('alpha.example')).toBeUndefined();
      store.remove('never-set.example'); // idempotent
    } finally {
      env.db.close();
    }
  });
});

describe('normalizeOrigin', () => {
  it('lowercases hostnames and drops scheme/path/query', () => {
    expect(normalizeOrigin('https://Example.COM/Path?x=1')).toBe('example.com');
    expect(normalizeOrigin('http://news.example/article')).toBe('news.example');
    expect(normalizeOrigin('news.example')).toBe('news.example');
    expect(normalizeOrigin('localhost:4390')).toBe('localhost:4390');
    expect(normalizeOrigin('https://localhost:4390/x')).toBe('localhost:4390');
  });

  it('keeps explicit non-default ports and drops default ports', () => {
    expect(normalizeOrigin('http://dev.internal:8080')).toBe('dev.internal:8080');
    expect(normalizeOrigin('https://example.com:443')).toBe('example.com');
    expect(normalizeOrigin('http://example.com:80')).toBe('example.com');
  });

  it('throws invalid_input for empty or unparseable origins', () => {
    expect(() => normalizeOrigin('')).toThrow(BrowserError);
    expect(() => normalizeOrigin('   ')).toThrow(BrowserError);
    expect(() => normalizeOrigin('::not-a-host::')).toThrow(BrowserError);
    expect(() => normalizeOrigin('http://')).toThrow(BrowserError);
    expect(browserError('not_found', 'x').code).toBe('not_found');
    expect(browserError('invalid_input', 'x').code).toBe('invalid_input');
  });
});

describe('built-in blocklist', () => {
  it('lists banking/payment/account patterns and matches apex + subdomains', () => {
    expect(SITE_BLOCKLIST.length).toBeGreaterThan(5);
    // PLAN-M7 named patterns are present.
    const joined = SITE_BLOCKLIST.join(' ');
    expect(joined).toContain('*.wellsfargo.com');
    expect(joined).toContain('paypal.com');
    expect(joined).toContain('accounts.google.com');
    expect(joined).toContain('appleid.apple.com');

    expect(isBlockedHost('wellsfargo.com')).toBe(true);
    expect(isBlockedHost('www.wellsfargo.com')).toBe(true);
    expect(isBlockedHost('banking.online.wellsfargo.com')).toBe(true);
    expect(isBlockedHost('paypal.com')).toBe(true);
    expect(isBlockedHost('www.paypal.com')).toBe(true);
    expect(isBlockedHost('accounts.google.com')).toBe(true);
    expect(isBlockedHost('appleid.apple.com')).toBe(true);
    // Suffix matching must not over-match unrelated hosts.
    expect(isBlockedHost('wellsfargo.com.evil.example')).toBe(false);
    expect(isBlockedHost('notwellsfargo.com')).toBe(false);
    expect(isBlockedHost('news.example')).toBe(false);
  });
});

describe('createSiteScopeManager', () => {
  it('resolves default ask, stored scope and blocklist precedence', () => {
    const env = scopeEnv();
    try {
      const m = env.manager;
      expect(m.policy('news.example')).toEqual({
        origin: 'news.example',
        scope: 'ask',
        blocked: false,
        reason: null,
      });

      const record = m.set('https://news.example/article', 'trusted');
      expect(record).toMatchObject({ origin: 'news.example', scope: 'trusted' });
      expect(record.updatedAt).toBeGreaterThan(0);
      expect(m.policy('news.example')).toEqual({
        origin: 'news.example',
        scope: 'trusted',
        blocked: false,
        reason: null,
      });

      // A blocked origin is immutable even when set() is attempted.
      expect(() => m.set('www.wellsfargo.com', 'trusted')).toThrow(BrowserError);
      expect(m.policy('https://www.wellsfargo.com/login')).toEqual({
        origin: 'www.wellsfargo.com',
        scope: 'off',
        blocked: true,
        reason: 'blocked_origin',
      });
    } finally {
      env.db.close();
    }
  });

  it('keeps the blocklist winning even when a stored scope exists', () => {
    const env = scopeEnv();
    try {
      // Write a row AROUND the manager (e.g. legacy data): policy must still
      // report the hard block — the blocklist is checked before the store.
      env.store.upsert({ origin: 'appleid.apple.com', scope: 'trusted', updatedAt: 1 });
      expect(env.manager.policy('appleid.apple.com')).toEqual({
        origin: 'appleid.apple.com',
        scope: 'off',
        blocked: true,
        reason: 'blocked_origin',
      });
    } finally {
      env.db.close();
    }
  });

  it('validates the scope union and refuses blocked mutation with not_found', () => {
    const env = scopeEnv();
    try {
      const m = env.manager;
      expect(() => m.set('news.example', 'super' as 'off')).toThrow(/scope must be one of/);
      expect(() => m.set('www.paypal.com', 'read')).toThrow(BrowserError);
      expect(() => m.clear('www.paypal.com')).toThrow(BrowserError);
      expect(() => m.clear('')).toThrow(BrowserError);
      // clear() on an ordinary unconfigured origin is an idempotent no-op.
      expect(() => m.clear('news.example')).not.toThrow();
    } finally {
      env.db.close();
    }
  });

  it('lists configured origins ascending and clears back to default', () => {
    const env = scopeEnv();
    try {
      const m = env.manager;
      m.set('b.example', 'read');
      m.set('a.example', 'off');
      expect(m.list().map((r) => r.origin)).toEqual(['a.example', 'b.example']);

      m.clear('a.example');
      expect(m.policy('a.example').scope).toBe('ask');
      expect(m.list().map((r) => r.origin)).toEqual(['b.example']);
    } finally {
      env.db.close();
    }
  });

  it('audits only ids/origins/scopes — never content', () => {
    const env = scopeEnv();
    try {
      const m = env.manager;
      m.set('example.com', 'read+act');
      m.clear('example.com');
      m.clear('never.example'); // no-op clear is not audited
      const rows = env.auditRows().map((r) => ({
        action: r.action,
        target: r.target,
        details: JSON.parse(r.details) as Record<string, unknown>,
      }));
      expect(rows).toHaveLength(2);
      const setRow = rows.find((r) => r.action === 'scope.set');
      const clearRow = rows.find((r) => r.action === 'scope.clear');
      expect(setRow).toEqual({ action: 'scope.set', target: 'example.com', details: { scope: 'read+act' } });
      expect(clearRow).toEqual({ action: 'scope.clear', target: 'example.com', details: {} });
      // A no-op clear (nothing stored) is not audited.
      m.clear('never.example');
      expect(env.auditRows()).toHaveLength(2);
    } finally {
      env.db.close();
    }
  });

  it('exposes the documented scope union', () => {
    expect(SITE_SCOPES).toEqual(['off', 'ask', 'read', 'read+act', 'trusted']);
  });
});
