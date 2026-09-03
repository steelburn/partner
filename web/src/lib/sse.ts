/**
 * Minimal Server-Sent-Events reader over a fetch ReadableStream.
 *
 * Decodes UTF-8, normalizes CRLF, splits frames on blank lines, and yields
 * one event per block. Only `data:` (and `event:`) fields are surfaced —
 * comments (`:`) and other fields are ignored. Multi-line `data:` is joined
 * with '\n' per the SSE spec.
 */

export interface SseEvent {
  /** Optional `event:` name; null when the server sent none. */
  event: string | null;
  /** Concatenated `data:` payload for the frame. */
  data: string;
}

function parseSseBlock(block: string): SseEvent | null {
  const lines = block.split('\n');
  let event: string | null = null;
  const dataLines: string[] = [];
  for (const line of lines) {
    if (line.length === 0 || line.startsWith(':')) continue;
    if (line.startsWith('event:')) {
      const name = line.slice(6).trim();
      event = name.length > 0 ? name : null;
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).replace(/^ /, ''));
    }
    // Fields without a ':' (malformed) and unknown fields are ignored.
  }
  if (dataLines.length === 0) return null;
  return { event, data: dataLines.join('\n') };
}

export async function* parseSseStream(
  chunks: AsyncIterable<Uint8Array>,
): AsyncGenerator<SseEvent> {
  const decoder = new TextDecoder();
  let buffer = '';

  const drain = (): SseEvent[] => {
    const out: SseEvent[] = [];
    let separator: number;
    while ((separator = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, separator);
      buffer = buffer.slice(separator + 2);
      const parsed = parseSseBlock(block);
      if (parsed) out.push(parsed);
    }
    return out;
  };

  for await (const chunk of chunks) {
    // CRLF normalization happens here (before frame splitting) so that
    // '\r\n\r\n' boundaries are recognized.
    buffer += decoder.decode(chunk, { stream: true }).replace(/\r/g, '');
    const events = drain();
    if (events.length > 0) yield* events;
  }

  buffer += decoder.decode().replace(/\r/g, '');
  const tail = drain();
  if (tail.length > 0) yield* tail;
  // A final frame may legally omit the trailing blank line.
  if (buffer.length > 0) {
    const parsed = parseSseBlock(buffer);
    if (parsed) yield parsed;
  }
}
