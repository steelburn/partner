/**
 * Partner MV3 background service worker (ESM module).
 *
 * Owns the single native-messaging port to the local core host
 * (`com.partner.core`), an id→promise request map, auto-reconnect with
 * backoff, routing of popup messages, persisted pairing state
 * (chrome.storage.local), and the action badge ("!" = last action denied for
 * scope reasons).
 *
 * Page text is owner data: this module passes capture/analyze payloads
 * through to the core and never writes them to logs, errors, or storage.
 */

import {
  FrameDecoder,
  encodeFrame as buildFrame,
  newRequestId,
  request as buildRequest,
  responseResult,
} from './lib/protocol.js';
import type { NmResponse, NmResult } from './lib/protocol.js';
import type { PartnerRuntimeMessage, PartnerRuntimeReply } from './lib/messages.js';

const NATIVE_HOST = 'com.partner.core';
const STATE_KEY = 'partnerState';
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_CAP_MS = 15_000;
const REQUEST_TIMEOUT_MS = 20_000;

/** Denials that surface the "scope needed" badge hint. */
const DENIAL_CODES = new Set(['denied_scope', 'denied_origin', 'blocked_origin']);

interface Pending {
  command: string;
  timer: number;
  resolve(result: NmResult): void;
}

interface PartnerState {
  paired: boolean;
  lastDeny: string | null;
}

let port: chrome.runtime.Port | null = null;
let decoder: FrameDecoder = new FrameDecoder();
let pending = new Map<string, Pending>();
let backoffAttempt = 0;
let deadAttempts = 0;
let reconnectTimer: number | undefined;
let openAttempt: Promise<chrome.runtime.Port> | null = null;
let cachedState: PartnerState = { paired: false, lastDeny: null };

// ---------------------------------------------------------------------------
// Pairing state (chrome.storage.local)
// ---------------------------------------------------------------------------

async function loadState(): Promise<PartnerState> {
  const res = await chrome.storage.local.get(STATE_KEY);
  const raw = res[STATE_KEY] as PartnerState | undefined;
  return {
    paired: raw?.paired === true,
    lastDeny: typeof raw?.lastDeny === 'string' ? (raw.lastDeny as string) : null,
  };
}

async function persistState(next: PartnerState): Promise<void> {
  const changed =
    next.paired !== cachedState.paired || next.lastDeny !== cachedState.lastDeny;
  cachedState = next;
  if (changed) {
    await chrome.storage.local.set({ [STATE_KEY]: { ...next } }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Native port lifecycle
// ---------------------------------------------------------------------------

function failAllPending(error: string): void {
  for (const [, p] of pending) {
    clearTimeout(p.timer);
    p.resolve({ ok: false, error });
  }
  pending.clear();
}

function scheduleReconnect(): void {
  if (reconnectTimer !== undefined || port !== null) return;
  // Give up after six failed attempts without ever delivering a frame: the
  // native host is very likely not installed. Stop retrying until the user
  // acts (popup 'reconnect' message) — M7 review finding 4.
  deadAttempts += 1;
  if (deadAttempts >= 6) return;
  const delay = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** backoffAttempt);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined;
    backoffAttempt += 1;
    void warmUp();
  }, delay);
}

/** Reset the reconnect give-up counter (user asked to try again). */
function resetReconnect(): void {
  deadAttempts = 0;
  backoffAttempt = 0;
  void warmUp();
}

function connect(): Promise<chrome.runtime.Port> {
  return new Promise((resolve) => {
    const p = chrome.runtime.connectNative(NATIVE_HOST);
    port = p;
    decoder = new FrameDecoder();
    let delivered = false;
    p.onMessage.addListener((raw) => {
      delivered = true;
      onPortMessage(p, raw);
    });
    p.onDisconnect.addListener(() => {
      if (port !== p) return; // superseded by a newer attempt
      port = null;
      openAttempt = null;
      if (reconnectTimer !== undefined) {
        clearTimeout(reconnectTimer);
        reconnectTimer = undefined;
      }
      // A host that never delivered anything failed to start (not installed).
      failAllPending(delivered ? 'disconnected' : 'native_unavailable');
      void persistState({ paired: false, lastDeny: null });
      scheduleReconnect();
    });
    resolve(p);
  });
}

function ensurePort(): Promise<chrome.runtime.Port> {
  if (port !== null) return Promise.resolve(port);
  if (openAttempt !== null) return openAttempt;
  openAttempt = connect().finally(() => {
    openAttempt = null;
  });
  return openAttempt;
}

/** Decode and dispatch every complete NM frame in one raw chunk. */
function onPortMessage(p: chrome.runtime.Port, raw: unknown): void {
  let chunk: Uint8Array;
  if (raw instanceof ArrayBuffer) {
    chunk = new Uint8Array(raw);
  } else if (raw instanceof Uint8Array) {
    chunk = raw;
  } else {
    // Non-binary payload on a native port: protocol violation → resync.
    p.disconnect();
    return;
  }
  let frames: ReturnType<FrameDecoder['push']>;
  try {
    frames = decoder.push(chunk);
  } catch {
    // Framing desync (bad length / bad JSON / oversize). Drop buffered bytes
    // and force a fresh port so the streams re-synchronise.
    decoder.reset();
    p.disconnect();
    return;
  }
  for (const frame of frames) {
    if (frame.type === 'response') handleResponse(frame);
  }
}

function handleResponse(env: NmResponse): void {
  const id = env.id;
  const p = pending.get(id);
  if (!p) return;
  pending.delete(id);
  clearTimeout(p.timer);
  const result = responseResult(env);
  const cmd = p.command;
  if (result.ok) {
    deadAttempts = 0;
    backoffAttempt = 0;
    if (cmd === 'hello') {
      // hello only proves reachability — it does NOT imply pairing (the core
      // answers hello before any pair exchange; M7 review finding 2).
      void persistState({ paired: cachedState.paired, lastDeny: null });
    } else if (cmd === 'pair') {
      void persistState({ paired: true, lastDeny: null });
    } else {
      // capture/analyze/scope.read keep whatever pairing state we had.
      void persistState({ paired: cachedState.paired, lastDeny: null });
    }
    clearBadge();
  } else if (result.error === 'not_paired') {
    void persistState({ paired: false, lastDeny: null });
  } else if (result.error !== undefined && DENIAL_CODES.has(result.error)) {
    void persistState({ paired: cachedState.paired, lastDeny: result.error });
    setDeniedBadge(result.error);
  }
  p.resolve(result);
}

function setDeniedBadge(_reason: string): void {
  void chrome.action.setBadgeText({ text: '!' });
  void chrome.action.setBadgeBackgroundColor({ color: '#b42318' });
}

function clearBadge(): void {
  void chrome.action.setBadgeText({ text: '' });
}

/**
 * Issue one native-messaging request and await its response. Resolves with
 * the core's result (never throws for core denials); transport failures and
 * timeouts resolve with `{ ok:false, error }`.
 */
export function request(command: string, payload?: unknown): Promise<NmResult> {
  const id = newRequestId();
  return new Promise<NmResult>((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve({ ok: false, error: 'timeout' });
    }, REQUEST_TIMEOUT_MS);
    pending.set(id, { command, timer, resolve });
    ensurePort()
      .then((p) => {
        try {
          const frame = buildFrame(buildRequest(id, command, payload));
          // Native messaging wants an ArrayBuffer; expose exactly the frame.
          p.postMessage(
            frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength) as ArrayBuffer,
          );
        } catch {
          pending.delete(id);
          clearTimeout(timer);
          resolve({ ok: false, error: 'disconnected' });
        }
      })
      .catch(() => {
        pending.delete(id);
        clearTimeout(timer);
        resolve({ ok: false, error: 'native_unavailable' });
      });
  });
}

/** Reconnect probe: connect and say hello; refreshes pairing state. */
async function warmUp(): Promise<void> {
  try {
    const res = await request('hello', {});
    if (res.ok) { backoffAttempt = 0; deadAttempts = 0; }
  } catch {
    // request() never rejects; keep the worker alive only via timers above.
  }
}

// ---------------------------------------------------------------------------
// Message routing (popup ⇄ background)
// ---------------------------------------------------------------------------

function stateReply(): Promise<PartnerRuntimeReply> {
  return loadState().then((s) => ({
    kind: 'state.reply',
    paired: s.paired,
    native: port !== null,
    lastDeny: s.lastDeny,
  }));
}

chrome.runtime.onMessage.addListener((raw, _sender, sendResponse) => {
  const msg = raw as PartnerRuntimeMessage | undefined;
  if (typeof msg !== 'object' || msg === null) return undefined;
  if (msg.kind === 'state') {
    void stateReply().then(sendResponse);
    return true; // async response
  }
  if (msg.kind === 'reconnect') {
    resetReconnect();
    sendResponse({ kind: 'state.reply', paired: cachedState.paired, native: port !== null, lastDeny: cachedState.lastDeny });
    return true;
  }
  if (msg.kind === 'nm') {
    void request(msg.command, msg.payload)
      .then((res) => {
        const reply: PartnerRuntimeReply = {
          kind: 'nm.reply',
          command: msg.command,
          ok: res.ok,
        };
        if (res.payload !== undefined) reply.payload = res.payload;
        if (res.error !== undefined) reply.error = res.error;
        sendResponse(reply);
      })
      .catch(() => {
        sendResponse({
          kind: 'nm.reply',
          command: msg.command,
          ok: false,
          error: 'native_unavailable',
        } satisfies PartnerRuntimeReply);
      });
    return true; // async response
  }
  return undefined;
});

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

void loadState().then((s) => {
  cachedState = s;
});
void warmUp();
