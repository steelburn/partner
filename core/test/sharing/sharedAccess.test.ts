/**
 * M29 — the deployment's shared access, unit level.
 *
 * The load-bearing property a route test cannot see: publishing writes the
 * non-secret config to the system database AND the secrets to the deployment
 * keychain under `shared-*` accounts, and REMOVING a provider/search provider
 * from a later publish actually deletes its key. A fallback that kept a revoked
 * key readable would make "unpublish" decorative.
 */
import { describe, expect, it } from 'vitest';
import { createKeychainFake } from '../../src/keychain/keychain.js';
import { openDatabase } from '../../src/stores/db.js';
import { createSystemStores } from '../../src/users/store.js';
import { createSharedAccess } from '../../src/sharing/sharedAccess.js';

const PROVIDER = {
  id: 'p1',
  name: 'Gateway',
  kind: 'openai-compatible' as const,
  source: 'manual' as const,
  purpose: 'general' as const,
  endpoint: 'https://api.example.invalid/v1',
  defaultModels: ['m1'],
  visionModels: [],
  enabled: true,
  budgetCents: null,
  createdAt: 1,
  updatedAt: 1,
};

function makeShared() {
  const db = openDatabase(':memory:');
  const keychain = createKeychainFake();
  return { shared: createSharedAccess({ store: createSystemStores(db).sharedAccess, keychain }), keychain };
}

describe('shared access', () => {
  it('publishes config + key, reads it back, and prunes a revoked provider key', async () => {
    const { shared, keychain } = makeShared();
    await shared.publish({
      providers: [{ config: PROVIDER, key: 'sk-shared' }],
      search: null,
      updatedBy: 'owner',
      at: 10,
    });
    expect(shared.providers()).toHaveLength(1);
    expect(shared.status()).toMatchObject({
      configured: true,
      providerCount: 1,
      searchConfigured: false,
      updatedAt: 10,
      updatedBy: 'owner',
    });
    expect(await shared.providerKey('p1')).toBe('sk-shared');

    // Publishing an EMPTY set revokes the key, so a member cannot keep using it.
    await shared.publish({ providers: [], search: null, at: 20 });
    expect(shared.providers()).toHaveLength(0);
    expect(await shared.providerKey('p1')).toBeNull();

    // …and clear() is the explicit panic path.
    await shared.publish({ providers: [{ config: PROVIDER, key: 'sk-shared' }], search: null });
    await shared.clear();
    expect(shared.status().configured).toBe(false);
    expect(await shared.providerKey('p1')).toBeNull();
    expect(keychain).toBeDefined();
  });

  it('publishes search config + keys, and drops a search key that is no longer published', async () => {
    const { shared } = makeShared();
    await shared.publish({
      providers: [],
      search: {
        config: { enabled: true, provider: 'brave', endpoints: { tavily: null, brave: null } },
        keys: { brave: 'brave-key' },
      },
    });
    expect(shared.search()).toMatchObject({ enabled: true, provider: 'brave' });
    expect(await shared.searchKey('brave')).toBe('brave-key');

    // A later publish of a different provider removes the old key.
    await shared.publish({
      providers: [],
      search: {
        config: { enabled: true, provider: 'tavily', endpoints: { tavily: null, brave: null } },
        keys: { tavily: 'tavily-key' },
      },
    });
    expect(await shared.searchKey('brave')).toBeNull();
    expect(await shared.searchKey('tavily')).toBe('tavily-key');
  });

  it('a disabled search config is not published at all', async () => {
    const { shared } = makeShared();
    await shared.publish({ providers: [], search: null });
    expect(shared.search()).toBeNull();
    expect(shared.status().searchConfigured).toBe(false);
  });
});
