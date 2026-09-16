/**
 * M4 memory module index (PLAN-M4.md).
 *
 * Exposes the managers + the {@link MemoryBundle} the HTTP server consumes,
 * plus the shared wiring helpers so createCore (index.ts) and the test
 * harness (core/test/helpers.ts) assemble the SAME surface.
 */
import type { ProviderClient } from '@partner/shared';
import type { AuditService } from '../services/redaction.js';
import type { ConversationManager } from '../conversations/manager.js';
import type { PersonaManager } from '../personas/manager.js';
import type { ProviderManager } from '../providers/providerManager.js';
import { resolveChatModel } from '../gateway/resolver.js';
import type {
  EpisodeStore,
  MemoryFtsStore,
  ProfileEntryStore,
  SettingsStore,
} from '../stores/types.js';
import { createEpisodeManager } from './episodes.js';
import type { EpisodeManager, SummarizeTarget } from './episodes.js';
import { createMemoryForgetManager } from './forget.js';
import type { MemoryForgetManager, MemoryForgetResult } from './forget.js';
import { createProfileManager } from './profile.js';
import type { ProfileManager } from './profile.js';
import { createRememberManager } from './remember.js';
import type { RememberManager, RememberTarget } from './remember.js';
import { createSearchManager } from './search.js';
import type { SearchManager } from './search.js';
import { createMemorySettings } from './settings.js';
import type { MemorySettings } from './settings.js';
import { createMemoryTransferManager } from './transfer.js';
import type {
  MemoryImportCounts,
  MemoryTransferManager,
} from './transfer.js';
import type { MemoryExportBundle } from '@partner/shared';

export { MemoryError, memoryError, memoryErrorStatus } from './errors.js';
export type { MemoryErrorCode } from './errors.js';

export { createProfileManager, normalizeProfileInput, PROFILE_KINDS, PROFILE_STATUSES } from './profile.js';
export type { ProfileManager, ProfileManagerOptions, ProfileListOptions, ProfileEntryPatch } from './profile.js';

export { createEpisodeManager, SUMMARIZE_SYSTEM_PROMPT, demoEpisodeSummary } from './episodes.js';
export type {
  EpisodeManager,
  EpisodeManagerOptions,
  SummarizeTarget,
} from './episodes.js';

export { createSearchManager, escapeFtsQuery, SEARCH_HIT_CAP } from './search.js';
export type { SearchManager, SearchManagerOptions } from './search.js';

export { createMemoryForgetManager, parseBeforeCutoff } from './forget.js';
export type { MemoryForgetManager, MemoryForgetManagerOptions, MemoryForgetResult } from './forget.js';

export { createMemoryTransferManager } from './transfer.js';
export type { MemoryImportCounts, MemoryTransferManager, MemoryTransferManagerOptions } from './transfer.js';

export { buildTailoring, TAILORING_ENTRY_CAP, TAILORING_MAX_ENTRIES } from './tailor.js';
export type { TailoringPersona } from './tailor.js';

export {
  createRememberManager,
  parseRememberReply,
  formatKnownBlock,
  looksLikeSecret,
  REMEMBER_SYSTEM_PROMPT,
  REMEMBER_MAX_ITEMS,
  REMEMBER_VALUE_CAP,
  REMEMBER_EVIDENCE_CAP,
  REMEMBER_INPUT_CAP,
  REMEMBER_KNOWN_MAX,
  REMEMBER_KNOWN_VALUE_CAP,
  REMEMBER_KNOWN_HEADER,
  REMEMBER_SCOPES,
  REMEMBER_DEFAULT_POLICY,
} from './remember.js';
export type {
  RememberManager,
  RememberManagerOptions,
  RememberInput,
  RememberOutcome,
  RememberCandidate,
  RememberScope,
  RememberPolicy,
  RememberTarget,
} from './remember.js';

export { createMemorySettings, AUTO_REMEMBER_GLOBAL_KEY } from './settings.js';
export type { MemorySettings, MemorySettingsOptions } from './settings.js';

/**
 * The M4 memory surface wired into CoreAppOptions.memory / CoreBundle.memory
 * (all optional on the server — memory routes 501 not_configured without it).
 */
export interface MemoryBundle {
  profile: ProfileManager;
  episodes: EpisodeManager;
  search: SearchManager;
  forget: MemoryForgetManager;
  transfer: MemoryTransferManager;
  /** M19 automatic remember (persona-scoped + global suggestions). */
  remember: RememberManager;
  /** M19 follow-up: user-level global auto-remember consent. */
  settings: MemorySettings;
}

export interface MemoryWiringOptions {
  stores: { profile: ProfileEntryStore; episodes: EpisodeStore; fts: MemoryFtsStore };
  conversations: ConversationManager;
  /** Shared settings store holding the user-level global auto-remember flag. */
  settings: SettingsStore;
  audit: AuditService;
  /** Demo mode writes placeholder summaries without any provider call. */
  demo: boolean;
  /**
   * Resolves the summarizer's chat target for a conversation persona (or
   * null when nothing usable is configured). Supplied by the caller so the
   * harness and createCore can share the same resolver shape.
   */
  providerResolver: (personaId: string | null) => SummarizeTarget | null | Promise<SummarizeTarget | null>;
  /**
   * M19 automatic-remember resolver (cheap task class). Falls back to
   * {@link providerResolver} when omitted, so older harnesses keep working.
   */
  rememberResolver?: (personaId: string) => RememberTarget | null | Promise<RememberTarget | null>;
  /** Injectable clock (epoch ms), shared by every manager. */
  now?: () => number;
}

/** Assemble the full M4 memory bundle over the given stores/audit. */
export function createMemoryBundle(options: MemoryWiringOptions): MemoryBundle {
  const now = options.now;
  const profile = createProfileManager({
    store: options.stores.profile,
    fts: options.stores.fts,
    audit: options.audit,
    now,
  });
  const episodes = createEpisodeManager({
    stores: { episodes: options.stores.episodes, fts: options.stores.fts },
    conversations: options.conversations,
    providerResolver: options.providerResolver,
    demo: options.demo,
    audit: options.audit,
    now,
  });
  const search = createSearchManager({
    stores: {
      fts: options.stores.fts,
      profile: options.stores.profile,
      episodes: options.stores.episodes,
    },
  });
  const forget = createMemoryForgetManager({
    stores: {
      profile: options.stores.profile,
      episodes: options.stores.episodes,
      fts: options.stores.fts,
    },
    audit: options.audit,
    now,
  });
  const transfer = createMemoryTransferManager({
    stores: {
      profile: options.stores.profile,
      episodes: options.stores.episodes,
      fts: options.stores.fts,
    },
    audit: options.audit,
    now,
  });
  const rememberTargetResolver =
    options.rememberResolver ??
    ((personaId: string) => options.providerResolver(personaId) as RememberTarget | null | Promise<RememberTarget | null>);
  const remember = createRememberManager({
    profile,
    audit: options.audit,
    demo: options.demo,
    providerResolver: rememberTargetResolver,
  });
  const settings = createMemorySettings({
    settings: options.settings,
    audit: options.audit,
    now,
  });
  return { profile, episodes, search, forget, transfer, remember, settings };
}

/**
 * Build the summarize provider resolver used by createCore: route the
 * conversation's persona through gateway/resolver.ts (persona-pinned/first
 * enabled provider + persona task-class model) and return a live chat client
 * for it. null when the persona is missing/deleted, nothing is enabled, no
 * model resolved, or the keychain/client is unavailable — the episode manager
 * then falls back to its deterministic placeholder summary.
 */
export function createSummarizeResolver(deps: {
  personas: PersonaManager;
  providers: ProviderManager;
  /** Chat task class used for the resolved model (M19 passes 'cheap'). */
  taskClass?: 'chat' | 'deep' | 'coding' | 'vision' | 'cheap';
}): (personaId: string | null) => Promise<SummarizeTarget | null> {
  const taskClass = deps.taskClass ?? 'chat';
  return async (personaId: string | null): Promise<SummarizeTarget | null> => {
    if (personaId === null) return null;
    const persona = deps.personas.get(personaId);
    if (persona === null) return null;
    const resolved = resolveChatModel({
      persona,
      providers: deps.providers.list(),
      taskClass,
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
