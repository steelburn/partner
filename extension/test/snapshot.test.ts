import { describe, expect, it } from 'vitest';
import {
  MAX_BODY_TEXT,
  MAX_SELECTION_TEXT,
  buildSnapshot,
  truncateText,
} from '../src/lib/snapshot.js';

describe('truncateText', () => {
  it('keeps short text untouched', () => {
    expect(truncateText('short', 10_000)).toBe('short');
  });

  it('slices long text at the boundary (UTF-16 units)', () => {
    const long = 'x'.repeat(100_001);
    const out = truncateText(long, 100_000);
    expect(out.length).toBe(100_000);
    expect(out).toBe(long.slice(0, 100_000));
  });

  it('handles emoji (surrogate pairs) without throwing', () => {
    const long = '😀'.repeat(60_000); // 120_000 UTF-16 units
    const out = truncateText(long, 100_000);
    expect(out.length).toBe(100_000);
    expect(out).toBe(long.slice(0, 100_000)); // may end mid-pair; JSON/text encoders tolerate
  });
});

describe('buildSnapshot (pure; content.ts mirrors inline)', () => {
  it('builds url/title/origin and truncates body text to 100k', () => {
    const snap = buildSnapshot({
      url: 'https://example.com/a?q=1',
      title: 'Example — A',
      origin: 'https://example.com',
      selectionText: '  pick me  ',
      bodyText: 'body '.repeat(30_000), // 150_000 chars
    });
    expect(snap.url).toBe('https://example.com/a?q=1');
    expect(snap.title).toBe('Example — A');
    expect(snap.origin).toBe('https://example.com');
    expect(snap.text?.length).toBe(MAX_BODY_TEXT);
    expect(snap.text).toBe('body '.repeat(30_000).slice(0, MAX_BODY_TEXT));
  });

  it('trims the selection and truncates to 10k after trim', () => {
    const snap = buildSnapshot({
      url: 'u',
      title: 't',
      origin: 'o',
      selectionText: `   ${'s'.repeat(20_000)}   `,
      bodyText: 'text',
    });
    expect(snap.selection?.length).toBe(MAX_SELECTION_TEXT);
    expect(snap.selection).toBe('s'.repeat(10_000));
    expect(snap.selection?.startsWith('s')).toBe(true);
  });

  it('omits selection when blank/whitespace-only', () => {
    const snap = buildSnapshot({ url: 'u', title: 't', origin: 'o', selectionText: '   \n\t ', bodyText: 'text' });
    expect('selection' in snap).toBe(false);
    expect(snap.selection).toBeUndefined();
  });

  it('omits selection when absent', () => {
    const snap = buildSnapshot({ url: 'u', title: 't', origin: 'o', bodyText: 'text' });
    expect('selection' in snap).toBe(false);
  });

  it('omits text when the page has no body text', () => {
    const snap = buildSnapshot({ url: 'u', title: 't', origin: 'o', selectionText: 'sel' });
    expect('text' in snap).toBe(false);
    expect(snap.selection).toBe('sel');
  });

  it('keeps the full body when under the cap', () => {
    const bodyText = 'plain '.repeat(500);
    const snap = buildSnapshot({ url: 'u', title: 't', origin: 'o', bodyText });
    expect(snap.text).toBe(bodyText);
  });

  it('keeps unicode text intact when under the cap', () => {
    const bodyText = 'αβγ 😀 ✓ world '.repeat(100);
    const snap = buildSnapshot({ url: 'u', title: 't', origin: 'o', bodyText });
    expect(snap.text).toBe(bodyText);
  });
});
