import { describe, expect, it } from 'vitest';
import {
  FrameDecoder,
  decodeFrames,
  encodeFrame,
  failure,
  isEnvelope,
  isRequest,
  isResponse,
  newRequestId,
  parseEnvelope,
  request,
  responseResult,
  success,
} from '../src/lib/protocol.js';

const enc = new TextEncoder();
const dec = new TextDecoder();

function utf8Bytes(text: string): Uint8Array {
  return enc.encode(text);
}

function readLenLE(out: Uint8Array): number {
  return ((out[0] ?? 0) | ((out[1] ?? 0) << 8) | ((out[2] ?? 0) << 16) | ((out[3] ?? 0) << 24)) >>> 0;
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

describe('NM frame encoding', () => {
  it('encodes a 4-byte LE length prefix + UTF-8 JSON body', () => {
    const envelope = { type: 'request', id: 'r1', command: 'hello' };
    const out = encodeFrame(envelope);
    const body = utf8Bytes(JSON.stringify(envelope));
    expect(out.length).toBe(4 + body.length);
    expect(readLenLE(out)).toBe(body.length);
    expect(dec.decode(out.subarray(4))).toBe(JSON.stringify(envelope));
  });

  it('round-trips ASCII and unicode (emoji, CJK) payloads', () => {
    const original = { type: 'response', id: 'r-1', ok: true, payload: { hello: '✓ 世界 😀 café' } };
    const frames = decodeFrames(encodeFrame(original));
    expect(frames).toEqual([original]);
  });

  it('uses exact byte lengths for multibyte content', () => {
    const original = {
      type: 'request',
      id: 'x',
      command: 'page.capture',
      payload: { text: '😀'.repeat(1000) },
    };
    const out = encodeFrame(original);
    expect(readLenLE(out)).toBe(out.length - 4);
    expect(decodeFrames(out)).toEqual([original]);
  });
});

describe('decodeFrames', () => {
  it('decodes several concatenated frames in one buffer', () => {
    const a = { type: 'request', id: '1', command: 'a' };
    const b = { type: 'response', id: '2', ok: true, payload: 42 };
    const c = { type: 'request', id: '3', command: 'c', payload: [1, 2] };
    const buf = concatBytes([encodeFrame(a), encodeFrame(b), encodeFrame(c)]);
    expect(decodeFrames(buf)).toEqual([a, b, c]);
  });

  it('ignores a trailing partial frame (tolerant)', () => {
    const full = encodeFrame({ type: 'response', id: '9', ok: false, error: 'x' });
    const truncated = full.subarray(0, full.length - 3);
    expect(decodeFrames(truncated)).toEqual([]);
  });

  it('throws bad_frame on an oversize declared length', () => {
    // Declares a length larger than the cap.
    const buf = new Uint8Array(8);
    buf[3] = 0x02; // length = 0x02000000 = 32 MiB > 16 MiB cap
    expect(() => decodeFrames(buf)).toThrow('bad_frame');
  });

  it('throws bad_frame on invalid JSON', () => {
    const body = utf8Bytes('{"type":"response"'); // truncated JSON
    const len = body.length & 0xff;
    const prefix = new Uint8Array([len, 0, 0, 0]);
    expect(() => decodeFrames(concatBytes([prefix, body]))).toThrow('bad_frame');
  });

  it('throws bad_frame when a complete frame is not an envelope', () => {
    expect(() => decodeFrames(encodeFrame({ hello: 'world' }))).toThrow('bad_frame');
  });
});

describe('FrameDecoder (streaming, chunked)', () => {
  it('assembles frames fed one byte at a time', () => {
    const a = { type: 'request', id: 'c1', command: 'hello' };
    const b = { type: 'response', id: 'c2', ok: true, payload: { version: '0.7.0' } };
    const bytes = concatBytes([encodeFrame(a), encodeFrame(b)]);
    const decoder = new FrameDecoder();
    const seen: unknown[] = [];
    for (const byte of bytes) {
      seen.push(...decoder.push(Uint8Array.of(byte)));
    }
    expect(seen).toEqual([a, b]);
  });

  it('returns nothing until a chunk is complete, then the frame', () => {
    const expected = { type: 'response', id: 'p', ok: true, payload: { code: '1234' } };
    const full = encodeFrame(expected);
    const decoder = new FrameDecoder();
    expect(decoder.push(full.subarray(0, 4))).toEqual([]);
    expect(decoder.push(full.subarray(4))).toEqual([expected]);
  });

  it('buffers across arbitrary chunk splits (unicode body split mid-codepoint)', () => {
    const original = {
      type: 'response',
      id: 'u',
      ok: true,
      payload: { text: '😀✓世界'.repeat(200) },
    };
    const bytes = encodeFrame(original);
    const decoder = new FrameDecoder();
    const seen: unknown[] = [];
    let offset = 0;
    while (offset < bytes.length) {
      const size = Math.min(7, bytes.length - offset);
      seen.push(...decoder.push(bytes.subarray(offset, offset + size)));
      offset += size;
    }
    expect(seen).toEqual([original]);
  });

  it('reset() drops a partial frame', () => {
    const full = encodeFrame({ type: 'response', id: 'z', ok: true });
    const decoder = new FrameDecoder();
    decoder.push(full.subarray(0, 6));
    decoder.reset();
    expect(decoder.push(full)).toEqual([{ type: 'response', id: 'z', ok: true }]);
  });
});

describe('envelope builders', () => {
  it('builds requests and responses with stable ids', () => {
    const req = request('id-1', 'pair.code', { demo: true });
    expect(req).toEqual({
      type: 'request',
      id: 'id-1',
      command: 'pair.code',
      payload: { demo: true },
    });
    const noPayload = request('id-2', 'hello');
    expect('payload' in noPayload).toBe(false);
  });

  it('builds ok/failure responses', () => {
    expect(success('s', { ok: 1 })).toEqual({
      type: 'response',
      id: 's',
      ok: true,
      payload: { ok: 1 },
    });
    expect(success('s2')).toEqual({ type: 'response', id: 's2', ok: true });
    expect(failure('f', 'denied_scope')).toEqual({
      type: 'response',
      id: 'f',
      ok: false,
      error: 'denied_scope',
    });
  });

  it('newRequestId produces unique ids', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i += 1) {
      const id = newRequestId();
      expect(seen.has(id)).toBe(false);
      seen.add(id);
    }
  });

  it('type guards discriminate envelopes', () => {
    expect(isRequest(request('a', 'hello'))).toBe(true);
    expect(isResponse(request('a', 'hello'))).toBe(false);
    expect(isRequest(success('a'))).toBe(false);
    expect(isResponse(success('a'))).toBe(true);
    expect(isEnvelope(success('a'))).toBe(true);
    expect(isEnvelope({ type: 'nope' })).toBe(false);
    expect(isEnvelope(null)).toBe(false);
  });

  it('parseEnvelope round-trips JSON text and rejects garbage', () => {
    const env = request('r', 'scope.get', { origin: 'example.com' });
    expect(parseEnvelope(JSON.stringify(env))).toEqual(env);
    expect(() => parseEnvelope('not json')).toThrow('bad_frame');
    expect(() => parseEnvelope('{"type":"request"}')).toThrow('bad_frame'); // missing id/command
  });

  it('responseResult normalises ok and error envelopes', () => {
    expect(responseResult(success('a', { v: 1 }))).toEqual({ ok: true, payload: { v: 1 } });
    expect(responseResult(failure('a', 'denied_scope'))).toEqual({ ok: false, error: 'denied_scope' });
    expect(responseResult({ type: 'response', id: 'a', ok: false })).toEqual({
      ok: false,
      error: 'unknown_error',
    });
  });
});
