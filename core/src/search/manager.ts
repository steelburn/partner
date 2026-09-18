/**
 * M11 F2 search manager (PLAN-M11.md).
 *
 * One optional API-key search backend. Default-deny: OFF until the user
 * enables it AND stores a key (OS keychain — never the DB). Config
 * (non-secret) lives in the settings store under 'search_config'. Endpoints
 * default to the provider; http is only accepted on loopback (tests/fakes).
 *
 * Every query is audited with its LENGTH + hit count — never the query text
 * or the results (owner data).
 */
import { KEYCHAIN_SERVICE } from '../keychain/keychain.js';
import type {
  SearchConfig,
  SearchConfigInput,
  SearchHit,
  SearchKeyStatus,
  SearchProvider,
  SearchResult,
} from '@partner/shared';
import { SEARCH_DEFAULT_ENDPOINTS, SEARCH_PROVIDERS, isSearchProvider } from '@partner/shared';
import type { Keychain } from '@partner/shared';
import type { SettingsStore } from '../stores/types.js';
import type { AuditService } from '../services/redaction.js';
import { SearchError, searchError } from './errors.js';

export const SEARCH_SETTINGS_KEY = 'search_config';
/**
 * Keys are held per provider (`search:tavily`, `search:brave`) so holding both
 * a Brave and a Tavily key works. `search` (no suffix) is the legacy single
 * account written before per-provider keys existed; it is migrated onto the
 * configured provider on first read.
 */
export const SEARCH_KEYCHAIN_PREFIX = 'search:';
const LEGACY_KEYCHAIN_ACCOUNT = 'search';
const SEARCH_AUDIT_TARGET = 'search';
export const searchKeychainAccount = (provider: SearchProvider): string =>
  `${SEARCH_KEYCHAIN_PREFIX}${provider}`;
export const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_HITS = 5;
const MAX_SNIPPET_CHARS = 600;

export interface SearchManagerOptions {
  settings: SettingsStore;
  keychain: Keychain;
  audit: AuditService;
  /** Injectable fetch (tests). */
  fetchImpl?: typeof fetch;
  /** Injectable clock (epoch ms). */
  now?: () => number;
  /**
   * M29: the deployment's published search configuration, for an account with
   * `keyAccess: 'shared'`. Consulted only while THIS account has search
   * disabled or no key of its own, so a member's own setup always wins. The key
   * stays in the deployment keychain (`shared-search:<provider>`).
   */
  shared?: {
    config(): SearchConfig | null;
    key(provider: SearchProvider): Promise<string | null>;
  };
}

export interface SearchManager {
  config(): SearchConfig;
  /** True when the given provider (default: the configured one) holds a key. */
  hasKey(provider?: SearchProvider): Promise<boolean>;
  /** Key presence per provider, so the UI can manage both keys at once. */
  keyStatus(): Promise<SearchKeyStatus>;
  updateConfig(input: SearchConfigInput): SearchConfig;
  setKey(key: string, provider?: SearchProvider): Promise<void>;
  removeKey(provider?: SearchProvider): Promise<void>;
  /** Run one query; requires enabled + key (default-deny). */
  search(query: string, maxResults?: number): Promise<SearchResult>;
}

const DEFAULT_ENDPOINTS: Record<SearchProvider, string | null> = { tavily: null, brave: null };
const DEFAULT_CONFIG: SearchConfig = {
  enabled: false,
  provider: 'tavily',
  endpoints: { ...DEFAULT_ENDPOINTS },
};

function parseConfig(raw: string | null): SearchConfig {
  if (raw === null || raw === '') return { ...DEFAULT_CONFIG, endpoints: { ...DEFAULT_ENDPOINTS } };
  try {
    const parsed = JSON.parse(raw) as Partial<SearchConfig> & { endpoint?: unknown };
    const provider: SearchProvider = isSearchProvider(parsed.provider) ? parsed.provider : 'tavily';
    const endpoints: Record<SearchProvider, string | null> = { ...DEFAULT_ENDPOINTS };
    const stored = parsed.endpoints;
    if (stored !== null && typeof stored === 'object') {
      const record = stored as Record<string, unknown>;
      for (const option of SEARCH_PROVIDERS) {
        const value = record[option];
        endpoints[option] = typeof value === 'string' && value !== '' ? value : null;
      }
    } else if (typeof parsed.endpoint === 'string' && parsed.endpoint !== '') {
      // Legacy single override (pre per-provider endpoints) belonged to the
      // provider that was configured when it was written.
      endpoints[provider] = parsed.endpoint;
    }
    return { enabled: parsed.enabled === true, provider, endpoints };
  } catch {
    return { ...DEFAULT_CONFIG, endpoints: { ...DEFAULT_ENDPOINTS } };
  }
}

/** https only; http allowed on loopback (local fakes/tests). */
function normalizeEndpoint(raw: unknown): string | null {
  if (raw === undefined || raw === null || raw === '') return null;
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  if (trimmed === '') return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw searchError('invalid_input', 'endpoint must be a valid URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw searchError('invalid_input', 'endpoint must be http(s)');
  }
  if (url.protocol === 'http:') {
    const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1';
    if (!loopback) {
      throw searchError(
        'invalid_input',
        'http endpoints must be on a loopback host — use https elsewhere',
      );
    }
  }
  return trimmed.replace(/\/+$/, '');
}

export function createSearchManager(options: SearchManagerOptions): SearchManager {
  const { settings, keychain, audit } = options;
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;

  function ownConfig(): SearchConfig {
    return parseConfig(settings.get(SEARCH_SETTINGS_KEY));
  }

  /**
   * M29: what search should actually do for this account. The account's OWN
   * enabled configuration wins; while it has none, the deployment's published
   * configuration applies (so a member can search without a key of their own).
   * The `search.config` route still reports `ownConfig()` — publishing is the
   * owner's act, not a setting a member can edit.
   */
  function config(): SearchConfig {
    const own = ownConfig();
    if (own.enabled) return own;
    return options.shared?.config() ?? own;
  }

  function accountFor(provider: SearchProvider): string {
    return searchKeychainAccount(provider);
  }

  /** This account's OWN stored key for a provider (never the shared one). */
  async function ownKeyFor(provider: SearchProvider): Promise<string | null> {
    return keychain.get(KEYCHAIN_SERVICE, accountFor(provider));
  }

  function providerOrConfigured(provider?: SearchProvider): SearchProvider {
    const target = provider ?? ownConfig().provider;
    if (!isSearchProvider(target)) {
      throw searchError('invalid_input', 'provider must be tavily or brave');
    }
    return target;
  }

  // One-time best-effort migration of the legacy shared `search` key onto the
  // configured provider's account. Memoized so concurrent reads do it once.
  let legacyMigrated: Promise<void> | null = null;
  function migrateLegacyKey(): Promise<void> {
    if (legacyMigrated === null) {
      legacyMigrated = (async () => {
        const legacy = await keychain.get(KEYCHAIN_SERVICE, LEGACY_KEYCHAIN_ACCOUNT);
        if (legacy === null || legacy === '') return;
        const provider = ownConfig().provider;
        const existing = await keychain.get(KEYCHAIN_SERVICE, accountFor(provider));
        if (existing === null || existing === '') {
          await keychain.set(KEYCHAIN_SERVICE, accountFor(provider), legacy);
        }
        await keychain.delete(KEYCHAIN_SERVICE, LEGACY_KEYCHAIN_ACCOUNT);
      })().catch(() => {
        // Best effort: a keychain failure must not break config/search reads.
      });
    }
    return legacyMigrated;
  }

  async function hasKey(provider?: SearchProvider): Promise<boolean> {
    await migrateLegacyKey();
    const target = providerOrConfigured(provider);
    const key = await keychain.get(KEYCHAIN_SERVICE, accountFor(target));
    if (key !== null && key !== '') return true;
    // M29: a shared key counts — the member can really run a query with it.
    const sharedKey = await options.shared?.key(target);
    return sharedKey !== null && sharedKey !== undefined;
  }

  async function keyStatus(): Promise<SearchKeyStatus> {
    await migrateLegacyKey();
    const status = {} as SearchKeyStatus;
    for (const provider of SEARCH_PROVIDERS) {
      const key = await keychain.get(KEYCHAIN_SERVICE, accountFor(provider));
      const sharedKey = await options.shared?.key(provider);
      status[provider] = (key !== null && key !== '') || (sharedKey !== null && sharedKey !== undefined);
    }
    return status;
  }

  function updateConfig(input: SearchConfigInput): SearchConfig {
    const body = (input ?? {}) as SearchConfigInput;
    const current = ownConfig();
    const next: SearchConfig = { ...current };
    if (body.provider !== undefined) {
      if (!isSearchProvider(body.provider)) {
        throw searchError('invalid_input', 'provider must be tavily or brave');
      }
      next.provider = body.provider;
    }
    if (body.endpoints !== undefined) {
      if (body.endpoints === null || typeof body.endpoints !== 'object') {
        throw searchError('invalid_input', 'endpoints must be an object');
      }
      const record = body.endpoints as Record<string, unknown>;
      for (const option of SEARCH_PROVIDERS) {
        if (Object.prototype.hasOwnProperty.call(record, option)) {
          next.endpoints = { ...next.endpoints, [option]: normalizeEndpoint(record[option]) };
        }
      }
    }
    if (body.enabled !== undefined) next.enabled = body.enabled === true;
    settings.set(SEARCH_SETTINGS_KEY, JSON.stringify(next), now());
    audit.log('web', 'search.config', SEARCH_AUDIT_TARGET, {
      provider: next.provider,
      enabled: next.enabled,
    });
    return next;
  }

  async function setKey(key: string, provider?: SearchProvider): Promise<void> {
    const target = providerOrConfigured(provider);
    const trimmed = typeof key === 'string' ? key.trim() : '';
    if (trimmed === '') throw searchError('invalid_input', 'API key is required');
    await migrateLegacyKey();
    await keychain.set(KEYCHAIN_SERVICE, accountFor(target), trimmed);
    audit.log('web', 'search.setkey', accountFor(target), { provider: target, keyLength: trimmed.length });
  }

  async function removeKey(provider?: SearchProvider): Promise<void> {
    const target = providerOrConfigured(provider);
    await migrateLegacyKey();
    await keychain.delete(KEYCHAIN_SERVICE, accountFor(target));
    audit.log('web', 'search.unsetkey', accountFor(target), { provider: target });
  }

  async function search(query: string, maxResults?: number): Promise<SearchResult> {
    const trimmed = typeof query === 'string' ? query.trim() : '';
    if (trimmed === '') throw searchError('invalid_input', 'query is required');
    const cfg = config();
    if (!cfg.enabled) {
      throw searchError('disabled', 'internet search is disabled — enable it and store an API key');
    }
    await migrateLegacyKey();
    const key = (await ownKeyFor(cfg.provider)) ?? (await options.shared?.key(cfg.provider)) ?? null;
    if (key === null || key === '') {
      throw searchError('disabled', 'no search API key stored — add one to enable search');
    }
    const requested = typeof maxResults === 'number' ? Math.min(Math.max(1, Math.round(maxResults)), 8) : MAX_HITS;
    const started = Date.now();
    let hits: SearchHit[];
    try {
      if (cfg.provider === 'brave') {
        hits = await braveSearch(trimmed, key, requested);
      } else {
        hits = await tavilySearch(trimmed, key, requested);
      }
    } catch (err) {
      if (err instanceof SearchError) throw err;
      const message = err instanceof Error ? err.message : 'search failed';
      throw searchError('upstream', `search backend failed: ${safe(message)}`);
    }
    audit.log('web', 'search.exec', accountFor(cfg.provider), {
      provider: cfg.provider,
      queryLength: trimmed.length,
      hits: hits.length,
      ms: Date.now() - started,
    });
    return { query: trimmed, hits, provider: cfg.provider, ms: Date.now() - started };
  }

  function endpointFor(provider: SearchProvider): string {
    const cfg = config();
    return cfg.endpoints[provider] ?? SEARCH_DEFAULT_ENDPOINTS[provider];
  }

  function snippet(text: unknown): string | null {
    if (typeof text !== 'string') return null;
    const trimmed = text.trim();
    if (trimmed === '') return null;
    return trimmed.length > MAX_SNIPPET_CHARS ? `${trimmed.slice(0, MAX_SNIPPET_CHARS)}…` : trimmed;
  }

  async function tavilySearch(query: string, key: string, count: number): Promise<SearchHit[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
    try {
      const res = await fetchImpl(endpointFor('tavily'), {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ api_key: key, query, max_results: count }),
        signal: controller.signal,
      });
      if (!res.ok) throw searchError('upstream', `tavily responded ${res.status}`);
      const body: unknown = await res.json();
      const rawResults = body !== null && typeof body === 'object' ? (body as { results?: unknown[] }).results : [];
      const hits: SearchHit[] = [];
      for (const entry of Array.isArray(rawResults) ? rawResults : []) {
        if (entry === null || typeof entry !== 'object') continue;
        const item = entry as { title?: unknown; url?: unknown; content?: unknown };
        if (typeof item.title !== 'string' && typeof item.url !== 'string') continue;
        hits.push({
          title: typeof item.title === 'string' ? item.title.slice(0, 300) : '(untitled)',
          url: typeof item.url === 'string' ? item.url.slice(0, 1000) : '',
          snippet: snippet(item.content),
        });
        if (hits.length >= count) break;
      }
      return hits;
    } catch (err) {
      if (err instanceof SearchError) throw err;
      throw new SearchError(
        err instanceof Error && err.name === 'AbortError' ? 'timeout' : 'upstream',
        err instanceof Error && err.name === 'AbortError' ? 'search timed out' : 'tavily request failed',
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async function braveSearch(query: string, key: string, count: number): Promise<SearchHit[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
    try {
      const url = new URL(endpointFor('brave'));
      url.searchParams.set('q', query);
      url.searchParams.set('count', String(count));
      const res = await fetchImpl(url.toString(), {
        method: 'GET',
        headers: { 'X-Subscription-Token': key, accept: 'application/json' },
        signal: controller.signal,
      });
      if (!res.ok) throw searchError('upstream', `brave responded ${res.status}`);
      const body: unknown = await res.json();
      const rawResults =
        body !== null && typeof body === 'object'
          ? (body as { web?: { results?: unknown[] } }).web?.results
          : undefined;
      const hits: SearchHit[] = [];
      for (const entry of Array.isArray(rawResults) ? rawResults : []) {
        if (entry === null || typeof entry !== 'object') continue;
        const item = entry as { title?: unknown; url?: unknown; description?: unknown };
        if (typeof item.title !== 'string' && typeof item.url !== 'string') continue;
        hits.push({
          title: typeof item.title === 'string' ? item.title.slice(0, 300) : '(untitled)',
          url: typeof item.url === 'string' ? item.url.slice(0, 1000) : '',
          snippet: snippet(item.description),
        });
        if (hits.length >= count) break;
      }
      return hits;
    } catch (err) {
      if (err instanceof SearchError) throw err;
      throw new SearchError(
        err instanceof Error && err.name === 'AbortError' ? 'timeout' : 'upstream',
        err instanceof Error && err.name === 'AbortError' ? 'search timed out' : 'brave request failed',
      );
    } finally {
      clearTimeout(timer);
    }
  }

  return { config, hasKey, keyStatus, updateConfig, setKey, removeKey, search };
}

function safe(message: string): string {
  return message.slice(0, 200);
}
