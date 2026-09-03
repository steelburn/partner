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
  createPairingStore,
  createSessionStore,
  createSettingsStore,
  openDatabase,
} from './stores/db.js';
export type {
  AuditRow,
  AuditStore,
  PairingRow,
  PairingStore,
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

// ---- http server -----------------------------------------------------------
export { createCoreApp } from './http/server.js';
export type { CoreAppOptions } from './http/server.js';

import { loadConfig } from './config.js';
import type { CoreConfig } from './config.js';
import { openDatabase, createPairingStore, createSessionStore, createAuditStore } from './stores/db.js';
import { createKeychainFake, createKeychainNative } from './keychain/keychain.js';
import { createPairingManager } from './http/pairing.js';
import type { PairingManager } from './http/pairing.js';
import { createSessionManager } from './http/session.js';
import type { SessionManager } from './http/session.js';
import { auditLog } from './services/redaction.js';
import type { AuditService } from './services/redaction.js';
import { demoProvider } from './gateway/demo.js';
import { createCoreApp } from './http/server.js';

export interface CoreBundle {
  config: CoreConfig;
  db: Database;
  keychain: Keychain;
  pairing: PairingManager;
  sessions: SessionManager;
  audit: AuditService;
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

  const app = createCoreApp({
    port: config.port,
    demo: config.demo,
    version: config.version,
    schemaVersion: config.schemaVersion,
    hostAllowlist: config.hostAllowlist,
    pairing,
    sessions,
    audit,
    providers: config.demo ? [demoProvider()] : [],
  });

  return {
    config,
    db,
    keychain,
    pairing,
    sessions,
    audit,
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
