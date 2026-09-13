/**
 * Grouped-answer tests.
 *
 * The bug being fixed: a reply carrying both a `choice` and a `form` rendered
 * two independent submit buttons, and pressing either sent only its own answer
 * — the other set was discarded. These assertions pin the replacement rule:
 * exactly one submit when a message asks more than one question set, and a
 * submission that carries every part or is blocked.
 */
import { describe, expect, it } from 'vitest';
import type { AssetBlock, ChoiceBlock, FormBlock } from '@partner/shared';
import {
  answerableCount,
  composeGroupedAnswer,
  groupReadiness,
  groupedSubmitLabel,
  groupedSubmitText,
  isAnswerable,
  isGroupLive,
  shouldGroupAnswers,
  type AnswerPart,
} from '../src/lib/answer-group.js';

const choice = (over: Partial<ChoiceBlock> = {}): ChoiceBlock => ({
  kind: 'choice',
  mode: 'single',
  title: 'Which database?',
  options: ['Postgres', 'SQLite'],
  ...over,
});

const form = (over: Partial<FormBlock> = {}): FormBlock => ({
  kind: 'form',
  title: 'A few questions',
  questions: ['What problem are you solving?', 'Who is the user?'],
  ...over,
});

const asset: AssetBlock = { kind: 'asset', assetKind: 'code', title: 'Snippet', body: 'x' };

describe('which blocks ask a question', () => {
  it('counts choice and form, and never an asset', () => {
    expect(isAnswerable(choice())).toBe(true);
    expect(isAnswerable(form())).toBe(true);
    expect(isAnswerable(asset)).toBe(false);
    expect(answerableCount([choice(), form(), asset])).toBe(2);
  });

  it('leaves a single-container message on its own card button', () => {
    // `> 1`, not `>= 1`: the common case must not change behaviour at all.
    expect(shouldGroupAnswers([choice()])).toBe(false);
    expect(shouldGroupAnswers([form()])).toBe(false);
    expect(shouldGroupAnswers([asset])).toBe(false);
    expect(shouldGroupAnswers([])).toBe(false);
  });

  it('groups as soon as a message asks two things — the reported case', () => {
    expect(shouldGroupAnswers([choice(), form()])).toBe(true);
    expect(shouldGroupAnswers([form(), form()])).toBe(true);
    expect(shouldGroupAnswers([choice(), choice(), form()])).toBe(true);
  });

  it('ignores assets when deciding, since they ask nothing', () => {
    // choice + asset + form is still two question sets.
    expect(shouldGroupAnswers([choice(), asset, form()])).toBe(true);
  });
});

describe('composing the one message', () => {
  const parts: AnswerPart[] = [
    { key: '0', title: 'Which database?', text: 'Postgres' },
    { key: '1', title: 'A few questions', text: 'Q: What problem?\nA: Latency' },
  ];

  it('joins every part so one submit carries all answers', () => {
    expect(composeGroupedAnswer(parts)).toBe('Postgres\n\nQ: What problem?\nA: Latency');
  });

  it('keeps the order the questions appeared in', () => {
    const reversed = [parts[1], parts[0]] as AnswerPart[];
    expect(composeGroupedAnswer(reversed)).toBe('Q: What problem?\nA: Latency\n\nPostgres');
  });

  it('drops an empty part instead of emitting a blank line between answers', () => {
    const withEmpty: AnswerPart[] = [parts[0], { key: 'x', title: null, text: null }];
    expect(composeGroupedAnswer(withEmpty)).toBe('Postgres');
  });

  it('trims whitespace-only answers rather than sending them', () => {
    const padded: AnswerPart[] = [parts[0], { key: 'x', title: null, text: '   ' }];
    expect(composeGroupedAnswer(padded)).toBe('Postgres');
  });

  it('is empty when nothing is answered', () => {
    expect(composeGroupedAnswer([{ key: '0', title: null, text: null }])).toBe('');
    expect(composeGroupedAnswer([])).toBe('');
  });
});

describe('readiness — a submission must carry every part', () => {
  const done = (key: string): AnswerPart => ({ key, title: null, text: `answer ${key}` });

  it('is ready only when every expected part is complete', () => {
    expect(groupReadiness([done('0'), done('1')], 2)).toEqual({ ready: true, hint: null });
  });

  it('blocks submission while a part is still incomplete', () => {
    // The whole point: you cannot submit a choice and leave the form behind.
    const ready = groupReadiness([done('0'), { key: '1', title: null, text: null }], 2);
    expect(ready.ready).toBe(false);
    expect(ready.hint).toBe('1 answer still needed');
  });

  it('counts what is missing without revealing content', () => {
    const ready = groupReadiness([{ key: '0', title: null, text: null }], 3);
    expect(ready.ready).toBe(false);
    expect(ready.hint).toBe('3 answers still needed');
  });

  it('blocks while a part has not reported at all yet', () => {
    // Cards report on mount, so there is a frame with fewer parts than blocks —
    // submission must not be possible in that window.
    expect(groupReadiness([done('0')], 2).ready).toBe(false);
  });

  it('never reports ready with nothing to answer', () => {
    expect(groupReadiness([], 0)).toEqual({ ready: false, hint: null });
  });
});

describe('submit label', () => {
  it('names what the control does', () => {
    expect(groupedSubmitLabel(2)).toBe('Send answers');
    expect(groupedSubmitLabel(1)).toBe('Send answer');
  });
});

/**
 * Liveness — whether a grouped control is still interactive.
 *
 * Replaces the component-local `answered` flag as the thing that survives a
 * reload: local state dies with the page, and web storage cannot hold a flag
 * (see the brief and the storage census guard), so the durable signal is the
 * transcript itself — a question set is only still live while its message is
 * the newest one.
 */
describe('group liveness comes from transcript position', () => {
  it('treats only the newest message as live', () => {
    expect(isGroupLive(0, 1)).toBe(true);
    expect(isGroupLive(3, 4)).toBe(true);
  });

  it('treats any earlier message as no longer live', () => {
    // The moment a later turn exists, the question set is behind us — which is
    // exactly the state a reload has to reproduce.
    expect(isGroupLive(2, 4)).toBe(false);
    expect(isGroupLive(0, 4)).toBe(false);
  });

  it('is live the instant it arrives, before anything follows it', () => {
    // The freshly-arrived reply is the only message, so it must be answerable.
    expect(isGroupLive(0, 1)).toBe(true);
  });

  it('refuses an impossible position rather than defaulting to interactive', () => {
    // Failing open here would re-arm a stale control, so every unusable input
    // resolves to NOT live.
    expect(isGroupLive(-1, 3)).toBe(false);
    expect(isGroupLive(5, 3)).toBe(false);
    expect(isGroupLive(0, 0)).toBe(false);
    expect(isGroupLive(Number.NaN, 3)).toBe(false);
    expect(isGroupLive(0, Number.NaN)).toBe(false);
    expect(isGroupLive(0, -1)).toBe(false);
  });
});

describe('submit label across the three states', () => {
  it('offers to send while the question set is live', () => {
    expect(groupedSubmitText({ answered: false, stale: false, expected: 2 })).toBe('Send answers');
  });

  it('says the answers were sent only when they actually were', () => {
    expect(groupedSubmitText({ answered: true, stale: false, expected: 2 })).toBe('Answers sent');
  });

  it('does NOT claim "Answers sent" for a group the user never answered', () => {
    // The honesty rule: a stale group is inert because the conversation moved
    // on, not because the user submitted it. Collapsing the two reasons into
    // one label asserted something untrue about their actions.
    expect(groupedSubmitText({ answered: false, stale: true, expected: 2 })).toBe('Closed');
    expect(groupedSubmitText({ answered: false, stale: true, expected: 2 })).not.toBe('Answers sent');
  });

  it('still reports sent when a group is both answered and stale', () => {
    expect(groupedSubmitText({ answered: true, stale: true, expected: 2 })).toBe('Answers sent');
  });

  it('keeps the label honest for a single-container group too', () => {
    expect(groupedSubmitText({ answered: false, stale: false, expected: 1 })).toBe('Send answer');
    expect(groupedSubmitText({ answered: false, stale: true, expected: 1 })).toBe('Closed');
  });
});
