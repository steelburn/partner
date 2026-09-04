import { describe, expect, it } from 'vitest';
import {
  RISK_LABELS,
  computeLineDiff,
  formatFileSize,
  formatWhen,
  parseListResult,
  parseProposalId,
  parseReadResult,
  parseSearchResult,
  pendingLabel,
  resolveOutcome,
  riskOf,
  summarizeTool,
  validateRootLabel,
  validateRootPath,
} from '../src/lib/roots.js';

describe('summarizeTool + risk tiers', () => {
  it('labels the six tools and maps their risk tiers', () => {
    expect(summarizeTool('files.list')).toEqual({ label: 'List directory', risk: 'low' });
    expect(summarizeTool('files.read').risk).toBe('low');
    expect(summarizeTool('files.search').risk).toBe('low');
    expect(summarizeTool('files.edit')).toEqual({ label: 'Propose edit', risk: 'medium' });
    expect(summarizeTool('files.apply').risk).toBe('high');
    expect(summarizeTool('files.delete').risk).toBe('high');
    expect(riskOf('files.edit')).toBe('medium');
    expect(RISK_LABELS.low).toBe('Low');
    expect(RISK_LABELS.high).toBe('High');
  });
});

describe('pendingLabel (params summary — never content)', () => {
  it('summarizes the relative path for path tools', () => {
    expect(pendingLabel('files.read', { projectId: 'r-1', path: 'src/a.ts' })).toBe('src/a.ts');
    expect(pendingLabel('files.list', { projectId: 'r-1', path: 'docs' })).toBe('docs');
  });

  it('maps "." and missing paths to "project root"', () => {
    expect(pendingLabel('files.list', { projectId: 'r-1', path: '.' })).toBe('project root');
    expect(pendingLabel('files.read', { projectId: 'r-1' })).toBe('project root');
  });

  it('never includes proposed content or search terms', () => {
    const edit = pendingLabel('files.edit', {
      projectId: 'r-1',
      path: 'a.txt',
      proposedContent: 'SECRET-CONTENT-BODY',
    });
    expect(edit).toBe('a.txt');
    expect(edit).not.toContain('SECRET');

    const search = pendingLabel('files.search', {
      projectId: 'r-1',
      path: 'src',
      query: 'sk-very-secret-token',
    });
    expect(search).toBe('src · content search');
    expect(search).not.toContain('sk-very');
    expect(search).not.toContain('token');
  });

  it('marks content search and hides its query in the whole-root case', () => {
    expect(pendingLabel('files.search', { projectId: 'r-1', query: 'needle' })).toBe(
      'project root · content search',
    );
  });

  it('summarizes apply by its proposal id and prefixes a project label', () => {
    expect(pendingLabel('files.apply', { projectId: 'r-1', proposalId: 'p-abc' })).toBe(
      'proposal p-abc',
    );
    expect(
      pendingLabel('files.read', { projectId: 'r-1', path: 'x/y.md' }, { projectLabel: 'Docs' }),
    ).toBe('Docs · x/y.md');
  });

  it('caps very long summaries', () => {
    const long = pendingLabel('files.read', { path: 'a'.repeat(300) });
    expect(long.length).toBeLessThanOrEqual(141);
    expect(long.endsWith('…')).toBe(true);
  });
});

describe('resolveOutcome', () => {
  it('maps every broker decision to copy', () => {
    expect(resolveOutcome({ outcome: 'executed', result: {} }).tone).toBe('executed');
    const waiting = resolveOutcome({ outcome: 'needs_approval', pendingId: 'p-1' });
    expect(waiting.tone).toBe('waiting');
    expect(waiting.message).toContain('Waiting for approval');
    const denied = resolveOutcome({ outcome: 'denied', reason: 'no grant for this scope' });
    expect(denied.tone).toBe('denied');
    expect(denied.message).toContain('no grant for this scope');
  });
});

describe('root form validation', () => {
  it('requires a label', () => {
    expect(validateRootLabel('')).not.toBeNull();
    expect(validateRootLabel('   ')).not.toBeNull();
    expect(validateRootLabel('My app')).toBeNull();
  });

  it('requires an absolute path', () => {
    expect(validateRootPath('')).toContain('required');
    expect(validateRootPath('relative/dir')).toContain('absolute');
    expect(validateRootPath('/home/me/projects')).toBeNull();
    expect(validateRootPath('  /tmp/x  ')).toBeNull();
  });
});

describe('computeLineDiff', () => {
  it('reports unchanged content as all same rows', () => {
    const diff = computeLineDiff('a\nb\nc', 'a\nb\nc');
    expect(diff.added).toBe(0);
    expect(diff.removed).toBe(0);
    expect(diff.rows.map((row) => row.type)).toEqual(['same', 'same', 'same']);
    expect(diff.truncated).toBe(false);
  });

  it('lists added and removed lines with counts (single hunks)', () => {
    const diff = computeLineDiff('a\nb\nc', 'a\nX\nb\nc');
    expect(diff.added).toBe(1);
    expect(diff.removed).toBe(0);
    expect(diff.rows.map((row) => row.text)).toEqual(['a', 'X', 'b', 'c']);
    expect(diff.rows[1]).toEqual({ type: 'add', text: 'X' });
  });

  it('diff-summary counts multi-hunk changes with ordering', () => {
    const diff = computeLineDiff(
      'keep\nold-one\nkeep2\nold-two\nend',
      'keep\nnew-one\nkeep2\nend',
    );
    expect(diff.added).toBe(1);
    expect(diff.removed).toBe(2);
    expect(diff.rows.map((row) => row.type)).toEqual([
      'same',
      'remove',
      'add',
      'same',
      'remove',
      'same',
    ]);
    expect(diff.rows.map((row) => row.text)).toEqual([
      'keep',
      'old-one',
      'new-one',
      'keep2',
      'old-two',
      'end',
    ]);
  });

  it('treats a full replacement as all removes then adds', () => {
    const diff = computeLineDiff('one\ntwo', 'drei');
    expect(diff.added).toBe(1);
    expect(diff.removed).toBe(2);
    expect(diff.rows.map((row) => row.type)).toEqual(['remove', 'remove', 'add']);
  });

  it('ignores a trailing newline when lines are otherwise equal', () => {
    const diff = computeLineDiff('x\ny\n', 'x\ny');
    expect(diff.added).toBe(0);
    expect(diff.removed).toBe(0);
  });

  it('truncates oversized inputs and marks the diff truncated', () => {
    const big = Array.from({ length: 500 }, (_, i) => `line-${i}`).join('\n');
    const diff = computeLineDiff(big, big + '\nmore');
    expect(diff.truncated).toBe(true);
    expect(diff.rows.length).toBeLessThanOrEqual(801);
  });
});

describe('tool-result parsing (tolerant envelopes)', () => {
  it('parses list results from entries / files / names', () => {
    const entries = parseListResult({
      entries: [
        { name: 'a.ts', kind: 'file', size: 3, mtime: 1 },
        { name: 'lib', path: 'lib', kind: 'dir' },
      ],
    });
    expect(entries).toHaveLength(2);
    expect(entries?.[0]?.size).toBe(3);
    expect(entries?.[1]?.kind).toBe('dir');
    expect(parseListResult({ files: ['x.txt'] })).toEqual([
      { name: 'x.txt', path: 'x.txt', kind: 'file', size: null, mtime: null },
    ]);
    expect(parseListResult({ items: [] })).toBeNull();
  });

  it('parses read results with the truncation flag', () => {
    expect(parseReadResult({ content: 'hello' })).toEqual({
      content: 'hello',
      truncated: false,
    });
    expect(parseReadResult({ text: 'x', truncated: true })).toEqual({
      content: 'x',
      truncated: true,
    });
    expect(parseReadResult({ size: 3 })).toBeNull();
  });

  it('parses search hits from hits / matches envelopes', () => {
    expect(
      parseSearchResult({ hits: [{ path: 'a.ts', line: 4, text: 'const x' }] }),
    ).toEqual([{ path: 'a.ts', line: 4, text: 'const x' }]);
    expect(parseSearchResult({ matches: ['just a line'] })).toEqual([
      { path: '', line: null, text: 'just a line' },
    ]);
    expect(parseSearchResult({ results: [] })).toBeNull();
  });

  it('reads a proposal id out of common edit-result shapes', () => {
    expect(parseProposalId({ proposalId: 'p-1' })).toBe('p-1');
    expect(parseProposalId({ proposal: { id: 'p-2' } })).toBe('p-2');
    expect(parseProposalId({ id: 'p-3' })).toBe('p-3');
    expect(parseProposalId({ applied: true })).toBeNull();
  });
});

describe('formatting helpers', () => {
  it('formats file sizes and timestamps', () => {
    expect(formatFileSize(null)).toBe('—');
    expect(formatFileSize(512)).toBe('512 B');
    expect(formatFileSize(2048)).toBe('2.0 KB');
    expect(formatFileSize(5 * 1024 * 1024)).toBe('5.0 MB');
    expect(formatWhen(null)).toBe('—');
    expect(formatWhen(0)).toBe('—');
    expect(formatWhen(Date.now())).toMatch(/\d{2}:\d{2}/);
  });
});
