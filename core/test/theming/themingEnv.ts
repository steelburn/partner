/**
 * Shared in-memory environment for M6 theme manager tests (core/test only):
 * ONE SQLite ':memory:' db with the v7 tables, the theme/persona/settings
 * row stores, the REAL persona manager (seeded with the eight starter
 * personas so resolution tests bind 'p-builder' etc.), the theme manager
 * (presets seeded) and a shared audit service with an injectable clock.
 * Tests never share state between cases.
 */
import type { Database } from 'better-sqlite3';
import { openDatabase } from '../../src/stores/db.js';
import { auditLog } from '../../src/services/redaction.js';
import type { AuditService } from '../../src/services/redaction.js';
import type { AuditStore, PersonaStore, SettingsStore, ThemeStore } from '../../src/stores/types.js';
import {
  createAuditStore,
  createPersonaStore,
  createSettingsStore,
  createThemeStore,
} from '../../src/stores/db.js';
import { createPersonaManager } from '../../src/personas/manager.js';
import type { PersonaManager } from '../../src/personas/manager.js';
import { createThemeManager } from '../../src/theming/index.js';
import type { ThemeManager } from '../../src/theming/index.js';

export interface ThemingTestEnv {
  db: Database;
  auditStore: AuditStore;
  audit: AuditService;
  stores: {
    themes: ThemeStore;
    personas: PersonaStore;
    settings: SettingsStore;
  };
  personas: PersonaManager;
  themes: ThemeManager;
  close(): void;
}

export interface ThemingTestOptions {
  /** Fixed clock; default real time. */
  now?: () => number;
}

/** Fresh managers over ONE in-memory db with a shared audit + clock. */
export function makeThemingEnv(optionsIn: ThemingTestOptions = {}): ThemingTestEnv {
  const now = optionsIn.now;
  const db = openDatabase(':memory:');
  const auditStore = createAuditStore(db);
  const audit = auditLog({ store: auditStore, ...(now !== undefined ? { now } : {}) });
  const stores = {
    themes: createThemeStore(db),
    personas: createPersonaStore(db),
    settings: createSettingsStore(db),
  };
  // The REAL persona manager (M3) seeds the eight starters; binding tests
  // target the seeded 'p-builder' row.
  const personas = createPersonaManager({ store: stores.personas, audit });
  personas.seedIfEmpty();
  const themes = createThemeManager({
    store: stores.themes,
    personaStore: stores.personas,
    settings: stores.settings,
    audit,
    now,
  });
  themes.seedIfEmpty();
  return {
    db,
    auditStore,
    audit,
    stores,
    personas,
    themes,
    close(): void {
      db.close();
    },
  };
}
