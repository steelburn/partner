/**
 * Partner core HTTP server (Express 5) — the M0 security spine as routes.
 *
 * Layering, in order:
 *  1. Loopback Host guard — 403 before any routing when the Host header is
 *     not on the allowlist (default `127.0.0.1:<port>` / `localhost:<port>`).
 *  2. Public surface — /v1/health and (demo only) /v1/dev/pair-code.
 *  3. Pairing exchange — POST /v1/pair drives the 6-digit single-use manager
 *     and mints a `web` session bound to the caller's (allowlisted) origin.
 *  4. Authed group (Bearer + origin) — POST /v1/chat (SSE), GET /v1/audit,
 *     the M1 provider API (/v1/providers…, /v1/models), the
 *     self-service import (/v1/self-service/*), the M2 tool surface
 *     (/v1/roots|/v1/grants|/v1/tools…, /v1/proposals…) and the M3
 *     persona + conversation API (/v1/personas…, /v1/conversations…).
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
import type { NextFunction, Request, Response } from 'express';
import type { ChatEvent, ChatMessage, ChatRequest, ConversationMessage, ProviderClient, ProviderSummary, ToolCall } from '@partner/shared';
import type { NoteInput, Persona } from '@partner/shared';
import type { PlanInput, TaskStatusInput } from '@partner/shared';
import type { ProviderInput, ProviderSource, SelfServiceConnectInput } from '@partner/shared';
import type { McpCallInput, McpServerInput, McpServerUpdate, SearchConfigInput } from '@partner/shared';
import type { ProjectRootInput, ToolExecResponse } from '@partner/shared/tools.js';
import type { SiteScope } from '@partner/shared';
import { redactString } from '@partner/shared';
import { demoProvider } from '../gateway/demo.js';
import { createBudgetTracker } from '../gateway/budget.js';
import { centsForTokens } from '../gateway/pricing.js';
import type { SpendLedgerManager } from '../gateway/spend.js';
import { resolveChatModel } from '../gateway/resolver.js';
import { isImageCapableModel } from '../gateway/vision.js';
import { UpstreamError } from '../gateway/openaiCompatible.js';
import type { OpenAICompatibleClient } from '../gateway/openaiCompatible.js';
import {
  connectSelfService,
  createSelfServiceDemoDouble,
  fetchSelfServiceLoginKey,
  SelfServiceError,
} from '../gateway/selfService.js';
import type { ProviderManager } from '../providers/providerManager.js';
import { ProviderError } from '../providers/errors.js';
import type { PairingManager } from './pairing.js';
import type { SessionInfo, SessionManager } from './session.js';
import type { AuditService } from '../services/redaction.js';
import type { PendingToolRow } from '../stores/types.js';
import type { ToolBroker } from '../broker/broker.js';
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
import type { PlanManager } from '../plans/index.js';
import { PlanError, planErrorStatus } from '../plans/index.js';
import type { ThemeManager } from '../theming/manager.js';
import { ThemeError, themeErrorStatus } from '../theming/errors.js';
import type { SiteScopeManager } from '../browser/scopes.js';
import { BrowserError, browserErrorStatus } from '../browser/errors.js';
import type { SkillManager } from '../skills/manager.js';
import type { SkillRunner } from '../skills/runner.js';
import { SkillError, skillErrorStatus } from '../skills/errors.js';
import type { FolderManager } from '../folders/manager.js';
import { FolderError, folderErrorStatus } from '../folders/errors.js';
import type { AttachmentManager } from '../attachments/manager.js';
import { AttachmentError, attachmentErrorStatus } from '../attachments/errors.js';
import type { AssetManager } from '../assets/manager.js';
import { AssetError, assetErrorStatus } from '../assets/errors.js';
import type { McpManager } from '../mcp/manager.js';
import { McpError, mcpErrorStatus } from '../mcp/errors.js';
import type { SearchManager } from '../search/manager.js';
import { SearchError, searchErrorStatus } from '../search/errors.js';
import {
  applyStructuredGuidance,
  independenceDeclaration,
  SEARCH_TOOL_APPROVAL_INSTRUCTION,
  SEARCH_TOOL_INSTRUCTION,
} from '../chat/instructions.js';
import { SEARCH_MANIFEST } from '../search/tool.js';
import { runChatToolPass, runNativeToolCalls } from '../chat/toolPass.js';
import { searchToolExternal } from '../search/tool.js';
import { mcpToolExternal } from '../mcp/tool.js';
import { summarizeToolResult } from '../playbooks/loop.js';
import { fileRefsExcerpt, parseFileRefs } from '../chat/fileRefs.js';
import type { PlaybookManager, PbEvent } from '../playbooks/manager.js';
import type { DeployManager } from '../playbooks/deploy.js';
import { PlaybookError, playbookError, playbookErrorStatus } from '../playbooks/errors.js';

export interface CoreAppOptions {
  port: number;
  demo: boolean;
  version: string;
  schemaVersion: number;
  /** Host header allowlist; defaults to loopback for `port`. */
  hostAllowlist?: string[];
  /** Optional built SPA directory served at / (stub at M0; the packaged shell wires the real path). */
  staticDir?: string;
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
const MAX_AUDIT_LIMIT = 500;

/** The origin used for session binding is the (allowlisted) Host header. */
function originOf(req: Request): string {
  return String(req.headers.host ?? '').toLowerCase();
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
    // clickable choices (F9) and assets (F10). Deterministic, opt-in per
    // conversation feature set (default on for persisted persona chat).
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

/** Loopback-only Host guard, applied before any routing. */
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

/** Safe audit target for a self-service endpoint: its host, or a constant. */
function endpointAuditTarget(raw: unknown): string {
  if (typeof raw !== 'string') return 'self-service';
  try {
    return new URL(raw.trim()).host || 'self-service';
  } catch {
    return 'self-service';
  }
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

export function createCoreApp(options: CoreAppOptions): express.Express {
  const { pairing, sessions, audit } = options;
  const allowlist = new Set(
    (options.hostAllowlist ?? [`127.0.0.1:${options.port}`, `localhost:${options.port}`]).map((h) =>
      h.toLowerCase(),
    ),
  );

  const app = express();
  app.disable('x-powered-by');

  // Demo mode: an in-process S0 double keeps the import fully offline.
  const demoSelfService = options.demo ? createSelfServiceDemoDouble(options.port) : undefined;

  // 1. Loopback guard + JSON body parsing (public routes may not send JSON).
  app.use(hostGuard(allowlist));
  app.use(express.json({ limit: '1mb' }));

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
    });
  });

  if (options.demo) {
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

  // 3. Pairing exchange -> mints a `web` session.
  app.post('/v1/pair', async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { code?: unknown };
    const code = typeof body.code === 'string' ? body.code.trim() : '';
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

    const origin = originOf(req);
    const created = await sessions.create('web', origin);
    audit.log('pair', 'pair.verify', 'web', { ok: true, kind: 'web' });
    // The token crosses exactly this boundary; it is stored hashed and never
    // re-serialized anywhere (logs, audit, SSE).
    res.json({ token: created.token, kind: 'web', expiresAt: created.expiresAt });
  });

  // 4. Authed group (Bearer token + origin binding). Auth is applied per
  // route so unmatched public paths fall through to the 404 handler instead
  // of being swallowed by a router-level auth middleware.
  const api = express.Router();

  api.post('/v1/chat', requireSession(sessions), async (req: Request, res: Response) => {
    const session = res.locals.session as SessionInfo;
    const body = (req.body ?? {}) as {
      messages?: unknown;
      model?: unknown;
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
    const resolved = resolveChatModel({
      persona: routingPersona,
      requestedModel,
      providers,
      taskClass: taskClassRaw ?? 'chat',
    });
    let managedProvider: ProviderSummary | null = resolved.provider;
    // Demo-mode guard: a provider imported through the built-in demo double is
    // an OFFLINE artifact (its endpoint is this core itself), so keep the demo
    // provider as the chat backend — demo stays usable with no network.
    if (options.demo && managedProvider?.source === 'llm-self-service') {
      managedProvider = null;
    }

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
      const model = resolved.model;
      if (model === '') {
        res.status(400).json({
          error: 'model_required',
          message: 'no model chosen — set a model in the request or run a provider test to populate defaults',
        });
        return;
      }
      let client: OpenAICompatibleClient;
      try {
        client = await activeManager.clientFor(managedProvider.id);
      } catch (err) {
        if (sendProviderError(res, err)) return;
        throw err;
      }

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
          ? buildTailoring(options.memory.profile, routingPersona.id)
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
      if (persistedUserMessageId !== null && options.attachments && isImageCapableModel(model)) {
        try {
          const metas = options.attachments
            .metaForMessage(persistedUserMessageId)
            .filter((meta) => meta.mime.startsWith('image/') && meta.size <= 3 * 1024 * 1024);
          const meta = metas[0] ?? null;
          if (meta !== null && conversationId !== null) {
            const image = options.attachments.content(conversationId, meta.id);
            if (image !== null) {
              for (let index = requestMessages.length - 1; index >= 0; index -= 1) {
                const message = requestMessages[index];
                if (message && message.role === 'user') {
                  requestMessages[index] = {
                    ...message,
                    image: {
                      mime: image.mime,
                      dataBase64: image.data.toString('base64'),
                    },
                  };
                  break;
                }
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
        // next turn's history carries them. No auto-continuation model round.
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
            };
            await runChatToolPass(deltaText, {
              persona: routingPersona,
              broker: options.broker,
              external: externalTools,
              audit,
              conversationId: activeConversationId,
              appendSystemNote,
            });
            // M11 F2 native function calls (same gate/broker, same notes).
            if (nativeCalls.length > 0) {
              await runNativeToolCalls(nativeCalls, {
                persona: routingPersona,
                broker: options.broker,
                external: externalTools,
                audit,
                conversationId: activeConversationId,
                appendSystemNote,
              });
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

  api.post('/v1/providers/:id/key', requireSession(sessions), async (req: Request, res: Response) => {
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

  // llm-self-service integrated import (S0 contract, proxied for the web UI).
  api.post('/v1/self-service/login-key', requireSession(sessions), async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { endpoint?: unknown };
    try {
      const { publicKeyPem } = await fetchSelfServiceLoginKey(body.endpoint, {
        demo: options.demo,
        demoDouble: demoSelfService,
      });
      audit.log('self-service', 'self_service.login_key', endpointAuditTarget(body.endpoint), { ok: true });
      res.json({ publicKeyPem });
    } catch (err) {
      if (err instanceof SelfServiceError) {
        audit.log('self-service', 'self_service.login_key', endpointAuditTarget(body.endpoint), {
          ok: false,
          reason: err.kind,
        });
        res.status(err.httpStatus).json({ error: err.kind, message: err.message });
        return;
      }
      throw err;
    }
  });

  api.post('/v1/self-service/connect', requireSession(sessions), async (req: Request, res: Response) => {
    const manager = requireProviderManager(options, res);
    if (!manager) return;
    const raw = (req.body ?? {}) as Record<string, unknown>;
    // Envelope only: a plaintext password field is rejected outright (PLAN-M1).
    if (raw.password !== undefined && raw.password !== null && raw.password !== '') {
      audit.log('self-service', 'self_service.connect', 'rejected', { ok: false, reason: 'plaintext_password' });
      res.status(400).json({
        error: 'plaintext_password_rejected',
        message: 'password must be sent encrypted (passwordCipher)',
      });
      return;
    }
    try {
      const summary = await connectSelfService(manager, raw as unknown as SelfServiceConnectInput, {
        demo: options.demo,
        demoDouble: demoSelfService,
      });
      audit.log('self-service', 'self_service.connect', summary.id, {
        ok: true,
        source: summary.source,
        providerId: summary.id,
      });
      res.status(201).json(summary);
    } catch (err) {
      if (err instanceof SelfServiceError) {
        audit.log('self-service', 'self_service.connect', 'connect', { ok: false, reason: err.kind });
        res.status(err.httpStatus).json({ error: err.kind, message: err.message });
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
    const body = (req.body ?? {}) as { personaId?: unknown; title?: unknown; folderId?: unknown };
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
    try {
      const summary = manager.create({
        personaId: optionalString(body.personaId),
        title: optionalString(body.title),
        ...(folderId !== undefined ? { folderId } : {}),
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
    (req: Request, res: Response) => {
      const attachments = requireAttachments(options, res);
      if (!attachments) return;
      const conversationId = String(req.params.id ?? '');
      const manager = requireConversationManager(options, res);
      if (!manager) return;
      try {
        manager.get(conversationId); // 404 when the conversation is unknown
        const body = (req.body ?? {}) as { name?: unknown; mime?: unknown; dataBase64?: unknown };
        const meta = attachments.upload(conversationId, {
          name: typeof body.name === 'string' ? body.name : '',
          mime: typeof body.mime === 'string' ? body.mime : '',
          dataBase64: typeof body.dataBase64 === 'string' ? body.dataBase64 : '',
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
      res.setHeader('Content-Type', content.mime);
      res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(content.name)}`);
      res.setHeader('X-Content-Type-Options', 'nosniff');
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

  api.post('/v1/mcp/servers', requireSession(sessions), (req: Request, res: Response) => {
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

  api.put('/v1/mcp/servers/:id', requireSession(sessions), (req: Request, res: Response) => {
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

  api.delete('/v1/mcp/servers/:id', requireSession(sessions), (req: Request, res: Response) => {
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

  api.post('/v1/mcp/servers/:id/call', requireSession(sessions), (req: Request, res: Response) => {
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
    void search.hasKey().then((hasKey) => {
      res.status(200).json({ ...search.config(), hasKey });
    });
  });

  api.put('/v1/search/config', requireSession(sessions), (req: Request, res: Response) => {
    const search = requireSearch(options, res);
    if (!search) return;
    try {
      const next = search.updateConfig((req.body ?? {}) as SearchConfigInput);
      void search.hasKey().then((hasKey) => {
        res.status(200).json({ ...next, hasKey });
      });
    } catch (err) {
      if (sendSearchError(res, err)) return;
      throw err;
    }
  });

  api.put('/v1/search/key', requireSession(sessions), (req: Request, res: Response) => {
    const search = requireSearch(options, res);
    if (!search) return;
    const body = (req.body ?? {}) as { key?: unknown };
    void search
      .setKey(typeof body.key === 'string' ? body.key : '')
      .then(() => res.status(204).end())
      .catch((err) => {
        if (sendSearchError(res, err)) return;
        throw err;
      });
  });

  api.delete('/v1/search/key', requireSession(sessions), (_req: Request, res: Response) => {
    const search = requireSearch(options, res);
    if (!search) return;
    void search.removeKey().then(() => res.status(204).end());
  });

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
    res.json({ notes: notes.list() });
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

  api.get('/v1/files/refs', requireSession(sessions), (req: Request, res: Response) => {
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
    res.json({ roots: broker.roots.list() });
  });

  api.post('/v1/roots', requireSession(sessions), (req: Request, res: Response) => {
    const broker = requireBroker(options, res);
    if (!broker) return;
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

  api.delete('/v1/roots/:id', requireSession(sessions), (req: Request, res: Response) => {
    const broker = requireBroker(options, res);
    if (!broker) return;
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

  api.post('/v1/grants', requireSession(sessions), (req: Request, res: Response) => {
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
    if (!broker.manifests.some((m) => m.id === toolId)) {
      res.status(400).json({ error: 'unknown_tool', message: 'no such tool' });
      return;
    }
    if (projectId === '' || broker.roots.getById(projectId) === null) {
      res.status(404).json({ error: 'not_found', message: 'project root not found' });
      return;
    }
    const note = typeof body.note === 'string' && body.note.trim() !== '' ? body.note.trim() : undefined;
    const grant = broker.grants.add(toolId, projectId, note === undefined ? {} : { note });
    audit.log(actor, 'grant.add', projectId, { toolId, projectId, grantId: grant.id, source: 'user' });
    res.status(201).json(grant);
  });

  api.delete('/v1/grants/:id', requireSession(sessions), (req: Request, res: Response) => {
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
      if (row.requestedBy !== 'persona') return { ...row, personaName: null };
      const playbookPersona = options.playbooks?.personaForPending(row.id) ?? null;
      if (playbookPersona !== null) return { ...row, personaName: playbookPersona.name };
      const stored = broker.pending.get(row.id);
      const storedPersonaId = stored?.personaId ?? null;
      if (storedPersonaId !== null && options.personaManager !== undefined) {
        const persona = options.personaManager.get(storedPersonaId);
        if (persona !== null) return { ...row, personaName: persona.name };
      }
      return { ...row, personaName: null };
    });
    res.json({ pending });
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
          );
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

  api.post('/v1/proposals/:id/apply', requireSession(sessions), (req: Request, res: Response) => {
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

  api.put('/v1/browser/scopes/:origin', requireSession(sessions), (req: Request, res: Response) => {
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

  api.delete('/v1/browser/scopes/:origin', requireSession(sessions), (req: Request, res: Response) => {
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

  api.get('/v1/skills', requireSession(sessions), (req: Request, res: Response) => {
    const skills = requireSkills(options, res);
    if (!skills) return;
    res.json({ skills: skills.list() });
  });

  api.post('/v1/skills/install', requireSession(sessions), (req: Request, res: Response) => {
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

  api.post('/v1/skills/:id/disable', requireSession(sessions), (req: Request, res: Response) => {
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

  api.post('/v1/skills/:id/enable', requireSession(sessions), (req: Request, res: Response) => {
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

  api.delete('/v1/skills/:id', requireSession(sessions), (req: Request, res: Response) => {
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

  api.post('/v1/skills/:id/invoke', requireSession(sessions), async (req: Request, res: Response) => {
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
    const result = await runner.invoke(
      detail,
      body.args,
      personaId === undefined ? {} : { personaId },
    );
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

  api.post('/v1/playbooks/:id/run', requireSession(sessions), async (req: Request, res: Response) => {
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

  api.post('/v1/deploy-profiles', requireSession(sessions), (req: Request, res: Response) => {
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

  api.delete('/v1/deploy-profiles/:id', requireSession(sessions), (req: Request, res: Response) => {
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
  const errorHandler: express.ErrorRequestHandler = (err, _req, res, _next) => {
    const maybe = err as { type?: string };
    if (maybe?.type === 'entity.parse.failed') {
      res.status(400).json({ error: 'bad_json' });
      return;
    }
    if (maybe?.type === 'entity.too.large') {
      res.status(413).json({ error: 'payload_too_large' });
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
