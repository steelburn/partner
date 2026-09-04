/**
 * Shared in-memory test harness for the M0/M1/M2 spine (core/test only).
 *
 * Builds a fresh SQLite ':memory:' database, stores, managers, audit service
 * and Express app per call so tests never share state. Since M2 the harness
 * ALSO wires the tool broker (roots/grants/pending/proposals stores on the
 * SAME db + the six files.* tools) by default — pass `broker: false` to get
 * the pre-M2 surface (tool routes then 501). Real filesystem roots are made
 * with {@link makeTempRoot} (node:os tmpdir + mkdtemp) and removed by the
 * test.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Express } from 'express';
import type { Keychain } from '@partner/shared';
import { SCHEMA_VERSION } from '@partner/shared';
import { CORE_VERSION } from '../src/config.js';
import { demoProvider } from '../src/gateway/demo.js';
import { createPairingManager } from '../src/http/pairing.js';
import type { PairingManager, PairingOptions } from '../src/http/pairing.js';
import { createSessionManager } from '../src/http/session.js';
import type { SessionManager } from '../src/http/session.js';
import { createCoreApp } from '../src/http/server.js';
import { auditLog } from '../src/services/redaction.js';
import type { AuditService } from '../src/services/redaction.js';
import { createKeychainFake } from '../src/keychain/keychain.js';
import { createProviderManager } from '../src/providers/providerManager.js';
import type { ProviderManager } from '../src/providers/providerManager.js';
import { createToolBroker } from '../src/broker/broker.js';
import type { ToolBroker } from '../src/broker/broker.js';
import { createGrantManager } from '../src/broker/grants.js';
import type { GrantManager } from '../src/broker/grants.js';
import { createPendingManager } from '../src/broker/pending.js';
import type { PendingManager } from '../src/broker/pending.js';
import { createProjectRootManager } from '../src/broker/roots.js';
import type { ProjectRootManager } from '../src/broker/roots.js';
import { createFileTools } from '../src/files/tools.js';
import { createProposalManager } from '../src/files/proposals.js';
import type { ProposalManager } from '../src/files/proposals.js';
import { createPersonaManager } from '../src/personas/manager.js';
import type { PersonaManager } from '../src/personas/manager.js';
import { createConversationManager } from '../src/conversations/manager.js';
import type { ConversationManager } from '../src/conversations/manager.js';
import {
  createAuditStore,
  createConversationStore,
  createFileProposalStore,
  createGrantStore,
  createMessageStore,
  createPairingStore,
  createPendingToolStore,
  createPersonaStore,
  createProjectRootStore,
  createProviderStore,
  createSessionStore,
  openDatabase,
} from '../src/stores/db.js';
import type {
  AuditStore,
  ConversationStore,
  FileProposalStore,
  GrantStore,
  MessageStore,
  PairingStore,
  PendingToolStore,
  PersonaStore,
  ProjectRootStore,
  ProviderStore,
  SessionStore,
} from '../src/stores/types.js';

export const ALLOWED_HOST = '127.0.0.1:4390';
export const ALTERNATE_HOST = 'localhost:4390';
export const ALLOWLIST = [ALLOWED_HOST, ALTERNATE_HOST];

/** A fresh real directory under the OS tmpdir (cleaned by the caller). */
export function makeTempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'partner-core-root-'));
}

export interface HarnessOptions {
  demo?: boolean;
  pairing?: PairingOptions;
  staticDir?: string;
  /** Wire the M2 tool broker (default true). */
  broker?: boolean;
  /** Wire + seed the M3 persona/conversation managers (default true). */
  personas?: boolean;
}

export interface Harness {
  app: Express;
  db: ReturnType<typeof openDatabase>;
  pairing: PairingManager;
  sessions: SessionManager;
  audit: AuditService;
  pairingStore: PairingStore;
  sessionStore: SessionStore;
  auditStore: AuditStore;
  providerStore: ProviderStore;
  providerManager: ProviderManager;
  keychain: Keychain;
  /** M2 broker surface (undefined when wired with broker: false). */
  broker?: ToolBroker;
  projectRootStore: ProjectRootStore;
  grantStore: GrantStore;
  pendingStore: PendingToolStore;
  proposalStore: FileProposalStore;
  projectRootManager?: ProjectRootManager;
  grantManager?: GrantManager;
  pendingManager?: PendingManager;
  proposalManager?: ProposalManager;
  /** M3 persona/conversation stores + managers over the SAME db. The persona
   *  table is seeded with the eight starter personas (demoHarness default). */
  personaStore: PersonaStore;
  personas: PersonaManager;
  conversationStore: ConversationStore;
  messageStore: MessageStore;
  conversations: ConversationManager;
  close(): void;
}

export function demoHarness(options: HarnessOptions = {}): Harness {
  const demo = options.demo ?? true;
  const brokerEnabled = options.broker ?? true;
  const personasEnabled = options.personas ?? true;
  const db = openDatabase(':memory:');
  const pairingStore = createPairingStore(db);
  const sessionStore = createSessionStore(db);
  const auditStore = createAuditStore(db);

  const pairing = createPairingManager(pairingStore, {
    demo,
    ...options.pairing,
  });
  const sessions = createSessionManager(sessionStore, {});
  const audit = auditLog({ store: auditStore });

  // M1: every harness gets a provider manager over the SAME in-memory DB and
  // a fresh fake keychain so provider/import tests run without an OS daemon.
  const keychain = createKeychainFake();
  const providerStore = createProviderStore(db);
  const providerManager = createProviderManager({ store: providerStore, keychain, audit });

  // M2: broker over the same db — the manager/queue stores exist on every
  // harness so row-level assertions are possible; managers + broker are wired
  // unless broker: false (the 501 not_configured case).
  const projectRootStore = createProjectRootStore(db);
  const grantStore = createGrantStore(db);
  const pendingStore = createPendingToolStore(db);
  const proposalStore = createFileProposalStore(db);

  let projectRootManager: ProjectRootManager | undefined;
  let grantManager: GrantManager | undefined;
  let pendingManager: PendingManager | undefined;
  let proposalManager: ProposalManager | undefined;
  let broker: ToolBroker | undefined;
  if (brokerEnabled) {
    projectRootManager = createProjectRootManager({ store: projectRootStore });
    grantManager = createGrantManager({ store: grantStore });
    pendingManager = createPendingManager({
      store: pendingStore,
      onCreateGrant: (row, note) =>
        (grantManager as GrantManager).add(row.toolId, row.projectId ?? '', note === undefined ? {} : { note }).id,
    });
    proposalManager = createProposalManager({ store: proposalStore });
    broker = createToolBroker({
      roots: projectRootManager,
      grants: grantManager,
      pending: pendingManager,
      proposals: proposalManager,
      tools: createFileTools({ proposals: proposalStore }),
      audit,
    });
  }

  // M3: persona + conversation managers over the same db (default on). When
  // the persona table is empty the eight starter personas are seeded.
  const personaStore = createPersonaStore(db);
  const personas = createPersonaManager({ store: personaStore, audit });
  if (personasEnabled) personas.seedIfEmpty();
  const conversationStore = createConversationStore(db);
  const messageStore = createMessageStore(db);
  const conversations = createConversationManager({
    personaStore: personasEnabled ? personaStore : undefined,
    stores: { conversations: conversationStore, messages: messageStore },
    audit,
  });

  const app = createCoreApp({
    port: 4390,
    demo,
    version: CORE_VERSION,
    schemaVersion: SCHEMA_VERSION,
    hostAllowlist: ALLOWLIST,
    staticDir: options.staticDir,
    pairing,
    sessions,
    audit,
    providers: demo ? [demoProvider()] : [],
    providerManager,
    broker,
    personaManager: personasEnabled ? personas : undefined,
    conversationManager: personasEnabled ? conversations : undefined,
  });

  return {
    app,
    db,
    pairing,
    sessions,
    audit,
    pairingStore,
    sessionStore,
    auditStore,
    providerStore,
    providerManager,
    keychain,
    broker,
    projectRootStore,
    grantStore,
    pendingStore,
    proposalStore,
    projectRootManager,
    grantManager,
    pendingManager,
    proposalManager,
    personaStore,
    personas,
    conversationStore,
    messageStore,
    conversations,
    close(): void {
      db.close();
    },
  };
}

/** Recursively remove a {@link makeTempRoot} directory (test teardown). */
export function removeTempRoot(path: string): void {
  rmSync(path, { recursive: true, force: true });
}
