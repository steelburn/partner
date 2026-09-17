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
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { createServer } from 'node:net';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Express, Request } from 'express';
import type { Keychain, Persona, ToolRisk } from '@partner/shared';
import type { PlaybookChatTarget } from '../src/playbooks/index.js';
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
import { createSpendLedgerManager } from '../src/gateway/spend.js';
import type { SpendLedgerManager } from '../src/gateway/spend.js';
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
import type { NoteManager, DailySummarizeTarget } from '../src/notes/index.js';
import { createNoteManager } from '../src/notes/index.js';
import { createNotesTools } from '../src/tools/notes.js';
import { createBrainstormManager } from '../src/notes/index.js';
import type { BrainstormManager } from '../src/notes/index.js';
import type { PlanManager } from '../src/plans/index.js';
import { createPlanManager } from '../src/plans/index.js';
import type { ProfileManager } from '../src/memory/profile.js';
import type { ThemeManager } from '../src/theming/index.js';
import { createThemeManager } from '../src/theming/index.js';
import { createSiteScopeManager } from '../src/browser/scopes.js';
import type { SiteScopeManager } from '../src/browser/scopes.js';
import { FILE_TOOL_IDS } from '../src/files/tools.js';
import { TOOL_MANIFESTS } from '../src/broker/toolManifests.js';
import { createSkillManager } from '../src/skills/manager.js';
import type { SkillManager } from '../src/skills/manager.js';
import { createSkillDraftManager } from '../src/skills/drafts.js';
import { createFlowAiHook } from '../src/skills/flow/ai.js';
import { createSkillLlmResolver } from '../src/skills/llm.js';
import type { SkillGenerateHook } from '../src/skills/drafts.js';
import { createSkillRunner } from '../src/skills/runner.js';
import type { SkillRunner } from '../src/skills/runner.js';
import {
  createDeployManager,
  createPlaybookManager,
  createPlaybookProviderResolver,
  createToolLoop,
} from '../src/playbooks/index.js';
import type { DeployManager } from '../src/playbooks/deploy.js';
import type { PlaybookManager } from '../src/playbooks/manager.js';
import { createScheduleManager } from '../src/schedules/index.js';
import type { ScheduleManager } from '../src/schedules/index.js';
import { createPersonaManager } from '../src/personas/manager.js';
import type { PersonaManager } from '../src/personas/manager.js';
import { createConversationManager } from '../src/conversations/manager.js';
import type { ConversationManager } from '../src/conversations/manager.js';
import { createFolderManager } from '../src/folders/index.js';
import type { FolderManager } from '../src/folders/index.js';
import { createAttachmentManager } from '../src/attachments/index.js';
import type { AttachmentManager } from '../src/attachments/index.js';
import { createAssetManager } from '../src/assets/index.js';
import type { AssetManager } from '../src/assets/index.js';
import { createMcpManager } from '../src/mcp/index.js';
import { createMcpSkillReach } from '../src/mcp/index.js';
import type { McpManager } from '../src/mcp/index.js';
import { createSearchManager } from '../src/search/index.js';
import type { SearchManager } from '../src/search/index.js';
import { createMemoryBundle, createSummarizeResolver } from '../src/memory/index.js';
import type { MemoryBundle } from '../src/memory/index.js';
import {
  createAuditStore,
  createConversationStore,
  createDeployProfileStore,
  createFolderStore,
  createNoteFolderStore,
  createAttachmentStore,
  createAssetStore,
  createChatBlobStore,
  createMcpServerStore,
  createEpisodeStore,
  createFileProposalStore,
  createGrantStore,
  createMemoryFtsStore,
  createMessageStore,
  createNoteLinkStore,
  createNoteStore,
  createNoteVersionStore,
  createNoteGraphStore,
  createBrainstormSessionStore,
  createNotesFtsStore,
  createPairingStore,
  createPendingToolStore,
  createPersonaStore,
  createPlanStore,
  createPlaybookRunStore,
  createProfileStore,
  createProjectRootStore,
  createProviderStore,
  createScheduleRunStore,
  createSessionStore,
  createSettingsStore,
  createSiteScopeStore,
  createSkillDraftStore,
  createSkillInvocationStore,
  createSkillStore,
  createSpendLedgerStore,
  createThemeStore,
  openDatabase,
} from '../src/stores/db.js';
import type {
  AuditStore,
  ConversationStore,
  NoteVersionStore,
  NoteGraphStore,
  BrainstormSessionStore,
  DeployProfileStore,
  EpisodeStore,
  FileProposalStore,
  FolderStore,
  NoteFolderStore,
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
  PlaybookRunStore,
  ProfileEntryStore,
  ProjectRootStore,
  ProviderStore,
  ScheduleRunStore,
  SessionStore,
  SettingsStore,
  SiteScopeStore,
  SkillDraftStore,
  SkillInvocationStore,
  SkillStore,
  ThemeStore,
} from '../src/stores/types.js';

export const ALLOWED_HOST = '127.0.0.1:4390';
export const ALTERNATE_HOST = 'localhost:4390';
export const ALLOWLIST = [ALLOWED_HOST, ALTERNATE_HOST];

/**
 * M22/R7: the attachment upload wire shape, in ONE place so every test posts
 * what the SPA posts — the file bytes ARE the body, the content type is the
 * mime, and the name rides `x-attachment-name` percent-encoded (a filename is
 * user data and must not reach a URL).
 */
export function attachmentUploadHeaders(
  token: string,
  name: string,
  mime: string,
): Record<string, string> {
  return {
    Host: ALLOWED_HOST,
    Authorization: `Bearer ${token}`,
    'Content-Type': mime,
    'x-attachment-name': encodeURIComponent(name),
  };
}

/** The repo's checked-in sample catalog (skills-catalog/ at the repo root). */
export const REPO_CATALOG = fileURLToPath(new URL('../../skills-catalog/', import.meta.url));

/** A fresh real directory under the OS tmpdir (cleaned by the caller). */
export function makeTempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'partner-core-root-'));
}

/**
 * A port the OS says is free, released and returned for the caller to bind.
 *
 * Why not just `PORT=0`: the loopback allowlist is DERIVED from the configured
 * port (`127.0.0.1:<port>`), so a test that wants to SEND a request must name the
 * port it will listen on — an ephemeral bind would be allowlisted as
 * `127.0.0.1:0` and every request would be refused. `loadConfig` therefore
 * refuses `PORT=0` outright, and a test that needs a dynamic port asks for one
 * here (Node cannot transfer a port from one server to another, so there is a
 * nanosecond-wide window in which someone else could take it — which is fine:
 * a failed bind now REJECTS the boot instead of reporting a phantom core).
 */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (address === null || typeof address === 'string') {
        probe.close();
        reject(new Error('the OS handed back no port'));
        return;
      }
      probe.close(() => resolve(address.port));
    });
  });
}

/**
 * Close a listener and WAIT for it, dropping its connections first.
 *
 * `server.close()` alone waits for existing connections to end, so a keep-alive
 * socket left by a request keeps the callback from firing until `keepAlive
 * timeout` — which blew a 10s test hook on Windows and, because the hook aborted,
 * left the per-user SQLite handles open for the temp-dir cleanup to hit EPERM.
 * `closeAllConnections()` makes the close deterministic.
 */
export function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

export interface HarnessOptions {
  demo?: boolean;
  pairing?: PairingOptions;
  /** M20-B S7: simulate the request's network peer (e.g. a LAN address). */
  peer?: string | undefined;
  /**
   * M20-B S7: per-request peer resolver, for the realistic mixed case (the
   * secret is ISSUED from the machine and REDEEMED from the phone). Takes
   * precedence over `peer`.
   */
  peerAddress?: (req: Request) => string | undefined;
  /** M20-B S7: expose the QR/link payload route (config.remoteAccess). */
  remoteAccess?: boolean;
  /** M20-B S7: the pinned certificate fingerprint the payload carries. */
  tlsFingerprint?: string;
  /** M20-B S7: override the https core URL in the payload. */
  pairCoreUrl?: string;
  /** M20-B S7: fixed-window pair budget (limit/windowMs). */
  pairRateLimit?: { limit?: number; windowMs?: number };
  /** M22: the deployment owns the project roots, so /v1/roots is read-only. */
  rootsFixed?: boolean;
  /**
   * R7: tighten the per-attachment upload cap (bytes) for both the route's
   * body limit and the manager — the two are one value, and limit tests need
   * a cap small enough to exceed without pushing 8 MiB through a socket.
   */
  maxUploadBytes?: number;
  staticDir?: string;
  /** M15: enable the header-guarded /v1/pair/device channel with this secret. */
  deviceSecret?: string;
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
  /**
   * Wire the M9 playbook manager (registry + persona tool loop + run rows)
   * over the same db (default true; needs broker + personas + notes wired).
   * The provider resolver mirrors createCore — demo mode falls back to the
   * demo provider so TEXT playbooks run end-to-end. Pass false for the 501
   * not_configured surface.
   */
  playbooks?: boolean;
  /**
   * Override the playbook provider resolver (tests inject a scripted fake
   * provider to drive persona tool loops over HTTP). Falls back to the
   * demo/live resolver when omitted.
   */
  playbookProvider?: (persona: Persona) => PlaybookChatTarget | null;
  /**
   * Wire the M9 deploy-profile manager over the same db (default true). Pass
   * false for the 501 not_configured surface.
   */
  deployProfiles?: boolean;
  /**
   * Wire the M14 schedule manager over the same db (default true when
   * playbooks are wired — the schedule manager drives the SAME persona tool
   * loop). Pass false for the 501 not_configured surface.
   */
  schedules?: boolean;
  /**
   * M16 F2 brainstorm manager (wired when personas + notes are wired). The
   * demo harness writes the deterministic placeholder first reply; pass a
   * resolver to script a real provider turn.
   */
  brainstormProvider?: () => Promise<DailySummarizeTarget | null> | DailySummarizeTarget | null;
  /**
   * M26 cut B: the one-shot skill generator the drafts manager is built with.
   * ABSENT BY DEFAULT — no generator means `mode: 'generate'` is refused by
   * name, which is exactly what a build with no configured provider does.
   */
  skillDraftGenerator?: SkillGenerateHook;
  /**
   * M28 cut D: override the flow authoring model the drafts manager gets.
   * Default: `createFlowAiHook({ providers, demo })` — the same wiring the real
   * core uses, so a route test exercises the demo answers (and an injected fake
   * exercises a proposal that actually CHANGES the graph). `null` leaves it
   * unwired, which is the only way to reach the "no flow model" refusals.
   */
  skillFlowAi?: import('../src/skills/flow/ai.js').FlowAiHook | null;
  /**
   * M26 cut E: wire the skill RUNNER into the drafts manager (default true).
   * Pass false to leave the manager without a sandbox, which is the only way to
   * reach the dry-run's typed "no runner wired" refusal.
   */
  skillDraftRunner?: boolean;
}

export interface Harness {
  app: Express;
  db: ReturnType<typeof openDatabase>;
  pairing: PairingManager;
  sessions: SessionManager;
  audit: AuditService;
  /** M10 cumulative spend ledger (same db). */
  spendLedger: SpendLedgerManager;
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
  /** M11 F11 folder manager + store over the SAME db (folders for chats). */
  folderStore: FolderStore;
  /** M17 note<->folder membership store over the SAME tree (schema v16). */
  noteFolderStore: NoteFolderStore;
  folders?: FolderManager;
  /** M11 F1 chat-attachment manager (uploads + content) over the SAME db. */
  attachments?: AttachmentManager;
  /** M11 F10 asset manager (saved artifacts + note promotion). */
  assets?: AssetManager;
  /** M11 F2 MCP manager (stdio servers). */
  mcp?: McpManager;
  /** M11 F2 search manager (API-key backend, default-deny). */
  search?: SearchManager;
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
  /** M16 F1/F3 stores (PLAN-M16.md, schema v14). */
  noteVersionStore: NoteVersionStore;
  noteGraphStore: NoteGraphStore;
  /** M16 follow-up brainstorm linkage store (schema v15). */
  brainstormSessionStore: BrainstormSessionStore;
  planStore: PlanStore;
  notesFtsStore: NotesFtsStore;
  notes?: NoteManager;
  plans?: PlanManager;
  /** M16 F2 brainstorm manager (demo placeholder first reply by default). */
  brainstorm?: BrainstormManager;
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
  /** M26 skill-draft authoring over the SAME db (default on). */
  skillDrafts?: import('../src/skills/drafts.js').SkillDraftManager;
  /** The generator the drafts manager got (undefined = generate is refused). */
  skillDraftGenerator?: import('../src/skills/drafts.js').SkillGenerateHook;
  skillDraftStore: SkillDraftStore;
  /**
   * The scratch root a draft dry-run materializes into (removed in close()).
   * Tests assert against it exactly as the manager does — the run dir itself is
   * wiped by the manager, so this is the PARENT the run reported. `undefined`
   * when skills are unwired.
   */
  skillRunsDir?: string;
  /** M9 playbook + deploy stores/managers over the SAME db (default on). */
  deployProfileStore: DeployProfileStore;
  playbookRunStore: PlaybookRunStore;
  deployProfiles?: import('../src/playbooks/deploy.js').DeployManager;
  playbooks?: import('../src/playbooks/manager.js').PlaybookManager;
  /** M14 schedules (PLAN-M14.md) — manager + run store over the SAME db. */
  schedules?: ScheduleManager;
  scheduleRunStore: ScheduleRunStore;
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
  // M10: cumulative spend ledger over the same db (PLAN-M10 W3).
  const spendLedger = createSpendLedgerManager({ store: createSpendLedgerStore(db) });

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

  // M11 F11: folder manager over the same db (default on with personas). The
  // conversations table is the edge owner, so the manager gets the
  // conversation manager for counts + delete reassignment.
  const folderStore = createFolderStore(db);
  const noteFolderStore = createNoteFolderStore(db);
  let folders: FolderManager | undefined;
  let attachments: AttachmentManager | undefined;
  if (personasEnabled) {
    folders = createFolderManager({
      store: folderStore,
      conversations,
      noteFolders: noteFolderStore,
      audit,
    });
    attachments = createAttachmentManager({
      blobs: createChatBlobStore(db),
      attachments: createAttachmentStore(db),
      audit,
      ...(options.maxUploadBytes === undefined ? {} : { maxBytes: options.maxUploadBytes }),
    });
  }

  // M4: memory stores + managers over the same db (default on). The resolver
  // mirrors createCore (persona -> provider manager) but the demo harness
  // registers no provider, so non-demo summarize falls back to the
  // deterministic placeholder unless a test registers a provider + keys.
  const profileStore = createProfileStore(db);
  const episodeStore = createEpisodeStore(db);
  const memoryFtsStore = createMemoryFtsStore(db);
  // Shared settings store — opened before memory so the bundle can read the
  // user-level global auto-remember consent.
  const settingsStore = createSettingsStore(db);

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
      settings: settingsStore,
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
  // M16 F1/F3 (schema v14): version snapshots + graph positions on every
  // harness; the manager snapshots/reads them only when wired (below).
  const noteVersionStore = createNoteVersionStore(db);
  const noteGraphStore = createNoteGraphStore(db);
  const brainstormSessionStore = createBrainstormSessionStore(db);
  const planStore = createPlanStore(db);
  const notesFtsStore = createNotesFtsStore(db);
  let notes: NoteManager | undefined;
  let plans: PlanManager | undefined;
  if (notesPlansEnabled) {
    notes = createNoteManager({
      stores: {
        notes: noteStore,
        links: noteLinkStore,
        fts: notesFtsStore,
        versions: noteVersionStore,
        graph: noteGraphStore,
        folders: noteFolderStore,
      },
      ...(folders !== undefined ? { folderLookup: folders } : {}),
      audit,
      demo,
    });
    plans = createPlanManager({
      stores: { plans: planStore, fts: notesFtsStore },
      audit,
    });
  }

  // M27 S1: the broker is built AFTER the note manager so its dispatch map can
  // carry the app-scoped notes executors — the same ordering createCore uses.
  // When notes are off (`notesPlans: false`) the executors are simply absent, so
  // an app-scoped call answers `unknown_tool` rather than reaching a store that
  // does not exist.
  if (brokerEnabled) {
    broker = createToolBroker({
      roots: projectRootManager as ProjectRootManager,
      grants: grantManager as GrantManager,
      pending: pendingManager as PendingManager,
      proposals: proposalManager as ProposalManager,
      tools: {
        ...createFileTools({ proposals: proposalStore }),
        ...(notes !== undefined ? createNotesTools({ notes }) : {}),
      },
      audit,
    });
  }

  // M11 F10: asset manager over the same db (default on with notes).
  let assets: AssetManager | undefined;
  if (notesPlansEnabled) {
    assets = createAssetManager({
      store: createAssetStore(db),
      notes: notes as NoteManager,
      audit,
    });
  }

  // M11 F2: MCP manager over the same db (default on with personas).
  const mcp = createMcpManager({
    store: createMcpServerStore(db),
    audit,
  });

  // M6: theme manager + stores over the same db (default on). Preset rows
  // seed only when the themes table is empty; settings hold the global
  // active_theme key and the persona store's colorTheme column is the
  // per-persona override. Managers + routes are wired unless themes: false
  // (the 501 not_configured case).
  const themeStore = createThemeStore(db);
  // (settingsStore is opened earlier, before the memory bundle.)
  // M11 F2: search backend (config in settings, key in the fake/native
  // keychain — default-deny OFF until enabled).
  const search = createSearchManager({
    settings: settingsStore,
    keychain,
    audit,
  });
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
  let skillRunsDir: string | undefined;
  let skills: SkillManager | undefined;
  let skillRunner: SkillRunner | undefined;
  let skillDrafts: import('../src/skills/drafts.js').SkillDraftManager | undefined;
  const skillDraftStore = createSkillDraftStore(db);
  // M27: the reaches this harness's build honours, exactly as createCore states
  // them. Declared OUT here so the app options below can forward the SAME object
  // to the chat authoring instructions that the runner and drafts were built
  // with — the prompt and the validator must not be told different builds.
  const runtimeCapabilities = { mcp: true, llm: true, notes: true };
  if (skillsEnabled && brokerEnabled) {
    skillsDir = skillsOption.storeDir ?? makeTempRoot();
    // M26 cut E: dry-runs materialize under their own temp root, so a test can
    // see exactly what the manager wrote and then wiped.
    skillRunsDir = makeTempRoot();
    const catalogDir = skillsOption.catalogDir ?? REPO_CATALOG;
    // The skill tool registry is the BROKER's manifest set (M27 S1: files.* and
    // notes.*), derived the same way createCore derives it, so the harness can
    // never accept a tool the broker would not dispatch — or refuse one it would.
    const registry = new Set<string>(TOOL_MANIFESTS.map((m) => m.id));
    // The same registry's own risks, derived exactly as createCore derives them
    // (M28 D5's flow-compile ceiling reads this).
    const toolRisks = new Map<string, ToolRisk>(TOOL_MANIFESTS.map((m) => [m.id, m.risk]));
    skills = createSkillManager({
      store: skillStore,
      invocations: skillInvocationStore,
      storeDir: skillsDir,
      catalogDir,
      tools: registry,
      capabilities: runtimeCapabilities,
      audit,
    });
    skillRunner = createSkillRunner({
      dataDir: skillsDir,
      broker: broker as ToolBroker,
      audit,
      invocations: skillInvocationStore,
      // M27 S5: the same production resolver a real core injects. With no
      // provider seeded (the default here, and every demo build) it resolves
      // nothing, so a skill's model call answers `no_provider` — honest, and
      // what a build with nothing configured does. A test that needs the reach
      // drives the runner directly with a fake client, never the network.
      llm: createSkillLlmResolver(providerManager),
      spendLedger,
      // M27 S2: the same MCP seam a real core injects, over the harness's own
      // manager. A test that needs a live MCP call creates a server whose
      // command is a local script (see mcpReach.test.ts) — never the network.
      mcp: createMcpSkillReach(mcp, audit),
    });
    // M26: drafts over the same db, with the same registry. No generator is
    // injected by default, so `mode:'generate'` is refused — which is exactly
    // what a build with no configured provider does. A test may inject one to
    // exercise the generate seam without a real provider. Cut E wires the SAME
    // runner (a dry-run is the real sandbox) plus the scratch root, and
    // `skillDraftRunner: false` leaves the runner out on purpose. Cut C wires
    // the broker's approval queue: an install ask rides that same `pending_tools`
    // table the Files queue reads.
    skillDrafts = createSkillDraftManager({
      store: skillDraftStore,
      skills,
      tools: registry,
      riskOf: (toolId: string) => toolRisks.get(toolId) ?? null,
      capabilities: runtimeCapabilities,
      audit,
      runsDir: skillRunsDir,
      pending: pendingManager,
      ...(options.skillDraftRunner === false ? {} : { runner: skillRunner }),
      ...(options.skillDraftGenerator !== undefined
        ? { generate: options.skillDraftGenerator }
        : {}),
      // M28 cut D: the flow authoring model, wired by default exactly as the
      // real core wires it (a demo build answers deterministically, a live one
      // calls the configured provider). A test that needs a REAL proposal -
      // one that differs from the graph it was given - injects its own hook;
      // `skillFlowAi: null` leaves it out on purpose, which is the only way to
      // reach the "no flow model wired" refusals.
      ...(options.skillFlowAi === null
        ? {}
        : { flowAi: options.skillFlowAi ?? createFlowAiHook({ providers: providerManager, demo }) }),
    });
  }

  // M9: deploy-profile + playbook stores/managers over the same db (default
  // on). Playbooks need the broker, personas and notes (the loop is persona-
  // mediated); the run + profile stores exist on every harness for row-level
  // assertions. The resolver mirrors createCore: demo falls back to the demo
  // provider so text playbooks run end-to-end with no credentials.
  const deployProfileStore = createDeployProfileStore(db);
  const playbookRunStore = createPlaybookRunStore(db);
  const deployEnabled = options.deployProfiles !== false;
  let deployProfiles: DeployManager | undefined;
  if (deployEnabled) {
    deployProfiles = createDeployManager({ store: deployProfileStore, audit });
  }
  const playbooksEnabled =
    options.playbooks !== false && brokerEnabled && personasEnabled && notesPlansEnabled;
  let playbooks: PlaybookManager | undefined;
  let playbookResolver:
    | ((persona: Persona) => PlaybookChatTarget | null | Promise<PlaybookChatTarget | null>)
    | undefined;
  let toolLoop:
    | import('../src/playbooks/loop.js').ToolLoop
    | undefined;
  const scheduleRunStore = createScheduleRunStore(db);
  if (playbooksEnabled) {
    const resolver =
      options.playbookProvider !== undefined
        ? options.playbookProvider
        : createPlaybookProviderResolver({ providers: providerManager, demo });
    const loop = createToolLoop({
      broker: broker as ToolBroker,
      resolver,
      audit,
    });
    playbookResolver = resolver;
    toolLoop = loop;
    playbooks = createPlaybookManager({
      broker: broker as ToolBroker,
      personas,
      conversations,
      notes: notes as NoteManager,
      runs: playbookRunStore,
      resolver,
      loop,
      audit,
    });
  }

  // M14: schedule manager over the same db, driving the SAME persona tool
  // loop (a queued run must resume on the instance that started it). Demo
  // defaults to UTC so schedule windows are deterministic.
  let schedules: ScheduleManager | undefined;
  if (options.schedules !== false && playbookResolver !== undefined && toolLoop !== undefined) {
    schedules = createScheduleManager({
      personas,
      conversations,
      notes: notes as NoteManager,
      runs: scheduleRunStore,
      loop: toolLoop,
      resolver: playbookResolver,
      folders: folders as { get(id: string): unknown },
      audit,
      defaultTz: 'UTC',
      // Test harnesses drive scripted providers over the real loop: keep the
      // tool grammar advertised whenever the broker is wired so queued
      // approval / auto-resume paths stay exercisable deterministically
      // (real grants are NOT required in these tests).
      canRunTools: () => brokerEnabled,
    });
  }

  // M16 F2 (PLAN-M16.md): brainstorm manager over the same managers. Demo
  // harness mode (default) writes the deterministic placeholder first reply;
  // brainstormProvider can script a real provider turn.
  let brainstorm: BrainstormManager | undefined;
  if (notesPlansEnabled && personasEnabled) {
    brainstorm = createBrainstormManager({
      personas,
      conversations,
      notes: notes as NoteManager,
      folders: folders as { get(id: string): unknown },
      sessions: brainstormSessionStore,
      audit,
      demo,
      providerResolver: async () => (await options.brainstormProvider?.()) ?? null,
    });
  }

  const app = createCoreApp({
    port: 4390,
    demo,
    version: CORE_VERSION,
    schemaVersion: SCHEMA_VERSION,
    hostAllowlist: ALLOWLIST,
    staticDir: options.staticDir,
    deviceSecret: options.deviceSecret,
    // M22: pretend the deployment owns the roots (the route refusals).
    ...(options.rootsFixed === undefined ? {} : { rootsFixed: options.rootsFixed }),
    ...(options.maxUploadBytes === undefined ? {} : { maxUploadBytes: options.maxUploadBytes }),
    // M20-B S7: the networked-pairing lane. `peer` is the TEST seam for the
    // network peer (sockets are loopback under supertest); the real default
    // reads `req.socket.remoteAddress`.
    ...(options.remoteAccess === undefined ? {} : { remoteAccess: options.remoteAccess }),
    ...(options.tlsFingerprint === undefined ? {} : { tlsFingerprint: options.tlsFingerprint }),
    ...(options.pairCoreUrl === undefined ? {} : { pairCoreUrl: options.pairCoreUrl }),
    ...(options.pairRateLimit === undefined ? {} : { pairRateLimit: options.pairRateLimit }),
    ...(options.peer === undefined ? {} : { peerAddress: () => options.peer }),
    ...(options.peerAddress === undefined ? {} : { peerAddress: options.peerAddress }),
    pairing,
    sessions,
    audit,
    providers: demo ? [demoProvider()] : [],
    providerManager,
    broker,
    personaManager: personasEnabled ? personas : undefined,
    conversationManager: personasEnabled ? conversations : undefined,
    folders: folders,
    attachments: attachments,
    assets: assets,
    mcp: mcp,
    search: search,
    ...(memoryEnabled ? { memory } : {}),
    ...(notesPlansEnabled ? { notes, plans } : {}),
    ...(themesEnabled ? { themes } : {}),
    ...(browserEnabled ? { scopes } : {}),
    ...(skills && skillRunner ? { skills, skillRunner } : {}),
    // M27 S2/S5: the harness states the same reaches a real core does, so the
    // chat authoring instructions it produces are the production text.
    skillCapabilities: runtimeCapabilities,
    ...(skillDrafts !== undefined ? { skillDrafts } : {}),
    ...(playbooks !== undefined ? { playbooks } : {}),
    ...(deployProfiles !== undefined ? { deployProfiles } : {}),
    ...(schedules !== undefined ? { schedules } : {}),
    ...(brainstorm !== undefined ? { brainstorm } : {}),
    spendLedger,
  });

  return {
    app,
    db,
    pairing,
    sessions,
    audit,
    spendLedger,
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
    folderStore,
    noteFolderStore,
    folders,
    attachments,
    assets,
    mcp,
    search,
    profileStore,
    episodeStore,
    memoryFtsStore,
    memory,
    profile,
    episodes,
    noteStore,
    noteLinkStore,
    noteVersionStore,
    noteGraphStore,
    brainstormSessionStore,
    planStore,
    notesFtsStore,
    notes,
    plans,
    brainstorm,
    themeStore,
    settingsStore,
    themes,
    scopeStore,
    scopes,
    skillStore,
    skillInvocationStore,
    skills,
    skillRunner,
    skillDrafts,
    skillDraftGenerator: options.skillDraftGenerator,
    skillDraftStore,
    skillRunsDir,
    deployProfileStore,
    playbookRunStore,
    deployProfiles,
    playbooks,
    schedules,
    scheduleRunStore,
    close(): void {
      db.close();
      if (skillsDir !== undefined) removeTempRoot(skillsDir);
      if (skillRunsDir !== undefined) removeTempRoot(skillRunsDir);
    },
  };
}

/**
 * Recursively remove a {@link makeTempRoot} directory (test teardown).
 *
 * On Windows, child processes spawned inside the root (skill workers, etc.)
 * release their cwd/file handles asynchronously and antivirus scanners can
 * briefly pin files, so a single rmSync races and throws EBUSY/EPERM. Retry
 * with a short backoff before giving up — harmless elsewhere.
 */
export function removeTempRoot(path: string): void {
  let lastError: unknown;
  // rmSync's own maxRetries covers short Windows handle-release/AV races;
  // the outer loop adds a bounded pause between full attempts.
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      rmSync(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 40 });
      return;
    } catch (error) {
      lastError = error;
      const end = Date.now() + 80 * (attempt + 1);
      while (Date.now() < end) {
        /* short sync pause — teardown only */
      }
    }
  }
  throw lastError;
}

let symlinkSupportedCache: boolean | undefined;

/**
 * Whether this OS/test-runner can actually create symlinks. Windows without
 * Developer Mode (or an elevated shell) throws EPERM on symlinkSync, so the
 * path-escape tests that NEED real symlinks cannot run there.
 */
export function canCreateSymlinks(): boolean {
  if (symlinkSupportedCache !== undefined) return symlinkSupportedCache;
  let probe: string | undefined;
  try {
    probe = makeTempRoot();
    const target = join(probe, 'target');
    const link = join(probe, 'link');
    mkdirSync(target);
    symlinkSync(target, link);
    symlinkSupportedCache = true;
  } catch {
    symlinkSupportedCache = false;
  } finally {
    if (probe !== undefined) {
      try {
        rmSync(probe, { recursive: true, force: true });
      } catch {
        /* probe cleanup best-effort */
      }
    }
  }
  return symlinkSupportedCache;
}
