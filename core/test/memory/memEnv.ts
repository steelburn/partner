/**
 * Shared in-memory environment for M4 memory manager tests (core/test only):
 * one SQLite ':memory:' db with the v5 tables + audit service, plus the row
 * stores the managers run over. Tests never share state between cases.
 */
import { openDatabase } from '../../src/stores/db.js';
import { auditLog } from '../../src/services/redaction.js';
import type { AuditService } from '../../src/services/redaction.js';
import type { AuditStore } from '../../src/stores/types.js';
import type { Database } from 'better-sqlite3';
import {
  createAuditStore,
  createConversationStore,
  createEpisodeStore,
  createMemoryFtsStore,
  createMessageStore,
  createProfileStore,
} from '../../src/stores/db.js';
import { createConversationManager } from '../../src/conversations/manager.js';
import type { ConversationManager } from '../../src/conversations/manager.js';
import { createProfileManager } from '../../src/memory/profile.js';
import type { ProfileManager } from '../../src/memory/profile.js';
import { createEpisodeManager } from '../../src/memory/episodes.js';
import type { EpisodeManager, SummarizeTarget } from '../../src/memory/episodes.js';
import { createSearchManager } from '../../src/memory/search.js';
import type { SearchManager } from '../../src/memory/search.js';
import { createMemoryForgetManager } from '../../src/memory/forget.js';
import type { MemoryForgetManager } from '../../src/memory/forget.js';
import { createMemoryTransferManager } from '../../src/memory/transfer.js';
import type { MemoryTransferManager } from '../../src/memory/transfer.js';

export interface MemoryTestEnv {
  db: Database;
  auditStore: AuditStore;
  audit: AuditService;
  stores: {
    profile: ReturnType<typeof createProfileStore>;
    episodes: ReturnType<typeof createEpisodeStore>;
    fts: ReturnType<typeof createMemoryFtsStore>;
  };
  conversations: ConversationManager;
  profile: ProfileManager;
  episodes: EpisodeManager;
  search: SearchManager;
  forget: MemoryForgetManager;
  transfer: MemoryTransferManager;
  close(): void;
}

export interface MemoryTestOptions {
  demo?: boolean;
  /** Fixed clock; default real time. */
  now?: () => number;
  /** Resolver override (default: null => placeholder summaries). */
  providerResolver?: (personaId: string | null) => SummarizeTarget | null;
}

/** Fresh managers over ONE in-memory db with a shared audit + clock. */
export function makeMemoryEnv(optionsIn: MemoryTestOptions = {}): MemoryTestEnv {
  const demo = optionsIn.demo ?? false;
  const now = optionsIn.now;
  const db = openDatabase(':memory:');
  const auditStore = createAuditStore(db);
  const audit = auditLog({ store: auditStore, ...(now !== undefined ? { now } : {}) });
  const stores = {
    profile: createProfileStore(db),
    episodes: createEpisodeStore(db),
    fts: createMemoryFtsStore(db),
  };
  const conversationStore = createConversationStore(db);
  const messageStore = createMessageStore(db);
  const conversations = createConversationManager({
    stores: { conversations: conversationStore, messages: messageStore },
    audit,
    ...(now !== undefined ? { now } : {}),
  });
  const profile = createProfileManager({ store: stores.profile, fts: stores.fts, audit, now });
  const episodes = createEpisodeManager({
    stores: { episodes: stores.episodes, fts: stores.fts },
    conversations,
    providerResolver: optionsIn.providerResolver ?? (() => null),
    demo,
    audit,
    now,
  });
  const search = createSearchManager({ stores });
  const forget = createMemoryForgetManager({ stores, audit, now });
  const transfer = createMemoryTransferManager({ stores, audit, now });
  return {
    db,
    auditStore,
    audit,
    stores,
    conversations,
    profile,
    episodes,
    search,
    forget,
    transfer,
    close(): void {
      db.close();
    },
  };
}
