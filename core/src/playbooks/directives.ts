/**
 * Persona tool directive parser (PLAN-M9.md "Persona tool directive
 * protocol").
 *
 * A provider reply may contain, ON ITS OWN LINE, the exact form:
 *
 *   [[partner:tool <toolId> <json>]]
 *
 * where <json> is a single-line JSON object ({@code {}} allowed). Parsing is
 * line-based and defensive: malformed lines (bad shape, unterminated, JSON
 * that does not parse to an object) are SKIPPED silently — a stray directive
 * must never crash a run or surface a 500. Only whole-line directives are
 * recognized; prose mentioning the marker mid-sentence is not a directive.
 *
 * A reply may chain directives across rounds; the loop engine consumes the
 * LAST directive of a reply (see {@link lastDirective}) and re-loops so the
 * model can ask for the next one once the previous result is fed back.
 *
 * This module is unit-pure: no imports beyond the shared wire type.
 */
import type { PersonaToolDirective } from '@partner/shared';

export const DIRECTIVE_OPEN = '[[partner:tool ';

/** Tool-id token: dotted ids (files.read) plus _ and - (shared ToolId shape). */
const TOOL_ID_PATTERN = /^([A-Za-z0-9][A-Za-z0-9.:_/-]*)(?:[ \t]+(.*))?$/;

function parseLine(line: string): PersonaToolDirective | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith(DIRECTIVE_OPEN)) return null;
  const rest = trimmed.slice(DIRECTIVE_OPEN.length).trim();
  const match = TOOL_ID_PATTERN.exec(rest);
  if (match === null) return null;
  const toolId = match[1];
  // The exact form carries a JSON argument (may be {}); a bare tool id with
  // no JSON is malformed and skipped.
  const jsonPart = match[2];
  if (toolId === undefined || jsonPart === undefined) return null;
  let jsonText = jsonPart.trim();
  // Unterminated (no closing ]]) -> malformed.
  if (!jsonText.endsWith(']]')) return null;
  jsonText = jsonText.slice(0, -2).trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText) as unknown;
  } catch {
    return null; // Malformed JSON — skip silently.
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null; // Args must be a JSON object.
  }
  return { toolId, args: parsed as Record<string, unknown> };
}

/**
 * Extract every well-formed directive from a reply, in line order. Malformed
 * lines are skipped silently (never throw). Nested braces inside the JSON are
 * fine as long as the whole directive sits on one line.
 */
export function parseReplyTools(text: string): PersonaToolDirective[] {
  if (typeof text !== 'string' || text === '') return [];
  const directives: PersonaToolDirective[] = [];
  for (const line of text.split('\n')) {
    const directive = parseLine(line);
    if (directive !== null) directives.push(directive);
  }
  return directives;
}

/**
 * The LAST directive of a reply (the loop engine executes one directive per
 * round, so the model chains tool calls across rounds by looping). Null when
 * the reply carries no well-formed directive.
 */
export function lastDirective(text: string): PersonaToolDirective | null {
  const directives = parseReplyTools(text);
  return directives.length === 0 ? null : (directives[directives.length - 1] as PersonaToolDirective);
}
