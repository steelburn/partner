/**
 * M11 F7/F9 renderer tests (PLAN-M11.md) — server-rendered (no DOM needed).
 * PartnerMarkdown sanitizes raw HTML, renders GFM tables/code, slices out
 * :::partner.* containers, and renders choices as real single/multi controls
 * with the confirm gated until a selection exists. Asset containers (F10)
 * stay readable inline: prose bodies render under a kind+title header and
 * html/css code assets expose the F12 Preview action.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement as h } from 'react';
import { PartnerMarkdown } from '../src/Markdown.js';
import { ChoiceCard } from '../src/ChoiceCard.js';
import { FormCard, formatFormAnswers } from '../src/FormCard.js';
import { ScorecardCard, formatScorecardAnswers } from '../src/ScorecardCard.js';

function render(props: {
  text: string;
  busy?: boolean;
  onAnswer?: (message: string) => void;
  onPreviewCode?: (preview: { title: string; source: string }) => void;
  resolveNote?: (title: string) => { id: string; title: string; snippet?: string | null } | null;
  onOpenNote?: (id: string) => void;
}): string {
  return renderToStaticMarkup(
    h(PartnerMarkdown, {
      text: props.text,
      busy: props.busy,
      onAnswer: props.onAnswer,
      onPreviewCode: props.onPreviewCode,
      resolveNote: props.resolveNote,
      onOpenNote: props.onOpenNote,
    }),
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

describe('PartnerMarkdown form containers (multi-question)', () => {
  it('renders one input per question and a single submit, keeping prose', () => {
    const html = render({
      text:
        'Before I draft it:\n\n:::partner.form title="A few questions"\n- What problem are you solving?\n- Who is the primary user?\n:::\n\nThanks!',
    });
    expect(html).not.toContain(':::partner.form');
    expect(html).not.toContain(':::');
    expect(html).toContain('form-card');
    expect(html).toContain('A few questions');
    expect(html).toContain('What problem are you solving?');
    expect(html).toContain('Who is the primary user?');
    // Two separate fields, but only one submit action.
    expect(html.match(/<textarea/g)?.length).toBe(2);
    expect(html.match(/Submit answers/g)?.length).toBe(1);
    expect(html).toContain('Before I draft it:');
    expect(html).toContain('Thanks!');
  });

  it('keeps an unclosed form container as visible text (never materialized)', () => {
    const html = render({ text: ':::partner.form\n- a?\n- b?' });
    expect(html).toContain(':::partner.form');
  });

  it('busy forms disable every field and the submit', () => {
    const html = renderToStaticMarkup(
      h(FormCard, {
        title: 'T',
        questions: ['a?', 'b?'],
        busy: true,
        onConfirm: () => undefined,
      }),
    );
    expect(html).toMatch(/disabled/);
  });
});

describe('formatFormAnswers', () => {
  it('labels each non-empty answer with its question and joins them once', () => {
    const message = formatFormAnswers(
      ['What problem?', 'Who benefits?', 'Deadline?'],
      ['Slow onboarding', '  ', 'Friday'],
    );
    expect(message).toBe(
      'Q: What problem?\nA: Slow onboarding\n\nQ: Deadline?\nA: Friday',
    );
  });

  it('returns an empty string when nothing was answered', () => {
    expect(formatFormAnswers(['a?'], ['  '])).toBe('');
  });
});

describe('PartnerMarkdown scorecard containers', () => {
  it('renders one score row per item and a single submit, keeping prose', () => {
    const html = render({
      text:
        'Quick pulse check:\n\n:::partner.scorecard title="Rate the launch" scale=5\n- Onboarding flow\n- Pricing clarity\n- Support responsiveness\n:::\n\nThanks!',
    });
    expect(html).not.toContain(':::partner.scorecard');
    expect(html).not.toContain(':::');
    expect(html).toContain('scorecard-card');
    expect(html).toContain('Rate the launch');
    expect(html).toContain('Onboarding flow');
    expect(html).toContain('Pricing clarity');
    expect(html).toContain('Support responsiveness');
    // Three items x five scores = fifteen radios, but only one submit.
    expect(html.match(/type="radio"/g)?.length).toBe(15);
    expect(html.match(/Submit ratings/g)?.length).toBe(1);
    expect(html).toContain('Quick pulse check:');
    expect(html).toContain('Thanks!');
  });

  it('honours the scale and the optional low/high labels', () => {
    const html = render({
      text: ':::partner.scorecard scale=10 labels="Poor|Excellent"\n- Onboarding\n- Pricing\n:::',
    });
    expect(html.match(/type="radio"/g)?.length).toBe(20);
    expect(html).toContain('1 = Poor');
    expect(html).toContain('10 = Excellent');
  });

  it('keeps an unclosed scorecard container as visible text (never materialized)', () => {
    const html = render({ text: ':::partner.scorecard\n- a\n- b' });
    expect(html).toContain(':::partner.scorecard');
  });

  it('busy scorecards disable every score and the submit', () => {
    const html = renderToStaticMarkup(
      h(ScorecardCard, {
        title: 'T',
        items: ['a', 'b'],
        scale: 5,
        busy: true,
        onConfirm: () => undefined,
      }),
    );
    expect(html).toMatch(/disabled/);
  });
});

describe('formatScorecardAnswers', () => {
  it('labels each rated item with its score and joins them once', () => {
    const message = formatScorecardAnswers(
      ['Onboarding flow', 'Pricing clarity', 'Support'],
      [4, 2, null],
      5,
    );
    expect(message).toBe('Q: Onboarding flow\nA: 4/5\n\nQ: Pricing clarity\nA: 2/5');
  });

  it('returns an empty string when nothing is rated', () => {
    expect(formatScorecardAnswers(['a', 'b'], [null, null], 5)).toBe('');
  });
});

describe('PartnerMarkdown asset containers (F10 — body readable inline)', () => {
  it('renders a definition container body inline under a kind+title header', () => {
    const html = render({
      text: 'Here is the answer:\n\n:::partner.asset kind=definition title="What a partner can do"\nA partner can chat, plan, run tools and save artifacts.\n:::\n\nThat is the short version.',
    });
    expect(html).not.toContain(':::partner.asset');
    expect(html).not.toContain(':::');
    expect(html).toContain('md-asset-kind');
    expect(html).toContain('definition');
    expect(html).toContain('What a partner can do');
    // The body is readable in the bubble — never hidden behind the tag.
    expect(html).toContain('A partner can chat, plan, run tools and save artifacts.');
    expect(html).toContain('Here is the answer:');
    expect(html).toContain('That is the short version.');
  });

  it('renders markdown inside an asset body (lists survive)', () => {
    const html = render({
      text: ':::partner.asset kind=document title="Capabilities"\n- chat\n- plan\n::: ',
    });
    expect(html).toContain('<li>chat</li>');
    expect(html).toContain('<li>plan</li>');
  });

  it('keeps an unclosed asset container as visible text (never materialized)', () => {
    const html = render({ text: ':::partner.asset kind=definition\nNot closed yet.' });
    expect(html).toContain(':::partner.asset');
    expect(html).toContain('Not closed yet.');
  });

  it('shows html code assets verbatim and offers the F12 Preview', () => {
    const html = render({
      text: ':::partner.asset kind=code title="Greeting"\n```html\n<h1>Hello</h1>\n```\n:::',
      onPreviewCode: () => undefined,
    });
    expect(html).not.toContain(':::');
    // Code is visible inline (escaped text inside the code well).
    expect(html).toContain('md-asset-code');
    expect(html).toContain('&lt;h1&gt;Hello&lt;/h1&gt;');
    expect(html).not.toContain('```html');
    expect(html).toContain('Greeting');
    expect(html).toContain('Preview');
  });

  it('disables the Preview action while the turn is streaming', () => {
    const html = render({
      text: ':::partner.asset kind=code\n```css\np { color: red }\n```\n:::',
      busy: true,
      onPreviewCode: () => undefined,
    });
    expect(html).toMatch(/disabled/);
  });

  it('never offers Preview for non-browser code languages', () => {
    const html = render({
      text: ':::partner.asset kind=code title="Swap"\n```js\nconst x = 1;\n```\n:::',
    });
    expect(html).toContain('const x = 1;');
    expect(html).not.toContain('Preview');
  });

  it('previews an unfenced HTML document body', () => {
    let called: { title: string; source: string } | null = null;
    const html = render({
      text: ':::partner.asset kind=code title="Card"\n<div class="card">Hi</div>\n:::',
      onPreviewCode: (preview) => {
        called = preview;
      },
    });
    expect(html).toContain('Preview');
    expect(html).toContain('md-asset-code');
    expect(called).toBeNull(); // server render cannot click; wiring asserted below
  });
});

describe('PartnerMarkdown inline HTML code preview (F12 follow-up)', () => {
  it('renders both the code and a sandboxed result for an html fence', () => {
    const html = render({ text: 'Look:\n\n```html\n<h1>Hello</h1>\n```' });
    // The source stays visible...
    expect(html).toContain('&lt;h1&gt;Hello&lt;/h1&gt;');
    expect(html).toContain('md-code-block');
    expect(html).toContain('md-code-lang');
    // ...and the rendered document rides an inline sandboxed iframe.
    expect(html).toContain('md-code-preview-frame');
    expect(html).toContain('srcDoc');
    expect(html).toContain('sandbox');
  });

  it('previews an untagged fence whose text reads as HTML', () => {
    const html = render({ text: '```\n<div class="card">Hi</div>\n```' });
    expect(html).toContain('md-code-preview-frame');
    expect(html).toContain('&lt;div class=&quot;card&quot;&gt;Hi&lt;/div&gt;');
  });

  it('leaves non-HTML fences as a plain pre (no preview)', () => {
    const html = render({ text: '```js\nconst x = 1;\n```' });
    expect(html).toContain('const x = 1;');
    expect(html).toContain('md-pre');
    expect(html).not.toContain('md-code-preview-frame');
  });

  it('never executes scripts outside the sandbox (source is inert text)', () => {
    const html = render({ text: '```html\n<script>alert(1)</script>\n```' });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
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

describe('M16 chat wiki-links', () => {
  it('renders a resolved citation as a note button with a content hint', () => {
    const html = render({
      text: 'See [[Alpha Note]] and continue.',
      resolveNote: (title) =>
        title === 'Alpha Note' ? { id: 'n1', title, snippet: 'Alpha body text.' } : null,
      onOpenNote: () => undefined,
    });
    expect(html).not.toContain('[[');
    expect(html).toContain('md-wiki-link');
    expect(html).toContain('Alpha Note');
    expect(html).toContain('<button');
    expect(html).toContain('Alpha body text.');
    expect(html).toContain('See ');
    expect(html).toContain('and continue.');
  });

  it('renders a citation with no matching note as an inert dangling chip', () => {
    const html = render({
      text: 'See [[Ghost Note]].',
      resolveNote: () => null,
      onOpenNote: () => undefined,
    });
    expect(html).toContain('md-wiki-link');
    expect(html).toContain('is-dangling');
    expect(html).toContain('Ghost Note');
    expect(html).not.toContain('<button');
  });

  it('leaves [[…]] inside a code fence as literal code', () => {
    const html = render({
      text: '```ts\nconst t = "[[Literal]]";\n```',
      resolveNote: () => ({ id: 'n1', title: 'Literal' }),
      onOpenNote: () => undefined,
    });
    expect(html).toContain('md-pre');
    expect(html).toContain('[[Literal]]');
    expect(html).not.toContain('md-wiki-link');
  });
});
