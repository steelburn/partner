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
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Server } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { Express } from 'express';
import type { Keychain } from '@partner/shared';
import { LEGACY_USER_ID } from '@partner/shared';
import Database from 'better-sqlite3';

// ---- config ----------------------------------------------------------------
export { CORE_VERSION, DEFAULT_DB_PATH, DEFAULT_HOST, DEFAULT_PORT, loadConfig } from './config.js';
export type { CoreConfig, CoreTlsConfig, KeychainKind } from './config.js';

// ---- users & credentials (M20-B S2/S2a, wired in M22) ---------------------
export { createUserManager, FIRST_USER_ID } from './users/manager.js';
export { createUserRails, partitionConfigFor } from './users/rails.js';
export { createUserPartitions } from './users/partition.js';
export { dbKeyAccount, ensureDbKey, DB_KEY_ACCOUNT } from './keychain/dbKey.js';
export { openEncryptedDatabase } from './stores/db.js';
export { userDbPath, userSkillsDir, usersRoot } from './users/paths.js';
export { LEGACY_USER_ID } from '@partner/shared';
export { createCredentialManager, SCRYPT_PARAMS } from './users/credentials.js';
export { createSystemStores } from './users/store.js';
export { openSystemDatabase, SYSTEM_KEY_ACCOUNT } from './system/db.js';
export { isClientClass, CLIENT_CLASSES, CLIENT_ENVELOPE } from './http/capabilities.js';

// ---- keychain --------------------------------------------------------------
export { createKeychainFake, createKeychainNative, KEYCHAIN_SERVICE } from './keychain/keychain.js';
export { createKeychainFile, keychainFileError } from './keychain/file.js';
export type { Keychain } from './keychain/keychain.js';

// ---- stores ----------------------------------------------------------------
export {
  createAuditStore,
  createConversationStore,
  createDeployProfileStore,
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
  createPlaybookRunStore,
  createProfileStore,
  createProjectRootStore,
  createProviderStore,
  createSessionStore,
  createSettingsStore,
  createSiteScopeStore,
  createSkillInvocationStore,
  createSkillStore,
  createSpendLedgerStore,
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
  DeployProfileRow,
  DeployProfileStore,
  ProviderRow,
  ProviderRowPatch,
  ProviderStore,
  SessionRow,
  SessionStore,
  SettingsRow,
  SettingsStore,
  SiteScopeStore,
  PlaybookRunPatch,
  PlaybookRunRow,
  PlaybookRunStore,
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
export type { TailoringPersona } from './memory/tailor.js';
export {
  createRememberManager,
  parseRememberReply,
  looksLikeSecret,
  REMEMBER_SYSTEM_PROMPT,
  REMEMBER_MAX_ITEMS,
  REMEMBER_VALUE_CAP,
  REMEMBER_EVIDENCE_CAP,
  REMEMBER_INPUT_CAP,
} from './memory/remember.js';
export type {
  RememberManager,
  RememberManagerOptions,
  RememberInput,
  RememberOutcome,
  RememberCandidate,
  RememberTarget,
} from './memory/remember.js';

// ---- M5 notes + plans (PLAN-M5.md) -----------------------------------------
export { createNoteManager, parseWikiLinks, noteSearchText, stripDailySummarySection, demoDailySummary, createDailySummarizeResolver } from './notes/index.js';
export { createBrainstormManager, buildBrainstormBundle, demoBrainstormReply, brainstormSetKey, BRAINSTORM_PERSONA_ID, BRAINSTORM_MAX_NOTES, BrainstormError, brainstormError, brainstormErrorStatus } from './notes/index.js';
export type { BrainstormManager, BrainstormManagerOptions, BrainstormErrorCode, BrainstormBundleResult } from './notes/index.js';
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
// ---- playbooks + deploy targets (M9) ---------------------------------------
export {
  createDeployManager,
  createPlaybookManager,
  createPlaybookProviderResolver,
  createToolLoop,
  listPlaybooks,
  playbookById,
  parseReplyTools,
  lastDirective,
  authorizeTool,
  summarizeToolResult,
  buildUserMessage,
  PlaybookError,
  playbookError,
  playbookErrorStatus,
  LOOP_MAX_ROUNDS,
  TOOL_RESULT_EXCERPT_CHARS,
  PLAYBOOKS,
} from './playbooks/index.js';
export type {
  DeployManager,
  DeployManagerOptions,
  DeployPackageInput,
  LoopEvent,
  LoopProviderResolver,
  LoopStatus,
  PbEvent,
  PbRunOutcome,
  PlaybookChatTarget,
  PlaybookManager,
  PlaybookManagerOptions,
  PreparedPlaybookRun,
  ToolLoop,
  ToolLoopDeps,
  ToolLoopResult,
  ToolLoopRunRequest,
} from './playbooks/index.js';

// ---- scheduled & autonomous work (M14, PLAN-M14.md) ------------------------
export {
  createScheduleManager,
  scheduleError,
  scheduleErrorStatus,
  ScheduleError,
} from './schedules/index.js';
export type {
  ScheduleManager,
  ScheduleManagerOptions,
  ScheduleRunReason,
  ScheduleRunView,
} from './schedules/index.js';
export { nextFire, partsAt, epochOfCivil } from './schedules/index.js';
export type { CivilParts } from './schedules/index.js';
export { createCoreApp } from './http/server.js';
export type { CoreAppOptions } from './http/server.js';
export type { ChatDoneMetaEvent, ServerChatEvent } from './http/server.js';

import { loadConfig } from './config.js';
import type { CoreConfig, CoreTlsConfig } from './config.js';
import {
  openDatabase,
  createPairingStore,
  createSessionStore,
  createAuditStore,
  createProviderStore,
  createFolderStore,
  createChatBlobStore,
  createAttachmentStore,
  createAssetStore,
  createMcpServerStore,
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
  createDeployProfileStore,
  createPlaybookRunStore,
  createScheduleRunStore,
  createSpendLedgerStore,
  openEncryptedDatabase,
} from './stores/db.js';
import type {
  ConversationStore,
  EpisodeStore,
  FolderStore,
  MemoryFtsStore,
  MessageStore,
  NoteFolderStore,
  NoteLinkStore,
  NoteStore,
  NoteVersionStore,
  NoteGraphStore,
  BrainstormSessionStore,
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
  DeployProfileStore,
  PlaybookRunStore,
} from './stores/types.js';
import { createPersonaManager } from './personas/manager.js';
import type { PersonaManager } from './personas/manager.js';
import { createConversationManager } from './conversations/manager.js';
import type { ConversationManager } from './conversations/manager.js';
import { createKeychainFake, createKeychainNative } from './keychain/keychain.js';
import { createKeychainFile, keychainFileError } from './keychain/file.js';
import { isDirectEntryPoint } from './entry.js';
import { rateLimitKeyFor } from './http/peer.js';
import { dbKeyAccount, ensureDbKey } from './keychain/dbKey.js';
import { userDbPath } from './users/paths.js';
import { createUserManager } from './users/manager.js';
import type { UserManager } from './users/manager.js';
import { createCredentialManager } from './users/credentials.js';
import type { CredentialManager } from './users/credentials.js';
import { createSystemStores, type SystemStores } from './users/store.js';
import { createUserRails } from './users/rails.js';
import { createKeyVault } from './users/unlock.js';
import { openSystemDatabase } from './system/db.js';
import { createPairingManager } from './http/pairing.js';
import type { PairingManager } from './http/pairing.js';
import { createSessionManager } from './http/session.js';
import type { SessionManager } from './http/session.js';
import { auditLog } from './services/redaction.js';
import type { AuditService } from './services/redaction.js';
import { demoProvider } from './gateway/demo.js';
import {
  createSpendLedgerManager,
  SPEND_WINDOW_MS,
} from './gateway/spend.js';
import type { SpendLedgerManager } from './gateway/spend.js';
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
import { createNoteManager, createDailySummarizeResolver, createBrainstormManager } from './notes/index.js';
import type { NoteManager, BrainstormManager } from './notes/index.js';
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
import { createFolderManager } from './folders/index.js';
import type { FolderManager } from './folders/index.js';
import { createAttachmentManager } from './attachments/index.js';
import type { AttachmentManager } from './attachments/index.js';
import { createAssetManager } from './assets/index.js';
import type { AssetManager } from './assets/index.js';
import { createMcpManager } from './mcp/index.js';
import type { McpManager } from './mcp/index.js';
import { createSearchManager } from './search/index.js';
import type { SearchManager } from './search/index.js';
import {
  createDeployManager,
  createPlaybookManager,
  createPlaybookProviderResolver,
  createToolLoop,
} from './playbooks/index.js';
import type { DeployManager, PlaybookManager } from './playbooks/index.js';
import { transportRefusal } from './net/tls.js';
import { createScheduleManager } from './schedules/index.js';
import type { ScheduleManager } from './schedules/index.js';
import type { ScheduleRunStore } from './stores/types.js';
import {
  createBrainstormSessionStore,
  createNoteLinkStore,
  createNoteStore,
  createNoteVersionStore,
  createNoteGraphStore,
  createNoteFolderStore,
  createNotesFtsStore,
  createPlanStore,
} from './stores/db.js';

export interface CoreBundle {
  config: CoreConfig;
  db: Database.Database;
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
  /** M11 F11 folder manager + store (chats organized into folders). */
  folders: FolderManager;
  folderStore: FolderStore;
  /** M17 note<->folder membership store (schema v16; shared tree). */
  noteFolderStore: NoteFolderStore;
  /** M11 F1 chat-attachment manager (uploads + blob content). */
  attachments: AttachmentManager;
  /** M11 F10 asset manager (saved response artifacts + note promotion). */
  assets: AssetManager;
  /** M11 F2 MCP manager (stdio client config + user tool calls). */
  mcp: McpManager;
  /** M11 F2 search manager (optional API-key search backend). */
  search: SearchManager;
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
  /** M16 F1/F3 stores (PLAN-M16.md, schema v14). */
  noteVersionStore: NoteVersionStore;
  noteGraphStore: NoteGraphStore;
  /** M16 follow-up brainstorm linkage store (schema v15). */
  brainstormSessionStore: BrainstormSessionStore;
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
  /** M9 playbook + deploy surfaces (schema v10, PLAN-M9.md). */
  playbooks: PlaybookManager;
  playbookRunStore: PlaybookRunStore;
  deployProfiles: DeployManager;
  deployProfileStore: DeployProfileStore;
  /** M14 scheduled & autonomous work (PLAN-M14.md, schema v13). */
  schedules: ScheduleManager;
  scheduleRunStore: ScheduleRunStore;
  /** M16 F2 brainstorm manager (PLAN-M16.md). */
  brainstorm: BrainstormManager;
  /** Scheduler driver handle (start/stop/tick; tests drive tick()). */
  scheduler: {
    start(): void;
    stop(): void;
    /** Fire due schedules now (used by the interval and tests). */
    tick(): Promise<string[]>;
  };
  app: Express;
  /** Close the SQLite handle (no-op safe after shutdown). */
  close(): void;
}

/**
 * The keychain a config asks for (M21). ONE place decides this, because the
 * database open and the app build must agree: they did not before, and a config
 * where they disagreed would encrypt the DB with one keychain and store provider
 * keys in another. `file` names its path in the failure so a container boot says
 * which mount is wrong.
 */
export function createConfiguredKeychain(config: CoreConfig): Keychain {
  switch (config.keychain) {
    case 'fake':
      return createKeychainFake();
    case 'file': {
      const path = config.keychainFile;
      if (path === undefined) {
        // config.ts refuses this combination; the guard keeps the invariant
        // here too, so a hand-built CoreConfig cannot skip it.
        throw new Error('KEYCHAIN_KIND=file requires KEYCHAIN_FILE');
      }
      try {
        return createKeychainFile(path);
      } catch (cause) {
        throw keychainFileError(cause, path);
      }
    }
    default:
      return createKeychainNative();
  }
}

/**
 * Open the core's database for a config: demo/:memory: stays plaintext; a
 * LIVE file database is opened whole-file-encrypted (M10 W1) with the
 * keychain-held cipher key (created on first use).
 *
 * M20-B S1: a boot with USER_ID opens THAT app user's partition — their own
 * encrypted file under `data/users/<userId>/` with their own cipher key —
 * while a boot without USER_ID keeps today's single-user path + account
 * byte-identical. Partitions are opened through the bounded per-user cache
 * (one open, reused; S3 owns the process-lifetime instance).
 */
async function openCoreDatabase(config: CoreConfig): Promise<Database.Database> {
  if (config.demo || config.dbPath === ':memory:') return openDatabase(config.dbPath);
  const keychain: Keychain = createConfiguredKeychain(config);
  if (config.userId !== undefined) {
    // A single-user boot needs exactly ONE partition handle, so open it directly
    // instead of through the bounded cache. A cache built per call and discarded
    // would leave the handle UNTRACKED — nothing could ever close it — while its
    // LRU bound and closeAll() claimed to be managing it. The process-lifetime
    // cache belongs to the multi-user wiring (N rails), where more than one
    // partition is open at once.
    //
    // Going through `userDbPath`/`dbKeyAccount` (not a hand-built path) is what
    // gives user #0 the LEGACY database and the legacy keychain account, so an
    // existing install keeps its data instead of opening an empty file.
    const keyHex = await ensureDbKey(keychain, dbKeyAccount(config.userId));
    return openEncryptedDatabase(userDbPath(config.dataRoot, config.userId), keyHex);
  }
  const keyHex = await ensureDbKey(keychain);
  return openEncryptedDatabase(config.dbPath, keyHex);
}

/**
 * Register the deployment-owned roots (M22) idempotently.
 *
 * IDEMPOTENT matters: grants reference a root BY ID, so a second boot must find
 * the existing row rather than insert a duplicate (the manager refuses a
 * duplicate canonical path with a typed `exists` error). The stored path is the
 * canonical one, so the lookup compares canonical paths.
 */
function applyFixedRoots(
  roots: ProjectRootManager,
  paths: readonly string[],
  readOnly = false,
): void {
  for (const raw of paths) {
    if (!existsSync(raw) || !statSync(raw).isDirectory()) {
      throw new Error(
        `FIXED_ROOTS: ${raw} is not an existing directory — mount it (compose) or ` +
          'fix the path; refusing to boot with a root the file tools cannot use',
      );
    }
    const canonical = realpathSync(raw);
    if (roots.list().some((root) => root.path === canonical)) continue;
    roots.add({ label: basename(canonical) || canonical, path: canonical, readOnly });
  }
}

/**
 * Build the full M0 core in-process (config -> app). Does NOT listen; call
 * {@link startServer} for the bound server. Live-mode file databases must
 * be opened encrypted first (pass the db from {@link openCoreDatabase});
 * demo/:memory: builds stay synchronous and untouched.
 */
/**
 * Build the core for ONE database. In login mode the listening app calls this
 * once per user (see users/rails.ts) — that is the whole of "multi-user": the
 * same single-user core, over each user's own file, key and skills directory.
 */
export function createCore(
  config: CoreConfig,
  db?: Database.Database,
  system?: SystemStores,
  appOptions?: {
    /** M22/R1: per-user partition delegation (login mode). */
    delegate?: (userId: string) => Promise<Express | 'partition_locked' | undefined>;
    /** M20-B S9: the key vault, so the account routes can unlock/lock. */
    auth?: { vault?: import('./http/server.js').CoreAuthOptions['vault'] };
    /**
     * M22 sign-up: the invite-secret manager, when the caller wants to own its
     * clock (a test proving expiry/lock) or its lifetime. Production passes
     * nothing — `signupMode`/`signupTtlMs` come from config, and the app then
     * creates the in-memory manager itself.
     */
    signupSecrets?: import('./http/pairSecret.js').PairSecretManager;
    /** Fixed-window budget for `POST /v1/auth/signup`, per network peer. */
    signupRateLimit?: { limit?: number; windowMs?: number };
    /**
     * M20-B S7 TEST SEAM: the network peer of a request. Injectable because a
     * hermetic test cannot dial the core from a non-loopback address, and the
     * value can only ever make a request look MORE remote (checked by
     * `isLoopbackPeer`).
     */
    peerAddress?: (req: import('express').Request) => string | undefined;
  },
): CoreBundle {
  if (db === undefined) {
    if (!config.demo && config.dbPath !== ':memory:') {
      throw new Error(
        'live-mode file databases must be opened encrypted — boot via startServer ' +
          '(openCoreDatabase), not createCore with a plaintext open',
      );
    }
    db = openDatabase(config.dbPath);
  }
  const keychain = createConfiguredKeychain(config);

  // M22: in LOGIN mode the pre-user tables MUST come from the system database
  // (`data/system.db`, keyed by `system-key`), because resolving and proving a
  // user cannot depend on a database that is chosen BY the user. A hand-built
  // call that forgets it would silently mint sessions against the wrong store,
  // so it is refused rather than defaulted.
  if (config.authMode === 'login' && system === undefined) {
    throw new Error(
      'AUTH_MODE=login requires the system database (users + credentials) — boot via ' +
        'startServer, which opens it with the `system-key` keychain account',
    );
  }

  const pairing = createPairingManager(system?.pairings ?? createPairingStore(db), {
    codeTtlMs: config.codeTtlMs,
    maxAttempts: config.maxAttempts,
    lockMs: config.lockMs,
    demo: config.demo,
  });
  const sessions = createSessionManager(system?.sessions ?? createSessionStore(db), {
    ttlMs: config.sessionTtlMs,
  });
  // M22 account managers. Present ONLY in login mode: pairing mode has no user
  // to resolve (the OS profile identifies the holder, §2a), and building these
  // over a store nobody reads would invite a route to trust them by accident.
  const users = system === undefined ? undefined : createUserManager({ store: system.users });
  const credentials =
    system === undefined ? undefined : createCredentialManager(system.credentials);
  const audit = auditLog({ store: createAuditStore(db) });
  // M10 cumulative spend ledger over the same db (PLAN-M10 W3).
  const spendLedger = createSpendLedgerManager({ store: createSpendLedgerStore(db) });

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
  // M22: a deployment may OWN the roots (a container volume mount). Register
  // them before anything can read the list, and fail the boot when one is not a
  // directory — a typo'd or unmounted path must not silently leave the file
  // tools with no reachable root (or, worse, "succeed" with an empty one).
  applyFixedRoots(projectRootManager, config.fixedRoots, config.fixedRootsReadOnly);
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

  // M11 F11: folders over the SAME db (schema v12). Conversations are the
  // edge owner; the folder manager uses the conversation manager for chat
  // counts and folder-delete reassignment. No seed — Inbox is folder NULL.
  // M17: the SAME tree also holds notes (note_folders membership, schema v16),
  // so the membership store is created first and handed to the folder manager
  // for noteCount + delete cleanup.
  const folderStore = createFolderStore(db);
  const noteFolderStore = createNoteFolderStore(db);
  const folders = createFolderManager({
    store: folderStore,
    conversations: conversationManager,
    noteFolders: noteFolderStore,
    audit,
  });

  // M11 F1: chat attachments over the SAME db (schema v12). Payload bytes
  // live in chat_blobs inside the encrypted DB; staged rows bind to turns.
  const attachments = createAttachmentManager({
    blobs: createChatBlobStore(db),
    maxBytes: config.maxUploadBytes,
    attachments: createAttachmentStore(db),
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
    // M19: automatic remember prefers the persona's cheap task class so
    // extraction does not burn the chat model on every turn.
    rememberResolver: createSummarizeResolver({
      personas: personaManager,
      providers: providerManager,
      taskClass: 'cheap',
    }),
  });

  // M5: notes + plans over the SAME db (schema v6). Wiki-links/tags/daily/
  // export live in the note manager; document validation + task status in the
  // plan manager; both share the notes_fts mirror. Daily summaries route
  // through the first enabled provider's default model when one is usable;
  // demo mode always writes the deterministic placeholder. M16 F1/F3 add the
  // note_versions snapshot store + the note_graph position store (schema
  // v14) — versioning hooks the manager's single mutation choke point.
  const noteStore = createNoteStore(db);
  const noteLinkStore = createNoteLinkStore(db);
  const noteVersionStore = createNoteVersionStore(db);
  const noteGraphStore = createNoteGraphStore(db);
  const brainstormSessionStore = createBrainstormSessionStore(db);
  const planStore = createPlanStore(db);
  const notesFtsStore = createNotesFtsStore(db);
  const notes = createNoteManager({
    stores: {
      notes: noteStore,
      links: noteLinkStore,
      fts: notesFtsStore,
      versions: noteVersionStore,
      graph: noteGraphStore,
      folders: noteFolderStore,
    },
    folderLookup: folders,
    audit,
    demo: config.demo,
    providerResolver: createDailySummarizeResolver({ providers: providerManager }),
  });
  const plans = createPlanManager({
    stores: { plans: planStore, fts: notesFtsStore },
    audit,
  });

  // M11 F10: assets over the SAME db (schema v12). Promotion bridges into
  // notes (F6): chat artifacts become notes with provenance headers.
  const assets = createAssetManager({
    store: createAssetStore(db),
    notes,
    audit,
  });

  // M11 F2 (slice 2): MCP stdio servers over the SAME db (schema v12).
  // Created OFF (default-deny); enable + user-initiated calls via /v1/mcp.
  const mcp = createMcpManager({
    store: createMcpServerStore(db),
    audit,
  });

  // M6: theming over the SAME db (schema v7). The two immutable preset rows
  // seed on first boot (empty table only); the persona store's colorTheme
  // column (M3) is the per-persona override and the settings store holds the
  // global active_theme key.
  const settingsStore = createSettingsStore(db);
  // M11 F2 search: optional API-key backend (config in settings, key in the
  // OS keychain, default-deny OFF). No schema change — schema v12 stands.
  const search = createSearchManager({
    settings: settingsStore,
    keychain,
    audit,
  });
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

  // M9: playbooks + deploy targets over the SAME db (schema v10). The deploy
  // manager owns profile CRUD validation + the package step; the playbook
  // manager orchestrates persona tool loops (broker-mediated, approval-queue
  // aware) over the registry's declarative summaries. The provider resolver
  // mirrors chat routing and keeps the demo provider OUT of live tool loops
  // (demo text playbooks still run against the deterministic provider).
  const deployProfileStore = createDeployProfileStore(db);
  const deployProfiles = createDeployManager({ store: deployProfileStore, audit });
  const playbookRunStore = createPlaybookRunStore(db);
  const playbookProviderResolver = createPlaybookProviderResolver({
    providers: providerManager,
    demo: config.demo,
  });
  const toolLoop = createToolLoop({
    broker,
    resolver: playbookProviderResolver,
    audit,
  });
  const playbooks = createPlaybookManager({
    broker,
    personas: personaManager,
    conversations: conversationManager,
    notes,
    runs: playbookRunStore,
    resolver: playbookProviderResolver,
    loop: toolLoop,
    audit,
  });

  // M14: schedules + scheduler driver over the SAME db (schema v13). Runs are
  // autonomous persona tool loops (the shared loop above) driven headlessly;
  // approvals decide into queued runs via tryResumeAfterDecision (wired as a
  // hook on the pending-decide route). Demo mode defaults to UTC so schedule
  // windows are deterministic; live mode uses the machine's local zone.
  const scheduleRunStore = createScheduleRunStore(db);
  const schedulerTz =
    config.schedulerTz ??
    (config.demo ? 'UTC' : Intl.DateTimeFormat().resolvedOptions().timeZone);
  const schedules = createScheduleManager({
    personas: personaManager,
    conversations: conversationManager,
    notes,
    runs: scheduleRunStore,
    loop: toolLoop,
    resolver: playbookProviderResolver,
    folders,
    audit,
    defaultTz: schedulerTz,
    // Tool envelope: advertise the directive grammar only when a run could
    // actually use broker tools — any ACTIVE user grant, or any persona
    // autoScope (persona-envelope consent). Deny-by-default is untouched: the
    // broker still refuses every execution without its own grant.
    canRunTools: () =>
      grantManager.list().length > 0 ||
      personaManager.list().some((persona) => (persona.independence.autoScopes ?? []).length > 0),
  });
  let schedulerTimer: ReturnType<typeof setInterval> | null = null;
  const scheduler = {
    start(): void {
      if (config.schedulerTickMs <= 0 || schedulerTimer !== null) return;
      schedulerTimer = setInterval(() => {
        void schedules.tick().catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          // eslint-disable-next-line no-console
          console.error(`[partner-core] scheduler tick failed: ${message}`);
        });
      }, config.schedulerTickMs);
      // Unref so a tick never keeps the process alive on its own.
      schedulerTimer.unref();
    },
    stop(): void {
      if (schedulerTimer !== null) {
        clearInterval(schedulerTimer);
        schedulerTimer = null;
      }
    },
    tick(): Promise<string[]> {
      return schedules.tick();
    },
  };

  // M16 F2: brainstorm orchestrator (PLAN-M16.md). Notes/captures bundle
  // into a conversation bound to the Brainstorming persona (seeded on
  // demand); the persona's first reply rides the same provider seam daily
  // summaries use (deterministic placeholder in demo).
  const brainstorm = createBrainstormManager({
    personas: personaManager,
    conversations: conversationManager,
    notes,
    folders,
    sessions: brainstormSessionStore,
    audit,
    demo: config.demo,
    providerResolver: createDailySummarizeResolver({ providers: providerManager }),
  });

  const app = createCoreApp({
    ...(appOptions ?? {}),
    port: config.port,
    demo: config.demo,
    version: config.version,
    schemaVersion: config.schemaVersion,
    hostAllowlist: config.hostAllowlist,
    staticDir: config.staticDir,
    // M22: the account lane (login) or the pairing ceremony (default).
    auth:
      config.authMode === 'login' && users !== undefined && credentials !== undefined
        ? {
            mode: 'login',
            users,
            capabilities: credentials,
            sessionClass: config.loginSessionClass,
            ...(appOptions?.auth ?? {}),
          }
        : { mode: config.authMode, ...(appOptions?.auth ?? {}) },
    loginRateLimit: config.loginRateLimit,
    // M22 sign-up: `off` unless the deployment opted into invite-gated
    // self-service (SIGNUP_MODE=invite + AUTH_MODE=login, enforced by loadConfig).
    signupMode: config.signupMode,
    signupTtlMs: config.signupTtlMs,
    maxJsonBytes: config.maxJsonBytes,
    // R7: the SAME number the attachment manager enforces, so the route's body
    // limit and the manager's cap cannot drift.
    maxUploadBytes: config.maxUploadBytes,
    // M22: a deployment-owned roots list makes the roots surface read-only.
    rootsFixed: config.fixedRoots.length > 0,
    // R4: the header is read only when the socket peer is a trusted proxy, and
    // it feeds the rate-limit buckets only (never locality).
    clientIp: (req) =>
      rateLimitKeyFor({
        peer: req.socket?.remoteAddress ?? undefined,
        headerValue:
          config.clientIpHeader === undefined ? undefined : req.headers[config.clientIpHeader],
        trustedCidrs: config.trustedProxyCidrs,
      }),
    deviceSecret: config.deviceSecret,
    bootNonce: config.bootNonce,
    // M20-B S7: the networked-pairing lane reads the transport facts from the
    // one place they are decided (S6): remote access gates the payload route
    // and the certificate fingerprint is the value a scanning device pins.
    remoteAccess: config.remoteAccess,
    tlsFingerprint: config.tls?.fingerprint,
    pairing,
    sessions,
    audit,
    spendLedger,
    providers: config.demo ? [demoProvider()] : [],
    providerManager,
    broker,
    personaManager,
    conversationManager,
    folders,
    attachments,
    assets,
    mcp,
    search,
    memory,
    notes,
    plans,
    themes,
    scopes,
    skills,
    skillRunner,
    playbooks,
    deployProfiles,
    schedules,
    brainstorm,
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
    folders,
    folderStore,
    noteFolderStore,
    attachments,
    assets,
    mcp,
    search,
    memory,
    profileStore,
    episodeStore,
    memoryFtsStore,
    notes,
    plans,
    noteStore,
    noteLinkStore,
    noteVersionStore,
    noteGraphStore,
    brainstormSessionStore,
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
    playbooks,
    playbookRunStore,
    deployProfiles,
    deployProfileStore,
    schedules,
    scheduleRunStore,
    brainstorm,
    scheduler,
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

function listen(
  app: Express,
  port: number,
  host: string,
  tls?: CoreTlsConfig,
): Promise<Server> {
  return new Promise((resolve, reject) => {
    // PLAN-M20-B S6: TLS configured ⇒ https. The material was loaded and
    // SAN-checked by config.ts; https needs the PEM itself, so it is read here
    // (a failure is a hard boot error, never a silent downgrade to plain
    // HTTP).
    const server =
      tls === undefined
        ? app.listen(port, host)
        : createHttpsServer(
            { cert: readFileSync(tls.certFile), key: readFileSync(tls.keyFile) },
            app,
          ).listen(port, host);
    // Readiness comes from the `listening` EVENT, not from `listen`'s callback:
    // on Windows (Node 25) that callback is ALSO invoked when the bind failed,
    // so the promise used to resolve with a server that was never listening —
    // the core printed "up on …" and served nothing, and a caller reading
    // `server.address()` got `null` instead of the EADDRINUSE it needed to see.
    // `error` is registered first so a failed bind can only reject.
    server.once('error', reject);
    server.once('listening', () => resolve(server));
  });
}

/**
 * M22: open the PRE-USER store set (users, credentials, pairings, sessions) for
 * a LOGIN-mode boot. `undefined` in pairing mode — the desktop shape keeps its
 * session/pairing tables in the main database, byte-identical to today.
 */
async function openSystemFor(
  config: CoreConfig,
  keychain: Keychain,
): Promise<{ stores: SystemStores; db: Database.Database } | undefined> {
  if (config.authMode !== 'login') return undefined;
  const db = await openSystemDatabase({ location: config.systemDbPath, keychain });
  return { stores: createSystemStores(db), db };
}

/**
 * M22: the ACCOUNT LANE as a public seam — the same keychain resolution and the
 * same system database the server boots with, so the operator CLI
 * (`docker/server/tools/user.mjs`) can create and rotate credentials without a
 * second, divergent spelling of "where does the user list live?".
 */
export async function openAccounts(config: CoreConfig = loadConfig()): Promise<{
  db: Database.Database;
  stores: SystemStores;
  users: UserManager;
  credentials: CredentialManager;
  close(): void;
}> {
  const keychain = createConfiguredKeychain(config);
  const db = await openSystemDatabase({ location: config.systemDbPath, keychain });
  const stores = createSystemStores(db);
  return {
    db,
    stores,
    users: createUserManager({ store: stores.users }),
    credentials: createCredentialManager(stores.credentials),
    close: () => db.close(),
  };
}

/**
 * Build the core and bind the listener — plain HTTP on `host` unless TLS is
 * configured (then HTTPS). Resolves once listening.
 */
export interface StartedServer {
  bundle: CoreBundle;
  server: Server;
  /**
   * M20-B S9 (login mode only): the account lane — the key vault and the
   * per-user rails. Exposed so an operator tool (and a test) can LOCK a user's
   * key, sweep idle partitions, or close one deliberately, without reaching into
   * this function's closure.
   */
  accounts?: { vault: ReturnType<typeof createKeyVault>; rails: ReturnType<typeof createUserRails> };
  /**
   * M22: whether any account exists. The boot hint has to say "sign in" or
   * "create the account" — the wrong one reads as a dead end, and only this
   * function can see the user table.
   */
  loginHasUsers?: boolean;
}

export async function startServer(config: CoreConfig = loadConfig()): Promise<StartedServer> {
  // M20-B S6 second line of defence: `loadConfig` already refuses a remote bind
  // without TLS, but `startServer` accepts an explicit `CoreConfig`, so a
  // hand-built one could otherwise put a PLAINTEXT listener on a non-loopback
  // host. Re-asserted here because the consequence (serving the whole API in
  // clear text) is not worth trusting a caller to have built correctly.
  const insecure = transportRefusal({ remote: config.remoteAccess === true, tls: config.tls !== undefined });
  if (insecure !== null) {
    throw new Error(
      `refusing to start: ${insecure.reason} — a non-loopback bind requires TLS ` +
        '(REMOTE_ACCESS=1 with TLS_CERT_FILE/TLS_KEY_FILE, or construct the config through loadConfig)',
    );
  }
  const keychain = createConfiguredKeychain(config);
  const system = await openSystemFor(config, keychain);
  // M22/R1: in login mode the listening app is a GATEWAY — it authenticates and
  // delegates every other /v1 request to the caller's own partition, so it needs
  // no file database of its own. (User #0's partition IS the legacy
  // `partner.db`, opened by the rails on their first request.)
  // M20-B S9: the per-user key vault (login mode only).
  const vault =
    system === undefined
      ? undefined
      : createKeyVault({
          keychain,
          wraps: system.stores.keyWraps,
          users: system.stores.users,
        });
  const rails =
    system === undefined
      ? undefined
      : createUserRails({
          config,
          system: system.stores,
          keychain,
          build: (cfg, partitionDb, stores) =>
            createCore(cfg, partitionDb as Database.Database, stores),
          maxOpen: config.partitionMaxOpen,
          idleMs: config.partitionIdleMs,
          ...(vault === undefined ? {} : { vault }),
        });
  // R1 data-safety guard: in login mode the listening app has no database of its
  // own, and a pre-partition database exists only for the FIRST user. One sitting
  // there with no user to own it would be silently orphaned by a partitioned boot,
  // so refuse and say what to do.
  if (rails !== undefined && system !== undefined && existsSync(config.dbPath)) {
    const anyUser = system.stores.users.list().length > 0;
    const ownerExists = system.stores.users.findById(LEGACY_USER_ID) !== undefined;
    if (anyUser && !ownerExists) {
      throw new Error(
        'login mode found an existing pre-partition database at ' +
          config.dbPath +
          " but no first user (id '" +
          LEGACY_USER_ID +
          "') to own it — refusing to boot rather than leave it unreadable. " +
          'Delete that file if it is scratch, or move it to the first user\'s partition ' +
          'directory and copy its keychain entry to the same name with the user id appended.',
      );
    }
  }
  const db =
    rails === undefined ? await openCoreDatabase(config) : openDatabase(':memory:');
  const bundle = createCore(
    config,
    db,
    system?.stores,
    rails === undefined
      ? undefined
      : {
          delegate: async (userId) => {
            // S9 first: no key, no partition. This is what makes a signed-out
            // user unreadable rather than merely unread.
            if (vault !== undefined && (await vault.keyFor(userId)) === undefined) {
              return 'partition_locked' as const;
            }
            return (await rails.coreFor(userId))?.app;
          },
          ...(vault === undefined ? {} : { auth: { vault } }),
        },
  );
  const server = await listen(bundle.app, config.port, config.host, config.tls);
  // M14: the scheduler heartbeat runs while the core listens (auto-stopped
  // on close so a shutdown never ticks a closed DB).
  // The gateway itself has no schedules; each OPEN partition runs its own.
  if (rails === undefined) bundle.scheduler.start();
  // R3: close partitions that have gone idle, so key material does not sit in
  // memory for a user who walked away. Unref'd: never keeps the process alive.
  const idleTimer =
    rails === undefined || config.partitionIdleMs <= 0
      ? undefined
      : setInterval(() => rails.sweep(), Math.max(30_000, Math.floor(config.partitionIdleMs / 4)));
  idleTimer?.unref();
  server.on('close', () => {
    if (idleTimer !== undefined) clearInterval(idleTimer);
    bundle.scheduler.stop();
    rails?.closeAll();
    system?.db.close();
  });
  return {
    bundle,
    server,
    ...(vault === undefined || rails === undefined ? {} : { accounts: { vault, rails } }),
    ...(system === undefined ? {} : { loginHasUsers: system.stores.users.list().length > 0 }),
  };
}

async function main(): Promise<void> {
  const config = loadConfig();

  // M7 native-messaging mode: run the Chrome frame session over stdin/stdout
  // and do NOT start the HTTP server. stdout carries framed responses here,
  // so this branch never prints a banner or any other text to stdout.
  if (process.argv.includes('--native-messaging')) {
    const db = await openCoreDatabase(config);
    const bundle = createCore(config, db, (await openSystemFor(config, createConfiguredKeychain(config)))?.stores);
    const deps: NativeSessionDeps = {
      version: bundle.config.version,
      demo: bundle.config.demo,
      schemaVersion: bundle.config.schemaVersion,
      pairing: bundle.pairing,
      scopes: bundle.scopes,
      personas: bundle.personaManager,
      providers: bundle.providerManager,
      audit: bundle.audit,
      themes: bundle.themes,
    };
    try {
      await createNativeSession(deps, { stdin: process.stdin, stdout: process.stdout });
    } finally {
      bundle.close();
      process.exit(0);
    }
    return;
  }

  const { bundle, server, loginHasUsers } = await startServer(config);
  // M15: the boot hint tells an operator where the pairing code comes from —
  // the demo seam, the shell device channel (tray), or nowhere (a bare live
  // core intentionally exposes no code surface).
  // M22: in LOGIN mode there is no code surface at all. Say which of the two
  // states applies — "create an account" or "sign in" — because the wrong one is
  // a dead end for whoever reads it (a fresh hosted core has no other way in).
  const pairHint =
    config.authMode === 'login'
      ? loginHasUsers === true
        ? ' · user login: sign in at the web UI'
        : config.signupMode === 'invite'
          ? ' · user login: no account yet — mint an invite with `node tools/signup-link.mjs`' +
            ' (or create one with `node tools/user.mjs add <name>`)'
          : ' · user login: create the account with `node tools/user.mjs add <name>`'
      : config.demo
        ? ' · dev pairing code: GET /v1/dev/pair-code'
        : config.deviceSecret !== undefined
          ? ' · device pairing: GET /v1/pair/device (shell tray)'
          : ' · no pairing code surface (boot inside the shell, or set PARTNER_DEVICE_SECRET)';
  console.log(
    `partner-core v${config.version} up on ${config.tls === undefined ? 'http' : 'https'}://${config.host}:${config.port}` +
      ` demo=${config.demo ? 'on' : 'off'} schema=v${config.schemaVersion}${pairHint}`,
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

  // M15 lifecycle: the desktop shell keeps this process's stdin pipe open and
  // sets PARTNER_PARENT_WATCH=1. When the shell dies — graceful quit, crash,
  // or force-kill — the OS closes the pipe write end, this stream emits 'end',
  // and the core exits itself. An orphaned core must never hold :4390 or the
  // encrypted DB lock after its shell is gone. Skipped for --native-messaging
  // (stdin carries the framed protocol there) and for plain core runs that
  // were not spawned by the shell (dev terminals, docker demo — their stdin
  // may be closed or a TTY from the start, so EOF is not a signal).
  if (process.env.PARTNER_PARENT_WATCH === '1' && !process.argv.includes('--native-messaging')) {
    let parentGone = false;
    const onParentExit = (): void => {
      if (parentGone) return;
      parentGone = true;
      shutdown('parent-exit');
    };
    process.stdin.resume();
    process.stdin.on('end', onParentExit);
    process.stdin.on('close', onParentExit);
    process.stdin.on('error', () => {
      /* EPIPE etc. — 'end'/'close' is the real signal; ignore. */
    });
  }
}

// CLI entry guard: listen only when THIS file was the entry point — never when
// imported (vitest, the operator CLI tools, web/shell packages). See
// ./entry.js for why "a bundled artifact always runs" was wrong.
if (
  isDirectEntryPoint({
    entryArg: process.argv[1],
    metaUrl: (import.meta as { url?: string }).url,
    selfFile: typeof __filename === 'string' ? __filename : undefined,
  })
) {
  main().catch((err: unknown) => {
    console.error('partner-core failed to start:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
