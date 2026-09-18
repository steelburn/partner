/**
 * M3 conversation API client (PLAN-M3.md).
 *
 * Same chokepoint rules as every other client (lib/api.ts): the pairing
 * token travels ONLY as `Authorization: Bearer …`; transport is injectable
 * for tests; non-2xx maps to ApiRequestError with a readable message.
 * Secrets discipline: message content is never logged or echoed by this
 * module — it is fetched into the UI and re-sent to /v1/chat, nothing more.
 */

import {
  ApiRequestError,
  expectJson,
  expectNoContent,
  type FetchLike,
} from './api.js';
import type {
  ConversationMessage,
  ConversationSummary,
  CreateConversationInput,
  TitleSuggestionReply,
} from '@partner/shared';

const CONVERSATIONS_PATH = '/v1/conversations';

export type { FetchLike };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Normalize a conversations list response ({conversations: [...]} or a bare
 * array of ConversationSummary). Throws ApiRequestError on other shapes.
 */
export function parseConversationList(value: unknown, status = 200): ConversationSummary[] {
  if (Array.isArray(value)) return value as ConversationSummary[];
  if (isRecord(value) && Array.isArray(value.conversations)) {
    return value.conversations as unknown as ConversationSummary[];
  }
  throw new ApiRequestError(status, 'The conversations response had an unexpected shape.');
}

function isSummary(record: unknown): record is ConversationSummary {
  return (
    isRecord(record) &&
    typeof record.id === 'string' &&
    typeof record.createdAt === 'number' &&
    typeof record.updatedAt === 'number'
  );
}

/**
 * Normalize a single conversation summary: the core may return it bare or
 * under a `conversation` key (mirrors parsePersona's tolerance).
 */
export function parseConversationSummary(value: unknown, status = 200): ConversationSummary {
  const record = isRecord(value) ? value : null;
  const enveloped =
    record && isRecord(record.conversation)
      ? (record.conversation as unknown as ConversationSummary)
      : null;
  const summary = enveloped ?? (record as unknown as ConversationSummary | null);
  if (summary === null || !isSummary(summary)) {
    throw new ApiRequestError(status, 'The conversation response had an unexpected shape.');
  }
  return summary;
}

/**
 * Normalize the GET /v1/conversations/:id detail response. The core is
 * expected to return {conversation?, messages: [...]}; bare-array and
 * {messages: [...]} shapes are tolerated so the client stays robust. The
 * summary is null when the response omitted it.
 */
export function parseConversationDetail(
  value: unknown,
  status = 200,
): { conversation: ConversationSummary | null; messages: ConversationMessage[] } {
  const messagesValue: unknown = Array.isArray(value)
    ? value
    : isRecord(value)
      ? value.messages
      : undefined;
  if (!Array.isArray(messagesValue)) {
    throw new ApiRequestError(status, 'The conversation detail response had an unexpected shape.');
  }
  let conversation: ConversationSummary | null = null;
  if (isRecord(value) && isSummary(value.conversation)) {
    conversation = value.conversation as ConversationSummary;
  } else if (isRecord(value) && isSummary(value)) {
    conversation = value as ConversationSummary;
  }
  const messages = messagesValue as ConversationMessage[];
  if (messages.some((m) => !isRecord(m) || typeof m.id !== 'string')) {
    throw new ApiRequestError(status, 'The conversation detail response had an unexpected shape.');
  }
  return { conversation, messages };
}

/** GET /v1/conversations -> recent conversations (titles + updatedAt). */
export async function listConversations(
  token: string,
  options: { fetchImpl?: FetchLike } = {},
): Promise<ConversationSummary[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(CONVERSATIONS_PATH, {
    method: 'GET',
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
  });
  return parseConversationList(await expectJson<unknown>(response), response.status);
}

/** POST /v1/conversations {personaId?, title?} -> the created conversation. */
export async function createConversation(
  token: string,
  input: CreateConversationInput,
  options: { fetchImpl?: FetchLike } = {},
): Promise<ConversationSummary> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(CONVERSATIONS_PATH, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify(input),
  });
  return parseConversationSummary(await expectJson<unknown>(response), response.status);
}

/**
 * GET /v1/conversations/:id -> the conversation summary + messages ascending.
 * Message ordering is the core's contract; the client renders in arrival
 * order without re-sorting.
 */
export async function getConversation(
  token: string,
  id: string,
  options: { fetchImpl?: FetchLike } = {},
): Promise<{ conversation: ConversationSummary | null; messages: ConversationMessage[] }> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(`${CONVERSATIONS_PATH}/${encodeURIComponent(id)}`, {
    method: 'GET',
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
  });
  return parseConversationDetail(await expectJson<unknown>(response), response.status);
}

/** DELETE /v1/conversations/:id -> 204. */
export async function deleteConversation(
  token: string,
  id: string,
  options: { fetchImpl?: FetchLike } = {},
): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(`${CONVERSATIONS_PATH}/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${token}` },
  });
  return expectNoContent(response, 'Deleting the conversation');
}

/**
 * POST /v1/conversations/:id/title-suggestion -> a PROPOSAL (M34).
 *
 * Writes nothing: the transcript goes to one bounded model call and the reply
 * comes back for the owner to accept. Accepting is the ordinary
 * `PUT /v1/conversations/:id` (`updateConversation` in `lib/folders.ts`), so
 * there is exactly one path that stores a title.
 *
 * A reply the core could not use is a 200 with `{ok:false, code, message}` — the
 * request succeeded in determining the answer — so the caller renders the
 * sentence instead of treating it as a transport error. Failures that ARE
 * transport-shaped (401/404/400/501) throw ApiRequestError with the core's own
 * message, exactly like every other call here.
 */
export async function suggestConversationTitle(
  token: string,
  id: string,
  options: { fetchImpl?: FetchLike } = {},
): Promise<TitleSuggestionReply> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(
    `${CONVERSATIONS_PATH}/${encodeURIComponent(id)}/title-suggestion`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: '{}',
    },
  );
  const body = await expectJson<unknown>(response);
  if (!isRecord(body) || typeof body.ok !== 'boolean') {
    throw new ApiRequestError(
      response.status,
      'The title suggestion response had an unexpected shape.',
    );
  }
  if (body.ok === false) {
    return {
      ok: false,
      code: typeof body.code === 'string' ? body.code : 'unknown',
      message:
        typeof body.message === 'string'
          ? body.message
          : 'The core could not name this session.',
    };
  }
  if (typeof body.title !== 'string' || body.title.trim() === '') {
    throw new ApiRequestError(
      response.status,
      'The title suggestion response had an unexpected shape.',
    );
  }
  return {
    ok: true,
    title: body.title,
    model: typeof body.model === 'string' ? body.model : 'unknown',
    source: body.source === 'transcript' ? 'transcript' : 'model',
    userTurns: typeof body.userTurns === 'number' ? body.userTurns : 0,
    messageCount: typeof body.messageCount === 'number' ? body.messageCount : 0,
  };
}
