/**
 * M17 core unit tests (PLAN-M17): note<->folder membership, project-scoped
 * note lists, and the project-scoped graph with cross-project ghosts.
 *
 * One in-memory db wires the SAME folder tree for chats and notes: the
 * folder manager owns the tree, the note-folder store owns membership, and
 * the note manager resolves scopes through the folder manager. Note content
 * is owner data — these tests assert ids/counts/shape, never bodies.
 */
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/stores/db.js';
import {
  createAuditStore,
  createConversationStore,
  createFolderStore,
  createMessageStore,
  createNoteFolderStore,
  createNoteGraphStore,
  createNoteLinkStore,
  createNoteStore,
  createNotesFtsStore,
} from '../../src/stores/db.js';
import { createConversationManager } from '../../src/conversations/manager.js';
import { createFolderManager } from '../../src/folders/index.js';
import type { FolderManager } from '../../src/folders/index.js';
import { createNoteManager } from '../../src/notes/index.js';
import type { NoteManager } from '../../src/notes/index.js';
import { auditLog } from '../../src/services/redaction.js';
import type { AuditService } from '../../src/services/redaction.js';
import type { NoteFolderStore } from '../../src/stores/types.js';

function makeEnv(): {
  db: ReturnType<typeof openDatabase>;
  folders: FolderManager;
  notes: NoteManager;
  noteFolderStore: NoteFolderStore;
  audit: AuditService;
} {
  const db = openDatabase(':memory:');
  const audit = auditLog({ store: createAuditStore(db) });
  const conversations = createConversationManager({
    stores: { conversations: createConversationStore(db), messages: createMessageStore(db) },
    audit,
  });
  const noteFolderStore = createNoteFolderStore(db);
  const folders = createFolderManager({
    store: createFolderStore(db),
    conversations,
    noteFolders: noteFolderStore,
    audit,
  });
  const notes = createNoteManager({
    stores: {
      notes: createNoteStore(db),
      links: createNoteLinkStore(db),
      fts: createNotesFtsStore(db),
      graph: createNoteGraphStore(db),
      folders: noteFolderStore,
    },
    folderLookup: folders,
    audit,
    demo: true,
  });
  return { db, folders, notes, noteFolderStore, audit };
}

describe('M17 noteFolderStore', () => {
  it('replaces membership per note, dedupes and lists per folder/union', () => {
    const { db, noteFolderStore } = makeEnv();
    try {
      noteFolderStore.setForNote('n1', ['f1', 'f2', 'f1'], 10);
      expect(noteFolderStore.listFolderIdsForNote('n1').sort()).toEqual(['f1', 'f2']);
      expect(noteFolderStore.listNoteIdsInFolder('f1')).toEqual(['n1']);
      expect(noteFolderStore.listNoteIdsInFolder('f2')).toEqual(['n1']);

      noteFolderStore.setForNote('n2', ['f2'], 11);
      expect(noteFolderStore.listNoteIdsInFolder('f2').sort()).toEqual(['n1', 'n2']);
      expect(noteFolderStore.listNoteIdsInFolders(['f1', 'f2'])).toEqual(['n1', 'n2']);

      const counts = noteFolderStore.countByFolder();
      expect(counts.get('f1')).toBe(1);
      expect(counts.get('f2')).toBe(2);

      // Replace (not append): n1 loses f1.
      noteFolderStore.setForNote('n1', ['f3'], 12);
      expect(noteFolderStore.listFolderIdsForNote('n1')).toEqual(['f3']);
      expect(noteFolderStore.listNoteIdsInFolder('f1')).toEqual([]);

      // Clear to unfiled.
      noteFolderStore.setForNote('n1', [], 13);
      expect(noteFolderStore.listFolderIdsForNote('n1')).toEqual([]);

      noteFolderStore.removeForFolder('f2');
      expect(noteFolderStore.listNoteIdsInFolder('f2')).toEqual([]);
      expect(noteFolderStore.listFolderIdsForNote('n2')).toEqual([]);
      noteFolderStore.removeForNote('n1');
      expect(noteFolderStore.listFolderIdsForNote('n1')).toEqual([]);
    } finally {
      db.close();
    }
  });
});

describe('M17 note manager membership + scopes', () => {
  it('creates with folderIds, rejects unknown folders, and carries folderIds', () => {
    const { db, folders, notes } = makeEnv();
    try {
      const project = folders.create({ name: 'Project' });
      const created = notes.create({ title: 'A', folderIds: [project.id] });
      expect(created.folderIds).toEqual([project.id]);
      expect(notes.get(created.id)?.folderIds).toEqual([project.id]);
      expect(notes.list().find((row) => row.id === created.id)?.folderIds).toEqual([project.id]);

      expect(() => notes.create({ title: 'B', folderIds: ['ghost'] })).toThrow(/folder not found/);
      // The bad create must not have left a note behind.
      expect(notes.list().some((row) => row.title === 'B')).toBe(false);

      // Raw update payloads ignore folderIds (membership has one write path).
      const updated = notes.update(created.id, { content: 'x', folderIds: ['ghost'] } as never);
      expect(updated.folderIds).toEqual([project.id]);
    } finally {
      db.close();
    }
  });

  it('setFolders replaces and clears membership ([] = Inbox) with audit ids/counts', () => {
    const { db, folders, notes, noteFolderStore, audit } = makeEnv();
    try {
      const a = folders.create({ name: 'A' });
      const b = folders.create({ name: 'B' });
      const note = notes.create({ title: 'Note' });

      const assigned = notes.setFolders(note.id, [a.id, b.id, a.id]);
      expect(assigned.folderIds).toEqual([a.id, b.id]);
      expect(noteFolderStore.listFolderIdsForNote(note.id).sort()).toEqual([a.id, b.id].sort());

      const cleared = notes.setFolders(note.id, []);
      expect(cleared.folderIds).toEqual([]);

      expect(() => notes.setFolders(note.id, ['ghost'])).toThrow(/folder not found/);
      expect(() => notes.setFolders('ghost', [])).toThrow(/note not found/);
      expect(() => notes.setFolders(note.id, 'nope' as never)).toThrow(/folderIds must be an array/);

      // Audit carries ids/counts only — never note content.
      const rows = audit.query({ limit: 20, action: 'note.folders' });
      expect(rows.length).toBeGreaterThan(0);
      const latest = rows[0];
      expect(latest?.target).toBe(note.id);
      const details = JSON.parse(latest?.details ?? '{}') as Record<string, unknown>;
      expect(details.count).toBe(0);
      expect(details.folderIds).toEqual([]);
      expect(JSON.stringify(details)).not.toContain('Note');
    } finally {
      db.close();
    }
  });

  it('list filters by project subtree and unfiled (Inbox)', () => {
    const { db, folders, notes } = makeEnv();
    try {
      const work = folders.create({ name: 'Work' });
      const sub = folders.create({ name: 'Sub', parentId: work.id });
      const personal = folders.create({ name: 'Personal' });

      const inWork = notes.create({ title: 'work note', folderIds: [work.id] });
      const inSub = notes.create({ title: 'sub note', folderIds: [sub.id] });
      const inPersonal = notes.create({ title: 'personal note', folderIds: [personal.id] });
      const unfiled = notes.create({ title: 'inbox note' });
      const both = notes.create({ title: 'both', folderIds: [work.id, personal.id] });

      const workIds = notes.list({ folderId: work.id }).map((row) => row.id).sort();
      expect(workIds).toEqual([both.id, inSub.id, inWork.id].sort());

      const personalIds = notes.list({ folderId: personal.id }).map((row) => row.id).sort();
      expect(personalIds).toEqual([both.id, inPersonal.id].sort());

      const inboxIds = notes.list({ unfiled: true }).map((row) => row.id);
      expect(inboxIds).toEqual([unfiled.id]);

      expect(notes.list()).toHaveLength(5);
      expect(() => notes.list({ folderId: 'ghost' })).toThrow(/folder not found/);
    } finally {
      db.close();
    }
  });

  it('note delete clears its memberships', () => {
    const { db, folders, notes, noteFolderStore } = makeEnv();
    try {
      const project = folders.create({ name: 'Project' });
      const note = notes.create({ title: 'Doomed', folderIds: [project.id] });
      expect(folders.get(project.id)?.noteCount).toBe(1);
      notes.remove(note.id);
      expect(noteFolderStore.listFolderIdsForNote(note.id)).toEqual([]);
      expect(folders.get(project.id)?.noteCount).toBe(0);
    } finally {
      db.close();
    }
  });
});

describe('M17 note graph scoping', () => {
  it('unscoped graph is backward compatible (folderIds, no externalNodes)', () => {
    const { db, folders, notes } = makeEnv();
    try {
      const project = folders.create({ name: 'Project' });
      notes.create({ title: 'Alpha', folderIds: [project.id] });
      notes.create({ title: 'Beta' });
      const graph = notes.graph();
      expect(graph.externalNodes).toBeUndefined();
      expect(graph.nodes.every((node) => node.external === undefined)).toBe(true);
      expect(graph.nodes.find((node) => node.title === 'Alpha')?.folderIds).toEqual([project.id]);
      expect(graph.nodes.find((node) => node.title === 'Beta')?.folderIds).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('returns in-scope nodes + both-direction ghosts and boundary edges', () => {
    const { db, folders, notes } = makeEnv();
    try {
      const a = folders.create({ name: 'A' });
      const b = folders.create({ name: 'B' });
      const nA = notes.create({ title: 'Alpha', folderIds: [a.id] });
      const nC = notes.create({ title: 'Gamma', folderIds: [a.id] });
      const nB = notes.create({ title: 'Beta', folderIds: [b.id] });

      // A links out to B, and B links into A (both directions).
      notes.update(nA.id, { content: 'see [[Beta]]' });
      notes.update(nB.id, { content: 'see [[Gamma]]' });

      const graph = notes.graph({ folderId: a.id });
      expect(graph.nodes.map((node) => node.id).sort()).toEqual([nA.id, nC.id].sort());
      expect(graph.nodes.every((node) => node.external === undefined)).toBe(true);
      expect(graph.externalNodes?.map((node) => node.id)).toEqual([nB.id]);
      expect(graph.externalNodes?.[0]?.external).toBe(true);
      expect(graph.externalNodes?.[0]?.x).toBeNull();
      expect(graph.externalNodes?.[0]?.folderIds).toEqual([b.id]);

      const pairs = graph.edges.map((edge) => `${edge.source}->${edge.target}`).sort();
      expect(pairs).toContain(`${nA.id}->${nB.id}`);
      expect(pairs).toContain(`${nB.id}->${nC.id}`);

      // Scoping to B yields the mirror ghosts.
      const graphB = notes.graph({ folderId: b.id });
      expect(graphB.externalNodes?.map((node) => node.id).sort()).toEqual([nA.id, nC.id].sort());
    } finally {
      db.close();
    }
  });

  it('collapses a mutual cross-project link to one bidirectional boundary edge', () => {
    const { db, folders, notes } = makeEnv();
    try {
      const a = folders.create({ name: 'A' });
      const b = folders.create({ name: 'B' });
      const nA = notes.create({ title: 'Alpha', folderIds: [a.id] });
      const nB = notes.create({ title: 'Beta', folderIds: [b.id] });
      notes.update(nA.id, { content: '[[Beta]]' });
      notes.update(nB.id, { content: '[[Alpha]]' });

      const graph = notes.graph({ folderId: a.id });
      expect(graph.externalNodes?.map((node) => node.id)).toEqual([nB.id]);
      const boundary = graph.edges.filter(
        (edge) =>
          (edge.source === nA.id && edge.target === nB.id) ||
          (edge.source === nB.id && edge.target === nA.id),
      );
      expect(boundary).toHaveLength(1);
      expect(boundary[0]?.bidirectional).toBe(true);
    } finally {
      db.close();
    }
  });

  it('a note in two projects appears in both scopes; unfiled scoping works', () => {
    const { db, folders, notes } = makeEnv();
    try {
      const a = folders.create({ name: 'A' });
      const b = folders.create({ name: 'B' });
      const shared = notes.create({ title: 'Shared', folderIds: [a.id, b.id] });
      const inbox = notes.create({ title: 'Inbox note' });

      expect(notes.graph({ folderId: a.id }).nodes.map((n) => n.id)).toContain(shared.id);
      expect(notes.graph({ folderId: b.id }).nodes.map((n) => n.id)).toContain(shared.id);
      const inboxGraph = notes.graph({ unfiled: true });
      expect(inboxGraph.nodes.map((n) => n.id)).toEqual([inbox.id]);
      // Unfiled notes have no cross-project links here -> empty ghost set.
      expect(inboxGraph.externalNodes).toEqual([]);
    } finally {
      db.close();
    }
  });
});

describe('M17 folder manager note bookkeeping', () => {
  it('reports noteCount and subtreeIds; delete clears membership but keeps notes', () => {
    const { db, folders, notes } = makeEnv();
    try {
      const root = folders.create({ name: 'Root' });
      const child = folders.create({ name: 'Child', parentId: root.id });
      const grandchild = folders.create({ name: 'Grand', parentId: child.id });

      expect(folders.subtreeIds(root.id).sort()).toEqual([root.id, child.id, grandchild.id].sort());
      expect(folders.subtreeIds(child.id).sort()).toEqual([child.id, grandchild.id].sort());
      expect(() => folders.subtreeIds('ghost')).toThrow(/folder not found/);

      const note = notes.create({ title: 'N', folderIds: [child.id, grandchild.id] });
      const childFolder = folders.get(child.id);
      expect(childFolder?.chatCount).toBe(0);
      expect(childFolder?.noteCount).toBe(1);
      expect(folders.get(grandchild.id)?.noteCount).toBe(1);

      // Deleting the child removes only its direct membership; the note
      // survives and keeps its grandchild membership.
      folders.remove(child.id);
      expect(notes.get(note.id)).not.toBeNull();
      expect(notes.get(note.id)?.folderIds).toEqual([grandchild.id]);
    } finally {
      db.close();
    }
  });
});
