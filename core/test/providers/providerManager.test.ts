/**
 * Provider manager tests (PLAN-M1): create/list/remove semantics, typed
 * errors, and the core security invariant — the key lives ONLY in the
 * keychain (service 'partner', account 'provider:<id>'); neither the DB row,
 * the summaries, nor any list() ever carries key material.
 */
import { describe, expect, it } from 'vitest';
import type { ProviderInput, ProviderSummary } from '@partner/shared';
import { openDatabase, createAuditStore, createProviderStore } from '../../src/stores/db.js';
import { createKeychainFake } from '../../src/keychain/keychain.js';
import { auditLog } from '../../src/services/redaction.js';
import { createProviderManager } from '../../src/providers/providerManager.js';
import { ProviderError } from '../../src/providers/errors.js';

const KEYCHAIN_SERVICE = 'partner';

function makeManager() {
  const db = openDatabase(':memory:');
  const keychain = createKeychainFake();
  const audit = auditLog({ store: createAuditStore(db) });
  const store = createProviderStore(db);
  const manager = createProviderManager({ store, keychain, audit });
  return { db, store, keychain, audit, manager };
}

function input(overrides: Partial<ProviderInput> = {}): ProviderInput {
  return { name: 'My provider', endpoint: 'https://api.ne1.dev/v1', ...overrides };
}

async function expectProviderError(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toSatisfy((err: unknown) => err instanceof ProviderError && (err as ProviderError).code === code);
}

describe('create + list', () => {
  it('creates a summary matching the shared ProviderSummary shape with NO key fields', async () => {
    const { manager, keychain, audit } = makeManager();
    const summary = await manager.create(input());
    expect(summary.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(summary).toMatchObject({
      name: 'My provider',
      kind: 'openai-compatible',
      source: 'manual',
      endpoint: 'https://api.ne1.dev/v1',
      defaultModels: [],
      enabled: true,
      budgetCents: null,
      health: { ok: false, latencyMs: null, error: null, models: [], checkedAt: null },
    });
    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain('keyRef');
    expect(serialized).not.toContain('key"');
    expect(serialized).not.toContain('sk-');
    // Nothing is in the keychain yet — the key is only ever set explicitly.
    await expect(keychain.get(KEYCHAIN_SERVICE, `provider:${summary.id}`)).resolves.toBeNull();
    // Every sensitive action is audited.
    expect(audit.list(10).some((r) => r.action === 'provider.create')).toBe(true);
  });

  it('normalizes the endpoint (trim + ONE trailing slash) and maps options', async () => {
    const { manager } = makeManager();
    const summary = await manager.create(
      input({ name: 'trailing', endpoint: '  https://api.ne1.dev/v1/  ', defaultModels: ['gpt-4o'], budgetCents: 500, enabled: false }),
    );
    expect(summary.endpoint).toBe('https://api.ne1.dev/v1');
    expect(summary.defaultModels).toEqual(['gpt-4o']);
    expect(summary.budgetCents).toBe(500);
    expect(summary.enabled).toBe(false);
  });

  it('rejects an unsupported kind with a typed invalid_kind error', async () => {
    const { manager } = makeManager();
    await expectProviderError(
      manager.create(input({ kind: 'anthropic' as ProviderInput['kind'] })),
      'invalid_kind',
    );
  });

  it('rejects a bad endpoint with a typed invalid_endpoint error', async () => {
    const { manager } = makeManager();
    await expectProviderError(manager.create(input({ endpoint: 'not-a-url' })), 'invalid_endpoint');
    await expectProviderError(manager.create(input({ endpoint: 'ftp://x/v1' })), 'invalid_endpoint');
    await expectProviderError(manager.create(input({ endpoint: '' })), 'invalid_endpoint');
    await expectProviderError(manager.create(input({ endpoint: '   ' })), 'invalid_endpoint');
  });

  it('rejects a missing name and a negative budget with invalid_input', async () => {
    const { manager } = makeManager();
    await expectProviderError(manager.create(input({ name: '  ' })), 'invalid_input');
    await expectProviderError(manager.create(input({ budgetCents: -1 })), 'invalid_input');
  });

  it('list() returns every provider in creation order, never the keyRef', async () => {
    const { manager } = makeManager();
    const first = await manager.create(input({ name: 'A', endpoint: 'https://a.example/v1' }));
    const second = await manager.create(input({ name: 'B', endpoint: 'https://b.example/v1' }));
    const listed = manager.list();
    expect(listed.map((p) => p.id)).toEqual([first.id, second.id]);
    expect(JSON.stringify(listed)).not.toContain('keyRef');
    expect(JSON.stringify(listed)).not.toContain('key"');
    expect(manager.get(first.id)?.name).toBe('A');
    expect(manager.get('nope')).toBeNull();
  });
});

describe('key lifecycle (keychain only)', () => {
  it('setKey stores ONLY in the keychain; the DB row and summaries never carry the key', async () => {
    const { db, manager, keychain, store } = makeManager();
    const summary = await manager.create(input());
    const key = 'sk-live-abcdef123456';

    await manager.setKey(summary.id, key);

    await expect(keychain.get(KEYCHAIN_SERVICE, `provider:${summary.id}`)).resolves.toBe(key);
    await expect(manager.getKey(summary.id)).resolves.toBe(key);
    const row = store.findById(summary.id) as NonNullable<ReturnType<typeof store.findById>>;
    expect(JSON.stringify(row)).not.toContain(key);
    expect(JSON.stringify(row)).not.toContain('sk-');
    // keyRef is the provider id (the keychain account base), never the secret.
    expect(row.keyRef).toBe(summary.id);
    expect(JSON.stringify(manager.list())).not.toContain(key);
    expect(JSON.stringify(manager.get(summary.id))).not.toContain(key);

    // The audit row for set_key must not contain the key either.
    const rows = db.prepare('SELECT details FROM audit_log WHERE action = ?').all('provider.set_key') as Array<{
      details: string;
    }>;
    expect(rows.length).toBe(1);
    expect(rows[0]?.details).not.toContain('sk-');
    expect(rows[0]?.details).not.toContain('abcdef');
  });

  it('setKey rotates: the old keychain entry is replaced, the DB is untouched', async () => {
    const { manager, keychain } = makeManager();
    const summary = await manager.create(input());
    await manager.setKey(summary.id, 'sk-rotate-old-111111');
    await manager.setKey(summary.id, 'sk-rotate-new-222222');
    await expect(keychain.get(KEYCHAIN_SERVICE, `provider:${summary.id}`)).resolves.toBe(
      'sk-rotate-new-222222',
    );
  });

  it('getKey returns null when no key was ever set', async () => {
    const { manager } = makeManager();
    const summary = await manager.create(input());
    await expect(manager.getKey(summary.id)).resolves.toBeNull();
  });

  it('setKey on an unknown provider throws not_found; empty key throws invalid_input', async () => {
    const { manager } = makeManager();
    const summary = await manager.create(input());
    await expectProviderError(manager.setKey('missing-id', 'sk-x-12345678'), 'not_found');
    await expectProviderError(manager.setKey(summary.id, ''), 'invalid_input');
  });
});

describe('remove', () => {
  it('deletes the row AND the keychain entry and audits the delete', async () => {
    const { manager, keychain, audit } = makeManager();
    const summary = await manager.create(input());
    await manager.setKey(summary.id, 'sk-remove-me-123456');
    await manager.remove(summary.id);

    expect(manager.get(summary.id)).toBeNull();
    expect(manager.list()).toHaveLength(0);
    await expect(keychain.get(KEYCHAIN_SERVICE, `provider:${summary.id}`)).resolves.toBeNull();
    expect(audit.list(10).some((r) => r.action === 'provider.delete')).toBe(true);
  });

  it('remove on an unknown provider throws not_found', async () => {
    const { manager } = makeManager();
    await expectProviderError(manager.remove('missing-id'), 'not_found');
  });
});

describe('summary hygiene', () => {
  it('summaries expose only the shared ProviderSummary fields (typed round-trip)', async () => {
    const { manager } = makeManager();
    const created = await manager.create(input({ defaultModels: ['gpt-4o'] }));
    const listed = manager.list();
    const typed: ProviderSummary[] = listed; // compile-time shape check
    expect(typed[0]?.id).toBe(created.id);
    const keys = Object.keys(listed[0] ?? {}).sort();
    expect(keys).toEqual(
      [
        'id',
        'name',
        'kind',
        'source',
        'purpose',
        'endpoint',
        'defaultModels',
        'visionModels',
        'enabled',
        'budgetCents',
        'createdAt',
        'updatedAt',
        'health',
      ].sort(),
    );
  });

  it('defaults purpose to general and validates unknown purposes', async () => {
    const { manager } = makeManager();
    const plain = await manager.create(input({}));
    expect(plain.purpose).toBe('general');

    const coding = await manager.create(input({ purpose: 'coding' }));
    expect(coding.purpose).toBe('coding');
    expect(manager.list().some((p) => p.id === coding.id && p.purpose === 'coding')).toBe(true);

    // Unknown purpose degrades to the default rather than throwing.
    const bogus = (await manager.create(input({ purpose: 'hype' as 'coding' }))) as ProviderSummary;
    expect(bogus.purpose).toBe('general');
  });
});

/**
 * M24 — the vision declaration. An OpenAI-compatible gateway's model ids are
 * operator-chosen aliases, so whether one can read a photo is a fact about the
 * user's setup that only the user can state; the manager stores that statement
 * and lets it be edited on a profile that already works.
 */
describe('vision declarations (M24)', () => {
  it('stores and round-trips declared image-capable models', async () => {
    const { manager, store } = makeManager();
    const summary = await manager.create(
      input({ defaultModels: ['alias-1', 'alias-2'], visionModels: ['alias-2'] }),
    );
    expect(summary.visionModels).toEqual(['alias-2']);
    expect(manager.get(summary.id)?.visionModels).toEqual(['alias-2']);
    // Stored as JSON on its own column, not folded into default_models.
    const row = store.findById(summary.id);
    expect(JSON.parse(row?.defaultModels ?? '[]')).toEqual(['alias-1', 'alias-2']);
    expect(JSON.parse(row?.visionModels ?? '[]')).toEqual(['alias-2']);
  });

  it('defaults to nothing declared (an upgrade must not invent capability)', async () => {
    const { manager } = makeManager();
    const summary = await manager.create(input({ defaultModels: ['gpt-4o'] }));
    expect(summary.visionModels).toEqual([]);
  });

  it('trims, de-duplicates and drops blanks in a declaration', async () => {
    const { manager } = makeManager();
    const summary = await manager.create(
      input({ visionModels: ['  a ', 'a', '', '   ', 'b'] }),
    );
    expect(summary.visionModels).toEqual(['a', 'b']);
  });

  it('refuses a non-array / non-string visionModels', async () => {
    const { manager } = makeManager();
    await expectProviderError(
      manager.create(input({ visionModels: 'gpt-4o' as unknown as string[] })),
      'invalid_input',
    );
    await expectProviderError(
      manager.create(input({ visionModels: [1, 2] as unknown as string[] })),
      'invalid_input',
    );
  });

  it('update edits the declaration in place, leaving the rest alone', async () => {
    const { manager, keychain } = makeManager();
    const created = await manager.create(
      input({ name: 'Keep me', defaultModels: ['alias-1'], purpose: 'general' }),
    );
    await manager.setKey(created.id, 'sk-declare-me-123456');

    const updated = manager.update(created.id, { visionModels: ['alias-1'] });
    expect(updated).toMatchObject({
      name: 'Keep me',
      purpose: 'general',
      endpoint: 'https://api.ne1.dev/v1',
      defaultModels: ['alias-1'],
      visionModels: ['alias-1'],
      enabled: true,
    });
    // The key was never touched, and never surfaces on the summary.
    await expect(keychain.get(KEYCHAIN_SERVICE, `provider:${created.id}`)).resolves.toBe(
      'sk-declare-me-123456',
    );
    expect(JSON.stringify(updated)).not.toContain('sk-');
  });

  it('update can clear the declaration with an empty list', async () => {
    const { manager, store } = makeManager();
    const created = await manager.create(input({ visionModels: ['alias-1'] }));
    expect(manager.update(created.id, { visionModels: [] }).visionModels).toEqual([]);
    // Cleared means NULL on the row, the same shape as "never declared".
    expect(store.findById(created.id)?.visionModels).toBeNull();
  });

  it('update is a no-op returning the current summary when nothing is given', async () => {
    const { manager, audit } = makeManager();
    const created = await manager.create(input({ visionModels: ['alias-1'] }));
    const same = manager.update(created.id, {});
    expect(same.updatedAt).toBe(created.updatedAt);
    expect(
      audit.list(10).some((r) => r.action === 'provider.update'),
    ).toBe(false);
  });

  it('update validates each field and refuses an unknown purpose or bad budget', async () => {
    const { manager } = makeManager();
    const created = await manager.create(input());
    expect(() => manager.update('missing', { name: 'x' })).toThrow(ProviderError);
    expect(() => manager.update(created.id, { purpose: 'hype' as 'coding' })).toThrow();
    expect(() => manager.update(created.id, { budgetCents: -1 })).toThrow();
    expect(() => manager.update(created.id, { name: '   ' })).toThrow();
    expect(() =>
      manager.update(created.id, { visionModels: ['ok', 7 as unknown as string] }),
    ).toThrow();
    // Nothing landed: the row is still what create made it.
    expect(manager.get(created.id)).toMatchObject({ name: 'My provider', visionModels: [] });
  });

  it('update records the declaration count in audit, never model ids', async () => {
    const { manager, audit } = makeManager();
    const created = await manager.create(input());
    manager.update(created.id, { visionModels: ['secret-alias-name'] });
    const row = audit.list(10).find((r) => r.action === 'provider.vision_declared');
    expect(row).toBeDefined();
    expect(String(row?.details)).toContain('"count":1');
    expect(JSON.stringify(audit.list(10))).not.toContain('secret-alias-name');
  });
});
