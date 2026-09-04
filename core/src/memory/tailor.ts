/**
 * Chat-time tailoring (M4, PLAN-M4.md §"chat-time tailoring").
 *
 * buildTailoring(profileManager, personaId) renders the confirmed GLOBAL
 * profile entries (personaScope === null) as a compact system-prompt block
 * (max 8 entries, each trimmed to 240 chars, '- kind: value' with an
 * optional '(evidence: …)' suffix), or null when there is nothing to honor.
 *
 * M4 uses global entries only; `personaId` is reserved for the later
 * per-persona override milestone (PLAN-M4 "Out of scope") and is not read.
 * The route prepends the returned block as a system message ONLY on the
 * provider-routed, persona-bound persist path — never demo, never one-shot —
 * and the injected prelude is never persisted into the transcript.
 */
import type { ProfileManager } from './profile.js';

export const TAILORING_MAX_ENTRIES = 8;
export const TAILORING_ENTRY_CAP = 240;
export const TAILORING_EVIDENCE_CAP = 120;

export function buildTailoring(profileManager: ProfileManager, personaId: string): string | null {
  const confirmedGlobal = profileManager
    .list()
    .filter((entry) => entry.status === 'confirmed' && entry.personaScope === null)
    // Newest first: the most recent confirmed facts are the ones to honor.
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, TAILORING_MAX_ENTRIES);

  if (confirmedGlobal.length === 0) return null;

  const lines = confirmedGlobal.map((entry) => {
    let line = `- ${entry.kind}: ${entry.value.trim()}`;
    if (entry.evidence !== null && entry.evidence.trim() !== '') {
      line += ` (evidence: ${entry.evidence.trim().slice(0, TAILORING_EVIDENCE_CAP)})`;
    }
    return line.slice(0, TAILORING_ENTRY_CAP);
  });
  return lines.join('\n');
}
