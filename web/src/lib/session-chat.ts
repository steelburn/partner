/**
 * M10 W5 session-only chat client (PLAN-M10.md): lets the web app talk to an
 * OpenAI-compatible endpoint DIRECTLY from the browser when no Partner core
 * is reachable — a borrowed machine with nothing installed.
 *
 * Security discipline (the whole point of the mode):
 *   - the key lives ONLY in the caller's in-memory state for the tab; this
 *     module never persists it (no localStorage/sessionStorage/URLs/logs),
 *   - the request carries the minimal header set (content-type/accept/
 *     authorization) — no telemetry/user-agent headers (the M1 scrub
 *     discipline; a browser cannot send x-stainless-* anyway),
 *   - the key is never interpolated into the URL,
 *   - errors are mapped to readable hints (CORS/network vs HTTP status)
 *     that never echo the key.
 * No tools/memory/notes exist in this mode by construction — the endpoint is
 * the only thing this client touches.
 */

export interface SessionChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** Normalize a user-pasted endpoint to the .../v1 form (strip trailing /). */
export function normalizeChatEndpoint(raw: string): string {
  let endpoint = raw.trim().replace(/\/+$/, '');
  if (!/\/v1$/.test(endpoint)) endpoint = `${endpoint}/v1`;
  return endpoint;
}

export function validateSessionEndpoint(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return 'Endpoint is required.';
  if (!/^https?:\/\//.test(trimmed)) {
    return 'Endpoint must start with https:// or http://.';
  }
  return null;
}

/** The key never leaves this shape: it is only used to build the header. */
export interface SessionChatRequest {
  endpoint: string; // normalized .../v1 base
  key: string;
  model: string;
  messages: SessionChatMessage[];
  signal?: AbortSignal;
  /** Injectable transport (tests); defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export type SessionChatOutcome =
  | { ok: true }
  | {
      ok: false;
      /** 'cors' (browser blocked / no network), 'http', 'aborted', 'parse'. */
      kind: 'cors' | 'http' | 'aborted' | 'parse';
      status?: number;
      /** Readable message — never contains the key. */
      message: string;
    };

const SSE_HEADERS = { 'content-type': 'application/json', accept: 'text/event-stream' };

/**
 * Stream one assistant turn against an OpenAI-compatible endpoint. Deltas
 * arrive through onDelta as plain text; a final assistant message is
 * returned so the caller can extend its in-memory transcript.
 */
export async function streamSessionChat(
  request: SessionChatRequest,
  onDelta: (text: string) => void,
): Promise<{ outcome: SessionChatOutcome; assistant: string }> {
  let assistant = '';
  const fetchImpl = request.fetchImpl ?? fetch;
  try {
    const response = await fetchImpl(`${request.endpoint}/chat/completions`, {
      method: 'POST',
      headers: {
        ...SSE_HEADERS,
        authorization: `Bearer ${request.key}`,
      },
      body: JSON.stringify({
        model: request.model,
        messages: request.messages,
        stream: true,
      }),
      signal: request.signal,
    });
    if (!response.ok) {
      const status = response.status;
      let detail = '';
      try {
        const body = (await response.json()) as { error?: { message?: string } };
        detail = body?.error?.message ?? '';
      } catch {
        detail = '';
      }
      if (status === 401) {
        return {
          outcome: {
            ok: false,
            kind: 'http',
            status,
            message:
              'The endpoint rejected the key (401). Check it was pasted whole and matches the provider.',
          },
          assistant,
        };
      }
      if (status === 429 || status === 402) {
        return {
          outcome: {
            ok: false,
            kind: 'http',
            status,
            message: `The endpoint refused the request (${status}) — out of quota or rate-limited.`,
          },
          assistant,
        };
      }
      const safe = detail.slice(0, 200).replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-***');
      return {
        outcome: {
          ok: false,
          kind: 'http',
          status,
          message: `The endpoint returned ${status}${safe ? `: ${safe}` : ''}.`,
        },
        assistant,
      };
    }

    if (!response.body) {
      return {
        outcome: { ok: false, kind: 'parse', message: 'The endpoint sent no stream body.' },
        assistant,
      };
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split('\n');
      buffer = frames.pop() ?? '';
      for (const line of frames) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === '[DONE]') return { outcome: { ok: true }, assistant };
        try {
          const parsed = JSON.parse(payload) as {
            choices?: Array<{ delta?: { content?: string } }>;
          };
          const content = parsed?.choices?.[0]?.delta?.content;
          if (typeof content === 'string' && content.length > 0) {
            assistant += content;
            onDelta(content);
          }
        } catch {
          // Ignore malformed frames defensively; a run of them still fails
          // cleanly when the stream ends without content.
        }
      }
    }
    return { outcome: { ok: true }, assistant };
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'AbortError') {
      return { outcome: { ok: false, kind: 'aborted', message: 'Stopped.' }, assistant };
    }
    // fetch TypeError = the browser blocked the request: CORS, mixed
    // content, DNS/network, or the endpoint refused preflight.
    return {
      outcome: {
        ok: false,
        kind: 'cors',
        message:
          'The browser could not reach that endpoint (CORS or network). Many providers do not ' +
          'allow browser access — run the desktop core and pair instead, or use an endpoint ' +
          'that sends Access-Control-Allow-Origin.',
      },
      assistant,
    };
  }
}
