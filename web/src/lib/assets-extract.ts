/**
 * M11 F10 asset extraction candidates (PLAN-M11.md).
 *
 * Pure + deterministic: a saved assistant response becomes one or more typed
 * assets. Explicit `:::partner.asset` containers (C3) win; otherwise the
 * whole message is a `document` candidate plus any code fences and markdown
 * tables. The dialog lets the user pick, retitle and rekind each candidate
 * before anything is written.
 */
import { parseStructuredBlocks } from '@partner/shared';
import type { AssetKind } from '@partner/shared';

export interface AssetCandidate {
  kind: AssetKind;
  title: string;
  body: string;
}

const EXPLICIT_KIND: Record<string, AssetKind> = {
  decision: 'decision',
  action: 'action',
  definition: 'definition',
  draft: 'draft',
  code: 'code',
  table: 'table',
  document: 'document',
  'reference-list': 'reference-list',
  quote: 'quote',
};

function firstHeading(text: string): string | null {
  const line = text
    .split('\n')
    .map((entry) => entry.trim())
    .find((entry) => /^#{1,3}\s+/.test(entry));
  return line ? line.replace(/^#{1,3}\s+/, '').trim().slice(0, 80) : null;
}

const FENCE = /```([\w-]*)\n([\s\S]*?)\n```/g;

function splitCandidates(text: string): AssetCandidate[] {
  const candidates: AssetCandidate[] = [];
  const heading = firstHeading(text);
  candidates.push({
    kind: 'document',
    title: heading ?? 'Saved response',
    body: text,
  });

  let fence: RegExpExecArray | null;
  const fenced = new RegExp(FENCE.source, 'g');
  while ((fence = fenced.exec(text)) !== null) {
    const lang = (fence[1] ?? '').trim();
    const body = (fence[2] ?? '').trim();
    if (body.length < 2) continue;
    const title = (lang !== '' ? `${lang} snippet` : 'Code snippet').slice(0, 80);
    candidates.push({ kind: 'code', title, body: `\`\`\`${lang}\n${body}\n\`\`\`` });
    if (candidates.length >= 8) break;
  }

  // Markdown tables: contiguous runs of lines starting with | containing a
  // separator row (|---|).
  const lines = text.split('\n');
  let index = 0;
  while (index < lines.length - 1 && candidates.length < 8) {
    const line = lines[index] ?? '';
    if (line.trimStart().startsWith('|') && /^\s*\|[\s:|-]+\|\s*$/.test(lines[index + 1] ?? '')) {
      const block: string[] = [line];
      let cursor = index + 1;
      while (cursor < lines.length && (lines[cursor] ?? '').trimStart().startsWith('|')) {
        block.push(lines[cursor] ?? '');
        cursor += 1;
      }
      const table = block.join('\n');
      if (table.length > 2) {
        candidates.push({ kind: 'table', title: 'Table', body: table });
      }
      index = cursor;
      continue;
    }
    index += 1;
  }

  return candidates;
}

/** Explicit ::partner.asset containers, mapped to kinds (win over heuristics). */
export function extractCandidates(text: string): AssetCandidate[] {
  const explicit: AssetCandidate[] = [];
  for (const hit of parseStructuredBlocks(text)) {
    if (hit.block.kind === 'asset') {
      const kind = EXPLICIT_KIND[hit.block.assetKind] ?? 'custom';
      explicit.push({
        kind,
        title: hit.block.title ?? `${hit.block.assetKind} artifact`,
        body: hit.block.body,
      });
    }
  }
  return explicit.length > 0 ? explicit : splitCandidates(text);
}
