/**
 * Partner core — M0 security spine entry point.
 *
 * Wiring order: config -> keychain -> SQLite stores -> pairing/session
 * managers -> redaction audit service -> demo provider -> Express app.
 *
 * This module re-exports the full public surface so tests and later packages
 * (web, shell, extension) can build the core in-process via {@link createCore}
 * or spawn it via `npm run start` (tsx src/index.ts).
 *
 * Running this file directly (node/tsx entry) starts the loopback server and
 * prints a one-line startup banner; importing it never listens.
 */
import { pathToFileURL } from 'node:url';
import type { Server } from 'node:http';
import type { Express } from 'express';
import type { Keychain } from '@partner/shared';
import type { Database } from 'better-sqlite3';

// ---- config ----------------------------------------------------------------
export { CORE_VERSION, DEFAULT_DB_PATH, DEFAULT_HOST, DEFAULT_PORT, loadConfig } from './config.js';
export type { CoreConfig, KeychainKind } from './config.js';

// ---- keychain --------------------------------------------------------------
export { createKeychainFake, createKeychainNative, KEYCHAIN_SERVICE } from './keychain/keychain.js';
export type { Keychain } from './keychain/keychain.js';

// ---- stores ----------------------------------------------------------------
export {
  createAuditStore,
  createFileProposalStore,
  createGrantStore,
  createPairingStore,
  createPendingToolStore,
  createProjectRootStore,
  createProviderStore,
  createSessionStore,
  createSettingsStore,
  openDatabase,
} from './stores/db.js';
export type {
  AuditRow,
  AuditStore,
  FileProposalRow,
  FileProposalStore,
  GrantRow,
  GrantStore,
  PairingRow,
  PairingStore,
  PendingToolRow,
  PendingToolStore,
  ProjectRootRow,
  ProjectRootStore,
  ProviderRow,
  ProviderRowPatch,
  ProviderStore,
  SessionRow,
  SessionStore,
  SettingsRow,
  SettingsStore,
} from './stores/types.js';

// ---- pairing / sessions ----------------------------------------------------
export { codeHash, createPairingManager } from './http/pairing.js';
export type { PairingManager, PairingOptions, PairingVerifyResult } from './http/pairing.js';
export { createSessionManager, tokenHash } from './http/session.js';
export type {
  SessionInfo,
  SessionManager,
  SessionOptions,
  SessionValidationResult,
} from './http/session.js';

// ---- redaction / audit -----------------------------------------------------
export { auditLog, redactJson, redactString, redactValue } from './services/redaction.js';
export type { AuditService } from './services/redaction.js';

// ---- gateway ---------------------------------------------------------------
export { demoProvider, DEMO_MODEL } from './gateway/demo.js';
export { createOpenAICompatibleClient, UpstreamError, safeUpstreamMessage, USER_AGENT } from './gateway/openaiCompatible.js';
export type {
  OpenAICompatibleClient,
  OpenAICompatibleOptions,
  UpstreamErrorCode,
} from './gateway/openaiCompatible.js';
export { resolveChatProvider } from './gateway/resolver.js';
export { createBudgetTracker } from './gateway/budget.js';
export { priceForModel } from './gateway/pricing.js';
export type { BudgetOptions, BudgetRecord, BudgetTracker } from './gateway/budget.js';
export { connectSelfService, fetchSelfServiceLoginKey } from './gateway/selfService.js';
export type { SelfServiceErrorKind, SelfServiceOptions } from './gateway/selfService.js';

// ---- providers (M1) --------------------------------------------------------
export { createProviderManager, toSummary, normalizeEndpoint } from './providers/providerManager.js';
export type {
  ProviderManager,
  ProviderManagerOptions,
} from './providers/providerManager.js';
export { ProviderError } from './providers/errors.js';
export type { ProviderErrorCode } from './providers/errors.js';

// ---- M2 tool broker (files, roots, grants, pending, proposals) -------------
export { createToolBroker } from './broker/broker.js';
export type { ExecContext, DecideResult, ToolBroker, ToolBrokerOptions } from './broker/broker.js';
export { ToolError, toolErrorStatus } from './broker/errors.js';
export type { ToolErrorCode } from './broker/errors.js';
export { FILE_TOOL_MANIFESTS, manifestFor } from './broker/toolManifests.js';
export { createGrantManager } from './broker/grants.js';
export type { GrantAddOptions, GrantManager, GrantManagerOptions } from './broker/grants.js';
export { createPendingManager } from './broker/pending.js';
export type {
  EnqueueInput,
  PendingDecision,
  PendingManager,
  PendingManagerOptions,
} from './broker/pending.js';
export { createProjectRootManager } from './broker/roots.js';
export type {
  ProjectRootManager,
  ProjectRootManagerOptions,
  RootFs,
} from './broker/roots.js';
export { canonicalize, resolveInRoot } from './files/paths.js';
export type { ResolveResult } from './files/paths.js';
export { createProposalManager } from './files/proposals.js';
export type { ProposalManager, ProposalManagerOptions, ProposalView } from './files/proposals.js';
export { createFileTools, FILE_TOOL_IDS } from './files/tools.js';
export type {
  ApplyResult,
  DeleteResult,
  EditResult,
  FileToolDeps,
  FileTools,
  ListResult,
  ReadResult,
  SearchResult,
  ToolExecutor,
} from './files/tools.js';

// ---- http server -----------------------------------------------------------
export { createCoreApp } from './http/server.js';
export type { CoreAppOptions } from './http/server.js';

import { loadConfig } from './config.js';
import type { CoreConfig } from './config.js';
import {
  openDatabase,
  createPairingStore,
  createSessionStore,
  createAuditStore,
  createProviderStore,
  createProjectRootStore,
  createGrantStore,
  createPendingToolStore,
  createFileProposalStore,
} from './stores/db.js';
import type { ProviderStore } from './stores/types.js';
import { createKeychainFake, createKeychainNative } from './keychain/keychain.js';
import { createPairingManager } from './http/pairing.js';
import type { PairingManager } from './http/pairing.js';
import { createSessionManager } from './http/session.js';
import type { SessionManager } from './http/session.js';
import { auditLog } from './services/redaction.js';
import type { AuditService } from './services/redaction.js';
import { demoProvider } from './gateway/demo.js';
import { createProviderManager } from './providers/providerManager.js';
import type { ProviderManager } from './providers/providerManager.js';
import { createToolBroker } from './broker/broker.js';
import type { ToolBroker } from './broker/broker.js';
import { createGrantManager } from './broker/grants.js';
import type { GrantManager } from './broker/grants.js';
import { createPendingManager } from './broker/pending.js';
import type { PendingManager } from './broker/pending.js';
import { createProjectRootManager } from './broker/roots.js';
import type { ProjectRootManager } from './broker/roots.js';
import { createFileTools } from './files/tools.js';
import { createProposalManager } from './files/proposals.js';
import type { ProposalManager } from './files/proposals.js';
import { createCoreApp } from './http/server.js';

export interface CoreBundle {
  config: CoreConfig;
  db: Database;
  keychain: Keychain;
  pairing: PairingManager;
  sessions: SessionManager;
  audit: AuditService;
  providerStore: ProviderStore;
  providerManager: ProviderManager;
  /** M2 broker + its managers (wired on every core; roots are added at runtime). */
  broker: ToolBroker;
  projectRootManager: ProjectRootManager;
  grantManager: GrantManager;
  pendingManager: PendingManager;
  proposalManager: ProposalManager;
  app: Express;
  /** Close the SQLite handle (no-op safe after shutdown). */
  close(): void;
}

/**
 * Build the full M0 core in-process (config -> app). Does NOT listen; call
 * {@link startServer} for the bound server.
 */
export function createCore(config: CoreConfig): CoreBundle {
  const db = openDatabase(config.dbPath);
  const keychain = config.keychain === 'native' ? createKeychainNative() : createKeychainFake();

  const pairing = createPairingManager(createPairingStore(db), {
    codeTtlMs: config.codeTtlMs,
    maxAttempts: config.maxAttempts,
    lockMs: config.lockMs,
    demo: config.demo,
  });
  const sessions = createSessionManager(createSessionStore(db), { ttlMs: config.sessionTtlMs });
  const audit = auditLog({ store: createAuditStore(db) });

  // M1: provider profiles (row store) + manager (keychain + probe logic). In
  // demo mode the store is ':memory:' and the keychain is the fake, so the
  // whole surface is exercisable with no credentials. Demo chat still falls
  // back to the demo provider until a profile is registered.
  const providerStore = createProviderStore(db);
  const providerManager = createProviderManager({ store: providerStore, keychain, audit });

  // M2: tool broker over the SAME in-memory/file DB — roots/grants/pending/
  // proposals tables (schema v3) + the six files.* tools. Roots are added at
  // runtime (a registered dir must exist), so wiring here needs no temp dir.
  const projectRootManager = createProjectRootManager({ store: createProjectRootStore(db) });
  const grantManager = createGrantManager({ store: createGrantStore(db) });
  const pendingManager = createPendingManager({
    store: createPendingToolStore(db),
    // Approve + remember persists a user grant for (tool, project).
    onCreateGrant: (row, note) =>
      grantManager.add(row.toolId, row.projectId ?? '', note === undefined ? {} : { note }).id,
  });
  const proposalStore = createFileProposalStore(db);
  const proposalManager = createProposalManager({ store: proposalStore });
  const broker = createToolBroker({
    roots: projectRootManager,
    grants: grantManager,
    pending: pendingManager,
    proposals: proposalManager,
    tools: createFileTools({ proposals: proposalStore }),
    audit,
  });

  const app = createCoreApp({
    port: config.port,
    demo: config.demo,
    version: config.version,
    schemaVersion: config.schemaVersion,
    hostAllowlist: config.hostAllowlist,
    staticDir: config.staticDir,
    pairing,
    sessions,
    audit,
    providers: config.demo ? [demoProvider()] : [],
    providerManager,
    broker,
  });

  return {
    config,
    db,
    keychain,
    pairing,
    sessions,
    audit,
    providerStore,
    providerManager,
    broker,
    projectRootManager,
    grantManager,
    pendingManager,
    proposalManager,
    app,
    close(): void {
      try {
        db.close();
      } catch {
        // Already closed — ignore.
      }
    },
  };
}

function listen(app: Express, port: number, host: string): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, host, () => resolve(server));
    server.on('error', reject);
  });
}

/**
 * Build the core and bind the loopback HTTP server. Resolves once listening.
 */
export async function startServer(config: CoreConfig = loadConfig()): Promise<{ bundle: CoreBundle; server: Server }> {
  const bundle = createCore(config);
  const server = await listen(bundle.app, config.port, config.host);
  return { bundle, server };
}

async function main(): Promise<void> {
  const config = loadConfig();
  const { bundle, server } = await startServer(config);
  const demoHint = config.demo ? ' · dev pairing code: GET /v1/dev/pair-code' : ' · pair via tray code';
  console.log(
    `partner-core v${config.version} up on http://${config.host}:${config.port}` +
      ` demo=${config.demo ? 'on' : 'off'} schema=v${config.schemaVersion}${demoHint}`,
  );

  const shutdown = (signal: string): void => {
    console.log(`partner-core shutting down (${signal})`);
    server.close(() => {
      bundle.close();
      process.exit(0);
    });
    // Safety valve if keep-alive connections refuse to drain.
    setTimeout(() => process.exit(1), 5000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

// CLI entry guard: listen only when executed directly (tsx src/index.ts),
// never when imported (vitest, integration tests, web/shell packages).
const entryArg = process.argv[1];
if (entryArg !== undefined && import.meta.url === pathToFileURL(entryArg).href) {
  main().catch((err: unknown) => {
    console.error('partner-core failed to start:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
