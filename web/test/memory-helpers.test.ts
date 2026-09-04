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
  isEntryInUse,
  kindLabel,
  kindTone,
  scopedLabel,
  sortEpisodes,
  statusLabel,
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
    personaScope: null,
    createdAt: 100,
    updatedAt: 200,
    ...overrides,
  };
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

  it('scopedLabel: null scope reads All personas, ids resolve to names', () => {
    const personas = [
      { id: 'p-1', name: 'Maya' },
      { id: 'p-2', name: 'Scribe' },
    ];
    expect(scopedLabel(null, personas)).toBe('All personas');
    expect(scopedLabel(null)).toBe('All personas');
    expect(scopedLabel('p-2', personas)).toBe('Scribe');
    expect(scopedLabel('p-gone', personas)).toBe('Removed persona');
  });
});

describe('in-use indicator', () => {
  it('isEntryInUse only flags confirmed GLOBAL entries', () => {
    expect(isEntryInUse(entry())).toBe(true);
    expect(isEntryInUse(entry({ status: 'suggested' }))).toBe(false);
    expect(isEntryInUse(entry({ status: 'rejected' }))).toBe(false);
    expect(isEntryInUse(entry({ personaScope: 'p-1' }))).toBe(false);
    expect(isEntryInUse(entry({ personaScope: 'p-1', status: 'confirmed' }))).toBe(false);
  });

  it('countEntriesInUse sums the flagged entries', () => {
    expect(
      countEntriesInUse([
        entry(),
        entry({ id: 'a', personaScope: 'p-1' }),
        entry({ id: 'b', status: 'suggested' }),
        entry({ id: 'c' }),
      ]),
    ).toBe(2);
    expect(countEntriesInUse([])).toBe(0);
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
