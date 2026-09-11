/**
 * Shared in-memory environment for M5 notes + plans manager tests (core/test
 * only): ONE SQLite ':memory:' db with the v6 tables + audit service, plus
 * the row stores both managers run over (they share the notes_fts mirror).
 * Tests never share state between cases.
 */
import type { Database } from 'better-sqlite3';
import { openDatabase } from '../../src/stores/db.js';
import { auditLog } from '../../src/services/redaction.js';
import type { AuditService } from '../../src/services/redaction.js';
import type { AuditStore } from '../../src/stores/types.js';
import {
  createAuditStore,
  createFolderStore,
  createNoteFolderStore,
  createNoteLinkStore,
  createNoteStore,
  createNoteVersionStore,
  createNoteGraphStore,
  createNotesFtsStore,
  createPlanStore,
} from '../../src/stores/db.js';
import type {
  FolderStore,
  NoteFolderStore,
  NoteGraphStore,
  NoteLinkStore,
  NoteStore,
  NoteVersionStore,
  NotesFtsStore,
  PlanStore,
} from '../../src/stores/types.js';
import { createNoteManager } from '../../src/notes/index.js';
import type { DailySummarizeTarget, NoteManager } from '../../src/notes/index.js';
import { createPlanManager } from '../../src/plans/index.js';
import type { PlanManager } from '../../src/plans/index.js';
import type { ChatEvent, ChatMessage, ChatRequest } from '@partner/shared';

export interface NotesTestEnv {
  db: Database;
  auditStore: AuditStore;
  audit: AuditService;
  stores: {
    notes: NoteStore;
    links: NoteLinkStore;
    plans: PlanStore;
    fts: NotesFtsStore;
    versions?: NoteVersionStore;
    graph?: NoteGraphStore;
    folders?: NoteFolderStore;
    folderTree?: FolderStore;
  };
  notes: NoteManager;
  plans: PlanManager;
  close(): void;
}

export interface NotesTestOptions {
  /** Demo mode writes the placeholder daily summary (default true). */
  demo?: boolean;
  /** Fixed clock; default real time. */
  now?: () => number;
  /** Resolver override (default: null => placeholder fallback). */
  providerResolver?: () => Promise<DailySummarizeTarget | null>;
  /** M16 F1/F3: wire the version + graph stores (default false). */
  m16?: boolean;
  /** M17: wire the folder tree + note<->folder membership (default false). */
  m17?: boolean;
}

/** Fresh managers over ONE in-memory db with a shared audit + clock. */
export function makeNotesEnv(optionsIn: NotesTestOptions = {}): NotesTestEnv {
  const demo = optionsIn.demo ?? true;
  const now = optionsIn.now;
  const db = openDatabase(':memory:');
  const auditStore = createAuditStore(db);
  const audit = auditLog({ store: auditStore, ...(now !== undefined ? { now } : {}) });
  const stores = {
    notes: createNoteStore(db),
    links: createNoteLinkStore(db),
    plans: createPlanStore(db),
    fts: createNotesFtsStore(db),
    versions: optionsIn.m16 === true ? createNoteVersionStore(db) : undefined,
    graph: optionsIn.m16 === true ? createNoteGraphStore(db) : undefined,
    folders: optionsIn.m17 === true ? createNoteFolderStore(db) : undefined,
    folderTree: optionsIn.m17 === true ? createFolderStore(db) : undefined,
  };
  // M17: a narrow structural folder lookup over the same tree (get +
  // subtreeIds) — enough for the note manager's scope resolution without
  // pulling the full folder manager (which owns chat counts) into this env.
  const folderTree = stores.folderTree;
  const folderLookup = folderTree
    ? {
        get: (id: string): unknown | null => folderTree.findById(id) ?? null,
        subtreeIds: (id: string): string[] => {
          if (!folderTree.findById(id)) throw new Error('folder not found');
          const all = folderTree.list();
          const out: string[] = [id];
          const queue: string[] = [id];
          const guard = new Set<string>([id]);
          while (queue.length > 0) {
            const current = queue.shift() as string;
            for (const row of all) {
              if (row.parentId === current && !guard.has(row.id)) {
                guard.add(row.id);
                out.push(row.id);
                queue.push(row.id);
              }
            }
          }
          return out;
        },
      }
    : undefined;
  const notes = createNoteManager({
    stores: {
      notes: stores.notes,
      links: stores.links,
      fts: stores.fts,
      ...(stores.versions !== undefined ? { versions: stores.versions } : {}),
      ...(stores.graph !== undefined ? { graph: stores.graph } : {}),
      ...(stores.folders !== undefined ? { folders: stores.folders } : {}),
    },
    ...(folderLookup !== undefined ? { folderLookup } : {}),
    audit,
    demo,
    providerResolver: optionsIn.providerResolver ?? null,
    now,
  });
  const plans = createPlanManager({
    stores: { plans: stores.plans, fts: stores.fts },
    audit,
    now,
  });
  return {
    db,
    auditStore,
    audit,
    stores,
    notes,
    plans,
    close(): void {
      db.close();
    },
  };
}

/** Fixed clock: noon UTC on 2025-02-03 (date '2025-02-03'). */
export function fixedClock(): () => number {
  let at = Date.UTC(2025, 1, 3, 12, 0, 0);
  return () => at;
}

/** Clock that ticks +1ms per read — deterministic ordering across creates. */
export function sequentialClock(): () => number {
  let at = Date.UTC(2025, 2, 1, 0, 0, 0);
  return () => {
    const value = at;
    at += 1;
    return value;
  };
}

/** Advance the fixed clock by the given milliseconds and return the new value. */
export function advanceFixed(clock: { value: number }): (ms: number) => number {
  return (ms: number): number => {
    clock.value += ms;
    return clock.value;
  };
}

/** A fake chat client that records the last chat request body. */
export function fakeProvider(): {
  client: DailySummarizeTarget['client'];
  requests: Array<{ model: string; messages: ChatMessage[] }>;
  reply: string;
  fail: boolean;
} {
  const state: {
    requests: Array<{ model: string; messages: ChatMessage[] }>;
    reply: string;
    fail: boolean;
  } = { requests: [], reply: 'PROVIDER SUMMARY TEXT', fail: false };
  const client: DailySummarizeTarget['client'] = {
    async *chatStream(req: ChatRequest) {
      state.requests.push({ model: req.model, messages: req.messages });
      if (state.fail) {
        yield { type: 'error', message: 'upstream blew up' } as ChatEvent;
        return;
      }
      yield { type: 'delta', text: state.reply } as ChatEvent;
      yield { type: 'done', model: req.model, latencyMs: 5 } as ChatEvent;
      yield { type: 'usage', promptTokens: 1, completionTokens: 1, totalTokens: 2 } as ChatEvent;
    },
    async health() {
      return { ok: true, latencyMs: 1 };
    },
  };
  return {
    client,
    get requests() {
      return state.requests;
    },
    get reply() {
      return state.reply;
    },
    set reply(value: string) {
      state.reply = value;
    },
    get fail() {
      return state.fail;
    },
    set fail(value: boolean) {
      state.fail = value;
    },
  };
}
