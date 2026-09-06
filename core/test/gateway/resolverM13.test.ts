/**
 * M13 resolver additions (PLAN-M13.md F1): an explicit per-turn provider pin
 * (`providerId`) wins over persona pinning and purpose routing so a chat
 * session can switch models between providers for one turn, and
 * `resolveImageTurnUpgrade` finds the best vision-capable model for a turn
 * that carries an image when the routed model cannot see.
 */
import { describe, expect, it } from 'vitest';
import type { Persona, ProviderSummary } from '@partner/shared';
import { resolveChatModel, resolveImageTurnUpgrade } from '../../src/gateway/resolver.js';

function provider(overrides: Partial<ProviderSummary> & { id: string }): ProviderSummary {
  return {
    name: overrides.id,
    kind: 'openai-compatible',
    source: 'manual',
    purpose: 'general',
    endpoint: `https://${overrides.id}.example/v1`,
    defaultModels: [],
    enabled: true,
    budgetCents: null,
    createdAt: 1,
    updatedAt: 1,
    health: { ok: false, latencyMs: null, error: null, models: [], checkedAt: null },
    ...overrides,
  };
}

function persona(overrides: Partial<Persona> & { id: string }): Persona {
  const { model, ...rest } = overrides;
  const rawModel: Partial<Persona['model']> = model ?? {};
  const modelOut: Persona['model'] = { taskClasses: {}, ...rawModel };
  modelOut.taskClasses = { ...(rawModel.taskClasses ?? {}) };
  return {
    name: overrides.id,
    tagline: undefined,
    avatar: undefined,
    colorTheme: undefined,
    character: { voice: 'warm', language: 'en', systemPrompt: '', temperature: 0.7 },
    model: modelOut,
    independence: { level: 'assist', requireHumanFor: ['high'] },
    memory: { userProfile: 'none', episodes: 'none' },
    isDefault: false,
    paused: false,
    createdAt: 1,
    updatedAt: 1,
    ...rest,
  };
}

const gpt = (id: string) => provider({ id, defaultModels: [id] });

describe('M13 explicit per-turn provider pin (resolveChatModel)', () => {
  it('providerId wins over the persona pin and purpose routing', () => {
    const pinned = gpt('prov-pinned');
    const vision = provider({ id: 'prov-vision', purpose: 'vision', defaultModels: ['v-model'] });
    const other = gpt('prov-other');
    const p = persona({
      id: 'p1',
      model: { taskClasses: { chat: 'pinned-chat' }, providerId: 'prov-pinned' },
    });
    const res = resolveChatModel({
      persona: p,
      requestedModel: 'gpt-4o-x',
      providerId: 'prov-other',
      providers: [pinned, vision, other],
      taskClass: 'vision',
    });
    expect(res.provider?.id).toBe('prov-other');
    expect(res.model).toBe('gpt-4o-x');
  });

  it('providerId with no requested model uses the persona mapping on that provider', () => {
    const a = gpt('prov-a');
    const b = gpt('prov-b');
    const p = persona({ id: 'p1', model: { taskClasses: { chat: 'chat-m' } } });
    const res = resolveChatModel({ persona: p, providerId: 'prov-b', providers: [a, b] });
    expect(res.provider?.id).toBe('prov-b');
    expect(res.model).toBe('chat-m');
  });

  it('a disabled explicit provider is ignored (falls back like a ghost pin)', () => {
    const on = gpt('prov-on');
    const off = provider({ id: 'prov-off', enabled: false, defaultModels: ['m'] });
    const res = resolveChatModel({ providerId: 'prov-off', requestedModel: 'x', providers: [off, on] });
    expect(res.provider?.id).toBe('prov-on');
    expect(res.model).toBe('x');
  });
});

describe('resolveImageTurnUpgrade', () => {
  it('uses the persona vision task-class mapping when it can see', () => {
    const general = gpt('prov-general');
    const vision = provider({ id: 'prov-vision', purpose: 'vision', defaultModels: ['gpt-4o'] });
    const p = persona({
      id: 'p1',
      model: { taskClasses: { vision: 'my-vision-200k' } },
    });
    const up = resolveImageTurnUpgrade({ persona: p, providers: [general, vision] });
    expect(up?.provider.id).toBe('prov-vision');
    expect(up?.model).toBe('my-vision-200k');
  });

  it('falls back to the vision-purpose provider default when the persona has no vision mapping', () => {
    const general = provider({ id: 'prov-general', defaultModels: ['llama-3.1-8b'] });
    const vision = provider({ id: 'prov-vision', purpose: 'vision', defaultModels: ['gpt-4o'] });
    const up = resolveImageTurnUpgrade({ providers: [general, vision] });
    expect(up?.provider.id).toBe('prov-vision');
    expect(up?.model).toBe('gpt-4o');
  });

  it('prefers the persona pinned provider before a vision-purpose provider', () => {
    const pinned = provider({ id: 'prov-pinned', defaultModels: ['gpt-4.1-mini'] });
    const vision = provider({ id: 'prov-vision', purpose: 'vision', defaultModels: ['gpt-4o'] });
    const p = persona({ id: 'p1', model: { taskClasses: {}, providerId: 'prov-pinned' } });
    const up = resolveImageTurnUpgrade({ persona: p, providers: [vision, pinned] });
    expect(up?.provider.id).toBe('prov-pinned');
    expect(up?.model).toBe('gpt-4.1-mini');
  });

  it('skips a non-capable persona vision mapping but still finds a capable default elsewhere', () => {
    const general = provider({ id: 'prov-general', defaultModels: ['llama-3.1-8b'] });
    const vision = provider({ id: 'prov-vision', purpose: 'vision', defaultModels: ['gpt-4o'] });
    const p = persona({ id: 'p1', model: { taskClasses: { vision: 'text-only-here' } } });
    const up = resolveImageTurnUpgrade({ persona: p, providers: [general, vision] });
    expect(up?.provider.id).toBe('prov-vision');
    expect(up?.model).toBe('gpt-4o');
  });

  it('returns null when nothing enabled can see images', () => {
    const general = provider({ id: 'prov-general', defaultModels: ['llama-3.1-8b'] });
    const p = persona({ id: 'p1', model: { taskClasses: { vision: 'text-model' } } });
    expect(resolveImageTurnUpgrade({ persona: p, providers: [general] })).toBeNull();
    expect(resolveImageTurnUpgrade({ providers: [] })).toBeNull();
    expect(resolveImageTurnUpgrade({ providers: [provider({ id: 'off', enabled: false, defaultModels: ['gpt-4o'] })] })).toBeNull();
  });
});
