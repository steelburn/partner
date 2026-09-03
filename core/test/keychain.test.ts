import { describe, expect, it } from 'vitest';
import {
  createKeychainFake,
  createKeychainNative,
  KEYCHAIN_SERVICE,
} from '../src/keychain/keychain.js';

describe('keychainFake', () => {
  it('round-trips a secret per (service, account)', async () => {
    const kc = createKeychainFake();
    expect(await kc.get('svc', 'acct')).toBeNull();
    await kc.set('svc', 'acct', 's3cret');
    expect(await kc.get('svc', 'acct')).toBe('s3cret');
  });

  it('isolates accounts and services', async () => {
    const kc = createKeychainFake();
    await kc.set('svc', 'a', 'value-a');
    await kc.set('svc', 'b', 'value-b');
    await kc.set('other-svc', 'a', 'value-c');
    expect(await kc.get('svc', 'a')).toBe('value-a');
    expect(await kc.get('svc', 'b')).toBe('value-b');
    expect(await kc.get('other-svc', 'a')).toBe('value-c');
    await kc.set('svc', 'a', 'replaced');
    expect(await kc.get('svc', 'a')).toBe('replaced');
    expect(await kc.get('svc', 'b')).toBe('value-b'); // untouched
  });

  it('delete removes only the targeted secret; get returns null after', async () => {
    const kc = createKeychainFake();
    await kc.set('svc', 'acct', 'v');
    await kc.delete('svc', 'acct');
    expect(await kc.get('svc', 'acct')).toBeNull();
    // Deleting an absent secret is a no-op, not an error.
    await expect(kc.delete('svc', 'missing')).resolves.toBeUndefined();
  });

  it('two fakes never share state', async () => {
    const a = createKeychainFake();
    const b = createKeychainFake();
    await a.set('svc', 'acct', 'secret-a');
    expect(await b.get('svc', 'acct')).toBeNull();
  });
});

describe('keychainNative shape', () => {
  it('service constant is partner', () => {
    expect(KEYCHAIN_SERVICE).toBe('partner');
  });

  it('createKeychainNative returns the Keychain contract without touching storage', () => {
    const kc = createKeychainNative();
    expect(typeof kc.get).toBe('function');
    expect(typeof kc.set).toBe('function');
    expect(typeof kc.delete).toBe('function');
  });
});
