/**
 * M10 audit view helpers (PLAN-M10 W4): area labels, pretty detail JSON and
 * JSON/Markdown export builders. Pure functions — unit-tested in the web
 * suite. Rows are the core's redacted audit entries; nothing here can
 * reintroduce a secret (export text is built from the same redacted rows).
 */
import type { AuditEntry } from './audit.js';
import { formatWhen } from './roots.js';

/** Coarse area chip for an action id (prefix match; default 'other'). */
export function auditAreaLabel(action: string): string {
  if (action.startsWith('chat') || action.startsWith('pair') || action.startsWith('session')) {
    return 'chat';
  }
  if (action.startsWith('provider') || action.startsWith('budget')) return 'provider';
  if (action.startsWith('playbook') || action.startsWith('deploy-profile')) return 'playbook';
  if (action.startsWith('skill')) return 'skill';
  return 'other';
}

/** Pretty-printed details JSON for the expandable row body. */
export function prettyAuditDetails(details: string): string {
  try {
    const parsed = JSON.parse(details) as unknown;
    return JSON.stringify(parsed, null, 2);
  } catch {
    return details;
  }
}

function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

/** JSON export text of the fetched (redacted) rows. */
export function auditJsonText(entries: AuditEntry[]): string {
  return JSON.stringify(entries, null, 2);
}

/** Markdown export text of the fetched (redacted) rows. */
export function auditMarkdownText(entries: AuditEntry[]): string {
  const lines: string[] = [
    '# Partner audit log',
    '',
    '| Time | Actor | Action | Target | Details |',
    '| --- | --- | --- | --- | --- |',
  ];
  for (const entry of entries) {
    const when = formatWhen(entry.createdAt) ?? String(entry.createdAt);
    const details = entry.details.replace(/\|/g, '\\|').replace(/\n/g, ' ');
    lines.push(`| ${when} | ${entry.actor} | ${entry.action} | ${entry.target} | ${details} |`);
  }
  return `${lines.join('\n')}\n`;
}

/** Client-side JSON export of the fetched (redacted) rows. */
export function exportAuditJson(entries: AuditEntry[]): void {
  download(new Blob([auditJsonText(entries)], { type: 'application/json' }), `partner-audit-${Date.now()}.json`);
}

/** Client-side Markdown export of the fetched (redacted) rows. */
export function exportAuditMarkdown(entries: AuditEntry[]): void {
  download(new Blob([auditMarkdownText(entries)], { type: 'text/markdown' }), `partner-audit-${Date.now()}.md`);
}
