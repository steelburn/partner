/**
 * M11 F1 file references (PLAN-M11.md) — core half.
 *
 * A mention is a markdown link with the `partner-file://` scheme:
 *   [label](partner-file://<rootId>/<relative/path>)
 *
 * `parseFileRefs` extracts refs from a user message. `fileRefsExcerpt`
 * enriches the model context for a NEWEST user turn: for each ref inside a
 * root the user has already GRANTED files.read on, the file is read through
 * the broker (capped) and its text appended to the turn. Nothing is read
 * without a grant; missing/oversized files are skipped, never fatal.
 */
import type { ToolExecResponse } from '@partner/shared';

export interface ParsedFileRef {
  rootId: string;
  path: string;
  label: string;
}

export interface FileRefDeps {
  /** True when an ACTIVE user grant covers files.read for this root. */
  hasReadGrant(rootId: string): boolean;
  /** Read through the broker (only called under a grant). */
  read(params: { projectId: string; path: string; maxBytes?: number }): ToolExecResponse;
  /** Root label for the header (fallback: root id). */
  rootLabel(rootId: string): string | null;
}

export const MAX_REF_EXCERPT_BYTES = 6000;
export const MAX_REFS_PER_TURN = 5;
export const MAX_REFS_TOTAL_CHARS = 18_000;

const REF = /partner-file:\/\/([^/?#\s)\]]+)\/([^\s)\]]+)/g;

/** Extract partner-file refs from markdown text (order of appearance). */
export function parseFileRefs(text: string): ParsedFileRef[] {
  const out: ParsedFileRef[] = [];
  const seen = new Set<string>();
  const re = new RegExp(REF.source, 'g');
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    try {
      const rootId = decodeURIComponent(match[1] ?? '');
      const path = decodeURIComponent(match[2] ?? '');
      if (rootId === '' || path === '') continue;
      const key = `${rootId}/${path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ rootId, path, label: path.split('/').pop() ?? path });
    } catch {
      // malformed percent-encoding — ignore the ref
    }
  }
  return out;
}

/**
 * Build the model-context excerpt for a message's file refs. Reads happen
 * ONLY for refs whose root has an active files.read grant; each read is
 * capped; failures are skipped silently. Returns '' when nothing applies.
 */
export function fileRefsExcerpt(text: string, deps: FileRefDeps): string {
  const refs = parseFileRefs(text).slice(0, MAX_REFS_PER_TURN);
  if (refs.length === 0) return '';
  const blocks: string[] = [];
  let total = 0;
  for (const ref of refs) {
    if (!deps.hasReadGrant(ref.rootId)) continue;
    const response = deps.read({
      projectId: ref.rootId,
      path: ref.path,
      maxBytes: MAX_REF_EXCERPT_BYTES,
    });
    if (response.outcome !== 'executed') continue;
    const content = String((response.result as { content?: unknown })?.content ?? '');
    if (content === '') continue;
    total += content.length;
    if (total > MAX_REFS_TOTAL_CHARS) break;
    const label = ref.label;
    const rootLabel = deps.rootLabel(ref.rootId) ?? ref.rootId;
    blocks.push(`[File reference: ${label} (in ${rootLabel})]\n${content}`);
  }
  return blocks.length === 0 ? '' : blocks.join('\n\n');
}
