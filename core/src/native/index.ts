/**
 * M7 native-messaging session (PLAN-M7.md).
 *
 * The core is the Chrome native HOST: the extension pipes length-prefixed
 * JSON request frames to stdin and reads one response per request from
 * stdout. `createNativeSession` consumes frames sequentially and answers
 * every request with the SAME id (one response per request, in order).
 *
 * Pairing semantics (mirrors desktop pairing): the channel starts UNPAIRED.
 * Only `hello`, `pair.code` and `pair` are answered before pairing; every
 * other command returns `not_paired` until a `pair {code}` succeeds against
 * the pairing manager this session. `pair.code` reveals the dev code in
 * demo mode only (the demo seam the extension popup drives).
 *
 * Commands:
 *   hello        -> {version, demo, schemaVersion}
 *   pair.code    -> {code} (demo) | not_paired (live — the tray/web UI owns
 *                   code display, the NM host never reveals a live code)
 *   pair         -> {paired:true} | not_paired {reason}
 *   scope.get    -> resolved policy (blocklist -> stored -> default 'ask')
 *   page.capture -> read+act/trusted (and not blocked) -> {captured:true,
 *                   chars, selectionChars}; else denied_scope {policy}
 *   page.analyze -> capture policy first, then summarize the page through
 *                   the persona/provider (deterministic preview text when
 *                   demo or no usable provider); persona_paused when the
 *                   resolved persona is paused.
 *
 * Redaction discipline: page text/selection are the owner's data and never
 * reach audit rows, stderr logs or error payloads — capture/analyze audit
 * rows carry origin + ok + char counts only, and the analyze REPLY (the
 * owner-facing summary) is the only place page-derived text may appear.
 */
import type { Writable } from 'node:stream';
import type { NmEnvelope, Persona } from '@partner/shared';
import { redactString } from '../services/redaction.js';
import type { AuditService } from '../services/redaction.js';
import type { PairingManager } from '../http/pairing.js';
import type { PersonaManager } from '../personas/manager.js';
import type { ProviderManager } from '../providers/providerManager.js';
import { resolveChatModel } from '../gateway/resolver.js';
import type { SiteScopeManager } from '../browser/scopes.js';
import { CAPTURE_SCOPES } from '../browser/scopes.js';
import { BrowserError } from '../browser/errors.js';
import { firstDeltaText } from '../notes/index.js';
import { NmError, readFrame, writeFrame } from './frames.js';

export { MAX_FRAME_BYTES, NmError, nmError, readFrame, writeFrame } from './frames.js';
export type { NmErrorCode } from './frames.js';

/** Response `error` codes the extension understands (PLAN-M7 command set). */
export type NmCommandError =
  | 'unknown_command'
  | 'not_paired'
  | 'denied_scope'
  | 'persona_paused'
  | 'no_provider'
  | 'bad_frame';

/** Fixed analyzer instruction — never user-derived. */
export const ANALYZE_SYSTEM_PROMPT =
  'You are the user\'s partner analyzing a web page they captured. Write a ' +
  'concise, factual summary of the page content below: what it is about, the ' +
  'key claims or findings, and anything the user should act on. Third person, ' +
  'no greeting, no preamble.';

/** Page/selection content budget for the provider call (mirrors M5). */
export const ANALYZE_CHAR_BUDGET = 20_000;
/** Preview length of the selection echoed in the demo reply. */
export const ANALYZE_SELECTION_PREVIEW_CHARS = 120;

export interface NativeSessionDeps {
  /** Core version banner (hello). */
  version: string;
  /** Demo mode flag (hello; gates pair.code). */
  demo: boolean;
  schemaVersion: number;
  pairing: PairingManager;
  scopes: SiteScopeManager;
  personas: PersonaManager;
  providers: ProviderManager;
  audit: AuditService;
}

export interface NativeSessionIo {
  /** Inbound request frames (the extension -> core). */
  stdin: AsyncIterable<Buffer>;
  /** Outbound response frames (core -> extension). */
  stdout: Writable;
}

export interface NativeSessionResult {
  /** Request frames consumed. */
  frames: number;
  /** Response frames written (one per request; bad frames too). */
  responded: number;
  /** Whether a `pair {code}` succeeded this session. */
  paired: boolean;
  /** Why the session stopped. */
  ended: 'eof' | 'bad_frame';
}

interface SessionState {
  paired: boolean;
}

/** An already-decoded inbound request (post shape validation). */
interface NmRequest {
  id: string;
  command: string;
  payload: unknown;
}

type Outcome =
  | { ok: true; payload: unknown }
  | { ok: false; error: NmCommandError; payload?: unknown };

function ok(payload: unknown): Outcome {
  return { ok: true, payload };
}
function fail(error: NmCommandError, payload?: unknown): Outcome {
  return { ok: false, error, payload };
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** Parse + shape-validate one inbound frame into a request (null: bad). */
function parseRequest(body: Buffer): NmRequest | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    return null;
  }
  const envelope = asObject(parsed);
  if (!envelope) return null;
  const id = asString(envelope.id);
  const command = asString(envelope.command);
  if (id === undefined || command === undefined) return null;
  if (envelope.type !== undefined && envelope.type !== 'request') return null;
  return { id, command, payload: envelope.payload };
}

/** Resolved policy deciding whether capture/analyze may run. */
function captureAllowed(policy: import('@partner/shared').ResolvedPolicy): boolean {
  return !policy.blocked && CAPTURE_SCOPES.includes(policy.scope);
}

/** Deterministic preview reply when demo or no usable provider exists. */
export function demoAnalyzeReply(text: string | undefined, selection: string | undefined): string {
  const chars = (text ?? '').length;
  const selectionChars = (selection ?? '').length;
  let reply = `Partner preview (demo): page has ${chars} chars, selection has ${selectionChars} chars.`;
  if (selection !== undefined && selection.length > 0) {
    reply += ` ${selection.slice(0, ANALYZE_SELECTION_PREVIEW_CHARS)}`;
  }
  return reply;
}

function captureFields(payload: unknown): { origin: string; url?: string; title?: string } | null {
  const body = asObject(payload);
  if (!body) return null;
  const origin = asString(body.origin)?.trim();
  if (origin === undefined || origin === '') return null;
  const url = asString(body.url)?.trim() || undefined;
  const title = asString(body.title)?.trim() || undefined;
  if (body.url !== undefined && url === undefined) return null; // wrong type
  if (body.title !== undefined && title === undefined) return null; // wrong type
  return { origin, url, title };
}

function textOf(payload: unknown): { text?: string; selection?: string } | null {
  const body = asObject(payload);
  if (!body) return null;
  const text = asString(body.text);
  const selection = asString(body.selection);
  if (body.text !== undefined && text === undefined) return null;
  if (body.selection !== undefined && selection === undefined) return null;
  return { text, selection };
}

// ---------------------------------------------------------------------------
// Command handlers.
// ---------------------------------------------------------------------------

async function handleHello(deps: NativeSessionDeps): Promise<Outcome> {
  return ok({ version: deps.version, demo: deps.demo, schemaVersion: deps.schemaVersion });
}

async function handlePairCode(deps: NativeSessionDeps): Promise<Outcome> {
  if (!deps.demo) {
    return fail('not_paired', { reason: 'live_mode' });
  }
  let code = await deps.pairing.devCode();
  if (code === null) {
    // Demo seam: issue a code on first read (mirrors GET /v1/dev/pair-code).
    code = await deps.pairing.issue();
  }
  return ok({ code });
}

async function handlePair(
  deps: NativeSessionDeps,
  session: SessionState,
  payload: unknown,
): Promise<Outcome> {
  const body = asObject(payload);
  const code = body ? asString(body.code) : undefined;
  if (code === undefined || code.trim() === '') {
    return fail('not_paired', { reason: 'invalid_payload' });
  }
  const result = await deps.pairing.verify(code.trim());
  if (!result.ok) {
    return fail('not_paired', { reason: result.reason });
  }
  session.paired = true;
  deps.audit.log('nm', 'pair.ok', 'nm', {});
  return ok({ paired: true });
}

async function handleScopeGet(deps: NativeSessionDeps, payload: unknown): Promise<Outcome> {
  const body = asObject(payload);
  const origin = body ? asString(body.origin) : undefined;
  if (origin === undefined || origin.trim() === '') {
    return fail('bad_frame', { reason: 'invalid_payload' });
  }
  const policy = deps.scopes.policy(origin);
  return ok(policy);
}

function deniedPolicy(policy: import('@partner/shared').ResolvedPolicy): Outcome {
  return fail('denied_scope', { policy, required: 'read+act' });
}

async function handleCapture(deps: NativeSessionDeps, payload: unknown): Promise<Outcome> {
  const fields = captureFields(payload);
  if (!fields) return fail('bad_frame', { reason: 'invalid_payload' });
  const { text, selection } = textOf(payload) ?? {};
  const policy = deps.scopes.policy(fields.origin);
  const chars = (text ?? '').length;
  const selectionChars = (selection ?? '').length;
  if (!captureAllowed(policy)) {
    deps.audit.log('nm', 'browser.capture', policy.origin, {
      ok: false,
      scope: policy.scope,
      blocked: policy.blocked,
    });
    return deniedPolicy(policy);
  }
  deps.audit.log('nm', 'browser.capture', policy.origin, {
    ok: true,
    scope: policy.scope,
    chars,
    selectionChars,
  });
  return ok({ captured: true, chars, selectionChars });
}

/** The persona that routes analyze: explicit id, else the default. */
function resolvePersona(deps: NativeSessionDeps, personaId: string | undefined): Persona | null {
  if (personaId !== undefined && personaId !== '') {
    const explicit = deps.personas.get(personaId);
    if (explicit) return explicit;
    // Unknown id -> the default persona (no NM code for not_found; fail closed
    // to the persona-less default routing below when none exists).
  }
  return deps.personas.list().find((p) => p.isDefault) ?? null;
}

async function handleAnalyze(deps: NativeSessionDeps, payload: unknown): Promise<Outcome> {
  const fields = captureFields(payload);
  if (!fields) return fail('bad_frame', { reason: 'invalid_payload' });
  const { text, selection } = textOf(payload) ?? {};
  const body = asObject(payload);
  const personaId = body ? asString(body.personaId) : undefined;

  // 1. Capture policy gate (same as page.capture — read+act/trusted).
  const policy = deps.scopes.policy(fields.origin);
  if (!captureAllowed(policy)) {
    deps.audit.log('nm', 'browser.analyze', policy.origin, {
      ok: false,
      scope: policy.scope,
      blocked: policy.blocked,
    });
    return deniedPolicy(policy);
  }

  // 2. Persona pre-flight: paused persona refuses to analyze (423-like).
  const persona = resolvePersona(deps, personaId);
  const usedPersonaId = persona?.id ?? null;
  if (persona !== null && persona.paused) {
    deps.audit.log('nm', 'browser.analyze', policy.origin, {
      ok: false,
      reason: 'persona_paused',
      personaId: usedPersonaId,
    });
    return fail('persona_paused', { personaId: usedPersonaId });
  }

  // 3. Content: the user selection when present, else the page text (the
  //    extension caps text at ~100k; the provider call caps at 20k).
  const chars = (text ?? '').length;
  const selectionChars = (selection ?? '').length;
  const content = selection !== undefined && selection.trim() !== '' ? selection : (text ?? '');
  const source = content.slice(0, ANALYZE_CHAR_BUDGET);

  // 4. Summarize: demo -> deterministic preview; else persona/provider
  //    routing (mirrors M3 chat); no usable provider -> preview fallback.
  let reply: string;
  let model: string | null = null;
  let mode: 'demo' | 'provider' = 'demo';
  if (!deps.demo) {
    const resolved = resolveChatModel({
      persona,
      providers: deps.providers.list(),
      taskClass: 'chat',
    });
    if (resolved.provider !== null && resolved.model !== '') {
      try {
        const client = await deps.providers.clientFor(resolved.provider.id);
        const got = await firstDeltaText(
          client.chatStream({
            model: resolved.model,
            messages: [
              { role: 'system', content: ANALYZE_SYSTEM_PROMPT },
              { role: 'user', content: source },
            ],
          }),
        );
        if (got !== null && got.trim() !== '') {
          reply = got.trim();
          model = resolved.model;
          mode = 'provider';
        } else {
          deps.audit.log('nm', 'browser.analyze', policy.origin, {
            ok: false,
            reason: 'no_provider',
            personaId: usedPersonaId,
          });
          return fail('no_provider', { reason: 'upstream_empty', personaId: usedPersonaId });
        }
      } catch {
        // Keychain/client unavailable -> degrade to the preview fallback.
        reply = demoAnalyzeReply(text, selection);
      }
    } else {
      reply = demoAnalyzeReply(text, selection);
    }
  } else {
    reply = demoAnalyzeReply(text, selection);
  }

  deps.audit.log('nm', 'browser.analyze', policy.origin, {
    ok: true,
    mode,
    chars,
    selectionChars,
    personaId: usedPersonaId,
    ...(model !== null ? { model } : {}),
  });
  return ok({ reply, personaId: usedPersonaId, mode, ...(model !== null ? { model } : {}) });
}

// ---------------------------------------------------------------------------
// Session driver.
// ---------------------------------------------------------------------------

const UNPAIRED_COMMANDS = new Set(['hello', 'pair.code', 'pair']);

export async function createNativeSession(
  deps: NativeSessionDeps,
  io: NativeSessionIo,
): Promise<NativeSessionResult> {
  const session: SessionState = { paired: false };
  const result: NativeSessionResult = { frames: 0, responded: 0, paired: false, ended: 'eof' };

  const respond = (id: string, outcome: Outcome): void => {
    const envelope: NmEnvelope = { type: 'response', id, ok: outcome.ok };
    if (outcome.ok) envelope.payload = outcome.payload;
    else {
      envelope.error = outcome.error;
      if (outcome.payload !== undefined) envelope.payload = outcome.payload;
    }
    writeFrame(io.stdout, envelope);
    result.responded += 1;
  };

  for (;;) {
    let body: Buffer | null;
    try {
      body = await readFrame(io.stdin);
    } catch (err) {
      // Unrecoverable framing error (absurd length): answer once, then stop —
      // the stream position is unknowable, so the channel cannot continue.
      if (err instanceof NmError && err.code === 'bad_frame') {
        result.ended = 'bad_frame';
        writeFrame(io.stdout, { type: 'response', id: '', ok: false, error: 'bad_frame' });
        result.responded += 1;
        return result;
      }
      throw err;
    }
    if (body === null) break; // EOF: the extension closed the channel.
    result.frames += 1;

    const request = parseRequest(body);
    if (request === null) {
      // A frame decoded but is not a usable request. The channel is aligned
      // again after it (we consumed its exact length), so answer and resume.
      writeFrame(io.stdout, { type: 'response', id: '', ok: false, error: 'bad_frame' });
      result.responded += 1;
      continue;
    }

    let outcome: Outcome;
    if (!session.paired && !UNPAIRED_COMMANDS.has(request.command)) {
      outcome = fail('not_paired', { reason: 'pair_required' });
    } else {
      try {
        outcome = await dispatch(deps, session, request);
      } catch (err) {
        // Belt-and-suspenders: never crash the channel on an unexpected
        // error, and never let page-derived text reach a log. Message text
        // is not logged anywhere, but redact anyway as a hard discipline.
        const message = err instanceof Error ? err.message : String(err);
        console.error('[partner-core] native dispatch failed:', redactString(message));
        outcome = fail('bad_frame', { reason: 'internal_error' });
      }
    }
    respond(request.id, outcome);
    if (session.paired) result.paired = true;
  }

  return result;
}

async function dispatch(
  deps: NativeSessionDeps,
  session: SessionState,
  request: NmRequest,
): Promise<Outcome> {
  try {
    switch (request.command) {
      case 'hello':
        return handleHello(deps);
      case 'pair.code':
        return handlePairCode(deps);
      case 'pair':
        return handlePair(deps, session, request.payload);
      case 'scope.get':
        return handleScopeGet(deps, request.payload);
      case 'page.capture':
        return handleCapture(deps, request.payload);
      case 'page.analyze':
        return handleAnalyze(deps, request.payload);
      default:
        return fail('unknown_command');
    }
  } catch (err) {
    // Invalid origins surface as typed BrowserErrors -> answer bad_frame so
    // the channel stays alive; anything else re-throws to the session guard.
    if (err instanceof BrowserError) {
      return fail('bad_frame', { reason: 'invalid_payload' });
    }
    throw err;
  }
}
