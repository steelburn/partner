import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/stores/db.js';
import { createAssetStore, createNoteStore, createNoteLinkStore, createNotesFtsStore, createAuditStore } from '../../src/stores/db.js';
import { createAssetManager } from '../../src/assets/index.js';
import { createNoteManager } from '../../src/notes/index.js';
import { auditLog } from '../../src/services/redaction.js';

describe('M11 F10 asset manager', () => {
  it('creates + lists typed assets and validates kinds/sizes', () => {
    const db = openDatabase(':memory:');
    const audit = auditLog({ store: createAuditStore(db) });
    const manager = createAssetManager({ store: createAssetStore(db), audit });
    try {
      const meta = manager.create('c-1', {
        kind: 'code',
        title: 'swap.ts',
        body: '```ts\nconst swap = (a, b) => [b, a];\n```',
        tags: ['ts'],
      });
      expect(meta.kind).toBe('code');
      expect(meta.messageId).toBeNull();
      const list = manager.list('c-1');
      expect(list).toHaveLength(1);
      expect(list[0]?.body).toContain('swap');

      expect(() => manager.create('c-1', { kind: 'bogus' as 'code', title: '', body: 'x' })).toThrow(/title is required/);
      expect(() => manager.create('c-1', { kind: 'document', title: 't', body: '' })).toThrow(/body is required/);
      expect(() => manager.create('c-1', { kind: 'document', title: 't', body: 'x'.repeat(300000) })).toThrow(/capped/);
    } finally {
      db.close();
    }
  });

  it('promote creates a note with provenance', () => {
    const db = openDatabase(':memory:');
    const audit = auditLog({ store: createAuditStore(db) });
    const notes = createNoteManager({
      stores: { notes: createNoteStore(db), links: createNoteLinkStore(db), fts: createNotesFtsStore(db) },
      audit,
    });
    const manager = createAssetManager({ store: createAssetStore(db), notes, audit });
    try {
      const meta = manager.create('c-1', { kind: 'document', title: 'Summary', body: 'Key facts.' });
      const result = manager.promote('c-1', meta.id);
      const note = notes.get(result.noteId);
      expect(note?.title).toBe('Summary');
      expect(note?.content).toContain('Key facts.');
      expect(note?.content).toContain('Source: conversation c-1');
      // Scoped delete refused for the wrong conversation.
      expect(() => manager.remove('other', meta.id)).toThrow(/not found/);
      manager.remove('c-1', meta.id);
      expect(manager.list('c-1')).toHaveLength(0);
    } finally {
      db.close();
    }
  });
});
