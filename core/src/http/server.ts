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
 *     the M1 provider API (/v1/providers…, /v1/models) and the
 *     self-service import (/v1/self-service/*).
 *
 * Secrets discipline: tokens/keys never enter responses, audit details, or
 * SSE payloads — every audit write goes through the redaction service.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import type { ChatEvent, ChatMessage, ChatRequest, ProviderClient } from '@partner/shared';
import type { ProviderInput, ProviderSource, SelfServiceConnectInput } from '@partner/shared';
import type { ProjectRootInput, ToolExecResponse } from '@partner/shared/tools.js';
import { redactString } from '@partner/shared';
import { demoProvider } from '../gateway/demo.js';
import { createBudgetTracker } from '../gateway/budget.js';
import { centsForTokens } from '../gateway/pricing.js';
import { resolveChatProvider } from '../gateway/resolver.js';
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
}

const SSE_HEADERS = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
};

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

function writeSse(res: Response, event: ChatEvent): void {
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
    const body = (req.body ?? {}) as { messages?: unknown; model?: unknown };
    const messages = sanitizeMessages(body.messages);
    if (messages === null) {
      res.status(400).json({ error: 'invalid_messages' });
      return;
    }
    const requestedModel =
      typeof body.model === 'string' && body.model.trim() !== '' ? body.model.trim() : undefined;

    // M1: a configured provider wins over the demo/legacy fallback whenever
    // the manager resolves an enabled provider (resolver.ts).
    const manager = options.providerManager;
    let managedProvider = manager ? resolveChatProvider(manager, requestedModel) : undefined;
    // Demo-mode guard: a provider imported through the built-in demo double is
    // an OFFLINE artifact (its endpoint is this core itself), so keep the demo
    // provider as the chat backend — demo stays usable with no network.
    if (options.demo && managedProvider?.source === 'llm-self-service') {
      managedProvider = undefined;
    }

    if (managedProvider) {
      // managedProvider is only ever non-null when a manager is wired.
      const activeManager: ProviderManager = manager as ProviderManager;
      const model = requestedModel ?? managedProvider.defaultModels[0] ?? '';
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
        }
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
      }
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
