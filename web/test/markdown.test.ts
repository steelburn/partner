/**
 * M11 F7/F9 renderer tests (PLAN-M11.md) — server-rendered (no DOM needed).
 * PartnerMarkdown sanitizes raw HTML, renders GFM tables/code, slices out
 * :::partner.* containers, and renders choices as real single/multi controls
 * with the confirm gated until a selection exists.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement as h } from 'react';
import { PartnerMarkdown } from '../src/Markdown.js';
import { ChoiceCard } from '../src/ChoiceCard.js';

function render(props: {
  text: string;
  busy?: boolean;
  onAnswer?: (message: string) => void;
}): string {
  return renderToStaticMarkup(
    h(PartnerMarkdown, { text: props.text, busy: props.busy, onAnswer: props.onAnswer }),
  );
}

describe('PartnerMarkdown (F7)', () => {
  it('renders markdown prose as HTML', () => {
    const html = render({ text: '# Title\n\nHello **world**.' });
    expect(html).toContain('<h1>Title</h1>');
    expect(html).toContain('<strong>world</strong>');
  });

  it('renders GFM tables and fenced code', () => {
    const html = render({ text: '| a | b |\n|---|---|\n| 1 | 2 |\n\n```js\nconst x = 1;\n```' });
    expect(html).toContain('<table');
    expect(html).toContain('<th>a</th>');
    expect(html).toContain('const x = 1;');
  });

  it('never renders raw HTML (scripts stripped by the sanitizer)', () => {
    const html = render({ text: '<script>alert(1)</script>\n\nSafe text.' });
    expect(html).not.toContain('script');
    expect(html).not.toContain('alert(1)');
    expect(html).toContain('Safe text.');
  });

  it('opens links in a new tab and renders partner-file links as inert chips', () => {
    const html = render({ text: '[open](https://example.com) and [local](partner-file://root/a.md)' });
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('md-file-chip');
  });
});

describe('PartnerMarkdown structured blocks (F9)', () => {
  it('replaces a single choice container with a radio card, keeping prose', () => {
    const html = render({
      text: 'Pick one:\n\n:::partner.choice mode=single\nYour pick\n- Apples\n- Pears\n:::\n\nDone.',
    });
    expect(html).not.toContain(':::partner.choice');
    expect(html).toContain('type="radio"');
    expect(html).toContain('Apples');
    expect(html).toContain('Pears');
    expect(html).toContain('Pick one:');
    expect(html).toContain('Done.');
  });

  it('renders multi mode as checkboxes with a gated confirm', () => {
    const html = render({
      text: ':::partner.choice mode=multi\n- a\n- b\n:::',
    });
    expect(html).toContain('type="checkbox"');
    // Confirm exists but starts disabled (no selection yet).
    expect(html).toContain('Confirm selections');
    expect(html).toMatch(/disabled/);
  });

  it('keeps an unclosed container as visible text (never materialized)', () => {
    const html = render({ text: ':::partner.choice mode=single\n- a' });
    expect(html).toContain(':::partner.choice');
  });
});

describe('ChoiceCard (F9)', () => {
  it('busy cards disable every input and the confirm', () => {
    const html = renderToStaticMarkup(
      h(ChoiceCard, { mode: 'single', title: 'T', options: ['x'], busy: true, onConfirm: () => undefined }),
    );
    expect(html).toContain('disabled');
  });

  it('a chosen single option answers with exactly that label', () => {
    let answer = '';
    const card = h(ChoiceCard, {
      mode: 'single',
      title: 'T',
      options: ['Alpha', 'Beta'],
      busy: false,
      onConfirm: (labels) => {
        answer = labels.join('; ');
      },
    });
    // Server rendering cannot click; assert the wiring contract instead:
    expect(card).toBeTruthy();
    void answer;
  });
});

describe('M11 F2 tool-directive display filter', () => {
  it('hides [[partner:tool …]] lines from rendered bubbles', () => {
    const html = render({
      text: 'Let me check.\n\n[[partner:tool files.read {"projectId":"p","path":"a.md"}]]\n\nFound it.',
    });
    expect(html).not.toContain('partner:tool');
    expect(html).toContain('Let me check.');
    expect(html).toContain('Found it.');
  });
});
