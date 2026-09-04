/**
 * Tiny loopback http server helper for M1 upstream doubles (tests only).
 * Listens on port 0 so the OS picks a free port; keeps track of sockets via
 * closeAllConnections on close so stalled/timeout tests never hang vitest.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface TestServer {
  server: http.Server;
  /** e.g. http://127.0.0.1:54321 (no trailing slash) */
  base: string;
  close(): Promise<void>;
}

export function startHttpServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<TestServer> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        server,
        base: `http://127.0.0.1:${port}`,
        close(): Promise<void> {
          return new Promise((done) => {
            server.closeAllConnections();
            server.close(() => done());
          });
        },
      });
    });
  });
}

/** SSE fixture: two deltas + usage + [DONE], like an OpenAI streamed reply. */
export function sseReply(text: string[], usage: { prompt: number; completion: number }): string {
  const frames: string[] = [];
  for (const piece of text) {
    frames.push(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: piece } }] })}\n\n`);
  }
  frames.push(
    `data: ${JSON.stringify({
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: usage.prompt, completion_tokens: usage.completion, total_tokens: usage.prompt + usage.completion },
    })}\n\n`,
  );
  frames.push('data: [DONE]\n\n');
  return frames.join('');
}
