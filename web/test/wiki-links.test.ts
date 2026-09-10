/**
 * M16 chat wiki-link helper tests — rewriting `[[Title]]` citations into
 * `partner-note:` links (outside code) and the plain-text hint snippet.
 */
import { describe, expect, it } from 'vitest';
import {
  linkifyWikiLinks,
  noteSnippet,
  wikiTitleFromHref,
} from '../src/lib/wiki-links.js';

describe('linkifyWikiLinks', () => {
  it('rewrites a citation into a partner-note link', () => {
    expect(linkifyWikiLinks('See [[Alpha Note]] for context.')).toBe(
      'See [Alpha Note](partner-note:Alpha%20Note) for context.',
    );
  });

  it('rewrites every citation and keeps surrounding prose', () => {
    expect(linkifyWikiLinks('[[A]] then [[B]]')).toBe(
      '[A](partner-note:A) then [B](partner-note:B)',
    );
  });

  it('encodes the href and escapes backslashes in the visible label', () => {
    expect(linkifyWikiLinks('[[A & B\\C]]')).toBe(
      '[A & B\\\\C](partner-note:A%20%26%20B%5CC)',
    );
  });

  it('escapes backticks so an inline-code title cannot break the link', () => {
    expect(linkifyWikiLinks('[[Run `npm test`]]')).toBe(
      '[Run \\`npm test\\`](partner-note:Run%20%60npm%20test%60)',
    );
  });

  it('never rewrites inside fenced code blocks', () => {
    const text = 'before [[Real]]\n```\nconst x = "[[NotALink]]";\n```\nafter [[Real2]]';
    expect(linkifyWikiLinks(text)).toBe(
      'before [Real](partner-note:Real)\n```\nconst x = "[[NotALink]]";\n```\nafter [Real2](partner-note:Real2)',
    );
  });

  it('never rewrites inside tilde-fenced code blocks', () => {
    const text = '~~~\n[[NotALink]]\n~~~\n[[Real]]';
    expect(linkifyWikiLinks(text)).toBe('~~~\n[[NotALink]]\n~~~\n[Real](partner-note:Real)');
  });

  it('never rewrites inside inline code spans', () => {
    expect(linkifyWikiLinks('a `[[NotALink]]` and [[Real]]')).toBe(
      'a `[[NotALink]]` and [Real](partner-note:Real)',
    );
  });

  it('leaves empty brackets and unclosed brackets alone', () => {
    expect(linkifyWikiLinks('[[]] and [[open')).toBe('[[]] and [[open');
  });
});

describe('wikiTitleFromHref', () => {
  it('decodes the cited title', () => {
    expect(wikiTitleFromHref('partner-note:Alpha%20Note')).toBe('Alpha Note');
  });

  it('returns null for other schemes and empty titles', () => {
    expect(wikiTitleFromHref('https://example.com')).toBeNull();
    expect(wikiTitleFromHref('partner-file://root/a.md')).toBeNull();
    expect(wikiTitleFromHref('partner-note:%20')).toBeNull();
  });
});

describe('noteSnippet', () => {
  it('strips markdown noise and collapses whitespace', () => {
    expect(noteSnippet('# Title\n\nSome **bold** `code` and a [link](https://x).')).toBe(
      'Title Some bold code and a link.',
    );
  });

  it('drops fenced code and truncates at a word boundary', () => {
    const snippet = noteSnippet('```js\nconst x = 1;\n```\n' + 'word '.repeat(80), 40);
    expect(snippet.endsWith('…')).toBe(true);
    expect(snippet.length).toBeLessThanOrEqual(41);
    expect(snippet).not.toContain('const x');
  });

  it('returns an empty string for an empty body', () => {
    expect(noteSnippet('')).toBe('');
  });
});
