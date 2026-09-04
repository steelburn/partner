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
import { fileURLToPath } from 'node:url';
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
import type { EpisodeManager } from '../src/memory/episodes.js';
import type { NoteManager } from '../src/notes/index.js';
import { createNoteManager } from '../src/notes/index.js';
import type { PlanManager } from '../src/plans/index.js';
import { createPlanManager } from '../src/plans/index.js';
import type { ProfileManager } from '../src/memory/profile.js';
import type { ThemeManager } from '../src/theming/index.js';
import { createThemeManager } from '../src/theming/index.js';
import { createSiteScopeManager } from '../src/browser/scopes.js';
import type { SiteScopeManager } from '../src/browser/scopes.js';
import { FILE_TOOL_IDS } from '../src/files/tools.js';
import { createSkillManager } from '../src/skills/manager.js';
import type { SkillManager } from '../src/skills/manager.js';
import { createSkillRunner } from '../src/skills/runner.js';
import type { SkillRunner } from '../src/skills/runner.js';
import { createPersonaManager } from '../src/personas/manager.js';
import type { PersonaManager } from '../src/personas/manager.js';
import { createConversationManager } from '../src/conversations/manager.js';
import type { ConversationManager } from '../src/conversations/manager.js';
import { createMemoryBundle, createSummarizeResolver } from '../src/memory/index.js';
import type { MemoryBundle } from '../src/memory/index.js';
import {
  createAuditStore,
  createConversationStore,
  createEpisodeStore,
  createFileProposalStore,
  createGrantStore,
  createMemoryFtsStore,
  createMessageStore,
  createNoteLinkStore,
  createNoteStore,
  createNotesFtsStore,
  createPairingStore,
  createPendingToolStore,
  createPersonaStore,
  createPlanStore,
  createProfileStore,
  createProjectRootStore,
  createProviderStore,
  createSessionStore,
  createSettingsStore,
  createSiteScopeStore,
  createSkillInvocationStore,
  createSkillStore,
  createThemeStore,
  openDatabase,
} from '../src/stores/db.js';
import type {
  AuditStore,
  ConversationStore,
  EpisodeStore,
  FileProposalStore,
  GrantStore,
  MemoryFtsStore,
  MessageStore,
  NoteLinkStore,
  NoteStore,
  NotesFtsStore,
  PairingStore,
  PendingToolStore,
  PersonaStore,
  PlanStore,
  ProfileEntryStore,
  ProjectRootStore,
  ProviderStore,
  SessionStore,
  SettingsStore,
  SiteScopeStore,
  SkillInvocationStore,
  SkillStore,
  ThemeStore,
} from '../src/stores/types.js';

export const ALLOWED_HOST = '127.0.0.1:4390';
export const ALTERNATE_HOST = 'localhost:4390';
export const ALLOWLIST = [ALLOWED_HOST, ALTERNATE_HOST];

/** The repo's checked-in sample catalog (skills-catalog/ at the repo root). */
export const REPO_CATALOG = fileURLToPath(new URL('../../skills-catalog/', import.meta.url));

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
  /**
   * Wire the M4 memory managers over the same db (default true). Summarize
   * runs in demo mode (placeholder) because the demo harness registers no
   * usable chat provider by default.
   */
  memory?: boolean;
  /**
   * Wire the M5 notes + plans managers over the same db (default true). The
   * stores live on the harness for row-level assertions; demo mode makes
   * daily summarize write the deterministic placeholder.
   */
  notesPlans?: boolean;
  /**
   * Wire the M6 theme manager over the same db (default true). Presets seed
   * when the themes table is empty; theme routes 501 when disabled.
   */
  themes?: boolean;
  /**
   * Wire the M7 site-scope manager over the same db (default true). The
   * browser scope/policy routes 501 when disabled.
   */
  browser?: boolean;
  /**
   * Wire the M8 skills manager + runner over the same db (default true) with
   * a TEMP store dir (removed in close()) and a catalog that defaults to the
   * repo's skills-catalog/. Pass false for the 501 not_configured surface;
   * pass an object to point storeDir/catalogDir elsewhere.
   */
  skills?: boolean | { storeDir?: string; catalogDir?: string };
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
  /** M4 memory stores + managers over the SAME db (default on). */
  profileStore: ProfileEntryStore;
  episodeStore: EpisodeStore;
  memoryFtsStore: MemoryFtsStore;
  memory?: MemoryBundle;
  profile?: ProfileManager;
  episodes?: EpisodeManager;
  /** M5 notes + plans managers + stores over the SAME db (default on). */
  noteStore: NoteStore;
  noteLinkStore: NoteLinkStore;
  planStore: PlanStore;
  notesFtsStore: NotesFtsStore;
  notes?: NoteManager;
  plans?: PlanManager;
  /** M6 theme manager + stores over the SAME db (default on). */
  themeStore: ThemeStore;
  settingsStore: SettingsStore;
  themes?: ThemeManager;
  /** M7 site-scope manager + store over the SAME db (default on). */
  scopeStore: SiteScopeStore;
  scopes?: SiteScopeManager;
  /** M8 skills manager + runner + stores over the SAME db (default on). */
  skillStore: SkillStore;
  skillInvocationStore: SkillInvocationStore;
  skills?: SkillManager;
  skillRunner?: SkillRunner;
  close(): void;
}

export function demoHarness(options: HarnessOptions = {}): Harness {
  const demo = options.demo ?? true;
  const brokerEnabled = options.broker ?? true;
  const personasEnabled = options.personas ?? true;
  const memoryEnabled = options.memory ?? true;
  const notesPlansEnabled = options.notesPlans ?? true;
  const themesEnabled = options.themes ?? true;
  const browserEnabled = options.browser ?? true;
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

  // M4: memory stores + managers over the same db (default on). The resolver
  // mirrors createCore (persona -> provider manager) but the demo harness
  // registers no provider, so non-demo summarize falls back to the
  // deterministic placeholder unless a test registers a provider + keys.
  const profileStore = createProfileStore(db);
  const episodeStore = createEpisodeStore(db);
  const memoryFtsStore = createMemoryFtsStore(db);
  let memory: MemoryBundle | undefined;
  let profile: ProfileManager | undefined;
  let episodes: EpisodeManager | undefined;
  if (memoryEnabled) {
    // Mirror createCore's resolver: the conversation's persona routes through
    // the provider manager. Demo mode short-circuits to placeholders before
    // the resolver runs, so the demo harness needs no registered provider.
    memory = createMemoryBundle({
      stores: { profile: profileStore, episodes: episodeStore, fts: memoryFtsStore },
      conversations,
      audit,
      demo,
      providerResolver: createSummarizeResolver({
        personas,
        providers: providerManager,
      }),
    });
    profile = memory.profile;
    episodes = memory.episodes;
  }

  // M5: notes + plans managers over the same db (default on). Stores exist on
  // every harness so row-level assertions are possible; managers + routes are
  // wired unless notesPlans: false (the 501 not_configured case). Demo mode
  // makes daily summarize write the deterministic placeholder.
  const noteStore = createNoteStore(db);
  const noteLinkStore = createNoteLinkStore(db);
  const planStore = createPlanStore(db);
  const notesFtsStore = createNotesFtsStore(db);
  let notes: NoteManager | undefined;
  let plans: PlanManager | undefined;
  if (notesPlansEnabled) {
    notes = createNoteManager({
      stores: { notes: noteStore, links: noteLinkStore, fts: notesFtsStore },
      audit,
      demo,
    });
    plans = createPlanManager({
      stores: { plans: planStore, fts: notesFtsStore },
      audit,
    });
  }

  // M6: theme manager + stores over the same db (default on). Preset rows
  // seed only when the themes table is empty; settings hold the global
  // active_theme key and the persona store's colorTheme column is the
  // per-persona override. Managers + routes are wired unless themes: false
  // (the 501 not_configured case).
  const themeStore = createThemeStore(db);
  const settingsStore = createSettingsStore(db);
  let themes: ThemeManager | undefined;
  if (themesEnabled) {
    themes = createThemeManager({
      store: themeStore,
      personaStore,
      settings: settingsStore,
      audit,
    });
    themes.seedIfEmpty();
  }

  // M7: site-scope manager + store over the same db (default on). The store
  // exists on every harness for row-level assertions; the manager + routes
  // are wired unless browser: false (the 501 not_configured case).
  const scopeStore = createSiteScopeStore(db);
  let scopes: SiteScopeManager | undefined;
  if (browserEnabled) {
    scopes = createSiteScopeManager({ store: scopeStore, audit });
  }

  // M8: skills manager + runner over the same db (default on). Installed
  // code lands in a TEMP store dir (removed in close()); the catalog defaults
  // to the repo's checked-in skills-catalog/ so install/invoke flows run
  // against the real sample skills. The runner needs the broker (skill tool
  // requests are broker-mediated), so skills are only wired when the broker
  // is — pass skills: false for the 501 not_configured surface.
  const skillStore = createSkillStore(db);
  const skillInvocationStore = createSkillInvocationStore(db);
  const skillsEnabled = options.skills !== false;
  const skillsOption =
    typeof options.skills === 'object' && options.skills !== null ? options.skills : {};
  let skillsDir: string | undefined;
  let skills: SkillManager | undefined;
  let skillRunner: SkillRunner | undefined;
  if (skillsEnabled && brokerEnabled) {
    skillsDir = skillsOption.storeDir ?? makeTempRoot();
    const catalogDir = skillsOption.catalogDir ?? REPO_CATALOG;
    // The broker registry is the six files.* manifests in v1; FILE_TOOL_IDS
    // mirrors it so the harness needs no back-reference to the broker.
    const registry = new Set<string>(FILE_TOOL_IDS);
    skills = createSkillManager({
      store: skillStore,
      invocations: skillInvocationStore,
      storeDir: skillsDir,
      catalogDir,
      tools: registry,
      audit,
    });
    skillRunner = createSkillRunner({
      dataDir: skillsDir,
      broker: broker as ToolBroker,
      audit,
      invocations: skillInvocationStore,
    });
  }

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
    ...(memoryEnabled ? { memory } : {}),
    ...(notesPlansEnabled ? { notes, plans } : {}),
    ...(themesEnabled ? { themes } : {}),
    ...(browserEnabled ? { scopes } : {}),
    ...(skills && skillRunner ? { skills, skillRunner } : {}),
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
    profileStore,
    episodeStore,
    memoryFtsStore,
    memory,
    profile,
    episodes,
    noteStore,
    noteLinkStore,
    planStore,
    notesFtsStore,
    notes,
    plans,
    themeStore,
    settingsStore,
    themes,
    scopeStore,
    scopes,
    skillStore,
    skillInvocationStore,
    skills,
    skillRunner,
    close(): void {
      db.close();
      if (skillsDir !== undefined) removeTempRoot(skillsDir);
    },
  };
}

/** Recursively remove a {@link makeTempRoot} directory (test teardown). */
export function removeTempRoot(path: string): void {
  rmSync(path, { recursive: true, force: true });
}
