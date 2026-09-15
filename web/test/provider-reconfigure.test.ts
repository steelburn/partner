/**
 * M25 — provider reconfiguration (web/src/lib/providers.ts).
 *
 * The feature: rediscover an EXISTING endpoint's models through the key the
 * keychain already holds, then reassign which models each purpose profile
 * carries. The logic that decides what the pane shows and what it writes back
 * is pure, so it is tested here; the component only renders it.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ProviderPurpose, ProviderSummary } from '@partner/shared';
import {
  endpointGroups,
  endpointHost,
  reconfigureChanges,
  reconfigureModelOptions,
  reconfigurePinsFor,
} from '../src/lib/providers.js';

function provider(
  overrides: Partial<ProviderSummary> & { id: string; purpose: ProviderPurpose },
): ProviderSummary {
  return {
    name: overrides.id,
    kind: 'openai-compatible',
    source: 'manual',
    endpoint: 'https://api.ne1.dev/v1',
    defaultModels: [],
    visionModels: [],
    enabled: true,
    budgetCents: null,
    createdAt: 1,
    updatedAt: 1,
    health: { ok: true, latencyMs: 1, error: null, models: [], checkedAt: 1 },
    ...overrides,
  };
}

describe('endpointHost', () => {
  it('returns host:port, and the raw string when it is not a URL', () => {
    expect(endpointHost('https://api.ne1.dev/v1')).toBe('api.ne1.dev');
    expect(endpointHost('http://127.0.0.1:4390/v1')).toBe('127.0.0.1:4390');
    expect(endpointHost('not a url')).toBe('not a url');
  });
});

describe('endpointGroups', () => {
  it('groups profiles by endpoint, preserving first-seen order', () => {
    const groups = endpointGroups([
      provider({ id: 'a', purpose: 'general' }),
      provider({ id: 'b', purpose: 'vision', endpoint: 'https://other.example/v1' }),
      provider({ id: 'c', purpose: 'coding' }),
    ]);
    expect(groups.map((g) => g.endpoint)).toEqual([
      'https://api.ne1.dev/v1',
      'https://other.example/v1',
    ]);
    expect(groups[0]?.host).toBe('api.ne1.dev');
    expect(groups[0]?.providers.map((p) => p.id)).toEqual(['a', 'c']);
    expect(groups[1]?.providers.map((p) => p.id)).toEqual(['b']);
  });

  it('returns nothing for no providers', () => {
    expect(endpointGroups([])).toEqual([]);
  });
});

describe('reconfigureModelOptions', () => {
  it('puts discovered models first and appends pinned-but-gone ids, deduped', () => {
    const profiles = [
      provider({ id: 'a', purpose: 'general', defaultModels: ['old-model', 'shared'] }),
      provider({ id: 'b', purpose: 'coding', defaultModels: ['shared'] }),
    ];
    expect(
      reconfigureModelOptions(['shared', 'new-model', 'shared'], profiles),
    ).toEqual(['shared', 'new-model', 'old-model']);
  });

  it('drops blank entries', () => {
    expect(reconfigureModelOptions(['  ', 'model'], [])).toEqual(['model']);
  });
});

describe('reconfigurePinsFor', () => {
  it('keeps a profile\u2019s current models, ordered by the option list', () => {
    const profile = provider({
      id: 'a',
      purpose: 'general',
      defaultModels: ['b-model', 'a-model'],
    });
    expect(reconfigurePinsFor(profile, ['a-model', 'b-model', 'c-model'])).toEqual([
      'a-model',
      'b-model',
    ]);
  });

  it('yields nothing when the profile pins nothing in the option list', () => {
    const profile = provider({ id: 'a', purpose: 'general', defaultModels: ['gone'] });
    expect(reconfigurePinsFor(profile, ['a-model'])).toEqual([]);
  });
});

describe('reconfigureChanges', () => {
  it('emits a PUT only for profiles whose ordered list actually changed', () => {
    const profiles = [
      provider({ id: 'a', purpose: 'general', defaultModels: ['m1', 'm2'] }),
      provider({ id: 'b', purpose: 'coding', defaultModels: ['m1'] }),
    ];
    expect(
      reconfigureChanges(profiles, { a: ['m1', 'm2'], b: ['m1', 'm3'] }),
    ).toEqual([{ id: 'b', defaultModels: ['m1', 'm3'] }]);
  });

  it('treats a reordered list as a change (order picks the default)', () => {
    const profiles = [provider({ id: 'a', purpose: 'general', defaultModels: ['m1', 'm2'] })];
    expect(reconfigureChanges(profiles, { a: ['m2', 'm1'] })).toEqual([
      { id: 'a', defaultModels: ['m2', 'm1'] },
    ]);
  });

  it('a vision profile carries its pins as the M24 declaration; others do not', () => {
    const profiles = [
      provider({ id: 'v', purpose: 'vision', defaultModels: ['m1'] }),
      provider({ id: 'g', purpose: 'general', defaultModels: ['m1'] }),
    ];
    expect(
      reconfigureChanges(profiles, { v: ['m1', 'm2'], g: ['m1', 'm2'] }),
    ).toEqual([
      { id: 'v', defaultModels: ['m1', 'm2'], visionModels: ['m1', 'm2'] },
      { id: 'g', defaultModels: ['m1', 'm2'] },
    ]);
  });

  it('ignores profiles the pane did not assign', () => {
    const profiles = [provider({ id: 'a', purpose: 'general', defaultModels: ['m1'] })];
    expect(reconfigureChanges(profiles, {})).toEqual([]);
  });
});

/**
 * No component render harness exists (node vitest), so the wiring and the
 * secrets policy are pinned as source guards — the reconfigure pane must use
 * the STORED key and must never grow a key field of its own.
 */
describe('ProvidersView reconfigure wiring (source guard)', () => {
  const source = readFileSync(
    join(fileURLToPath(new URL('../src/ProvidersView.tsx', import.meta.url))),
    'utf8',
  );

  it('offers a Reconfigure existing mode and discovers through the stored key', () => {
    expect(source).toContain('Reconfigure existing');
    expect(source).toContain('listProviderModels');
    expect(source).toContain('ReconfigurePane');
  });

  it('never asks for a key inside the reconfigure pane', () => {
    const pane = source.slice(source.indexOf('function ReconfigurePane'));
    expect(pane).not.toContain('type="password"');
    expect(pane).not.toContain('setProviderKey');
    expect(pane).toContain('updateProvider');
  });
});
