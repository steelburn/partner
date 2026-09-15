/**
 * M11 F2 search panel (PLAN-M11.md).
 *
 * Two provider cards (Tavily/Brave). Each card owns its keychain-held key and
 * optional endpoint override; the radio picks which provider is active for
 * chat and the manual test search. Enabling unlocks the `search` tool for
 * auto+ personas. Token-styled.
 */
import { useEffect, useState } from 'react';
import type { SearchProvider, SearchResult } from '@partner/shared';
import { SEARCH_DEFAULT_ENDPOINTS, SEARCH_PROVIDERS } from '@partner/shared';
import {
  getSearchConfig,
  removeSearchKey,
  runSearch,
  setSearchKey,
  updateSearchConfig,
} from './lib/search.js';
import { readStoredToken } from './lib/token.js';

export interface SearchPanelProps {
  onUnpair: () => void;
}

function providerHint(provider: SearchProvider): string {
  return provider === 'tavily'
    ? 'api.tavily.com — POST /search with an api_key'
    : 'api.search.brave.com — GET /res/v1/web/search with a subscription token';
}

interface SearchConfigLike {
  enabled: boolean;
  provider: SearchProvider;
  endpoints: Record<SearchProvider, string | null>;
  hasKey: boolean;
  keys: Record<SearchProvider, boolean>;
}

const emptyDrafts = (): Record<SearchProvider, string> => ({ tavily: '', brave: '' });

function isAuthError(cause: unknown): boolean {
  const status = (cause as { status?: number }).status;
  return status === 401 || status === 403;
}

export function SearchPanel({ onUnpair }: SearchPanelProps) {
  const [config, setConfig] = useState<SearchConfigLike | null>(null);
  const [provider, setProvider] = useState<SearchProvider>('tavily');
  const [endpointDrafts, setEndpointDrafts] = useState<Record<SearchProvider, string>>(emptyDrafts);
  const [keyDrafts, setKeyDrafts] = useState<Record<SearchProvider, string>>(emptyDrafts);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [searchBusy, setSearchBusy] = useState(false);
  const [result, setResult] = useState<SearchResult | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);

  const applyConfig = (next: SearchConfigLike, resetEndpoints = false): void => {
    setConfig(next);
    setProvider(next.provider);
    if (resetEndpoints) {
      setEndpointDrafts({
        tavily: next.endpoints.tavily ?? '',
        brave: next.endpoints.brave ?? '',
      });
    }
  };

  const load = async (): Promise<void> => {
    const token = readStoredToken();
    if (!token) {
      onUnpair();
      return;
    }
    try {
      const cfg = await getSearchConfig(token);
      applyConfig(cfg, true);
      setError(null);
    } catch (cause) {
      if (isAuthError(cause)) {
        onUnpair();
        return;
      }
      setError(cause instanceof Error ? cause.message : 'Could not load the search config.');
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const tokenOf = (): string => {
    const token = readStoredToken();
    if (!token) {
      onUnpair();
      return '';
    }
    return token;
  };

  const saveEnabled = async (enabled: boolean): Promise<void> => {
    const token = tokenOf();
    if (token === '') return;
    setBusy(true);
    setError(null);
    try {
      applyConfig(await updateSearchConfig(token, { enabled, provider }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save the search config.');
    } finally {
      setBusy(false);
    }
  };

  const selectProvider = async (option: SearchProvider): Promise<void> => {
    if (option === config?.provider) return;
    const token = tokenOf();
    if (token === '') return;
    const previous = provider;
    setProvider(option);
    setBusy(true);
    setError(null);
    try {
      applyConfig(await updateSearchConfig(token, { provider: option }));
    } catch (cause) {
      setProvider(previous);
      setError(cause instanceof Error ? cause.message : 'Could not select the search provider.');
    } finally {
      setBusy(false);
    }
  };

  const saveEndpoint = async (target: SearchProvider): Promise<void> => {
    const token = tokenOf();
    if (token === '') return;
    const trimmed = endpointDrafts[target].trim();
    setBusy(true);
    setError(null);
    try {
      applyConfig(
        await updateSearchConfig(token, { endpoints: { [target]: trimmed === '' ? null : trimmed } }),
        true,
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save the endpoint.');
    } finally {
      setBusy(false);
    }
  };

  const storeKey = async (target: SearchProvider): Promise<void> => {
    const token = tokenOf();
    if (token === '') return;
    const draft = keyDrafts[target].trim();
    if (draft === '') return;
    setBusy(true);
    setError(null);
    try {
      await setSearchKey(token, draft, target);
      setKeyDrafts((current) => ({ ...current, [target]: '' }));
      setConfig(await getSearchConfig(token));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not store the API key.');
    } finally {
      setBusy(false);
    }
  };

  const clearKey = async (target: SearchProvider): Promise<void> => {
    const token = tokenOf();
    if (token === '') return;
    setBusy(true);
    setError(null);
    try {
      await removeSearchKey(token, target);
      setConfig(await getSearchConfig(token));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not remove the API key.');
    } finally {
      setBusy(false);
    }
  };

  const trySearch = async (): Promise<void> => {
    const token = tokenOf();
    if (token === '') return;
    setSearchBusy(true);
    setSearchError(null);
    setResult(null);
    try {
      setResult(await runSearch(token, query.trim()));
    } catch (cause) {
      setSearchError(cause instanceof Error ? cause.message : 'Search failed.');
    } finally {
      setSearchBusy(false);
    }
  };

  return (
    <section className="card add-card" aria-label="Search">
      <h2 className="card-title">Internet search</h2>
      <p className="card-copy">
        Two optional API-key search backends. Each keeps its own key, so you can store both and
        pick which one to use. OFF until you enable it and store a key. When enabled:{' '}
        <strong>auto</strong> and <strong>autonomous</strong> personas can use the{' '}
        <code className="md-code-inline">search</code> tool in chat directly; at{' '}
        <strong>suggest</strong> the persona asks and you approve from the Files queue; assist
        never runs tools. You can also search right here. Your keys live in the OS keychain.
      </p>

      {error !== null ? (
        <p className="chat-attach-error" role="alert">
          {error}
        </p>
      ) : null}

      <div className="search-config-row">
        <span className="source-badge">{config?.enabled ? 'Enabled' : 'Off'}</span>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={() => void saveEnabled(!config?.enabled)}
          disabled={busy}
        >
          {config?.enabled ? 'Disable' : 'Enable'}
        </button>
        <span className="form-hint">Choosing a provider saves it right away.</span>
      </div>

      <div className="search-provider-cards" role="radiogroup" aria-label="Search provider">
        {SEARCH_PROVIDERS.map((option) => {
          const selected = provider === option;
          const stored = config?.keys?.[option] === true;
          const savedEndpoint = config?.endpoints[option] ?? '';
          const endpointDirty = endpointDrafts[option].trim() !== savedEndpoint.trim();
          return (
            <div
              key={option}
              className={`search-provider-card${selected ? ' is-selected' : ''}`}
            >
              <div className="search-provider-head">
                <label className="search-provider-choice">
                  <input
                    type="radio"
                    name="search-provider"
                    value={option}
                    checked={selected}
                    disabled={busy}
                    onChange={() => void selectProvider(option)}
                  />
                  <span className="search-provider-name">{option}</span>
                </label>
                {selected ? <span className="source-badge">In use</span> : null}
              </div>
              <p className="search-provider-hint">{providerHint(option)}</p>

              <div className="search-key-row">
                {stored ? (
                  <>
                    <span className="source-badge">Key stored</span>
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      onClick={() => void clearKey(option)}
                      disabled={busy}
                    >
                      Remove key
                    </button>
                  </>
                ) : (
                  <>
                    <input
                      className="field"
                      type="password"
                      value={keyDrafts[option]}
                      disabled={busy}
                      onChange={(event) =>
                        setKeyDrafts((current) => ({ ...current, [option]: event.target.value }))
                      }
                      placeholder="API key (sk-…)"
                      aria-label={`${option} API key`}
                    />
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      onClick={() => void storeKey(option)}
                      disabled={busy || keyDrafts[option].trim() === ''}
                    >
                      Store key
                    </button>
                  </>
                )}
              </div>

              <label className="search-endpoint-field">
                Endpoint (optional)
                <input
                  className="field"
                  type="text"
                  value={endpointDrafts[option]}
                  disabled={busy}
                  onChange={(event) =>
                    setEndpointDrafts((current) => ({ ...current, [option]: event.target.value }))
                  }
                  placeholder={SEARCH_DEFAULT_ENDPOINTS[option]}
                  aria-label={`${option} endpoint`}
                />
              </label>
              <div className="search-endpoint-actions">
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => void saveEndpoint(option)}
                  disabled={busy || !endpointDirty}
                >
                  Save endpoint
                </button>
              </div>
            </div>
          );
        })}
      </div>

      <div className="search-try-row">
        <input
          className="field"
          type="text"
          value={query}
          disabled={searchBusy}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Try: latest partner coding news"
          aria-label="Search query"
        />
        <button
          type="button"
          className="btn btn-primary btn-sm"
          onClick={() => void trySearch()}
          disabled={searchBusy || query.trim() === ''}
          aria-busy={searchBusy}
        >
          {searchBusy ? 'Searching…' : 'Search'}
        </button>
      </div>
      {searchError !== null ? (
        <p className="chat-attach-error" role="alert">
          {searchError}
        </p>
      ) : null}
      {result !== null ? (
        <ul className="search-results" role="list">
          {result.hits.length === 0 ? (
            <li className="rail-note">No results.</li>
          ) : (
            result.hits.map((hit, index) => (
              <li key={`${hit.url}-${index}`} className="search-result">
                <a href={hit.url} target="_blank" rel="noopener noreferrer" className="search-result-title">
                  {hit.title}
                </a>
                {hit.snippet ? <span className="search-result-snippet">{hit.snippet}</span> : null}
              </li>
            ))
          )}
        </ul>
      ) : null}
    </section>
  );
}
