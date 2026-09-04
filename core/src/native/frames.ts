/**
 * Chrome native-messaging frame codec (PLAN-M7.md).
 *
 * Chrome framing: 4-byte little-endian byte length followed by the UTF-8
 * JSON body. The core is the native HOST: requests arrive on stdin (frames
 * from the extension) and responses go to stdout.
 *
 * A frame source wraps ONE async-iterable (Node Readable or an in-memory
 * duplex) and is drained sequentially by {@link readFrame} — leftover bytes
 * inside a chunk are retained across calls so chunk boundaries never matter.
 *
 * Frame errors:
 *  - length 0 or > MAX_FRAME_BYTES -> NmError('bad_frame'): the stream
 *    position is unknowable, so the caller writes one error response and
 *    ends the channel.
 *  - clean EOF at any point (before a header or mid-body) -> readFrame
 *    returns null: the other side closed; the session ends quietly.
 *
 * Frame bodies are parsed by the caller; a decodable-but-unparseable body is
 * answered with a bad_frame response and the channel CONTINUES (tested).
 */
import type { Writable } from 'node:stream';
import type { NmEnvelope } from '@partner/shared';

/** Upper bound for one frame body (Chrome caps ~1MB; 16MiB is generous). */
export const MAX_FRAME_BYTES = 16 * 1024 * 1024;

/** Native-messaging protocol error code (framing layer). */
export type NmErrorCode = 'bad_frame';

export class NmError extends Error {
  readonly code: NmErrorCode;

  constructor(code: NmErrorCode, message: string) {
    super(message);
    this.name = 'NmError';
    this.code = code;
  }
}

export function nmError(code: NmErrorCode, message: string): NmError {
  return new NmError(code, message);
}

interface FrameSource {
  /** Next frame body, or null at a clean end of the channel. */
  next(): Promise<Buffer | null>;
}

/**
 * A single-iterator reader over an async-iterable byte stream. Created once
 * per stream (readFrame caches it per iterable) so sequential reads keep
 * chunk leftovers instead of dropping them.
 */
function createFrameSource(stream: AsyncIterable<Buffer>): FrameSource {
  let iterator: AsyncIterator<Buffer> | null = null;
  const chunks: Buffer[] = [];
  let buffered = 0;
  let ended = false;

  async function pull(): Promise<boolean> {
    if (ended) return false;
    if (iterator === null) iterator = stream[Symbol.asyncIterator]();
    const next = await iterator.next();
    if (next.done) {
      ended = true;
      return false;
    }
    const value = next.value;
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    if (chunk.length > 0) {
      chunks.push(chunk);
      buffered += chunk.length;
    }
    return true;
  }

  function takeBytes(n: number): Buffer {
    const out = Buffer.allocUnsafe(n);
    let written = 0;
    while (written < n) {
      const head = chunks[0];
      if (head === undefined) break; // buffered >= n is guaranteed by callers
      const take = Math.min(head.length, n - written);
      head.copy(out, written, 0, take);
      written += take;
      if (take === head.length) chunks.shift();
      else chunks[0] = head.subarray(take);
    }
    buffered -= n;
    return out;
  }

  async function next(): Promise<Buffer | null> {
    // Header: 4 bytes LE length.
    while (buffered < 4 && !ended) {
      if (!(await pull())) break;
    }
    if (buffered < 4) return null; // EOF before a header -> clean end.
    const header = takeBytes(4);
    const length = header.readUInt32LE(0);
    if (length === 0) return Buffer.alloc(0); // caller answers bad_frame; aligned.
    if (length > MAX_FRAME_BYTES) {
      throw nmError(
        'bad_frame',
        `frame length ${length} exceeds the ${MAX_FRAME_BYTES} byte maximum`,
      );
    }
    while (buffered < length && !ended) {
      if (!(await pull())) break;
    }
    if (buffered < length) return null; // EOF mid-body -> channel ended.
    return takeBytes(length);
  }

  return { next };
}

const sharedSources = new WeakMap<object, FrameSource>();

/**
 * Read one frame body (length prefix stripped) from `stream`. Returns null
 * when the channel ends cleanly (EOF). Callers must invoke this strictly
 * sequentially — repeated calls on the SAME iterable share one reader so no
 * bytes are lost across chunk boundaries.
 */
export async function readFrame(stream: AsyncIterable<Buffer>): Promise<Buffer | null> {
  const key = stream as object;
  let source = sharedSources.get(key);
  if (!source) {
    source = createFrameSource(stream);
    sharedSources.set(key, source);
  }
  return source.next();
}

/** Encode `envelope` as one Chrome native-messaging frame and write it. */
export function writeFrame(stream: Writable, envelope: NmEnvelope): void {
  const body = Buffer.from(JSON.stringify(envelope), 'utf8');
  const out = Buffer.allocUnsafe(4 + body.length);
  out.writeUInt32LE(body.length, 0);
  body.copy(out, 4);
  stream.write(out);
}
