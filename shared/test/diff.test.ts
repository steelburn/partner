import { describe, expect, it } from 'vitest';
import { diffLines, splitLines } from '../src/diff.js';

describe('splitLines', () => {
  it('splits and drops one trailing empty segment', () => {
    expect(splitLines('a\nb\n')).toEqual(['a', 'b']);
    expect(splitLines('')).toEqual([]);
    expect(splitLines('a\n\nb')).toEqual(['a', '', 'b']);
  });
});

describe('diffLines', () => {
  function plain(runs: ReturnType<typeof diffLines>): string {
    return runs.map((r) => `${r.type}:${r.text}`).join('\n');
  }

  it('is empty for identical input', () => {
    expect(diffLines('same\nbody\n', 'same\nbody\n')).toEqual([]);
  });

  it('detects a single added line', () => {
    const runs = diffLines('a\nb\n', 'a\nx\nb\n');
    expect(plain(runs)).toContain('add:x');
    expect(plain(runs)).toContain('same:a');
    expect(plain(runs)).toContain('same:b');
  });

  it('detects a single removed line', () => {
    const runs = diffLines('a\nx\nb\n', 'a\nb\n');
    expect(plain(runs)).toContain('remove:x');
  });

  it('represents replacement as remove then add', () => {
    const runs = diffLines('a\nold\nb\n', 'a\nnew\nb\n');
    const idx = plain(runs);
    const removeAt = idx.indexOf('remove:old');
    const addAt = idx.indexOf('add:new');
    expect(removeAt).toBeGreaterThanOrEqual(0);
    expect(addAt).toBeGreaterThan(removeAt);
  });

  it('merges adjacent runs of the same kind', () => {
    const runs = diffLines('one\ntwo\nthree\n', '1\n2\n3\n');
    expect(runs.filter((r) => r.type === 'remove')).toHaveLength(1);
    expect(runs.filter((r) => r.type === 'add')).toHaveLength(1);
  });

  it('handles a fully new file', () => {
    const runs = diffLines('', 'hello\nworld\n');
    expect(runs).toEqual([
      { type: 'add', text: 'hello\nworld' },
    ]);
  });

  it('handles a fully deleted file', () => {
    const runs = diffLines('hello\nworld\n', '');
    expect(runs).toEqual([
      { type: 'remove', text: 'hello\nworld' },
    ]);
  });

  it('keeps large common prefixes/suffixes as same runs', () => {
    const before = ['# Title', '', 'intro', '', 'old line', '', 'footer'].join('\n') + '\n';
    const after = ['# Title', '', 'intro', '', 'new line', '', 'footer'].join('\n') + '\n';
    const runs = diffLines(before, after);
    const sameText = runs.filter((r) => r.type === 'same').map((r) => r.text).join('\n');
    expect(sameText).toContain('# Title');
    expect(sameText).toContain('footer');
  });

  it('survives very large inputs via the coarse fallback', () => {
    const big = Array.from({ length: 3000 }, (_, i) => `line ${i}`).join('\n');
    const runs = diffLines('', big);
    expect(runs.some((r) => r.type === 'add' && r.text.length > 1000)).toBe(true);
    const removed = diffLines(big, '');
    expect(removed.some((r) => r.type === 'remove')).toBe(true);
  });
});
