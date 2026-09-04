/**
 * Native-messaging frame protocol — PURE (no chrome, no DOM, no node APIs;
 * runs under vitest/node and in the MV3 service worker).
 *
 * Chrome framing: 4-byte little-endian UTF-8 byte length + JSON payload
 * (PLAN-M7.md). These local types are shape-compatible with the wire types
 * shipped in `shared/src/browser.ts` (NmEnvelope, SCHEMA_VERSION=8) and with
 * the core's NM server — keep them in sync; the core is the author of the
 * frame grammar, this module is its mirror for the extension side.
 *
 * Page text is owner data: callers must never put payloads into logs/errors.
 */

export interface NmRequest {
  type: 'request';
  id: string;
  command: string;
  payload?: unknown;
}

export interface NmResponse {
  type: 'response';
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: string;
}

export type NmEnvelope = NmRequest | NmResponse;

/** Upper bound for a single decoded frame (16 MiB ≫ any page snapshot). */
export const MAX_FRAME_BYTES = 16 * 1024 * 1024;
/** Error code thrown by the decoder on framing/protocol violations. */
export const ERR_BAD_FRAME = 'bad_frame';

let seq = 0;

/** Monotonic, collision-resistant request id (per service-worker lifetime). */
export function newRequestId(prefix = 'r'): string {
  seq += 1;
  return `${prefix}-${Date.now().toString(36)}-${seq.toString(36)}`;
}

/** Build a request envelope. */
export function request(id: string, command: string, payload?: unknown): NmRequest {
  const env: NmRequest = { type: 'request', id, command };
  if (payload !== undefined) env.payload = payload;
  return env;
}

/** Build an ok response envelope. */
export function success(id: string, payload?: unknown): NmResponse {
  const env: NmResponse = { type: 'response', id, ok: true };
  if (payload !== undefined) env.payload = payload;
  return env;
}

/** Build a failed response envelope carrying an error code. */
export function failure(id: string, error: string): NmResponse {
  return { type: 'response', id, ok: false, error };
}

export function isRequest(value: unknown): value is NmRequest {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return v.type === 'request' && typeof v.id === 'string' && typeof v.command === 'string';
}

export function isResponse(value: unknown): value is NmResponse {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return v.type === 'response' && typeof v.id === 'string' && typeof v.ok === 'boolean';
}

export function isEnvelope(value: unknown): value is NmEnvelope {
  return isRequest(value) || isResponse(value);
}

/** Parse a JSON frame body into an envelope; throws ERR_BAD_FRAME. */
export function parseEnvelope(json: string): NmEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error(ERR_BAD_FRAME);
  }
  if (!isEnvelope(parsed)) throw new Error(ERR_BAD_FRAME);
  return parsed;
}

/** Normalise an ok/failed response envelope into a plain result. */
export function responseResult(env: NmResponse): NmResult {
  if (env.ok) return { ok: true, payload: env.payload };
  return { ok: false, error: env.error ?? 'unknown_error' };
}

/** Result shape returned to callers (never throws for core denials). */
export interface NmResult {
  ok: boolean;
  payload?: unknown;
  error?: string;
}

// ---------------------------------------------------------------------------
// Byte framing
// ---------------------------------------------------------------------------

const TE = new TextEncoder();

function encodeUtf8(text: string): Uint8Array {
  return TE.encode(text);
}

/**
 * Encode an object as one NM frame: 4-byte little-endian length + UTF-8 JSON.
 * Returns a Buffer-compatible Uint8Array (Buffer extends Uint8Array).
 */
export function encodeFrame(obj: unknown): Uint8Array {
  const text = JSON.stringify(obj);
  if (text === undefined) throw new Error(ERR_BAD_FRAME);
  const body = encodeUtf8(text);
  const out = new Uint8Array(4 + body.byteLength);
  const len = body.byteLength;
  out[0] = len & 0xff;
  out[1] = (len >>> 8) & 0xff;
  out[2] = (len >>> 16) & 0xff;
  out[3] = (len >>> 24) & 0xff;
  out.set(body, 4);
  return out;
}

function readFrame(input: Uint8Array, offset: number): { frame: NmEnvelope; next: number } {
  if (input.length - offset < 4) throw new Error(ERR_BAD_FRAME);
  const b0 = input[offset] ?? 0;
  const b1 = input[offset + 1] ?? 0;
  const b2 = input[offset + 2] ?? 0;
  const b3 = input[offset + 3] ?? 0;
  // Little-endian 32-bit unsigned (frames are ≪ 2 GiB; stays exact).
  const len = (b0 | (b1 << 8) | (b2 << 16) | (b3 << 24)) >>> 0;
  if (len > MAX_FRAME_BYTES) throw new Error(ERR_BAD_FRAME);
  const start = offset + 4;
  if (input.length - start < len) {
    // Incomplete frame tail — not an error; caller feeds more bytes.
    throw new Error('_incomplete');
  }
  const body = input.subarray(start, start + len);
  const json = new TextDecoder().decode(body);
  return { frame: parseEnvelope(json), next: start + len };
}

/**
 * Stateless decode of all complete frames in `buffer` (for single-shot use):
 * concatenated frames are all returned; a trailing partial frame is ignored
 * (tolerant). Streaming readers should prefer {@link FrameDecoder} so partial
 * bytes carry across chunks. Throws ERR_BAD_FRAME on framing violations.
 */
export function decodeFrames(buffer: Uint8Array): NmEnvelope[] {
  const out: NmEnvelope[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    const next = tryReadComplete(buffer, offset);
    if (next === null) break;
    out.push(next.frame);
    offset = next.next;
  }
  return out;
}

function tryReadComplete(
  buffer: Uint8Array,
  offset: number,
): { frame: NmEnvelope; next: number } | null {
  if (buffer.length - offset < 4) return null;
  try {
    return readFrame(buffer, offset);
  } catch (err) {
    if (err instanceof Error && err.message === '_incomplete') return null;
    throw err;
  }
}

/**
 * Streaming NM frame decoder. Feed raw chunks (ArrayBuffers/Uint8Arrays from
 * `port.onMessage`) via {@link push}; complete frames are returned once their
 * full payload has arrived, partial chunks are buffered across calls.
 */
export class FrameDecoder {
  #buf = new Uint8Array(0);

  /** Feed one raw chunk; returns every envelope completed by this chunk. */
  push(chunk: Uint8Array): NmEnvelope[] {
    const merged = new Uint8Array(this.#buf.length + chunk.length);
    merged.set(this.#buf, 0);
    merged.set(chunk, this.#buf.length);
    const out: NmEnvelope[] = [];
    let offset = 0;
    while (offset < merged.length) {
      const next = tryReadComplete(merged, offset);
      if (next === null) break;
      out.push(next.frame);
      offset = next.next;
    }
    this.#buf = merged.subarray(offset);
    return out;
  }

  /** Drop any buffered partial bytes (e.g. after a port reset). */
  reset(): void {
    this.#buf = new Uint8Array(0);
  }
}
