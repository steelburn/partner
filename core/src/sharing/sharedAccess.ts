/**
 * Deployment shared access (M29) — the owner's AI configuration, published for
 * invited members who have none of their own.
 *
 * ## The gap this closes
 *
 * An invite lets a person create their own account, but a fresh account has no
 * provider and no search key, so "sign in and chat" was not true: the member had
 * to be handed a base URL and an API key too. That is the operator leaking a
 * credential it should not have to hand over at all.
 *
 * So the OWNER publishes their provider and search configuration once, from the
 * app. The non-secret half (endpoint, model lists, purposes, search provider)
 * goes into the system database's `shared_access` key/value rows; the secrets go
 * into the DEPLOYMENT keychain under `shared-provider:<id>` and
 * `shared-search:<provider>` accounts. A member with `keyAccess: 'shared'` then
 * reaches the published configuration through a read-only fallback in their own
 * provider/search managers, and never sees — or holds — the key itself.
 *
 * ## Rules that keep this honest
 *
 *  - A member's OWN configuration always wins. The fallback is consulted only
 *    while the member has no enabled provider of their own, and only when a
 *    shared search is the only one available.
 *  - Unpublishing removes the system rows AND the shared keychain entries, so
 *    revoking shared access actually revokes the credential rather than merely
 *    hiding the config.
 *  - Only an owner may publish (enforced at the route). The published rows hold
 *    no secret, so reading them back is safe.
 */
import type { Keychain, SearchConfig } from '@partner/shared';
import { isProviderPurpose, isSearchProvider } from '@partner/shared';
import type { ProviderSummary } from '@partner/shared';
import { KEYCHAIN_SERVICE } from '../keychain/keychain.js';
import type { SharedAccessStore } from '../stores/types.js';

/** Keychain account prefix holding a published provider's key. */
export const SHARED_PROVIDER_KEYCHAIN_PREFIX = 'shared-provider:';
/** Keychain account prefix holding a published search provider's key. */
export const SHARED_SEARCH_KEYCHAIN_PREFIX = 'shared-search:';
/** `shared_access` key holding the published provider list (JSON array). */
export const SHARED_PROVIDERS_KEY = 'providers';
/** `shared_access` key holding the published search config (JSON object). */
export const SHARED_SEARCH_KEY = 'search';
/** `shared_access` key holding the publish metadata (who/when). */
export const SHARED_META_KEY = 'meta';

/** A provider as published: everything a client sees except live health. */
export type SharedProviderConfig = Omit<ProviderSummary, 'health'>;

export interface SharedAccessStatus {
  /** True when at least one provider is published. */
  configured: boolean;
  providerCount: number;
  searchConfigured: boolean;
  /** When the owner last published, or null if never. */
  updatedAt: number | null;
  /** The owner who published, or null (operator tooling). */
  updatedBy: string | null;
}

export interface SharedAccess {
  /** The published providers, in publish order. Empty when none. */
  providers(): SharedProviderConfig[];
  /** The published key for one provider id, or null. */
  providerKey(id: string): Promise<string | null>;
  /** The published search config, or null when none/search is disabled. */
  search(): SearchConfig | null;
  /** The published key for one search provider, or null. */
  searchKey(provider: string): Promise<string | null>;
  status(): SharedAccessStatus;
  /**
   * Publish (or replace) the owner's configuration. Writes the non-secret rows
   * and the `shared-*` keychain entries, then PRUNES keys for providers/search
   * providers that are no longer published — a revoked provider's key must not
   * stay readable.
   */
  publish(input: PublishSharedAccessInput): Promise<void>;
  /** Remove every published row and key. */
  clear(): Promise<void>;
}

export interface PublishSharedAccessInput {
  providers: Array<{ config: SharedProviderConfig; key: string | null }>;
  search: { config: SearchConfig; keys: Record<string, string> } | null;
  /** The publishing owner (audited by the caller), for the meta row. */
  updatedBy?: string | null;
  at?: number;
}

/** Serialize what actually needs to persist (no functions, no health). */
function toStoredProvider(config: SharedProviderConfig): SharedProviderConfig {
  return {
    id: config.id,
    name: config.name,
    kind: config.kind,
    source: config.source,
    purpose: config.purpose,
    endpoint: config.endpoint,
    defaultModels: [...config.defaultModels],
    visionModels: [...config.visionModels],
    enabled: config.enabled,
    budgetCents: config.budgetCents,
    createdAt: config.createdAt,
    updatedAt: config.updatedAt,
  };
}

/** Defensive parse: one bad row must not break every member's chat. */
function parseProviders(raw: string | undefined): SharedProviderConfig[] {
  if (raw === undefined || raw === '') return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const out: SharedProviderConfig[] = [];
    for (const entry of parsed) {
      if (entry === null || typeof entry !== 'object') continue;
      const row = entry as Record<string, unknown>;
      if (typeof row.id !== 'string' || row.id === '') continue;
      if (typeof row.endpoint !== 'string' || row.endpoint === '') continue;
      if (typeof row.name !== 'string') continue;
      out.push({
        id: row.id,
        name: row.name,
        kind: 'openai-compatible',
        source: 'manual',
        purpose: isProviderPurpose(row.purpose) ? row.purpose : 'general',
        endpoint: row.endpoint,
        defaultModels: Array.isArray(row.defaultModels)
          ? row.defaultModels.filter((m): m is string => typeof m === 'string')
          : [],
        visionModels: Array.isArray(row.visionModels)
          ? row.visionModels.filter((m): m is string => typeof m === 'string')
          : [],
        enabled: row.enabled !== false,
        budgetCents: typeof row.budgetCents === 'number' ? row.budgetCents : null,
        createdAt: typeof row.createdAt === 'number' ? row.createdAt : 0,
        updatedAt: typeof row.updatedAt === 'number' ? row.updatedAt : 0,
      });
    }
    return out;
  } catch {
    return [];
  }
}

function parseSearch(raw: string | undefined): SearchConfig | null {
  if (raw === undefined || raw === '') return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== 'object') return null;
    const row = parsed as Record<string, unknown>;
    if (row.enabled !== true) return null;
    if (!isSearchProvider(row.provider)) return null;
    const endpoints = { tavily: null, brave: null } as SearchConfig['endpoints'];
    if (row.endpoints !== null && typeof row.endpoints === 'object') {
      const stored = row.endpoints as Record<string, unknown>;
      for (const key of ['tavily', 'brave'] as const) {
        const value = stored[key];
        if (typeof value === 'string' && value !== '') endpoints[key] = value;
      }
    }
    return { enabled: true, provider: row.provider, endpoints };
  } catch {
    return null;
  }
}

function parseMeta(raw: string | undefined): { updatedAt: number | null; updatedBy: string | null } {
  if (raw === undefined || raw === '') return { updatedAt: null, updatedBy: null };
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : null,
      updatedBy: typeof parsed.updatedBy === 'string' && parsed.updatedBy !== '' ? parsed.updatedBy : null,
    };
  } catch {
    return { updatedAt: null, updatedBy: null };
  }
}

export function createSharedAccess(options: {
  store: SharedAccessStore;
  keychain: Keychain;
}): SharedAccess {
  const { store, keychain } = options;

  async function readSharedKey(prefix: string, id: string): Promise<string | null> {
    try {
      return await keychain.get(KEYCHAIN_SERVICE, `${prefix}${id}`);
    } catch {
      // A keychain failure must not turn into a wrong-key stream upstream; the
      // caller treats null as "no shared credential".
      return null;
    }
  }

  async function writeKey(prefix: string, id: string, key: string | null): Promise<void> {
    try {
      if (key === null || key === '') await keychain.delete(KEYCHAIN_SERVICE, `${prefix}${id}`);
      else await keychain.set(KEYCHAIN_SERVICE, `${prefix}${id}`, key);
    } catch {
      // Best effort: a missing key surfaces as `missing_key` on the first turn,
      // which is a clearer failure than a publish that half-succeeds.
    }
  }

  function providers(): SharedProviderConfig[] {
    return parseProviders(store.get(SHARED_PROVIDERS_KEY)?.value);
  }

  return {
    providers,

    async providerKey(id: string): Promise<string | null> {
      return readSharedKey(SHARED_PROVIDER_KEYCHAIN_PREFIX, id);
    },

    search(): SearchConfig | null {
      return parseSearch(store.get(SHARED_SEARCH_KEY)?.value);
    },

    async searchKey(provider: string): Promise<string | null> {
      return readSharedKey(SHARED_SEARCH_KEYCHAIN_PREFIX, provider);
    },

    status(): SharedAccessStatus {
      const list = providers();
      const meta = parseMeta(store.get(SHARED_META_KEY)?.value);
      return {
        configured: list.length > 0,
        providerCount: list.length,
        searchConfigured: parseSearch(store.get(SHARED_SEARCH_KEY)?.value) !== null,
        updatedAt: meta.updatedAt,
        updatedBy: meta.updatedBy,
      };
    },

    async publish(input: PublishSharedAccessInput): Promise<void> {
      const at = input.at ?? Date.now();
      // Write the new set, then PRUNE what is no longer published. Removing
      // first would delete live keys if the write then failed.
      const previousProviderIds = new Set(providers().map((p) => p.id));

      const configs = input.providers.map((entry) => toStoredProvider(entry.config));
      store.set(SHARED_PROVIDERS_KEY, JSON.stringify(configs), at);
      for (const entry of input.providers) {
        await writeKey(SHARED_PROVIDER_KEYCHAIN_PREFIX, entry.config.id, entry.key);
      }
      if (input.search === null) {
        store.remove(SHARED_SEARCH_KEY);
      } else {
        store.set(SHARED_SEARCH_KEY, JSON.stringify(input.search.config), at);
      }
      // A search key that is not in the new set must not stay readable: the
      // publication is the whole authority for what a member may use.
      for (const provider of ['tavily', 'brave'] as const) {
        const key = input.search?.keys[provider];
        await writeKey(SHARED_SEARCH_KEYCHAIN_PREFIX, provider, key === undefined ? null : key);
      }
      store.set(
        SHARED_META_KEY,
        JSON.stringify({ updatedAt: at, updatedBy: input.updatedBy ?? null }),
        at,
      );

      for (const id of previousProviderIds) {
        if (!configs.some((config) => config.id === id)) {
          await writeKey(SHARED_PROVIDER_KEYCHAIN_PREFIX, id, null);
        }
      }
    },

    async clear(): Promise<void> {
      for (const config of providers()) {
        await writeKey(SHARED_PROVIDER_KEYCHAIN_PREFIX, config.id, null);
      }
      for (const provider of ['tavily', 'brave']) {
        await writeKey(SHARED_SEARCH_KEYCHAIN_PREFIX, provider, null);
      }
      store.remove(SHARED_PROVIDERS_KEY);
      store.remove(SHARED_SEARCH_KEY);
      store.remove(SHARED_META_KEY);
    },
  };
}
