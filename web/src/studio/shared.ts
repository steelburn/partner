/**
 * M28-era Studio split: the small helpers the Studio's parts share.
 *
 * These four are pure presentation/transport helpers — no fetching, no state —
 * and they are here rather than in `lib/` because they speak to the Studio's
 * own shapes (`SkillDraft` -> `SkillDraftSummary`) rather than to the wire API.
 *
 * `isSessionLost` is the one with a rule behind it: a 401/403 from the core
 * means the PAIRING is gone, which is a different next step from a failed
 * request, so every panel asks this question the same way instead of testing
 * status codes itself.
 */
import { ApiRequestError } from '../lib/api.js';
import type { SkillDraft, SkillDraftSummary } from '@partner/shared';

/** True when an ApiRequestError means the core session is gone. */
export function isSessionLost(cause: unknown): boolean {
  return cause instanceof ApiRequestError && (cause.status === 401 || cause.status === 403);
}

/** Pretty render of a dry-run result (the owner's own data, owner-only view). */
export function renderResult(result: unknown): string {
  if (typeof result === 'string') return result;
  try {
    return JSON.stringify(result, null, 2);
  } catch {
    return String(result);
  }
}

/** The summary half of a full draft (the rail never needs the source). */
export function summarize(draft: SkillDraft): SkillDraftSummary {
  return {
    id: draft.id,
    name: draft.name,
    description: draft.description,
    status: draft.status,
    origin: draft.origin,
    manifest: draft.manifest,
    validation: draft.validation,
    model: draft.model,
    conversationId: draft.conversationId,
    personaId: draft.personaId,
    pendingInstallId: draft.pendingInstallId,
    createdAt: draft.createdAt,
    updatedAt: draft.updatedAt,
  };
}

/** A safe message from an unknown throw (never a content leak: message only). */
export function messageOf(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message !== '' ? cause.message : fallback;
}
