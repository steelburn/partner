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
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import type { ChatEvent, ChatMessage, ChatRequest, ProviderClient, ProviderSummary } from '@partner/shared';
import type { Persona } from '@partner/shared';
import type { ProviderInput, ProviderSource, SelfServiceConnectInput } from '@partner/shared';
import type { ProjectRootInput, ToolExecResponse } from '@partner/shared/tools.js';
import { redactString } from '@partner/shared';
import { demoProvider } from '../gateway/demo.js';
import { createBudgetTracker } from '../gateway/budget.js';
import { centsForTokens } from '../gateway/pricing.js';
import { resolveChatModel } from '../gateway/resolver.js';
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
import type { ToolBroker } from '../broker/broker.js';
import type { ToolErrorCode } from '../broker/errors.js';
import { ToolError, toolErrorStatus } from '../broker/errors.js';
import type { ConversationManager, ConversationDetail } from '../conversations/manager.js';
import type { PersonaManager } from '../personas/manager.js';
import { ConversationError } from '../conversations/errors.js';
import { PersonaError } from '../personas/errors.js';

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
    };
    const messages = sanitizeMessages(body.messages);
    if (messages === null) {
      res.status(400).json({ error: 'invalid_messages' });
      return;
    }
    const requestedModel = optionalString(body.model);
    const requestedPersonaId = optionalString(body.personaId);
    const requestedConversationId = optionalString(body.conversationId);
    const taskClassRaw = optionalTaskClass(body.taskClass);
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
    const persist = requestedPersonaId !== undefined || requestedConversationId !== undefined;
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

    const ensureConversation = (): void => {
      if (!persist || conversationId !== null) return;
      try {
        // Auto-created conversations are bound to the routing persona; the
        // title is the first user message truncated to 60 chars (PLAN-M3).
        const title = firstUser !== undefined ? firstUser.content.slice(0, 60) : undefined;
        const created = (conversationManager as ConversationManager).create({
          personaId: routingPersonaId ?? undefined,
          title,
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
        (conversationManager as ConversationManager).append(conversationId, 'user', {
          content: lastUser.content,
          personaId: routingPersonaId,
          model: null,
          latencyMs: null,
        });
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

      // The turn will stream: create the auto conversation + persist the
      // incoming user message BEFORE streaming (best effort).
      ensureConversation();
      persistUserTurn();

      res.status(200);
      res.set(SSE_HEADERS);
      res.flushHeaders();

      // Defense-in-depth spend cap (PLAN-M1 'budget'). Off when the provider
      // has no budgetCents. Enforcement is WITHIN this response: deltas are
      // charged as they stream (char/4 token estimate, conservative default
      // price for unknown models) and the upstream is ABORTED the moment the
      // cap is exceeded — one budget_reached event, never a done. Final usage
      // reconciles the estimate with the real token count.
      const budgetCents = managedProvider.budgetCents ?? null;
      const tracker = createBudgetTracker({ budgetCents });

      // Client disconnect / budget stop: abort the upstream stream.
      const controller = new AbortController();
      const abortOnClose = (): void => {
        if (!res.writableEnded) controller.abort();
      };
      res.on('close', abortOnClose);

      const chatRequest: ChatRequest = { model, messages, stream: true, signal: controller.signal };
      let events = 0;
      let ok = true;
      let over = false;
      let estTokens = 0;

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
          if (event.type === 'error') ok = false;
          writeSse(res, event);
          events += 1;
          observeEvent(event);
        }
        persistAssistantTurn(sawDone, deltaText, doneModel, doneLatencyMs);
      } catch {
        // External abort (client gone) ends the generator silently; only
        // surface an error if the socket is still open.
        if (!res.writableEnded) {
          ok = false;
          writeSse(res, { type: 'error', message: 'provider_stream_failed' });
        }
      } finally {
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
    persistUserTurn();

    const chatRequest: ChatRequest = { model, messages, stream: true };

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
    res.json({ providers: manager.list() });
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
    res.json({ entries: audit.list(limit) });
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
    const body = (req.body ?? {}) as { personaId?: unknown; title?: unknown };
    try {
      const summary = manager.create({
        personaId: optionalString(body.personaId),
        title: optionalString(body.title),
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
      res.status(200).json({ conversation: detail.summary, messages: detail.messages });
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

  // -------------------------------------------------------------------------
  // M2 tool surface (PLAN-M2 wire spec) — project roots, grants, the broker
  // exec route, the approval queue, and write-preview proposals. Everything
  // 501s when no broker is wired. Responses use the shared wire types only;
  // params/results with content never reach audit (broker summarizes).
  // -------------------------------------------------------------------------

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
    res.json({ pending: broker.pending.list() });
  });

  api.post('/v1/tools/pending/:id', requireSession(sessions), (req: Request, res: Response) => {
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
      const result = broker.decide(id, {
        decision,
        remember: body.remember === true,
        ...(note !== undefined ? { note } : {}),
      }, actor);
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
    const message =
      err instanceof Error ? redactString(err.message) : `non-Error thrown: ${typeof err}`;
    console.error('[partner-core] unhandled error:', message);
    res.status(500).json({ error: 'internal_error' });
  };
  app.use(errorHandler);

  return app;
}
