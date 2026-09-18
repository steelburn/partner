/**
 * M34 — the session-title suggestion (PLAN-M34.md slice B).
 *
 * The module is the seam where an untrusted reply becomes a title, so these
 * tests pin the boundary rather than the wording:
 *
 *   1. BOUNDED IN. The transcript handed to the model is the last N turns,
 *      each clipped — a 100-message chat cannot produce an unbounded prompt.
 *   2. BOUNDED OUT. `sanitizeTitle` keeps ONE line and drops list markers, a
 *      `Title:` label, quotes/emphasis and trailing punctuation, so a reply
 *      reads as a label instead of a sentence.
 *   3. HONEST WITH NO MODEL. Demo mode and "no provider configured" both
 *      answer with the title DERIVED from the opening message and say so
 *      (`source: 'transcript'`), while a provider that IS configured but
 *      unusable stays a typed failure.
 *   4. The call is the shared bounded one: an over-cap reply and a stream that
 *      never answers are typed failures, never a hung route.
 *   5. Nothing here writes: every outcome is a proposal.
 */
import { describe, expect, it } from 'vitest';
import type {
  ChatEvent,
  ChatRequest,
  ConversationMessage,
  HealthReport,
  ProviderClient,
  ProviderSummary,
} from '@partner/shared';
import {
  TITLE_ASK_CHARS,
  TITLE_MAX_CHARS,
  TITLE_MIN_USER_TURNS,
  TITLE_SYSTEM_PROMPT,
  TITLE_TRANSCRIPT_TURNS,
  buildTitleTranscript,
  collapseWhitespace,
  countUserTurns,
  createTitleSuggester,
  derivedTitle,
  parseTitleReply,
  sanitizeTitle,
  suggestConversationTitle,
} from '../../src/conversations/title.js';
import type { TitleSuggesterOptions } from '../../src/conversations/title.js';

let seq = 0;
function msg(role: ConversationMessage['role'], content: string): ConversationMessage {
  seq += 1;
  return {
    id: `m${seq}`,
    conversationId: 'c1',
    role,
    personaId: null,
    content,
    model: null,
    latencyMs: null,
    createdAt: seq,
  };
}

/** A few back and forth: the shape the suggestion is offered against. */
function exchange(): ConversationMessage[] {
  return [
    msg('user', 'how do I rotate the sqlite key without losing data?'),
    msg('assistant', 'Back up first, then re-wrap the DEK with the new key.'),
    msg('user', 'and what about the vault passphrase?'),
    msg('assistant', 'It wraps the same DEK, so rotating it is a separate step.'),
  ];
}

function summary(over: Partial<ProviderSummary> = {}): ProviderSummary {
  return {
    id: 'p1',
    name: 'Fake provider',
    kind: 'openai-compatible',
    source: 'manual',
    purpose: 'general',
    endpoint: 'https://fake.example/v1',
    defaultModels: ['fake-model'],
    visionModels: [],
    enabled: true,
    budgetCents: null,
    createdAt: 1,
    updatedAt: 1,
    health: { ok: false, latencyMs: null, error: null, models: [], checkedAt: null },
    ...over,
  };
}

function streamClient(reply: string): { client: ProviderClient; requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  const client: ProviderClient = {
    async *chatStream(req: ChatRequest): AsyncGenerator<ChatEvent> {
      requests.push(req);
      yield { type: 'delta', text: reply };
      yield { type: 'done', model: 'fake-model', latencyMs: 1 };
    },
    async health(): Promise<HealthReport> {
      return { ok: true, latencyMs: 0 };
    },
  };
  return { client, requests };
}

function silentClient(): ProviderClient {
  return {
    async *chatStream(_req: ChatRequest): AsyncGenerator<ChatEvent> {
      await new Promise<void>(() => undefined);
    },
    async health(): Promise<HealthReport> {
      return { ok: true, latencyMs: 0 };
    },
  };
}

function optionsFor(
  client: ProviderClient | null,
  over: Partial<TitleSuggesterOptions> = {},
): TitleSuggesterOptions {
  const providers =
    client === null
      ? { list: () => [] as ProviderSummary[], clientFor: async () => client as never }
      : { list: () => [summary()], clientFor: async () => client };
  return { providers, demo: false, ...over };
}

describe('sanitizeTitle', () => {
  it('keeps the first non-empty line and drops a label, markup and quotes', () => {
    expect(sanitizeTitle('Title: **"Rotating the sqlite key."**')).toBe(
      'Rotating the sqlite key',
    );
    expect(sanitizeTitle('- Session title — Vault passphrases\nmore text')).toBe(
      'Vault passphrases',
    );
    expect(sanitizeTitle('\n\n  2. Key rotation plan  \n')).toBe('Key rotation plan');
  });

  it('has nothing usable for an empty or decoration-only reply', () => {
    expect(sanitizeTitle('')).toBeNull();
    expect(sanitizeTitle('   \n  \n')).toBeNull();
    expect(sanitizeTitle('**""**')).toBeNull();
  });

  it('clamps a long title instead of storing a paragraph', () => {
    const long = 'a'.repeat(400);
    const title = sanitizeTitle(long);
    expect(title).not.toBeNull();
    expect((title as string).length).toBeLessThanOrEqual(TITLE_MAX_CHARS);
    expect((title as string).endsWith('…')).toBe(true);
  });

  it('keeps internal punctuation and collapses whitespace', () => {
    expect(sanitizeTitle('SQLite key rotation:   the DEK, step by step')).toBe(
      'SQLite key rotation: the DEK, step by step',
    );
  });
});

describe('parseTitleReply', () => {
  it('reports a sentence when the reply has no usable title', () => {
    expect(parseTitleReply('**')).toEqual({
      ok: false,
      message: 'the model returned no usable title',
    });
  });

  it('accepts a plain reply', () => {
    expect(parseTitleReply('Key rotation')).toEqual({ ok: true, title: 'Key rotation' });
  });
});

describe('the prompt input is bounded', () => {
  it('sees only the last turns, each clipped, with system text left out', () => {
    const messages = [
      msg('system', 'x'.repeat(5_000)),
      ...Array.from({ length: TITLE_TRANSCRIPT_TURNS + 4 }, (_, i) =>
        msg(i % 2 === 0 ? 'user' : 'assistant', `turn ${i} ${'y'.repeat(600)}`),
      ),
    ];
    const transcript = buildTitleTranscript(messages);
    const lines = transcript.split('\n');
    expect(lines).toHaveLength(TITLE_TRANSCRIPT_TURNS);
    // The newest turn survives; the oldest is gone.
    expect(transcript).toContain(`turn ${TITLE_TRANSCRIPT_TURNS + 3} `);
    expect(transcript).not.toContain('turn 0 ');
    for (const line of lines) {
      expect(line.startsWith('User: ') || line.startsWith('Assistant: ')).toBe(true);
      expect(line.length).toBeLessThanOrEqual('Assistant: '.length + 400);
    }
    // No system text ever reaches the prompt.
    expect(transcript).not.toContain('xxxxx');
  });

  it('ignores empty turns', () => {
    const messages = [msg('user', '  '), msg('assistant', ''), msg('user', 'real')];
    expect(buildTitleTranscript(messages)).toBe('User: real');
    expect(countUserTurns(messages)).toBe(1);
    expect(TITLE_MIN_USER_TURNS).toBe(2);
  });
});

describe('derivedTitle (the no-model answer)', () => {
  it('uses the opening user message, clipped to the asked length', () => {
    const messages = [msg('user', `  ${'z'.repeat(200)}  `)];
    const title = derivedTitle(messages);
    expect(title).not.toBeNull();
    expect((title as string).length).toBeLessThanOrEqual(TITLE_ASK_CHARS);
  });

  it('collapses whitespace and falls back to the first turn of any role', () => {
    expect(derivedTitle([msg('user', 'a\n\n  b   c')])).toBe('a b c');
    expect(derivedTitle([msg('assistant', 'only an answer')])).toBe('only an answer');
    expect(derivedTitle([])).toBeNull();
    expect(collapseWhitespace('  a \n b ')).toBe('a b');
  });
});

describe('suggestConversationTitle', () => {
  it('returns the model title and hands it exactly the pinned prompt', async () => {
    const { client, requests } = streamClient('"SQLite key rotation."');
    const outcome = await suggestConversationTitle(optionsFor(client), { messages: exchange() });
    expect(outcome).toEqual({
      ok: true,
      title: 'SQLite key rotation',
      model: 'fake-model',
      source: 'model',
    });
    const sent = requests[0] as ChatRequest;
    expect(sent.messages[0]).toEqual({ role: 'system', content: TITLE_SYSTEM_PROMPT });
    const user = sent.messages[1] as { role: string; content: string };
    expect(user.content).toContain('User: how do I rotate the sqlite key');
    expect(user.content).toContain('Assistant: It wraps the same DEK');
    // The prompt carries the conversation, never an id or a token.
    expect(user.content).not.toContain('c1');
  });

  it('answers deterministically in demo mode without calling a provider', async () => {
    const { client, requests } = streamClient('model title');
    const outcome = await suggestConversationTitle(optionsFor(client, { demo: true }), {
      messages: exchange(),
    });
    expect(outcome).toEqual({
      ok: true,
      title: 'how do I rotate the sqlite key without losing data?',
      model: 'transcript',
      source: 'transcript',
    });
    expect(requests).toHaveLength(0);
  });

  it('falls back to the derived title when no provider is configured', async () => {
    const outcome = await suggestConversationTitle(optionsFor(null), { messages: exchange() });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('unreachable');
    expect(outcome.source).toBe('transcript');
    expect(outcome.model).toBe('transcript');
  });

  it('reports a typed failure when the reply has no usable title', async () => {
    const { client } = streamClient('**""**');
    const outcome = await suggestConversationTitle(optionsFor(client), { messages: exchange() });
    expect(outcome).toEqual({
      ok: false,
      code: 'unusable_reply',
      message: 'the model returned no usable title',
    });
  });

  it('is bounded: a reply past the cap and a stream that never answers both fail', async () => {
    const oversized = streamClient('t'.repeat(2_000));
    expect(
      await suggestConversationTitle(
        optionsFor(oversized.client, { replyCapBytes: 512 }),
        { messages: exchange() },
      ),
    ).toMatchObject({ ok: false, code: 'reply_too_large' });

    const hanging = streamClient('');
    const outcome = await suggestConversationTitle(
      optionsFor(silentClient(), { timeoutMs: 5, now: () => 0 }),
      { messages: exchange() },
    );
    expect(outcome).toMatchObject({ ok: false, code: 'timeout' });
    expect(hanging.client).toBeDefined();
  });

  it('has nothing to name in an empty conversation', async () => {
    const { client, requests } = streamClient('whatever');
    const outcome = await suggestConversationTitle(optionsFor(client), { messages: [] });
    expect(outcome).toEqual({
      ok: false,
      code: 'no_context',
      message: 'this conversation has nothing to name yet',
    });
    expect(requests).toHaveLength(0);
  });
});

describe('createTitleSuggester', () => {
  it('is the hook the route takes', async () => {
    const { client } = streamClient('Key rotation');
    const suggester = createTitleSuggester(optionsFor(client));
    await expect(suggester.suggest({ messages: exchange() })).resolves.toMatchObject({
      ok: true,
      title: 'Key rotation',
    });
  });
});
