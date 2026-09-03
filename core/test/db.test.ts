import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SCHEMA_VERSION } from '@partner/shared';
import {
  createAuditStore,
  createPairingStore,
  createSessionStore,
  createSettingsStore,
  openDatabase,
} from '../src/stores/db.js';

const EXPECTED_TABLES = ['pairings', 'sessions', 'audit_log', 'settings', 'meta'];

function tableNames(db: ReturnType<typeof openDatabase>): string[] {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all() as Array<{ name: string }>;
  return rows.map((r) => r.name);
}

describe('database schema', () => {
  it('creates every M0 table and records the schema version', () => {
    const db = openDatabase(':memory:');
    for (const table of EXPECTED_TABLES) expect(tableNames(db)).toContain(table);
    const meta = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version') as
      | { value: string }
      | undefined;
    expect(meta?.value).toBe(String(SCHEMA_VERSION));
    db.close();
  });

  it('is idempotent when a file DB is opened twice and creates parents', () => {
    const dir = mkdtempSync(join(tmpdir(), 'partner-core-db-'));
    const location = join(dir, 'nested', 'data.db');
    try {
      const first = openDatabase(location);
      expect(first.pragma('journal_mode', { simple: true })).toBe('wal');
      for (const table of EXPECTED_TABLES) expect(tableNames(first)).toContain(table);
      first.close();

      // Second open on the same file must not throw and must keep the data.
      const second = openDatabase(location);
      for (const table of EXPECTED_TABLES) expect(tableNames(second)).toContain(table);
      const meta = second.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version') as
        | { value: string }
        | undefined;
      expect(meta?.value).toBe(String(SCHEMA_VERSION));
      second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('row stores', () => {
  let db: ReturnType<typeof openDatabase>;
  beforeAll(() => {
    db = openDatabase(':memory:');
  });
  afterAll(() => db.close());

  it('settings round-trips and upserts updated_at', () => {
    const settings = createSettingsStore(db);
    expect(settings.get('missing')).toBeNull();
    settings.set('theme', 'paper', 100);
    expect(settings.get('theme')).toBe('paper');
    settings.set('theme', 'ink', 200);
    expect(settings.get('theme')).toBe('ink');
    const row = db.prepare('SELECT updated_at FROM settings WHERE key = ?').get('theme') as {
      updated_at: number;
    };
    expect(row.updated_at).toBe(200);
  });

  it('pairing store rows round-trip with hash + lock fields', () => {
    const pairings = createPairingStore(db);
    const id = pairings.insert('abc123hash', 1_000, 1_000 + 120_000);
    const row = pairings.findByCodeHash('abc123hash');
    expect(row).toMatchObject({ id, codeHash: 'abc123hash', attempts: 0, lockedUntil: null });
    pairings.updateAttempts(id, 3, 1_000 + 300_000);
    expect(pairings.getLatest()).toMatchObject({ id, attempts: 3, lockedUntil: 1_000 + 300_000 });
    pairings.removeByCodeHash('abc123hash');
    expect(pairings.findByCodeHash('abc123hash')).toBeUndefined();
    pairings.removeAll();
    expect(pairings.getLatest()).toBeUndefined();
  });

  it('session store rows round-trip with revocation', () => {
    const sessions = createSessionStore(db);
    sessions.insert('tokhash', 'web', '127.0.0.1:4390', 1_000, 1_000 + 60_000, 1_000);
    const row = sessions.findByTokenHash('tokhash');
    expect(row).toMatchObject({ kind: 'web', revokedAt: null });
    sessions.touch((row as NonNullable<typeof row>).id, 2_000);
    sessions.revoke((row as NonNullable<typeof row>).id, 3_000);
    expect(sessions.findByTokenHash('tokhash')).toMatchObject({
      lastSeenAt: 2_000,
      revokedAt: 3_000,
    });
  });

  it('audit store lists newest first and caps at limit', () => {
    const audit = createAuditStore(db);
    audit.add('a', 'first', 't', '{}', 100);
    audit.add('b', 'second', 't', '{}', 200);
    audit.add('c', 'third', 't', '{}', 300);
    const all = audit.list(10);
    expect(all.map((r) => r.action)).toEqual(['third', 'second', 'first']);
    expect(audit.list(2).map((r) => r.action)).toEqual(['third', 'second']);
  });
});
