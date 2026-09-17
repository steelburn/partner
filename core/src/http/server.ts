/**
 * Partner core HTTP server (Express 5) — the M0 security spine as routes.
 *
 * Layering, in order:
 *  1. Host allowlist guard — 403 before any routing when the Host header is
 *     not on the allowlist (default `127.0.0.1:<port>` / `localhost:<port>`;
 *     with remote access on, the explicit ALLOWED_HOSTS list from config).
 *     PLAN-M20 §2.1: the Host header is client-supplied once a client is
 *     remote, so it is a LOOKUP KEY for session/origin binding — NOT a
 *     network control. TLS (cert fingerprint pinned at pair time) and that
 *     named allowlist are the controls.
 *  2. Public surface — /v1/health, /v1/boot (shell boot identity) and
 *     (demo only) /v1/dev/pair-code.
 *  3. Pairing exchange — POST /v1/pair drives the 6-digit single-use manager
 *     (LOCAL only, mints `desktop`) or a 256-bit single-use pair secret
 *     (LOCAL-issued by POST /v1/pair/payload, accepted from anywhere, mints
 *     `mobile`) and mints a `web` session bound to the caller's (allowlisted)
 *     origin. Both paths are per-peer rate-limited. See M20-B S7 below.
 *  3. Account lane (M22, login mode only) — POST /v1/auth/session signs a USER
 *     in and POST /v1/auth/signup creates an account from a single-use INVITE
 *     (minted loopback-only by POST /v1/signup/code, i.e. `compose exec
 *     tools/signup-link.mjs`). Sign-up is OFF unless the deployment sets
 *     SIGNUP_MODE=invite: creating an account is otherwise an operator act.
 *  4. Authed group (Bearer + origin) — POST /v1/chat (SSE), GET /v1/audit,
 *     the M1 provider API (/v1/providers…, /v1/models), the M2 tool surface
 *     (/v1/roots|/v1/grants|/v1/tools…, /v1/proposals…) and the M3
 *     persona + conversation API (/v1/personas…, /v1/conversations…).
 *
 * M20-B S4 (client-class capability envelope): the mutating route groups that
 * the capability vocabulary HAS A NAME for carry `capability(<name>)`
 * (http/requireCapability.ts) straight after requireSession, and /v1/tools/exec
 * passes the session's class into the broker so it re-checks per TOOL before the
 * grant check. The class always comes from the validated session row — a mobile
 * session is refused whether or not it holds a grant, and an unknown class is
 * refused outright. Read paths (chat, files.browse/refs) stay open to every
 * class that holds the capability.
 *
 * SCOPE OF THAT GUARD, stated so it is not read as "every route": the vocabulary
 * is TWELVE names (M22 added the last two). Gated are the MACHINE-power surfaces
 * (file write, roots, grants, deploy, skill install/invoke, MCP call INCLUDING
 * server create/update/delete — configuring one spawns a process — browser
 * scopes, provider-purpose discovery) and, since M22, the two surfaces that were
 * missing a name: **provider KEY writes** (`provider.configure`:
 * `/v1/providers/:id/key`, `/v1/search/key`) and **autonomous firing**
 * (`persona.run`: playbook run, schedule run-now). A stored key is spendable
 * money and a credential that outlives the session; a run is work the user did
 * not just ask for. Both are denied to mobile/extension by the envelope table.
 * NOT gated, deliberately: the DATA plane (personas, conversations, folders,
 * notes, plans, themes, memory) because a phone may legitimately edit its own
 * notes and memory, and provider create/delete, which name an endpoint rather
 * than a secret.
 *
 * M20-B S7 (networked pairing): the peer — `socket.remoteAddress`, never the
 * Host header — decides which credential is even admissible. `{code}` is
 * refused from a non-loopback peer and mints `desktop`; a `{secret}` is
 * accepted from anywhere and mints `mobile`, so no shape of remote request can
 * reach desktop authority. The payload route (which CREATES a secret) is
 * loopback-only and refuses without remote access + TLS, because a secret
 * carried to another device over plaintext is the thing the pinned cert
 * fingerprint exists to prevent. Secrets cross exactly one boundary and are
 * never logged, audited or persisted.
 *
 * M3 chat (PLAN-M3.md): POST /v1/chat accepts optional {conversationId?,
 * personaId?, taskClass?}. A persona (explicit or derived from the
 * conversation) routes the model via gateway/resolver.ts and must not be
 * paused (423 persona_paused). When a personaId or conversationId is
 * present, the turn is PERSISTED (auto-creating a conversation bound to the
 * persona when none is given) and a trailing `done_meta` SSE event carries
 * the stored {messageId, conversationId}. Persistence failures are logged
 * (redacted) and NEVER break the stream. Without personaId/conversationId
 * the route is byte-identical to M0/M1 (no persistence, no done_meta).
 *
 * Secrets discipline: tokens/keys never enter responses, audit details, or
 * SSE payloads — every audit write goes through the redaction service. Chat
 * content is never audited either: message rows carry only ids/lengths.
 */
import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';
import express from 'express';
import { timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { ChatEvent, ChatImagePart, ChatMessage, ChatRequest, ConversationMessage, ProviderClient, ProviderSummary, ToolCall } from '@partner/shared';
import { attachmentTooLargeMessage, describeBytes } from '@partner/shared';
import type { NoteInput, Persona } from '@partner/shared';
import type { PlanInput, TaskStatusInput } from '@partner/shared';
import type { ProviderInput, ProviderPatch, ProviderPurpose, ProviderSource } from '@partner/shared';
import type { McpCallInput, McpServerInput, McpServerUpdate, SearchConfigInput } from '@partner/shared';
import type { ProjectRootInput, ToolExecResponse } from '@partner/shared/tools.js';
import { APP_SCOPE_ID } from '@partner/shared';
import type { SiteScope } from '@partner/shared';
import { redactString, isProviderPurpose, isSearchProvider, PROVIDER_PURPOSES } from '@partner/shared';
import { demoProvider } from '../gateway/demo.js';
import { createBudgetTracker } from '../gateway/budget.js';
import { centsForTokens } from '../gateway/pricing.js';
import type { SpendLedgerManager } from '../gateway/spend.js';
import { resolveChatModel, resolveImageTurnUpgrade } from '../gateway/resolver.js';
import {
  isImageCapableModel,
  declaredVisionModels,
  MAX_INLINE_IMAGE_BYTES,
  MAX_INLINE_IMAGES_PER_TURN,
} from '../gateway/vision.js';
import { UpstreamError, createOpenAICompatibleClient } from '../gateway/openaiCompatible.js';
import type { OpenAICompatibleClient } from '../gateway/openaiCompatible.js';
import { normalizeEndpoint } from '../providers/providerManager.js';
import type { ProviderManager } from '../providers/providerManager.js';
import { ProviderError } from '../providers/errors.js';
import type { PairingManager } from './pairing.js';
import type { UserManager } from '../users/manager.js';
import type { CredentialManager } from '../users/credentials.js';
import type { AuthMode, SignupMode } from '../config.js';
import {
  LEGACY_USER_ID,
  accountIdForUsername,
  isUsableAccountId,
  passphraseProblem,
  usernameProblem,
} from '@partner/shared';
import { createPairSecretManager } from './pairSecret.js';
import type { PairSecretManager } from './pairSecret.js';
import { buildPairPayload } from './pairPayload.js';
import { createRateLimiter } from './rateLimit.js';
import type { RateLimiter } from './rateLimit.js';
import { isLoopbackPeer } from './peer.js';
import type { SessionInfo, SessionManager } from './session.js';
import { requireCapability } from './requireCapability.js';
import type { Capability } from './capabilities.js';
import { capabilityDenial } from './capabilities.js';
import type { AuditService } from '../services/redaction.js';
import type { PendingToolRow } from '../stores/types.js';
import type { ToolBroker } from '../broker/broker.js';
import { browseDirectory, BrowseError } from '../files/browse.js';
import type { ToolErrorCode } from '../broker/errors.js';
import { ToolError, toolError, toolErrorStatus } from '../broker/errors.js';
import type { ConversationManager, ConversationDetail } from '../conversations/manager.js';
import type { PersonaManager } from '../personas/manager.js';
import { ConversationError } from '../conversations/errors.js';
import { PersonaError } from '../personas/errors.js';
import type { MemoryBundle } from '../memory/index.js';
import { buildTailoring } from '../memory/tailor.js';
import { MemoryError, memoryErrorStatus } from '../memory/index.js';
import type { NoteManager } from '../notes/index.js';
import { NoteError, noteErrorStatus } from '../notes/index.js';
import type { BrainstormManager } from '../notes/index.js';
import { BrainstormError, brainstormErrorStatus } from '../notes/index.js';
import type { PlanManager } from '../plans/index.js';
import { PlanError, planErrorStatus } from '../plans/index.js';
import type { ThemeManager } from '../theming/manager.js';
import { ThemeError, themeErrorStatus } from '../theming/errors.js';
import type { SiteScopeManager } from '../browser/scopes.js';
import { BrowserError, browserErrorStatus } from '../browser/errors.js';
import type { SkillManager } from '../skills/manager.js';
import type { SkillDraftManager } from '../skills/drafts.js';
import {
  authoringToolExternal,
  authoringToolSpecs,
  canAdvertiseAuthoring,
} from '../skills/tool.js';
import type { SkillRunner } from '../skills/runner.js';
import { SkillError, skillErrorStatus } from '../skills/errors.js';
import type { FolderManager } from '../folders/manager.js';
import { FolderError, folderErrorStatus } from '../folders/errors.js';
import type { AttachmentManager } from '../attachments/manager.js';
import { MAX_ATTACHMENT_BYTES } from '../attachments/manager.js';
import { AttachmentError, attachmentErrorStatus } from '../attachments/errors.js';
import type { AssetManager } from '../assets/manager.js';
import { AssetError, assetErrorStatus } from '../assets/errors.js';
import type { McpManager } from '../mcp/manager.js';
import { McpError, mcpErrorStatus } from '../mcp/errors.js';
import type { SearchManager } from '../search/manager.js';
import { SearchError, searchErrorStatus } from '../search/errors.js';
import {
  applyStructuredGuidance,
  authoringInstructions,
  independenceDeclaration,
  SEARCH_TOOL_APPROVAL_INSTRUCTION,
  SEARCH_TOOL_INSTRUCTION,
} from '../chat/instructions.js';
import { SEARCH_MANIFEST } from '../search/tool.js';
import { runChatToolPass, runNativeToolCalls } from '../chat/toolPass.js';
import type { ChatToolDecision } from '../chat/toolPass.js';
import { searchToolExternal } from '../search/tool.js';
import { mcpToolExternal } from '../mcp/tool.js';
import { summarizeToolResult } from '../playbooks/loop.js';
import { fileRefsExcerpt, parseFileRefs } from '../chat/fileRefs.js';
import type { PlaybookManager, PbEvent } from '../playbooks/manager.js';
import type { DeployManager } from '../playbooks/deploy.js';
import { PlaybookError, playbookError, playbookErrorStatus } from '../playbooks/errors.js';
import type { ScheduleManager } from '../schedules/index.js';
import { ScheduleError, scheduleErrorStatus } from '../schedules/index.js';

/**
 * M22: the account lane. `pairing` is the desktop shape (no users at all);
 * `login` requires the managers, because a session must name its user.
 */
export interface CoreAuthOptions {
  mode: AuthMode;
  /** Present in login mode (the system-database managers). */
  users?: UserManager;
  capabilities?: CredentialManager;
  /** The client class a login session is minted with (config). */
  sessionClass?: string;
  /**
   * M20-B S9: the per-user key vault. A successful sign-in wraps the user's
   * partition key (first time) and releases it into memory; a request whose
   * user has no key available is refused with `partition_locked` rather than
   * being served from a partition nobody unlocked.
   */
  vault?: {
    adopt(userId: string, passphrase: string): Promise<boolean>;
    unlock(userId: string, passphrase: string): Promise<boolean>;
    lock(userId: string): boolean;
    keyFor(userId: string): Promise<string | undefined>;
  };
}

export interface CoreAppOptions {
  port: number;
  demo: boolean;
  version: string;
  schemaVersion: number;
  /**
   * M22: how clients authenticate. Absent = pairing (unchanged); `login`
   * disables the pairing routes and enables POST /v1/auth/session.
   */
  auth?: CoreAuthOptions;
  /**
   * M22/R1: per-user partitions. When present (login mode), every authenticated
   * `/v1/*` request is handed to THAT USER'S OWN core — a complete single-user
   * app built over their own encrypted database and skills directory — instead
   * of being served by this app's stores. Returns `undefined` when the partition
   * cannot be opened; the request then fails 503 rather than ever falling back
   * to another user's data.
   */
  delegate?: (userId: string) => Promise<express.Express | 'partition_locked' | undefined>;
  /**
   * M22/R4: the bucket key for the AUTH rate limits (pair + sign-in). Defaults
   * to the socket peer; a deployment behind a trusted tunnel sets it to the real
   * client address so per-IP budgets are per client, not per tunnel. It never
   * feeds a locality decision — that stays on `peerAddress`.
   */
  clientIp?: (req: Request) => string | undefined;
  /** R7: the JSON body cap in bytes (default 1 MiB). */
  maxJsonBytes?: number;
  /**
   * R7: the per-attachment upload cap in bytes (default
   * {@link MAX_ATTACHMENT_BYTES}). It is the body limit of the upload route
   * and the number its 413 quotes, so an operator tightening
   * `MAX_UPLOAD_BYTES` tightens the wire, the message and the number the SPA
   * checks before uploading — one value, no drift.
   */
  maxUploadBytes?: number;
  /** M22: fixed-window budget for POST /v1/auth/session, per network peer. */
  loginRateLimit?: { limit?: number; windowMs?: number };
  /**
   * Host-lookup allowlist. Defaults to the derived loopback pair for `port`;
   * with remote access on, config passes the explicit ALLOWED_HOSTS list.
   */
  hostAllowlist?: string[];
  /**
   * M15 device pairing channel: when the shell hands the core a per-boot
   * secret, GET /v1/pair/device (header-guarded) issues the live pairing
   * code for the tray. Absent = the route does not exist (a plain live core
   * still exposes no code surface — the demo /v1/dev/pair-code seam stays
   * demo-only).
   */
  deviceSecret?: string;
  /**
   * M15 hardening (boot identity): the nonce the desktop shell minted for the
   * sidecar it spawned (PARTNER_CORE_NONCE), echoed by GET /v1/boot so the
   * shell can prove the listener on its port is the child it started. Without
   * it, a stale core (or any local process) already holding :4390 answers the
   * shell's bare TCP probe and the desktop silently renders against a foreign
   * core while the real sidecar never served a request (POSIX: EADDRINUSE;
   * Windows: both bind and the stray wins). NOT a credential: it grants no
   * authority and guards no data. Absent in dev/CI/container runs.
   */
  bootNonce?: string;
  /**
   * M22: the deployment OWNS the project roots (`FIXED_ROOTS`). The list still
   * reports them, but adding or removing one is refused with `roots_fixed` —
   * what the file tools can see is a deployment decision (a mounted volume),
   * not a client one. Absent ⇒ today's desktop behaviour.
   */
  rootsFixed?: boolean;
  /** Optional built SPA directory served at / (stub at M0; the packaged shell wires the real path). */
  staticDir?: string;
  /**
   * M20-B S7: remote access is ON (config.remoteAccess). Gates the networked
   * pairing surfaces — POST /v1/pair/payload refuses with
   * `remote_access_disabled` when it is false, because a secret for another
   * device is meaningless while nothing but loopback can reach this core.
   */
  remoteAccess?: boolean;
  /**
   * M20-B S7: the served certificate's fingerprint (config.tls.fingerprint),
   * the value a pairing client PINS. Absent without TLS, and the payload route
   * then refuses (`tls_required`): a secret carried to another device over
   * plaintext is exactly what the pin exists to prevent.
   */
  tlsFingerprint?: string;
  /**
   * M20-B S7: the https URL a pairing device should use. Defaults to
   * `https://<first allowlisted host>`; explicit override for a deployment
   * whose canonical URL is not the first ALLOWED_HOSTS entry.
   */
  pairCoreUrl?: string;
  /**
   * M20-B S7: fixed-window budget for POST /v1/pair, per network peer.
   * Defaults to the limiter's own 10 per 60s.
   */
  pairRateLimit?: { limit?: number; windowMs?: number };
  /**
   * M20-B S7: the pair-secret manager (256-bit single-use secrets for the
   * networked path). Defaults to a fresh in-memory manager, which is the
   * correct lifetime — a secret that has been scanned is consumed, and one
   * that has not is meaningless after a restart.
   */
  pairSecrets?: PairSecretManager;
  /**
   * M22 sign-up: `off` (default) keeps account creation an operator act;
   * `invite` lets a person create their OWN account with a single-use code the
   * operator mints on the machine (`POST /v1/signup/code`). Ignored unless the
   * app is in login mode — the pairing ceremony has no credential to create.
   */
  signupMode?: SignupMode;
  /**
   * How long a minted invite stays usable, when this app creates its own
   * secret manager. Defaults to 24h (an invite is handed to a person).
   */
  signupTtlMs?: number;
  /**
   * The invite-secret manager. Defaults to a fresh in-memory
   * {@link createPairSecretManager} — the same 256-bit single-use primitive as
   * the networked-pairing secret (keyed HMAC at rest, one active record, dies
   * with the process), which is exactly the lifetime an invite wants.
   */
  signupSecrets?: PairSecretManager;
  /**
   * Fixed-window budget for `POST /v1/auth/signup`, per network peer. Separate
   * from the sign-in budget on purpose: a sign-up flood must not lock the
   * owner out of signing in.
   */
  signupRateLimit?: { limit?: number; windowMs?: number };
  /**
   * M20-B S7: TEST SEAM — the network peer of a request. Defaults to the real
   * socket address (`req.socket.remoteAddress`), which is the only signal that
   * distinguishes a local caller from a remote one. Injectable because a
   * hermetic test cannot dial the core from a non-loopback address; production
   * code (index.ts) never passes it, and the value can only ever make a
   * request look MORE remote or unclassifiable (both fail closed).
   */
  peerAddress?: (req: Request) => string | undefined;
  pairing: PairingManager;
  sessions: SessionManager;
  audit: AuditService;
  /** Configured model providers. Empty in M0 outside demo mode. */
  providers?: ProviderClient[];
  /**
   * M1 provider manager (optional so M0 harnesses/tests compile unchanged).
   * When present AND it resolves an enabled provider, POST /v1/chat streams
   * through it (budget-wrapped); otherwise the demo/legacy fallback applies.
   */
  providerManager?: ProviderManager;
  /**
   * M10 cumulative spend ledger (optional so older harnesses compile
   * unchanged). When present, provider chat with a budgetCents cap is
   * refused BEFORE a turn streams once the rolling window is spent, and
   * each finished turn settles its cents into the ledger.
   */
  spendLedger?: SpendLedgerManager;
  /**
   * M2 tool broker (optional so M0/M1 harnesses compile unchanged). When
   * absent the whole /v1/roots|/v1/grants|/v1/tools surface responds 501
   * not_configured (mirrors the provider manager).
   */
  broker?: ToolBroker;
  /**
   * M3 persona manager (optional so M0-M2 harnesses compile unchanged).
   * When absent the persona routes 501 and persona-bound chat is refused
   * with not_configured; persona-less one-shot chat is untouched.
   */
  personaManager?: PersonaManager;
  /**
   * M3 conversation manager (optional; paired with personaManager). When
   * absent, conversation persistence in /v1/chat and the conversation
   * routes 501 not_configured.
   */
  conversationManager?: ConversationManager;
  /**
   * M4 memory bundle (optional so M0-M3 harnesses compile unchanged). When
   * absent the /v1/memory surface responds 501 not_configured and chat-time
   * tailoring is skipped. When present, provider-routed persona chat
   * PREPENDS the confirmed-global profile prelude to the upstream request
   * (demo/one-shot paths stay byte-identical; nothing is persisted).
   */
  memory?: MemoryBundle;
  /**
   * M5 note manager (optional so M0-M4 harnesses compile unchanged). When
   * absent the /v1/notes + /v1/tags surface responds 501 not_configured.
   */
  notes?: NoteManager;
  /**
   * M16 F2 brainstorm manager (optional so pre-M16 harnesses compile
   * unchanged). When absent POST /v1/notes/brainstorm responds 501
   * not_configured.
   */
  brainstorm?: BrainstormManager;
  /**
   * M5 plan manager (optional so M0-M4 harnesses compile unchanged). When
   * absent the /v1/plans surface responds 501 not_configured.
   */
  plans?: PlanManager;
  /**
   * M6 theme manager (optional so M0-M5 harnesses compile unchanged). When
   * absent the /v1/themes + /v1/theme/active + persona-theme bind surface
   * responds 501 not_configured.
   */
  themes?: ThemeManager;
  /**
   * M7 site-scope manager (optional so M0-M6 harnesses compile unchanged).
   * When absent the /v1/browser/scopes + /v1/browser/policy surface responds
   * 501 not_configured.
   */
  scopes?: SiteScopeManager;
  /**
   * M8 skill manager (optional so M0-M7 harnesses compile unchanged). When
   * absent the whole /v1/skills surface responds 501 not_configured.
   */
  skills?: SkillManager;
  /**
   * M26 skill DRAFT manager (optional so M0–M25 harnesses compile unchanged).
   * When absent the /v1/skills/drafts surface responds 501 not_configured.
   */
  skillDrafts?: SkillDraftManager;
  /**
   * M8 skill runner (paired with skills; the invoke route needs both). When
   * absent POST /v1/skills/:id/invoke responds 501 not_configured.
   */
  skillRunner?: SkillRunner;
  /**
   * M9 playbook manager (optional so M0-M8 harnesses compile unchanged).
   * When absent the /v1/playbooks surface responds 501 not_configured.
   */
  playbooks?: PlaybookManager;
  /**
   * M11 F11 folder manager (optional so M0-M10 harnesses compile unchanged).
   * When absent the /v1/folders surface responds 501 not_configured and
   * conversation folder params are refused with folder_not_configured.
   */
  folders?: FolderManager;
  /**
   * M11 F1 attachment manager (optional so M0-M10 harnesses compile
   * unchanged). When absent the /v1/…/attachments surface responds 501
   * not_configured and chat attachmentIds are ignored.
   */
  attachments?: AttachmentManager;
  /**
   * M11 F10 asset manager (optional so M0-M10 harnesses compile unchanged).
   * When absent the /v1/…/assets surface responds 501 not_configured.
   */
  assets?: AssetManager;
  /**
   * M11 F2 MCP manager (optional so M0-M10 harnesses compile unchanged).
   * When absent the /v1/mcp surface responds 501 not_configured.
   */
  mcp?: McpManager;
  /**
   * M11 F2 search manager (optional so M0-M10 harnesses compile unchanged).
   * When absent the /v1/search surface responds 501 not_configured and the
   * chat search tool is not offered.
   */
  search?: SearchManager;
  /**
   * M9 deploy-profile manager (optional so M0-M8 harnesses compile
   * unchanged). When absent the /v1/deploy-profiles surface responds 501
   * not_configured.
   */
  deployProfiles?: DeployManager;
  /**
   * M14 schedule manager (optional so M0-M13 harnesses compile unchanged).
   * When absent the /v1/schedules surface responds 501 not_configured and
   * the pending-decide hook never resumes schedule runs.
   */
  schedules?: ScheduleManager;
}

const SSE_HEADERS = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
};

/** Trailing SSE event emitted ONLY when a turn was persisted (PLAN-M3): the
 *  shared ChatEvent `done` is untouched (shared/ is the web lane's), so the
 *  stored ids ride a separate final event the web layer consumes. */
export interface ChatDoneMetaEvent {
  type: 'done_meta';
  messageId: string;
  conversationId: string;
}

/** Local event union: ChatEvent (wire) + done_meta (route-only). */
export type ServerChatEvent = ChatEvent | ChatDoneMetaEvent;

const ALLOWED_ROLES: ReadonlySet<string> = new Set(['system', 'user', 'assistant']);
const DEFAULT_AUDIT_LIMIT = 100;
/**
 * MIME types this route may render INLINE. Everything else is forced to a
 * download (PLAN-M20.md §8.1.1).
 *
 * Why: the SPA and this API share an origin, and the session bearer token lives
 * in that origin's `localStorage`. `assertAllowed` accepts any `text/*` upload
 * — including `text/html` — so serving one `inline` let a document execute on
 * the authenticated origin and read the token. `nosniff` does not help here:
 * it defends against content *sniffing*, not against an explicitly declared
 * `text/html`.
 *
 * The realistic chain is not an attacker uploading. The partner generates an
 * HTML/CSS prototype for the Design capability, and the user opens it — which
 * is exactly why the disposition is decided here instead of trusting a client
 * to ask for the right one.
 *
 * Uploading HTML stays allowed (the model legitimately reads HTML the user
 * attaches); only *rendering it on the app's origin* is refused. Images and PDF
 * are not script-bearing document types and the SPA displays them inline, so
 * they keep `inline`.
 */
const INLINE_SAFE_MIME: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'application/pdf',
]);

/** True when a response body may be rendered in the page rather than saved. */
export function isInlineSafeMime(mime: string): boolean {
  return INLINE_SAFE_MIME.has(String(mime ?? '').trim().toLowerCase());
}

/**
 * Headers for a core-served attachment body.
 *
 * Extracted so the policy is unit-testable without an HTTP round trip and so
 * there is exactly one place that decides whether user bytes may render on the
 * authenticated origin.
 */
export function attachmentContentHeaders(
  mime: string,
  name: string,
): Record<string, string> {
  const inline = isInlineSafeMime(mime);
  const headers: Record<string, string> = {
    'Content-Type': mime,
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(name)}`,
    'X-Content-Type-Options': 'nosniff',
  };
  if (!inline) {
    // Defence in depth: if a client ignores the disposition and renders the
    // body anyway, `sandbox` gives it an opaque origin with no script access
    // to this origin's storage. Deliberately NOT applied to the inline types —
    // `sandbox` blocks plugins, which breaks the browser's inline PDF viewer.
    headers['Content-Security-Policy'] = 'sandbox';
  }
  return headers;
}

const MAX_AUDIT_LIMIT = 500;

/**
 * The Host header as a LOOKUP KEY (PLAN-M20 §2.1): the origin a session is
 * bound to and matched against the allowlist. Client-supplied, so it decides
 * nothing about the network — TLS and the allowlist do. `X-Forwarded-Host` is
 * deliberately never read: honouring it would let an unauthenticated proxy
 * header pick the session origin.
 */
function originOf(req: Request): string {
  return String(req.headers.host ?? '').toLowerCase();
}

/**
 * M20-B S7: the network peer of a request — the ONLY signal that separates a
 * local caller from a remote one (`Host` is lookup-key only, §2.1). Returns
 * `undefined` when the transport exposes none (e.g. a unix socket), which the
 * pairing routes treat as unclassifiable and refuse.
 */
function socketPeerOf(req: Request): string | undefined {
  const address = req.socket?.remoteAddress;
  return typeof address === 'string' && address.length > 0 ? address : undefined;
}

/**
 * M20-B S7: the https URL a scanning device should use, derived from the
 * allowlist the operator wrote (`https://<first ALLOWED_HOSTS entry>`). Null
 * when the allowlist is empty, which the payload route refuses rather than
 * inventing an address.
 */
function defaultPairCoreUrl(hostAllowlist: readonly string[]): string | null {
  const first = hostAllowlist.find((host) => host.trim().length > 0);
  return first === undefined ? null : `https://${first.trim().toLowerCase()}`;
}

/**
 * M20-B S7: the per-peer rate-limit bucket of a pairing attempt. The peer is
 * the bucket key; an absent peer cannot be attributed and is refused by the
 * limiter (`invalid_key`) rather than sharing an anonymous budget.
 */
const PAIR_RATE_LIMIT_DEFAULT = { limit: 10, windowMs: 60_000 } as const;

/**
 * How long a minted sign-up invite stays usable when this app owns the manager
 * (`config.signupTtlMs` overrides it). A day rather than the pairing secret's
 * two minutes, because an invite is handed to a PERSON through a message and
 * opened when they get to it — and it is single-use, single-active, and gone on
 * restart regardless.
 */
const SIGNUP_TTL_DEFAULT_MS = 24 * 60 * 60 * 1000;

const DEVICE_LABEL_MAX = 64;
const PLATFORM_MAX = 32;

/** Sentinel for a malformed optional tag — a unique symbol, NOT a magic
 *  string, so a client cannot send the literal text that means "invalid". */
const INVALID_TAG = Symbol('invalid_tag');

/** Optional, non-secret device metadata: bounded and control-character free. */
function readOptionalTag(value: unknown, max: number): string | null | typeof INVALID_TAG {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') return INVALID_TAG;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  // eslint-disable-next-line no-control-regex
  if (trimmed.length > max || /[\u0000-\u001f\u007f]/.test(trimmed)) return INVALID_TAG;
  return trimmed;
}

/**
 * Cap on the persisted prior turns replayed into the upstream request when
 * the client sends only the newest user message (M3 multi-turn contract:
 * the SPA posts one message + conversationId; the core rebuilds context).
 */
const MAX_CONTEXT_MESSAGES = 40;

/**
 * Assemble the upstream message list for a chat turn.
 *
 * Order: persona system prompt (identity) -> M4 profile prelude (context) ->
 * prior persisted turns (only when the client sent the newest user turn and
 * the conversation already has history) -> the request's own messages.
 * When the client already supplied a full transcript (2+ messages) it is
 * used verbatim — no history is replayed to avoid duplication.
 */
function assembleRequestMessages(input: {
  persona: Persona | null;
  /** Stored prior turns (oldest first, current turn NOT included). */
  history: ConversationMessage[];
  /** Sanitized request body messages. */
  requestMessages: ChatMessage[];
  /** M4 profile tailoring to honor (already trimmed to null when absent). */
  profilePrelude?: string | null;
  /** M12 F2-capability: the search backend is enabled (default-deny OFF). */
  searchEnabled?: boolean;
  /**
   * M26 D8: the broker tool ids the skill-authoring contract may name, or null
   * when this turn may not author at all (a non-desktop client, an `assist`
   * persona, a banned tool). Null = the contract is NOT appended, so a persona
   * that cannot act is never told the tools exist.
   */
  authoringToolIds?: readonly string[] | null;
  /**
   * M12.6 approval continuation: resume the conversation WITHOUT a new user
   * turn — prompts + the stored history tail only, so the next assistant
   * round answers against the outcome notes the decision just posted.
   */
  continueTurn?: boolean;
}): ChatMessage[] {
  const out: ChatMessage[] = [];
  // M4 profile prelude keeps its documented position as the FIRST system
  // message when active (memoryRoutes contract); the persona's identity
  // system prompt follows it.
  if (
    input.profilePrelude !== undefined &&
    input.profilePrelude !== null &&
    input.profilePrelude.trim() !== ''
  ) {
    out.push({
      role: 'system',
      content: '<Partner profile you should honor>\n' + input.profilePrelude,
    });
  }
  const systemPrompt = input.persona?.character.systemPrompt.trim() ?? '';
  if (systemPrompt !== '') {
    const systemIndex = out.length;
    // M12 capability pass: every persona turn declares its independence level
    // (chat never did — only playbooks did) so the model can honestly check
    // what it may do before answering "can I search?".
    const personaIdentity =
      input.persona !== null
        ? `${systemPrompt}\n\n${independenceDeclaration(input.persona.independence.level)}`
        : systemPrompt;
    out.push({ role: 'system', content: personaIdentity });
    // M11 C3: teach capable personas the :::partner.* container grammar for
    // clickable choices (F9), multi-question forms and assets (F10).
    // Deterministic, opt-in per conversation feature set (default on for
    // persisted persona chat).
    if (input.persona !== null) {
      applyStructuredGuidance(out, systemIndex);
      // M11 F3: a persona's DEFAULT skills are announced so the model can
      // call on them; bans are enforced server-side, never prompted.
      const defaults = input.persona.policy?.skills?.default;
      if (defaults !== undefined && defaults.length > 0) {
        const base = out[systemIndex];
        if (base) {
          out[systemIndex] = {
            ...base,
            content:
              `${base.content}\nSkills available to you by default: ${defaults.join(', ')}.`,
          };
        }
      }
      // M12 F2-capability: announce the internet-search tool ONLY when the
      // persona could actually use it (enabled backend; auto/autonomous run
      // it directly, suggest queues an approval). Default-deny — assist and
      // every disabled/banned case are never told it exists.
      const searchInstruction = searchInstructionFor(
        input.persona,
        input.searchEnabled === true,
      );
      if (searchInstruction !== null) {
        const base = out[systemIndex];
        if (base) {
          out[systemIndex] = {
            ...base,
            content: `${base.content}\n\n${searchInstruction}`,
          };
        }
      }
      // M26 D8: the authoring contract, under exactly the conditions the chat
      // route advertises the two authoring tools (the caller decides - the
      // prompt and the advertised functions must never disagree).
      if (input.authoringToolIds !== undefined && input.authoringToolIds !== null) {
        const base = out[systemIndex];
        if (base) {
          out[systemIndex] = {
            ...base,
            content: `${base.content}\n\n${authoringInstructions(input.authoringToolIds)}`,
          };
        }
      }
    }
  }
  const singleNewUserTurn =
    input.requestMessages.length === 1 && input.requestMessages[0]?.role === 'user';
  const appendHistory =
    input.continueTurn === true || (singleNewUserTurn && input.history.length > 0);
  if (appendHistory) {
    for (const row of input.history.slice(-MAX_CONTEXT_MESSAGES)) {
      out.push({ role: row.role, content: row.content });
    }
  }
  // A resume round carries ONLY stored history — the request body must hold
  // no messages (validated in the /v1/chat handler).
  if (input.continueTurn === true) return out;
  for (const message of input.requestMessages) {
    out.push(message);
  }
  return out;
}

/** Can this persona direct-execute the external `search` tool this turn?
 *  Default-deny: the backend must be enabled AND the persona must sit at a
 *  level the gate would allow for a medium-risk EXTERNAL tool (auto+ —
 *  assist never runs tools, suggest queues an approval instead) AND the
 *  persona must not have banned it (F3 bans are enforced at the gate, so
 *  announcing a banned tool would bait a refusal). */
function canRunSearchTool(persona: Persona, searchEnabled: boolean): boolean {
  if (!searchEnabled) return false;
  const level = persona.independence.level;
  if (level !== 'auto' && level !== 'autonomous') return false;
  return !(persona.policy?.tools?.banned ?? []).includes('search');
}

/** Deterministic search announcement for a persona's system message: null
 *  when nothing should be announced (backend disabled, assist level, or a
 *  persona-level ban); the run grammar at auto/autonomous; the approval
 *  grammar at suggest (medium-risk external — every use queues an approval). */
function searchInstructionFor(persona: Persona, searchEnabled: boolean): string | null {
  if (!searchEnabled) return null;
  if ((persona.policy?.tools?.banned ?? []).includes('search')) return null;
  const level = persona.independence.level;
  if (level === 'auto' || level === 'autonomous') return SEARCH_TOOL_INSTRUCTION;
  if (level === 'suggest') return SEARCH_TOOL_APPROVAL_INSTRUCTION;
  return null;
}

/**
 * M26 D8: the broker tool ids the authoring contract may name for this turn, or
 * null when it may not author. ONE decision function, so the system-prompt
 * contract and the advertised native functions can never disagree - and the
 * same rule is enforced again in the tool pass, which refuses the ids by class.
 */
function authoringToolIdsFor(
  persona: Persona,
  clientClass: string,
  options: CoreAppOptions,
): readonly string[] | null {
  const broker = options.broker;
  if (broker === undefined || options.skillDrafts === undefined) return null;
  if (!canAdvertiseAuthoring({ persona, clientClass })) return null;
  return broker.manifests.map((manifest) => manifest.id);
}

/** The native function-call advertisement for the two authoring tools. The
 *  specs come from the authoring module, so the description is written once.
 *  (A non-null return needs a non-empty tool list.) */
function authoringFunctionTools(
  toolIds: ReadonlySet<string>,
): Array<{
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}> {
  return authoringToolSpecs(toolIds).map((spec) => ({
    type: 'function',
    function: {
      name: spec.id,
      description: spec.description,
      parameters: spec.parameters,
    },
  }));
}

function appendAttachmentContext(messages: ChatMessage[], context: string): void {
  if (context === '') return;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message && message.role === 'user') {
      messages[index] = { ...message, content: `${message.content}\n\n${context}` };
      return;
    }
  }
}

function sanitizeMessages(input: unknown): ChatMessage[] | null {
  if (!Array.isArray(input)) return null;
  const messages: ChatMessage[] = [];
  for (const entry of input) {
    if (entry === null || typeof entry !== 'object') continue;
    const maybe = entry as { role?: unknown; content?: unknown };
    if (typeof maybe.role !== 'string' || !ALLOWED_ROLES.has(maybe.role)) continue;
    if (typeof maybe.content !== 'string') continue;
    messages.push({ role: maybe.role as ChatMessage['role'], content: maybe.content });
  }
  // Reject a body full of garbage entries instead of silently chatting empty.
  if (input.length > 0 && messages.length === 0) return null;
  return messages;
}

function pickProvider(options: CoreAppOptions): ProviderClient | undefined {
  const configured = options.providers?.[0];
  if (configured) return configured;
  // M0 legacy/demo fallback keeps /v1/chat alive when the provider manager
  // has no enabled provider registered (see the /v1/chat handler).
  return options.demo ? demoProvider() : undefined;
}

/** Host-allowlist guard (a lookup key, not a network control), before routing. */
function hostGuard(allowlist: ReadonlySet<string>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!allowlist.has(originOf(req))) {
      res.status(403).json({ error: 'forbidden_host' });
      return;
    }
    next();
  };
}

function requireSession(sessions: SessionManager) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const header = req.headers.authorization;
    const token =
      typeof header === 'string' && header.startsWith('Bearer ')
        ? header.slice('Bearer '.length).trim()
        : '';
    if (token === '') {
      res.status(401).json({ error: 'unauthorized', reason: 'missing_token' });
      return;
    }
    const result = await sessions.validate(token, originOf(req));
    if (!result.ok) {
      // Never echo the presented token; just say why it was refused.
      res.status(401).json({ error: 'unauthorized', reason: result.reason });
      return;
    }
    // res.locals.session carries the validated row — the capability guards
    // below read its `clientClass`; the request never supplies one.
    res.locals.session = result.session;
    res.locals.token = token;
    next();
  };
}

function writeSse(res: Response, event: ServerChatEvent): void {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

/** SSE writer for the playbook run/resume streams (local event union). */
function writePbSse(res: Response, event: PbEvent): void {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

/** Body-object helper: the playbook run input envelope. */
function bodyInputs(raw: unknown): Record<string, unknown> | null {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) return null;
  return raw as Record<string, unknown>;
}

/** ProviderError code -> loopback HTTP status (see providers/errors.ts). */
function providerHttpStatus(err: ProviderError): number {
  switch (err.code) {
    case 'invalid_kind':
    case 'invalid_endpoint':
    case 'invalid_input':
      return 400;
    case 'not_found':
      return 404;
    case 'missing_key':
      return 409;
    case 'keychain_unavailable':
      return 500;
    case 'upstream':
      return 502;
  }
}

/** Send a typed ProviderError response; false when err is not a ProviderError. */
function sendProviderError(res: Response, err: unknown): boolean {
  if (err instanceof ProviderError) {
    res.status(providerHttpStatus(err)).json({ error: err.code, message: err.message });
    return true;
  }
  return false;
}

/** PersonaError code -> loopback status (personas/errors.ts). */
function personaHttpStatus(err: PersonaError): number {
  switch (err.code) {
    case 'invalid_input':
      return 400;
    case 'not_found':
      return 404;
    case 'conflict':
      return 409;
  }
}

/** Send a typed PersonaError response; false when err is not a PersonaError. */
function sendPersonaError(res: Response, err: unknown): boolean {
  if (err instanceof PersonaError) {
    res.status(personaHttpStatus(err)).json({ error: err.code, message: err.message });
    return true;
  }
  return false;
}

/** Send a typed ConversationError response; false when not one. */
function sendConversationError(res: Response, err: unknown): boolean {
  if (err instanceof ConversationError) {
    const status = err.code === 'not_found' ? 404 : 400;
    res.status(status).json({ error: err.code, message: err.message });
    return true;
  }
  return false;
}

/** Send a typed MemoryError response; false when not one. */
function sendMemoryError(res: Response, err: unknown): boolean {
  if (err instanceof MemoryError) {
    res.status(memoryErrorStatus(err.code)).json({ error: err.code, message: err.message });
    return true;
  }
  return false;
}

/** Send a typed NoteError response; false when not one. */
function sendNoteError(res: Response, err: unknown): boolean {
  if (err instanceof NoteError) {
    res.status(noteErrorStatus(err.code)).json({ error: err.code, message: err.message });
    return true;
  }
  return false;
}

/** Send a typed BrainstormError response; false when not one. */
function sendBrainstormError(res: Response, err: unknown): boolean {
  if (err instanceof BrainstormError) {
    res.status(brainstormErrorStatus(err.code)).json({ error: err.code, message: err.message });
    return true;
  }
  return false;
}

/** Send a typed PlanError response; false when not one. */
function sendPlanError(res: Response, err: unknown): boolean {
  if (err instanceof PlanError) {
    res.status(planErrorStatus(err.code)).json({ error: err.code, message: err.message });
    return true;
  }
  return false;
}

/**
 * Send a typed ThemeError response; false when not one. invalid_input (the
 * lint/contrast gate) carries the full ThemeReport body {ok:false, errors,
 * warnings} so the studio can render per-token errors.
 */
function sendThemeError(res: Response, err: unknown): boolean {
  if (err instanceof ThemeError) {
    if (err.code === 'invalid_input') {
      res.status(400).json({
        error: err.code,
        message: err.message,
        ...(err.report !== undefined ? { report: err.report } : {}),
      });
      return true;
    }
    res.status(themeErrorStatus(err.code)).json({ error: err.code, message: err.message });
    return true;
  }
  return false;
}

/** Trimmed non-empty string or undefined (chat optional fields). */
function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/** Chat task-class union guard; unknown -> 'bad_params' (typed on the wire). */
function optionalTaskClass(value: unknown): 'chat' | 'deep' | 'coding' | 'vision' | 'cheap' | undefined {
  if (value === undefined || value === null) return undefined;
  if (
    value === 'chat' ||
    value === 'deep' ||
    value === 'coding' ||
    value === 'vision' ||
    value === 'cheap'
  ) {
    return value;
  }
  return undefined;
}

/**
 * M13: does this conversation have a staged inline image (uploaded, bound to
 * the NEXT turn — messageId null) small enough to ride as an image part?
 * Best-effort: an attachment-store failure just means "no image" (the turn
 * falls back to the descriptor context as before).
 */
function stagedInlineImage(attachments: AttachmentManager, conversationId: string): boolean {
  try {
    return attachments
      .list(conversationId)
      .some(
        (m) =>
          m.messageId === null && m.mime.startsWith('image/') && m.size <= MAX_INLINE_IMAGE_BYTES,
      );
  } catch {
    return false;
  }
}

/**
 * The upload caps apply to ONE route: the attachment POST streams the file
 * itself as the body, everything else is still a JSON request. The error
 * handler has to tell them apart to quote the right number (and body-parser's
 * `err.limit` says which limit actually fired).
 */
const UPLOAD_PATH = /\/v1\/conversations\/[^/]+\/attachments\/?$/;

/**
 * The staged-upload filename rides a header, percent-encoded, because a
 * filename is user data and user data must not reach a URL (browser history,
 * referrers, proxy access logs). A value that is not valid percent-encoding is
 * taken literally rather than refused, so a plain name still uploads.
 */
function attachmentNameHeader(raw: unknown): string {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string' || value.trim() === '') return '';
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * The declared content type IS the mime (parameters such as `; charset=utf-8`
 * are dropped). Empty means the client declared nothing — the manager refuses
 * that with `invalid_input`, which is the honest answer.
 */
function attachmentMimeHeader(raw: unknown): string {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' ? (value.split(';')[0] ?? '').trim() : '';
}

/** What the 413 can honestly say: the declared size when the client sent one. */
function attachmentTooLargeFor(req: Request, cap: number): string {
  const name = attachmentNameHeader(req.headers['x-attachment-name']);
  const declared = Number(req.headers['content-length']);
  const size = Number.isFinite(declared) && declared > 0 ? declared : null;
  return attachmentTooLargeMessage(cap, name !== '' && size !== null ? { name, size } : null);
}

/** M13: host label for purpose-bundle provider names (never the key). */
const PURPOSE_LABELS: Record<ProviderPurpose, string> = {
  general: 'General',
  cheap: 'Cheap',
  deep: 'Deep',
  coding: 'Coding',
  vision: 'Vision',
  research: 'Research',
};

function endpointHost(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return endpoint;
  }
}

/**
 * M13: parse the bundle `modelPins` body field. null when absent; throws a
 * typed ProviderError on malformed input (unknown purpose keys or non-array/
 * empty model lists). The route enforces completeness against the requested
 * purposes and membership in the fetched model list.
 */
function parseModelPins(raw: unknown): Partial<Record<ProviderPurpose, string[]>> | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ProviderError(
      'invalid_input',
      'modelPins must be an object mapping purpose -> array of model ids',
    );
  }
  const pins: Partial<Record<ProviderPurpose, string[]>> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!isProviderPurpose(key)) {
      throw new ProviderError('invalid_input', `modelPins contains an unknown purpose "${key}"`);
    }
    if (
      !Array.isArray(value) ||
      value.length === 0 ||
      value.some((m) => typeof m !== 'string' || m.trim() === '')
    ) {
      throw new ProviderError(
        'invalid_input',
        `modelPins.${key} must be a non-empty array of model id strings`,
      );
    }
    pins[key as ProviderPurpose] = (value as string[]).map((m) => m.trim());
  }
  return pins;
}

/**
 * The M1 llm-self-service import (login-key + connect routes) was REMOVED in
 * M22: Partner is a plain OpenAI-compatible client, and provider setup is a
 * base URL + key typed by the user. The `llm-self-service` ProviderSource value
 * stays in the shared enum so rows written by older installs still read, but
 * nothing creates one.
 */

/**
 * M22: the deployment owns the roots, so this surface is read-only. Refused
 * BEFORE any parameter validation or store write, and audited, because a client
 * asking to change what the file tools can reach is worth a row even when it is
 * refused by configuration.
 */
function refuseFixedRoots(options: CoreAppOptions, res: Response): boolean {
  if (options.rootsFixed !== true) return false;
  options.audit.log('session', 'roots.change_denied', 'roots', { reason: 'roots_fixed' });
  res.status(403).json({
    error: 'roots_fixed',
    message:
      'Project roots are set by the deployment (FIXED_ROOTS) and cannot be changed from a client',
  });
  return true;
}

/**
 * M22: LOGIN mode has no pairing ceremony. Answered for every pairing route so
 * a client cannot tell "no such route" from "wrong mode" and go hunting for
 * another door.
 */
function refusePairingAuth(res: Response): void {
  res.status(403).json({
    error: 'pairing_disabled',
    message: 'This Partner authenticates with a user login (AUTH_MODE=login)',
  });
}

function notConfigured(res: Response, what = 'provider manager'): void {
  res.status(501).json({ error: 'not_configured', message: `${what} is not wired` });
}

/** Guard: returns the providerManager or 501s (no manager wired). */
function requireProviderManager(
  options: CoreAppOptions,
  res: Response,
): ProviderManager | null {
  const manager = options.providerManager;
  if (!manager) {
    notConfigured(res);
    return null;
  }
  return manager;
}

/** Guard: returns the M2 tool broker or 501s (no broker wired). */
function requireBroker(options: CoreAppOptions, res: Response): ToolBroker | null {
  const broker = options.broker;
  if (!broker) {
    notConfigured(res, 'tool broker');
    return null;
  }
  return broker;
}

/** Guard: returns the M3 persona manager or 501s. */
function requirePersonaManager(options: CoreAppOptions, res: Response): PersonaManager | null {
  const manager = options.personaManager;
  if (!manager) {
    notConfigured(res, 'persona manager');
    return null;
  }
  return manager;
}

/** Guard: returns the M11 F2 search manager or 501s. */
function requireSearch(options: CoreAppOptions, res: Response): SearchManager | null {
  const search = options.search;
  if (!search) {
    notConfigured(res, 'search manager');
    return null;
  }
  return search;
}

/** Send a typed SearchError response; false when not one. */
function sendSearchError(res: Response, err: unknown): boolean {
  if (err instanceof SearchError) {
    res.status(searchErrorStatus(err.code)).json({ error: err.code, message: err.message });
    return true;
  }
  return false;
}

/** Guard: returns the M11 F2 MCP manager or 501s. */
function requireMcp(options: CoreAppOptions, res: Response): McpManager | null {
  const mcp = options.mcp;
  if (!mcp) {
    notConfigured(res, 'MCP manager');
    return null;
  }
  return mcp;
}

/** Send a typed McpError response; false when not one. */
function sendMcpError(res: Response, err: unknown): boolean {
  if (err instanceof McpError) {
    res.status(mcpErrorStatus(err.code)).json({ error: err.code, message: err.message });
    return true;
  }
  return false;
}

/** Guard: returns the M11 F10 asset manager or 501s. */
function requireAssets(options: CoreAppOptions, res: Response): AssetManager | null {
  const assets = options.assets;
  if (!assets) {
    notConfigured(res, 'asset manager');
    return null;
  }
  return assets;
}

/** Send a typed AssetError response; false when not one. */
function sendAssetError(res: Response, err: unknown): boolean {
  if (err instanceof AssetError) {
    res.status(assetErrorStatus(err.code)).json({ error: err.code, message: err.message });
    return true;
  }
  return false;
}

/** Guard: returns the M11 F1 attachment manager or 501s. */
function requireAttachments(options: CoreAppOptions, res: Response): AttachmentManager | null {
  const attachments = options.attachments;
  if (!attachments) {
    notConfigured(res, 'attachment manager');
    return null;
  }
  return attachments;
}

/** Send a typed AttachmentError response; false when not one. */
function sendAttachmentError(res: Response, err: unknown): boolean {
  if (err instanceof AttachmentError) {
    res.status(attachmentErrorStatus(err.code)).json({ error: err.code, message: err.message });
    return true;
  }
  return false;
}

/** Guard: returns the M3 conversation manager or 501s. */
function requireConversationManager(
  options: CoreAppOptions,
  res: Response,
): ConversationManager | null {
  const manager = options.conversationManager;
  if (!manager) {
    notConfigured(res, 'conversation manager');
    return null;
  }
  return manager;
}

/** Guard: returns the M11 F11 folder manager or 501s. */
function requireFolders(options: CoreAppOptions, res: Response): FolderManager | null {
  const folders = options.folders;
  if (!folders) {
    notConfigured(res, 'folder manager');
    return null;
  }
  return folders;
}

/** Send a typed FolderError response; false when not one. */
function sendFolderError(res: Response, err: unknown): boolean {
  if (err instanceof FolderError) {
    res.status(folderErrorStatus(err.code)).json({ error: err.code, message: err.message });
    return true;
  }
  return false;
}

/** Guard: returns the M4 memory bundle or 501s. */
function requireMemory(options: CoreAppOptions, res: Response): MemoryBundle | null {
  const memory = options.memory;
  if (!memory) {
    notConfigured(res, 'memory manager');
    return null;
  }
  return memory;
}

/** Guard: returns the M5 note manager or 501s. */
function requireNotes(options: CoreAppOptions, res: Response): NoteManager | null {
  const notes = options.notes;
  if (!notes) {
    notConfigured(res, 'notes manager');
    return null;
  }
  return notes;
}

/** Guard: returns the M16 F2 brainstorm manager or 501s. */
function requireBrainstorm(options: CoreAppOptions, res: Response): BrainstormManager | null {
  const brainstorm = options.brainstorm;
  if (!brainstorm) {
    notConfigured(res, 'brainstorm manager');
    return null;
  }
  return brainstorm;
}

/** Guard: returns the M5 plan manager or 501s. */
function requirePlans(options: CoreAppOptions, res: Response): PlanManager | null {
  const plans = options.plans;
  if (!plans) {
    notConfigured(res, 'plans manager');
    return null;
  }
  return plans;
}

/** Guard: returns the M6 theme manager or 501s. */
function requireThemes(options: CoreAppOptions, res: Response): ThemeManager | null {
  const themes = options.themes;
  if (!themes) {
    notConfigured(res, 'theme manager');
    return null;
  }
  return themes;
}

/** Guard: returns the M7 site-scope manager or 501s. */
function requireScopes(options: CoreAppOptions, res: Response): SiteScopeManager | null {
  const scopes = options.scopes;
  if (!scopes) {
    notConfigured(res, 'browser scope manager');
    return null;
  }
  return scopes;
}

/** Guard: returns the M8 skill manager or 501s. */
function requireSkills(options: CoreAppOptions, res: Response): SkillManager | null {
  const skills = options.skills;
  if (!skills) {
    notConfigured(res, 'skills manager');
    return null;
  }
  return skills;
}

/** Guard: returns the M8 skill runner or 501s. */
function requireSkillRunner(options: CoreAppOptions, res: Response): SkillRunner | null {
  const runner = options.skillRunner;
  if (!runner) {
    notConfigured(res, 'skill runner');
    return null;
  }
  return runner;
}

/** Guard: returns the M26 skill DRAFT manager or 501s. */
function requireSkillDrafts(options: CoreAppOptions, res: Response): SkillDraftManager | null {
  const drafts = options.skillDrafts;
  if (!drafts) {
    notConfigured(res, 'skill draft manager');
    return null;
  }
  return drafts;
}

/** Guard: returns the M9 playbook manager or 501s. */
function requirePlaybooks(options: CoreAppOptions, res: Response): PlaybookManager | null {
  const playbooks = options.playbooks;
  if (!playbooks) {
    notConfigured(res, 'playbook manager');
    return null;
  }
  return playbooks;
}

/** Guard: returns the M9 deploy-profile manager or 501s. */
function requireDeployProfiles(options: CoreAppOptions, res: Response): DeployManager | null {
  const profiles = options.deployProfiles;
  if (!profiles) {
    notConfigured(res, 'deploy manager');
    return null;
  }
  return profiles;
}

/** Guard: returns the M14 schedule manager or 501s. */
function requireSchedules(options: CoreAppOptions, res: Response): ScheduleManager | null {
  const schedules = options.schedules;
  if (!schedules) {
    notConfigured(res, 'schedule manager');
    return null;
  }
  return schedules;
}

/** Send a typed ScheduleError response; false when err is not a ScheduleError. */
function sendScheduleError(res: Response, err: unknown): boolean {
  if (err instanceof ScheduleError) {
    res.status(scheduleErrorStatus(err.code)).json({ error: err.code, message: err.message });
    return true;
  }
  return false;
}

/** Send a typed PlaybookError response; false when err is not a PlaybookError. */
function sendPlaybookError(res: Response, err: unknown): boolean {
  if (err instanceof PlaybookError) {
    res.status(playbookErrorStatus(err.code)).json({ error: err.code, message: err.message });
    return true;
  }
  return false;
}

/** Send a typed SkillError response; false when err is not a SkillError. */
function sendSkillError(res: Response, err: unknown): boolean {
  if (err instanceof SkillError) {
    res.status(skillErrorStatus(err.code)).json({ error: err.code, message: err.message });
    return true;
  }
  return false;
}

/** Send a typed BrowserError response; false when err is not a BrowserError. */
function sendBrowserError(res: Response, err: unknown): boolean {
  if (err instanceof BrowserError) {
    res.status(browserErrorStatus(err.code)).json({ error: err.code, message: err.message });
    return true;
  }
  return false;
}

/** Send a typed ToolError response; false when err is not a ToolError. */
function sendToolError(res: Response, err: unknown): boolean {
  if (err instanceof ToolError) {
    res.status(toolErrorStatus(err.code)).json({ error: err.code, message: err.message });
    return true;
  }
  return false;
}

/** denied reason -> loopback status (see broker/errors.ts mappings). */
function deniedStatus(reason: string): number {
  return toolErrorStatus(reason as ToolErrorCode);
}

/** Session kind as the audit/decision actor ('web' unless something else). */
function actorOf(session: SessionInfo): string {
  return session.kind !== '' ? session.kind : 'web';
}

/** Post a system note into the conversation a search approval belongs to
 *  (no-op when the row has no conversation or the manager is absent). */
function appendConversationSystemNote(
  options: CoreAppOptions,
  conversationId: string | null,
  content: string,
): void {
  if (conversationId === null || conversationId === '') return;
  const manager = options.conversationManager;
  if (!manager) return;
  try {
    (manager as ConversationManager).append(conversationId, 'system', {
      content,
      personaId: null,
      model: null,
      latencyMs: null,
    });
  } catch {
    // The decision itself already succeeded; a lost note must not 500 it.
  }
}

interface ExternalApprovalDeps {
  broker: ToolBroker;
  row: PendingToolRow;
  decision: 'approve' | 'deny';
  by: string;
  options: CoreAppOptions;
  audit: AuditService;
}

/** Decide a persona-requested EXTERNAL (web search) approval row. Approve
 *  executes the search ONCE through the enabled backend and posts the result
 *  note into the conversation; deny just closes the row with a note. The row
 *  closes regardless of execution outcome (mirrors broker.decide). No grant
 *  is ever created (external tools have no project grants — remember is not
 *  honored). Audit carries tool/decision only — never the query text. */
async function decideExternalApproval(
  deps: ExternalApprovalDeps,
): Promise<{
  ok: true;
  grantId: null;
  executed: boolean;
  error?: string;
  result?: Record<string, unknown>;
}> {
  const { broker, row, decision, by, options, audit } = deps;
  const approved = decision === 'approve';
  let executed = false;
  let error: string | undefined;
  let result: Record<string, unknown> | undefined;

  if (approved) {
    const owner = searchToolExternal(options.search);
    if (!owner) {
      error = 'not_configured';
    } else if (!owner.allow(SEARCH_MANIFEST.id)) {
      error = 'disabled';
    } else {
      let params: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(row.params) as unknown;
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
          params = parsed as Record<string, unknown>;
        }
      } catch {
        error = 'bad_params';
      }
      if (error === undefined) {
        const response = await owner.exec(SEARCH_MANIFEST.id, params);
        if (response.outcome === 'executed') {
          executed = true;
          result = response.result ?? {};
        } else if (response.outcome === 'needs_approval') {
          error = 'needs_approval';
        } else {
          error = response.reason;
        }
      }
    }
  }

  // Close the row once (throws not_pending on a double decision).
  broker.pending.decide(row.id, { decision, remember: false }, by);
  audit.log(by, approved ? 'tool.approve' : 'tool.deny', row.id, {
    toolId: row.toolId,
    external: true,
    executed,
    ...(error !== undefined ? { error } : {}),
  });

  let note: string;
  if (!approved) {
    note = `[tool ${row.toolId}] was denied by the user — do not retry it; continue with what you have.`;
  } else if (error !== undefined) {
    note = `The tool "${row.toolId}" could not run (${error}) — continue without it.`;
  } else {
    const summary = summarizeToolResult(result ?? {});
    note = `[tool ${row.toolId} result]\n${summary}\n[end tool ${row.toolId} result]`;
  }
  appendConversationSystemNote(options, row.conversationId, note);

  return {
    ok: true,
    grantId: null,
    executed,
    ...(error !== undefined ? { error } : {}),
    ...(executed && result !== undefined ? { result } : {}),
  };
}

interface SkillInstallApprovalDeps {
  broker: ToolBroker;
  drafts: SkillDraftManager;
  row: PendingToolRow;
  decision: 'approve' | 'deny';
  /** True when the caller has SEEN the before/after permission table (D6). */
  acknowledgePermissions: boolean;
  by: string;
  options: CoreAppOptions;
  audit: AuditService;
}

/**
 * Decide a persona-requested SKILL INSTALL row (M26 D2b). Approve calls the SAME
 * `promote()` the Studio button calls - one install implementation, so the two
 * surfaces cannot diverge - and deny closes the ask, leaving the draft exactly
 * as it was. Nothing else here can make a draft executable.
 *
 * Two properties that are deliberate, not incidental:
 *
 *   1. The row is closed by `settleInstall`, never by `broker.decide` (which
 *      EXECUTES the stored tool and refuses a non-tool row).
 *   2. A FAILED approve leaves the ask OPEN: nothing was installed, so the card
 *      must survive for the owner to review in the Studio or deny. The failure
 *      is reported as `error` in the same body shape the search approvals use,
 *      which is what the chat card already renders.
 */
function decideInstallApproval(deps: SkillInstallApprovalDeps): {
  ok: true;
  grantId: null;
  executed: boolean;
  error?: string;
  result?: Record<string, unknown>;
} {
  const { broker, drafts, row, decision, by, options, audit } = deps;
  // A decided row is decided: this is what makes "approving installs exactly
  // once" true, and it mirrors `broker.decide` (which refuses the same way).
  if (row.decidedAt !== null) throw toolError('not_pending', 'pending call was already decided');
  const approved = decision === 'approve';
  let executed = false;
  let error: string | undefined;
  let result: Record<string, unknown> | undefined;
  let draftName = '';

  if (approved) {
    const draftId = row.draftId ?? '';
    if (draftId === '') {
      error = 'bad_params';
    } else {
      draftName = drafts.get(draftId)?.name ?? '';
      try {
        const installed = drafts.promote(draftId, {
          via: 'approval',
          acknowledgePermissions: deps.acknowledgePermissions,
        });
        executed = true;
        // Ids/version only: the draft's code and text never leave the store.
        result = {
          skillId: installed.skill.id,
          version: installed.skill.version,
          mode: installed.mode,
        };
      } catch (err) {
        error = err instanceof SkillError ? err.code : 'install_failed';
      }
    }
  }

  if (!approved) broker.pending.settleInstall(row.id, 'deny', by);
  else if (executed) broker.pending.settleInstall(row.id, 'approve', by);

  audit.log(by, approved ? 'tool.approve' : 'tool.deny', row.id, {
    kind: 'skill_install',
    draftId: row.draftId,
    executed,
    ...(error !== undefined ? { error } : {}),
  });

  let note: string;
  if (!approved) {
    note =
      'The skill install the persona asked for was denied by the user - the draft is still ' +
      'there; continue without it.';
  } else if (error !== undefined) {
    note =
      `The install of "${draftName}" could not be completed (${error}) - continue without it; ` +
      'the draft is unchanged.';
  } else {
    note =
      `The user installed the skill "${draftName}" (${String(result?.mode ?? 'created')}, ` +
      `version ${String(result?.version ?? '')}). It is available now - continue.`;
  }
  appendConversationSystemNote(options, row.conversationId, note);

  return {
    ok: true,
    grantId: null,
    executed,
    ...(error !== undefined ? { error } : {}),
    ...(result !== undefined ? { result } : {}),
  };
}

/**
 * The persona label a queue row is tagged with (PLAN-M9 Web bullet): a live
 * playbook run wins, then the persona stored on a chat-requested row, else
 * nothing. One function, because the M26 INSTALL branch labels its row the same
 * way.
 */
function queuePersonaName(
  row: { id: string; requestedBy: string },
  broker: ToolBroker,
  options: CoreAppOptions,
): string | null {
  if (row.requestedBy !== 'persona') return null;
  const playbookPersona = options.playbooks?.personaForPending(row.id) ?? null;
  if (playbookPersona !== null) return playbookPersona.name;
  const storedPersonaId = broker.pending.get(row.id)?.personaId ?? null;
  if (storedPersonaId === null || options.personaManager === undefined) return null;
  return options.personaManager.get(storedPersonaId)?.name ?? null;
}

export function createCoreApp(options: CoreAppOptions): express.Express {
  const { pairing, sessions, audit } = options;
  const hostAllowlist =
    options.hostAllowlist ?? [`127.0.0.1:${options.port}`, `localhost:${options.port}`];
  const allowlist = new Set(hostAllowlist.map((h) => h.toLowerCase()));

  // M20-B S7: the networked-pairing lane. `peerOf` is the one signal that
  // separates a local caller from a remote one; the limiter buckets per peer
  // (an unattributable peer is refused by the limiter itself, never pooled);
  // and the secret manager is in-memory by design (a scanned secret is
  // consumed, an unscanned one dies with the process).
  const peerOf = options.peerAddress ?? socketPeerOf;
  const limitKeyOf = (req: Request): string =>
    String(options.clientIp?.(req) ?? peerOf(req) ?? '');
  const pairSecrets = options.pairSecrets ?? createPairSecretManager();
  const pairLimiter: RateLimiter = createRateLimiter({
    limit: options.pairRateLimit?.limit ?? PAIR_RATE_LIMIT_DEFAULT.limit,
    windowMs: options.pairRateLimit?.windowMs ?? PAIR_RATE_LIMIT_DEFAULT.windowMs,
  });
  const pairCoreUrl = options.pairCoreUrl ?? defaultPairCoreUrl(hostAllowlist);

  // M22: the account lane. `loginMode` short-circuits every pairing route, so a
  // hosted core cannot be enrolled by proximity even if a code is somehow
  // minted (e.g. by a stale tray process).
  const auth = options.auth ?? { mode: 'pairing' as AuthMode };
  const loginMode = auth.mode === 'login';
  const loginLimiter: RateLimiter = createRateLimiter({
    limit: options.loginRateLimit?.limit ?? PAIR_RATE_LIMIT_DEFAULT.limit,
    windowMs: options.loginRateLimit?.windowMs ?? PAIR_RATE_LIMIT_DEFAULT.windowMs,
  });

  // M22 sign-up: invite-gated self-service account creation. Deliberately the
  // SAME secret primitive as the networked-pairing lane (256-bit, single use,
  // only a keyed hash at rest, one active record, invalidated by a restart) and
  // deliberately NOT the pairing lane's semantics: the mint is loopback-only,
  // the code is consumed by a sign-up rather than by a session, and it is only
  // reachable in login mode. `open` registration is not a mode — see
  // `SignupMode` in config.ts for why.
  const signupMode = options.signupMode ?? 'off';
  const signupEnabled = loginMode && signupMode === 'invite';
  const signupSecrets =
    options.signupSecrets ??
    createPairSecretManager({ ttlMs: options.signupTtlMs ?? SIGNUP_TTL_DEFAULT_MS });
  const signupLimiter: RateLimiter = createRateLimiter({
    limit: options.signupRateLimit?.limit ?? PAIR_RATE_LIMIT_DEFAULT.limit,
    windowMs: options.signupRateLimit?.windowMs ?? PAIR_RATE_LIMIT_DEFAULT.windowMs,
  });

  const app = express();
  app.disable('x-powered-by');

  // 1. Loopback guard + JSON body parsing (public routes may not send JSON).
  app.use(hostGuard(allowlist));
  const uploadCap = options.maxUploadBytes ?? MAX_ATTACHMENT_BYTES;
  app.use(express.json({ limit: options.maxJsonBytes ?? 1024 * 1024 }));

  // Built SPA (optional at M0): serve static assets and index.html at /.
  const staticDir = options.staticDir;
  if (staticDir && existsSync(join(staticDir, 'index.html'))) {
    app.use(express.static(staticDir));
    app.get('/', (_req: Request, res: Response) => res.sendFile(join(staticDir, 'index.html')));
  }

  // 2. Public surface.
  app.get('/v1/health', (_req: Request, res: Response) => {
    res.json({
      status: 'ok',
      demo: options.demo,
      version: options.version,
      schemaVersion: options.schemaVersion,
      // M22: the SPA picks its gate from this (a login form vs the pairing
      // ceremony). Neither value is a secret; `hasUsers` is what lets the form
      // say "no account exists yet — create one on the server" instead of
      // failing every attempt with a 401.
      authMode: auth.mode,
      ...(loginMode ? { hasUsers: (auth.users?.list().length ?? 0) > 0 } : {}),
      // M22 sign-up: `invite` when this core lets a person create their own
      // account (with a code minted on the machine), `off` otherwise. Not a
      // secret — it decides whether the gate offers a "Create an account" path
      // at all, and the form still needs a live invite to succeed.
      signupMode: signupEnabled ? 'invite' : 'off',
      // R7: the SPA reads this to refuse an over-size file BEFORE spending the
      // upload. It cannot be inferred client-side, and a refused upload that
      // already pushed megabytes over a phone connection is a bad trade for
      // not stating a limit that the server refuses by anyway.
      maxUploadBytes: uploadCap,
      // M24: the cap that decides whether an attached photo reaches the MODEL.
      // It is smaller than the upload cap, and the SPA cannot infer it: without
      // it the composer encoded a phone photo to fit 8 MB, uploaded it happily,
      // and the turn then dropped the part over 3 MB — so the persona answered
      // that no image had been sent. The SPA encodes images to THIS number.
      maxInlineImageBytes: MAX_INLINE_IMAGE_BYTES,
    });
  });

  // M15 hardening (boot identity): the shell refuses to treat a listener on
  // its port as "its" core unless it echoes the nonce the shell handed this
  // process, so a stale dev core squatting :4390 can no longer masquerade as
  // the sidecar.
  // UNLIKE the device channel below this route is always mounted — its whole
  // job is diagnostics, and the shell must be able to tell "my sidecar has not
  // bound yet" from "something else owns the port"; a missing route would
  // read as the former. It discloses nothing new: version/demo are already
  // public on /v1/health, and the nonce is a boot correlation id, so `null`
  // only means no shell spawned this core (dev/CI/container).
  app.get('/v1/boot', (_req: Request, res: Response) => {
    res.json({
      bootNonce: options.bootNonce ?? null,
      version: options.version,
      demo: options.demo,
    });
  });

  // M22: suppressed in LOGIN mode along with the rest of the pairing lane.
  if (options.demo && !loginMode) {
    app.get('/v1/dev/pair-code', async (_req: Request, res: Response) => {
      let code = await pairing.devCode();
      if (code === null) {
        // Demo seam: issue a code on first read so the e2e flow is a single
        // GET (no tray/UI to trigger issue() yet in M0).
        code = await pairing.issue();
        audit.log('pair', 'pair.issue', 'demo', { demo: true });
      }
      res.json({ code });
    });
  }

  // M15 device channel: the desktop shell (tray) mints the code for the LIVE
  // pairing ceremony on demand. Enabled only when the shell generated a
  // per-boot secret and handed it to the core in its environment — the code
  // is single-active with the usual 120s TTL and dies with the process, and
  // no other loopback caller (browser page, local process) can read it
  // without the header secret.
  if (!loginMode && options.deviceSecret !== undefined && options.deviceSecret !== '') {
    const expected = Buffer.from(options.deviceSecret, 'utf8');
    app.get('/v1/pair/device', async (req: Request, res: Response) => {
      const actual = Buffer.from(req.header('x-partner-device') ?? '', 'utf8');
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
        res.status(401).json({ error: 'device_secret_mismatch' });
        return;
      }
      const code = await pairing.issue();
      audit.log('shell', 'pair.issue.device', 'shell', {});
      res.json({ code });
    });
  }

  // 3a. M20-B S7: issue a NETWORKED pairing payload (QR / link) — LOCAL ONLY.
  //
  // M22: refused entirely in LOGIN mode. Pairing proves a DEVICE by proximity;
  // a hosted core authenticates a USER, and leaving both doors open would let
  // whoever can reach the port try the weaker one.
  app.post('/v1/pair/payload', async (req: Request, res: Response) => {
    if (loginMode) {
      refusePairingAuth(res);
      return;
    }
    if (!isLoopbackPeer(peerOf(req))) {
      audit.log('pair', 'pair.payload', 'pair', { ok: false, reason: 'loopback_required' });
      res.status(403).json({ error: 'loopback_required' });
      return;
    }
    if (options.remoteAccess !== true) {
      // A secret for another device is meaningless while only loopback can
      // reach this core, so refuse rather than hand out a dead credential.
      res.status(409).json({ error: 'remote_access_disabled' });
      return;
    }
    if (options.tlsFingerprint === undefined || pairCoreUrl === null) {
      res.status(409).json({ error: 'tls_required' });
      return;
    }
    const secret = await pairSecrets.issue();
    let payload: string;
    try {
      payload = buildPairPayload({
        coreUrl: pairCoreUrl,
        certFingerprint: options.tlsFingerprint,
        secret,
      });
    } catch {
      // A caller bug at issue time (the module refuses what it would not
      // produce). Name it without echoing the secret or the URL.
      audit.log('pair', 'pair.payload', 'pair', { ok: false, reason: 'invalid_payload' });
      res.status(500).json({ error: 'pair_payload_failed' });
      return;
    }
    audit.log('pair', 'pair.payload', 'pair', { ok: true, coreUrl: pairCoreUrl });
    res.json({ payload, coreUrl: pairCoreUrl, certFingerprint: options.tlsFingerprint });
  });

  // 3b. Pairing exchange -> mints a `web` session.
  //
  // Two credential shapes, one route, and the peer they arrived from decides
  // what they can buy (PLAN-M20-B S7):
  //  - `{code}` — the 6-digit local ceremony. Refused outright from a
  //    non-loopback peer, and mints the `desktop` class.
  //  - `{secret}` — a 256-bit single-use secret issued above, for a device
  //    that is NOT this machine. Accepted from anywhere, and NEVER mints
  //    `desktop`: it mints `mobile`. A remote request cannot reach desktop
  //    authority by any shape of request.
  // Both paths are per-peer rate-limited BEFORE any verification, and the
  // bucket is reset on success so a legitimate pairing does not consume it.
  app.post('/v1/pair', async (req: Request, res: Response) => {
    if (loginMode) {
      refusePairingAuth(res);
      return;
    }
    const peer = peerOf(req);
    const budget = pairLimiter.check(limitKeyOf(req));
    if (!budget.allowed) {
      audit.log('pair', 'pair.rate_limited', 'pair', { reason: budget.reason });
      if (budget.reason === 'invalid_clock') {
        res.status(503).json({ error: 'temporarily_unavailable' });
        return;
      }
      if (budget.reason === 'invalid_key') {
        // No attributable peer: refuse rather than pool unknown callers.
        res.status(403).json({ error: 'forbidden_peer' });
        return;
      }
      const retryAfterMs = Math.max(0, Math.ceil(budget.retryAfterMs));
      res.set('Retry-After', String(Math.ceil(retryAfterMs / 1000)));
      res.status(429).json({
        error: 'too_many_attempts',
        reason: 'rate_limited',
        retryAfterMs,
      });
      return;
    }

    const body = (req.body ?? {}) as {
      code?: unknown;
      secret?: unknown;
      deviceLabel?: unknown;
      platform?: unknown;
    };
    const code = typeof body.code === 'string' ? body.code.trim() : '';
    const secret = typeof body.secret === 'string' ? body.secret : '';
    if (code.length > 0 && secret.length > 0) {
      res.status(400).json({ error: 'invalid_pairing_request', reason: 'ambiguous_credential' });
      return;
    }
    if (code.length === 0 && secret.length === 0) {
      res.status(400).json({ error: 'invalid_pairing_request', reason: 'missing_credential' });
      return;
    }

    // Optional, non-secret device metadata for the S5 registry. Validated
    // before a credential is spent so a malformed body cannot consume one.
    const deviceLabel = readOptionalTag(body.deviceLabel, DEVICE_LABEL_MAX);
    if (deviceLabel === INVALID_TAG) {
      res.status(400).json({ error: 'invalid_pairing_request', reason: 'invalid_device_label' });
      return;
    }
    const platform = readOptionalTag(body.platform, PLATFORM_MAX);
    if (platform === INVALID_TAG) {
      res.status(400).json({ error: 'invalid_pairing_request', reason: 'invalid_platform' });
      return;
    }

    const origin = originOf(req);

    if (secret.length > 0) {
      const result = await pairSecrets.verify(secret);
      if (!result.ok) {
        audit.log('pair', 'pair.secret.verify', 'web', { ok: false, reason: result.reason });
        if (result.reason === 'locked') {
          res.status(429).json({ error: 'too_many_attempts', reason: result.reason });
          return;
        }
        res.status(401).json({ error: 'pairing_failed', reason: result.reason });
        return;
      }
      // NEVER `desktop`, and no user is named: pairing enrolls a DEVICE; the
      // authentication lane supplies user_id later (§2a).
      const created = await sessions.create({
        kind: 'web',
        origin,
        clientClass: 'mobile',
        deviceLabel: deviceLabel ?? null,
        platform: platform ?? null,
      });
      pairLimiter.reset(limitKeyOf(req));
      audit.log('pair', 'pair.secret.verify', 'web', { ok: true, clientClass: 'mobile' });
      res.json({
        token: created.token,
        kind: 'web',
        clientClass: 'mobile',
        expiresAt: created.expiresAt,
      });
      return;
    }

    // The 6-digit code is the LOCAL ceremony: refuse before verifying so a
    // remote caller can never consume (or lock) the code the user is reading
    // off their own screen.
    if (!isLoopbackPeer(peer)) {
      audit.log('pair', 'pair.verify', 'web', { ok: false, reason: 'loopback_required' });
      res.status(403).json({ error: 'loopback_required' });
      return;
    }

    const result = await pairing.verify(code);

    if (!result.ok) {
      audit.log('pair', 'pair.verify', 'web', { ok: false, reason: result.reason });
      if (result.reason === 'locked') {
        res.status(429).json({ error: 'too_many_attempts', reason: result.reason });
        return;
      }
      res.status(401).json({ error: 'pairing_failed', reason: result.reason });
      return;
    }

    // M20-B S3: the class is 'desktop' — reachable only from this machine (the
    // peer check above), and no user is named here: pairing enrolls a DEVICE,
    // the authentication lane supplies user_id later (§2a).
    const created = await sessions.create({
      kind: 'web',
      origin,
      clientClass: 'desktop',
      deviceLabel: deviceLabel ?? null,
      platform: platform ?? null,
    });
    pairLimiter.reset(limitKeyOf(req));
    audit.log('pair', 'pair.verify', 'web', { ok: true, kind: 'web', clientClass: 'desktop' });
    // The token crosses exactly this boundary; it is stored hashed and never
    // re-serialized anywhere (logs, audit, SSE).
    res.json({
      token: created.token,
      kind: 'web',
      clientClass: 'desktop',
      expiresAt: created.expiresAt,
    });
  });

  // 3c. M22: USER LOGIN — the hosted shape's only way in.
  //
  // The credential is proved against the system database (scrypt, per-user
  // lockout, timing parity for unknown users) and the session it mints carries
  // the USER, which the pairing ceremony cannot do (§2a: enrollment is not
  // authentication). Nothing about the password — or the presented username —
  // enters an audit row or a response: the row is ids and counts only.
  app.post('/v1/auth/session', async (req: Request, res: Response) => {
    if (!loginMode || auth.users === undefined || auth.capabilities === undefined) {
      res.status(403).json({
        error: 'login_disabled',
        message: 'This Partner authenticates by pairing (AUTH_MODE is not login)',
      });
      return;
    }

    const peer = peerOf(req);
    const budget = loginLimiter.check(limitKeyOf(req));
    if (!budget.allowed) {
      audit.log('auth', 'auth.signin', 'rate_limited', { ok: false, reason: budget.reason });
      if (budget.reason === 'invalid_key') {
        res.status(403).json({ error: 'forbidden_peer' });
        return;
      }
      if (budget.reason === 'invalid_clock') {
        res.status(503).json({ error: 'temporarily_unavailable' });
        return;
      }
      const retryAfterMs = Math.max(0, Math.ceil(budget.retryAfterMs));
      res.set('Retry-After', String(Math.ceil(retryAfterMs / 1000)));
      res.status(429).json({ error: 'too_many_attempts', reason: 'rate_limited', retryAfterMs });
      return;
    }

    // An instance with no account yet cannot authenticate anybody, and every
    // attempt would look like a wrong password. Say so instead: the fix is an
    // operator command, not a retry.
    const all = auth.users.list();
    if (all.length === 0) {
      res.status(409).json({
        error: 'no_account',
        message:
          'No account exists yet — create one on the machine running Partner ' +
          '(docker compose exec partner node tools/user.mjs add <name>)',
      });
      return;
    }

    const body = (req.body ?? {}) as { username?: unknown; password?: unknown };
    const username = typeof body.username === 'string' ? body.username.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    if (username === '' || password === '') {
      res.status(400).json({ error: 'invalid_input', message: 'username and password are required' });
      return;
    }

    // Username matching is case-insensitive against the LABEL the operator set
    // (and the id, so a script can use either). The password is what proves it.
    const wanted = username.toLowerCase();
    const user = all.find(
      (candidate) =>
        candidate.label.toLowerCase() === wanted || candidate.id.toLowerCase() === wanted,
    );
    // Unknown username: still spend the verification work, so "no such user"
    // and "wrong password" cost the same and cannot be told apart by timing.
    const targetId = user?.id ?? '';
    const verified = await auth.capabilities.verify(targetId, password);
    if (!verified.ok) {
      audit.log('auth', 'auth.signin', targetId === '' ? 'unknown' : targetId, {
        ok: false,
        reason: user === undefined ? 'unknown_user' : verified.reason,
      });
      if (verified.ok === false && verified.reason === 'locked') {
        const retryAfterMs = Math.max(0, verified.lockedUntil - Date.now());
        res.set('Retry-After', String(Math.ceil(retryAfterMs / 1000)));
        res.status(429).json({ error: 'too_many_attempts', reason: 'locked', retryAfterMs });
        return;
      }
      // One message for "no such user" and "wrong password" — no enumeration.
      res.status(401).json({ error: 'invalid_credentials' });
      return;
    }

    const resolution = auth.users.resolve(targetId);
    if (!resolution.ok) {
      audit.log('auth', 'auth.signin', targetId, { ok: false, reason: resolution.reason });
      res.status(403).json({ error: 'account_disabled' });
      return;
    }

    // M20-B S9: sign-in is also the UNLOCK event. The first sign-in after an
    // upgrade WRAPS the partition key under this passphrase and removes the
    // plaintext copy, so from then on "signed out" means "cannot be opened".
    // The key goes into memory for the life of the session.
    if (auth.vault !== undefined) {
      await auth.vault.adopt(resolution.user.id, password);
      const unlocked = await auth.vault.unlock(resolution.user.id, password);
      if (!unlocked) {
        // Only reachable if the wrap was written under a different passphrase
        // (an out-of-band rotation); the credential matched, so say what failed.
        audit.log('auth', 'auth.unlock', resolution.user.id, { ok: false });
        res.status(409).json({
          error: 'unlock_failed',
          message:
            'The stored key could not be unwrapped with that passphrase — the ' +
            'account was rotated outside this core. Re-run tools/user.mjs passwd.',
        });
        return;
      }
      audit.log('auth', 'auth.unlock', resolution.user.id, { ok: true });
    }

    const created = await sessions.create({
      kind: 'web',
      origin: originOf(req),
      clientClass: auth.sessionClass ?? 'desktop',
      userId: resolution.user.id,
    });
    loginLimiter.reset(limitKeyOf(req));
    audit.log('auth', 'auth.signin', resolution.user.id, {
      ok: true,
      clientClass: auth.sessionClass ?? 'desktop',
    });
    res.json({
      token: created.token,
      kind: 'web',
      clientClass: auth.sessionClass ?? 'desktop',
      userId: resolution.user.id,
      expiresAt: created.expiresAt,
    });
  });

  // 3c-bis. M22 sign-up — ISSUE A SINGLE-USE INVITE (LOCAL ONLY).
  //
  // Why the mint is loopback-only and not a button: "may this person create an
  // account here?" is an administrative decision, and a hostname the internet can
  // reach is reachable by anyone. Shell access to the machine is the operator's
  // proof of being at the machine (`docker compose exec partner node
  // tools/signup-link.mjs`), which is the same reasoning as the pairing secret.
  // The CODE is minted here; the link carrying it is built by the tool, because
  // only the operator knows what URL the person should open.
  app.post('/v1/signup/code', async (req: Request, res: Response) => {
    if (!signupEnabled) {
      res.status(403).json({
        error: 'signup_disabled',
        message:
          'Sign-up is off. Set SIGNUP_MODE=invite in the deployment to enable it, ' +
          'or create the account on the machine (tools/user.mjs add <name>).',
      });
      return;
    }
    if (!isLoopbackPeer(peerOf(req))) {
      audit.log('auth', 'auth.signup_code', 'invite', { ok: false, reason: 'loopback_required' });
      res.status(403).json({ error: 'loopback_required' });
      return;
    }
    const code = await signupSecrets.issue();
    // The code is never logged, echoed into an audit row, or written anywhere:
    // it exists in this response and in the operator's terminal.
    audit.log('auth', 'auth.signup_code', 'invite', { ok: true });
    res.status(201).json({ code });
  });

  // 3c-ter. M22 sign-up — CREATE AN ACCOUNT WITH AN INVITE.
  //
  // The person chooses their own name and passphrase; the operator never sees
  // either, which is the whole point of the invite lane (a CLI-created account
  // means the operator typed the passphrase). What this route produces is
  // byte-for-byte what `tools/user.mjs add` produces: a users row (id derived
  // from the name, `0` for the first account so a pre-partition database keeps
  // its owner) plus a scrypt credential — so a sign-up later, a CLI rotation and
  // a partition unlock are all the same account.
  app.post('/v1/auth/signup', async (req: Request, res: Response) => {
    if (!loginMode || auth.users === undefined || auth.capabilities === undefined) {
      res.status(403).json({
        error: 'login_disabled',
        message: 'This Partner authenticates by pairing (AUTH_MODE is not login)',
      });
      return;
    }
    if (!signupEnabled) {
      res.status(403).json({
        error: 'signup_disabled',
        message:
          'Sign-up is off. Ask whoever runs this Partner to create an account for you ' +
          '(tools/user.mjs add <name>), or to enable invites with SIGNUP_MODE=invite.',
      });
      return;
    }

    const budget = signupLimiter.check(limitKeyOf(req));
    if (!budget.allowed) {
      audit.log('auth', 'auth.signup', 'invite', { ok: false, reason: budget.reason });
      if (budget.reason === 'invalid_key') {
        res.status(403).json({ error: 'forbidden_peer' });
        return;
      }
      if (budget.reason === 'invalid_clock') {
        res.status(503).json({ error: 'temporarily_unavailable' });
        return;
      }
      const retryAfterMs = Math.max(0, Math.ceil(budget.retryAfterMs));
      res.set('Retry-After', String(Math.ceil(retryAfterMs / 1000)));
      res.status(429).json({ error: 'too_many_attempts', reason: 'rate_limited', retryAfterMs });
      return;
    }

    const body = (req.body ?? {}) as { code?: unknown; username?: unknown; password?: unknown };
    const code = typeof body.code === 'string' ? body.code : '';
    const username = typeof body.username === 'string' ? body.username.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    if (code === '') {
      res.status(400).json({
        error: 'invalid_input',
        reason: 'missing_invite',
        message: 'This form needs the invite link you were sent — open that link, or paste its code.',
      });
      return;
    }

    // Shape checks BEFORE the invite is spent: a typo in the passphrase must not
    // burn a one-time code. A username that is already taken still does (the
    // operator mints another), which is why both halves validate the same rules
    // (`@partner/shared/accounts`) — the browser shows exactly these sentences.
    const nameProblem = usernameProblem(username);
    if (nameProblem !== null) {
      res.status(400).json({ error: 'invalid_input', reason: 'invalid_username', message: nameProblem });
      return;
    }
    const passProblem = passphraseProblem(password);
    if (passProblem !== null) {
      res
        .status(400)
        .json({ error: 'invalid_input', reason: 'invalid_passphrase', message: passProblem });
      return;
    }

    const verified = await signupSecrets.verify(code);
    if (!verified.ok) {
      audit.log('auth', 'auth.signup', 'invite', { ok: false, reason: verified.reason });
      if (verified.reason === 'locked') {
        const retryAfterMs = 5 * 60 * 1000;
        res.set('Retry-After', String(Math.ceil(retryAfterMs / 1000)));
        res.status(429).json({ error: 'too_many_attempts', reason: verified.reason, retryAfterMs });
        return;
      }
      res.status(401).json({
        error: 'invite_failed',
        reason: verified.reason,
        message:
          'That invite has already been used or has expired. Ask for a fresh one — ' +
          'invites are single use.',
      });
      return;
    }

    // The label is what a person signs in with, and sign-in matches it
    // case-insensitively against the FIRST match, so two accounts differing only
    // in case would make one of them unreachable. Refuse the duplicate instead.
    const wanted = username.toLowerCase();
    const existing = auth.users.list();
    if (
      existing.some(
        (candidate) =>
          candidate.label.toLowerCase() === wanted || candidate.id.toLowerCase() === wanted,
      )
    ) {
      audit.log('auth', 'auth.signup', 'invite', { ok: false, reason: 'duplicate_username' });
      res.status(409).json({
        error: 'username_taken',
        message: 'That name is already taken on this Partner. Try another, or sign in instead.',
      });
      return;
    }

    // The first account owns the pre-partition database (the same rule the CLI
    // uses): a hosted core that ran single-user keeps its history instead of
    // appearing to start empty.
    const id = existing.length === 0 ? LEGACY_USER_ID : accountIdForUsername(username);
    if (!isUsableAccountId(id)) {
      // Unreachable via `usernameProblem` (it checks the same rules) — kept so a
      // future rule added in one place cannot produce an unusable partition id.
      res.status(400).json({
        error: 'invalid_input',
        reason: 'invalid_username',
        message: 'That name cannot be used for an account folder. Add a letter or digit.',
      });
      return;
    }

    const created = auth.users.create({ id, label: username });
    if (!created.ok) {
      audit.log('auth', 'auth.signup', 'invite', { ok: false, reason: created.reason });
      if (created.reason === 'duplicate_id' || created.reason === 'duplicate_os_profile') {
        res.status(409).json({
          error: 'username_taken',
          message: 'That name is already taken on this Partner. Try another, or sign in instead.',
        });
        return;
      }
      res.status(400).json({ error: 'invalid_input', reason: 'invalid_username' });
      return;
    }

    // The credential is written under the new id. If this fails the account row
    // is left WITHOUT a credential, which in login mode cannot be signed into at
    // all — so it is reported as a server fault naming the id, and the operator
    // fixes it with `tools/user.mjs passwd <name>` (the two shape refusals above
    // make an ordinary failure here unreachable).
    const stored = await auth.capabilities.create(created.user.id, password);
    if (!stored.ok) {
      audit.log('auth', 'auth.signup', created.user.id, { ok: false, reason: stored.reason });
      res.status(500).json({
        error: 'credential_not_stored',
        message:
          'The account was created but its passphrase could not be stored. Ask the ' +
          'operator to run tools/user.mjs passwd ' +
          created.user.id,
      });
      return;
    }

    signupLimiter.reset(limitKeyOf(req));
    audit.log('auth', 'auth.signup', created.user.id, { ok: true });
    // No session is minted here: signing in stays a single path (`/v1/auth/session`)
    // so a bug in this route cannot hand out authority. The SPA signs in
    // immediately with the credentials it just sent.
    res.status(201).json({ ok: true, id: created.user.id });
  });

  // 3d. M22/R1: PER-USER PARTITION DELEGATION.
  //
  // Registered AFTER the public surface and the account routes, so /v1/health,
  // /v1/boot and /v1/auth/session stay this app's business, and BEFORE the authed
  // router, so no route here ever reads a store belonging to another user. The
  // session (validated against the SHARED system sessions) names the user; that
  // user's own app then serves the request — including re-validating the token
  // itself, which is cheap and keeps the child app a normal core.
  if (options.delegate !== undefined) {
    const delegate = options.delegate;
    app.use((req: Request, res: Response, next: NextFunction) => {
      if (!req.path.startsWith('/v1/')) {
        next();
        return;
      }
      requireSession(sessions)(req, res, () => {
        const session = res.locals.session as SessionInfo | undefined;
        if (session === undefined || session.userId === null) {
          // Login mode always names a user; a session without one has no
          // partition, and guessing one would be the bug this design prevents.
          res.status(403).json({ error: 'no_partition', reason: 'session_has_no_user' });
          return;
        }
        void delegate(session.userId).then(
          (target) => {
            if (target === 'partition_locked') {
              // S9: the SESSION is valid but the user's key is not in memory
              // (signed out, idle-locked, or after a restart). Signing in again
              // unlocks it; the SPA treats this as "authenticate again".
              res.status(401).json({ error: 'unauthorized', reason: 'partition_locked' });
              return;
            }
            if (target === undefined) {
              res.status(503).json({ error: 'partition_unavailable' });
              return;
            }
            target(req, res, next);
          },
          () => res.status(503).json({ error: 'partition_unavailable' }),
        );
      });
    });
  }

  // 4. Authed group (Bearer token + origin binding). Auth is applied per
  // route so unmatched public paths fall through to the 404 handler instead
  // of being swallowed by a router-level auth middleware.
  const api = express.Router();

  /**
   * Per-route capability guard (M20-B S4): the client-class envelope of the
   * session that paid the token, mounted AFTER requireSession (which is what
   * puts the session — and its class — on res.locals) and BEFORE the broker or
   * any handler, so a refused call touches no store. The capability names come
   * from `capabilities.ts`; the class NEVER comes from the request.
   */
  const capability = (cap: Capability) => requireCapability(cap, { audit });

  api.post('/v1/chat', requireSession(sessions), capability('chat'), async (req: Request, res: Response) => {
    const session = res.locals.session as SessionInfo;
    const body = (req.body ?? {}) as {
      messages?: unknown;
      model?: unknown;
      providerId?: unknown;
      conversationId?: unknown;
      personaId?: unknown;
      taskClass?: unknown;
      attachmentIds?: unknown;
      tools?: unknown;
      noPersist?: unknown;
      continueTurn?: unknown;
    };
    const messages = sanitizeMessages(body.messages);
    if (messages === null) {
      res.status(400).json({ error: 'invalid_messages' });
      return;
    }
    // M11 F2 native function calling: the CLIENT opts a turn into tool
    // advertisement (default off keeps every existing stream byte-identical).
    const advertiseTools = body.tools === true;
    const rawAttachmentIds = Array.isArray(body.attachmentIds)
      ? body.attachmentIds.filter((entry): entry is string => typeof entry === 'string')
      : [];
    const requestedModel = optionalString(body.model);
    // M13 per-turn provider pin (the chat model picker): explicit providerId
    // is validated below and wins over persona pinning + purpose routing.
    const requestedProviderId = optionalString(body.providerId);
    const requestedPersonaId = optionalString(body.personaId);
    const requestedConversationId = optionalString(body.conversationId);
    const taskClassRaw = optionalTaskClass(body.taskClass);
    // M12.6 approval continuation: resume the conversation's NEXT persona
    // round with no new user turn. The approval decision route just posted
    // the outcome note into the conversation — this streams the assistant's
    // answer to it (the chat UI fires it after deciding an in-chat card).
    const continueTurn = body.continueTurn === true;
    if (continueTurn) {
      if (requestedConversationId === undefined || requestedConversationId === '') {
        res.status(400).json({
          error: 'bad_params',
          message: 'continueTurn requires conversationId',
        });
        return;
      }
      if (messages.length > 0) {
        res.status(400).json({
          error: 'bad_params',
          message: 'a continueTurn request carries no user messages',
        });
        return;
      }
      if (body.noPersist === true) {
        res.status(400).json({
          error: 'bad_params',
          message: 'continueTurn cannot be combined with noPersist',
        });
        return;
      }
    }
    if (
      body.taskClass !== undefined &&
      body.taskClass !== null &&
      taskClassRaw === undefined
    ) {
      res.status(400).json({
        error: 'bad_params',
        message: "taskClass must be one of chat|deep|coding|vision|cheap",
      });
      return;
    }

    // Newest user turn = what gets answered AND what is persisted as the
    // new turn; the FIRST user message titles an auto-created conversation.
    const firstUser = messages.find((m) => m.role === 'user');
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');

    // ---------------------------------------------------------------------
    // M3 persona/conversation pre-flight (PLAN-M3.md). Only when the caller
    // names a personaId OR a conversationId does chat persist; otherwise the
    // rest of this handler is byte-identical to M0/M1 one-shot chat.
    // ---------------------------------------------------------------------
    // A/B persona studio (M11): noPersist streams a persona turn WITHOUT
    // creating a conversation — comparisons never clutter the rail. SSE still
    // ends with usage/done (no done_meta, nothing persisted, no bindings).
    const noPersist = body.noPersist === true;
    const persist = !noPersist && (requestedPersonaId !== undefined || requestedConversationId !== undefined);
    let personaManager: PersonaManager | null = null;
    let conversationManager: ConversationManager | null = null;
    // The persona that supplies model routing (null = legacy no-persona).
    let routingPersona: Persona | null = null;
    // Denormalized persona id stamped on persisted message rows.
    let routingPersonaId: string | null = null;
    // Persistence target; null until an auto conversation is ensured.
    let conversationId: string | null = null;

    if (persist) {
      personaManager = requirePersonaManager(options, res);
      if (!personaManager) return;
      conversationManager = requireConversationManager(options, res);
      if (!conversationManager) return;

      // personaId given -> must exist (404) and NOT be paused (423).
      if (requestedPersonaId !== undefined) {
        const persona = personaManager.get(requestedPersonaId);
        if (!persona) {
          res.status(404).json({ error: 'not_found', message: 'persona not found' });
          return;
        }
        if (persona.paused) {
          res.status(423).json({
            error: 'persona_paused',
            message: 'persona is paused — resume it before chatting',
          });
          return;
        }
        routingPersona = persona;
        routingPersonaId = persona.id;
      }

      // conversationId given -> must exist (404); persona derives from the
      // conversation when no explicit personaId was sent.
      if (requestedConversationId !== undefined) {
        let detail: ConversationDetail;
        try {
          detail = conversationManager.get(requestedConversationId);
        } catch (err) {
          if (sendConversationError(res, err)) return;
          throw err;
        }
        conversationId = detail.summary.id;
        if (routingPersona === null && detail.summary.personaId !== null) {
          const bound = personaManager.get(detail.summary.personaId);
          if (bound) {
            // A paused persona refuses chat even when reached via a
            // conversation bound to it.
            if (bound.paused) {
              res.status(423).json({
                error: 'persona_paused',
                message: 'persona is paused — resume it before chatting',
              });
              return;
            }
            routingPersona = bound;
            routingPersonaId = bound.id;
          }
          // Bound persona deleted -> the conversation still works, no persona.
        }
      }
    }

    // ---------------------------------------------------------------------
    // Model resolution (gateway/resolver.ts): requestedModel wins; else the
    // persona's task-class mapping; else the persona's fallback; else the
    // first enabled provider's default model. No persona -> legacy routing.
    // ---------------------------------------------------------------------
    const manager = options.providerManager;
    const providers = manager ? manager.list() : [];
    // M13: an explicit per-turn provider pin must exist and be enabled — the
    // resolver trusts it (invalid ids would otherwise surface as a confusing
    // upstream model_not_found mid-stream).
    if (requestedProviderId !== undefined) {
      const target = providers.find((p) => p.id === requestedProviderId) ?? null;
      if (target === null) {
        res.status(404).json({ error: 'not_found', message: 'provider not found' });
        return;
      }
      if (!target.enabled) {
        res.status(400).json({
          error: 'provider_disabled',
          message: 'provider is disabled — enable it before chatting',
        });
        return;
      }
    }
    const resolved = resolveChatModel({
      persona: routingPersona,
      requestedModel,
      providerId: requestedProviderId,
      providers,
      taskClass: taskClassRaw ?? 'chat',
    });
    let managedProvider: ProviderSummary | null = resolved.provider;

    // Persistence helpers — best effort ONLY. A failure is logged (redacted)
    // and the stream continues: persistence must never break a chat turn.
    const logPersistenceFailure = (what: string, err: unknown): void => {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[partner-core] chat persist (${what}) failed:`, redactString(message));
    };
    // M11 F1: id of the persisted newest user turn (attachment binding +
    // context enrichment target); null until persistUserTurn runs.
    let persistedUserMessageId: string | null = null;

    // Prior persisted turns (oldest first) captured AFTER the auto
    // conversation exists but BEFORE the current user turn is appended, so
    // the upstream context never duplicates the incoming message. Set by
    // whichever branch streams the turn (managed or legacy/demo).
    let priorHistory: ConversationMessage[] = [];
    const capturePriorHistory = (): void => {
      if (conversationId === null) return;
      try {
        const detail = (conversationManager as ConversationManager).get(conversationId);
        priorHistory = detail.messages;
      } catch (err) {
        priorHistory = [];
        logPersistenceFailure('history', err);
      }
    };

    const ensureConversation = (): void => {
      if (!persist || conversationId !== null) return;
      try {
        // Auto-created conversations are bound to the routing persona; the
        // title is the first user message truncated to 60 chars (PLAN-M3).
        const title = firstUser !== undefined ? firstUser.content.slice(0, 60) : undefined;
        // D10: a persona's home folder auto-places its auto-created chats.
        const home = routingPersona?.homeFolderId;
        const homeFolder =
          home !== undefined && options.folders?.get(home) !== undefined ? home : undefined;
        const created = (conversationManager as ConversationManager).create({
          personaId: routingPersonaId ?? undefined,
          title,
          ...(homeFolder !== undefined ? { folderId: homeFolder } : {}),
        });
        conversationId = created.id;
      } catch (err) {
        logPersistenceFailure('conversation create', err);
      }
    };

    const persistUserTurn = (): void => {
      if (!persist || conversationId === null || lastUser === undefined) return;
      // A conversation that pre-existed WITHOUT a title (the web rail
      // pre-creates empty chats via POST /v1/conversations) gets titled by
      // its FIRST user message — mirroring the auto-create rule in
      // ensureConversation, so both entry paths title the same way. Only an
      // empty conversation that is still untitled is titled; a title a user
      // set explicitly is never overwritten. Best effort only.
      if (firstUser !== undefined && firstUser.content !== '') {
        try {
          const detail = (conversationManager as ConversationManager).get(conversationId);
          if (detail.messages.length === 0) {
            const existing = detail.summary.title;
            if (existing === null || existing === '') {
              (conversationManager as ConversationManager).update(conversationId, {
                title: firstUser.content.slice(0, 60),
              });
            }
          }
        } catch (err) {
          logPersistenceFailure('conversation title', err);
        }
      }
      try {
        // Per-message persona switch (PLAN-M3): the conversation follows its
        // latest message's persona, so rebind when they differ.
        if (routingPersonaId !== null) {
          const bound = (conversationManager as ConversationManager).get(conversationId).summary
            .personaId;
          if (bound !== routingPersonaId) {
            (conversationManager as ConversationManager).bindPersona(conversationId, routingPersonaId);
          }
        }
        const storedUser = (conversationManager as ConversationManager).append(conversationId, 'user', {
          content: lastUser.content,
          personaId: routingPersonaId,
          model: null,
          latencyMs: null,
        });
        persistedUserMessageId = storedUser.id;
        // Bind staged uploads named by this turn (M11 F1) — best effort.
        if (options.attachments && rawAttachmentIds.length > 0) {
          try {
            options.attachments.bindToMessage(conversationId, storedUser.id, rawAttachmentIds);
          } catch (bindErr) {
            logPersistenceFailure('attachment bind', bindErr);
          }
        }
      } catch (err) {
        logPersistenceFailure('user message', err);
      }
    };

    // Persist the assistant turn AFTER done (deltas + model + latency) and
    // emit the trailing done_meta event with the stored ids. done_meta is
    // ONLY written when the turn was actually stored.
    const persistAssistantTurn = (
      sawDone: boolean,
      deltaText: string,
      doneModel: string | null,
      doneLatencyMs: number | null,
    ): void => {
      if (!persist || !sawDone || conversationId === null) return;
      try {
        const stored = (conversationManager as ConversationManager).append(conversationId, 'assistant', {
          content: deltaText,
          personaId: routingPersonaId,
          model: doneModel,
          latencyMs: doneLatencyMs,
        });
        writeSse(res, {
          type: 'done_meta',
          messageId: stored.id,
          conversationId: stored.conversationId,
        });
      } catch (err) {
        logPersistenceFailure('assistant message', err);
      }
    };

    // Turn-accumulation shared by both streaming paths.
    let deltaText = '';
    let sawDone = false;
    let doneModel: string | null = null;
    let doneLatencyMs: number | null = null;
    const observeEvent = (event: ChatEvent): void => {
      if (event.type === 'delta') {
        deltaText += event.text;
      } else if (event.type === 'done') {
        sawDone = true;
        doneModel = event.model;
        doneLatencyMs = event.latencyMs;
      }
    };

    if (managedProvider) {
      // managedProvider is only ever non-null when a manager is wired.
      const activeManager: ProviderManager = manager as ProviderManager;
      // M13: let so an image-turn vision upgrade can reroute below.
      let model = resolved.model;
      if (model === '') {
        res.status(400).json({
          error: 'model_required',
          message: 'no model chosen — set a model in the request or run a provider test to populate defaults',
        });
        return;
      }
      // M13 image-turn vision upgrade (PLAN-M13.md F1): when an inline image
      // rides this turn and routing was IMPLICIT (no model/task/provider pin
      // from the client) but landed on a model that cannot see, hand the turn
      // to the best vision-capable model so the photo is actually analyzed
      // instead of degrading to a text stub. An EXPLICIT pick is the user's
      // confirmed choice and is never overridden.
      const implicitTurn =
        requestedModel === undefined &&
        taskClassRaw === undefined &&
        requestedProviderId === undefined;
      // M24: can this (model, serving profile) pair actually receive a photo?
      // Name heuristics alone decide "no" for a gateway alias the user has
      // assigned, so the profile's declarations are part of every answer here.
      const modelSeesImages = (provider: ProviderSummary | null, id: string): boolean =>
        isImageCapableModel(id, declaredVisionModels(provider));
      if (
        implicitTurn &&
        conversationId !== null &&
        options.attachments &&
        stagedInlineImage(options.attachments, conversationId) &&
        !modelSeesImages(managedProvider, model)
      ) {
        const upgrade = resolveImageTurnUpgrade({ persona: routingPersona, providers });
        if (
          upgrade !== null &&
          (upgrade.provider.id !== managedProvider.id || upgrade.model !== model)
        ) {
          audit.log('session', 'chat.vision_reroute', `${managedProvider.id}/${model}`, {
            to: `${upgrade.provider.id}/${upgrade.model}`,
            reason: 'image_attached',
          });
          managedProvider = upgrade.provider;
          model = upgrade.model;
        }
      }
      let client: OpenAICompatibleClient;
      try {
        client = await activeManager.clientFor(managedProvider.id);
      } catch (err) {
        if (sendProviderError(res, err)) return;
        throw err;
      }
      // Decided AFTER the handoff: `managedProvider`/`model` are what will serve
      // the turn, and this is the gate for riding the photo upstream.
      const imageTurnSupported = modelSeesImages(managedProvider, model);

      // M10 cumulative budget (PLAN-M10 W3): a provider WITH a budgetCents
      // cap is refused BEFORE this turn streams when its rolling-window
      // spend has already reached the cap — the upstream is never called.
      // The per-response tracker below remains the mid-stream hard stop.
      const ledger = options.spendLedger;
      const budgetCents = managedProvider.budgetCents ?? null;
      if (ledger !== undefined && budgetCents !== null) {
        const spentCents = ledger.spent(managedProvider.id);
        if (spentCents >= budgetCents) {
          res.status(200);
          res.set(SSE_HEADERS);
          res.flushHeaders();
          writeSse(res, {
            type: 'budget_reached',
            message: 'provider budget exhausted — no more turns until the spend window rolls',
            spentCents,
            limitCents: budgetCents,
            requests: 0,
            limitRequests: null,
          });
          res.end();
          audit.log('session', 'chat.stream', model, {
            ok: false,
            over: true,
            budgetRefused: true,
            events: 0,
            messages: messages.length,
            sessionId: session.id,
            providerId: managedProvider.id,
            ...(routingPersonaId !== null ? { personaId: routingPersonaId } : {}),
            ...(conversationId !== null ? { conversationId } : {}),
          });
          audit.log('session', 'provider.budget', managedProvider.id, {
            event: 'refused',
            spentCents,
            limitCents: budgetCents,
          });
          return;
        }
      }

      // The turn will stream: create the auto conversation + persist the
      // incoming user message BEFORE streaming (best effort).
      ensureConversation();
      capturePriorHistory();
      persistUserTurn();

      res.status(200);
      res.set(SSE_HEADERS);
      res.flushHeaders();

      // Defense-in-depth spend cap (PLAN-M1 'budget'): the per-response
      // tracker layered UNDER the M10 cumulative ledger. Enforcement is
      // WITHIN this response: deltas are charged as they stream (char/4
      // token estimate, conservative default price for unknown models) and
      // the upstream is ABORTED the moment the cap is exceeded — one
      // budget_reached event, never a done. Final usage reconciles the
      // estimate with the real token count.
      const tracker = createBudgetTracker({ budgetCents });

      // Client disconnect / budget stop: abort the upstream stream.
      const controller = new AbortController();
      const abortOnClose = (): void => {
        if (!res.writableEnded) controller.abort();
      };
      res.on('close', abortOnClose);

      // Upstream context (M3 multi-turn + persona identity): the persona's
      // system prompt first, then the M4 profile prelude, then the prior
      // persisted turns (SPA sends only the newest user message) and finally
      // the request's own messages. The prelude is never persisted.
      const tailoring =
        routingPersona !== null && options.memory
          ? buildTailoring(options.memory.profile, routingPersona)
          : null;
      const requestMessages = assembleRequestMessages({
        persona: routingPersona,
        history: priorHistory,
        requestMessages: messages,
        profilePrelude: tailoring,
        // M12 F2-capability: the internet-search tool is announced only when
        // the backend is enabled (config read is cheap + sync; the key is
        // checked at exec time with a clear note when missing).
        searchEnabled: options.search !== undefined && options.search.config().enabled === true,
        // M26 D8: the authoring contract, under the same conditions as the two
        // advertised authoring tools below (never for a turn that cannot act).
        authoringToolIds:
          routingPersona !== null
            ? authoringToolIdsFor(
                routingPersona,
                (res.locals.session as SessionInfo).clientClass,
                options,
              )
            : null,
        continueTurn,
      });

      // M11 F1: enrich the newest user turn with its bound attachment text
      // (extracts for text, descriptors for images) before it reaches the
      // provider. The persisted content stays unchanged.
      if (persistedUserMessageId !== null && options.attachments) {
        appendAttachmentContext(
          requestMessages,
          options.attachments.contextForMessage(persistedUserMessageId),
        );
      }

      // M11 F1 file refs: partner-file:// mentions inside roots the user has
      // GRANTED files.read on are read (capped) and appended so the persona
      // sees the file. Grant-less refs are skipped — nothing is read blindly.
      if (options.broker !== undefined && lastUser !== undefined) {
        const broker = options.broker;
        const excerpt = fileRefsExcerpt(lastUser.content, {
          hasReadGrant: (rootId: string) =>
            broker.grants.hasGrant('files.read', rootId, Date.now()),
          read: (params) => broker.exec('files.read', params, { requestedBy: 'web' }),
          rootLabel: (rootId: string) =>
            broker.roots.list().find((root) => root.id === rootId)?.label ?? null,
        });
        if (excerpt !== '') appendAttachmentContext(requestMessages, excerpt);
      }

      // M11 multimodal: a bound IMAGE attachment rides the newest user turn
      // as an inline image part — but ONLY to an image-capable model in the
      // managed path. The persisted turn stays plain text.
      //
      // "Image-capable" includes what the user DECLARED on the serving profile
      // (M24): behind an OpenAI-compatible gateway the model ids are
      // operator-chosen aliases, so a name-only heuristic silently decided that
      // a model which can see cannot, and the photo never left the machine —
      // the model was handed just the text descriptor and answered that no
      // image arrived.
      if (persistedUserMessageId !== null && options.attachments && imageTurnSupported) {
        try {
          // EVERY qualifying photo rides, in attach order — taking only the
          // first silently withheld the rest of a multi-photo turn. Bounded by
          // count and per-image size; anything left behind is still named in
          // the descriptor context, which now says it was not sent.
          const metas =
            conversationId === null
              ? []
              : options.attachments
                  .metaForMessage(persistedUserMessageId)
                  .filter(
                    (meta) =>
                      meta.mime.startsWith('image/') && meta.size <= MAX_INLINE_IMAGE_BYTES,
                  )
                  .slice(0, MAX_INLINE_IMAGES_PER_TURN);
          const parts: ChatImagePart[] = [];
          for (const meta of metas) {
            const image =
              conversationId === null
                ? null
                : options.attachments.content(conversationId, meta.id);
            if (image !== null) {
              parts.push({ mime: image.mime, dataBase64: image.data.toString('base64') });
            }
          }
          if (parts.length > 0) {
            for (let index = requestMessages.length - 1; index >= 0; index -= 1) {
              const message = requestMessages[index];
              if (message && message.role === 'user') {
                requestMessages[index] = { ...message, images: parts };
                break;
              }
            }
          }
        } catch (imgErr) {
          logPersistenceFailure('image part', imgErr);
        }
      }

      const chatRequest: ChatRequest = {
        model,
        messages: requestMessages,
        stream: true,
        signal: controller.signal,
        ...(routingPersona !== null
          ? { temperature: routingPersona.character.temperature }
          : {}),
      };
      // M11 F2: advertise the broker's file tools when the client asked and
      // the persona can act (assist never gets tools).
      if (advertiseTools && options.broker !== undefined && routingPersona !== null) {
        if (routingPersona.independence.level !== 'assist') {
          chatRequest.tools = options.broker.manifests.map((m) => ({
            type: 'function',
            function: {
              name: m.id,
              description: m.description,
              parameters: { type: 'object', properties: {}, additionalProperties: true },
            },
          }));
        }
      }
      // M12 F2-capability: the external `search` tool joins the advertisement
      // ONLY when the persona could actually run it (enabled backend,
      // auto/autonomous, not banned) — the same default-deny gate as the
      // system-prompt announcement above.
      if (
        advertiseTools &&
        routingPersona !== null &&
        options.search !== undefined &&
        canRunSearchTool(routingPersona, options.search.config().enabled === true)
      ) {
        chatRequest.tools = Array.isArray(chatRequest.tools) ? chatRequest.tools : [];
        chatRequest.tools.push({
          type: 'function',
          function: {
            name: SEARCH_MANIFEST.id,
            description: SEARCH_MANIFEST.description,
            parameters: {
              type: 'object',
              properties: { query: { type: 'string' } },
              required: ['query'],
            },
          },
        });
      }
      // M26 cut C: the authoring external tools for THIS turn. The conversation
      // and persona are bound here, at the only place that knows them, so a
      // chat-authored draft and its install ask belong to the right chat. It is
      // wired whether or not the turn ADVERTISES the tools: the directive form
      // works too, and D8 governs what the model is TOLD, not what a client
      // class may ask for (the tool pass applies the class envelope itself).
      const authoringTool =
        routingPersona !== null && options.broker !== undefined
          ? authoringToolExternal({
              drafts: options.skillDrafts,
              toolIds: new Set(options.broker.manifests.map((manifest) => manifest.id)),
              conversationId,
              personaId: routingPersona.id,
            })
          : undefined;
      // M26 D8: the two authoring tools join the advertisement ONLY when the
      // persona could actually use them (desktop session, `skill.author`,
      // independence >= suggest, neither id banned). Default-deny, exactly like
      // search above - an `assist` persona is never told authoring exists.
      if (advertiseTools && routingPersona !== null && authoringTool !== undefined) {
        const authoringIds = authoringToolIdsFor(
          routingPersona,
          (res.locals.session as SessionInfo).clientClass,
          options,
        );
        if (authoringIds !== null) {
          chatRequest.tools = Array.isArray(chatRequest.tools) ? chatRequest.tools : [];
          chatRequest.tools.push(...authoringFunctionTools(new Set(authoringIds)));
        }
      }
      let events = 0;
      let ok = true;
      let over = false;
      let estTokens = 0;
      // M10 cumulative ledger settlement: exact cents once a usage event
      // reconciles the turn, otherwise the conservative estimate; null when
      // nothing was billable (external abort). Settled once per turn.
      let settledCents: number | null = null;
      /** M11 F2: native tool calls collected from this turn's stream. */
      let nativeCalls: ToolCall[] = [];

      const emitBudgetReached = (spentCents: number): void => {
        writeSse(res, {
          type: 'budget_reached',
          message: 'budget reached — stream stopped',
          spentCents,
          limitCents: budgetCents,
          requests: events,
          limitRequests: null,
        });
      };

      try {
        for await (const event of client.chatStream(chatRequest)) {
          if (event.type === 'delta') {
            estTokens += Math.max(1, Math.ceil(event.text.length / 4));
            if (budgetCents !== null) {
              const tentative = tracker.spentCents + centsForTokens(model, estTokens);
              if (tentative >= budgetCents) {
                over = true;
                settledCents = tentative;
                controller.abort();
                emitBudgetReached(tentative);
                break;
              }
            }
            writeSse(res, event);
            events += 1;
            observeEvent(event);
            continue;
          }
          if (event.type === 'usage') {
            // Reconcile with the real count (est was tentative only).
            const rec = tracker.charge({ model, totalTokens: event.totalTokens });
            settledCents = rec.spentCents;
            if (rec.over) {
              over = true;
              controller.abort();
              emitBudgetReached(rec.spentCents);
              break;
            }
            writeSse(res, event);
            events += 1;
            continue;
          }
          if (event.type === 'tool_calls') {
            // Native function calls are turn machinery — never forwarded to
            // the client stream; they execute through the tool pass below.
            nativeCalls = event.calls;
            continue;
          }
          if (event.type === 'error') ok = false;
          writeSse(res, event);
          events += 1;
          observeEvent(event);
        }
        persistAssistantTurn(sawDone, deltaText, doneModel, doneLatencyMs);
        // M11 F2 (slice 1): chat-directive tool pass. When the finished
        // persona reply carried [[partner:tool …]] directives, authorize +
        // broker each one; outcome notes persist as system messages so the
        // next turn's history carries them. The note is ALSO streamed live
        // and, when a tool actually ran (or was refused), a `tool_continue`
        // event asks the client for one continuation round so the persona
        // answers against the result in the same interaction — otherwise the
        // promise ("let me look that up") is followed by silence.
        if (
          !over &&
          sawDone &&
          persist &&
          conversationId !== null &&
          routingPersona !== null &&
          options.broker !== undefined
        ) {
          const activeConversationId: string = conversationId;
          const externalTools = [
            searchToolExternal(options.search),
            mcpToolExternal(options.mcp),
            // M26 cut C: the authoring tools built above. The provider declares
            // `capability: 'skill.author'`, so the tool pass refuses them by
            // client class BEFORE execute-vs-queue (a mobile or extension turn
            // is refused with the device note, like any broker tool it may not
            // use).
            authoringTool,
          ].filter((tool): tool is NonNullable<typeof tool> => tool !== undefined);
          try {
            const appendSystemNote = (content: string): void => {
              try {
                (conversationManager as ConversationManager).append(
                  activeConversationId,
                  'system',
                  {
                    content,
                    personaId: null,
                    model: doneModel,
                    latencyMs: null,
                  },
                );
              } catch (noteErr) {
                logPersistenceFailure('tool note', noteErr);
              }
              // Live transcript: the note exists in the DB either way, but the
              // SPA must render it without a reload (see tool_note contract).
              // Guard the socket: a client that left mid-turn must not break
              // the pass (the note is persisted above regardless).
              try {
                if (!res.writableEnded) writeSse(res, { type: 'tool_note', content });
              } catch (sseErr) {
                logPersistenceFailure('tool note sse', sseErr);
              }
            };
            const directivePass = await runChatToolPass(deltaText, {
              persona: routingPersona,
              broker: options.broker,
              external: externalTools,
              audit,
              conversationId: activeConversationId,
              // M20-B S4: the persona's tool calls inherit the SESSION's class.
              // Without this the loop reached the broker class-less, which
              // defaulted to the desktop envelope and let a mobile turn execute
              // a granted write.
              clientClass: (res.locals.session as SessionInfo).clientClass,
              appendSystemNote,
            });
            // M11 F2 native function calls (same gate/broker, same notes).
            let nativePass: { decisions: ChatToolDecision[] } = { decisions: [] };
            if (nativeCalls.length > 0) {
              nativePass = await runNativeToolCalls(nativeCalls, {
                persona: routingPersona,
                broker: options.broker,
                external: externalTools,
                audit,
                conversationId: activeConversationId,
                clientClass: (res.locals.session as SessionInfo).clientClass,
                appendSystemNote,
              });
            }
            const decisions = [...directivePass.decisions, ...nativePass.decisions];
            // Continue when the model has something new to answer against: a
            // tool ran, or it was refused for a reason it should react to.
            // `queued` is excluded — that approval is the user's move, and
            // the approval flow runs its own continuation after the decision.
            if (decisions.some((decision) => decision.decision !== 'queued')) {
              if (!res.writableEnded) writeSse(res, { type: 'tool_continue' });
            }
          } catch (toolErr) {
            // A tool-pass failure must never break the turn that finished.
            logPersistenceFailure('tool pass', toolErr);
          }
        }
        // Natural end without a usage event: settle the conservative
        // estimate so the ledger still reflects the turn.
        if (settledCents === null && estTokens > 0) {
          settledCents = centsForTokens(model, estTokens);
        }
      } catch {
        // External abort (client gone) ends the generator silently; only
        // surface an error if the socket is still open.
        if (!res.writableEnded) {
          ok = false;
          writeSse(res, { type: 'error', message: 'provider_stream_failed' });
        }
      } finally {
        // M10 cumulative ledger settle — once per turn, from the exact
        // usage reconciliation or the conservative estimate. External
        // aborts that produced nothing leave settledCents null.
        if (
          ledger !== undefined &&
          budgetCents !== null &&
          settledCents !== null &&
          settledCents > 0
        ) {
          const rec = ledger.charge({
            providerId: managedProvider.id,
            cents: settledCents,
          });
          audit.log('session', 'provider.budget', managedProvider.id, {
            event: 'charged',
            cents: settledCents,
            spentCents: rec.spentCents,
            limitCents: budgetCents,
            ...(rec.spentCents >= budgetCents ? { reached: true } : {}),
          });
        }
        res.removeListener('close', abortOnClose);
        res.end();
        audit.log('session', 'chat.stream', model, {
          ok,
          events,
          over,
          messages: messages.length,
          sessionId: session.id,
          providerId: managedProvider.id,
          ...(routingPersonaId !== null ? { personaId: routingPersonaId } : {}),
          ...(conversationId !== null ? { conversationId } : {}),
        });
        // M19 automatic remember: persisted, provider-routed turns are
        // scanned OUT OF BAND. res.end() has already fired, so the client
        // never waits on extraction; the manager tracks the work so tests can
        // await idle(). Two independent consents (M19 follow-up): GLOBAL
        // facts ride the user-level setting, PERSONA-scoped facts ride the
        // persona's private-memory toggle — so global detection works with
        // the persona toggle off, and vice versa.
        const rememberGlobalAuto =
          options.memory?.settings.autoRememberGlobal() === true;
        const rememberPersonaOn = routingPersona?.memory.personaMemory === 'on';
        if (
          persist &&
          sawDone &&
          !continueTurn &&
          conversationId !== null &&
          routingPersona !== null &&
          options.memory !== undefined &&
          (rememberGlobalAuto || rememberPersonaOn) &&
          (lastUser !== undefined || deltaText.trim() !== '')
        ) {
          options.memory.remember.enqueue({
            personaId: routingPersona.id,
            userText: lastUser?.content ?? '',
            assistantText: deltaText,
            conversationId,
            // Ride the exact provider/model that served this turn when the
            // persona's cheap/chat target cannot be resolved on its own (a
            // provider with no default models, e.g. a per-message model
            // pick). Without this, auto-remember silently never runs.
            fallbackTarget: { client, model },
            // Only the scopes whose consent is on may be filed.
            policy: { global: rememberGlobalAuto, persona: rememberPersonaOn },
          });
        }
      }
      return;
    }

    // Legacy/demo path — EXACT M0 behaviour (tests + e2e assert the demo
    // stream 'demo: received … characters').
    const model = requestedModel ?? 'demo';
    const provider = pickProvider(options);
    if (!provider) {
      res.status(501).json({ error: 'no_provider' });
      return;
    }

    // The turn will stream: auto conversation + persisted user turn first.
    ensureConversation();
    capturePriorHistory();
    persistUserTurn();

    let requestMessages = assembleRequestMessages({
      persona: routingPersona,
      history: priorHistory,
      requestMessages: messages,
      continueTurn,
    });
    if (persistedUserMessageId !== null && options.attachments) {
      appendAttachmentContext(
        requestMessages,
        options.attachments.contextForMessage(persistedUserMessageId),
      );
    }
    // M11 F1 file refs (legacy/demo path mirror).
    if (options.broker !== undefined && lastUser !== undefined) {
      const broker = options.broker;
      const excerpt = fileRefsExcerpt(lastUser.content, {
        hasReadGrant: (rootId: string) => broker.grants.hasGrant('files.read', rootId, Date.now()),
        read: (params) => broker.exec('files.read', params, { requestedBy: 'web' }),
        rootLabel: (rootId: string) =>
          broker.roots.list().find((root) => root.id === rootId)?.label ?? null,
      });
      if (excerpt !== '') appendAttachmentContext(requestMessages, excerpt);
    }
    const chatRequest: ChatRequest = {
      model,
      messages: requestMessages,
      stream: true,
      ...(routingPersona !== null ? { temperature: routingPersona.character.temperature } : {}),
    };

    res.status(200);
    res.set(SSE_HEADERS);
    res.flushHeaders();

    let events = 0;
    let ok = true;
    try {
      for await (const event of provider.chatStream(chatRequest)) {
        writeSse(res, event);
        events += 1;
        observeEvent(event);
      }
      persistAssistantTurn(sawDone, deltaText, doneModel, doneLatencyMs);
    } catch {
      ok = false;
      writeSse(res, { type: 'error', message: 'provider_stream_failed' });
    } finally {
      res.end();
      audit.log('session', 'chat.stream', model, {
        ok,
        events,
        messages: messages.length,
        sessionId: session.id,
        ...(routingPersonaId !== null ? { personaId: routingPersonaId } : {}),
        ...(conversationId !== null ? { conversationId } : {}),
      });
    }
  });

  // -------------------------------------------------------------------------
  // M1 provider API (PLAN-M1.md wire spec) — every route authed + audited;
  // responses NEVER contain the key, keyRef, or Authorization material.
  // -------------------------------------------------------------------------

  api.get('/v1/providers', requireSession(sessions), (_req: Request, res: Response) => {
    const manager = requireProviderManager(options, res);
    if (!manager) return;
    // M10: providers with a budget cap carry their current window spend so
    // the UI can show remaining budget (additive field; ledger optional).
    const ledger = options.spendLedger;
    const providers = manager.list();
    res.json({
      providers:
        ledger === undefined
          ? providers
          : providers.map((p) =>
              p.budgetCents === null || p.budgetCents === undefined
                ? p
                : { ...p, spentCents: ledger.spent(p.id) },
            ),
    });
  });

  api.post('/v1/providers', requireSession(sessions), async (req: Request, res: Response) => {
    const manager = requireProviderManager(options, res);
    if (!manager) return;
    try {
      const summary = await manager.create((req.body ?? {}) as ProviderInput);
      res.status(201).json(summary);
    } catch (err) {
      if (sendProviderError(res, err)) return;
      throw err;
    }
  });

  /**
   * M24 — edit a profile's non-secret fields (the model lists, purpose, name,
   * enabled, budget). The one the vision fix turns on: a photo attached to a
   * turn routed by a name the core does not recognise needs the user to be able
   * to SAY "this model can see", on a provider that already works — not to
   * delete and re-add it. The endpoint and the key are not editable here (the
   * secret lives in the keychain under the provider id); audit carries field
   * names and counts only.
   */
  api.put('/v1/providers/:id', requireSession(sessions), (req: Request, res: Response) => {
    const manager = requireProviderManager(options, res);
    if (!manager) return;
    try {
      res.json(manager.update(String(req.params.id ?? ''), (req.body ?? {}) as ProviderPatch));
    } catch (err) {
      if (sendProviderError(res, err)) return;
      throw err;
    }
  });

  // M13 purpose-provider bundle (PLAN-M13.md F2): one OpenAI-compatible
  // endpoint + one key -> one provider profile PER purpose (general | cheap |
  // deep | coding | vision | research), so purpose routing has real profiles
  // to pick. The single key is stored into each profile's own keychain item
  // (never the DB or a response). When the caller supplies `modelPins` (a
  // map of purpose -> model ids, as fetched by /v1/providers/discover), each
  // purpose profile carries EXACTLY the pinned models — the first one is the
  // purpose's default when a persona has no override. Without pins the
  // heuristic applies (vision keeps image-capable models, others the full
  // list). The chat probe is left to the per-profile Test button.
  api.post('/v1/providers/purposes', requireSession(sessions), async (req: Request, res: Response) => {
    const manager = requireProviderManager(options, res);
    if (!manager) return;
    const body = (req.body ?? {}) as {
      endpoint?: unknown;
      key?: unknown;
      purposes?: unknown;
      modelPins?: unknown;
      budgetCents?: unknown;
    };
    if (typeof body.key !== 'string' || body.key.trim() === '') {
      res.status(400).json({ error: 'invalid_input', message: 'key is required and must be a non-empty string' });
      return;
    }
    if (
      body.budgetCents !== undefined &&
      body.budgetCents !== null &&
      typeof body.budgetCents !== 'number'
    ) {
      res.status(400).json({ error: 'invalid_input', message: 'budgetCents must be a number of cents or null' });
      return;
    }
    const budgetCents =
      typeof body.budgetCents === 'number' ? Math.round(body.budgetCents) : null;
    const rawPurposes = Array.isArray(body.purposes) ? body.purposes : null;
    if (rawPurposes !== null && rawPurposes.some((p) => typeof p !== 'string' || !isProviderPurpose(p))) {
      res.status(400).json({ error: 'invalid_input', message: 'purposes contains an unknown purpose tag' });
      return;
    }
    const purposes = rawPurposes === null
      ? [...PROVIDER_PURPOSES]
      : PROVIDER_PURPOSES.filter((p) => (rawPurposes as unknown[]).includes(p));
    if (purposes.length === 0) {
      res.status(400).json({ error: 'invalid_input', message: 'purposes must be a non-empty array of purpose tags' });
      return;
    }
    // modelPins (M13): present -> must be a full, valid assignment for the
    // requested purposes (every purpose needs a non-empty model list).
    let modelPins: Partial<Record<ProviderPurpose, string[]>> | null = null;
    if (body.modelPins !== undefined) {
      try {
        modelPins = parseModelPins(body.modelPins);
      } catch (err) {
        if (sendProviderError(res, err)) return;
        throw err;
      }
    }
    try {
      const endpoint = normalizeEndpoint(body.endpoint);
      const key = body.key.trim();
      const client = createOpenAICompatibleClient({ endpoint, apiKey: key });
      const models = await client.listModels();
      const visionModels = models.filter((model) => isImageCapableModel(model));
      if (modelPins !== null) {
        const missing = purposes.filter((p) => modelPins[p] === undefined || modelPins[p].length === 0);
        if (missing.length > 0) {
          throw new ProviderError(
            'invalid_input',
            `modelPins must assign at least one model to every requested purpose (missing: ${missing.join(', ')})`,
          );
        }
        const modelSet = new Set(models);
        for (const purpose of purposes) {
          for (const model of modelPins[purpose] ?? []) {
            if (!modelSet.has(model)) {
              throw new ProviderError(
                'invalid_input',
                `model "${model}" (purpose ${purpose}) is not in the provider's model list`,
              );
            }
          }
        }
      }
      const created: ProviderSummary[] = [];
      for (const purpose of purposes) {
        const pinned = modelPins?.[purpose];
        // What this profile's models are for, decided by the user: a `vision`
        // purpose means every model pinned to it can see (M24 declares them
        // explicitly, so the declaration also survives the purpose tag later
        // changing to something else). Other purposes declare only the models
        // the shared hints recognise.
        const visionForPurpose =
          purpose === 'vision'
            ? (pinned ?? models.filter((m) => isImageCapableModel(m)))
            : [];
        const summary = await manager.create({
          name: `${PURPOSE_LABELS[purpose]} · ${endpointHost(endpoint)}`,
          purpose,
          endpoint,
          ...(budgetCents !== null ? { budgetCents } : {}),
          // Explicit pins win; otherwise the heuristic: vision keeps the
          // models that can actually see, every other profile carries the
          // full list so persona task-class pins resolve to real ids.
          defaultModels:
            pinned ??
            (purpose === 'vision' && visionModels.length > 0 ? visionModels : models),
          visionModels: visionForPurpose,
        });
        await manager.setKey(summary.id, key);
        created.push(summary);
      }
      res.status(201).json({ created, models });
    } catch (err) {
      if (err instanceof UpstreamError) {
        res.status(502).json({ error: 'upstream', message: err.message });
        return;
      }
      if (sendProviderError(res, err)) return;
      throw err;
    }
  });

  // M13 pre-bundle model discovery: fetch the upstream /models for an
  // endpoint + key WITHOUT persisting anything. The web UI uses it so the
  // user can assign models to purposes BEFORE adding the purpose providers
  // (the key is never stored by this route and never returns).
  api.post('/v1/providers/discover', requireSession(sessions), async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { endpoint?: unknown; key?: unknown };
    if (typeof body.key !== 'string' || body.key.trim() === '') {
      res.status(400).json({ error: 'invalid_input', message: 'key is required and must be a non-empty string' });
      return;
    }
    try {
      const endpoint = normalizeEndpoint(body.endpoint);
      const client = createOpenAICompatibleClient({ endpoint, apiKey: body.key.trim() });
      const models = await client.listModels();
      audit.log('web', 'provider.discover', endpointHost(endpoint), { models: models.length });
      res.json({ endpoint, models });
    } catch (err) {
      if (err instanceof UpstreamError) {
        res.status(502).json({ error: 'upstream', message: err.message });
        return;
      }
      if (sendProviderError(res, err)) return;
      throw err;
    }
  });

  api.post(
    '/v1/providers/:id/key',
    requireSession(sessions),
    capability('provider.configure'),
    async (req: Request, res: Response) => {
    const manager = requireProviderManager(options, res);
    if (!manager) return;
    const id = String(req.params.id ?? '');
    const body = (req.body ?? {}) as { key?: unknown };
    if (typeof body.key !== 'string' || body.key.trim() === '') {
      res.status(400).json({ error: 'invalid_input', message: 'key is required and must be a non-empty string' });
      return;
    }
    try {
      await manager.setKey(id, body.key);
    } catch (err) {
      if (sendProviderError(res, err)) return;
      throw err;
    }
    res.status(204).end();
  });

  api.post('/v1/providers/:id/test', requireSession(sessions), async (req: Request, res: Response) => {
    const manager = requireProviderManager(options, res);
    if (!manager) return;
    const id = String(req.params.id ?? '');
    try {
      const summary = await manager.test(id);
      res.json(summary);
    } catch (err) {
      if (sendProviderError(res, err)) return;
      throw err;
    }
  });

  api.delete('/v1/providers/:id', requireSession(sessions), async (req: Request, res: Response) => {
    const manager = requireProviderManager(options, res);
    if (!manager) return;
    const id = String(req.params.id ?? '');
    try {
      await manager.remove(id);
      // M10 W3: drop the provider's spend ledger row with it (no stale spend
      // if the same profile id is re-created in the window).
      options.spendLedger?.reset(id);
    } catch (err) {
      if (sendProviderError(res, err)) return;
      throw err;
    }
    res.status(204).end();
  });

  api.get('/v1/models', requireSession(sessions), async (req: Request, res: Response) => {
    const manager = requireProviderManager(options, res);
    if (!manager) return;
    const id = typeof req.query.provider === 'string' && req.query.provider !== '' ? req.query.provider : '';
    if (id === '') {
      res.status(400).json({ error: 'invalid_input', message: 'provider query parameter is required' });
      return;
    }
    if (!manager.get(id)) {
      res.status(404).json({ error: 'not_found', message: 'provider not found' });
      return;
    }
    let client: OpenAICompatibleClient;
    try {
      client = await manager.clientFor(id);
    } catch (err) {
      if (sendProviderError(res, err)) return;
      throw err;
    }
    try {
      const models = await client.listModels();
      res.json({ models });
    } catch (err) {
      if (err instanceof UpstreamError) {
        res.status(502).json({ error: 'upstream', message: err.message });
        return;
      }
      throw err;
    }
  });

  api.get('/v1/audit', requireSession(sessions), (req: Request, res: Response) => {
    const raw = typeof req.query.limit === 'string' ? Number.parseInt(req.query.limit, 10) : NaN;
    const limit = Number.isFinite(raw)
      ? Math.min(MAX_AUDIT_LIMIT, Math.max(1, raw))
      : DEFAULT_AUDIT_LIMIT;
    const opt = (v: unknown): string | undefined =>
      typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
    res.json({
      entries: audit.query({
        limit,
        actor: opt(req.query.actor),
        action: opt(req.query.action),
        q: opt(req.query.q),
      }),
    });
  });

  // -------------------------------------------------------------------------
  // M3 persona surface (PLAN-M3 wire spec) — CRUD + pause/resume + default
  // invariants (409 when deleting the default persona). Every route authed;
  // responses are shared Persona wire shapes (no secrets exist on a persona).
  // -------------------------------------------------------------------------

  api.get('/v1/personas', requireSession(sessions), (req: Request, res: Response) => {
    const manager = requirePersonaManager(options, res);
    if (!manager) return;
    res.json({ personas: manager.list() });
  });

  api.post('/v1/personas', requireSession(sessions), (req: Request, res: Response) => {
    const manager = requirePersonaManager(options, res);
    if (!manager) return;
    try {
      const persona = manager.create(req.body);
      res.status(201).json(persona);
    } catch (err) {
      if (sendPersonaError(res, err)) return;
      throw err;
    }
  });

  api.put('/v1/personas/:id', requireSession(sessions), (req: Request, res: Response) => {
    const manager = requirePersonaManager(options, res);
    if (!manager) return;
    const id = String(req.params.id ?? '');
    try {
      const persona = manager.update(id, req.body);
      res.status(200).json(persona);
    } catch (err) {
      if (sendPersonaError(res, err)) return;
      throw err;
    }
  });

  api.delete('/v1/personas/:id', requireSession(sessions), (req: Request, res: Response) => {
    const manager = requirePersonaManager(options, res);
    if (!manager) return;
    const id = String(req.params.id ?? '');
    try {
      manager.remove(id);
    } catch (err) {
      if (sendPersonaError(res, err)) return;
      throw err;
    }
    res.status(204).end();
  });

  api.post('/v1/personas/:id/pause', requireSession(sessions), (req: Request, res: Response) => {
    const manager = requirePersonaManager(options, res);
    if (!manager) return;
    const id = String(req.params.id ?? '');
    try {
      res.status(200).json(manager.pause(id));
    } catch (err) {
      if (sendPersonaError(res, err)) return;
      throw err;
    }
  });

  api.post('/v1/personas/:id/resume', requireSession(sessions), (req: Request, res: Response) => {
    const manager = requirePersonaManager(options, res);
    if (!manager) return;
    const id = String(req.params.id ?? '');
    try {
      res.status(200).json(manager.resume(id));
    } catch (err) {
      if (sendPersonaError(res, err)) return;
      throw err;
    }
  });

  // -------------------------------------------------------------------------
  // M3 conversation surface (PLAN-M3 wire spec) — recent conversations with
  // message counts, explicit create, transcript GET, delete (cascade). Every
  // route authed; wire shapes are shared ConversationSummary/Message.
  // -------------------------------------------------------------------------

  api.get('/v1/conversations', requireSession(sessions), (req: Request, res: Response) => {
    const manager = requireConversationManager(options, res);
    if (!manager) return;
    res.json({ conversations: manager.list() });
  });

  api.post('/v1/conversations', requireSession(sessions), (req: Request, res: Response) => {
    const manager = requireConversationManager(options, res);
    if (!manager) return;
    const body = (req.body ?? {}) as {
      personaId?: unknown;
      title?: unknown;
      folderId?: unknown;
      parentId?: unknown;
      sourceAssetId?: unknown;
    };
    let folderId = optionalString(body.folderId);
    if (folderId !== undefined) {
      const folders = requireFolders(options, res);
      if (!folders) return;
      if (!folders.get(folderId)) {
        res.status(400).json({ error: 'folder_not_found', message: 'folder not found' });
        return;
      }
    } else {
      // D10 home folder: a persona's new chats auto-land in its home folder.
      const personaId = optionalString(body.personaId);
      const persona = personaId !== undefined && options.personaManager ? options.personaManager.get(personaId) : null;
      const home = persona?.homeFolderId;
      if (home !== undefined && options.folders?.get(home)) {
        folderId = home;
      }
    }
    // M16 F4 discuss lineage (PLAN-M16.md): a forked discussion points at its
    // parent (must still exist) and the asset that sparked it.
    const parentId = optionalString(body.parentId);
    if (parentId !== undefined && parentId !== null) {
      try {
        manager.get(parentId);
      } catch {
        res.status(400).json({ error: 'parent_not_found', message: 'parent conversation not found' });
        return;
      }
    }
    try {
      const sourceAssetId = optionalString(body.sourceAssetId);
      const summary = manager.create({
        personaId: optionalString(body.personaId),
        title: optionalString(body.title),
        ...(folderId !== undefined ? { folderId } : {}),
        ...(parentId !== undefined ? { parentId } : {}),
        ...(sourceAssetId !== undefined ? { sourceAssetId } : {}),
      });
      res.status(201).json(summary);
    } catch (err) {
      if (sendConversationError(res, err)) return;
      throw err;
    }
  });

  api.get('/v1/conversations/:id', requireSession(sessions), (req: Request, res: Response) => {
    const manager = requireConversationManager(options, res);
    if (!manager) return;
    const id = String(req.params.id ?? '');
    try {
      const detail = manager.get(id);
      const extra: Record<string, unknown> = {};
      if (options.attachments) {
        // M11 F1: attachment metadata grouped by message + staged uploads.
        const byMessage: Record<string, unknown[]> = {};
        const staged: unknown[] = [];
        for (const meta of options.attachments.list(id)) {
          if (meta.messageId === null) staged.push(meta);
          else {
            (byMessage[meta.messageId] ??= []).push(meta);
          }
        }
        extra.attachmentsByMessage = byMessage;
        extra.stagedAttachments = staged;
      }
      res.status(200).json({ conversation: detail.summary, messages: detail.messages, ...extra });
    } catch (err) {
      if (sendConversationError(res, err)) return;
      throw err;
    }
  });

  api.delete('/v1/conversations/:id', requireSession(sessions), (req: Request, res: Response) => {
    const manager = requireConversationManager(options, res);
    if (!manager) return;
    const id = String(req.params.id ?? '');
    try {
      manager.remove(id);
    } catch (err) {
      if (sendConversationError(res, err)) return;
      throw err;
    }
    res.status(204).end();
  });

  api.put('/v1/conversations/:id', requireSession(sessions), (req: Request, res: Response) => {
    const manager = requireConversationManager(options, res);
    if (!manager) return;
    const id = String(req.params.id ?? '');
    const body = (req.body ?? {}) as { title?: unknown; folderId?: unknown };
    const folderId = optionalString(body.folderId);
    if (body.folderId !== undefined && body.folderId !== null) {
      if (folderId !== undefined) {
        const folders = requireFolders(options, res);
        if (!folders) return;
        if (!folders.get(folderId)) {
          res.status(400).json({ error: 'folder_not_found', message: 'folder not found' });
          return;
        }
      }
    }
    const title =
      body.title === undefined || body.title === null ? undefined : String(body.title);
    try {
      const summary = manager.update(id, {
        ...(title !== undefined ? { title } : {}),
        ...(body.folderId !== undefined ? { folderId: folderId ?? null } : {}),
      });
      res.status(200).json({ conversation: summary });
    } catch (err) {
      if (sendConversationError(res, err)) return;
      throw err;
    }
  });

  // -----------------------------------------------------------------------
  // M11 F11 folder surface (PLAN-M11.md) — the conversation tree: create,
  // list, rename/move (cycle-guarded server-side), delete (children + chats
  // reparent to the removed folder's parent = Inbox when it was a root).
  // Every route authed; audit carries folder ids/names only.
  // -----------------------------------------------------------------------

  api.get('/v1/folders', requireSession(sessions), (_req: Request, res: Response) => {
    const folders = requireFolders(options, res);
    if (!folders) return;
    res.json({ folders: folders.list() });
  });

  api.post('/v1/folders', requireSession(sessions), (req: Request, res: Response) => {
    const folders = requireFolders(options, res);
    if (!folders) return;
    const body = (req.body ?? {}) as { name?: unknown; parentId?: unknown };
    try {
      const created = folders.create({
        name: typeof body.name === 'string' ? body.name : '',
        ...(optionalString(body.parentId) !== undefined
          ? { parentId: optionalString(body.parentId) as string }
          : {}),
      });
      res.status(201).json(created);
    } catch (err) {
      if (sendFolderError(res, err)) return;
      throw err;
    }
  });

  api.put('/v1/folders/:id', requireSession(sessions), (req: Request, res: Response) => {
    const folders = requireFolders(options, res);
    if (!folders) return;
    const id = String(req.params.id ?? '');
    const body = (req.body ?? {}) as { name?: unknown; parentId?: unknown };
    try {
      const updated = folders.update(id, {
        ...(body.name !== undefined && body.name !== null
          ? { name: String(body.name) }
          : {}),
        ...(body.parentId !== undefined ? { parentId: optionalString(body.parentId) ?? null } : {}),
      });
      res.status(200).json(updated);
    } catch (err) {
      if (sendFolderError(res, err)) return;
      throw err;
    }
  });

  api.delete('/v1/folders/:id', requireSession(sessions), (req: Request, res: Response) => {
    const folders = requireFolders(options, res);
    if (!folders) return;
    const id = String(req.params.id ?? '');
    try {
      folders.remove(id);
    } catch (err) {
      if (sendFolderError(res, err)) return;
      throw err;
    }
    res.status(204).end();
  });

  // -----------------------------------------------------------------------
  // M11 F1 chat-attachment surface (PLAN-M11.md). Staged uploads live on a
  // conversation until the next /v1/chat names them (attachmentIds), then
  // bind to the persisted user turn. Payload bytes are conversation-scoped
  // owner data served only through /content. Every route authed.
  // -----------------------------------------------------------------------

  api.get(
    '/v1/conversations/:id/attachments',
    requireSession(sessions),
    (req: Request, res: Response) => {
      const attachments = requireAttachments(options, res);
      if (!attachments) return;
      const conversationId = String(req.params.id ?? '');
      const manager = requireConversationManager(options, res);
      if (!manager) return;
      try {
        manager.get(conversationId); // 404 when the conversation is unknown
        res.json({ attachments: attachments.list(conversationId) });
      } catch (err) {
        if (sendConversationError(res, err)) return;
        throw err;
      }
    },
  );

  api.post(
    '/v1/conversations/:id/attachments',
    requireSession(sessions),
    // R7: the file IS the body. `express.raw` (not `express.json`) is what
    // makes `MAX_UPLOAD_BYTES` the real ceiling — the base64 JSON envelope it
    // replaces spent a third of the bytes on encoding and was bounded by the
    // 1 MiB JSON cap instead, so the advertised 8 MiB was unreachable.
    express.raw({ type: '*/*', limit: uploadCap }),
    (req: Request, res: Response) => {
      const attachments = requireAttachments(options, res);
      if (!attachments) return;
      const conversationId = String(req.params.id ?? '');
      const manager = requireConversationManager(options, res);
      if (!manager) return;
      if (!Buffer.isBuffer(req.body)) {
        // Either no body at all, or a body some other parser claimed (an old
        // client still sending the base64 JSON envelope). Say what an upload
        // must look like instead of returning a shape error.
        res.status(400).json({
          error: 'invalid_input',
          message:
            'send the file bytes as the request body, with the file content type and an x-attachment-name header',
        });
        return;
      }
      try {
        manager.get(conversationId); // 404 when the conversation is unknown
        const meta = attachments.upload(conversationId, {
          name: attachmentNameHeader(req.headers['x-attachment-name']),
          mime: attachmentMimeHeader(req.headers['content-type']),
          data: req.body,
        });
        res.status(201).json(meta);
      } catch (err) {
        if (sendConversationError(res, err)) return;
        if (sendAttachmentError(res, err)) return;
        throw err;
      }
    },
  );

  api.delete(
    '/v1/conversations/:id/attachments/:attId',
    requireSession(sessions),
    (req: Request, res: Response) => {
      const attachments = requireAttachments(options, res);
      if (!attachments) return;
      const conversationId = String(req.params.id ?? '');
      const attId = String(req.params.attId ?? '');
      try {
        attachments.remove(conversationId, attId);
      } catch (err) {
        if (sendAttachmentError(res, err)) return;
        throw err;
      }
      res.status(204).end();
    },
  );

  api.get(
    '/v1/conversations/:id/attachments/:attId/content',
    requireSession(sessions),
    (req: Request, res: Response) => {
      const attachments = requireAttachments(options, res);
      if (!attachments) return;
      const conversationId = String(req.params.id ?? '');
      const attId = String(req.params.attId ?? '');
      const content = attachments.content(conversationId, attId);
      if (content === null) {
        res.status(404).json({ error: 'not_found', message: 'attachment content not found' });
        return;
      }
      // Policy lives in one exported place (PLAN-M20.md §8.1.1): executable
      // document types never render on the SPA's origin.
      for (const [header, value] of Object.entries(
        attachmentContentHeaders(content.mime, content.name),
      )) {
        res.setHeader(header, value);
      }
      res.send(content.data);
    },
  );

  // -----------------------------------------------------------------------
  // M11 F10 asset surface (PLAN-M11.md) — typed saved artifacts per
  // conversation; POST takes an ARRAY of AssetInput for one-click "save this
  // response"; promote turns an asset into a Note (F6 handshake). Bodies are
  // owner content; audit rows carry ids/kinds/lengths only.
  // -----------------------------------------------------------------------

  api.get(
    '/v1/conversations/:id/assets',
    requireSession(sessions),
    (req: Request, res: Response) => {
      const assets = requireAssets(options, res);
      if (!assets) return;
      const conversationId = String(req.params.id ?? '');
      const manager = requireConversationManager(options, res);
      if (!manager) return;
      try {
        manager.get(conversationId); // 404 when the conversation is unknown
        res.json({ assets: assets.list(conversationId) });
      } catch (err) {
        if (sendConversationError(res, err)) return;
        throw err;
      }
    },
  );

  api.post(
    '/v1/conversations/:id/assets',
    requireSession(sessions),
    (req: Request, res: Response) => {
      const assets = requireAssets(options, res);
      if (!assets) return;
      const conversationId = String(req.params.id ?? '');
      const manager = requireConversationManager(options, res);
      if (!manager) return;
      try {
        manager.get(conversationId); // 404 when the conversation is unknown
        const raw = Array.isArray(req.body) ? req.body : (req.body as { items?: unknown })?.items;
        const inputs = Array.isArray(raw) ? raw : [];
        if (inputs.length === 0) {
          res.status(400).json({ error: 'invalid_input', message: 'no assets to save' });
          return;
        }
        const created = inputs.map((entry) =>
          assets.create(conversationId, entry as Parameters<AssetManager['create']>[1]),
        );
        res.status(201).json({ assets: created });
      } catch (err) {
        if (sendConversationError(res, err)) return;
        if (sendAssetError(res, err)) return;
        throw err;
      }
    },
  );

  api.delete(
    '/v1/conversations/:id/assets/:assetId',
    requireSession(sessions),
    (req: Request, res: Response) => {
      const assets = requireAssets(options, res);
      if (!assets) return;
      const conversationId = String(req.params.id ?? '');
      const assetId = String(req.params.assetId ?? '');
      try {
        assets.remove(conversationId, assetId);
      } catch (err) {
        if (sendAssetError(res, err)) return;
        throw err;
      }
      res.status(204).end();
    },
  );

  api.post(
    '/v1/conversations/:id/assets/:assetId/promote',
    requireSession(sessions),
    (req: Request, res: Response) => {
      const assets = requireAssets(options, res);
      if (!assets) return;
      const conversationId = String(req.params.id ?? '');
      const assetId = String(req.params.assetId ?? '');
      try {
        const result = assets.promote(conversationId, assetId);
        res.status(200).json({ noteId: result.noteId });
      } catch (err) {
        if (sendAssetError(res, err)) return;
        throw err;
      }
    },
  );

  // -------------------------------------------------------------------------
  // M16 F4 asset Discuss (PLAN-M16.md). :id = the asset's ORIGIN conversation
  // (the discussion the asset was born in). 'continue' = open that same
  // discussion (the asset stays in its thread); 'fork' = a NEW conversation
  // that is a child thread of the origin, carrying the asset as provenance
  // (lineage columns parent_id + source_asset_id). The UI composes the first
  // user turn with the asset body quoted; nothing is sent implicitly.
  // -------------------------------------------------------------------------

  api.post(
    '/v1/conversations/:id/assets/:assetId/discuss',
    requireSession(sessions),
    (req: Request, res: Response) => {
      const assets = requireAssets(options, res);
      if (!assets) return;
      const originConversationId = String(req.params.id ?? '');
      const assetId = String(req.params.assetId ?? '');
      const body = (req.body ?? {}) as { mode?: unknown };
      const mode: 'continue' | 'fork' =
        body.mode === 'fork' ? 'fork' : 'continue';
      const asset = assets.list(originConversationId).find((entry) => entry.id === assetId);
      if (!asset) {
        res.status(404).json({ error: 'not_found', message: 'asset not found' });
        return;
      }
      if (mode === 'fork') {
        const manager = requireConversationManager(options, res);
        if (!manager) return;
        let personaId: string | undefined;
        try {
          personaId = manager.get(originConversationId).summary.personaId ?? undefined;
        } catch {
          // Origin conversation gone (orphan asset row) — fork stands alone.
        }
        if (personaId === undefined && options.personaManager) {
          const fallback = options.personaManager.list().find((persona) => persona.isDefault);
          personaId = fallback?.id;
        }
        let folderId: string | undefined;
        try {
          folderId = manager.get(originConversationId).summary.folderId ?? undefined;
        } catch {
          folderId = undefined;
        }
        const title = `Discuss — ${asset.title}`.slice(0, 120);
        try {
          const summary = manager.create({
            personaId,
            title,
            ...(folderId !== undefined ? { folderId } : {}),
            parentId: originConversationId,
            sourceAssetId: assetId,
          });
          audit.log('web', 'asset.discuss', assetId, {
            conversationId: summary.id,
            originConversationId,
            mode: 'fork',
          });
          res.status(201).json({
            conversationId: summary.id,
            mode: 'fork' as const,
            assetId,
            originConversationId,
          });
        } catch (err) {
          if (sendConversationError(res, err)) return;
          throw err;
        }
        return;
      }
      audit.log('web', 'asset.discuss', assetId, {
        conversationId: originConversationId,
        originConversationId,
        mode: 'continue',
      });
      res.status(200).json({
        conversationId: originConversationId,
        mode: 'continue' as const,
        assetId,
        originConversationId,
      });
    },
  );

  // -----------------------------------------------------------------------
  // M11 F2 MCP surface (PLAN-M11.md — slice 2). Stdio server config
  // (default-deny OFF), tool catalog listing, and USER-initiated tool calls
  // (the paired session is the user). Persona auto-calls arrive with the
  // broker-integration slice. Every route authed; audit rows are
  // mcp.* with ids/tool names only — never args or results.
  // -----------------------------------------------------------------------

  api.get('/v1/mcp/servers', requireSession(sessions), (_req: Request, res: Response) => {
    const mcp = requireMcp(options, res);
    if (!mcp) return;
    res.json({ servers: mcp.list() });
  });

  // M20-B S4 (blocker fix): registering or EDITING an MCP server takes an
  // arbitrary `command`/`args` and an `enabled` toggle, and an enabled server is
  // SPAWNED as a child process with the user's privileges (mcp/client.ts).
  // Ungated, that made the envelope's `mcp.call` guard meaningless: any class
  // could register + enable a command and then invoke it. Configuring is at
  // least as powerful as calling, so it clears the same bar. (If a future class
  // may call but not configure, split a `mcp.configure` capability here.)
  api.post(
    '/v1/mcp/servers',
    requireSession(sessions),
    capability('mcp.call'),
    (req: Request, res: Response) => {
    const mcp = requireMcp(options, res);
    if (!mcp) return;
    try {
      const server = mcp.create((req.body ?? {}) as McpServerInput);
      res.status(201).json(server);
    } catch (err) {
      if (sendMcpError(res, err)) return;
      throw err;
    }
  });

  api.put(
    '/v1/mcp/servers/:id',
    requireSession(sessions),
    capability('mcp.call'),
    (req: Request, res: Response) => {
    const mcp = requireMcp(options, res);
    if (!mcp) return;
    const id = String(req.params.id ?? '');
    try {
      const server = mcp.update(id, (req.body ?? {}) as McpServerUpdate);
      res.status(200).json(server);
    } catch (err) {
      if (sendMcpError(res, err)) return;
      throw err;
    }
  });

  api.delete(
    '/v1/mcp/servers/:id',
    requireSession(sessions),
    capability('mcp.call'),
    (req: Request, res: Response) => {
    const mcp = requireMcp(options, res);
    if (!mcp) return;
    const id = String(req.params.id ?? '');
    try {
      mcp.remove(id);
    } catch (err) {
      if (sendMcpError(res, err)) return;
      throw err;
    }
    res.status(204).end();
  });

  api.get('/v1/mcp/servers/:id/tools', requireSession(sessions), (req: Request, res: Response) => {
    const mcp = requireMcp(options, res);
    if (!mcp) return;
    const id = String(req.params.id ?? '');
    void mcp
      .listTools(id)
      .then((tools) => res.status(200).json({ tools }))
      .catch((err) => {
        if (sendMcpError(res, err)) return;
        res.status(500).json({ error: 'internal', message: 'could not list tools' });
      });
  });

  api.post('/v1/mcp/servers/:id/call', requireSession(sessions), capability('mcp.call'), (req: Request, res: Response) => {
    const mcp = requireMcp(options, res);
    if (!mcp) return;
    const id = String(req.params.id ?? '');
    void mcp
      .call(id, (req.body ?? {}) as McpCallInput)
      .then((result) => res.status(200).json(result))
      .catch((err) => {
        if (sendMcpError(res, err)) return;
        res.status(500).json({ error: 'internal', message: 'tool call failed' });
      });
  });

  // -----------------------------------------------------------------------
  // M11 F2 search surface (PLAN-M11.md): one optional API-key backend.
  // Config + key are default-deny (enabled flag + keychain-held key); the
  // query route is the USER-initiated search (explicit consent). The same
  // backend powers the chat `search` tool (directive/native) via
  // searchToolExternal. Audit: query LENGTH + hit count only.
  // -----------------------------------------------------------------------

  api.get('/v1/search/config', requireSession(sessions), (_req: Request, res: Response) => {
    const search = requireSearch(options, res);
    if (!search) return;
    void (async () => {
      const config = search.config();
      const keys = await search.keyStatus();
      res.status(200).json({ ...config, hasKey: keys[config.provider], keys });
    })();
  });

  api.put('/v1/search/config', requireSession(sessions), (req: Request, res: Response) => {
    const search = requireSearch(options, res);
    if (!search) return;
    try {
      const next = search.updateConfig((req.body ?? {}) as SearchConfigInput);
      void (async () => {
        const keys = await search.keyStatus();
        res.status(200).json({ ...next, hasKey: keys[next.provider], keys });
      })();
    } catch (err) {
      if (sendSearchError(res, err)) return;
      throw err;
    }
  });

  api.put(
    '/v1/search/key',
    requireSession(sessions),
    capability('provider.configure'),
    (req: Request, res: Response) => {
    const search = requireSearch(options, res);
    if (!search) return;
    const body = (req.body ?? {}) as { key?: unknown; provider?: unknown };
    const provider = body.provider;
    if (provider !== undefined && !isSearchProvider(provider)) {
      res.status(400).json({ error: 'invalid_input', message: 'provider must be tavily or brave' });
      return;
    }
    void search
      .setKey(typeof body.key === 'string' ? body.key : '', provider)
      .then(() => res.status(204).end())
      .catch((err) => {
        if (sendSearchError(res, err)) return;
        throw err;
      });
  });

  api.delete(
    '/v1/search/key',
    requireSession(sessions),
    capability('provider.configure'),
    (req: Request, res: Response) => {
      const search = requireSearch(options, res);
      if (!search) return;
      const provider = req.query.provider;
      if (provider !== undefined && !isSearchProvider(provider)) {
        res.status(400).json({ error: 'invalid_input', message: 'provider must be tavily or brave' });
        return;
      }
      void search.removeKey(provider).then(() => res.status(204).end());
    },
  );

  api.post('/v1/search/query', requireSession(sessions), (req: Request, res: Response) => {
    const search = requireSearch(options, res);
    if (!search) return;
    const body = (req.body ?? {}) as { query?: unknown; maxResults?: unknown };
    void search
      .search(
        typeof body.query === 'string' ? body.query : '',
        typeof body.maxResults === 'number' ? body.maxResults : undefined,
      )
      .then((result) => res.status(200).json(result))
      .catch((err) => {
        if (sendSearchError(res, err)) return;
        res.status(500).json({ error: 'internal', message: 'search failed' });
      });
  });

  // -------------------------------------------------------------------------
  // M4 memory surface (PLAN-M4 wire spec) — profile entries, episode
  // summaries, FTS search, forgetting, export/import. Every route authed;
  // responses carry the OWNER's memory (user data by design) but audit rows
  // only ever carry ids, kinds and lengths — never memory content.
  // -------------------------------------------------------------------------

  // M19 follow-up: the user-level consent for GLOBAL auto-remember. Persona
  // detection stays per-persona; this flag governs facts that apply
  // everywhere. Default ON (suggestions still require confirmation).
  api.get('/v1/memory/settings', requireSession(sessions), (_req: Request, res: Response) => {
    const memory = requireMemory(options, res);
    if (!memory) return;
    res.json({ autoRememberGlobal: memory.settings.autoRememberGlobal() });
  });

  api.put('/v1/memory/settings', requireSession(sessions), (req: Request, res: Response) => {
    const memory = requireMemory(options, res);
    if (!memory) return;
    const body = (req.body ?? {}) as { autoRememberGlobal?: unknown };
    if (typeof body.autoRememberGlobal !== 'boolean') {
      res.status(400).json({
        error: 'invalid_input',
        message: 'autoRememberGlobal must be a boolean',
      });
      return;
    }
    res.json({
      autoRememberGlobal: memory.settings.setAutoRememberGlobal(body.autoRememberGlobal),
    });
  });

  api.get('/v1/memory/profile', requireSession(sessions), (req: Request, res: Response) => {
    const memory = requireMemory(options, res);
    if (!memory) return;
    const includeRejected =
      req.query.includeRejected === '1' || req.query.includeRejected === 'true';
    const scopeRaw = req.query.personaScope;
    res.json({
      profile: memory.profile.list({
        includeRejected,
        ...(typeof scopeRaw === 'string' && scopeRaw.trim() !== ''
          ? { personaScope: scopeRaw.trim() }
          : {}),
      }),
    });
  });

  api.post('/v1/memory/profile', requireSession(sessions), (req: Request, res: Response) => {
    const memory = requireMemory(options, res);
    if (!memory) return;
    try {
      const entry = memory.profile.add((req.body ?? {}) as never);
      res.status(201).json(entry);
    } catch (err) {
      if (sendMemoryError(res, err)) return;
      throw err;
    }
  });

  api.put('/v1/memory/profile/:id', requireSession(sessions), (req: Request, res: Response) => {
    const memory = requireMemory(options, res);
    if (!memory) return;
    const id = String(req.params.id ?? '');
    try {
      const entry = memory.profile.update(id, (req.body ?? {}) as never);
      res.status(200).json(entry);
    } catch (err) {
      if (sendMemoryError(res, err)) return;
      throw err;
    }
  });

  api.delete('/v1/memory/profile/:id', requireSession(sessions), (req: Request, res: Response) => {
    const memory = requireMemory(options, res);
    if (!memory) return;
    const id = String(req.params.id ?? '');
    try {
      memory.profile.remove(id);
    } catch (err) {
      if (sendMemoryError(res, err)) return;
      throw err;
    }
    res.status(204).end();
  });

  api.get('/v1/memory/episodes', requireSession(sessions), (req: Request, res: Response) => {
    const memory = requireMemory(options, res);
    if (!memory) return;
    res.json({ episodes: memory.episodes.list() });
  });

  api.post(
    '/v1/memory/episodes/:conversationId',
    requireSession(sessions),
    async (req: Request, res: Response) => {
      const memory = requireMemory(options, res);
      if (!memory) return;
      try {
        const { episode, created } = await memory.episodes.summarize(
          String(req.params.conversationId ?? ''),
        );
        res.status(created ? 201 : 200).json(episode);
      } catch (err) {
        if (sendMemoryError(res, err)) return;
        if (sendConversationError(res, err)) return;
        throw err;
      }
    },
  );

  api.delete('/v1/memory/episodes/:id', requireSession(sessions), (req: Request, res: Response) => {
    const memory = requireMemory(options, res);
    if (!memory) return;
    const id = String(req.params.id ?? '');
    try {
      memory.episodes.remove(id);
    } catch (err) {
      if (sendMemoryError(res, err)) return;
      throw err;
    }
    res.status(204).end();
  });

  api.get('/v1/memory/search', requireSession(sessions), (req: Request, res: Response) => {
    const memory = requireMemory(options, res);
    if (!memory) return;
    const q = typeof req.query.q === 'string' ? req.query.q : '';
    try {
      res.json({ hits: memory.search.query(q) });
    } catch (err) {
      if (sendMemoryError(res, err)) return;
      throw err;
    }
  });

  api.post('/v1/memory/forget', requireSession(sessions), (req: Request, res: Response) => {
    const memory = requireMemory(options, res);
    if (!memory) return;
    try {
      const removed = memory.forget.forget((req.body ?? {}) as never);
      res.json({ removed });
    } catch (err) {
      if (sendMemoryError(res, err)) return;
      throw err;
    }
  });

  api.get('/v1/memory/export', requireSession(sessions), (req: Request, res: Response) => {
    const memory = requireMemory(options, res);
    if (!memory) return;
    res.json(memory.transfer.exportBundle());
  });

  api.post('/v1/memory/import', requireSession(sessions), (req: Request, res: Response) => {
    const memory = requireMemory(options, res);
    if (!memory) return;
    try {
      const body = (req.body ?? {}) as { bundle?: unknown };
      const imported = memory.transfer.importBundle(body.bundle);
      res.json({ imported });
    } catch (err) {
      if (sendMemoryError(res, err)) return;
      throw err;
    }
  });

  // -------------------------------------------------------------------------
  // M5 notes + tags surface (PLAN-M5 wire spec). Notes are the owner's local
  // markdown: create/update parse wiki-links ([[Title]], resolved/dangling),
  // search rides the notes_fts mirror, daily() creates today's note on first
  // touch, capture() splits title/body, and /daily/summarize appends (or
  // replaces) the '## Daily summary' section. Every route authed; responses
  // carry the OWNER's note content by design, but audit rows only ever carry
  // ids and lengths — never note content. Literal single-segment paths are
  // registered BEFORE '/v1/notes/:id' so Express never treats 'capture' or
  // 'export' as an id.
  // -------------------------------------------------------------------------

  api.get('/v1/notes', requireSession(sessions), (req: Request, res: Response) => {
    const notes = requireNotes(options, res);
    if (!notes) return;
    // M17: ?folderId=<id> scopes to that project subtree; ?folderId=none
    // scopes to unfiled (Inbox). A scope needs the shared folder tree.
    const folderParam = typeof req.query.folderId === 'string' ? req.query.folderId : undefined;
    if (folderParam !== undefined) {
      const folders = requireFolders(options, res);
      if (!folders) return;
    }
    try {
      const filter =
        folderParam === undefined
          ? undefined
          : folderParam === 'none'
            ? { unfiled: true }
            : { folderId: folderParam };
      res.json({ notes: notes.list(filter) });
    } catch (err) {
      if (sendNoteError(res, err)) return;
      throw err;
    }
  });

  api.post('/v1/notes', requireSession(sessions), (req: Request, res: Response) => {
    const notes = requireNotes(options, res);
    if (!notes) return;
    try {
      const note = notes.create((req.body ?? {}) as NoteInput);
      res.status(201).json(note);
    } catch (err) {
      if (sendNoteError(res, err)) return;
      throw err;
    }
  });

  api.post('/v1/notes/capture', requireSession(sessions), (req: Request, res: Response) => {
    const notes = requireNotes(options, res);
    if (!notes) return;
    const body = (req.body ?? {}) as { text?: unknown };
    try {
      const note = notes.capture(body.text);
      res.status(201).json(note);
    } catch (err) {
      if (sendNoteError(res, err)) return;
      throw err;
    }
  });

  api.get('/v1/notes/daily', requireSession(sessions), (req: Request, res: Response) => {
    const notes = requireNotes(options, res);
    if (!notes) return;
    res.json(notes.daily());
  });

  api.post('/v1/notes/daily/summarize', requireSession(sessions), async (req: Request, res: Response) => {
    const notes = requireNotes(options, res);
    if (!notes) return;
    try {
      const note = await notes.summarizeDaily();
      res.json(note);
    } catch (err) {
      if (sendNoteError(res, err)) return;
      throw err;
    }
  });

  api.get('/v1/notes/search', requireSession(sessions), (req: Request, res: Response) => {
    const notes = requireNotes(options, res);
    if (!notes) return;
    const q = typeof req.query.q === 'string' ? req.query.q : '';
    try {
      res.json({ notes: notes.search(q) });
    } catch (err) {
      if (sendNoteError(res, err)) return;
      throw err;
    }
  });

  api.get('/v1/notes/export', requireSession(sessions), (req: Request, res: Response) => {
    const notes = requireNotes(options, res);
    if (!notes) return;
    res.json(notes.exportAll());
  });

  // -------------------------------------------------------------------------
  // M16 F1/F2/F3 notes graph, brainstorm + version history (PLAN-M16.md).
  // Literal segments sit before GET /v1/notes/:id so 'graph'/'brainstorm'
  // are never swallowed by the :id param route.
  // -------------------------------------------------------------------------

  api.get('/v1/notes/graph', requireSession(sessions), (req: Request, res: Response) => {
    const notes = requireNotes(options, res);
    if (!notes) return;
    // M17: ?folderId=<id|none> scopes the graph to a project subtree (or
    // unfiled) and returns one-hop externalNodes (ghosts) on both sides.
    const folderParam = typeof req.query.folderId === 'string' ? req.query.folderId : undefined;
    if (folderParam !== undefined) {
      const folders = requireFolders(options, res);
      if (!folders) return;
    }
    let graph: ReturnType<typeof notes.graph>;
    try {
      const filter =
        folderParam === undefined
          ? undefined
          : folderParam === 'none'
            ? { unfiled: true }
            : { folderId: folderParam };
      graph = notes.graph(filter);
    } catch (err) {
      if (sendNoteError(res, err)) return;
      throw err;
    }
    // M16 follow-up: link brainstorm sessions back to their source nodes so
    // the graph can badge notes and resolve "open the existing brainstorm".
    // Best-effort — a linkage failure must never break the graph read. M17:
    // a scoped read keeps only sessions touching an in-scope node.
    if (options.brainstorm) {
      try {
        const list = options.brainstorm.sessions();
        const scoped = folderParam !== undefined;
        const inScope = new Set(graph.nodes.map((node) => node.id));
        const relevant = scoped
          ? list.filter((session) => session.noteIds.some((id) => inScope.has(id)))
          : list;
        if (relevant.length > 0) graph.brainstorms = relevant;
      } catch {
        /* linkage is advisory */
      }
    }
    res.json(graph);
  });

  api.put('/v1/notes/graph/positions', requireSession(sessions), (req: Request, res: Response) => {
    const notes = requireNotes(options, res);
    if (!notes) return;
    const body = (req.body ?? {}) as { positions?: unknown };
    if (!Array.isArray(body.positions) || body.positions.length === 0) {
      res.status(400).json({ error: 'invalid_input', message: 'positions must be a non-empty array' });
      return;
    }
    try {
      for (const entry of body.positions) {
        const item = entry as { noteId?: unknown; x?: unknown; y?: unknown };
        if (typeof item.noteId !== 'string' || item.noteId === '') {
          res.status(400).json({ error: 'invalid_input', message: 'each position needs a noteId' });
          return;
        }
        notes.setPosition(item.noteId, item.x as number, item.y as number);
      }
      res.status(204).end();
    } catch (err) {
      if (sendNoteError(res, err)) return;
      throw err;
    }
  });

  api.post('/v1/notes/brainstorm', requireSession(sessions), async (req: Request, res: Response) => {
    const brainstorm = requireBrainstorm(options, res);
    if (!brainstorm) return;
    try {
      const result = await brainstorm.start((req.body ?? {}) as never);
      res.status(201).json(result);
    } catch (err) {
      if (sendBrainstormError(res, err)) return;
      throw err;
    }
  });

  // M16 follow-up: list linked brainstorms (optionally for one note) and flip
  // a session between concluded and reopenable. Owner actions; ids only.
  api.get('/v1/notes/brainstorm', requireSession(sessions), (req: Request, res: Response) => {
    const brainstorm = requireBrainstorm(options, res);
    if (!brainstorm) return;
    const noteId = typeof req.query.noteId === 'string' && req.query.noteId !== '' ? req.query.noteId : null;
    const conversationId =
      typeof req.query.conversationId === 'string' && req.query.conversationId !== ''
        ? req.query.conversationId
        : null;
    try {
      if (conversationId !== null) {
        // One conversation's linked brainstorm (or null) — the chat header.
        res.json({ session: brainstorm.byConversation(conversationId) });
        return;
      }
      res.json({
        sessions: noteId === null ? brainstorm.sessions() : brainstorm.sessionsForNote(noteId),
      });
    } catch (err) {
      if (sendBrainstormError(res, err)) return;
      throw err;
    }
  });

  api.post(
    '/v1/notes/brainstorm/:conversationId/conclude',
    requireSession(sessions),
    (req: Request, res: Response) => {
      const brainstorm = requireBrainstorm(options, res);
      if (!brainstorm) return;
      const conversationId = String(req.params.conversationId ?? '');
      try {
        res.json({ session: brainstorm.conclude(conversationId) });
      } catch (err) {
        if (sendBrainstormError(res, err)) return;
        throw err;
      }
    },
  );

  api.post(
    '/v1/notes/brainstorm/:conversationId/reopen',
    requireSession(sessions),
    (req: Request, res: Response) => {
      const brainstorm = requireBrainstorm(options, res);
      if (!brainstorm) return;
      const conversationId = String(req.params.conversationId ?? '');
      try {
        res.json({ session: brainstorm.reopen(conversationId) });
      } catch (err) {
        if (sendBrainstormError(res, err)) return;
        throw err;
      }
    },
  );

  api.get('/v1/notes/:id/versions', requireSession(sessions), (req: Request, res: Response) => {
    const notes = requireNotes(options, res);
    if (!notes) return;
    const id = String(req.params.id ?? '');
    try {
      res.json({ versions: notes.versions(id) });
    } catch (err) {
      if (sendNoteError(res, err)) return;
      throw err;
    }
  });

  api.get(
    '/v1/notes/:id/versions/:versionId',
    requireSession(sessions),
    (req: Request, res: Response) => {
      const notes = requireNotes(options, res);
      if (!notes) return;
      const id = String(req.params.id ?? '');
      const versionId = String(req.params.versionId ?? '');
      try {
        res.json({ version: notes.version(id, versionId) });
      } catch (err) {
        if (sendNoteError(res, err)) return;
        throw err;
      }
    },
  );

  api.post('/v1/notes/:id/restore', requireSession(sessions), (req: Request, res: Response) => {
    const notes = requireNotes(options, res);
    if (!notes) return;
    const id = String(req.params.id ?? '');
    const body = (req.body ?? {}) as { versionId?: unknown };
    if (typeof body.versionId !== 'string' || body.versionId === '') {
      res.status(400).json({ error: 'invalid_input', message: 'versionId is required' });
      return;
    }
    try {
      res.json({ note: notes.restore(id, body.versionId) });
    } catch (err) {
      if (sendNoteError(res, err)) return;
      throw err;
    }
  });

  api.get('/v1/tags', requireSession(sessions), (req: Request, res: Response) => {
    const notes = requireNotes(options, res);
    if (!notes) return;
    res.json({ tags: notes.listTags() });
  });

  api.get('/v1/notes/:id', requireSession(sessions), (req: Request, res: Response) => {
    const notes = requireNotes(options, res);
    if (!notes) return;
    const id = String(req.params.id ?? '');
    try {
      const note = notes.get(id);
      if (note === null) {
        res.status(404).json({ error: 'not_found', message: 'note not found' });
        return;
      }
      res.json({ note, links: notes.links(id) });
    } catch (err) {
      if (sendNoteError(res, err)) return;
      throw err;
    }
  });

  api.put('/v1/notes/:id', requireSession(sessions), (req: Request, res: Response) => {
    const notes = requireNotes(options, res);
    if (!notes) return;
    const id = String(req.params.id ?? '');
    try {
      res.json(notes.update(id, (req.body ?? {}) as never));
    } catch (err) {
      if (sendNoteError(res, err)) return;
      throw err;
    }
  });

  api.delete('/v1/notes/:id', requireSession(sessions), (req: Request, res: Response) => {
    const notes = requireNotes(options, res);
    if (!notes) return;
    const id = String(req.params.id ?? '');
    try {
      notes.remove(id);
    } catch (err) {
      if (sendNoteError(res, err)) return;
      throw err;
    }
    res.status(204).end();
  });

  api.get('/v1/notes/:id/backlinks', requireSession(sessions), (req: Request, res: Response) => {
    const notes = requireNotes(options, res);
    if (!notes) return;
    const id = String(req.params.id ?? '');
    try {
      res.json({ backlinks: notes.backlinks(id) });
    } catch (err) {
      if (sendNoteError(res, err)) return;
      throw err;
    }
  });

  // M17: replace a note's project memberships ([] = Inbox). Membership has
  // exactly one write path; content edits never touch it. Every route authed;
  // audit carries folder ids/counts only (never note content).
  api.put('/v1/notes/:id/folders', requireSession(sessions), (req: Request, res: Response) => {
    const notes = requireNotes(options, res);
    if (!notes) return;
    const folders = requireFolders(options, res);
    if (!folders) return;
    const id = String(req.params.id ?? '');
    const body = (req.body ?? {}) as { folderIds?: unknown };
    try {
      res.json(notes.setFolders(id, body.folderIds));
    } catch (err) {
      if (sendNoteError(res, err)) return;
      throw err;
    }
  });

  // -------------------------------------------------------------------------
  // M5 plans surface (PLAN-M5 wire spec). Plans are structured documents
  // (milestones -> tasks with status + optional owner persona). create()
  // starts empty; PUT replaces title/description/document after shape
  // validation; POST /tasks/:taskId applies a user-driven status transition
  // (audited — task note text length only, never its content). Exports carry
  // the OWNER's full plan by design.
  // -------------------------------------------------------------------------

  api.get('/v1/plans', requireSession(sessions), (req: Request, res: Response) => {
    const plans = requirePlans(options, res);
    if (!plans) return;
    res.json({ plans: plans.list() });
  });

  api.post('/v1/plans', requireSession(sessions), (req: Request, res: Response) => {
    const plans = requirePlans(options, res);
    if (!plans) return;
    try {
      const plan = plans.create((req.body ?? {}) as PlanInput);
      res.status(201).json(plan);
    } catch (err) {
      if (sendPlanError(res, err)) return;
      throw err;
    }
  });

  api.get('/v1/plans/:id', requireSession(sessions), (req: Request, res: Response) => {
    const plans = requirePlans(options, res);
    if (!plans) return;
    const id = String(req.params.id ?? '');
    const plan = plans.get(id);
    if (plan === null) {
      res.status(404).json({ error: 'not_found', message: 'plan not found' });
      return;
    }
    res.json(plan);
  });

  api.put('/v1/plans/:id', requireSession(sessions), (req: Request, res: Response) => {
    const plans = requirePlans(options, res);
    if (!plans) return;
    const id = String(req.params.id ?? '');
    try {
      res.json(plans.update(id, (req.body ?? {}) as never));
    } catch (err) {
      if (sendPlanError(res, err)) return;
      throw err;
    }
  });

  api.delete('/v1/plans/:id', requireSession(sessions), (req: Request, res: Response) => {
    const plans = requirePlans(options, res);
    if (!plans) return;
    const id = String(req.params.id ?? '');
    try {
      plans.remove(id);
    } catch (err) {
      if (sendPlanError(res, err)) return;
      throw err;
    }
    res.status(204).end();
  });

  api.post('/v1/plans/:id/tasks/:taskId', requireSession(sessions), (req: Request, res: Response) => {
    const plans = requirePlans(options, res);
    if (!plans) return;
    const id = String(req.params.id ?? '');
    const taskId = String(req.params.taskId ?? '');
    try {
      const plan = plans.setTaskStatus(id, taskId, (req.body ?? {}) as TaskStatusInput);
      res.json(plan);
    } catch (err) {
      if (sendPlanError(res, err)) return;
      throw err;
    }
  });

  api.get('/v1/plans/:id/export', requireSession(sessions), (req: Request, res: Response) => {
    const plans = requirePlans(options, res);
    if (!plans) return;
    const id = String(req.params.id ?? '');
    try {
      res.json(plans.exportPlan(id));
    } catch (err) {
      if (sendPlanError(res, err)) return;
      throw err;
    }
  });

  // PLAN-M5.md specifies POST for the plan export; the task brief specified
  // GET. Both verbs are registered — the endpoint is a read-only export.
  api.post('/v1/plans/:id/export', requireSession(sessions), (req: Request, res: Response) => {
    const plans = requirePlans(options, res);
    if (!plans) return;
    const id = String(req.params.id ?? '');
    try {
      res.json(plans.exportPlan(id));
    } catch (err) {
      if (sendPlanError(res, err)) return;
      throw err;
    }
  });

  // -------------------------------------------------------------------------
  // M6 theming surface (PLAN-M6 wire spec). Theme list/CRUD, activation and
  // the resolved active theme — persona override -> global active ->
  // preset-default. Every route authed; responses carry the owner's token
  // documents BY DESIGN (the studio edits them), but audit rows only ever
  // carry theme ids/names/source — never the token values. A gate-failing
  // save/update returns 400 with the full ThemeReport body (invalid_input).
  // -------------------------------------------------------------------------

  api.get('/v1/themes', requireSession(sessions), (req: Request, res: Response) => {
    const themes = requireThemes(options, res);
    if (!themes) return;
    res.json({ themes: themes.list() });
  });

  api.post('/v1/themes', requireSession(sessions), (req: Request, res: Response) => {
    const themes = requireThemes(options, res);
    if (!themes) return;
    try {
      const profile = themes.save(req.body);
      res.status(201).json(profile);
    } catch (err) {
      if (sendThemeError(res, err)) return;
      throw err;
    }
  });

  api.put('/v1/themes/:id', requireSession(sessions), (req: Request, res: Response) => {
    const themes = requireThemes(options, res);
    if (!themes) return;
    const id = String(req.params.id ?? '');
    try {
      res.json(themes.update(id, req.body));
    } catch (err) {
      if (sendThemeError(res, err)) return;
      throw err;
    }
  });

  api.delete('/v1/themes/:id', requireSession(sessions), (req: Request, res: Response) => {
    const themes = requireThemes(options, res);
    if (!themes) return;
    const id = String(req.params.id ?? '');
    try {
      themes.remove(id);
    } catch (err) {
      if (sendThemeError(res, err)) return;
      throw err;
    }
    res.status(204).end();
  });

  api.post('/v1/themes/:id/activate', requireSession(sessions), (req: Request, res: Response) => {
    const themes = requireThemes(options, res);
    if (!themes) return;
    const id = String(req.params.id ?? '');
    try {
      res.json(themes.activate(id));
    } catch (err) {
      if (sendThemeError(res, err)) return;
      throw err;
    }
  });

  api.get('/v1/theme/active', requireSession(sessions), (req: Request, res: Response) => {
    const themes = requireThemes(options, res);
    if (!themes) return;
    const personaId =
      typeof req.query.personaId === 'string' && req.query.personaId.trim() !== ''
        ? req.query.personaId.trim()
        : undefined;
    // D6: a conversation context (when given) resolves its override first.
    const conversationId =
      typeof req.query.conversationId === 'string' && req.query.conversationId.trim() !== ''
        ? req.query.conversationId.trim()
        : undefined;
    res.json(themes.active(personaId, conversationId));
  });

  api.post('/v1/conversations/:id/theme', requireSession(sessions), (req: Request, res: Response) => {
    const themes = requireThemes(options, res);
    if (!themes) return;
    const conversationId = String(req.params.id ?? '');
    if (conversationId === '') {
      res.status(400).json({ error: 'invalid_input', message: 'conversation id is required' });
      return;
    }
    const conversationManager = requireConversationManager(options, res);
    if (!conversationManager) return;
    const body = (req.body ?? {}) as { themeId?: unknown };
    const themeId =
      body.themeId === null || body.themeId === undefined || body.themeId === ''
        ? null
        : String(body.themeId);
    try {
      conversationManager.get(conversationId); // 404 when the conversation is unknown
      themes.bindConversationTheme(conversationId, themeId);
      res.status(200).json(themes.active(undefined, conversationId));
    } catch (err) {
      if (sendConversationError(res, err)) return;
      if (sendThemeError(res, err)) return;
      throw err;
    }
  });

  api.post('/v1/personas/:id/theme', requireSession(sessions), (req: Request, res: Response) => {
    const themes = requireThemes(options, res);
    if (!themes) return;
    // The persona-theme bind endpoint only exists on the wired personas
    // surface (501 when either manager is not wired).
    if (!requirePersonaManager(options, res)) return;
    const id = String(req.params.id ?? '');
    const body = (req.body ?? {}) as { themeId?: unknown };
    // themeId: a string id to bind, or null/undefined to CLEAR the override.
    const raw = body.themeId;
    const themeId =
      typeof raw === 'string' && raw.trim() !== ''
        ? raw.trim()
        : raw === null || raw === undefined
          ? null
          : undefined;
    if (themeId === undefined) {
      res.status(400).json({
        error: 'invalid_input',
        message: 'themeId must be a theme id string or null',
      });
      return;
    }
    try {
      themes.bindPersonaTheme(id, themeId);
      res.json({ personaId: id, themeId });
    } catch (err) {
      if (sendThemeError(res, err)) return;
      throw err;
    }
  });

  // -------------------------------------------------------------------------
  // M2 tool surface (PLAN-M2 wire spec) — project roots, grants, the broker
  // exec route, the approval queue, and write-preview proposals. Everything
  // 501s when no broker is wired. Responses use the shared wire types only;
  // params/results with content never reach audit (broker summarizes).
  // -------------------------------------------------------------------------

  // -----------------------------------------------------------------------
  // M11 F1 file-reference autocomplete (PLAN-M11.md). Lists files inside
  // roots the user has GRANTED files.read on only — other roots never leak
  // filenames. Shallow sync walk (depth <= 5), dot/trash/node_modules
  // skipped. The client turns a pick into a partner-file:// link.
  // -----------------------------------------------------------------------

  api.get('/v1/files/browse', requireSession(sessions), capability('file.read'), (req: Request, res: Response) => {
    const queryPath = typeof req.query.path === 'string' ? req.query.path : '';
    const actor = actorOf(res.locals.session as SessionInfo);
    try {
      const result = browseDirectory(queryPath);
      audit.log(actor, 'files.browse', result.path === '' ? '(drives)' : result.path, {
        entries: result.entries.length,
        truncated: result.truncated,
      });
      res.json(result);
    } catch (err) {
      if (err instanceof BrowseError) {
        const status =
          err.code === 'invalid_path'
            ? 400
            : err.code === 'not_found'
              ? 404
              : err.code === 'denied'
                ? 403
                : 500;
        res.status(status).json({ error: err.code, message: err.message });
        return;
      }
      throw err;
    }
  });

  api.get('/v1/files/refs', requireSession(sessions), capability('file.read'), (req: Request, res: Response) => {
    const broker = options.broker;
    if (!broker) {
      notConfigured(res, 'tool broker');
      return;
    }
    const query = String(req.query.q ?? '').trim().toLowerCase();
    const rawLimit = Number(req.query.limit ?? 24);
    const limit = Number.isFinite(rawLimit)
      ? Math.min(Math.max(Math.round(rawLimit), 1), 50)
      : 24;
    const nowAt = Date.now();
    const refs: Array<{
      rootId: string;
      rootLabel: string;
      path: string;
      kind: string;
      size: number | null;
    }> = [];
    const visited = new Set<string>();
    for (const root of broker.roots.list()) {
      if (refs.length >= limit) break;
      if (!broker.grants.hasGrant('files.read', root.id, nowAt)) continue;
      const walk = (absolute: string, rel: string, depth: number): void => {
        if (refs.length >= limit || depth > 5) return;
        let entries;
        try {
          entries = readdirSync(absolute, { withFileTypes: true });
        } catch {
          return;
        }
        entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        for (const entry of entries) {
          if (refs.length >= limit) return;
          const name = entry.name;
          if (name.startsWith('.') || name === 'node_modules') continue;
          const childAbs = join(absolute, name);
          const childRel = rel === '' ? name : `${rel}/${name}`;
          if (entry.isDirectory()) {
            walk(childAbs, childRel, depth + 1);
            continue;
          }
          if (!entry.isFile()) continue;
          if (query !== '' && !name.toLowerCase().includes(query)) continue;
          const key = childAbs;
          if (visited.has(key)) continue;
          visited.add(key);
          let size: number | null = null;
          try {
            size = statSync(childAbs).size;
          } catch {
            size = null;
          }
          refs.push({ rootId: root.id, rootLabel: root.label, path: childRel, kind: 'file', size });
        }
      };
      walk(root.path, '', 0);
    }
    res.json({ refs });
  });

  api.get('/v1/roots', requireSession(sessions), (req: Request, res: Response) => {
    const broker = requireBroker(options, res);
    if (!broker) return;
    // M22: `rootsFixed` lets the UI render the list read-only instead of
    // offering buttons that the next two routes will refuse.
    res.json({ roots: broker.roots.list(), rootsFixed: options.rootsFixed === true });
  });

  api.post('/v1/roots', requireSession(sessions), capability('roots'), (req: Request, res: Response) => {
    const broker = requireBroker(options, res);
    if (!broker) return;
    if (refuseFixedRoots(options, res)) return;
    const actor = actorOf(res.locals.session as SessionInfo);
    try {
      const root = broker.roots.add((req.body ?? {}) as ProjectRootInput);
      audit.log(actor, 'roots.add', root.id, { label: root.label, readOnly: root.readOnly });
      res.status(201).json(root);
    } catch (err) {
      if (sendToolError(res, err)) return;
      throw err;
    }
  });

  api.delete('/v1/roots/:id', requireSession(sessions), capability('roots'), (req: Request, res: Response) => {
    const broker = requireBroker(options, res);
    if (!broker) return;
    if (refuseFixedRoots(options, res)) return;
    const actor = actorOf(res.locals.session as SessionInfo);
    const id = String(req.params.id ?? '');
    try {
      broker.roots.remove(id);
      audit.log(actor, 'roots.remove', id, {});
      res.status(204).end();
    } catch (err) {
      if (sendToolError(res, err)) return;
      throw err;
    }
  });

  api.get('/v1/grants', requireSession(sessions), (req: Request, res: Response) => {
    const broker = requireBroker(options, res);
    if (!broker) return;
    res.json({ grants: broker.grants.list() });
  });

  api.post('/v1/grants', requireSession(sessions), capability('grants'), (req: Request, res: Response) => {
    const broker = requireBroker(options, res);
    if (!broker) return;
    const actor = actorOf(res.locals.session as SessionInfo);
    const body = (req.body ?? {}) as { toolId?: unknown; projectId?: unknown; note?: unknown };
    const toolId = typeof body.toolId === 'string' ? body.toolId.trim() : '';
    const projectId = typeof body.projectId === 'string' ? body.projectId.trim() : '';
    if (toolId === '') {
      res.status(400).json({ error: 'bad_params', message: 'toolId is required' });
      return;
    }
    const manifest = broker.manifests.find((m) => m.id === toolId);
    if (!manifest) {
      res.status(400).json({ error: 'unknown_tool', message: 'no such tool' });
      return;
    }
    // M27 S1 — the SCOPE decides which projectId is even admissible:
    //   - an app-scoped manifest (notes.*) takes ONLY the reserved APP_SCOPE_ID
    //     and never consults the roots manager;
    //   - a project-scoped manifest REFUSES APP_SCOPE_ID even though it is a
    //     legal-looking string, so 'app' can never become a root alias that
    //     grants a FILE tool through the app door.
    if (manifest.scope.kind === 'app') {
      if (projectId !== APP_SCOPE_ID) {
        res.status(400).json({
          error: 'bad_params',
          message: `projectId must be '${APP_SCOPE_ID}' for this tool`,
        });
        return;
      }
    } else if (projectId === APP_SCOPE_ID) {
      res.status(400).json({
        error: 'bad_params',
        message: `'${APP_SCOPE_ID}' is not a project root`,
      });
      return;
    } else if (projectId === '' || broker.roots.getById(projectId) === null) {
      res.status(404).json({ error: 'not_found', message: 'project root not found' });
      return;
    }
    const note = typeof body.note === 'string' && body.note.trim() !== '' ? body.note.trim() : undefined;
    const grant = broker.grants.add(toolId, projectId, note === undefined ? {} : { note });
    audit.log(actor, 'grant.add', projectId, { toolId, projectId, grantId: grant.id, source: 'user' });
    res.status(201).json(grant);
  });

  api.delete('/v1/grants/:id', requireSession(sessions), capability('grants'), (req: Request, res: Response) => {
    const broker = requireBroker(options, res);
    if (!broker) return;
    const actor = actorOf(res.locals.session as SessionInfo);
    const id = String(req.params.id ?? '');
    try {
      const grant = broker.grants.list().find((g) => g.id === id);
      broker.grants.remove(id);
      audit.log(actor, 'grants.remove', id, {
        toolId: grant?.toolId,
        projectId: grant?.projectId,
      });
      res.status(204).end();
    } catch (err) {
      if (sendToolError(res, err)) return;
      throw err;
    }
  });

  // Broker exec + decision routes. `respondExec` maps the wire outcome to the
  // loopback status: executed 200, needs_approval 202, denied by reason code.
  const respondExec = (res: Response, response: ToolExecResponse): void => {
    if (response.outcome === 'executed') {
      res.status(200).json(response);
      return;
    }
    if (response.outcome === 'needs_approval') {
      res.status(202).json(response);
      return;
    }
    res.status(deniedStatus(response.reason)).json(response);
  };

  api.post('/v1/tools/exec', requireSession(sessions), (req: Request, res: Response) => {
    const broker = requireBroker(options, res);
    if (!broker) return;
    const session = res.locals.session as SessionInfo;
    const body = (req.body ?? {}) as { tool?: unknown; params?: unknown };
    const tool = typeof body.tool === 'string' ? body.tool : '';
    if (tool === '') {
      res.status(400).json({ error: 'bad_params', message: 'tool is required' });
      return;
    }
    const response = broker.exec(tool, body.params, {
      requestedBy: session.kind === 'persona' || session.kind === 'skill' ? session.kind : 'web',
      // The broker checks the envelope against this BEFORE the grant check.
      clientClass: session.clientClass,
    });
    respondExec(res, response);
  });

  api.get('/v1/tools/pending', requireSession(sessions), (req: Request, res: Response) => {
    const broker = requireBroker(options, res);
    if (!broker) return;
    // Persona-requested rows get their persona's identity so the queue can
    // tag them like "Builder · files.read" (PLAN-M9 Web bullet). Live lookup
    // wins (queued playbook runs); chat-requested rows (M12 search
    // approvals) carry the stored persona_id instead; plain rows stay as-is.
    const pending = broker.pending.list().map((row) => {
      const personaName = queuePersonaName(row, broker, options);
      // M26 D2b: an INSTALL row names its DRAFT, not a tool - the queue can
      // render "Install <skill>?" without a broker manifest to look up. The row
      // already carries `kind` + `draftId` (the wire contract); `draftName` is
      // the label printed next to them.
      if (row.kind !== 'skill_install') return { ...row, personaName };
      const draftId = row.draftId ?? null;
      const draft = draftId === null ? null : (options.skillDrafts?.get(draftId) ?? null);
      return { ...row, personaName, draftName: draft?.name ?? null };
    });
    res.json({ pending });
  });

  // -------------------------------------------------------------------------
  // M14 scheduled work (PLAN-M14.md): run-now + run history. Schedule
  // definitions ride the persona surface (independence.schedules via
  // PATCH /v1/personas/:id) — no duplicate CRUD here.
  // -------------------------------------------------------------------------
  api.post(
    '/v1/personas/:id/schedules/:scheduleId/run-now',
    requireSession(sessions),
    capability('persona.run'),
    async (req: Request, res: Response) => {
      const schedules = requireSchedules(options, res);
      if (!schedules) return;
      const personaId = String(req.params.id ?? '');
      const scheduleId = String(req.params.scheduleId ?? '');
      try {
        // fire() starts the headless run and resolves once its row exists —
        // the UI polls GET /v1/schedules/runs and the run's conversation.
        const row = await schedules.fire(personaId, scheduleId);
        res.status(200).json({
          runId: row.id,
          status: row.status,
          conversationId: row.conversationId,
        });
      } catch (err) {
        if (sendScheduleError(res, err)) return;
        throw err;
      }
    },
  );

  api.get('/v1/schedules/runs/:runId', requireSession(sessions), (req: Request, res: Response) => {
    const schedules = requireSchedules(options, res);
    if (!schedules) return;
    const run = schedules.getRun(String(req.params.runId ?? ''));
    if (run === null) {
      res.status(404).json({ error: 'not_found', message: 'run not found' });
      return;
    }
    res.json(run);
  });

  api.get('/v1/schedules/runs', requireSession(sessions), (req: Request, res: Response) => {
    const schedules = requireSchedules(options, res);
    if (!schedules) return;
    const q = req.query;
    const personaId = typeof q.personaId === 'string' && q.personaId !== '' ? q.personaId : undefined;
    const status = typeof q.status === 'string' && q.status !== '' ? q.status : undefined;
    let limit = Number(q.limit);
    if (!Number.isInteger(limit) || limit < 1) limit = 50;
    res.json({ runs: schedules.listRuns({ personaId, status, limit: Math.min(limit, 100) }) });
  });

  api.post('/v1/tools/pending/:id', requireSession(sessions), async (req: Request, res: Response) => {
    const broker = requireBroker(options, res);
    if (!broker) return;
    const actor = actorOf(res.locals.session as SessionInfo);
    const id = String(req.params.id ?? '');
    const body = (req.body ?? {}) as {
      decision?: unknown;
      remember?: unknown;
      note?: unknown;
      /** M26 D6: the caller has seen the before/after permission table. */
      acknowledgePermissions?: unknown;
    };
    const decision = body.decision === 'deny' ? 'deny' : body.decision === 'approve' ? 'approve' : null;
    if (decision === null) {
      res.status(400).json({ error: 'bad_params', message: "decision must be 'approve' or 'deny'" });
      return;
    }
    const note = typeof body.note === 'string' && body.note.trim() !== '' ? body.note.trim() : undefined;
    try {
      const row = broker.pending.get(id);
      if (!row) throw toolError('not_found', 'pending call not found');
      // M26 D2b (PLAN-M26.md): a SKILL INSTALL row is a different decision with
      // a different executor. Approve calls `drafts.promote` - the same function
      // the Studio button calls - and deny closes the ask; `broker.decide` is
      // never reached for it (it would refuse the row as `wrong_kind` anyway).
      if (row.kind === 'skill_install') {
        // M20-B S4, the same rule the broker path applies: APPROVING EXECUTES.
        // An install is `skill.install`, so the approver's client class must
        // clear that envelope - otherwise the approval queue would be a way
        // around the class table for the act the table most cares about.
        const classDenial = capabilityDenial(
          (res.locals.session as SessionInfo).clientClass,
          'skill.install',
        );
        if (classDenial !== null) {
          audit.log(actor, 'capability.denied', row.toolId, {
            clientClass: classDenial.clientClass,
            capability: classDenial.capability,
          });
          throw toolError('capability_denied', 'this device may not install a skill');
        }
        const drafts = options.skillDrafts;
        const resultForInstall =
          drafts === undefined
            ? { ok: true as const, grantId: null, executed: false, error: 'not_configured' }
            : decideInstallApproval({
                broker,
                drafts,
                row,
                decision,
                acknowledgePermissions: body.acknowledgePermissions === true,
                by: actor,
                options,
                audit,
              });
        // M14: a decided persona row may belong to a queued SCHEDULE run.
        void options.schedules?.tryResumeAfterDecision(id);
        res.status(200).json(resultForInstall);
        return;
      }
      // M12 search approvals: a persona-requested row for an EXTERNAL tool
      // (no project root, no broker manifest) is decided against the search
      // backend — approve executes the search ONCE and posts the outcome
      // note back into the conversation the persona asked from. Every other
      // row stays on the broker decision path.
      const externalSearch = row.toolId === SEARCH_MANIFEST.id && row.requestedBy === 'persona';
      const result = externalSearch
        ? await decideExternalApproval({
            broker,
            row,
            decision,
            by: actor,
            options,
            audit,
          })
        : broker.decide(
            id,
            {
              decision,
              remember: body.remember === true,
              ...(note !== undefined ? { note } : {}),
            },
            actor,
            // M20-B S4 (blocker fix): the APPROVER's class decides whether the
            // stored tool may run, because approving EXECUTES it. Without this a
            // mobile session could approve a write someone else queued and have
            // it run — the envelope bypassed through the approval queue.
            (res.locals.session as SessionInfo).clientClass,
          );
      // M14: a decided persona-requested row may belong to a queued SCHEDULE
      // run — resume it headlessly in-process (approve executes the tool
      // once via broker.decide; this continues the persona loop).
      if (row.requestedBy === 'persona') {
        void options.schedules?.tryResumeAfterDecision(id);
      }
      res.status(200).json(result);
    } catch (err) {
      if (sendToolError(res, err)) return;
      throw err;
    }
  });

  api.get('/v1/tools/proposals/:id', requireSession(sessions), (req: Request, res: Response) => {
    const broker = requireBroker(options, res);
    if (!broker) return;
    const view = broker.getProposal(String(req.params.id ?? ''));
    if (!view) {
      res.status(404).json({ error: 'not_found', message: 'proposal not found' });
      return;
    }
    res.json(view);
  });

  api.post('/v1/proposals/:id/apply', requireSession(sessions), capability('file.write'), (req: Request, res: Response) => {
    const broker = requireBroker(options, res);
    if (!broker) return;
    const session = res.locals.session as SessionInfo;
    const proposalId = String(req.params.id ?? '');
    const body = (req.body ?? {}) as { projectId?: unknown };
    const projectId = typeof body.projectId === 'string' ? body.projectId.trim() : '';
    if (projectId === '') {
      res.status(400).json({ error: 'bad_params', message: 'projectId is required' });
      return;
    }
    // files.apply is HIGH risk — always asks unless an explicit user grant
    // exists (the broker decides); this route just forwards the wire params.
    const response = broker.exec('files.apply', { projectId, proposalId }, {
      requestedBy: session.kind === 'persona' || session.kind === 'skill' ? session.kind : 'web',
      clientClass: session.clientClass,
    });
    respondExec(res, response);
  });

  api.delete('/v1/proposals/:id', requireSession(sessions), (req: Request, res: Response) => {
    const broker = requireBroker(options, res);
    if (!broker) return;
    const actor = actorOf(res.locals.session as SessionInfo);
    const id = String(req.params.id ?? '');
    try {
      broker.discardProposal(id);
      audit.log(actor, 'proposal.discard', id, {});
      res.status(204).end();
    } catch (err) {
      if (sendToolError(res, err)) return;
      throw err;
    }
  });

  // Revoke the presented session (used by "Unpair"/"Pair again").
  api.delete('/v1/session', requireSession(sessions), async (_req: Request, res: Response) => {
    const session = res.locals.session as SessionInfo;
    const token = res.locals.token as string;
    await sessions.revoke(token);
    audit.log('session', 'session.revoke', 'web', { sessionId: session.id });
    res.status(204).end();
  });

  // M20-B S3: rotate the presented session's token IN PLACE (the mitigation for
  // the 30-day localStorage bearer named in PLAN-M20 §8.1 item 3). The device
  // row survives — same id, same user/class/label — while the token that was
  // presented stops resolving, so a copied token dies at the next request.
  // The new token crosses this response boundary only, exactly like /v1/pair;
  // the audit row carries the session id and class, never token material.
  api.post('/v1/session/rotate', requireSession(sessions), async (_req: Request, res: Response) => {
    const session = res.locals.session as SessionInfo;
    const rotated = await sessions.rotate(res.locals.token as string);
    if (rotated === null) {
      // The row vanished between auth and rotation (revoked concurrently).
      res.status(401).json({ error: 'unauthorized', reason: 'not_found' });
      return;
    }
    audit.log('session', 'session.rotate', 'web', {
      sessionId: session.id,
      clientClass: session.clientClass,
    });
    res.json({
      token: rotated.token,
      expiresAt: rotated.expiresAt,
      kind: session.kind,
      clientClass: session.clientClass,
    });
  });

  // -------------------------------------------------------------------------
  // M20-B S5 — the device registry: SEE and REVOKE the sessions paired to this
  // core. This is the user-visible half of "the 30-day bearer is the weakest
  // link" (PLAN-M20 §8.1 item 3): rotation limits how long a leaked token
  // lives, and these routes are how its owner notices one and kills it.
  //
  // Scope, and the ONE transitional rule: a caller sees its OWN user's
  // devices. `session.userId === null` is the pre-auth case — the sign-in
  // route does not exist yet, so every session in the field has user_id NULL
  // and a user-scoped read would list NOTHING on every install that exists
  // today. On an install with no users at all the single-user core IS the
  // whole core, so the list is every device. That branch lives in
  // `SessionManager.listDevices`/`revokeDeviceById` (one place, commented
  // there) and the authentication lane deletes it; a session that NAMES a user
  // is answered from that user's rows only and never falls back to the whole
  // table.
  //
  // Bodies carry id/clientClass/deviceLabel/platform/createdAt/lastSeenAt/
  // revokedAt and nothing else — never a token hash (the manager projects the
  // row through `DeviceRecord`, which has no such field, so a hash cannot leak
  // by adding one here) and never another user's row.
  //
  // No `capability(...)` guard on this group, deliberately: device lifecycle
  // is the session's own credential, not a class-gated authority. A new
  // capability would be DENIED for mobile/extension by construction (S4 fails
  // closed on an unknown name), which would leave a phone unable to list or
  // sign out its own device — the exact device a stolen token most likely sits
  // on.
  // -------------------------------------------------------------------------

  api.get('/v1/devices', requireSession(sessions), async (_req: Request, res: Response) => {
    const session = res.locals.session as SessionInfo;
    res.json({ devices: await sessions.listDevices(session.userId) });
  });

  // Revoke ONE device. Idempotent: re-revoking an already-revoked (or
  // concurrently revoked) row answers 200 with `alreadyRevoked: true` and
  // writes no second audit row. An id that is not in the caller's own
  // registry — another user's device, or no row at all — is a single 404 with
  // ONE message for both cases: 403 would confirm the row exists, and two
  // distinct messages would leak the same fact by another route.
  api.post(
    '/v1/devices/:id/revoke',
    requireSession(sessions),
    async (req: Request, res: Response) => {
      const session = res.locals.session as SessionInfo;
      const raw = String(req.params.id ?? '');
      const id = /^[0-9]+$/.test(raw) ? Number(raw) : Number.NaN;
      if (!Number.isSafeInteger(id) || id <= 0) {
        // No device id can have this shape, so it cannot exist either.
        res.status(404).json({ error: 'not_found', message: 'device not found' });
        return;
      }
      const result = await sessions.revokeDeviceById(id, session.userId);
      if (result === null) {
        res.status(404).json({ error: 'not_found', message: 'device not found' });
        return;
      }
      if (!result.alreadyRevoked) {
        // Only a real state change is audited; ids only, never token material.
        audit.log('session', 'session.revoke', 'device', { sessionId: id });
      }
      res.json({ id, revoked: true, alreadyRevoked: result.alreadyRevoked });
    },
  );

  // Revoke EVERY device of the caller. DECISION: this INCLUDES the calling
  // session. It is the panic button for a leaked bearer, so leaving the one
  // session the caller is holding alive would leave a hole the user cannot
  // close from the UI — and `revokeAllForUser` is exactly "every live session
  // of this user", so an exclusion would be a second, subtly different rule.
  // The response therefore STATES the consequence instead of implying it:
  // `currentSessionRevoked: true` tells the client to show "pair again"
  // rather than let the user discover it on their next request (which will be
  // a 401 `reason: 'revoked'`). A later "sign out my other devices" is a
  // separate route with an explicit exclude id — never a silent change here.
  api.post(
    '/v1/devices/revoke-all',
    requireSession(sessions),
    async (_req: Request, res: Response) => {
      const session = res.locals.session as SessionInfo;
      const result = await sessions.revokeAllDevices(session.userId, session.id);
      // Counts and ids only — no device labels, no token material.
      audit.log('session', 'session.revoke_all', 'device', {
        count: result.revoked,
        sessionId: session.id,
        currentSessionRevoked: result.currentSessionRevoked,
      });
      res.json({
        revoked: result.revoked,
        currentSessionRevoked: result.currentSessionRevoked,
      });
    },
  );

  // -------------------------------------------------------------------------
  // M7 browser site-scope surface (PLAN-M7 wire spec). Per-origin consent
  // for browser capture/action: list/put/delete configured scopes and read
  // the RESOLVED policy (built-in blocklist -> stored scope -> default
  // 'ask'). Every route authed; blocked origins are immutable (404 on
  // mutation). Responses carry origins only — never page content — and the
  // manager keeps audit rows to origins/scopes (no page text anywhere).
  // -------------------------------------------------------------------------

  api.get('/v1/browser/scopes', requireSession(sessions), (_req: Request, res: Response) => {
    const scopes = requireScopes(options, res);
    if (!scopes) return;
    res.json({ scopes: scopes.list() });
  });

  api.put('/v1/browser/scopes/:origin', requireSession(sessions), capability('browser'), (req: Request, res: Response) => {
    const scopes = requireScopes(options, res);
    if (!scopes) return;
    const origin = String(req.params.origin ?? '');
    const body = (req.body ?? {}) as { scope?: unknown };
    const scope = body.scope as SiteScope;
    try {
      res.json(scopes.set(origin, scope));
    } catch (err) {
      if (sendBrowserError(res, err)) return;
      throw err;
    }
  });

  api.delete('/v1/browser/scopes/:origin', requireSession(sessions), capability('browser'), (req: Request, res: Response) => {
    const scopes = requireScopes(options, res);
    if (!scopes) return;
    const origin = String(req.params.origin ?? '');
    try {
      scopes.clear(origin);
    } catch (err) {
      if (sendBrowserError(res, err)) return;
      throw err;
    }
    res.status(204).end();
  });

  api.get('/v1/browser/policy/:origin', requireSession(sessions), (req: Request, res: Response) => {
    const scopes = requireScopes(options, res);
    if (!scopes) return;
    const origin = String(req.params.origin ?? '');
    try {
      res.json(scopes.policy(origin));
    } catch (err) {
      if (sendBrowserError(res, err)) return;
      throw err;
    }
  });

  // -------------------------------------------------------------------------
  // M8 skills surface (PLAN-M8 wire spec) — local catalog + install/disable/
  // enable/uninstall + sandboxed invoke + invocation metadata. Every route
  // authed; the manager + runner keep audit rows to ids/versions/counts, so
  // skill code, logs, args and results never cross this surface's audit (the
  // invoke RESPONSE carries the skill's own result to the caller by design).
  // The literal '/v1/skills/catalog' route is registered before the ':id'
  // routes so Express never treats 'catalog' as a skill id.
  // -------------------------------------------------------------------------

  api.get('/v1/skills/catalog', requireSession(sessions), (req: Request, res: Response) => {
    const skills = requireSkills(options, res);
    if (!skills) return;
    const listing = skills.catalog();
    res.json({ skills: listing.skills, warnings: listing.warnings });
  });

  // -------------------------------------------------------------------------
  // M26 skill AUTHORING surface (PLAN-M26.md cut A). A draft is INERT: it runs
  // nothing and installs nothing. Creating/editing/validating need `skill.author`
  // (desktop-only by the envelope table); only /install needs `skill.install`,
  // and it is the single door into the skills store (the approved chat card
  // calls the same manager method). Draft source is the owner's own content: it
  // crosses this surface to the owner's UI and never reaches the audit log.
  //
  // Cut E adds the one route that DOES execute draft code - /run, a dry-run the
  // owner asks for, which materializes the draft into a core-owned scratch dir
  // (never a caller path) and returns the worker's own redacted log lines - plus
  // /bundle export and /import. An import always lands as a new INERT draft.
  //
  // Registered BEFORE the '/v1/skills/:id' routes so Express cannot read
  // 'drafts' or 'templates' as a skill id (same reason as '/catalog').
  // -------------------------------------------------------------------------
  api.get('/v1/skills/templates', requireSession(sessions), (req: Request, res: Response) => {
    const drafts = requireSkillDrafts(options, res);
    if (!drafts) return;
    res.json({ templates: drafts.templates() });
  });

  api.get('/v1/skills/drafts', requireSession(sessions), (req: Request, res: Response) => {
    const drafts = requireSkillDrafts(options, res);
    if (!drafts) return;
    res.json({ drafts: drafts.list() });
  });

  api.post(
    '/v1/skills/drafts',
    requireSession(sessions),
    capability('skill.author'),
    async (req: Request, res: Response) => {
      const drafts = requireSkillDrafts(options, res);
      if (!drafts) return;
      const body = (req.body ?? {}) as Record<string, unknown>;
      try {
        const draft = await drafts.create({
          mode: body.mode as 'manual' | 'template' | 'generate' | 'generate-flow',
          name: typeof body.name === 'string' ? body.name : '',
          description: typeof body.description === 'string' ? body.description : '',
          prompt: typeof body.prompt === 'string' ? body.prompt : undefined,
          template: typeof body.template === 'string' ? body.template : undefined,
          id: typeof body.id === 'string' ? body.id : undefined,
        });
        res.status(201).json(draft);
      } catch (err) {
        if (sendSkillError(res, err)) return;
        throw err;
      }
    },
  );

  /** Read a draft (owner's content) — no capability beyond the session. */
  api.get('/v1/skills/drafts/:id', requireSession(sessions), (req: Request, res: Response) => {
    const drafts = requireSkillDrafts(options, res);
    if (!drafts) return;
    const draft = drafts.get(String(req.params.id ?? ''));
    if (draft === null) {
      res.status(404).json({ error: 'not_found', message: 'skill draft not found' });
      return;
    }
    res.json(draft);
  });

  api.put(
    '/v1/skills/drafts/:id',
    requireSession(sessions),
    capability('skill.author'),
    (req: Request, res: Response) => {
      const drafts = requireSkillDrafts(options, res);
      if (!drafts) return;
      const body = (req.body ?? {}) as Record<string, unknown>;
      try {
        res.json(
          drafts.update(String(req.params.id ?? ''), {
            name: typeof body.name === 'string' ? body.name : undefined,
            description: typeof body.description === 'string' ? body.description : undefined,
            manifestText:
              typeof body.manifestText === 'string' ? body.manifestText : undefined,
            code: typeof body.code === 'string' ? body.code : undefined,
          }),
        );
      } catch (err) {
        if (sendSkillError(res, err)) return;
        throw err;
      }
    },
  );

  // Re-validate: deterministic, and it NEVER executes the draft.
  api.post(
    '/v1/skills/drafts/:id/validate',
    requireSession(sessions),
    capability('skill.author'),
    (req: Request, res: Response) => {
      const drafts = requireSkillDrafts(options, res);
      if (!drafts) return;
      try {
        res.json(drafts.validate(String(req.params.id ?? '')));
      } catch (err) {
        if (sendSkillError(res, err)) return;
        throw err;
      }
    },
  );

  // M26 cut E: the dry-run. The ONLY route that executes draft code, and only
  // because the owner asked for it. The manager materializes the draft into a
  // core-owned scratch dir (never a caller-supplied path), runs the REAL
  // sandbox against it, and answers with the worker's own redacted log lines so
  // an import-time crash is readable instead of an opaque `crashed`. No
  // skill_invocations row is written; the audit row carries counts only.
  api.post(
    '/v1/skills/drafts/:id/run',
    requireSession(sessions),
    capability('skill.author'),
    async (req: Request, res: Response) => {
      const drafts = requireSkillDrafts(options, res);
      if (!drafts) return;
      const body = (req.body ?? {}) as { args?: unknown; timeoutMs?: unknown };
      try {
        res.json(
          await drafts.runDraft(String(req.params.id ?? ''), {
            args: body.args,
            timeoutMs: typeof body.timeoutMs === 'number' ? body.timeoutMs : undefined,
            // M27 S3: the dry-run reaches the SAME runner, so it carries the
            // same class - read from the session row, like the invoke route.
            clientClass: (res.locals.session as SessionInfo).clientClass,
          }),
        );
      } catch (err) {
        if (sendSkillError(res, err)) return;
        throw err;
      }
    },
  );

  // M26 D12 export: the draft as an UNSIGNED bundle ({version, manifestText,
  // code}) for the SPA to save. Owner content, so it crosses this surface to
  // the owner's own UI; the audit row records a byte LENGTH only.
  api.post(
    '/v1/skills/drafts/:id/bundle',
    requireSession(sessions),
    capability('skill.author'),
    (req: Request, res: Response) => {
      const drafts = requireSkillDrafts(options, res);
      if (!drafts) return;
      try {
        res.json(drafts.exportBundle(String(req.params.id ?? '')));
      } catch (err) {
        if (sendSkillError(res, err)) return;
        throw err;
      }
    },
  );

  // M26 D12 import: a bundle ALWAYS lands as a new INERT draft (origin
  // 'import', de-duplicated slug) — it installs nothing, and the body is
  // treated as untrusted input (shape + size checked, manifest re-pointed at
  // the fresh slug). Registered before the ':id' routes below like every other
  // literal draft path.
  api.post(
    '/v1/skills/drafts/import',
    requireSession(sessions),
    capability('skill.author'),
    (req: Request, res: Response) => {
      const drafts = requireSkillDrafts(options, res);
      if (!drafts) return;
      try {
        res.status(201).json(drafts.importBundle(req.body));
      } catch (err) {
        if (sendSkillError(res, err)) return;
        throw err;
      }
    },
  );

  // Promote: the ONE path from authored text to runnable code.
  api.post(
    '/v1/skills/drafts/:id/install',
    requireSession(sessions),
    capability('skill.install'),
    (req: Request, res: Response) => {
      const drafts = requireSkillDrafts(options, res);
      if (!drafts) return;
      const body = (req.body ?? {}) as Record<string, unknown>;
      try {
        res.json(
          drafts.promote(String(req.params.id ?? ''), {
            // Never defaulted on: a widened permission set must be acknowledged
            // by a caller that has seen the before→after table.
            acknowledgePermissions: body.acknowledgePermissions === true,
            via: 'studio',
          }),
        );
      } catch (err) {
        if (sendSkillError(res, err)) return;
        throw err;
      }
    },
  );

  // M26 D2b: the persona's install ASK, as an HTTP surface (the chat tool
  // `skills.requestInstall` reaches the same manager method). It creates a
  // pending_tools row of kind 'skill_install' and NOTHING else — approving that
  // row is what installs, through the same `promote` the Studio calls.
  api.post(
    '/v1/skills/drafts/:id/request-install',
    requireSession(sessions),
    capability('skill.author'),
    (req: Request, res: Response) => {
      const drafts = requireSkillDrafts(options, res);
      if (!drafts) return;
      const body = (req.body ?? {}) as { conversationId?: unknown; personaId?: unknown };
      try {
        const { pendingId } = drafts.requestInstall(String(req.params.id ?? ''), {
          conversationId: typeof body.conversationId === 'string' ? body.conversationId : null,
          personaId: typeof body.personaId === 'string' ? body.personaId : null,
        });
        res.status(201).json({ pendingId });
      } catch (err) {
        if (sendSkillError(res, err)) return;
        throw err;
      }
    },
  );

  api.delete(
    '/v1/skills/drafts/:id',
    requireSession(sessions),
    capability('skill.author'),
    (req: Request, res: Response) => {
      const drafts = requireSkillDrafts(options, res);
      if (!drafts) return;
      try {
        drafts.discard(String(req.params.id ?? ''));
      } catch (err) {
        if (sendSkillError(res, err)) return;
        throw err;
      }
      res.status(204).end();
    },
  );

  // Start a draft from an INSTALLED skill: 'fork' copies under a new id (the
  // original is untouched), 'edit' binds to the installed id so promoting it
  // updates that skill in place.
  for (const action of ['fork', 'edit'] as const) {
    api.post(
      `/v1/skills/:id/${action}`,
      requireSession(sessions),
      capability('skill.author'),
      (req: Request, res: Response) => {
        const drafts = requireSkillDrafts(options, res);
        if (!drafts) return;
        const id = String(req.params.id ?? '');
        try {
          res.status(201).json(action === 'fork' ? drafts.fork(id) : drafts.edit(id));
        } catch (err) {
          if (sendSkillError(res, err)) return;
          throw err;
        }
      },
    );
  }

  api.get('/v1/skills', requireSession(sessions), (req: Request, res: Response) => {
    const skills = requireSkills(options, res);
    if (!skills) return;
    res.json({ skills: skills.list() });
  });

  api.post('/v1/skills/install', requireSession(sessions), capability('skill.install'), (req: Request, res: Response) => {
    const skills = requireSkills(options, res);
    if (!skills) return;
    const body = (req.body ?? {}) as { catalogId?: unknown };
    const catalogId = typeof body.catalogId === 'string' ? body.catalogId.trim() : '';
    if (catalogId === '') {
      res.status(400).json({ error: 'invalid_input', message: 'catalogId is required' });
      return;
    }
    try {
      const summary = skills.install(catalogId);
      res.status(201).json(summary);
    } catch (err) {
      if (sendSkillError(res, err)) return;
      throw err;
    }
  });

  api.get('/v1/skills/:id', requireSession(sessions), (req: Request, res: Response) => {
    const skills = requireSkills(options, res);
    if (!skills) return;
    const id = String(req.params.id ?? '');
    const detail = skills.get(id);
    if (detail === null) {
      res.status(404).json({ error: 'not_found', message: 'skill not installed' });
      return;
    }
    res.json(detail);
  });

  api.get('/v1/skills/:id/invocations', requireSession(sessions), (req: Request, res: Response) => {
    const skills = requireSkills(options, res);
    if (!skills) return;
    const id = String(req.params.id ?? '');
    if (skills.get(id) === null) {
      res.status(404).json({ error: 'not_found', message: 'skill not installed' });
      return;
    }
    res.json({ invocations: skills.listInvocations(id) });
  });

  api.post('/v1/skills/:id/disable', requireSession(sessions), capability('skill.install'), (req: Request, res: Response) => {
    const skills = requireSkills(options, res);
    if (!skills) return;
    const id = String(req.params.id ?? '');
    try {
      res.json(skills.disable(id));
    } catch (err) {
      if (sendSkillError(res, err)) return;
      throw err;
    }
  });

  api.post('/v1/skills/:id/enable', requireSession(sessions), capability('skill.install'), (req: Request, res: Response) => {
    const skills = requireSkills(options, res);
    if (!skills) return;
    const id = String(req.params.id ?? '');
    try {
      res.json(skills.enable(id));
    } catch (err) {
      if (sendSkillError(res, err)) return;
      throw err;
    }
  });

  api.delete('/v1/skills/:id', requireSession(sessions), capability('skill.install'), (req: Request, res: Response) => {
    const skills = requireSkills(options, res);
    if (!skills) return;
    const id = String(req.params.id ?? '');
    try {
      skills.remove(id);
    } catch (err) {
      if (sendSkillError(res, err)) return;
      throw err;
    }
    res.status(204).end();
  });

  api.post('/v1/skills/:id/invoke', requireSession(sessions), capability('skill.invoke'), async (req: Request, res: Response) => {
    const skills = requireSkills(options, res);
    if (!skills) return;
    const runner = requireSkillRunner(options, res);
    if (!runner) return;
    const id = String(req.params.id ?? '');
    const detail = skills.get(id);
    if (detail === null) {
      res.status(404).json({ error: 'not_found', message: 'skill not installed' });
      return;
    }
    if (detail.status === 'disabled') {
      res.status(409).json({ error: 'disabled', message: 'skill is disabled — enable it before invoking' });
      return;
    }
    const body = (req.body ?? {}) as { args?: unknown; personaId?: unknown };
    const personaId =
      typeof body.personaId === 'string' && body.personaId.trim() !== ''
        ? body.personaId.trim()
        : undefined;
    // M11 F3: a persona-level SKILL BAN refuses invoke server-side (the ban
    // is persona policy, not a suggestion the model can talk its way past).
    if (personaId !== undefined && options.personaManager) {
      const persona = options.personaManager.get(personaId);
      if (persona && (persona.policy?.skills?.banned ?? []).includes(id)) {
        res.status(423).json({
          error: 'skill_banned',
          message: 'this persona is not allowed to use that skill',
        });
        return;
      }
    }
    const result = await runner.invoke(detail, body.args, {
      // M27 S3 (PLAN-M27 D7): the class comes from the SESSION ROW this token
      // resolved to - never from the body/header/query - so the broker's
      // capability envelope keeps sitting ABOVE the skill's own grants. An
      // absent class would mean "internal caller with no session" (desktop),
      // which is not a route: every route here has a session.
      clientClass: (res.locals.session as SessionInfo).clientClass,
      ...(personaId === undefined ? {} : { personaId }),
    });
    // Invoke outcomes ride the 200 envelope {ok, result?, error?, meta}: the
    // coded failures (budget_exceeded/crashed/tool_denied/caps_exceeded/...) are
    // results of a run, not transport errors.
    res.json(result);
  });

  // -------------------------------------------------------------------------
  // M9 playbook + deploy-target surface (PLAN-M9 wire spec). Playbooks list
  // the registry; POST /:id/run streams the persona tool loop as SSE
  // (loop_step / persona_tool / delta / usage / done, terminal done_meta),
  // persisting a playbook_runs row + an optional conversation transcript +
  // save-as-note. A run that pauses on a queued persona tool ends its stream
  // with done_meta {status:'running', pendingId}; resume continues it after
  // the M2 decide route executed/denied the tool. Deploy profiles are plain
  // CRUD + the package step. Every route authed; audit rows are
  // playbook.run/playbook.resume/deploy-profile.* with ids/names/counts/
  // decisions only — never playbook text or tool content.
  // -------------------------------------------------------------------------

  api.get('/v1/playbooks', requireSession(sessions), (req: Request, res: Response) => {
    const playbooks = requirePlaybooks(options, res);
    if (!playbooks) return;
    res.json({ playbooks: playbooks.listPlaybooks() });
  });

  api.post(
    '/v1/playbooks/:id/run',
    requireSession(sessions),
    capability('persona.run'),
    async (req: Request, res: Response) => {
    const playbooks = requirePlaybooks(options, res);
    if (!playbooks) return;
    const id = String(req.params.id ?? '');
    const body = (req.body ?? {}) as {
      personaId?: unknown;
      conversationId?: unknown;
      inputs?: unknown;
      note?: unknown;
    };
    const inputs = bodyInputs(body.inputs);
    if (inputs === null) {
      res.status(400).json({ error: 'invalid_input', message: 'inputs must be an object' });
      return;
    }
    const personaId = optionalString(body.personaId);
    const conversationId = optionalString(body.conversationId);
    // Save-as-note shortcut (PLAN-M9 run body `note?`): fold the top-level
    // flag into the inputs envelope where the manager gates the save.
    if (body.note === true && !('saveNote' in inputs)) {
      inputs.saveNote = true;
    }

    let prepared;
    try {
      prepared = await playbooks.prepare({
        playbookId: id,
        ...(personaId !== undefined ? { personaId } : {}),
        ...(conversationId !== undefined ? { conversationId } : {}),
        inputs,
        // M20-B S4: a playbook started from a request inherits that session's
        // client class, so a mobile session cannot start a run whose tool calls
        // then execute under the desktop envelope.
        clientClass: (res.locals.session as SessionInfo).clientClass,
      });
    } catch (err) {
      if (sendPlaybookError(res, err)) return;
      throw err;
    }

    res.status(200);
    res.set(SSE_HEADERS);
    res.flushHeaders();
    try {
      for await (const event of prepared.events) {
        writePbSse(res, event);
      }
    } catch {
      if (!res.writableEnded) {
        writePbSse(res, { type: 'error', message: 'playbook_stream_failed' });
      }
    } finally {
      res.end();
    }
  });

  api.post(
    '/v1/playbooks/runs/:id/resume',
    requireSession(sessions),
    async (req: Request, res: Response) => {
      const playbooks = requirePlaybooks(options, res);
      if (!playbooks) return;
      const runId = String(req.params.id ?? '');
      const body = (req.body ?? {}) as { pendingId?: unknown };
      const pendingId = optionalString(body.pendingId);
      if (pendingId === undefined) {
        res.status(400).json({ error: 'invalid_input', message: 'pendingId is required' });
        return;
      }

      let prepared;
      try {
        prepared = playbooks.prepareResume(runId, pendingId);
      } catch (err) {
        if (sendPlaybookError(res, err)) return;
        throw err;
      }

      res.status(200);
      res.set(SSE_HEADERS);
      res.flushHeaders();
      try {
        for await (const event of prepared.events) {
          writePbSse(res, event);
        }
      } catch {
        if (!res.writableEnded) {
          writePbSse(res, { type: 'error', message: 'playbook_stream_failed' });
        }
      } finally {
        res.end();
      }
    },
  );

  api.get('/v1/deploy-profiles', requireSession(sessions), (_req: Request, res: Response) => {
    const profiles = requireDeployProfiles(options, res);
    if (!profiles) return;
    res.json({ profiles: profiles.list() });
  });

  api.post('/v1/deploy-profiles', requireSession(sessions), capability('deploy'), (req: Request, res: Response) => {
    const profiles = requireDeployProfiles(options, res);
    if (!profiles) return;
    try {
      const profile = profiles.create(req.body);
      res.status(201).json(profile);
    } catch (err) {
      if (sendPlaybookError(res, err)) return;
      throw err;
    }
  });

  api.delete('/v1/deploy-profiles/:id', requireSession(sessions), capability('deploy'), (req: Request, res: Response) => {
    const profiles = requireDeployProfiles(options, res);
    if (!profiles) return;
    const id = String(req.params.id ?? '');
    try {
      profiles.remove(id);
      res.status(204).end();
    } catch (err) {
      if (sendPlaybookError(res, err)) return;
      throw err;
    }
  });

  api.post(
    '/v1/deploy-profiles/:id/package',
    requireSession(sessions),
    capability('deploy'),
    (req: Request, res: Response) => {
      const profiles = requireDeployProfiles(options, res);
      if (!profiles) return;
      const id = String(req.params.id ?? '');
      const body = (req.body ?? {}) as { projectDir?: unknown; outDir?: unknown };
      const projectDir = typeof body.projectDir === 'string' ? body.projectDir.trim() : '';
      const outDir = typeof body.outDir === 'string' ? body.outDir.trim() : '';
      // Package materializes a deployable bundle on disk, so both paths must
      // stay inside a granted project root (PLAN-M9: "into a folder under a
      // granted project root") — never an arbitrary writable location.
      const roots = options.broker?.roots.list() ?? [];
      const underRoot = (candidate: string, canonical: boolean): boolean => {
        if (candidate === '' || !isAbsolute(candidate)) return false;
        let resolved: string;
        try {
          resolved = canonical ? realpathSync(candidate) : resolve(candidate);
        } catch {
          return false;
        }
        return roots.some((root) => {
          const base = resolve(root.path);
          return resolved === base || resolved.startsWith(base + sep);
        });
      };
      if (roots.length === 0) {
        res.status(400).json({
          error: 'invalid_input',
          message: 'no project roots are registered — add one in the Files view first',
        });
        return;
      }
      if (!underRoot(projectDir, true) || !underRoot(outDir, false)) {
        res.status(400).json({
          error: 'invalid_input',
          message: 'projectDir and outDir must be inside a granted project root',
        });
        return;
      }
      try {
        const result = profiles.package(id, { projectDir, outDir });
        res.json(result);
      } catch (err) {
        if (sendPlaybookError(res, err)) return;
        throw err;
      }
    },
  );

  app.use(api);

  // Unknown routes: structured 404 (never leak internal paths or secrets).
  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: 'not_found' });
  });

  // JSON error handler — never HTML, never internal paths, never secrets.
  const errorHandler: express.ErrorRequestHandler = (err, req, res, _next) => {
    const maybe = err as { type?: string; limit?: unknown };
    if (maybe?.type === 'entity.parse.failed') {
      res.status(400).json({ error: 'bad_json' });
      return;
    }
    if (maybe?.type === 'entity.too.large') {
      // Quote the cap that actually fired (`err.limit` is body-parser's) and
      // only name a file on the upload route: a 413 the user can act on says
      // how big the file was and how big it may be.
      const fired = typeof maybe.limit === 'number' ? maybe.limit : null;
      const upload =
        UPLOAD_PATH.test((req.originalUrl ?? '').split('?')[0] ?? '') &&
        (fired === null || fired === uploadCap);
      res.status(413).json({
        error: 'payload_too_large',
        message: upload
          ? attachmentTooLargeFor(req, fired ?? uploadCap)
          : `request bodies are capped at ${describeBytes(fired ?? options.maxJsonBytes ?? 1024 * 1024)}`,
      });
      return;
    }
    const message =
      err instanceof Error ? redactString(err.message) : `non-Error thrown: ${typeof err}`;
    console.error('[partner-core] unhandled error:', message);
    res.status(500).json({ error: 'internal_error' });
  };
  app.use(errorHandler);

  return app;
}
