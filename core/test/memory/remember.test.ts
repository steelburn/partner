/**
 * M19 automatic remember tests (PLAN-M19.md): the extractor's defensive
 * parser, secret filter, per-persona scoping + dedupe (rejected included),
 * demo/no-provider skips, and the content-free audit row. The provider
 * double mirrors the episode summarizer tests.
 */
import { describe, expect, it } from 'vitest';
import type {
  ChatEvent,
  ChatRequest,
  HealthReport,
  ProviderClient,
} from '@partner/shared';
import {
  createRememberManager,
  looksLikeSecret,
  parseRememberReply,
  REMEMBER_MAX_ITEMS,
  REMEMBER_SYSTEM_PROMPT,
} from '../../src/memory/remember.js';
import type { RememberTarget } from '../../src/memory/remember.js';
import { makeMemoryEnv } from './memEnv.js';
import type { MemoryTestEnv } from './memEnv.js';

function fakeProvider(reply: string): { target: RememberTarget; requests: ChatRequest[] } {
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
  return { target: { client, model: 'fake-model' }, requests };
}

function makeRemember(
  env: MemoryTestEnv,
  options: { demo?: boolean; target?: RememberTarget | null } = {},
) {
  return createRememberManager({
    profile: env.profile,
    audit: env.audit,
    demo: options.demo ?? false,
    providerResolver: () => options.target ?? null,
  });
}

describe('parseRememberReply', () => {
  it('parses a clean JSON array', () => {
    const parsed = parseRememberReply(
      '[{"kind":"identity","value":"Goes by Sam"},{"kind":"preference","value":"Wants TL;DR first","evidence":"asked twice"}]',
    );
    expect(parsed).toEqual([
      { kind: 'identity', value: 'Goes by Sam' },
      { kind: 'preference', value: 'Wants TL;DR first', evidence: 'asked twice' },
    ]);
  });

  it('strips markdown fences and surrounding prose', () => {
    const parsed = parseRememberReply(
      'Here you go:\n```json\n[{"kind":"rule","value":"Never use emoji"}]\n```\nDone.',
    );
    expect(parsed).toEqual([{ kind: 'rule', value: 'Never use emoji' }]);
  });

  it('drops malformed entries, unknown kinds and empty values', () => {
    const parsed = parseRememberReply(
      '[{"kind":"secret","value":"nope"},{"kind":"style","value":"   "},{"kind":"style","value":"Lowercase headers"},{"kind":"rule"}]',
    );
    expect(parsed).toEqual([{ kind: 'style', value: 'Lowercase headers' }]);
  });

  it('caps at the item limit and dedupes within the batch', () => {
    const items = Array.from({ length: 6 }, (_, i) => ({ kind: 'rule', value: `rule ${i}` }));
    items.push({ kind: 'rule', value: 'RULE 0' });
    const parsed = parseRememberReply(JSON.stringify(items));
    expect(parsed).toHaveLength(REMEMBER_MAX_ITEMS);
    expect(parsed.map((p) => p.value)).toEqual(['rule 0', 'rule 1', 'rule 2']);
  });

  it('returns [] for non-JSON / unterminated replies (never throws)', () => {
    expect(parseRememberReply('')).toEqual([]);
    expect(parseRememberReply('nothing to remember')).toEqual([]);
    expect(parseRememberReply('[{"kind":"rule","value":"x"}')).toEqual([]);
  });
});

describe('looksLikeSecret', () => {
  it('flags obvious credentials and payment data', () => {
    expect(looksLikeSecret('api key: sk-abcdefghijklmnop1234')).toBe(true);
    expect(looksLikeSecret('password: hunter2')).toBe(true);
    expect(looksLikeSecret('4111 1111 1111 1111')).toBe(true);
    expect(looksLikeSecret('a'.repeat(48))).toBe(true);
  });

  it('leaves ordinary facts alone', () => {
    expect(looksLikeSecret('prefers concise replies')).toBe(false);
    expect(looksLikeSecret('speaks German and English')).toBe(false);
  });
});

describe('remember manager (fake provider)', () => {
  it('files suggestions scoped to the persona and sends the fixed prompt', async () => {
    const fake = fakeProvider(
      '[{"kind":"identity","value":"Works as a backend engineer"},{"kind":"preference","value":"Prefers bullet lists","evidence":"used them throughout"}]',
    );
    const env = makeMemoryEnv();
    const remember = makeRemember(env, { target: fake.target });
    try {
      const outcome = await remember.extract({
        personaId: 'p-builder',
        userText: 'I am a backend engineer, please use bullets',
        assistantText: 'Noted.',
      });
      expect(outcome).toEqual({
        status: 'saved',
        suggested: 2,
        entryIds: expect.any(Array),
      });
      const entries = env.profile.list({ includeRejected: true });
      expect(entries).toHaveLength(2);
      expect(entries.every((e) => e.personaScope === 'p-builder')).toBe(true);
      expect(entries.every((e) => e.source === 'partner_suggestion')).toBe(true);
      expect(entries.every((e) => e.status === 'suggested')).toBe(true);

      // Fixed instruction first, transcript only as the payload.
      expect(fake.requests).toHaveLength(1);
      expect(fake.requests[0]?.messages[0]).toEqual({
        role: 'system',
        content: REMEMBER_SYSTEM_PROMPT,
      });
      expect(String(fake.requests[0]?.messages[1]?.content)).toContain('backend engineer');
      expect(REMEMBER_SYSTEM_PROMPT).not.toContain('backend engineer');
    } finally {
      env.close();
    }
  });

  it('dedupes against existing entries in the same scope, rejected included', async () => {
    const fake = fakeProvider(
      '[{"kind":"identity","value":"Works as a backend engineer"},{"kind":"preference","value":"Prefers bullet lists"},{"kind":"rule","value":"Rejected before"}]',
    );
    const env = makeMemoryEnv();
    const remember = makeRemember(env, { target: fake.target });
    try {
      env.profile.add({ kind: 'identity', value: 'works as a BACKEND engineer' });
      env.profile.add({ kind: 'rule', value: 'Rejected before', status: 'rejected' });
      const outcome = await remember.extract({
        personaId: 'p-builder',
        userText: 'anything',
        assistantText: 'ok',
      });
      expect(outcome).toMatchObject({ status: 'saved', suggested: 1 });
      const values = env.profile.list({ includeRejected: true }).map((e) => e.value);
      expect(values).toContain('Prefers bullet lists');
      expect(values).toHaveLength(3); // 2 seeded + 1 new
    } finally {
      env.close();
    }
  });

  it('scopes suggestions to the persona so another persona never sees them', async () => {
    const fake = fakeProvider('[{"kind":"preference","value":"Loves dark mode"}]');
    const env = makeMemoryEnv();
    const remember = makeRemember(env, { target: fake.target });
    try {
      await remember.extract({ personaId: 'p-studio', userText: 'x', assistantText: 'y' });
      const studio = env.profile.list().filter((e) => e.personaScope === 'p-studio');
      const builder = env.profile.list().filter((e) => e.personaScope === 'p-builder');
      expect(studio).toHaveLength(1);
      expect(builder).toHaveLength(0);
    } finally {
      env.close();
    }
  });

  it('filters out secret-looking candidates', async () => {
    const fake = fakeProvider(
      '[{"kind":"identity","value":"api key: sk-abcdefghijklmnop1234"},{"kind":"style","value":"Tabs over spaces"}]',
    );
    const env = makeMemoryEnv();
    const remember = makeRemember(env, { target: fake.target });
    try {
      const outcome = await remember.extract({ personaId: 'p-x', userText: 'a', assistantText: 'b' });
      expect(outcome).toMatchObject({ status: 'saved', suggested: 1 });
      expect(env.profile.list().map((e) => e.value)).toEqual(['Tabs over spaces']);
    } finally {
      env.close();
    }
  });

  it('skips demo mode and missing providers without calling anything', async () => {
    const fake = fakeProvider('[{"kind":"rule","value":"Never"}]');
    const env = makeMemoryEnv();
    try {
      const demo = makeRemember(env, { demo: true, target: fake.target });
      expect(await demo.extract({ personaId: 'p-x', userText: 'a', assistantText: 'b' })).toEqual({
        status: 'skipped',
        reason: 'demo',
      });
      const none = makeRemember(env, { target: null });
      expect(await none.extract({ personaId: 'p-x', userText: 'a', assistantText: 'b' })).toEqual({
        status: 'skipped',
        reason: 'no_provider',
      });
      expect(fake.requests).toHaveLength(0);
      expect(env.profile.list({ includeRejected: true })).toHaveLength(0);
    } finally {
      env.close();
    }
  });

  it('returns empty for "[]" replies and keeps audit content-free', async () => {
    const fake = fakeProvider('[]');
    const env = makeMemoryEnv();
    const remember = makeRemember(env, { target: fake.target });
    try {
      expect(await remember.extract({ personaId: 'p-x', userText: 'a', assistantText: 'b' })).toEqual({
        status: 'empty',
      });
      const rows = env.auditStore.list(50);
      expect(rows.some((r) => r.action === 'memory.remember')).toBe(false);
    } finally {
      env.close();
    }
  });

  it('returns error when the provider stream fails (never throws)', async () => {
    const client: ProviderClient = {
      async *chatStream(): AsyncGenerator<ChatEvent> {
        throw new Error('upstream down');
      },
      async health(): Promise<HealthReport> {
        return { ok: false, latencyMs: 0 };
      },
    };
    const env = makeMemoryEnv();
    const remember = makeRemember(env, { target: { client, model: 'fake' } });
    try {
      await expect(
        remember.extract({ personaId: 'p-x', userText: 'a', assistantText: 'b' }),
      ).resolves.toEqual({ status: 'error' });
    } finally {
      env.close();
    }
  });

  it('enqueue + idle: fire-and-forget work is awaited deterministically', async () => {
    const fake = fakeProvider('[{"kind":"preference","value":"Ships on Fridays"}]');
    const env = makeMemoryEnv();
    const remember = makeRemember(env, { target: fake.target });
    try {
      remember.enqueue({ personaId: 'p-x', userText: 'a', assistantText: 'b' });
      await remember.idle();
      expect(env.profile.list()).toHaveLength(1);
      // Idle with nothing in flight resolves immediately.
      await expect(remember.idle()).resolves.toBeUndefined();
      // The audit row never carries the fact text.
      const row = env.auditStore.list(50).find((r) => r.action === 'memory.remember');
      expect(row).toBeDefined();
      expect(JSON.stringify(row)).not.toContain('Ships on Fridays');
    } finally {
      env.close();
    }
  });
});
