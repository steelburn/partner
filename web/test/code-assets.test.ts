/**
 * M11 F12 code-asset helper tests (PLAN-M11.md) — fence stripping for
 * inline display and the html/css preview decision for `kind=code` asset
 * containers rendered in the transcript.
 */
import { describe, expect, it } from 'vitest';
import { codeAssetBody, codeAssetPreview, singleFencedCode } from '../src/lib/code-assets.js';

describe('singleFencedCode', () => {
  it('extracts a single fenced block with its language', () => {
    expect(singleFencedCode('```html\n<h1>Hi</h1>\n```')).toEqual({
      lang: 'html',
      code: '<h1>Hi</h1>',
    });
  });

  it('normalizes the language tag and tolerates trailing whitespace', () => {
    expect(singleFencedCode('```CSS\nbody { color: red }\n```  ')).toEqual({
      lang: 'css',
      code: 'body { color: red }',
    });
  });

  it('returns null when there is no fence or extra content', () => {
    expect(singleFencedCode('const x = 1;')).toBeNull();
    expect(singleFencedCode('```js\nconst a = 1;\n```\nAnd some prose after.')).toBeNull();
    expect(singleFencedCode('```js\na\n```\n\n```css\nb\n```')).toBeNull();
  });

  it('keeps inner code verbatim, including nested fence-like text', () => {
    expect(singleFencedCode('```md\ncode ``` inside\n```')?.code).toBe('code ``` inside');
  });
});

describe('codeAssetBody (display)', () => {
  it('strips the fence for a single fenced artifact', () => {
    expect(codeAssetBody('```html\n<p>x</p>\n```')).toEqual({ lang: 'html', code: '<p>x</p>' });
  });

  it('shows unfenced code verbatim', () => {
    expect(codeAssetBody('const x = 1;')).toEqual({ lang: null, code: 'const x = 1;' });
  });
});

describe('codeAssetPreview (F12 sandboxed viewer)', () => {
  it('offers html fenced code', () => {
    expect(codeAssetPreview('```html\n<h1>Hi</h1>\n```')).toEqual({
      lang: 'html',
      source: '<h1>Hi</h1>',
    });
  });

  it('offers css fenced code', () => {
    expect(codeAssetPreview('```css\np { color: red }\n```')?.lang).toBe('css');
  });

  it('offers an unfenced HTML fragment', () => {
    expect(codeAssetPreview('<div class="card">Hi</div>')?.source).toBe(
      '<div class="card">Hi</div>',
    );
  });

  it('refuses non-browser languages (js/py/sql) and mixed content', () => {
    expect(codeAssetPreview('```js\nconst x = 1;\n```')).toBeNull();
    expect(codeAssetPreview('```py\nprint(1)\n```')).toBeNull();
    expect(codeAssetPreview('```js\na\n```\n\n```css\nb\n```')).toBeNull();
    expect(codeAssetPreview('Plain prose that starts with no tag.')).toBeNull();
    expect(codeAssetPreview('')).toBeNull();
  });

  it('does not mislabel markdown prose as raw HTML when it is fenced', () => {
    expect(codeAssetPreview('```md\n- one\n- two\n```')).toBeNull();
  });
});
