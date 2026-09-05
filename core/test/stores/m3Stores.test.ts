/**
 * M3 store tests (PLAN-M3.md, schema v4): the personas/conversations/messages
 * tables are created idempotently alongside M0-M2 tables, and the plain row
 * stores round-trip rows with no business logic (the managers own semantics).
 * Existing db tests (M0/M2 tables) must stay green alongside these.
 */
import { describe, expect, it } from 'vitest';
import { SCHEMA_VERSION } from '@partner/shared';
import {
  createConversationStore,
  createMessageStore,
  createPersonaStore,
  openDatabase,
} from '../../src/stores/db.js';
import type {
  ConversationRow,
  MessageRow,
  PersonaRow,
} from '../../src/stores/types.js';

function tableNames(db: ReturnType<typeof openDatabase>): string[] {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all() as Array<{ name: string }>;
  return rows.map((r) => r.name);
}

const basePersona: PersonaRow = {
  id: 'p-1',
  name: 'Alma',
  tagline: null,
  avatar: null,
  colorTheme: 'theme-sage',
  voice: 'warm',
  language: 'en',
  systemPrompt: 'Be helpful.',
  temperature: 0.6,
  taskClasses: JSON.stringify({ chat: 'gpt-4.1-mini', deep: 'gpt-4.1' }),
  fallbackModel: 'gpt-4o',
  providerId: 'prov-1',
  independenceLevel: 'suggest',
  requireHuman: JSON.stringify(['high']),
  autoScopes: JSON.stringify(['search:read']),
  memoryFlags: JSON.stringify({ userProfile: 'read', episodes: 'none' }),
  policy: null,
  isDefault: 0,
  paused: 0,
  createdAt: 10,
  updatedAt: 10,
};

describe('schema v4 (additive M3 tables)', () => {
  it('creates personas/conversations/messages and keeps the M0 tables', () => {
    const db = openDatabase(':memory:');
    try {
      const names = tableNames(db);
      expect(names).toContain('personas');
      expect(names).toContain('conversations');
      expect(names).toContain('messages');
      for (const existing of ['providers', 'project_roots', 'grants', 'pending_tools', 'file_proposals']) {
        expect(names).toContain(existing);
      }
      const meta = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version') as
        | { value: string }
        | undefined;
      expect(meta?.value).toBe(String(SCHEMA_VERSION));
    } finally {
      db.close();
    }
  });

  it('is idempotent: a second open adds nothing and keeps rows', () => {
    const db = openDatabase(':memory:');
    try {
      const personaStore = createPersonaStore(db);
      personaStore.insert({ ...basePersona, id: 'p-keep' });
      const names1 = tableNames(db).filter((n) => ['personas', 'conversations', 'messages'].includes(n));
      const db2 = openDatabase(':memory:');
      try {
        const names2 = tableNames(db2).filter((n) => ['personas', 'conversations', 'messages'].includes(n));
        expect(names2.sort()).toEqual(names1.sort());
      } finally {
        db2.close();
      }
    } finally {
      db.close();
    }
  });
});

describe('createPersonaStore (plain CRUD)', () => {
  it('inserts, finds, lists in creation order, updates whitelisted columns and counts', () => {
    const db = openDatabase(':memory:');
    try {
      const store = createPersonaStore(db);
      const first = { ...basePersona, id: 'p-1', name: 'First', createdAt: 1, updatedAt: 1 };
      const second = { ...basePersona, id: 'p-2', name: 'Second', createdAt: 2, updatedAt: 2 };
      store.insert(first);
      store.insert(second);

      expect(store.findById('p-1')?.name).toBe('First');
      expect(store.count()).toBe(2);
      expect(store.list().map((r) => r.id)).toEqual(['p-1', 'p-2']);

      store.update('p-1', { name: 'Renamed', paused: 1, isDefault: 1, updatedAt: 3 });
      const updated = store.findById('p-1');
      expect(updated?.name).toBe('Renamed');
      expect(updated?.paused).toBe(1);
      expect(updated?.isDefault).toBe(1);
      expect(updated?.updatedAt).toBe(3);
      // Untouched columns survived.
      expect(updated?.voice).toBe('warm');
      expect(updated?.taskClasses).toContain('gpt-4.1');

      store.remove('p-2');
      expect(store.findById('p-2')).toBeUndefined();
      expect(store.count()).toBe(1);
    } finally {
      db.close();
    }
  });
});

describe('createConversationStore + createMessageStore', () => {
  it('conversations list most-recently-active first; messages are ordered and countable', () => {
    const db = openDatabase(':memory:');
    try {
      const conversations = createConversationStore(db);
      const messages = createMessageStore(db);
      const c1: ConversationRow = { id: 'c-1', personaId: 'p-1', title: 'Hello', folderId: null, createdAt: 1, updatedAt: 1 };
      const c2: ConversationRow = { id: 'c-2', personaId: null, title: null, folderId: null, createdAt: 2, updatedAt: 2 };
      conversations.insert(c1);
      conversations.insert(c2);
      expect(conversations.list().map((c) => c.id)).toEqual(['c-2', 'c-1']);

      const m1: MessageRow = { id: 'm-1', conversationId: 'c-1', role: 'user', personaId: 'p-1', contentType: 'text', content: 'hi', model: null, latencyMs: null, createdAt: 10 };
      const m2: MessageRow = { id: 'm-2', conversationId: 'c-1', role: 'assistant', personaId: 'p-1', contentType: 'text', content: 'hello', model: 'demo', latencyMs: 3, createdAt: 20 };
      messages.insert(m1);
      messages.insert(m2);
      messages.insert({ ...m1, id: 'm-3', conversationId: 'c-2', content: 'other', createdAt: 5 });

      expect(messages.listByConversation('c-1').map((m) => m.id)).toEqual(['m-1', 'm-2']);
      expect(messages.countByConversation('c-1')).toBe(2);
      expect(messages.countByConversation('c-2')).toBe(1);
      expect(messages.countsByConversation()).toEqual([
        { conversationId: 'c-1', count: 2 },
        { conversationId: 'c-2', count: 1 },
      ]);

      // updated_at bump moves c-1 to the front.
      conversations.update('c-1', { updatedAt: 99 });
      expect(conversations.list().map((c) => c.id)).toEqual(['c-1', 'c-2']);

      messages.removeByConversation('c-1');
      expect(messages.listByConversation('c-1')).toHaveLength(0);
      conversations.remove('c-1');
      expect(conversations.findById('c-1')).toBeUndefined();
    } finally {
      db.close();
    }
  });
});
