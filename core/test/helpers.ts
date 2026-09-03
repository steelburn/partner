/**
 * Shared in-memory test harness for the M0 spine (core/test only).
 *
 * Builds a fresh SQLite ':memory:' database, stores, managers, audit service
 * and Express app per call so tests never share state.
 */
import type { Express } from 'express';
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
import {
  createAuditStore,
  createPairingStore,
  createSessionStore,
  openDatabase,
} from '../src/stores/db.js';
import type { AuditStore, PairingStore, SessionStore } from '../src/stores/types.js';

export const ALLOWED_HOST = '127.0.0.1:4390';
export const ALTERNATE_HOST = 'localhost:4390';
export const ALLOWLIST = [ALLOWED_HOST, ALTERNATE_HOST];

export interface Harness {
  app: Express;
  db: ReturnType<typeof openDatabase>;
  pairing: PairingManager;
  sessions: SessionManager;
  audit: AuditService;
  pairingStore: PairingStore;
  sessionStore: SessionStore;
  auditStore: AuditStore;
  close(): void;
}

export function demoHarness(options: { demo?: boolean; pairing?: PairingOptions } = {}): Harness {
  const demo = options.demo ?? true;
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
  const app = createCoreApp({
    port: 4390,
    demo,
    version: CORE_VERSION,
    schemaVersion: SCHEMA_VERSION,
    hostAllowlist: ALLOWLIST,
    pairing,
    sessions,
    audit,
    providers: demo ? [demoProvider()] : [],
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
    close(): void {
      db.close();
    },
  };
}
