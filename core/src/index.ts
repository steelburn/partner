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
  assertFts5,
} from './stores/db.js';
export type {
  AuditRow,
  AuditStore,
  ConversationRow,
  ConversationRowPatch,
  ConversationStore,
  EpisodeRow,
  EpisodeRowPatch,
  EpisodeStore,
  FileProposalRow,
  FileProposalStore,
  GrantRow,
  GrantStore,
  MemoryFtsHit,
  MemoryFtsStore,
  MemoryRefKind,
  MessageRow,
  MessageStore,
  NoteLinkRow,
  NoteLinkStore,
  NoteRow,
  NoteRowPatch,
  NoteStore,
  NotesFtsHit,
  NotesFtsKind,
  NotesFtsStore,
  PairingRow,
  PairingStore,
  PendingToolRow,
  PendingToolStore,
  PersonaRow,
  PersonaRowPatch,
  PersonaStore,
  PlanRow,
  PlanRowPatch,
  PlanStore,
  ProfileEntryRow,
  ProfileEntryRowPatch,
  ProfileEntryStore,
  ProjectRootRow,
  ProjectRootStore,
  ProviderRow,
  ProviderRowPatch,
  ProviderStore,
  SessionRow,
  SessionStore,
  SettingsRow,
  SettingsStore,
  SiteScopeStore,
  SkillInvocationRow,
  SkillInvocationStore,
  SkillRow,
  SkillRowPatch,
  SkillStore,
  ThemeRow,
  ThemeRowPatch,
  ThemeStore,
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
export { resolveChatModel, resolveChatProvider } from './gateway/resolver.js';
export type { ResolveChatModelOptions, ResolvedChatModel } from './gateway/resolver.js';
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

// ---- M3 personas + conversations ------------------------------------------
export { createPersonaManager } from './personas/manager.js';
export type {
  PersonaDraft,
  PersonaManager,
  PersonaManagerOptions,
  PersonaPatch,
} from './personas/manager.js';
export { PersonaError } from './personas/errors.js';
export type { PersonaErrorCode } from './personas/errors.js';
export { createConversationManager } from './conversations/manager.js';
export type {
  AppendRole,
  ConversationAppendInput,
  ConversationDetail,
  ConversationManager,
  ConversationManagerOptions,
} from './conversations/manager.js';
export { ConversationError } from './conversations/errors.js';
export type { ConversationErrorCode } from './conversations/errors.js';

// ---- M4 memory (profile, episodes, search, forget, export/import, tailor) --
export {
  createMemoryBundle,
  createSummarizeResolver,
  MemoryError,
  memoryError,
  memoryErrorStatus,
} from './memory/index.js';
export type {
  MemoryBundle,
  MemoryImportCounts,
  MemoryTransferManager,
  MemoryWiringOptions,
} from './memory/index.js';
export { createProfileManager, normalizeProfileInput } from './memory/profile.js';
export type { ProfileEntryPatch, ProfileListOptions, ProfileManager, ProfileManagerOptions } from './memory/profile.js';
export { createEpisodeManager } from './memory/episodes.js';
export type { EpisodeManager, EpisodeManagerOptions, SummarizeTarget } from './memory/episodes.js';
export { createSearchManager, escapeFtsQuery } from './memory/search.js';
export type { SearchManager } from './memory/search.js';
export { createMemoryForgetManager, parseBeforeCutoff } from './memory/forget.js';
export type { MemoryForgetManager, MemoryForgetResult } from './memory/forget.js';
export { createMemoryTransferManager } from './memory/transfer.js';
export { buildTailoring } from './memory/tailor.js';

// ---- M5 notes + plans (PLAN-M5.md) -----------------------------------------
export { createNoteManager, parseWikiLinks, noteSearchText, stripDailySummarySection, demoDailySummary, createDailySummarizeResolver } from './notes/index.js';
export type { NoteManager, NoteManagerOptions, NotePatch } from './notes/index.js';
export { NoteError, noteError, noteErrorStatus } from './notes/index.js';
export type { NoteErrorCode } from './notes/index.js';
export { createPlanManager, validateDocument, planSearchText } from './plans/index.js';
export type { PlanManager, PlanManagerOptions, PlanPatch, PlanExportBundle } from './plans/index.js';
export { PlanError, planError, planErrorStatus } from './plans/index.js';
export type { PlanErrorCode } from './plans/index.js';

// ---- M6 theming (PLAN-M6.md) ---------------------------------------------
export { createThemeManager, ACTIVE_THEME_KEY } from './theming/index.js';
export type { ThemeManager, ThemeManagerOptions } from './theming/index.js';
export { ThemeError, themeError, themeErrorStatus } from './theming/index.js';
export type { ThemeErrorCode } from './theming/index.js';
export {
  apcaLc,
  wcagRatio,
  parseHex,
  relativeLuminance,
  lintTokens,
  contrastReport,
  validateTheme,
  THEME_TOKEN_KEYS,
  MIN_APCA_LC,
  MIN_WCAG_RATIO,
} from './theming/index.js';
export {
  PRESET_DEFAULT,
  PRESET_MIDNIGHT,
  THEME_PRESETS,
  PRESET_IDS,
  presetProfile,
} from './theming/index.js';
export type { ThemePreset } from './theming/index.js';

// ---- M8 skills (PLAN-M8.md) ----------------------------------------------
export { createSkillManager } from './skills/manager.js';
export type { SkillManager, SkillManagerOptions } from './skills/manager.js';
export { createSkillRunner } from './skills/runner.js';
export type {
  SkillInvokeContext,
  SkillInvokeErrorCode,
  SkillInvokeFailure,
  SkillInvokeOk,
  SkillInvokeResult,
  SkillRunner,
  SkillRunnerOptions,
} from './skills/runner.js';
export { SkillError, skillError, skillErrorStatus } from './skills/errors.js';
export type { SkillErrorCode } from './skills/errors.js';
export {
  readCatalog,
  loadCatalogSkill,
  validateManifestShape,
  defaultToolRegistry,
} from './skills/catalog.js';
export type {
  CatalogReadOptions,
  CatalogReadResult,
  LoadedCatalogSkill,
  ManifestValidation,
} from './skills/catalog.js';

// ---- M7 browser site scopes + native messaging (PLAN-M7.md) ----------------
export {
  createSiteScopeManager,
  normalizeOrigin,
  isBlockedHost,
  SITE_BLOCKLIST,
  SITE_SCOPES,
  CAPTURE_SCOPES,
} from './browser/scopes.js';
export type { SiteScopeManager, SiteScopeManagerOptions } from './browser/scopes.js';
export { BrowserError, browserError, browserErrorStatus } from './browser/errors.js';
export type { BrowserErrorCode } from './browser/errors.js';
export {
  createNativeSession,
  demoAnalyzeReply,
  readFrame,
  writeFrame,
  ANALYZE_CHAR_BUDGET,
  ANALYZE_SELECTION_PREVIEW_CHARS,
  ANALYZE_SYSTEM_PROMPT,
} from './native/index.js';
export type {
  NativeSessionDeps,
  NativeSessionIo,
  NativeSessionResult,
  NmCommandError,
} from './native/index.js';
export { MAX_FRAME_BYTES, NmError, nmError } from './native/index.js';
export type { NmErrorCode } from './native/index.js';

// ---- http server -----------------------------------------------------------
export { createCoreApp } from './http/server.js';
export type { CoreAppOptions } from './http/server.js';
export type { ChatDoneMetaEvent, ServerChatEvent } from './http/server.js';

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
  createPersonaStore,
  createConversationStore,
  createMessageStore,
  createProfileStore,
  createEpisodeStore,
  createMemoryFtsStore,
  createSettingsStore,
  createSiteScopeStore,
  createSkillInvocationStore,
  createSkillStore,
  createThemeStore,
} from './stores/db.js';
import type {
  ConversationStore,
  EpisodeStore,
  MemoryFtsStore,
  MessageStore,
  NoteLinkStore,
  NoteStore,
  NotesFtsStore,
  PersonaStore,
  PlanStore,
  ProfileEntryStore,
  ProviderStore,
  SettingsStore,
  SiteScopeStore,
  SkillInvocationStore,
  SkillStore,
  ThemeStore,
} from './stores/types.js';
import { createPersonaManager } from './personas/manager.js';
import type { PersonaManager } from './personas/manager.js';
import { createConversationManager } from './conversations/manager.js';
import type { ConversationManager } from './conversations/manager.js';
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
import { createMemoryBundle, createSummarizeResolver } from './memory/index.js';
import type { MemoryBundle } from './memory/index.js';
import { createNoteManager, createDailySummarizeResolver } from './notes/index.js';
import type { NoteManager } from './notes/index.js';
import { createPlanManager } from './plans/index.js';
import type { PlanManager } from './plans/index.js';
import { createThemeManager } from './theming/index.js';
import type { ThemeManager } from './theming/index.js';
import { createSiteScopeManager } from './browser/scopes.js';
import type { SiteScopeManager } from './browser/scopes.js';
import { createNativeSession } from './native/index.js';
import type { NativeSessionDeps } from './native/index.js';
import { createSkillManager } from './skills/manager.js';
import type { SkillManager } from './skills/manager.js';
import { createSkillRunner } from './skills/runner.js';
import type { SkillRunner } from './skills/runner.js';
import {
  createNoteLinkStore,
  createNoteStore,
  createNotesFtsStore,
  createPlanStore,
} from './stores/db.js';

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
  /** M3 persona manager + stores (wired on every core; seeded on boot). */
  personaManager: PersonaManager;
  personaStore: PersonaStore;
  conversationManager: ConversationManager;
  conversationStore: ConversationStore;
  messageStore: MessageStore;
  /** M4 memory managers + stores (wired on every core over the same db). */
  memory: MemoryBundle;
  profileStore: ProfileEntryStore;
  episodeStore: EpisodeStore;
  memoryFtsStore: MemoryFtsStore;
  /** M5 notes + plans managers + stores (PLAN-M5.md, schema v6). */
  notes: NoteManager;
  plans: PlanManager;
  noteStore: NoteStore;
  noteLinkStore: NoteLinkStore;
  planStore: PlanStore;
  notesFtsStore: NotesFtsStore;
  /** M6 theme manager + store + settings store (schema v7). */
  themes: ThemeManager;
  themeStore: ThemeStore;
  settingsStore: SettingsStore;
  /** M7 site-scope manager + store (schema v8, PLAN-M7.md). */
  scopes: SiteScopeManager;
  scopeStore: SiteScopeStore;
  /** M8 skill manager + runner + stores (schema v9, PLAN-M8.md). */
  skills: SkillManager;
  skillRunner: SkillRunner;
  skillStore: SkillStore;
  skillInvocationStore: SkillInvocationStore;
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

  // M3: personas + conversations over the SAME db. The persona manager seeds
  // the EIGHT starter personas on first run (empty table only) so a fresh
  // core always boots with a default partner persona.
  const personaStore = createPersonaStore(db);
  const personaManager = createPersonaManager({ store: personaStore, audit });
  personaManager.seedIfEmpty();
  const conversationStore = createConversationStore(db);
  const messageStore = createMessageStore(db);
  const conversationManager = createConversationManager({
    personaStore,
    stores: { conversations: conversationStore, messages: messageStore },
    audit,
  });

  // M4: memory over the SAME db (schema v5). Summaries route through the
  // persona's resolved chat provider when a conversation has one and a
  // provider+model is usable; demo mode always writes placeholder summaries.
  const profileStore = createProfileStore(db);
  const episodeStore = createEpisodeStore(db);
  const memoryFtsStore = createMemoryFtsStore(db);
  const memory = createMemoryBundle({
    stores: { profile: profileStore, episodes: episodeStore, fts: memoryFtsStore },
    conversations: conversationManager,
    audit,
    demo: config.demo,
    providerResolver: createSummarizeResolver({
      personas: personaManager,
      providers: providerManager,
    }),
  });

  // M5: notes + plans over the SAME db (schema v6). Wiki-links/tags/daily/
  // export live in the note manager; document validation + task status in the
  // plan manager; both share the notes_fts mirror. Daily summaries route
  // through the first enabled provider's default model when one is usable;
  // demo mode always writes the deterministic placeholder.
  const noteStore = createNoteStore(db);
  const noteLinkStore = createNoteLinkStore(db);
  const planStore = createPlanStore(db);
  const notesFtsStore = createNotesFtsStore(db);
  const notes = createNoteManager({
    stores: { notes: noteStore, links: noteLinkStore, fts: notesFtsStore },
    audit,
    demo: config.demo,
    providerResolver: createDailySummarizeResolver({ providers: providerManager }),
  });
  const plans = createPlanManager({
    stores: { plans: planStore, fts: notesFtsStore },
    audit,
  });

  // M6: theming over the SAME db (schema v7). The two immutable preset rows
  // seed on first boot (empty table only); the persona store's colorTheme
  // column (M3) is the per-persona override and the settings store holds the
  // global active_theme key.
  const settingsStore = createSettingsStore(db);
  const themeStore = createThemeStore(db);
  const themes = createThemeManager({
    store: themeStore,
    personaStore,
    settings: settingsStore,
    audit,
  });
  themes.seedIfEmpty();

  // M7: per-origin browser scopes over the SAME db (schema v8). The store is
  // additive + idempotent; the manager resolves policy against the built-in
  // blocklist first (blocked origins immutable), then the stored scope, then
  // the default 'ask'. Only origins cross this surface — never page content.
  const scopeStore = createSiteScopeStore(db);
  const scopes = createSiteScopeManager({ store: scopeStore, audit });

  // M8: skills over the SAME db (schema v9). The manager owns the installed
  // lifecycle (catalog -> code copy under config.skillsDir -> row); the
  // runner spawns one worker per invoke and brokers tool requests with
  // requestedBy 'skill'. Config.skillsCatalogDir points at the checked-in
  // local catalog (repo skills-catalog/) — no remote gallery in M8.
  const skillStore = createSkillStore(db);
  const skillInvocationStore = createSkillInvocationStore(db);
  const skillRegistry: ReadonlySet<string> = new Set(broker.manifests.map((m) => m.id));
  const skills = createSkillManager({
    store: skillStore,
    invocations: skillInvocationStore,
    storeDir: config.skillsDir,
    catalogDir: config.skillsCatalogDir,
    tools: skillRegistry,
    audit,
  });
  const skillRunner = createSkillRunner({
    dataDir: config.skillsDir,
    broker,
    audit,
    invocations: skillInvocationStore,
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
    personaManager,
    conversationManager,
    memory,
    notes,
    plans,
    themes,
    scopes,
    skills,
    skillRunner,
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
    personaManager,
    personaStore,
    conversationManager,
    conversationStore,
    messageStore,
    memory,
    profileStore,
    episodeStore,
    memoryFtsStore,
    notes,
    plans,
    noteStore,
    noteLinkStore,
    planStore,
    notesFtsStore,
    themes,
    themeStore,
    settingsStore,
    scopes,
    scopeStore,
    skills,
    skillRunner,
    skillStore,
    skillInvocationStore,
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

  // M7 native-messaging mode: run the Chrome frame session over stdin/stdout
  // and do NOT start the HTTP server. stdout carries framed responses here,
  // so this branch never prints a banner or any other text to stdout.
  if (process.argv.includes('--native-messaging')) {
    const bundle = createCore(config);
    const deps: NativeSessionDeps = {
      version: bundle.config.version,
      demo: bundle.config.demo,
      schemaVersion: bundle.config.schemaVersion,
      pairing: bundle.pairing,
      scopes: bundle.scopes,
      personas: bundle.personaManager,
      providers: bundle.providerManager,
      audit: bundle.audit,
    };
    try {
      await createNativeSession(deps, { stdin: process.stdin, stdout: process.stdout });
    } finally {
      bundle.close();
      process.exit(0);
    }
    return;
  }

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

// CLI entry guard: listen only when executed directly (tsx src/index.ts, or a
// bundled CJS artifact whose import.meta.url is empty), never when imported
// (vitest, integration tests, web/shell packages).
const entryArg = process.argv[1];
const metaUrl = (import.meta as { url?: string }).url;
const isDirectEntry =
  entryArg !== undefined &&
  (metaUrl === undefined || metaUrl === '' || metaUrl === pathToFileURL(entryArg).href);
if (isDirectEntry) {
  main().catch((err: unknown) => {
    console.error('partner-core failed to start:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
