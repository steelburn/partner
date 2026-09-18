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
  ProfileEntry,
  ProviderClient,
} from '@partner/shared';
import {
  createRememberManager,
  formatKnownBlock,
  formatRejectedBlock,
  looksLikeSecret,
  parseRememberReply,
  REMEMBER_KNOWN_HEADER,
  REMEMBER_KNOWN_MAX,
  REMEMBER_KNOWN_VALUE_CAP,
  REMEMBER_MAX_ITEMS,
  REMEMBER_REJECTED_HEADER,
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
  it('parses a clean JSON array (scope defaults to persona)', () => {
    const parsed = parseRememberReply(
      '[{"kind":"identity","value":"Goes by Sam"},{"kind":"preference","value":"Wants TL;DR first","evidence":"asked twice"}]',
    );
    expect(parsed).toEqual([
      { kind: 'identity', value: 'Goes by Sam', scope: 'persona' },
      { kind: 'preference', value: 'Wants TL;DR first', scope: 'persona', evidence: 'asked twice' },
    ]);
  });

  it('parses an explicit scope and defaults unknown scopes to persona', () => {
    const parsed = parseRememberReply(
      '[{"kind":"identity","value":"Lives in Berlin","scope":"global"},' +
        '{"kind":"rule","value":"Uses tabs","scope":"persona"},' +
        '{"kind":"style","value":"Lowercase headings","scope":"everywhere"}]',
    );
    expect(parsed.map((p) => [p.value, p.scope])).toEqual([
      ['Lives in Berlin', 'global'],
      ['Uses tabs', 'persona'],
      ['Lowercase headings', 'persona'],
    ]);
  });

  it('strips markdown fences and surrounding prose', () => {
    const parsed = parseRememberReply(
      'Here you go:\n```json\n[{"kind":"rule","value":"Never use emoji"}]\n```\nDone.',
    );
    expect(parsed).toEqual([{ kind: 'rule', value: 'Never use emoji', scope: 'persona' }]);
  });

  it('drops malformed entries, unknown kinds and empty values', () => {
    const parsed = parseRememberReply(
      '[{"kind":"secret","value":"nope"},{"kind":"style","value":"   "},{"kind":"style","value":"Lowercase headers"},{"kind":"rule"}]',
    );
    expect(parsed).toEqual([{ kind: 'style', value: 'Lowercase headers', scope: 'persona' }]);
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

describe('formatKnownBlock', () => {
  function entry(value: string): ProfileEntry {
    return {
      id: value,
      kind: 'rule',
      key: null,
      value,
      evidence: null,
      source: 'user',
      status: 'confirmed',
      personaScopes: [],
      createdAt: 0,
      updatedAt: 0,
    };
  }

  it('lists known facts behind the fixed header, collapsing whitespace', () => {
    const block = formatKnownBlock([entry('Lives in\n  Berlin'), entry('Lives in Berlin')]);
    expect(block).toBe(`${REMEMBER_KNOWN_HEADER}\n- Lives in Berlin`);
  });

  it('returns an empty string when nothing is known', () => {
    expect(formatKnownBlock([])).toBe('');
  });

  it('bounds the listing and each value', () => {
    const long = 'x'.repeat(REMEMBER_KNOWN_VALUE_CAP + 40);
    const entries = [entry(long)];
    for (let i = 0; i < REMEMBER_KNOWN_MAX + 5; i += 1) entries.push(entry(`rule ${i}`));
    const block = formatKnownBlock(entries);
    expect(block.split('\n')).toHaveLength(1 + REMEMBER_KNOWN_MAX);
    expect(block).not.toContain('x'.repeat(REMEMBER_KNOWN_VALUE_CAP + 1));
  });
});

describe('formatRejectedBlock', () => {
  function entry(value: string): ProfileEntry {
    return {
      id: value,
      kind: 'rule',
      key: null,
      value,
      evidence: null,
      source: 'user',
      status: 'rejected',
      personaScopes: [],
      createdAt: 0,
      updatedAt: 0,
    };
  }

  it('lists rejected facts behind its own header', () => {
    const block = formatRejectedBlock([entry('Declined once'), entry('Declined once')]);
    expect(block).toBe(`${REMEMBER_REJECTED_HEADER}\n- Declined once`);
  });

  it('returns an empty string when nothing has been rejected', () => {
    expect(formatRejectedBlock([])).toBe('');
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
  it('files persona-scoped suggestions and sends the fixed prompt', async () => {
    const fake = fakeProvider(
      '[{"kind":"identity","value":"Works as a backend engineer","scope":"persona"},{"kind":"preference","value":"Prefers bullet lists","scope":"persona","evidence":"used them throughout"}]',
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
      expect(entries.every((e) => e.personaScopes.join(',') === 'p-builder')).toBe(true);
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

  it('files global findings with an empty scope and persona findings scoped', async () => {
    const fake = fakeProvider(
      '[{"kind":"identity","value":"Lives in Berlin","scope":"global"},' +
        '{"kind":"rule","value":"Ship on Fridays","scope":"persona"},' +
        '{"kind":"identity","value":"Speaks German","scope":"global"}]',
    );
    const env = makeMemoryEnv();
    const remember = makeRemember(env, { target: fake.target });
    try {
      const outcome = await remember.extract({
        personaId: 'p-builder',
        userText: 'I live in Berlin',
        assistantText: 'Noted.',
      });
      expect(outcome).toMatchObject({ status: 'saved', suggested: 3 });
      const entries = env.profile.list({ includeRejected: true });
      const globals = entries.filter((e) => e.personaScopes.length === 0).map((e) => e.value);
      const scoped = entries
        .filter((e) => e.personaScopes.includes('p-builder'))
        .map((e) => e.value);
      expect(globals.sort()).toEqual(['Lives in Berlin', 'Speaks German']);
      expect(scoped).toEqual(['Ship on Fridays']);

      // Audit stays content-free and records the scope split as counts.
      const row = env.auditStore.list(50).find((r) => r.action === 'memory.remember');
      expect(row).toBeDefined();
      expect(JSON.stringify(row)).not.toContain('Berlin');
      const details = JSON.parse(row?.details ?? '{}') as Record<string, unknown>;
      expect(details).toMatchObject({ globals: 2, personaScoped: 1 });
    } finally {
      env.close();
    }
  });

  it('dedupes a global finding against an existing global entry', async () => {
    const fake = fakeProvider('[{"kind":"identity","value":"lives in BERLIN","scope":"global"}]');
    const env = makeMemoryEnv();
    const remember = makeRemember(env, { target: fake.target });
    try {
      env.profile.add({ kind: 'identity', value: 'Lives in Berlin' });
      const outcome = await remember.extract({
        personaId: 'p-builder',
        userText: 'x',
        assistantText: 'y',
      });
      expect(outcome).toEqual({ status: 'empty' });
      expect(env.profile.list()).toHaveLength(1);
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

  it('reviews existing memory and pending suggestions before suggesting', async () => {
    const fake = fakeProvider('[]');
    const env = makeMemoryEnv();
    const remember = makeRemember(env, { target: fake.target });
    try {
      env.profile.add({ kind: 'identity', value: 'Lives in Berlin' });
      env.profile.add({ kind: 'rule', value: 'Ships on Fridays', personaScopes: ['p-builder'] });
      env.profile.add({
        kind: 'preference',
        value: 'Prefers bullet lists',
        source: 'partner_suggestion',
      });
      env.profile.add({ kind: 'rule', value: 'Declined once', status: 'rejected' });
      env.profile.add({ kind: 'rule', value: 'Other persona secret', personaScopes: ['p-other'] });

      await remember.extract({ personaId: 'p-builder', userText: 'hi', assistantText: 'ok' });

      const payload = String(fake.requests[0]?.messages[1]?.content);
      expect(payload).toContain(REMEMBER_KNOWN_HEADER);
      // Confirmed global + this persona's own scoped entry + a pending suggestion.
      expect(payload).toContain('Lives in Berlin');
      expect(payload).toContain('Ships on Fridays');
      expect(payload).toContain('Prefers bullet lists');
      // Rejected facts ride a separate block so the model never re-asks them…
      expect(payload).toContain(REMEMBER_REJECTED_HEADER);
      expect(payload).toContain('Declined once');
      // …and another persona's memory never leaks (known or rejected).
      expect(payload).not.toContain('Other persona secret');
      // The rule lives in the fixed instruction; the listing never enters it.
      expect(String(fake.requests[0]?.messages[0]?.content)).toContain('already known');
      expect(String(fake.requests[0]?.messages[0]?.content)).toContain('REJECTED');
      expect(String(fake.requests[0]?.messages[0]?.content)).not.toContain('Lives in Berlin');
    } finally {
      env.close();
    }
  });

  it('omits the known block when nothing is remembered yet', async () => {
    const fake = fakeProvider('[]');
    const env = makeMemoryEnv();
    const remember = makeRemember(env, { target: fake.target });
    try {
      await remember.extract({ personaId: 'p-builder', userText: 'hi', assistantText: 'ok' });
      expect(String(fake.requests[0]?.messages[1]?.content)).not.toContain(REMEMBER_KNOWN_HEADER);
    } finally {
      env.close();
    }
  });

  it('never files a duplicate suggestion for a fact already pending review', async () => {
    const fake = fakeProvider('[{"kind":"preference","value":"Prefers bullet lists."}]');
    const env = makeMemoryEnv();
    const remember = makeRemember(env, { target: fake.target });
    try {
      env.profile.add({
        kind: 'preference',
        value: 'Prefers bullet lists',
        source: 'partner_suggestion',
      });
      const outcome = await remember.extract({
        personaId: 'p-builder',
        userText: 'x',
        assistantText: 'y',
      });
      expect(outcome).toEqual({ status: 'empty' });
      expect(env.profile.list({ includeRejected: true })).toHaveLength(1);
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
      const studio = env.profile.list().filter((e) => e.personaScopes.includes('p-studio'));
      const builder = env.profile.list().filter((e) => e.personaScopes.includes('p-builder'));
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

  it('falls back to the turn target when the resolver yields none', async () => {
    const fake = fakeProvider('[{"kind":"identity","value":"Lives in Berlin","scope":"global"}]');
    const env = makeMemoryEnv();
    // No resolver target — the manager must ride the turn's own target.
    const remember = makeRemember(env, { target: null });
    try {
      const outcome = await remember.extract({
        personaId: 'p-x',
        userText: 'I just moved to Berlin',
        assistantText: 'Noted.',
        fallbackTarget: fake.target,
      });
      expect(outcome).toMatchObject({ status: 'saved', suggested: 1 });
      expect(env.profile.list().map((e) => e.value)).toEqual(['Lives in Berlin']);
      expect(fake.requests).toHaveLength(1);
    } finally {
      env.close();
    }
  });

  it('falls back to the turn target when the resolver throws', async () => {
    const fake = fakeProvider('[{"kind":"rule","value":"Ship on Fridays"}]');
    const env = makeMemoryEnv();
    const remember = createRememberManager({
      profile: env.profile,
      audit: env.audit,
      demo: false,
      providerResolver: () => {
        throw new Error('keychain unavailable');
      },
    });
    try {
      const outcome = await remember.extract({
        personaId: 'p-x',
        userText: 'x',
        assistantText: 'y',
        fallbackTarget: fake.target,
      });
      expect(outcome).toMatchObject({ status: 'saved', suggested: 1 });
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

  it('filters findings by the per-turn policy (global vs persona consent)', async () => {
    const reply =
      '[{"kind":"identity","value":"Lives in Berlin","scope":"global"},{"kind":"preference","value":"Persona-only fact","scope":"persona"}]';

    // Global only: persona detection consent is off.
    const globalOnly = fakeProvider(reply);
    const envA = makeMemoryEnv();
    try {
      const remember = makeRemember(envA, { target: globalOnly.target });
      const outcome = await remember.extract({
        personaId: 'p-x',
        userText: 'x',
        assistantText: 'y',
        policy: { global: true, persona: false },
      });
      expect(outcome).toMatchObject({ status: 'saved', suggested: 1 });
      const entries = envA.profile.list();
      expect(entries.map((e) => e.value)).toEqual(['Lives in Berlin']);
      expect(entries[0]?.personaScopes).toEqual([]);
    } finally {
      envA.close();
    }

    // Persona only: global consent is off.
    const personaOnly = fakeProvider(reply);
    const envB = makeMemoryEnv();
    try {
      const remember = makeRemember(envB, { target: personaOnly.target });
      const outcome = await remember.extract({
        personaId: 'p-x',
        userText: 'x',
        assistantText: 'y',
        policy: { global: false, persona: true },
      });
      expect(outcome).toMatchObject({ status: 'saved', suggested: 1 });
      const entries = envB.profile.list();
      expect(entries.map((e) => e.value)).toEqual(['Persona-only fact']);
      expect(entries[0]?.personaScopes).toEqual(['p-x']);
    } finally {
      envB.close();
    }
  });

  it('skips entirely (no provider call) when both scopes are disallowed', async () => {
    const fake = fakeProvider('[{"kind":"rule","value":"Never"}]');
    const env = makeMemoryEnv();
    try {
      const remember = makeRemember(env, { target: fake.target });
      await expect(
        remember.extract({
          personaId: 'p-x',
          userText: 'x',
          assistantText: 'y',
          policy: { global: false, persona: false },
        }),
      ).resolves.toEqual({ status: 'skipped', reason: 'disabled' });
      expect(fake.requests).toHaveLength(0);
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
