/**
 * M3 resolver tests (PLAN-M3.md §"Resolver" + PLAN.md §4.2 fallback chain):
 * requestedModel wins; then persona.model.taskClasses[taskClass]; then
 * persona.model.fallback; then the first enabled provider's default model.
 * A persona's pinned provider (model.providerId) is used when enabled,
 * otherwise the first enabled provider; nothing configured -> typed
 * {provider: null, model: ''}. No persona = legacy provider-default routing.
 */
import { describe, expect, it } from 'vitest';
import type { Persona, ProviderSummary } from '@partner/shared';
import { resolveChatModel } from '../../src/gateway/resolver.js';

function provider(overrides: Partial<ProviderSummary> & { id: string }): ProviderSummary {
  return {
    name: overrides.id,
    kind: 'openai-compatible',
    source: 'manual',
    purpose: 'general',
    endpoint: `https://${overrides.id}.example/v1`,
    defaultModels: [],
    visionModels: [],
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

describe('resolveChatModel precedence', () => {
  it('requestedModel wins over every persona mapping', () => {
    const p = persona({
      id: 'p1',
      model: { taskClasses: { chat: 'persona-chat' }, fallback: 'persona-fallback', providerId: 'prov-a' },
    });
    const providers = [gpt('prov-a'), gpt('prov-b')];
    const res = resolveChatModel({ persona: p, requestedModel: 'gpt-requested', providers });
    expect(res).toEqual({ provider: providers[0], model: 'gpt-requested' });
  });

  it('taskClasses[taskClass] beats fallback, with the default task class chat', () => {
    const p = persona({
      id: 'p1',
      model: { taskClasses: { chat: 'chat-model', deep: 'deep-model' }, fallback: 'fallback-model' },
    });
    const providers = [gpt('prov-a')];
    // default taskClass = 'chat'
    expect(resolveChatModel({ persona: p, providers }).model).toBe('chat-model');
    expect(resolveChatModel({ persona: p, providers, taskClass: 'deep' }).model).toBe('deep-model');
    // coding is not mapped -> fallback.
    expect(resolveChatModel({ persona: p, providers, taskClass: 'coding' }).model).toBe(
      'fallback-model',
    );
  });

  it('provider default model when persona has no mapping', () => {
    const p = persona({ id: 'p1', model: { taskClasses: {} } });
    const providers = [gpt('prov-a')];
    const res = resolveChatModel({ persona: p, providers });
    expect(res.provider?.id).toBe('prov-a');
    expect(res.model).toBe('prov-a');
  });

  it('no persona -> legacy behaviour: first enabled provider default', () => {
    const providers = [gpt('prov-a'), gpt('prov-b')];
    const res = resolveChatModel({ providers });
    expect(res.provider?.id).toBe('prov-a');
    expect(res.model).toBe('prov-a');
    const withRequest = resolveChatModel({ providers, requestedModel: 'gpt-x' });
    expect(withRequest).toEqual({ provider: providers[0], model: 'gpt-x' });
  });

  it('nothing configured -> typed {provider: null, model: ""}', () => {
    expect(resolveChatModel({ providers: [] })).toEqual({ provider: null, model: '' });
    const p = persona({ id: 'p1', model: { taskClasses: { chat: 'x' } } });
    expect(resolveChatModel({ persona: p, providers: [] })).toEqual({ provider: null, model: '' });
    expect(
      resolveChatModel({ providers: [provider({ id: 'off', enabled: false })] }),
    ).toEqual({ provider: null, model: '' });
  });

  it('skips disabled providers entirely', () => {
    const off = provider({ id: 'off', enabled: false, defaultModels: ['off-model'] });
    const on = gpt('on-provider');
    const res = resolveChatModel({ providers: [off, on] });
    expect(res.provider?.id).toBe('on-provider');
    expect(res.model).toBe('on-provider');
  });
});

describe('persona provider pinning', () => {
  it('uses the pinned provider when it exists and is enabled', () => {
    const p = persona({ id: 'p1', model: { taskClasses: { chat: 'm1' }, providerId: 'prov-b' } });
    const providers = [gpt('prov-a'), gpt('prov-b')];
    const res = resolveChatModel({ persona: p, providers });
    expect(res.provider?.id).toBe('prov-b');
    expect(res.model).toBe('m1');
  });

  it('falls back to the first enabled provider when the pinned one is disabled', () => {
    const p = persona({ id: 'p1', model: { taskClasses: { chat: 'm1' }, providerId: 'prov-b' } });
    const providers = [gpt('prov-a'), provider({ id: 'prov-b', enabled: false })];
    const res = resolveChatModel({ persona: p, providers });
    expect(res.provider?.id).toBe('prov-a');
    expect(res.model).toBe('m1');
  });

  it('falls back to the first enabled provider when the pinned one is unknown', () => {
    const p = persona({ id: 'p1', model: { taskClasses: { chat: 'm1' }, providerId: 'ghost' } });
    const providers = [gpt('prov-a')];
    const res = resolveChatModel({ persona: p, providers });
    expect(res.provider?.id).toBe('prov-a');
    expect(res.model).toBe('m1');
  });

  it('requestedModel with a pinned persona rides the pinned provider', () => {
    const p = persona({ id: 'p1', model: { taskClasses: {}, providerId: 'prov-b' } });
    const providers = [gpt('prov-a'), gpt('prov-b')];
    const res = resolveChatModel({ persona: p, requestedModel: 'gpt-r', providers });
    expect(res.provider?.id).toBe('prov-b');
    expect(res.model).toBe('gpt-r');
  });
});

describe('M11 F4 purpose-based routing', () => {
  it('chat prefers a general provider over an earlier-created specialist', () => {
    const vision = provider({ id: 'prov-vision', purpose: 'vision', defaultModels: ['vision-m'] });
    const general = gpt('prov-general');
    // Created order: vision first — but chat wants general.
    const res = resolveChatModel({ providers: [vision, general] });
    expect(res.provider?.id).toBe('prov-general');
    expect(res.model).toBe('prov-general');
  });

  it('vision task class resolves to the vision provider when present', () => {
    const general = gpt('prov-general');
    const vision = provider({ id: 'prov-vision', purpose: 'vision', defaultModels: ['vision-m'] });
    const res = resolveChatModel({ providers: [general, vision], taskClass: 'vision' });
    expect(res.provider?.id).toBe('prov-vision');
    expect(res.model).toBe('vision-m');
  });

  it('coding falls back to general when no coding provider exists', () => {
    const general = gpt('prov-general');
    const vision = provider({ id: 'prov-vision', purpose: 'vision', defaultModels: ['v'] });
    const res = resolveChatModel({ providers: [vision, general], taskClass: 'coding' });
    expect(res.provider?.id).toBe('prov-general');
  });

  it('cheap beats deep beats general in a purpose-ordered preference', () => {
    const general = gpt('prov-general');
    const deep = provider({ id: 'prov-deep', purpose: 'deep', defaultModels: ['deep-m'] });
    const cheap = provider({ id: 'prov-cheap', purpose: 'cheap', defaultModels: ['cheap-m'] });
    const res = resolveChatModel({ providers: [general, deep, cheap], taskClass: 'cheap' });
    expect(res.provider?.id).toBe('prov-cheap');
    expect(res.model).toBe('cheap-m');
  });

  it('persona pinned provider still beats purpose routing', () => {
    const vision = provider({ id: 'prov-vision', purpose: 'vision', defaultModels: ['v'] });
    const general = gpt('prov-general');
    const p = persona({ id: 'p1', model: { taskClasses: { vision: 'm' }, providerId: 'prov-general' } });
    const res = resolveChatModel({ persona: p, providers: [vision, general], taskClass: 'vision' });
    expect(res.provider?.id).toBe('prov-general');
    expect(res.model).toBe('m');
  });

  it('persona model for a task rides the purpose-fit provider when unpinned', () => {
    const general = gpt('prov-general');
    const coding = provider({ id: 'prov-coding', purpose: 'coding', defaultModels: ['c'] });
    const p = persona({ id: 'p1', model: { taskClasses: { coding: 'coder-model' } } });
    const res = resolveChatModel({ persona: p, providers: [general, coding], taskClass: 'coding' });
    expect(res.provider?.id).toBe('prov-coding');
    expect(res.model).toBe('coder-model');
  });
});
