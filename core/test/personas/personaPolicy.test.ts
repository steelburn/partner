import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/stores/db.js';
import { createAuditStore, createPersonaStore } from '../../src/stores/db.js';
import { createPersonaManager } from '../../src/personas/manager.js';
import { auditLog } from '../../src/services/redaction.js';

describe('M11 F3 persona policy', () => {
  it('persists and round-trips skill/tool defaults + bans', () => {
    const db = openDatabase(':memory:');
    try {
      const manager = createPersonaManager({
        store: createPersonaStore(db),
        audit: auditLog({ store: createAuditStore(db) }),
      });
      const created = manager.create({
        name: 'Gated',
        policy: {
          skills: { default: ['web-research'], banned: ['ship'] },
          tools: { banned: ['deploy'] },
        },
      });
      expect(created.policy?.skills?.default).toEqual(['web-research']);
      expect(created.policy?.skills?.banned).toEqual(['ship']);
      expect(created.policy?.tools?.banned).toEqual(['deploy']);

      const read = manager.get(created.id);
      expect(read?.policy?.skills?.banned).toEqual(['ship']);
      expect(read?.policy?.tools?.banned).toEqual(['deploy']);

      // Unrelated updates must not wipe the policy.
      manager.update(created.id, { name: 'Gated2' });
      expect(manager.get(created.id)?.policy?.skills?.default).toEqual(['web-research']);

      // Clearing the policy removes it.
      manager.update(created.id, { policy: {} });
      expect(manager.get(created.id)?.policy).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it('normalizes junk policy input away', () => {
    const db = openDatabase(':memory:');
    try {
      const manager = createPersonaManager({
        store: createPersonaStore(db),
        audit: auditLog({ store: createAuditStore(db) }),
      });
      const created = manager.create({
        name: 'Clean',
        policy: {
          skills: { banned: ['', 7 as unknown as string, ' x ', 'x'] },
          tools: { banned: 'nope' as unknown as string[] },
        },
      });
      expect(created.policy?.skills?.banned).toEqual(['x']);
      expect(created.policy?.tools).toBeUndefined();
    } finally {
      db.close();
    }
  });
});
