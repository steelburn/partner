import { describe, expect, it } from 'vitest';
import { extractCandidates } from '../src/lib/assets-extract.js';

describe('M11 F10 asset extraction candidates', () => {
  it('falls back to a whole-document candidate when nothing structured', () => {
    const candidates = extractCandidates('Plain summary text here.');
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.kind).toBe('document');
    expect(candidates[0]?.title).toBe('Saved response');
  });

  it('uses the first heading as the document title', () => {
    const candidates = extractCandidates('## Migration plan\nDo the thing.');
    expect(candidates[0]?.title).toBe('Migration plan');
  });

  it('adds code fences and tables as extra candidates', () => {
    const text = 'Here:\n\n```ts\nconst x = 1;\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |';
    const candidates = extractCandidates(text);
    expect(candidates.length).toBeGreaterThanOrEqual(3);
    const code = candidates.find((c) => c.kind === 'code');
    expect(code?.body).toContain('const x = 1');
    expect(code?.body).toContain('```ts');
    const table = candidates.find((c) => c.kind === 'table');
    expect(table?.body).toContain('| a | b |');
  });

  it('explicit asset containers win over heuristics', () => {
    const text = 'prose\n\n:::partner.asset kind=decision title="Keep X"\nChosen because of Y.\n:::\n\n```js\nz()\n```';
    const candidates = extractCandidates(text);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.kind).toBe('decision');
    expect(candidates[0]?.title).toBe('Keep X');
    expect(candidates[0]?.body).toContain('Chosen because of Y');
  });
});
