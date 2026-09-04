/**
 * M4 episode manager tests (PLAN-M4.md §"Tests"): summarize with a fake
 * provider double (deterministic delta summary, mirroring gateway tests),
 * demo-mode placeholder, dedupe by conversation (resummarize UPDATES), unknown
 * conversation -> typed not_found, fixed prompt + windowed transcript, title
 * derivation, and audit rows with lengths/ids only — the summary and the
 * transcript never reach audit.
 */
import { describe, expect, it } from 'vitest';
import type {
  ChatEvent,
  ChatRequest,
  HealthReport,
  ProviderClient,
} from '@partner/shared';
import { MemoryError } from '../../src/memory/index.js';
import { SUMMARIZE_SYSTEM_PROMPT, demoEpisodeSummary } from '../../src/memory/episodes.js';
import type { SummarizeTarget } from '../../src/memory/episodes.js';
import { makeMemoryEnv } from './memEnv.js';
import type { MemoryTestEnv } from './memEnv.js';

/** Fake provider double: emits a deterministic delta summary (gateway-test
 *  pattern) and records the request it received. */
function fakeProvider(reply: string): { target: SummarizeTarget; requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  const client: ProviderClient = {
    async *chatStream(req: ChatRequest): AsyncGenerator<ChatEvent> {
      requests.push(req);
      yield { type: 'delta', text: reply };
      yield { type: 'usage', promptTokens: 5, completionTokens: 1, totalTokens: 6 };
      yield { type: 'done', model: 'fake-model', latencyMs: 2 };
    },
    async health(): Promise<HealthReport> {
      return { ok: true, latencyMs: 0 };
    },
  };
  return { target: { client, model: 'fake-model' }, requests };
}

async function summarizeFirst(env: MemoryTestEnv, conversationId: string) {
  return env.episodes.summarize(conversationId);
}

describe('episode manager — provider summarize (fake double)', () => {
  it('calls the fixed summarize prompt over the transcript and stores the delta as summary', async () => {
    const fake = fakeProvider('user wanted a standalone tldr generator script');
    const env = makeMemoryEnv({
      demo: false,
      providerResolver: (personaId) => (personaId === 'p-builder' ? fake.target : null),
    });
    try {
      const conv = env.conversations.create({ personaId: 'p-builder' });
      env.conversations.append(conv.id, 'user', { content: 'build me a tldr script' });
      env.conversations.append(conv.id, 'assistant', { content: 'here is the script' });

      const { episode, created } = await summarizeFirst(env, conv.id);
      expect(created).toBe(true);
      expect(episode).toMatchObject({
        conversationId: conv.id,
        personaId: 'p-builder',
        title: 'build me a tldr script',
        summary: 'user wanted a standalone tldr generator script',
        model: 'fake-model',
      });

      // The provider saw ONE request: a FIXED system prompt + transcript
      // content (roles/content only — no ids, no timestamps, no model junk).
      expect(fake.requests).toHaveLength(1);
      const sent = fake.requests[0];
      expect(sent?.model).toBe('fake-model');
      expect(sent?.messages[0]).toEqual({
        role: 'system',
        content: SUMMARIZE_SYSTEM_PROMPT,
      });
      expect(sent?.messages.slice(1)).toEqual([
        { role: 'user', content: 'build me a tldr script' },
        { role: 'assistant', content: 'here is the script' },
      ]);
      // The prompt text is FIXED — no user content inside it.
      expect(SUMMARIZE_SYSTEM_PROMPT).not.toContain('build me');
    } finally {
      env.close();
    }
  });

  it('windows the transcript to the last 30 messages', async () => {
    const fake = fakeProvider('windowed summary');
    const env = makeMemoryEnv({ demo: false, providerResolver: () => fake.target });
    try {
      const conv = env.conversations.create({});
      for (let i = 0; i < 40; i += 1) {
        env.conversations.append(conv.id, i % 2 === 0 ? 'user' : 'assistant', {
          content: `turn-${i}`,
        });
      }
      const { episode } = await summarizeFirst(env, conv.id);
      const sent = fake.requests[0];
      // 1 fixed prompt + the newest 30 of 40 transcript messages.
      expect(sent?.messages).toHaveLength(31);
      expect(sent?.messages[1]?.content).toBe('turn-10');
      expect(sent?.messages[sent.messages.length - 1]?.content).toBe('turn-39');
      expect(episode.summary).toBe('windowed summary');
    } finally {
      env.close();
    }
  });

  it('unknown conversation -> typed not_found', async () => {
    const env = makeMemoryEnv({ demo: false });
    try {
      try {
        await summarizeFirst(env, 'c-ghost');
        expect.unreachable('should throw');
      } catch (err) {
        expect(err).toBeInstanceOf(MemoryError);
        expect((err as MemoryError).code).toBe('not_found');
      }
    } finally {
      env.close();
    }
  });

  it('a provider stream error -> typed upstream', async () => {
    const failing: ProviderClient = {
      async *chatStream(): AsyncGenerator<ChatEvent> {
        yield { type: 'error', message: 'upstream request failed' };
      },
      async health(): Promise<HealthReport> {
        return { ok: false, latencyMs: 0, error: 'boom' };
      },
    };
    const env = makeMemoryEnv({
      demo: false,
      providerResolver: () => ({ client: failing, model: 'fake' }),
    });
    try {
      const conv = env.conversations.create({});
      env.conversations.append(conv.id, 'user', { content: 'hi' });
      try {
        await summarizeFirst(env, conv.id);
        expect.unreachable('should throw');
      } catch (err) {
        expect((err as MemoryError).code).toBe('upstream');
      }
      expect(env.episodes.list()).toHaveLength(0);
    } finally {
      env.close();
    }
  });
});

describe('episode manager — demo placeholder + dedupe', () => {
  it('demo mode writes the deterministic placeholder (never calls the provider)', async () => {
    let called = 0;
    const env = makeMemoryEnv({
      demo: true,
      providerResolver: () => {
        called += 1;
        return fakeProvider('SHOULD-NOT-APPEAR').target;
      },
    });
    try {
      const conv = env.conversations.create({});
      env.conversations.append(conv.id, 'user', { content: 'summarize this demo chat' });
      env.conversations.append(conv.id, 'assistant', { content: 'ok' });

      const { episode, created } = await summarizeFirst(env, conv.id);
      expect(created).toBe(true);
      expect(episode.summary).toBe(
        demoEpisodeSummary(env.conversations.get(conv.id).messages),
      );
      expect(episode.summary).toBe('Demo summary of 2 messages: summarize this demo chat');
      expect(episode.model).toBeNull();
      expect(called).toBe(0); // provider resolver never consulted in demo mode
    } finally {
      env.close();
    }
  });

  it('no provider (and not demo) also falls back to the deterministic placeholder', async () => {
    const env = makeMemoryEnv({ demo: false }); // resolver default returns null
    try {
      const conv = env.conversations.create({});
      env.conversations.append(conv.id, 'user', { content: 'plain chat' });
      const { episode } = await summarizeFirst(env, conv.id);
      expect(episode.summary).toBe('Demo summary of 1 messages: plain chat');
      expect(episode.model).toBeNull();
    } finally {
      env.close();
    }
  });

  it('dedupe: resummarizing the same conversation UPDATES the episode, no duplicates', async () => {
    const fake = fakeProvider('first summary');
    const env = makeMemoryEnv({ demo: false, providerResolver: () => fake.target });
    try {
      const conv = env.conversations.create({});
      env.conversations.append(conv.id, 'user', { content: 'first turn' });
      const first = await summarizeFirst(env, conv.id);
      expect(first.created).toBe(true);

      // More turns arrive; resummarize now.
      env.conversations.append(conv.id, 'user', { content: 'second turn adds detail' });
      fake.target.client = fakeProvider('updated summary covering both').target.client;
      const second = await summarizeFirst(env, conv.id);

      expect(second.created).toBe(false); // updated in place
      expect(second.episode.id).toBe(first.episode.id);
      expect(env.episodes.list()).toHaveLength(1);
      expect(second.episode.summary).toBe('updated summary covering both');
      // title follows the FIRST user message (transcript order).
      expect(second.episode.title).toBe('first turn');
    } finally {
      env.close();
    }
  });

  it('episode title falls back to the conversation title when no user message', async () => {
    const env = makeMemoryEnv({ demo: true });
    try {
      const conv = env.conversations.create({ title: 'My saved conversation' });
      env.conversations.append(conv.id, 'assistant', { content: 'only assistant text' });
      const { episode } = await summarizeFirst(env, conv.id);
      expect(episode.title).toBe('My saved conversation');
      expect(episode.summary).toBe('Demo summary of 1 messages: ');
    } finally {
      env.close();
    }
  });

  it('an empty conversation summarizes deterministically with no provider call', async () => {
    const fake = fakeProvider('NOPE');
    const env = makeMemoryEnv({ demo: false, providerResolver: () => fake.target });
    try {
      const conv = env.conversations.create({});
      const { episode } = await summarizeFirst(env, conv.id);
      expect(episode.summary).toBe('No messages to summarize yet.');
      expect(episode.model).toBeNull();
      expect(fake.requests).toHaveLength(0);
    } finally {
      env.close();
    }
  });

  it('remove() deletes the episode and its FTS row; unknown -> not_found', async () => {
    const env = makeMemoryEnv({ demo: true });
    try {
      const conv = env.conversations.create({});
      env.conversations.append(conv.id, 'user', { content: 'remember unique-topic-44' });
      const { episode } = await summarizeFirst(env, conv.id);
      expect(env.search.query('unique-topic-44').map((h) => h.refId)).toEqual([episode.id]);

      env.episodes.remove(episode.id);
      expect(env.episodes.get(episode.id)).toBeNull();
      expect(env.search.query('unique-topic-44')).toHaveLength(0);
      try {
        env.episodes.remove(episode.id);
        expect.unreachable('should throw');
      } catch (err) {
        expect((err as MemoryError).code).toBe('not_found');
      }
    } finally {
      env.close();
    }
  });
});

describe('episode manager — audit discipline', () => {
  it('episode.summarize audit rows carry ids/counts/lengths, NEVER content', async () => {
    const secretTurn = 'transcript-never-in-audit-needle';
    const secretSummary = 'summary-never-in-audit-needle';
    const env = makeMemoryEnv({ demo: false });
    try {
      // demo:false + resolver null -> placeholder summary that CONTAINS the
      // transcript text — perfect for proving audit never mirrors it.
      const conv = env.conversations.create({ personaId: 'p-scribe' });
      env.conversations.append(conv.id, 'user', { content: secretTurn });
      const { episode } = await summarizeFirst(env, conv.id);
      expect(episode.summary).toContain(secretTurn);

      // Give a real-summary audit row too (fake provider).
      const fakeEnv = makeMemoryEnv({
        demo: false,
        providerResolver: () => fakeProvider(secretSummary).target,
      });
      const conv2 = fakeEnv.conversations.create({ personaId: 'p-analyst' });
      fakeEnv.conversations.append(conv2.id, 'user', { content: 'x' });
      await fakeEnv.episodes.summarize(conv2.id);

      const blob = env.audit
        .list(100)
        .concat(fakeEnv.audit.list(100))
        .map((r) => JSON.stringify(r))
        .join('\n');
      expect(blob).not.toContain(secretTurn);
      expect(blob).not.toContain('Demo summary of');
      expect(blob).not.toContain(secretSummary);
      expect(blob).not.toContain('transcript-never');

      const envRows = env.audit.list(100).filter((r) => r.action === 'episode.summarize');
      expect(envRows).toHaveLength(1);
      expect(JSON.parse(envRows[0]?.details ?? '{}')).toMatchObject({
        conversationId: conv.id,
        personaId: 'p-scribe',
        messageCount: 1,
        created: true,
        model: null,
      });
      expect(JSON.parse(envRows[0]?.details ?? '{}')).toHaveProperty('summaryLength');
      fakeEnv.close();
    } finally {
      env.close();
    }
  });
});
