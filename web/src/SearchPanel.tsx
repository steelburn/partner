/**
 * M11 F2 search panel (PLAN-M11.md).
 *
 * Configure the optional API-key search backend (Tavily/Brave): enable,
 * endpoint override, keychain-held key, and a manual test search. Enabling
 * also lets an auto+ persona use the `search` tool in chat. Token-styled.
 */
import { useEffect, useState } from 'react';
import type { SearchProvider, SearchResult } from '@partner/shared';
import { SEARCH_PROVIDERS } from '@partner/shared';
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

export function SearchPanel({ onUnpair }: SearchPanelProps) {
  const [config, setConfig] = useState<(SearchConfigLike) | null>(null);
  const [provider, setProvider] = useState<SearchProvider>('tavily');
  const [endpoint, setEndpoint] = useState('');
  const [keyDraft, setKeyDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [searchBusy, setSearchBusy] = useState(false);
  const [result, setResult] = useState<SearchResult | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);

  interface SearchConfigLike {
    enabled: boolean;
    provider: SearchProvider;
    endpoint: string | null;
    hasKey: boolean;
  }

  const load = async (): Promise<void> => {
    const token = readStoredToken();
    if (!token) {
      onUnpair();
      return;
    }
    try {
      const cfg = await getSearchConfig(token);
      setConfig(cfg);
      setProvider(cfg.provider);
      setEndpoint(cfg.endpoint ?? '');
      setError(null);
    } catch (cause) {
      if ((cause as { status?: number }).status === 401 || (cause as { status?: number }).status === 403) {
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

  const saveConfig = async (enabled: boolean): Promise<void> => {
    const token = tokenOf();
    if (token === '') return;
    setBusy(true);
    setError(null);
    try {
      const next = await updateSearchConfig(token, {
        enabled,
        provider,
        endpoint: endpoint.trim() === '' ? null : endpoint.trim(),
      });
      setConfig(next);
      setProvider(next.provider);
      setEndpoint(next.endpoint ?? '');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save the search config.');
    } finally {
      setBusy(false);
    }
  };

  const storeKey = async (): Promise<void> => {
    const token = tokenOf();
    if (token === '') return;
    setBusy(true);
    setError(null);
    try {
      await setSearchKey(token, keyDraft.trim());
      setKeyDraft('');
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not store the API key.');
    } finally {
      setBusy(false);
    }
  };

  const clearKey = async (): Promise<void> => {
    const token = tokenOf();
    if (token === '') return;
    setBusy(true);
    setError(null);
    try {
      await removeSearchKey(token);
      await load();
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
        One optional API-key search backend. OFF until you enable it and store a key. When
        enabled: <strong>auto</strong> and <strong>autonomous</strong> personas can use the{' '}
        <code className="md-code-inline">search</code> tool in chat directly; at{' '}
        <strong>suggest</strong> the persona asks and you approve from the Files queue; assist
        never runs tools. You can also search right here. Your key lives in the OS keychain.
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
          onClick={() => void saveConfig(!config?.enabled)}
          disabled={busy}
        >
          {config?.enabled ? 'Disable' : 'Enable'}
        </button>
        <label className="search-provider-field">
          Provider
          <select
            className="field"
            value={provider}
            disabled={busy}
            onChange={(event) => setProvider(event.target.value as SearchProvider)}
          >
            {SEARCH_PROVIDERS.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>
        <label className="search-endpoint-field">
          Endpoint (optional)
          <input
            className="field"
            type="text"
            value={endpoint}
            disabled={busy}
            onChange={(event) => setEndpoint(event.target.value)}
            placeholder="https://api.tavily.com/search"
          />
        </label>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={() => void saveConfig(config?.enabled ?? false)}
          disabled={busy}
        >
          Save config
        </button>
      </div>
      <p className="form-hint">{providerHint(provider)}</p>

      <div className="search-key-row">
        {config?.hasKey ? (
          <>
            <span className="source-badge">API key stored</span>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => void clearKey()} disabled={busy}>
              Remove key
            </button>
          </>
        ) : (
          <>
            <input
              className="field"
              type="password"
              value={keyDraft}
              disabled={busy}
              onChange={(event) => setKeyDraft(event.target.value)}
              placeholder="API key (sk-…)"
              aria-label="Search API key"
            />
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => void storeKey()} disabled={busy || keyDraft.trim() === ''}>
              Store key
            </button>
          </>
        )}
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
