/**
 * M11 C3 structured-response guidance (PLAN-M11.md).
 *
 * The one deterministic instruction block the core can append to a persona's
 * system prompt so the model emits `:::partner.*` containers for structured
 * UI (choices F9, assets F10, results F2). It is a plain string — no model
 * state, no hidden prompts — and never enters audit (owner data, like the
 * persona system prompt itself).
 *
 * M12 capability pass: the same system message also carries a DETERMINISTIC
 * capability declaration so a persona can honestly "check what it can do"
 * before acting: its independence level is always declared in chat (the
 * starter prompt says "respect the declared independence level" but nothing
 * declared it), and the internet-search tool grammar is appended ONLY when
 * the persona could actually run it (backend enabled, auto/autonomous, not
 * banned). Default-deny: other personas are never told the search tool
 * exists.
 */
import type { ChatMessage, IndependenceLevel } from '@partner/shared';

/** Feature-flagged instruction blocks (id -> text). Order is stable. */
const INSTRUCTIONS: ReadonlyArray<readonly [string, string]> = [
  [
    'choices',
    [
      'When you ask the user a question whose answer is one of a fixed set of options, ',
      'emit the options as a clickable choice container instead of a numbered list:',
      '',
      ':::partner.choice mode=single', // or mode=multi for multiple selections
      '- Option one',
      '- Option two',
      ':::',
      '',
      'Rules: keep the surrounding question as normal text above the container; ',
      'one container per question; mode=single for one answer, mode=multi when several ',
      'answers may be selected; options are plain bullet lines (no numbering).',
    ].join('\n'),
  ],
  [
    'forms',
    [
      'When you need to ask the user MORE THAN ONE open-ended question (their answers ',
      'are free text, not a fixed set of options), ask them together as a single form ',
      'so the user answers each in its own field and submits once:',
      '',
      ':::partner.form title="A few questions"',
      '- What problem are you solving?',
      '- Who is the primary user?',
      ':::',
      '',
      'Rules: one open-ended question per bullet line; use a form when there are two ',
      'or more such questions; keep any surrounding explanation as normal text above ',
      'the container; do not mix fixed-choice options into a form (use a choice ',
      'container instead).',
    ].join('\n'),
  ],
  [
    'assets',
    [
      'When you produce a deliberate artifact the user may want to keep (a decision, a ',
      'list of action items, a definition, a draft, or code they asked for), wrap it in ',
      'an asset container so it can be saved:',
      '',
      ':::partner.asset kind=decision title="Decision: …"',
      '…the artifact as clean markdown…',
      ':::',
      '',
      'Use kind=decision|action|definition|draft|code|table|document when one fits; do ',
      'not wrap ordinary prose answers.',
    ].join('\n'),
  ],
] as const;

/**
 * The full guidance suffix for a turn. `enabled` lists the feature ids the
 * conversation has opted into (choices, forms and assets by default).
 * Deterministic — same input, same string — so tests can assert it verbatim.
 */
export function structuredInstructions(enabled: ReadonlySet<string>): string {
  const blocks: string[] = [];
  for (const [id, text] of INSTRUCTIONS) {
    if (enabled.has(id)) blocks.push(text);
  }
  if (blocks.length === 0) return '';
  return [
    '',
    'Structured interaction format:',
    ...blocks,
    '',
    'Always close every container you open with a lone ::: line.',
  ].join('\n');
}

/** Default opt-in set for persisted persona chat turns. */
export const DEFAULT_STRUCTURED_FEATURES: ReadonlySet<string> = new Set([
  'choices',
  'forms',
  'assets',
]);

/**
 * Append the structured-response guidance to the system message that already
 * carries the persona identity (no persona -> the caller's messages are
 * untouched, matching pre-M11 one-shot chat byte-for-byte).
 */
/** Plain-language meaning of each independence level (mirrors the M9 gate
 *  matrix in playbooks/gate.ts + the persona editor explainers). */
const INDEPENDENCE_MEANINGS: Record<IndependenceLevel, string> = {
  assist: 'answer and propose only — you never execute tools or prompt for permission (tool use starts at higher levels)',
  suggest: 'execute low-risk tools when granted; propose medium- and high-risk actions for approval',
  auto: 'execute low- and medium-risk tools when consent covers them; propose high-risk actions for approval',
  autonomous: 'act within your configured envelope — execute what is granted, propose the rest',
};

/** Deterministic declaration appended to a persona's chat system prompt so
 *  the model can reason about what it may do ("check capability"). Same
 *  input, same string. */
export function independenceDeclaration(level: IndependenceLevel): string {
  const meaning = INDEPENDENCE_MEANINGS[level] ?? INDEPENDENCE_MEANINGS.assist;
  return `Your independence level is ${level}: ${meaning}.`;
}

/** Deterministic internet-search tool instruction. Appended to the persona
 *  system message ONLY when the search backend is enabled AND the persona
 *  can direct-execute it (auto/autonomous, not banned) — see
 *  canRunSearchTool in the chat route. */
export const SEARCH_TOOL_INSTRUCTION = [
  'Internet search is available to you (the user enabled it and your independence level lets you run it).',
  'When you need current web information, emit ONE directive on its own line inside your reply:',
  '',
  '[[partner:tool search {"query":"<what to look up>"}]]',
  '',
  'Rules: only when a live web lookup is genuinely needed; never for local files, notes or conversation history;',
  'results are added to the conversation as a note AFTER your reply — if your answer depends on them, say you',
  "are looking it up and answer on the following turn; never invent titles, URLs or facts; never emit this",
  'directive for any other tool.',
].join('\n');

/** Deterministic internet-search instruction for SUGGEST personas: the tool
 *  exists but every use needs the user's approval (the directive queues an
 *  approval row the user decides in the Files queue). Appended only when the
 *  backend is enabled and the persona is suggest (not banned). */
export const SEARCH_TOOL_APPROVAL_INSTRUCTION = [
  'Internet search is enabled, but your independence level requires the user to approve each use.',
  'When you need current web information, emit ONE directive on its own line inside your reply:',
  '',
  '[[partner:tool search {"query":"<what to look up>"}]]',
  '',
  'Rules: emitting it queues an approval request the user decides (Files queue); do not claim the search ran',
  'until you see its results; results arrive as a note AFTER the approval — say you are looking it up and',
  'answer on the following turn; never invent titles, URLs or facts; never emit this directive for any other tool.',
].join('\n');

export function applyStructuredGuidance(
  out: ChatMessage[],
  personaSystemIndex: number,
  enabled?: ReadonlySet<string>,
): void {
  const features = enabled ?? DEFAULT_STRUCTURED_FEATURES;
  const suffix = structuredInstructions(features);
  if (suffix === '') return;
  const system = out[personaSystemIndex];
  if (!system || system.role !== 'system') return;
  out[personaSystemIndex] = { ...system, content: `${system.content}\n\n${suffix}` };
}
