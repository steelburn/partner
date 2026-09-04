/**
 * Grant manager tests (M2): add/list/hasGrant/remove + expiry respected with
 * an injectable clock; expired grants are hidden from list() and stop
 * authorizing without being deleted.
 */
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/stores/db.js';
import { createGrantStore } from '../../src/stores/db.js';
import { createGrantManager } from '../../src/broker/grants.js';
import type { GrantManager } from '../../src/broker/grants.js';
import type { ToolError } from '../../src/broker/errors.js';

function newManager(initialNow = 1_000_000): { manager: GrantManager; clock: { value: number } } {
  const clock = { value: initialNow };
  const db = openDatabase(':memory:');
  const manager = createGrantManager({
    store: createGrantStore(db),
    now: () => clock.value,
  });
  return { manager, clock };
}

describe('grant manager', () => {
  it('add persists a (tool, project) grant with source user and no expiry by default', () => {
    const { manager } = newManager();
    const grant = manager.add('files.list', 'root-1');
    expect(grant).toMatchObject({
      toolId: 'files.list',
      projectId: 'root-1',
      source: 'user',
      expiresAt: null,
    });
    expect(typeof grant.id).toBe('string');
    expect(manager.list()).toHaveLength(1);
    expect(manager.hasGrant('files.list', 'root-1')).toBe(true);
  });

  it('rejects empty ids and invalid ttl', () => {
    const { manager } = newManager();
    expect(() => manager.add('', 'root-1')).toThrowError(expect.objectContaining({ code: 'bad_params' }));
    expect(() => manager.add('files.list', '')).toThrowError(expect.objectContaining({ code: 'bad_params' }));
    expect(() => manager.add('files.list', 'root-1', { ttlMs: -5 })).toThrowError(
      expect.objectContaining({ code: 'bad_params' }),
    );
  });

  it('expiry is respected: hasGrant flips false and list hides the row', () => {
    const { manager, clock } = newManager(10_000);
    const grant = manager.add('files.read', 'root-1', { ttlMs: 5_000, note: 'session-scoped' });
    expect(grant.expiresAt).toBe(15_000);
    expect(grant.note).toBe('session-scoped');
    expect(manager.hasGrant('files.read', 'root-1')).toBe(true);

    clock.value = 15_000;
    expect(manager.hasGrant('files.read', 'root-1')).toBe(false); // expiry boundary
    expect(manager.list()).toHaveLength(0);

    clock.value = 20_000;
    expect(manager.hasGrant('files.read', 'root-1', 20_000)).toBe(false);
  });

  it('grants are scoped per (tool, project): no cross-tool or cross-project leakage', () => {
    const { manager } = newManager();
    manager.add('files.read', 'root-a');
    expect(manager.hasGrant('files.read', 'root-a')).toBe(true);
    expect(manager.hasGrant('files.read', 'root-b')).toBe(false);
    expect(manager.hasGrant('files.list', 'root-a')).toBe(false);
    expect(manager.hasGrant('files.delete', 'root-a')).toBe(false);
  });

  it('remove revokes and reports not_found for unknown ids', () => {
    const { manager } = newManager();
    const grant = manager.add('files.list', 'root-1');
    expect(manager.hasGrant('files.list', 'root-1')).toBe(true);
    manager.remove(grant.id);
    expect(manager.hasGrant('files.list', 'root-1')).toBe(false);
    expect(manager.list()).toHaveLength(0);

    try {
      manager.remove(grant.id);
      throw new Error('expected not_found');
    } catch (err) {
      expect((err as ToolError).code).toBe('not_found');
    }
  });
});
