/**
 * Partner core HTTP server (Express 5) — the M0 security spine as routes.
 *
 * Layering, in order:
 *  1. Loopback Host guard — 403 before any routing when the Host header is
 *     not on the allowlist (default `127.0.0.1:<port>` / `localhost:<port>`).
 *  2. Public surface — /v1/health and (demo only) /v1/dev/pair-code.
 *  3. Pairing exchange — POST /v1/pair drives the 6-digit single-use manager
 *     and mints a `web` session bound to the caller's (allowlisted) origin.
 *  4. Authed group (Bearer + origin) — POST /v1/chat (SSE) and GET /v1/audit.
 *
 * Secrets discipline: tokens/keys never enter responses, audit details, or
 * SSE payloads — every audit write goes through the redaction service.
 */
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import type { ChatEvent, ChatMessage, ChatRequest, ProviderClient } from '@partner/shared';
import { demoProvider } from '../gateway/demo.js';
import type { PairingManager } from './pairing.js';
import type { SessionInfo, SessionManager } from './session.js';
import type { AuditService } from '../services/redaction.js';

export interface CoreAppOptions {
  port: number;
  demo: boolean;
  version: string;
  schemaVersion: number;
  /** Host header allowlist; defaults to loopback for `port`. */
  hostAllowlist?: string[];
  pairing: PairingManager;
  sessions: SessionManager;
  audit: AuditService;
  /** Configured model providers. Empty in M0 outside demo mode. */
  providers?: ProviderClient[];
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
  // Demo fallback keeps /v1/chat alive before M1 wires real providers.
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
    next();
  };
}

function writeSse(res: Response, event: ChatEvent): void {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
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

  // 1. Loopback guard + JSON body parsing (public routes may not send JSON).
  app.use(hostGuard(allowlist));
  app.use(express.json({ limit: '1mb' }));

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
    const model =
      typeof body.model === 'string' && body.model.trim() !== '' ? body.model.trim() : 'demo';
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

  api.get('/v1/audit', requireSession(sessions), (req: Request, res: Response) => {
    const raw = typeof req.query.limit === 'string' ? Number.parseInt(req.query.limit, 10) : NaN;
    const limit = Number.isFinite(raw)
      ? Math.min(MAX_AUDIT_LIMIT, Math.max(1, raw))
      : DEFAULT_AUDIT_LIMIT;
    res.json({ entries: audit.list(limit) });
  });

  app.use(api);

  // Unknown routes: structured 404 (never leak internal paths or secrets).
  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: 'not_found' });
  });

  return app;
}
