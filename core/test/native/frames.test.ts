/**
 * M7 native-messaging FRAME codec tests (PLAN-M7.md): pure encode/decode
 * round trips over in-memory byte sources — exact 4-byte little-endian
 * length prefixes, payloads > 2k and > 64k (multi-byte length), chunk-
 * boundary splits, sequential frames on one channel, empty body frames,
 * oversized-length refusals, truncation = clean end-of-channel, EOF before
 * a header.
 */
import { PassThrough } from 'node:stream';
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import { MAX_FRAME_BYTES, NmError, readFrame, writeFrame } from '../../src/native/frames.js';
import type { NmEnvelope } from '@partner/shared';

/** Chrome framing for a JSON envelope (as the extension would write it). */
function frameEnvelope(envelope: NmEnvelope): Buffer {
  const body = Buffer.from(JSON.stringify(envelope), 'utf8');
  const out = Buffer.allocUnsafe(4 + body.length);
  out.writeUInt32LE(body.length, 0);
  body.copy(out, 4);
  return out;
}

/** One-shot async-iterable over prebuilt frame buffers (optionally chunked). */
function channel(frames: Buffer[], chunkSize?: number): AsyncIterable<Buffer> {
  async function* stdin(): AsyncGenerator<Buffer> {
    for (const f of frames) {
      if (chunkSize === undefined || chunkSize <= 0) {
        yield f;
      } else {
        for (let i = 0; i < f.length; i += chunkSize) {
          yield f.subarray(i, i + chunkSize);
        }
      }
    }
  }
  return stdin();
}

describe('frame encoding', () => {
  it('writes the exact 4-byte little-endian length prefix', async () => {
    const envelope: NmEnvelope = {
      type: 'request',
      id: 'r1',
      command: 'hello',
      payload: { a: 1, b: 'two' },
    };
    const stream = new PassThrough();
    writeFrame(stream, envelope);
    await once(stream, 'readable');
    const raw = stream.read() as Buffer;
    const body = Buffer.from(JSON.stringify(envelope), 'utf8');
    expect(raw).toBeInstanceOf(Buffer);
    expect(raw.length).toBe(4 + body.length);
    expect(raw.readUInt32LE(0)).toBe(body.length);
    expect(raw.subarray(4).toString('utf8')).toBe(body.toString('utf8'));
  });
});

describe('frame decoding', () => {
  it('round-trips envelopes > 2k and > 64k payloads (multi-byte length)', async () => {
    for (const size of [2048, 70_000]) {
      const envelope: NmEnvelope = {
        type: 'request',
        id: 'big',
        command: 'page.capture',
        payload: { origin: 'example.com', text: 'x'.repeat(size) },
      };
      const decoded = await readFrame(channel([frameEnvelope(envelope)]));
      expect(decoded).not.toBeNull();
      expect(JSON.parse((decoded as Buffer).toString('utf8'))).toEqual(envelope);
      // The length prefix is little-endian over the FULL body length.
      const body = Buffer.from(JSON.stringify(envelope), 'utf8');
      expect(body.length).toBeGreaterThan(size);
    }
  });

  it('decodes frames split across arbitrary chunk boundaries', async () => {
    const a: NmEnvelope = { type: 'request', id: '1', command: 'hello' };
    const b: NmEnvelope = {
      type: 'request',
      id: '2',
      command: 'page.capture',
      payload: { origin: 'example.com', text: 'split me'.repeat(300) },
    };
    const src = channel([frameEnvelope(a), frameEnvelope(b)], 7);
    expect(JSON.parse((await readFrame(src))!.toString('utf8'))).toEqual(a);
    expect(JSON.parse((await readFrame(src))!.toString('utf8'))).toEqual(b);
    expect(await readFrame(src)).toBeNull();
  });

  it('reads many sequential frames from one channel', async () => {
    const envelopes: NmEnvelope[] = Array.from({ length: 50 }, (_, i) => ({
      type: 'request',
      id: `id-${i}`,
      command: i % 2 === 0 ? 'hello' : 'scope.get',
      payload: i % 2 === 0 ? undefined : { origin: `site${i}.example` },
    }));
    const src = channel(envelopes.map(frameEnvelope));
    for (const expected of envelopes) {
      const body = await readFrame(src);
      expect(JSON.parse((body as Buffer).toString('utf8'))).toEqual(expected);
    }
    expect(await readFrame(src)).toBeNull();
  });

  it('returns null on EOF before any header', async () => {
    expect(await readFrame(channel([]))).toBeNull();
  });

  it('returns an empty body for a zero-length frame', async () => {
    const empty = Buffer.alloc(4); // length 0
    const src = channel([empty]);
    const body = await readFrame(src);
    expect(body).not.toBeNull();
    expect((body as Buffer).length).toBe(0);
  });

  it('throws bad_frame for an oversized length prefix', async () => {
    const huge = Buffer.alloc(4);
    huge.writeUInt32LE(MAX_FRAME_BYTES + 1, 0);
    const src = channel([huge]);
    try {
      await readFrame(src);
      expect.unreachable('expected a bad_frame NmError');
    } catch (err) {
      expect(err).toBeInstanceOf(NmError);
      expect((err as NmError).code).toBe('bad_frame');
    }
  });

  it('treats EOF mid-body as a clean end of channel (returns null)', async () => {
    const head = Buffer.alloc(4);
    head.writeUInt32LE(100, 0); // promises 100 body bytes…
    const short: AsyncIterable<Buffer> = (async function* shortChannel(): AsyncGenerator<Buffer> {
      yield head;
      yield Buffer.from('ab'); // …but only 2 arrive before EOF.
    })();
    expect(await readFrame(short)).toBeNull();
  });
});
