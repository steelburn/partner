import { describe, expect, it } from 'vitest';
import type {
  EpisodeSummary,
  MemoryExportBundle,
  ProfileEntry,
} from '@partner/shared';
import {
  KIND_LABELS,
  MEMORY_BUNDLE_FILE,
  bundleToFile,
  clampText,
  countEntriesInUse,
  dateValueToForgetIso,
  episodeTitle,
  isAutoDetected,
  isEntryInUse,
  kindLabel,
  kindTone,
  removedScopes,
  sameScopes,
  scopedLabel,
  scopedSummary,
  scopesOf,
  sortEpisodes,
  statusLabel,
  toggleScope,
  validateBundle,
  validateBundleSize,
} from '../src/lib/memory-helpers.js';

function entry(overrides: Partial<ProfileEntry> = {}): ProfileEntry {
  return {
    id: 'pe-1',
    kind: 'preference',
    key: null,
    value: 'I prefer concise replies.',
    evidence: null,
    source: 'user',
    status: 'confirmed',
    personaScopes: [],
    createdAt: 100,
    updatedAt: 200,
    ...overrides,
  };
}

/**
 * A pre-M33 payload: it carries only the single `personaScope` field (the
 * array field is absent, not merely empty), which is what the core actually
 * sent before v24 and what a hand-written fixture looks like.
 */
function legacyPayload(fields: { personaScope: string | null }): ProfileEntry {
  const payload = { ...entry() } as unknown as Record<string, unknown>;
  delete payload.personaScopes;
  return { ...payload, ...fields } as unknown as ProfileEntry;
}

function episode(overrides: Partial<EpisodeSummary> = {}): EpisodeSummary {
  return {
    id: 'ep-1',
    conversationId: 'c-1',
    personaId: 'p-1',
    title: 'A title',
    summary: 'A summary.',
    model: 'gpt-4o-mini',
    createdAt: 100,
    updatedAt: 200,
    ...overrides,
  };
}

function bundle(overrides: Partial<MemoryExportBundle> = {}): MemoryExportBundle {
  return {
    schema: 'memory/v1',
    exportedAt: 500,
    profile: [entry()],
    episodes: [episode()],
    ...overrides,
  };
}

describe('labels', () => {
  it('kindLabel maps every kind to a human label', () => {
    expect(kindLabel('preference')).toBe('Preference');
    expect(kindLabel('identity')).toBe('Identity');
    expect(kindLabel('rule')).toBe('Rule');
    expect(kindLabel('style')).toBe('Style');
    expect(KIND_LABELS).toMatchObject({
      preference: 'Preference',
      identity: 'Identity',
      rule: 'Rule',
      style: 'Style',
    });
  });

  it('kindTone: directive kinds get semantic tones, descriptive kinds stay neutral', () => {
    expect(kindTone('preference')).toBe('accent');
    expect(kindTone('rule')).toBe('danger');
    expect(kindTone('identity')).toBe('neutral');
    expect(kindTone('style')).toBe('neutral');
  });

  it('statusLabel maps every status', () => {
    expect(statusLabel('confirmed')).toBe('Confirmed');
    expect(statusLabel('suggested')).toBe('Suggested');
    expect(statusLabel('rejected')).toBe('Rejected');
  });

  it('scopedLabel: an empty scope reads All personas, ids resolve to names', () => {
    const personas = [
      { id: 'p-1', name: 'Maya' },
      { id: 'p-2', name: 'Scribe' },
    ];
    expect(scopedLabel([], personas)).toBe('All personas');
    expect(scopedLabel([])).toBe('All personas');
    expect(scopedLabel(['p-2'], personas)).toBe('Scribe');
    expect(scopedLabel(['p-gone'], personas)).toBe('Removed persona');
  });

  it('M33 scopedLabel + scopedSummary name one persona, count several', () => {
    const personas = [
      { id: 'p-1', name: 'Maya' },
      { id: 'p-2', name: 'Scribe' },
      { id: 'p-3', name: 'Builder' },
    ];
    // The full label lists every persona (tooltip / accessible name).
    expect(scopedLabel(['p-1', 'p-3'], personas)).toBe('Maya, Builder');
    // The row meta line stays short: one name, then a count.
    expect(scopedSummary([], personas)).toBe('All personas');
    expect(scopedSummary(['p-2'], personas)).toBe('Scribe');
    expect(scopedSummary(['p-1', 'p-3'], personas)).toBe('2 personas');
    expect(scopedSummary(['p-1', 'p-2', 'p-3'], personas)).toBe('3 personas');
  });

  it('M33 removedScopes names ids the local persona list no longer has', () => {
    const personas = [{ id: 'p-1', name: 'Maya' }];
    expect(removedScopes(['p-1'], personas)).toEqual([]);
    expect(removedScopes(['p-1', 'p-gone'], personas)).toEqual(['p-gone']);
    expect(removedScopes([], personas)).toEqual([]);
  });

  it('M33 toggleScope adds, removes, and stays order-stable', () => {
    expect(toggleScope([], 'p-1')).toEqual(['p-1']);
    expect(toggleScope(['p-1'], 'p-2')).toEqual(['p-1', 'p-2']);
    expect(toggleScope(['p-1', 'p-2'], 'p-1')).toEqual(['p-2']);
    // Unticking the last persona returns to the canonical All-personas set.
    expect(toggleScope(['p-1'], 'p-1')).toEqual([]);
  });

  it('M33 sameScopes compares as a set so a re-tick is not a write', () => {
    expect(sameScopes([], [])).toBe(true);
    expect(sameScopes(['p-1'], ['p-1'])).toBe(true);
    expect(sameScopes(['p-1', 'p-2'], ['p-2', 'p-1'])).toBe(true);
    expect(sameScopes(['p-1'], [])).toBe(false);
    expect(sameScopes(['p-1'], ['p-2'])).toBe(false);
    expect(sameScopes(['p-1', 'p-2'], ['p-1'])).toBe(false);
  });

  it('M33 scopesOf reads the array field and still understands the legacy one', () => {
    expect(scopesOf(entry({ personaScopes: ['p-1', 'p-2'] }))).toEqual(['p-1', 'p-2']);
    expect(scopesOf(entry({ personaScopes: [] }))).toEqual([]);
    // A pre-M33 payload (or a hand-built fixture) still scopes correctly.
    const legacy = legacyPayload({ personaScope: 'p-9' });
    expect(scopesOf(legacy)).toEqual(['p-9']);
    expect(scopesOf(legacyPayload({ personaScope: null }))).toEqual([]);
  });
});

describe('in-use indicator', () => {
  it('isEntryInUse only flags confirmed GLOBAL entries', () => {
    expect(isEntryInUse(entry())).toBe(true);
    expect(isEntryInUse(entry({ status: 'suggested' }))).toBe(false);
    expect(isEntryInUse(entry({ status: 'rejected' }))).toBe(false);
    expect(isEntryInUse(entry({ personaScopes: ['p-1'] }))).toBe(false);
    expect(isEntryInUse(entry({ personaScopes: ['p-1'], status: 'confirmed' }))).toBe(false);
  });

  it('countEntriesInUse sums the flagged entries', () => {
    expect(
      countEntriesInUse([
        entry(),
        entry({ id: 'a', personaScopes: ['p-1'] }),
        entry({ id: 'b', status: 'suggested' }),
        entry({ id: 'c' }),
      ]),
    ).toBe(2);
    expect(countEntriesInUse([])).toBe(0);
  });

  it('M19: scoped entries count as in use only for a persona with private memory on', () => {
    const entries = [
      entry({ id: 'g' }),
      entry({ id: 's', personaScopes: ['p-1'] }),
    ];
    const off = [{ id: 'p-1', name: 'Maya', memory: { personaMemory: 'off' as const } }];
    const on = [{ id: 'p-1', name: 'Maya', memory: { personaMemory: 'on' as const } }];

    expect(isEntryInUse(entries[1] as ProfileEntry, off)).toBe(false);
    expect(isEntryInUse(entries[1] as ProfileEntry, on)).toBe(true);
    expect(countEntriesInUse(entries, off)).toBe(1);
    expect(countEntriesInUse(entries, on)).toBe(2);
  });

  it('M33: a fact shared by several personas is honored by each of them', () => {
    const shared = entry({ id: 's', personaScopes: ['p-1', 'p-2'] });
    const mayaOn = [{ id: 'p-1', name: 'Maya', memory: { personaMemory: 'on' as const } }];
    const scribeOn = [{ id: 'p-2', name: 'Scribe', memory: { personaMemory: 'on' as const } }];
    const bothOff = [
      { id: 'p-1', name: 'Maya', memory: { personaMemory: 'off' as const } },
      { id: 'p-2', name: 'Scribe', memory: { personaMemory: 'off' as const } },
    ];
    const third = [{ id: 'p-3', name: 'Builder', memory: { personaMemory: 'on' as const } }];

    // Honored by ANY listed persona whose private memory is on…
    expect(isEntryInUse(shared, mayaOn)).toBe(true);
    expect(isEntryInUse(shared, scribeOn)).toBe(true);
    // …but not by an unlisted one, and not when every listed one is off.
    expect(isEntryInUse(shared, third)).toBe(false);
    expect(isEntryInUse(shared, bothOff)).toBe(false);
    expect(isEntryInUse(shared, [])).toBe(false);
  });
});

describe('provenance', () => {
  it('isAutoDetected flags partner suggestions only', () => {
    expect(isAutoDetected(entry())).toBe(false);
    expect(isAutoDetected(entry({ source: 'partner_suggestion', status: 'suggested' }))).toBe(true);
  });
});

describe('episode helpers', () => {
  it('sortEpisodes orders by updatedAt desc, then createdAt desc, then id', () => {
    const newest = episode({ id: 'a', updatedAt: 300 });
    const mid = episode({ id: 'b', updatedAt: 200, createdAt: 150 });
    const sameTs = episode({ id: 'c', updatedAt: 200, createdAt: 50 });
    const sorted = sortEpisodes([sameTs, newest, mid]);
    expect(sorted.map((e) => e.id)).toEqual(['a', 'b', 'c']);
    // Does not mutate the input.
    expect([sameTs, newest, mid].map((e) => e.id)).toEqual(['c', 'a', 'b']);
  });

  it('episodeTitle falls back for empty titles', () => {
    expect(episodeTitle(episode({ title: '  Real  ' }))).toBe('Real');
    expect(episodeTitle(episode({ title: null }))).toBe('Untitled conversation');
    expect(episodeTitle(episode({ title: '   ' }))).toBe('Untitled conversation');
  });

  it('clampText keeps short text and clamps long text to 220 chars', () => {
    const short = 'hello';
    expect(clampText(short)).toBe('hello');
    const long = 'x'.repeat(300);
    const clamped = clampText(long);
    expect(clamped.length).toBe(221); // 220 chars + ellipsis
    expect(clamped.endsWith('…')).toBe(true);
    expect(clampText(long, 10)).toBe('x'.repeat(10) + '…');
  });

  it('clampText never splits a surrogate pair', () => {
    const text = '😀'.repeat(300); // 300 code points, 600 UTF-16 units
    const clamped = clampText(text);
    // Every high surrogate must be followed by a low one (and vice versa):
    // no lone halves may survive the cut.
    for (let i = 0; i < clamped.length; i += 1) {
      const code = clamped.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = clamped.charCodeAt(i + 1);
        expect(next >= 0xdc00 && next <= 0xdfff).toBe(true);
        i += 1;
      } else if (code >= 0xdc00 && code <= 0xdfff) {
        throw new Error('stray low surrogate at ' + i);
      }
    }
    expect(Array.from(clamped).length).toBe(221);
  });
});

describe('bundle file payload', () => {
  it('bundleToFile returns the pretty JSON used for the download', () => {
    const text = bundleToFile(bundle());
    expect(text.endsWith('\n')).toBe(true);
    const parsed = JSON.parse(text) as MemoryExportBundle;
    expect(parsed).toEqual(bundle());
    expect(parsed.schema).toBe('memory/v1');
  });

  it('exposes the fixed download filename', () => {
    expect(MEMORY_BUNDLE_FILE).toBe('partner-memory.json');
  });
});

describe('validateBundle schema guard', () => {
  it('accepts a well-formed memory/v1 bundle', () => {
    expect(validateBundle(bundle())).toBeNull();
    expect(validateBundle(bundle({ profile: [], episodes: [] }))).toBeNull();
  });

  it('rejects non-objects and foreign files', () => {
    expect(validateBundle(null)).toMatch(/not a Partner memory file/i);
    expect(validateBundle('text')).toMatch(/not a Partner memory file/i);
    expect(validateBundle([bundle()])).toMatch(/not a Partner memory file/i);
    expect(validateBundle({ profile: [], episodes: [] })).toMatch(/memory\/v1/);
    expect(validateBundle({ schema: 'themes/v1', profile: [], episodes: [] })).toMatch(/memory\/v1/);
  });

  it('rejects bundles missing the lists', () => {
    expect(validateBundle({ schema: 'memory/v1' })).toMatch(/profile list/);
    expect(validateBundle({ schema: 'memory/v1', profile: [] })).toMatch(/episodes list/);
  });

  it('names the offending row index, never its content', () => {
    const badProfile = bundle({
      profile: [
        entry(),
        { ...entry({ id: 'pe-2' }), value: '' },
      ],
    });
    const profileError = validateBundle(badProfile);
    expect(profileError).toMatch(/profile\[1\]/);
    expect(profileError).not.toContain('pe-2');

    const badEpisode = bundle({ episodes: [{ ...episode({ id: 'ep-x' }), summary: '' }] });
    const episodeError = validateBundle(badEpisode);
    expect(episodeError).toMatch(/episodes\[0\]/);
    expect(episodeError).not.toContain('ep-x');

    expect(validateBundle(bundle({ profile: [null] }))).toMatch(/profile\[0\]/);
    expect(validateBundle(bundle({ episodes: [{ nope: 1 }] }))).toMatch(/episodes\[0\]/);
  });

  it('requires timestamps on rows', () => {
    expect(
      validateBundle(bundle({ profile: [{ ...entry(), createdAt: undefined }] })),
    ).toMatch(/profile\[0\].*timestamps/);
  });
});

describe('validateBundleSize', () => {
  it('rejects oversized files and accepts normal text', () => {
    expect(validateBundleSize('{"schema":"memory/v1"}')).toBeNull();
    expect(validateBundleSize('a'.repeat(20_000_001))).toMatch(/too large/);
  });
});

describe('dateValueToForgetIso', () => {
  it('converts a date value to local midnight of that day', () => {
    const iso = dateValueToForgetIso('2024-03-05');
    expect(iso).not.toBeNull();
    const date = new Date(iso as string);
    expect(date.getFullYear()).toBe(2024);
    expect(date.getMonth()).toBe(2); // March
    expect(date.getDate()).toBe(5);
    expect(date.getHours()).toBe(0);
    expect(date.getMinutes()).toBe(0);
  });

  it('returns null for malformed or impossible dates', () => {
    expect(dateValueToForgetIso('')).toBeNull();
    expect(dateValueToForgetIso('05-03-2024')).toBeNull();
    expect(dateValueToForgetIso('2024-13-01')).toBeNull();
    expect(dateValueToForgetIso('2023-02-31')).toBeNull();
    expect(dateValueToForgetIso('1969-12-31')).toBeNull();
    expect(dateValueToForgetIso('2024-1-5')).toBeNull();
  });
});
