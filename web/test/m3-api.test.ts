import { describe, expect, it } from 'vitest';
import {
  ApiRequestError,
  readDoneMeta,
  streamChat,
  type FetchLike,
  type StreamDoneMeta,
} from '../src/lib/api.js';
import {
  createConversation,
  deleteConversation,
  getConversation,
  listConversations,
  parseConversationDetail,
  parseConversationList,
  parseConversationSummary,
} from '../src/lib/conversations.js';
import {
  createPersona,
  deletePersona,
  listPersonas,
  parsePersona,
  parsePersonaList,
  pausePersona,
  resumePersona,
  updatePersona,
} from '../src/lib/personas.js';
import type {
  ChatEvent,
  ConversationMessage,
  ConversationSummary,
  Persona,
  PersonaInput,
} from '@partner/shared';

const TOKEN = 'tok-secret';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function streamResponse(chunks: string[], status = 200): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, {
    status,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function recordFetch(fn: (input: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ input: string; init?: RequestInit }> = [];
  const fetchImpl: FetchLike = (input, init) => {
    calls.push({ input, init });
    return Promise.resolve(fn(input, init));
  };
  return { fetchImpl, calls };
}

function persona(overrides: Partial<Persona> = {}): Persona {
  return {
    id: 'p-1',
    name: 'Maya',
    tagline: 'Sharp research partner',
    character: {
      voice: 'warm-professional',
      language: 'en',
      systemPrompt: 'You are Maya.',
      temperature: 0.6,
    },
    model: { taskClasses: { chat: 'gpt-4o-mini' } },
    independence: { level: 'assist', requireHumanFor: ['high'], autoScopes: [] },
    memory: { userProfile: 'none', episodes: 'none' },
    isDefault: true,
    paused: false,
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

const PERSONA_INPUT: PersonaInput = {
  name: 'Scribe',
  tagline: 'Emails and docs',
  character: {
    voice: 'clear',
    language: 'en',
    systemPrompt: 'You are Scribe.',
    temperature: 0.4,
  },
  model: { taskClasses: { chat: 'gpt-4o-mini' } },
  independence: { level: 'assist', requireHumanFor: ['high'], autoScopes: [] },
  memory: { userProfile: 'none', episodes: 'none' },
  isDefault: false,
};

function summary(overrides: Partial<ConversationSummary> = {}): ConversationSummary {
  return {
    id: 'c-1',
    personaId: 'p-1',
    title: 'Hello there',
    messageCount: 2,
    createdAt: 100,
    updatedAt: 200,
    ...overrides,
  };
}

function message(overrides: Partial<ConversationMessage> = {}): ConversationMessage {
  return {
    id: 'm-1',
    conversationId: 'c-1',
    role: 'user',
    personaId: 'p-1',
    content: 'Hello',
    model: null,
    latencyMs: null,
    createdAt: 150,
    ...overrides,
  };
}

describe('persona API client', () => {
  it('listPersonas GETs /v1/personas with the Bearer token and reads the envelope', async () => {
    const { fetchImpl, calls } = recordFetch(() => jsonResponse({ personas: [persona()] }));
    const result = await listPersonas(TOKEN, { fetchImpl });
    expect(result).toHaveLength(1);
    expect(result[0]?.name).toBe('Maya');
    expect(calls[0]?.input).toBe('/v1/personas');
    expect(calls[0]?.init?.method).toBe('GET');
    expect(calls[0]?.init?.headers).toMatchObject({ authorization: 'Bearer tok-secret' });
  });

  it('listPersonas tolerates a bare array', async () => {
    const { fetchImpl } = recordFetch(() => jsonResponse([persona({ id: 'p-2' })]));
    const result = await listPersonas(TOKEN, { fetchImpl });
    expect(result[0]?.id).toBe('p-2');
  });

  it('createPersona POSTs the input to /v1/personas and reads a bare persona', async () => {
    const { fetchImpl, calls } = recordFetch(() => jsonResponse(persona({ id: 'p-new' })));
    const result = await createPersona(TOKEN, PERSONA_INPUT, { fetchImpl });
    expect(result.id).toBe('p-new');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(calls[0]?.init?.headers).toMatchObject({ 'content-type': 'application/json' });
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual(PERSONA_INPUT);
  });

  it('createPersona tolerates a {persona: …} envelope', async () => {
    const { fetchImpl } = recordFetch(() => jsonResponse({ persona: persona() }));
    const result = await createPersona(TOKEN, PERSONA_INPUT, { fetchImpl });
    expect(result.id).toBe('p-1');
  });

  it('updatePersona PUTs to /v1/personas/:id', async () => {
    const { fetchImpl, calls } = recordFetch(() => jsonResponse(persona({ name: 'Maya 2' })));
    const result = await updatePersona(TOKEN, 'p-1', PERSONA_INPUT, { fetchImpl });
    expect(result.name).toBe('Maya 2');
    expect(calls[0]?.input).toBe('/v1/personas/p-1');
    expect(calls[0]?.init?.method).toBe('PUT');
  });

  it('deletePersona resolves on 204 and surfaces a 409 message (last default)', async () => {
    const ok = recordFetch(() => new Response(null, { status: 204 }));
    await expect(deletePersona(TOKEN, 'p-1', { fetchImpl: ok.fetchImpl })).resolves.toBeUndefined();
    const refused = recordFetch(() =>
      jsonResponse({ error: { message: 'The default persona cannot be deleted' } }, 409),
    );
    await expect(deletePersona(TOKEN, 'p-1', { fetchImpl: refused.fetchImpl })).rejects.toMatchObject({
      name: 'ApiRequestError',
      status: 409,
    });
  });

  it('pausePersona POSTs /pause and returns the updated persona', async () => {
    const { fetchImpl, calls } = recordFetch(() =>
      jsonResponse(persona({ paused: true, updatedAt: 9 })),
    );
    const result = await pausePersona(TOKEN, 'p-1', { fetchImpl });
    expect(result?.paused).toBe(true);
    expect(calls[0]?.input).toBe('/v1/personas/p-1/pause');
    expect(calls[0]?.init?.method).toBe('POST');
  });

  it('pausePersona resolves null on a 204 no-content response', async () => {
    const { fetchImpl } = recordFetch(() => new Response(null, { status: 204 }));
    const result = await pausePersona(TOKEN, 'p-1', { fetchImpl });
    expect(result).toBeNull();
  });

  it('resumePersona POSTs /resume and returns the resumed persona', async () => {
    const { fetchImpl, calls } = recordFetch(() => jsonResponse(persona({ paused: false })));
    const result = await resumePersona(TOKEN, 'p-1', { fetchImpl });
    expect(result?.paused).toBe(false);
    expect(calls[0]?.input).toBe('/v1/personas/p-1/resume');
  });

  it('throws ApiRequestError(401) for a dead session (maps via the shared error)', async () => {
    const { fetchImpl } = recordFetch(() => jsonResponse({ error: 'no session' }, 401));
    await expect(listPersonas('stale', { fetchImpl })).rejects.toMatchObject({
      name: 'ApiRequestError',
      status: 401,
    });
  });
});

describe('persona response parsing', () => {
  it('parsePersona accepts bare and enveloped shapes and rejects garbage', () => {
    expect(parsePersona(persona()).id).toBe('p-1');
    expect(parsePersona({ persona: persona() }).id).toBe('p-1');
    expect(() => parsePersona({ nope: true })).toThrow(ApiRequestError);
    expect(() => parsePersona(null)).toThrow(ApiRequestError);
  });

  it('parsePersonaList accepts envelope, bare array, and rejects garbage', () => {
    expect(parsePersonaList({ personas: [persona()] })).toHaveLength(1);
    expect(parsePersonaList([persona()])).toHaveLength(1);
    expect(() => parsePersonaList({ messages: [] })).toThrow(ApiRequestError);
    expect(() => parsePersonaList({ conversations: [] })).toThrow(ApiRequestError);
  });
});

describe('conversation API client', () => {
  it('listConversations GETs /v1/conversations and reads the envelope', async () => {
    const { fetchImpl, calls } = recordFetch(() =>
      jsonResponse({ conversations: [summary(), summary({ id: 'c-2' })] }),
    );
    const result = await listConversations(TOKEN, { fetchImpl });
    expect(result).toHaveLength(2);
    expect(calls[0]?.input).toBe('/v1/conversations');
    expect(calls[0]?.init?.method).toBe('GET');
    expect(calls[0]?.init?.headers).toMatchObject({ authorization: 'Bearer tok-secret' });
  });

  it('createConversation POSTs {personaId} and reads the created summary', async () => {
    const { fetchImpl, calls } = recordFetch(() =>
      jsonResponse(summary({ id: 'c-new', title: null, messageCount: 0 })),
    );
    const result = await createConversation(TOKEN, { personaId: 'p-1' }, { fetchImpl });
    expect(result.id).toBe('c-new');
    const body = JSON.parse(String(calls[0]?.init?.body)) as { personaId: string };
    expect(body.personaId).toBe('p-1');
  });

  it('getConversation maps the detail envelope (summary + messages)', async () => {
    const { fetchImpl } = recordFetch(() =>
      jsonResponse({
        conversation: summary({ messageCount: 2 }),
        messages: [message({ role: 'user' }), message({ id: 'm-2', role: 'assistant' })],
      }),
    );
    const detail = await getConversation(TOKEN, 'c-1', { fetchImpl });
    expect(detail.conversation?.title).toBe('Hello there');
    expect(detail.messages.map((m) => m.id)).toEqual(['m-1', 'm-2']);
  });

  it('getConversation tolerates a messages-only envelope and a bare array', async () => {
    const messagesOnly = recordFetch(() => jsonResponse({ messages: [message()] }));
    const bare = recordFetch(() => jsonResponse([message()]));
    const fromMessages = await getConversation(TOKEN, 'c-1', { fetchImpl: messagesOnly.fetchImpl });
    expect(fromMessages.conversation).toBeNull();
    expect(fromMessages.messages).toHaveLength(1);
    const fromBare = await getConversation(TOKEN, 'c-1', { fetchImpl: bare.fetchImpl });
    expect(fromBare.messages[0]?.content).toBe('Hello');
  });

  it('deleteConversation resolves on 204 and rejects otherwise', async () => {
    const ok = recordFetch(() => new Response(null, { status: 204 }));
    await expect(
      deleteConversation(TOKEN, 'c-1', { fetchImpl: ok.fetchImpl }),
    ).resolves.toBeUndefined();
    const bad = recordFetch(() => jsonResponse({ error: 'not found' }, 404));
    await expect(deleteConversation(TOKEN, 'c-x', { fetchImpl: bad.fetchImpl })).rejects.toMatchObject(
      { status: 404 },
    );
  });
});

describe('conversation response parsing', () => {
  it('parseConversationList / parseConversationSummary / parseConversationDetail', () => {
    expect(parseConversationList({ conversations: [summary()] })[0]?.id).toBe('c-1');
    expect(parseConversationSummary(summary()).id).toBe('c-1');
    expect(parseConversationSummary({ conversation: summary() }).id).toBe('c-1');
    const detail = parseConversationDetail({ conversation: summary(), messages: [message()] });
    expect(detail.conversation?.title).toBe('Hello there');
    expect(detail.messages[0]?.role).toBe('user');
    expect(() => parseConversationDetail({ nope: 1 })).toThrow(ApiRequestError);
  });
});

describe('chat done_meta consumption', () => {
  const frame = (e: ChatEvent) => `data: ${JSON.stringify(e)}\n\n`;

  it('reads messageId/conversationId off an enriched done frame', async () => {
    const { fetchImpl } = recordFetch(() =>
      streamResponse([
        frame({ type: 'delta', text: 'Hi' }),
        frame({ type: 'done', model: 'demo', latencyMs: 3 }),
        `data: ${JSON.stringify({ type: 'done', model: 'demo', latencyMs: 3, messageId: 'm-9', conversationId: 'c-9' })}\n\n`,
      ]),
    );
    const metas: StreamDoneMeta[] = [];
    const received: string[] = [];
    const result = await streamChat({
      token: TOKEN,
      content: 'x',
      onEvent: (e) => received.push(e.type),
      onDoneMeta: (m) => metas.push(m),
      fetchImpl,
    });
    expect(result.ok).toBe(true);
    expect(metas).toEqual([{ messageId: 'm-9', conversationId: 'c-9' }]);
  });

  it('consumes a dedicated trailing done_meta frame without dispatching it as an event', async () => {
    const { fetchImpl } = recordFetch(() =>
      streamResponse([
        frame({ type: 'done', model: 'demo', latencyMs: 3 }),
        `data: ${JSON.stringify({ type: 'done_meta', messageId: 'm-7', conversationId: 'c-7' })}\n\n`,
      ]),
    );
    const metas: StreamDoneMeta[] = [];
    const received: string[] = [];
    const result = await streamChat({
      token: TOKEN,
      content: 'x',
      onEvent: (e) => received.push(e.type),
      onDoneMeta: (m) => metas.push(m),
      fetchImpl,
    });
    expect(result.ok).toBe(true);
    expect(received).toEqual(['done']);
    expect(metas).toEqual([{ messageId: 'm-7', conversationId: 'c-7' }]);
  });

  it('yields no meta when the ids are absent or malformed', async () => {
    const { fetchImpl } = recordFetch(() =>
      streamResponse([
        frame({ type: 'done', model: 'demo', latencyMs: 3 }),
        `data: ${JSON.stringify({ type: 'done_meta', conversationId: 'c-1' })}\n\n`,
      ]),
    );
    const metas: StreamDoneMeta[] = [];
    await streamChat({
      token: TOKEN,
      content: 'x',
      onEvent: () => undefined,
      onDoneMeta: (m) => metas.push(m),
      fetchImpl,
    });
    expect(metas).toEqual([]);
  });

  it('readDoneMeta validates types defensively', () => {
    expect(readDoneMeta({ type: 'done', messageId: 'a', conversationId: 'b' })).toEqual({
      messageId: 'a',
      conversationId: 'b',
    });
    expect(readDoneMeta({ type: 'done_meta', messageId: 'a', conversationId: 'b' })).not.toBeNull();
    expect(readDoneMeta({ type: 'delta', text: 'x' })).toBeNull();
    expect(readDoneMeta({ type: 'done', messageId: 4, conversationId: 'b' })).toBeNull();
    expect(readDoneMeta(null)).toBeNull();
  });

  it('POSTs conversationId and personaId when streaming into a conversation', async () => {
    const { fetchImpl, calls } = recordFetch(() =>
      streamResponse([frame({ type: 'done', model: 'm', latencyMs: 1 })]),
    );
    await streamChat({
      token: TOKEN,
      content: 'hello',
      conversationId: 'c-1',
      personaId: 'p-1',
      onEvent: () => undefined,
      fetchImpl,
    });
    const body = JSON.parse(String(calls[0]?.init?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ conversationId: 'c-1', personaId: 'p-1' });
    expect(body.messages).toEqual([{ role: 'user', content: 'hello' }]);
  });

  it('flags a 423 (paused persona) response as paused with a friendly message', async () => {
    const { fetchImpl } = recordFetch(() => jsonResponse({ error: 'persona is paused' }, 423));
    const result = await streamChat({
      token: TOKEN,
      content: 'x',
      personaId: 'p-paused',
      onEvent: () => undefined,
      fetchImpl,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(423);
      expect(result.paused).toBe(true);
      expect(result.unauthorized).toBe(false);
      expect(result.message).toMatch(/resume it in Personas/i);
    }
  });
});
