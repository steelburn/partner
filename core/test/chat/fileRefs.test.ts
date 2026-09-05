/**
 * M11 F1 file-reference tests (PLAN-M11.md).
 *
 * parseFileRefs extracts partner-file:// links; fileRefsExcerpt reads only
 * refs whose root has an ACTIVE files.read grant, caps each file and the
 * turn total, skips failures silently, and labels blocks with the root name.
 */
import { describe, expect, it } from 'vitest';
import { fileRefsExcerpt, parseFileRefs } from '../../src/chat/fileRefs.js';
import type { FileRefDeps } from '../../src/chat/fileRefs.js';

const GRANTED = 'root-a';
const DENIED = 'root-b';

function deps(over: Partial<FileRefDeps> = {}): FileRefDeps {
  return {
    hasReadGrant: (rootId) => rootId === GRANTED,
    read: () => ({ outcome: 'executed' as const, result: { content: 'file text here' } }),
    rootLabel: (rootId) => (rootId === GRANTED ? 'Alpha' : null),
    ...over,
  };
}

describe('M11 F1 parseFileRefs', () => {
  it('extracts refs with root + path and dedupes', () => {
    const text = '[see](partner-file://root-a/docs/a.md) and [other](partner-file://root-b/b.txt) and again [see](partner-file://root-a/docs/a.md)';
    const refs = parseFileRefs(text);
    expect(refs).toHaveLength(2);
    expect(refs[0]).toMatchObject({ rootId: 'root-a', path: 'docs/a.md', label: 'a.md' });
    expect(refs[1]).toMatchObject({ rootId: 'root-b', path: 'b.txt' });
  });

  it('ignores malformed or unencoded refs', () => {
    expect(parseFileRefs('plain text partner-file://')).toHaveLength(0);
  });
});

describe('M11 F1 fileRefsExcerpt', () => {
  it('reads only granted roots and labels the block', () => {
    const excerpt = fileRefsExcerpt(
      '[a](partner-file://root-a/docs/a.md) [b](partner-file://root-b/b.txt)',
      deps(),
    );
    expect(excerpt).toContain('[File reference: a.md (in Alpha)]');
    expect(excerpt).toContain('file text here');
    expect(excerpt).not.toContain('b.txt'); // denied root never read
  });

  it('skips reads that are not executed (missing/queued)', () => {
    const denied: FileRefDeps = deps({
      read: () => ({ outcome: 'needs_approval' as const, pendingId: 'p-1' }),
    });
    const excerpt = fileRefsExcerpt('[a](partner-file://root-a/x.md)', denied);
    expect(excerpt).toBe('');
  });

  it('returns empty for no refs or all-denied', () => {
    expect(fileRefsExcerpt('no links at all', deps())).toBe('');
    expect(fileRefsExcerpt('[b](partner-file://root-b/y.md)', deps())).toBe('');
  });

  it('caps total ref chars', () => {
    let calls = 0;
    const big: FileRefDeps = deps({
      read: () => {
        calls += 1;
        return { outcome: 'executed' as const, result: { content: 'x'.repeat(9000) } };
      },
    });
    const text = Array.from({ length: 4 }, (_, i) => `[f${i}](partner-file://root-a/f${i}.md)`).join(' ');
    const excerpt = fileRefsExcerpt(text, big);
    // Two 9k reads exceed the 18k cap; the third never happens.
    expect(calls).toBeLessThanOrEqual(3);
    expect(excerpt.length).toBeLessThanOrEqual(MAX_REF_TOTAL + 400);
  });
});

const MAX_REF_TOTAL = 18_000;
