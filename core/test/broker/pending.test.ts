/**
 * Pending-approval queue manager tests (M2): enqueue/list/get; decide closes
 * the row with approve/deny; approve + remember creates a grant through the
 * injected callback; double decisions are rejected.
 */
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/stores/db.js';
import { createPendingToolStore } from '../../src/stores/db.js';
import { createPendingManager } from '../../src/broker/pending.js';
import type { PendingManager } from '../../src/broker/pending.js';
import type { ToolError } from '../../src/broker/errors.js';

function newManager(): {
  manager: PendingManager;
  createdGrants: Array<{ toolId: string; projectId: string; note?: string }>;
} {
  const db = openDatabase(':memory:');
  const createdGrants: Array<{ toolId: string; projectId: string; note?: string }> = [];
  const manager = createPendingManager({
    store: createPendingToolStore(db),
    onCreateGrant: (row, note) => {
      createdGrants.push({ toolId: row.toolId, projectId: row.projectId ?? '', note });
      return `grant-${createdGrants.length}`;
    },
  });
  return { manager, createdGrants };
}

describe('pending manager', () => {
  it('enqueue opens a queue row and list returns it parsed', () => {
    const { manager } = newManager();
    const id = manager.enqueue({
      toolId: 'files.edit',
      projectId: 'root-1',
      params: { projectId: 'root-1', path: 'a.txt', proposedContent: 'new' },
      risk: 'medium',
      requestedBy: 'web',
    });
    expect(id).toBeTruthy();
    const open = manager.list();
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({
      id,
      toolId: 'files.edit',
      risk: 'medium',
      requestedBy: 'web',
      params: { projectId: 'root-1', path: 'a.txt', proposedContent: 'new' },
    });
  });

  it('enqueue validates ids and params object-ness', () => {
    const { manager } = newManager();
    expect(() =>
      manager.enqueue({
        toolId: '',
        projectId: 'root-1',
        params: {},
        risk: 'low',
        requestedBy: 'web',
      }),
    ).toThrowError(expect.objectContaining({ code: 'bad_params' }));
    expect(() =>
      manager.enqueue({
        toolId: 'files.list',
        projectId: 'root-1',
        params: 'nope' as unknown as Record<string, unknown>,
        risk: 'low',
        requestedBy: 'web',
      }),
    ).toThrowError(expect.objectContaining({ code: 'bad_params' }));
  });

  it('M12: external rows may enqueue without a project and carry conversation/persona ids', () => {
    const { manager } = newManager();
    const id = manager.enqueue({
      toolId: 'search',
      projectId: '',
      params: { query: 'ces news' },
      risk: 'medium',
      requestedBy: 'persona',
      conversationId: 'conv-1',
      personaId: 'p-default',
    });
    const row = manager.get(id);
    expect(row).toMatchObject({
      id,
      toolId: 'search',
      projectId: '',
      requestedBy: 'persona',
      conversationId: 'conv-1',
      personaId: 'p-default',
      decidedAt: null,
    });
    // Omitted ids default to null (broker rows stay unchanged).
    const plain = manager.get(
      manager.enqueue({
        toolId: 'files.list',
        projectId: 'root-1',
        params: {},
        risk: 'low',
        requestedBy: 'web',
      }),
    );
    expect(plain?.conversationId).toBeNull();
    expect(plain?.personaId).toBeNull();
  });

  it('decide with approve + remember creates a grant via the callback', () => {
    const { manager, createdGrants } = newManager();
    const id = manager.enqueue({
      toolId: 'files.edit',
      projectId: 'root-1',
      params: {},
      risk: 'medium',
      requestedBy: 'web',
    });
    const result = manager.decide(id, { decision: 'approve', remember: true, note: 'ok' }, 'web');
    expect(result.grantId).toBe('grant-1');
    expect(result.row.decision).toBe('approve');
    expect(result.row.decidedAt).toBeGreaterThan(0);
    expect(createdGrants).toEqual([{ toolId: 'files.edit', projectId: 'root-1', note: 'ok' }]);
    expect(manager.list()).toHaveLength(0); // closed rows leave the queue
  });

  it('approve WITHOUT remember closes the row but creates no grant', () => {
    const { manager, createdGrants } = newManager();
    const id = manager.enqueue({
      toolId: 'files.read',
      projectId: 'root-1',
      params: {},
      risk: 'low',
      requestedBy: 'web',
    });
    const result = manager.decide(id, { decision: 'approve' }, 'web');
    expect(result.grantId).toBeNull();
    expect(createdGrants).toHaveLength(0);
  });

  it('deny closes the row and never touches grants', () => {
    const { manager, createdGrants } = newManager();
    const id = manager.enqueue({
      toolId: 'files.delete',
      projectId: 'root-1',
      params: {},
      risk: 'high',
      requestedBy: 'web',
    });
    const result = manager.decide(id, { decision: 'deny', note: 'nope' }, 'web');
    expect(result.row.decision).toBe('deny');
    expect(result.grantId).toBeNull();
    expect(createdGrants).toHaveLength(0);
  });

  it('a second decide on the same row is rejected (not_pending)', () => {
    const { manager } = newManager();
    const id = manager.enqueue({
      toolId: 'files.list',
      projectId: 'root-1',
      params: {},
      risk: 'low',
      requestedBy: 'web',
    });
    manager.decide(id, { decision: 'deny' }, 'web');
    try {
      manager.decide(id, { decision: 'approve' }, 'web');
      throw new Error('expected not_pending');
    } catch (err) {
      expect((err as ToolError).code).toBe('not_pending');
    }
  });

  it('decide on an unknown or already-closed row reports typed errors', () => {
    const { manager } = newManager();
    try {
      manager.decide('nope', { decision: 'approve' }, 'web');
      throw new Error('expected not_found');
    } catch (err) {
      expect((err as ToolError).code).toBe('not_found');
    }
    expect(() => manager.decide('x', { decision: 'maybe' as 'approve' }, 'web')).toThrowError(
      expect.objectContaining({ code: 'bad_params' }),
    );
  });
});
