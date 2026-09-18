/**
 * M29 — the invite store + manager, unit level.
 *
 * The HTTP lane proves the flow; this pins the two properties the flow depends
 * on and that a route test cannot isolate: the code is never stored (only its
 * SHA-256) and redemption is ONE conditional UPDATE, so two concurrent
 * redemptions of one code cannot both succeed.
 */
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/stores/db.js';
import { createSystemStores } from '../../src/users/store.js';
import { createInviteManager, inviteCodeHash } from '../../src/users/invites.js';

function store() {
  const db = openDatabase(':memory:');
  return createSystemStores(db).invites;
}

describe('invite manager', () => {
  it('stores only the hash, never the code, and resolves a live code', () => {
    const invites = createInviteManager({ store: store(), codeFactory: () => 'code-abc', now: () => 1_000 });
    const { code, invite } = invites.mint({ role: 'owner', keyAccess: 'own', createdBy: 'owner' });
    expect(code).toBe('code-abc');
    expect(invite.role).toBe('owner');
    expect(invite.keyAccess).toBe('own');
    // The row is what a database dump would show: a hash, no plaintext.
    expect(invite.codeHash).toBe(inviteCodeHash('code-abc'));
    expect(JSON.stringify(invite)).not.toContain('code-abc');

    const found = invites.find('code-abc');
    expect(found.ok).toBe(true);
    expect(invites.find('wrong')).toEqual({ ok: false, reason: 'unknown' });
  });

  it('is single use: a second consume loses the race', () => {
    const invites = createInviteManager({ store: store(), codeFactory: () => 'code-abc', now: () => 1_000 });
    const { invite } = invites.mint({});
    expect(invites.consume(invite.id, 'ama')).toBe(true);
    expect(invites.consume(invite.id, 'bo')).toBe(false);
    expect(invites.find('code-abc')).toEqual({ ok: false, reason: 'used' });
  });

  it('expires on the injected clock', () => {
    let now = 1_000;
    const invites = createInviteManager({
      store: store(),
      codeFactory: () => 'code-abc',
      now: () => now,
      ttlMs: 60_000,
    });
    invites.mint({});
    now += 60_001;
    // `find` is what the sign-up route checks before spending, so an expired
    // invite is refused there even though the store's consume is time-blind.
    expect(invites.find('code-abc')).toEqual({ ok: false, reason: 'expired' });
  });

  it('defaults a loopback operator mint to member + shared', () => {
    const invites = createInviteManager({ store: store(), codeFactory: () => 'code-abc' });
    const { invite } = invites.mint({});
    expect(invite.role).toBe('member');
    expect(invite.keyAccess).toBe('shared');
    expect(invite.createdBy).toBeNull();
  });
});
