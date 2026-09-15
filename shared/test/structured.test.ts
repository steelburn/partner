import { describe, expect, it } from 'vitest';
import {
  findStructuredBlock,
  parseFenceAttrs,
  parseStructuredBlocks,
  type StructuredBlockHit,
} from '../src/structured.js';

describe('partner structured containers (C3)', () => {
  it('parses a closed single choice with a title + bullets', () => {
    const text = 'Which do you prefer?\n\n:::partner.choice mode=single\nPick one\n- Apples\n- Pears\n:::\n\nMore text.';
    const hit = findStructuredBlock(text);
    expect(hit).not.toBeNull();
    const { block, start, end } = hit as StructuredBlockHit;
    expect(block.kind).toBe('choice');
    if (block.kind === 'choice') {
      expect(block.mode).toBe('single');
      expect(block.title).toBe('Pick one');
      expect(block.options).toEqual(['Apples', 'Pears']);
    }
    expect(text.slice(start, end)).toContain(':::partner.choice');
    // Round trip through all blocks leaves the prose intact.
    const all = parseStructuredBlocks(text);
    expect(all).toHaveLength(1);
  });

  it('parses multi mode from attributes and tolerates an attribute run', () => {
    const text = ':::partner.choice mode=multi\n- a\n- b\n- c\n:::\n';
    const hit = findStructuredBlock(text);
    expect(hit?.block.kind).toBe('choice');
    if (hit?.block.kind === 'choice') {
      expect(hit.block.mode).toBe('multi');
      expect(hit.block.options).toEqual(['a', 'b', 'c']);
    }
  });

  it('does not materialize an unclosed block (streaming rule)', () => {
    const text = ':::partner.choice mode=single\n- a\n- b';
    expect(findStructuredBlock(text)).toBeNull();
  });

  it('ignores malformed containers (no options / unknown kind)', () => {
    expect(findStructuredBlock(':::partner.choice mode=single\njust prose\n:::')).toBeNull();
    expect(findStructuredBlock(':::partner.mystery\n- a\n:::')).toBeNull();
  });

  it('parses asset containers with a raw body (F10 grammar)', () => {
    const text = ':::partner.asset kind=code title="hello.ts"\nconst x = 1;\n:::\n';
    const hit = findStructuredBlock(text);
    expect(hit?.block.kind).toBe('asset');
    if (hit?.block.kind === 'asset') {
      expect(hit.block.assetKind).toBe('code');
      expect(hit.block.title).toBe('hello.ts');
      expect(hit.block.body).toBe('const x = 1;');
    }
  });

  it('normalizes the asset kind token (case/whitespace, never prose)', () => {
    const upper = findStructuredBlock(':::partner.asset kind=Code\nconst x = 1;\n:::');
    if (upper?.block.kind === 'asset') expect(upper.block.assetKind).toBe('code');
    const quoted = findStructuredBlock(':::partner.asset kind=" Decision "\nDone.\n:::');
    if (quoted?.block.kind === 'asset') expect(quoted.block.assetKind).toBe('decision');
    const missing = findStructuredBlock(':::partner.asset\nBody.\n:::');
    if (missing?.block.kind === 'asset') expect(missing.block.assetKind).toBe('custom');
    const blank = findStructuredBlock(':::partner.asset kind="  "\nBody.\n:::');
    if (blank?.block.kind === 'asset') expect(blank.block.assetKind).toBe('custom');
  });

  it('parses form containers with one question per bullet', () => {
    const text =
      'A couple of things:\n\n:::partner.form title="Kickoff"\n- What problem are you solving?\n- Who is the primary user?\n:::\n\nThanks.';
    const hit = findStructuredBlock(text);
    expect(hit?.block.kind).toBe('form');
    if (hit?.block.kind === 'form') {
      expect(hit.block.title).toBe('Kickoff');
      expect(hit.block.questions).toEqual([
        'What problem are you solving?',
        'Who is the primary user?',
      ]);
    }
    // The prose around the container survives the slice.
    expect(text.slice(0, hit?.start ?? 0)).toContain('A couple of things:');
    expect(text.slice(hit?.end ?? 0)).toContain('Thanks.');
  });

  it('takes a form title from the fence tail or body lead line', () => {
    const tail = findStructuredBlock(':::partner.form Kickoff questions\n- a?\n- b?\n::: ');
    if (tail?.block.kind === 'form') expect(tail.block.title).toBe('Kickoff questions');
    const lead = findStructuredBlock(':::partner.form\nKickoff questions\n- a?\n- b?\n::: ');
    if (lead?.block.kind === 'form') expect(lead.block.title).toBe('Kickoff questions');
  });

  it('ignores a form with no questions and one left unclosed', () => {
    expect(findStructuredBlock(':::partner.form title="x"\njust prose\n:::')).toBeNull();
    expect(findStructuredBlock(':::partner.form\n- a?\n- b?')).toBeNull();
  });

  it('multiple blocks are found left to right with correct offsets', () => {
    const text =
      'lead\n:::partner.choice\n- one\n:::\nmiddle\n:::partner.asset kind=code\nx();\n:::\ntail';
    const hits = parseStructuredBlocks(text);
    expect(hits).toHaveLength(2);
    expect(hits[0]?.block.kind).toBe('choice');
    expect(hits[1]?.block.kind).toBe('asset');
    expect(text.slice(hits[0]?.start ?? 0, hits[0]?.end ?? 0)).toContain('- one');
    expect(text.slice(hits[1]?.start ?? 0, hits[1]?.end ?? 0)).toContain('x();');
  });

  it('parseFenceAttrs handles quoted and unquoted values', () => {
    const attrs = parseFenceAttrs('kind=code title="hello world" lang=ts');
    expect(attrs.get('kind')).toBe('code');
    expect(attrs.get('title')).toBe('hello world');
    expect(attrs.get('lang')).toBe('ts');
  });

  it('parses a scorecard with one rated item per bullet', () => {
    const text =
      'How did we do?\n\n:::partner.scorecard title="Rate the launch" scale=5\n- Onboarding flow\n- Pricing clarity\n- Support responsiveness\n:::\n\nThanks.';
    const hit = findStructuredBlock(text);
    expect(hit?.block.kind).toBe('scorecard');
    if (hit?.block.kind === 'scorecard') {
      expect(hit.block.title).toBe('Rate the launch');
      expect(hit.block.scale).toBe(5);
      expect(hit.block.labels).toBeNull();
      expect(hit.block.items).toEqual([
        'Onboarding flow',
        'Pricing clarity',
        'Support responsiveness',
      ]);
    }
    expect(text.slice(0, hit?.start ?? 0)).toContain('How did we do?');
    expect(text.slice(hit?.end ?? 0)).toContain('Thanks.');
  });

  it('defaults the scorecard scale to 5 and accepts low/high labels', () => {
    const bare = findStructuredBlock(':::partner.scorecard\n- a\n- b\n::: ');
    if (bare?.block.kind === 'scorecard') expect(bare.block.scale).toBe(5);

    const labelled = findStructuredBlock(
      ':::partner.scorecard scale=10 labels="Poor|Excellent"\n- a\n- b\n::: ',
    );
    if (labelled?.block.kind === 'scorecard') {
      expect(labelled.block.scale).toBe(10);
      expect(labelled.block.labels).toEqual(['Poor', 'Excellent']);
    }
  });

  it('clamps a malformed scorecard scale instead of dropping the container', () => {
    const at = (raw: string) => {
      const hit = findStructuredBlock(`:::partner.scorecard ${raw}\n- a\n- b\n::: `);
      return hit?.block.kind === 'scorecard' ? hit.block.scale : null;
    };
    // Out of range clamps to the nearest bound; junk falls back to the default.
    expect(at('scale=1')).toBe(2);
    expect(at('scale=99')).toBe(10);
    expect(at('scale=many')).toBe(5);
    expect(at('scale=')).toBe(5);
  });

  it('drops scorecard labels that are not exactly two non-empty ends', () => {
    const labels = (raw: string) => {
      const hit = findStructuredBlock(`:::partner.scorecard ${raw}\n- a\n- b\n::: `);
      return hit?.block.kind === 'scorecard' ? hit.block.labels : undefined;
    };
    expect(labels('labels="Poor|Excellent"')).toEqual(['Poor', 'Excellent']);
    expect(labels('labels="only"')).toBeNull();
    expect(labels('labels="a|b|c"')).toBeNull();
    expect(labels('labels=" | "')).toBeNull();
    // A comma stays part of a label (the separator is `|`).
    expect(labels('labels="Not good, really|Great"')).toEqual(['Not good, really', 'Great']);
  });

  it('ignores a scorecard with no items and one left unclosed', () => {
    expect(findStructuredBlock(':::partner.scorecard title="x"\njust prose\n:::')).toBeNull();
    expect(findStructuredBlock(':::partner.scorecard\n- a\n- b')).toBeNull();
  });
});
