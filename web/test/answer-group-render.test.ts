/**
 * Grouped-answer RENDER tests (server-rendered — no DOM needed).
 *
 * Why this file exists: an adversarial review pointed out that the grouped
 * answer lane asserted its headline behaviour only through PURE helpers. The
 * consequence is concrete — deleting `showSubmit={false}` from AnswerGroup
 * would restore the original bug (two independent submits, each discarding the
 * other's answers) and every test would still pass.
 *
 * The excuse used elsewhere — "these components only render in a browser, so a
 * source assertion is the only route" — is false in this repo:
 * `web/test/markdown.test.ts` already renders these very components with
 * `renderToStaticMarkup` (react-dom/server, node environment). So the
 * structural guarantee is asserted here on real markup.
 *
 * SSR does not run effects, so the cards cannot report answers upward and the
 * submit stays disabled — which is exactly the initial state worth pinning.
 * Interactive state transitions are covered by the browser pass recorded in
 * `docs/VERIFY-MOBILE.md`.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement as h } from 'react';
import type { ChoiceBlock, FormBlock, ScorecardBlock } from '@partner/shared';
import { AnswerGroup } from '../src/AnswerGroup.js';
import { ChoiceCard } from '../src/ChoiceCard.js';
import { FormCard } from '../src/FormCard.js';
import { ScorecardCard } from '../src/ScorecardCard.js';
import { PartnerMarkdown } from '../src/Markdown.js';

const CHOICE: ChoiceBlock = {
  kind: 'choice',
  mode: 'single',
  title: 'Which database?',
  options: ['Postgres', 'SQLite'],
};

const FORM: FormBlock = {
  kind: 'form',
  title: 'A few questions',
  questions: ['What problem are you solving?', 'Who is the primary user?'],
};

const SCORECARD: ScorecardBlock = {
  kind: 'scorecard',
  title: 'Rate the launch',
  items: ['Onboarding flow', 'Pricing clarity'],
  scale: 5,
  labels: null,
};

/** The one submit's markup, or null when it is absent. */
function submitButton(html: string, label: string): string | null {
  const match = new RegExp(`<button[^>]*>${label}</button>`).exec(html);
  return match === null ? null : match[0];
}

describe('a grouped message offers exactly one submit', () => {
  const html = renderToStaticMarkup(
    h(AnswerGroup, { blocks: [CHOICE, FORM], busy: false, onAnswer: () => undefined }),
  );

  it('renders ONE submit for the whole group', () => {
    expect(submitButton(html, 'Send answers')).not.toBeNull();
    expect((html.match(/Send answers/g) ?? []).length).toBe(1);
  });

  it('does not render the cards\' own submits — the bug being prevented', () => {
    // "Confirm" is ChoiceCard's own button; "Submit answers" is FormCard's.
    // Either one appearing here means two independent submits again, and
    // pressing it would discard the other question set.
    expect(html).not.toContain('Confirm selections');
    expect(html).not.toContain('Submit answers');
  });

  it('blocks the group until every part is answered', () => {
    // Nothing can report on the server, so nothing is answered yet.
    expect(submitButton(html, 'Send answers')).toContain('disabled');
  });

  it('still renders both question sets', () => {
    expect(html).toContain('Which database?');
    expect(html).toContain('A few questions');
    expect(html).toContain('What problem are you solving?');
    expect(html).toContain('Who is the primary user?');
  });
});

describe('a group that is no longer the live one', () => {
  it('reads "Closed", never "Answers sent"', () => {
    // Honesty rule: a stale group the user never answered must not claim its
    // answers were sent. Both states are inert; only one is true here.
    const html = renderToStaticMarkup(
      h(AnswerGroup, { blocks: [CHOICE, FORM], busy: false, live: false, onAnswer: () => undefined }),
    );
    expect(submitButton(html, 'Closed')).not.toBeNull();
    expect(html).not.toContain('Answers sent');
    expect(html).toContain('From an earlier reply.');
  });
});

describe('a single-container message keeps the card\'s own submit', () => {
  it('does not wrap one container in a group', () => {
    const text = [
      ':::partner.choice mode=single title="Which database?"',
      '- Postgres',
      '- SQLite',
      ':::',
    ].join('\n');
    const html = renderToStaticMarkup(h(PartnerMarkdown, { text, onAnswer: () => undefined }));
    expect(html).not.toContain('answer-group');
    expect(html).toContain('Confirm');
  });

  it('groups as soon as a second container asks something', () => {
    const text = [
      ':::partner.choice mode=single title="Which database?"',
      '- Postgres',
      '- SQLite',
      ':::',
      '',
      ':::partner.form title="A few questions"',
      '- What problem are you solving?',
      ':::',
    ].join('\n');
    const html = renderToStaticMarkup(h(PartnerMarkdown, { text, onAnswer: () => undefined }));
    expect(html).toContain('answer-group');
    expect((html.match(/Send answers/g) ?? []).length).toBe(1);
    expect(html).not.toContain('Submit answers');
  });
});

describe('a scorecard is answerable too', () => {
  it('renders as a grouped section with no submit of its own', () => {
    // The bug this guards: a scorecard that kept its own submit button next to a
    // choice's would send only its ratings and discard the choice.
    const html = renderToStaticMarkup(
      h(AnswerGroup, { blocks: [CHOICE, SCORECARD], busy: false, onAnswer: () => undefined }),
    );
    expect(html).toContain('scorecard-card');
    expect(html).toContain('Rate the launch');
    expect(html).toContain('Onboarding flow');
    expect(html).toContain('Pricing clarity');
    expect((html.match(/Send answers/g) ?? []).length).toBe(1);
    expect(html).not.toContain('Submit ratings');
    expect(html).not.toContain('Confirm');
  });

  it('renders one radio group per item so each item takes exactly one score', () => {
    const html = renderToStaticMarkup(
      h(AnswerGroup, { blocks: [CHOICE, SCORECARD], busy: false, onAnswer: () => undefined }),
    );
    // Choice (2 options) + two scorecard items x five scores = 12 radios.
    expect((html.match(/type="radio"/g) ?? []).length).toBe(12);
    // Three distinct radio groups: the choice plus one per scorecard item.
    const names = [...html.matchAll(/name="([^"]+)"/g)].map((match) => match[1]);
    expect(new Set(names).size).toBe(3);
  });
});

describe('a single scorecard keeps its own submit', () => {
  it('renders the card standalone with a gated submit', () => {
    const text = [
      ':::partner.scorecard title="Rate the launch" scale=5 labels="Poor|Excellent"',
      '- Onboarding flow',
      '- Pricing clarity',
      ':::',
    ].join('\n');
    const html = renderToStaticMarkup(h(PartnerMarkdown, { text, onAnswer: () => undefined }));
    expect(html).not.toContain(':::partner.scorecard');
    expect(html).toContain('scorecard-card');
    expect(html).toContain('Submit ratings');
    expect(html).toContain('1 = Poor');
    expect(html).toContain('5 = Excellent');
    // No rating yet, so the submit starts disabled.
    expect(submitButton(html, 'Submit ratings')).toContain('disabled');
    expect(html.match(/Submit ratings/g)?.length).toBe(1);
  });

  it('ScorecardCard renders no submit when the group owns it', () => {
    const html = renderToStaticMarkup(
      h(ScorecardCard, {
        title: SCORECARD.title,
        items: SCORECARD.items,
        scale: SCORECARD.scale,
        busy: false,
        showSubmit: false,
      }),
    );
    expect(html).not.toContain('Submit ratings');
  });
});

describe('the cards alone still carry their own submit', () => {
  it('ChoiceCard renders Confirm when standalone', () => {
    const html = renderToStaticMarkup(
      h(ChoiceCard, {
        mode: 'single',
        title: CHOICE.title,
        options: CHOICE.options,
        busy: false,
        onConfirm: () => undefined,
      }),
    );
    expect(html).toContain('Confirm');
  });

  it('ChoiceCard renders NO submit when the group owns it', () => {
    const html = renderToStaticMarkup(
      h(ChoiceCard, {
        mode: 'single',
        title: CHOICE.title,
        options: CHOICE.options,
        busy: false,
        showSubmit: false,
      }),
    );
    expect(html).not.toContain('Confirm');
  });

  it('FormCard renders its own submit when standalone, none when grouped', () => {
    const standalone = renderToStaticMarkup(
      h(FormCard, { title: FORM.title, questions: FORM.questions, busy: false, onConfirm: () => undefined }),
    );
    expect(standalone).toContain('Submit answers');

    const grouped = renderToStaticMarkup(
      h(FormCard, { title: FORM.title, questions: FORM.questions, busy: false, showSubmit: false }),
    );
    expect(grouped).not.toContain('Submit answers');
  });
});
