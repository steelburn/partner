/**
 * M5 notes module index (PLAN-M5.md).
 *
 * Re-exports the note manager + typed errors and builds the daily-summarize
 * provider resolver used by createCore: the FIRST enabled provider's default
 * model (no persona — the daily summary is the partner's own voice, not a
 * persona-bound turn). A live chat client is returned for it; null when
 * nothing is enabled, no model resolved, or the keychain/client is
 * unavailable — the manager then falls back to its deterministic placeholder.
 */
import type { ProviderClient } from '@partner/shared';
import type { ProviderManager } from '../providers/providerManager.js';
import { resolveChatModel } from '../gateway/resolver.js';
import type { DailySummarizeTarget } from './manager.js';

export { NoteError, noteError, noteErrorStatus } from './errors.js';
export type { NoteErrorCode } from './errors.js';

export {
  createNoteManager,
  parseWikiLinks,
  noteSearchText,
  stripDailySummarySection,
  demoDailySummary,
  utcDateString,
  isSameUtcDay,
  firstDeltaText,
  CAPTURE_TITLE_CAP,
  NOTES_SEARCH_CAP,
  DAILY_SUMMARIZE_CHAR_BUDGET,
  DAILY_SUMMARY_HEADING,
  DAILY_SUMMARIZE_SYSTEM_PROMPT,
} from './manager.js';
export type {
  DailySummarizeTarget,
  NoteManager,
  NoteManagerOptions,
  NotePatch,
} from './manager.js';

export {
  // M16 F2 brainstorm orchestrator (PLAN-M16.md).
  createBrainstormManager,
  buildBrainstormBundle,
  demoBrainstormReply,
  brainstormSetKey,
  BrainstormError,
  brainstormError,
  brainstormErrorStatus,
  BRAINSTORM_PERSONA_ID,
  BRAINSTORM_MAX_NOTES,
  BRAINSTORM_EXCERPT_CHARS,
  BRAINSTORM_TOTAL_CHARS,
  BRAINSTORM_SYSTEM_PROMPT,
} from './brainstorm.js';
export type {
  BrainstormManager,
  BrainstormManagerOptions,
  BrainstormBundleResult,
  BrainstormErrorCode,
} from './brainstorm.js';

/**
 * Build the daily-summarize resolver: first enabled provider's default
 * model, mirroring M1's resolveChatProvider fallback. Returns null when
 * nothing usable is configured (the note manager writes the placeholder).
 */
export function createDailySummarizeResolver(deps: {
  providers: ProviderManager;
}): () => Promise<DailySummarizeTarget | null> {
  return async (): Promise<DailySummarizeTarget | null> => {
    const resolved = resolveChatModel({
      providers: deps.providers.list(),
      taskClass: 'chat',
    });
    if (resolved.provider === null || resolved.model === '') return null;
    try {
      const client: ProviderClient = await deps.providers.clientFor(resolved.provider.id);
      return { client, model: resolved.model };
    } catch {
      return null; // missing key / keychain unavailable -> placeholder fallback
    }
  };
}
