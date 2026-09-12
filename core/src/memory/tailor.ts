/**
 * Chat-time tailoring (M4 PLAN-M4.md §"chat-time tailoring"; M19 extends it
 * to persona-scoped memory).
 *
 * buildTailoring(profileManager, persona) renders the confirmed profile
 * entries a persona should honor as a compact system-prompt block (max 8
 * entries, each trimmed to 240 chars, '- kind: value' with an optional
 * '(evidence: …)' suffix), or null when there is nothing to honor.
 *
 * Which entries:
 *   - GLOBAL entries (personaScope === null) are honored by every persona
 *     (M4 contract, unchanged).
 *   - PERSONA-SCOPED entries (personaScope === persona.id) are honored ONLY
 *     when that persona has private memory on (`memory.personaMemory ===
 *     'on'`). Passing a bare persona id keeps the M4 global-only behavior.
 *
 * The route prepends the returned block as a system message ONLY on the
 * provider-routed, persona-bound persist path — never demo, never one-shot —
 * and the injected prelude is never persisted into the transcript.
 */
import type { PersonaMemoryFlags } from '@partner/shared';
import type { ProfileManager } from './profile.js';

export const TAILORING_MAX_ENTRIES = 8;
export const TAILORING_ENTRY_CAP = 240;
export const TAILORING_EVIDENCE_CAP = 120;

/** Minimal persona shape tailoring needs (keeps managers decoupled). */
export interface TailoringPersona {
  id: string;
  memory?: Partial<PersonaMemoryFlags>;
}

export function buildTailoring(
  profileManager: ProfileManager,
  persona: string | TailoringPersona,
): string | null {
  const personaId = typeof persona === 'string' ? persona : persona.id;
  const includeScoped =
    typeof persona !== 'string' && persona.memory?.personaMemory === 'on';

  const candidates = profileManager
    .list()
    .filter((entry) => {
      if (entry.status !== 'confirmed') return false;
      if (entry.personaScope === null) return true;
      return includeScoped && entry.personaScope === personaId;
    })
    // Newest first: the most recent confirmed facts are the ones to honor.
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, TAILORING_MAX_ENTRIES);

  if (candidates.length === 0) return null;

  const lines = candidates.map((entry) => {
    let line = `- ${entry.kind}: ${entry.value.trim()}`;
    if (entry.evidence !== null && entry.evidence.trim() !== '') {
      line += ` (evidence: ${entry.evidence.trim().slice(0, TAILORING_EVIDENCE_CAP)})`;
    }
    return line.slice(0, TAILORING_ENTRY_CAP);
  });
  return lines.join('\n');
}
