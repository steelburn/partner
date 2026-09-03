import { describe, expect, it } from 'vitest';
import { parseSseStream, type SseEvent } from '../src/lib/sse.js';

const encoder = new TextEncoder();

async function collect(chunks: string[]): Promise<SseEvent[]> {
  const iterable: AsyncIterable<Uint8Array> = {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield encoder.encode(chunk);
    },
  };
  const out: SseEvent[] = [];
  for await (const event of parseSseStream(iterable)) out.push(event);
  return out;
}

describe('parseSseStream', () => {
  it('parses a data frame split across chunk boundaries', async () => {
    const events = await collect([
      'data: {"type":"delta","text":"He',
      'llo"}\n\ndata: {"type":"delta","text":"!"}\n\n',
    ]);
    expect(events).toEqual([
      { event: null, data: '{"type":"delta","text":"Hello"}' },
      { event: null, data: '{"type":"delta","text":"!"}' },
    ]);
  });

  it('handles CRLF frame separators', async () => {
    const events = await collect(['data: a\r\n\r\ndata: b\r\n\r\n']);
    expect(events.map((e) => e.data)).toEqual(['a', 'b']);
  });

  it('parses event name and multi-line data', async () => {
    const events = await collect(['event: turn\ndata: line1\ndata: line2\n\n']);
    expect(events).toEqual([{ event: 'turn', data: 'line1\nline2' }]);
  });

  it('ignores comments and unknown fields', async () => {
    const events = await collect([': keep-alive\nid: 7\ndata: ok\nretry: 100\n\n']);
    expect(events).toEqual([{ event: null, data: 'ok' }]);
  });

  it('yields a trailing frame without a final blank line', async () => {
    const events = await collect(['data: tail']);
    expect(events).toEqual([{ event: null, data: 'tail' }]);
  });

  it('yields nothing for comment-only or empty streams', async () => {
    expect(await collect([': ping\n\n'])).toEqual([]);
    expect(await collect([''])).toEqual([]);
  });
});
