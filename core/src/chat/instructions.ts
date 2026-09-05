/**
 * M11 C3 structured-response guidance (PLAN-M11.md).
 *
 * The one deterministic instruction block the core can append to a persona's
 * system prompt so the model emits `:::partner.*` containers for structured
 * UI (choices F9, assets F10, results F2). It is a plain string — no model
 * state, no hidden prompts — and never enters audit (owner data, like the
 * persona system prompt itself).
 */
import type { ChatMessage } from '@partner/shared';

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
 * conversation has opted into (both by default). Deterministic — same input,
 * same string — so tests can assert it verbatim.
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
  'assets',
]);

/**
 * Append the structured-response guidance to the system message that already
 * carries the persona identity (no persona -> the caller's messages are
 * untouched, matching pre-M11 one-shot chat byte-for-byte).
 */
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
