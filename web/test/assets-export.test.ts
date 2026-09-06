import { describe, expect, it } from 'vitest';
import type { Asset } from '@partner/shared';
import { assetExportFileName, buildAssetExportMarkdown } from '../src/lib/assets-export.js';

function asset(overrides: Partial<Asset> = {}): Asset {
  return {
    id: 'a1',
    conversationId: 'c1',
    messageId: 'm1',
    kind: 'document',
    title: 'Org-chart takeaways',
    tags: [],
    createdAt: 1_700_000_000_000,
    body: '## Key points\n\n- Partner reports to the CEO',
    ...overrides,
  };
}

describe('M14 assets-lane export helpers', () => {
  it('builds a .md filename from the title, dropping illegal path chars', () => {
    expect(assetExportFileName('Org-chart takeaways')).toBe('Org-chart takeaways.md');
    expect(assetExportFileName('Plan "Q1" / Q2: <draft>?')).toBe('Plan -Q1- - Q2- -draft.md');
    expect(assetExportFileName('  ')).toBe('asset.md');
  });

  it('prepends a provenance blockquote, then the raw body', () => {
    const markdown = buildAssetExportMarkdown(asset());
    expect(markdown.startsWith('> Saved as a **document** asset on ')).toBe(true);
    expect(markdown).toContain('2023-11-14T22:13:20.000Z');
    expect(markdown).toContain('## Key points\n\n- Partner reports to the CEO');
    // Body content is owner text: exported verbatim, never transformed.
    expect(markdown).not.toContain('Org-chart takeaways');
  });

  it('normalises a blank body to an empty document (no dangling header)', () => {
    const markdown = buildAssetExportMarkdown(asset({ body: '   \n' }));
    expect(markdown.endsWith('asset on 2023-11-14T22:13:20.000Z from this conversation.\n\n')).toBe(
      true,
    );
  });

  it('keeps the kind readable in the header (hyphenated kinds unchanged is fine)', () => {
    const markdown = buildAssetExportMarkdown(asset({ kind: 'reference-list' }));
    expect(markdown).toContain('**reference-list**');
  });
});
