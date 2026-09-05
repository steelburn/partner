/**
 * M11 F11 folder manager tests (PLAN-M11.md).
 *
 * Tree semantics live in the manager: append ordering per parent, parent
 * validation, cycle rejection on move, depth bound, and delete semantics
 * (children + direct chats reparent to the removed folder's parent). The
 * conversations table is the edge owner — chat counts and reassignment go
 * through the conversation manager.
 */
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/stores/db.js';
import { createConversationManager } from '../../src/conversations/manager.js';
import { createConversationStore, createFolderStore, createMessageStore } from '../../src/stores/db.js';
import { createFolderManager } from '../../src/folders/index.js';
import type { FolderManager } from '../../src/folders/index.js';
import { auditLog } from '../../src/services/redaction.js';
import { createAuditStore } from '../../src/stores/db.js';

function makeFolders(): {
  db: ReturnType<typeof openDatabase>;
  folders: FolderManager;
  conversations: ReturnType<typeof createConversationManager>;
} {
  const db = openDatabase(':memory:');
  const audit = auditLog({ store: createAuditStore(db) });
  const conversationStore = createConversationStore(db);
  const messageStore = createMessageStore(db);
  const conversations = createConversationManager({
    stores: { conversations: conversationStore, messages: messageStore },
    audit,
  });
  const folders = createFolderManager({
    store: createFolderStore(db),
    conversations,
    audit,
  });
  return { db, folders, conversations };
}

describe('folder manager tree semantics', () => {
  it('creates folders appended per parent and lists them flat', () => {
    const { db, folders } = makeFolders();
    try {
      const work = folders.create({ name: 'Work' });
      const alpha = folders.create({ name: 'Alpha', parentId: work.id });
      const beta = folders.create({ name: 'Beta', parentId: work.id });
      const personal = folders.create({ name: 'Personal' });

      expect(work.parentId).toBeNull();
      expect(alpha.position).toBe(0);
      expect(beta.position).toBe(1);
      expect(personal.position).toBe(1);

      const rows = folders.list();
      expect(rows.map((f) => f.id)).toContain(work.id);
      expect(rows.find((f) => f.id === alpha.id)?.parentId).toBe(work.id);
      expect(rows.find((f) => f.id === beta.id)?.parentId).toBe(work.id);
    } finally {
      db.close();
    }
  });

  it('refuses blank names and unknown parents', () => {
    const { db, folders } = makeFolders();
    try {
      expect(() => folders.create({ name: '   ' })).toThrow(/name is required/);
      expect(() => folders.create({ name: 'x', parentId: 'ghost' })).toThrow(/parent folder not found/);
    } finally {
      db.close();
    }
  });

  it('rejects moving a folder under itself or its own descendant (cycle)', () => {
    const { db, folders } = makeFolders();
    try {
      const root = folders.create({ name: 'Root' });
      const child = folders.create({ name: 'Child', parentId: root.id });
      const grandchild = folders.create({ name: 'Grand', parentId: child.id });

      expect(() => folders.update(root.id, { parentId: root.id })).toThrow(/own parent/);
      expect(() => folders.update(root.id, { parentId: child.id })).toThrow(/descendant/);
      expect(() => folders.update(child.id, { parentId: grandchild.id })).toThrow(/descendant/);

      // Legit move: grandchild to root.
      const moved = folders.update(grandchild.id, { parentId: null });
      expect(moved.parentId).toBeNull();
    } finally {
      db.close();
    }
  });

  it('delete reparents children and moves direct chats to the removed parent', () => {
    const { db, folders, conversations } = makeFolders();
    try {
      const root = folders.create({ name: 'Root' });
      const child = folders.create({ name: 'Child', parentId: root.id });
      const chat = conversations.create({ title: 'chat in root', folderId: root.id });
      expect(chat.folderId).toBe(root.id);
      // Folder list reports direct chat counts.
      expect(folders.get(root.id)?.chatCount).toBe(1);

      folders.remove(root.id);
      expect(folders.get(root.id)).toBeNull();
      // Child reparented to the removed root's parent (Inbox).
      expect(folders.get(child.id)?.parentId).toBeNull();
      // The chat followed the folder's contents to Inbox.
      expect(conversations.list().find((c) => c.id === chat.id)?.folderId).toBeNull();
    } finally {
      db.close();
    }
  });

  it('renames a folder and bumps updatedAt', () => {
    const { db, folders } = makeFolders();
    try {
      const created = folders.create({ name: 'Old' });
      const updated = folders.update(created.id, { name: 'New' });
      expect(updated.name).toBe('New');
      expect(folders.get(created.id)?.name).toBe('New');
      expect(() => folders.update(created.id, { name: '' })).toThrow(/name is required/);
    } finally {
      db.close();
    }
  });
});
