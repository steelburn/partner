import { useEffect, useRef, useState, type FormEvent } from 'react';
import { sessionLostAction,sessionLostSentence } from './lib/auth-mode.js';
import type { ProviderPurpose, ProviderSummary } from '@partner/shared';
import { isImageCapableModel, PROVIDER_PURPOSES } from '@partner/shared';
import {
  ApiRequestError,
  createPurposeProviders,
  deleteProvider,
  discoverProviderModels,
  listProviders,
  setProviderKey,
  testProvider,
} from './lib/api.js';
import {
  budgetLabel,
  describeHealth,
  normalizeEndpoint,
  parseBudgetDollars,
  purposeLabel,
  remainingBudgetLabel,
  sourceLabel,
  suggestPurposesForAdd,
  validateEndpoint,
} from './lib/providers.js';
import { readStoredToken } from './lib/token.js';
import { McpPanel } from './McpPanel.js';
import { SearchPanel } from './SearchPanel.js';
import { DeviceAccessPanel } from './DeviceAccessPanel.js';

export interface ProvidersViewProps {
  /** Forget the session and return to the pairing gate (auth failure). */
  onUnpair: () => void;
  /** True while this view is the visible one; triggers the first load. */
  active?: boolean;
}

/** True when an ApiRequestError means the core session is gone. */
function isSessionLost(cause: unknown): boolean {
  return (
    cause instanceof ApiRequestError && (cause.status === 401 || cause.status === 403)
  );
}

/**
 * M1 Providers screen (provisional): list + per-row Test/Set key/Delete,
 * an inline purpose-provider setup card (discover + assign models per
 * purpose). Secrets policy: provider keys live only in
 * transient, uncontrolled input fields and are cleared immediately; only the
 * ciphertext produced in this page is ever sent to the core.
 */
export default function ProvidersView({ onUnpair, active }: ProvidersViewProps) {
  const [providers, setProviders] = useState<ProviderSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sessionLost, setSessionLost] = useState(false);
  /** M11 F4: filter the list by provider purpose ('all' = no filter). */
  const [purposeFilter, setPurposeFilter] = useState<ProviderPurpose | 'all'>('all');
  /** Id of a freshly added provider whose Set-key step should auto-open. */
  const [loadedOnce, setLoadedOnce] = useState(false);

  const load = async (): Promise<void> => {
    const token = readStoredToken();
    if (!token) {
      setSessionLost(true);
      return;
    }
    try {
      const list = await listProviders(token);
      setProviders(list);
      setLoadError(null);
    } catch (cause) {
      if (isSessionLost(cause)) {
        setSessionLost(true);
        return;
      }
      setLoadError(cause instanceof Error ? cause.message : 'Could not load providers.');
    }
  };

  useEffect(() => {
    // Load once, the first time the tab becomes the visible view (both views
    // stay mounted when paired, so switching back never refetches).
    if (!active || loadedOnce) return;
    setLoadedOnce(true);
    void load();
    // Intended: load on first activation; row mutations update local state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, loadedOnce]);

  const replaceProvider = (next: ProviderSummary): void => {
    setProviders((prev) => prev?.map((p) => (p.id === next.id ? next : p)) ?? prev);
  };

  const removeProvider = (id: string): void => {
    setProviders((prev) => prev?.filter((p) => p.id !== id) ?? prev);
  };

  const appendProviders = (created: ProviderSummary[]): void => {
    setProviders((prev) => [...(prev ?? []), ...created]);
  };

  const handleSessionLost = (): void => setSessionLost(true);

  const panelIntro =
    'Endpoints Partner may call, with keys kept in your OS keychain. Add an OpenAI-compatible endpoint, then test it from here.';

  const scrollToCard = (id: string): void => {
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <section className="providers" aria-label="Providers">
      <div className="providers-panel">
        <div className="page-head">
          <div className="page-head-titles">
            <div className="kicker">Model access</div>
            <h1 className="page-title">Providers</h1>
          </div>
        </div>
        <p className="page-copy">{panelIntro}</p>

        {sessionLost ? (
          <div className="providers-alert" role="alert">
            <p className="providers-alert-text">
              {sessionLostSentence('manage providers')}
            </p>
            <button type="button" className="btn btn-secondary" onClick={onUnpair}>
              {sessionLostAction()}
            </button>
          </div>
        ) : null}

        {!sessionLost && providers === null ? (
          <p className="providers-loading" aria-busy="true">
            Loading providers…
          </p>
        ) : !sessionLost && loadError ? (
          <div className="providers-alert" role="alert">
            <p className="providers-alert-text">{loadError}</p>
            <button type="button" className="btn btn-secondary" onClick={() => void load()}>
              Try again
            </button>
          </div>
        ) : null}

        {!sessionLost && providers !== null && providers.length === 0 && !loadError ? (
          <div className="empty-state">
            <p className="empty-state-title">No providers connected</p>
            <p className="empty-state-copy">
              Nothing can call a model yet. Add your OpenAI-compatible endpoint once below and
              Partner creates a provider per purpose (General, Cheap, Deep, Coding, Vision,
              Research) — keys stay in your OS keychain.
            </p>
            <div className="empty-actions">
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => scrollToCard('purpose-bundle-card')}
              >
                Set up purpose providers
              </button>
            </div>
          </div>
        ) : null}

        {!sessionLost && providers !== null && providers.length > 0 ? (
          <>
            <div className="purpose-filter" role="group" aria-label="Filter by purpose">
              {(['all', ...PROVIDER_PURPOSES] as Array<ProviderPurpose | 'all'>).map((purpose) => (
                <button
                  key={purpose}
                  type="button"
                  className="btn btn-secondary btn-sm view-tab"
                  aria-pressed={purposeFilter === purpose}
                  onClick={() => setPurposeFilter(purpose)}
                >
                  {purpose === 'all' ? 'All' : purposeLabel(purpose)}
                </button>
              ))}
            </div>
            <ul className="provider-list">
              {providers
                .filter((p) => purposeFilter === 'all' || p.purpose === purposeFilter)
                .map((provider) => (
                  <li key={provider.id} className="provider-card">
                    <ProviderRow
                      provider={provider}
                      onUpdated={replaceProvider}
                      onRemoved={removeProvider}
                      onSessionLost={handleSessionLost}
                    />
                  </li>
                ))}
            </ul>
          </>
        ) : null}

        <PurposeBundleCard
          disabled={sessionLost}
          onAddedMany={appendProviders}
          onSessionLost={handleSessionLost}
          providers={providers ?? []}
        />
        <McpPanel onUnpair={handleSessionLost} />
        <SearchPanel onUnpair={handleSessionLost} />
        <DeviceAccessPanel onUnpair={handleSessionLost} />
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Provider row
// ---------------------------------------------------------------------------

type RowOp = 'test' | 'set-key' | 'delete';

interface ProviderRowProps {
  provider: ProviderSummary;
  /** Auto-open the Set-key step (freshly added provider). */
  onUpdated: (next: ProviderSummary) => void;
  onRemoved: (id: string) => void;
  onSessionLost: () => void;
}

function ProviderRow({ provider, onUpdated, onRemoved, onSessionLost }: ProviderRowProps) {
  const [busy, setBusy] = useState<RowOp | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [keyOpen, setKeyOpen] = useState(false);
  const keyRef = useRef<HTMLInputElement | null>(null);

  const handleOpError = (cause: unknown): void => {
    if (isSessionLost(cause)) {
      onSessionLost();
      return;
    }
    if (cause instanceof ApiRequestError) {
      setRowError(cause.message);
      return;
    }
    setRowError('Could not reach the Partner core.');
  };

  const toggleKey = (): void => {
    setConfirming(false);
    setRowError(null);
    // Toggling off also wipes any pasted key from the input (never leave a
    // secret in the DOM for the next open).
    if (keyOpen && keyRef.current) keyRef.current.value = '';
    setKeyOpen((open) => !open);
  };

  const handleTest = async (): Promise<void> => {
    if (busy) return;
    const token = readStoredToken();
    if (!token) {
      onSessionLost();
      return;
    }
    setConfirming(false);
    setBusy('test');
    setRowError(null);
    try {
      onUpdated(await testProvider(token, provider.id));
    } catch (cause) {
      handleOpError(cause);
    } finally {
      setBusy(null);
    }
  };

  const saveKey = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (busy) return;
    const token = readStoredToken();
    if (!token) {
      onSessionLost();
      return;
    }
    const key = (keyRef.current?.value ?? '').trim();
    if (key.length === 0) {
      setRowError('Paste the provider API key first.');
      return;
    }
    setConfirming(false);
    setBusy('set-key');
    setRowError(null);
    try {
      await setProviderKey(token, provider.id, key);
      if (keyRef.current) keyRef.current.value = '';
      setKeyOpen(false);
    } catch (cause) {
      handleOpError(cause);
    } finally {
      setBusy(null);
    }
  };

  const handleDelete = async (): Promise<void> => {
    if (busy) return;
    // Two-step confirm: the first press arms the button, the second deletes.
    if (!confirming) {
      setConfirming(true);
      return;
    }
    const token = readStoredToken();
    if (!token) {
      onSessionLost();
      return;
    }
    setBusy('delete');
    setRowError(null);
    try {
      await deleteProvider(token, provider.id);
      onRemoved(provider.id);
    } catch (cause) {
      setConfirming(false);
      handleOpError(cause);
    } finally {
      setBusy(null);
    }
  };

  const chips = provider.defaultModels.length > 0 ? provider.defaultModels : provider.health.models;
  const modelCount = provider.defaultModels.length || provider.health.models.length;
  const health = describeHealth(provider.health, modelCount);
  const budget = budgetLabel(provider.budgetCents);
  // M10: the providers list carries current window spend for budgeted
  // providers — show how much of the cap is left this window.
  const withSpend = provider as ProviderSummary & { spentCents?: number | null };
  const remaining =
    withSpend.spentCents === undefined || withSpend.spentCents === null
      ? null
      : remainingBudgetLabel(provider.budgetCents, withSpend.spentCents);
  const idle = busy === null;

  return (
    <article className="provider-card-inner">
      <div className="provider-card-head">
        <div className="provider-identity">
          <h3 className="provider-name">{provider.name}</h3>
          <span className="source-badge">{sourceLabel(provider.source)}</span>
          <span className="source-badge purpose-badge">{purposeLabel(provider.purpose)}</span>
        </div>
        <div className="row-actions">
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => void handleTest()}
            disabled={!idle}
            aria-busy={busy === 'test'}
          >
            {busy === 'test' ? 'Testing…' : 'Test'}
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={toggleKey}
            disabled={!idle}
            aria-expanded={keyOpen}
          >
            {keyOpen ? 'Close key' : 'Set key'}
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-sm btn-danger"
            onClick={() => void handleDelete()}
            disabled={!idle}
            aria-busy={busy === 'delete'}
            aria-label={
              confirming ? `Confirm deleting ${provider.name}` : `Delete provider ${provider.name}`
            }
          >
            {busy === 'delete' ? 'Deleting…' : confirming ? 'Confirm delete' : 'Delete'}
          </button>
        </div>
      </div>

      <p className="provider-endpoint">{provider.endpoint}</p>

      {chips.length > 0 ? (
        <div className="model-chips" aria-label="Default models">
          {chips.map((model) => (
            <span key={model} className="chip">
              {model}
            </span>
          ))}
        </div>
      ) : null}

      <p className={`health health-${health.tone}`}>{health.text}</p>
      {budget ? (
        <p className="provider-budget">
          {budget}
          {remaining ? ` · ${remaining}` : ''}
        </p>
      ) : null}

      {keyOpen ? (
        <form
          className="row-form"
          onSubmit={(event) => void saveKey(event)}
          aria-busy={busy === 'set-key'}
        >
          <label className="label" htmlFor={`provider-key-${provider.id}`}>
            API key
          </label>
          <div className="row-form-line">
            <input
              id={`provider-key-${provider.id}`}
              ref={keyRef}
              className="field key-field"
              type="password"
              autoComplete="new-password"
              spellCheck={false}
              autoFocus
              placeholder="Paste the API key"
              aria-label={`API key for ${provider.name}`}
              disabled={!idle}
            />
            <button type="submit" className="btn btn-primary" disabled={!idle}>
              {busy === 'set-key' ? 'Saving…' : 'Save'}
            </button>
            <button type="button" className="btn btn-secondary" onClick={toggleKey} disabled={!idle}>
              Cancel
            </button>
          </div>
        </form>
      ) : null}

      {rowError ? (
        <p className="row-error" role="alert">
          {rowError}
        </p>
      ) : null}
    </article>
  );
}

// ---------------------------------------------------------------------------
// M13 purpose-provider bundle (PLAN-M13.md F2)

interface PurposeBundleCardProps {
  disabled: boolean;
  onAddedMany: (created: ProviderSummary[]) => void;
  onSessionLost: () => void;
  /** All existing provider profiles — drives the pre-ticked purpose defaults. */
  providers: ProviderSummary[];
}

/**
 * Add one OpenAI-compatible endpoint + key and get one provider profile PER
 * purpose (General | Cheap | Deep | Coding | Vision | Research). Step 1
 * discovers the endpoint's models (one upstream /models call, nothing
 * persisted); step 2 lets the user pin which models each purpose profile
 * carries — the FIRST pinned model is that purpose's default when a persona
 * has no override. The single key is stored by the core into each profile's
 * own keychain item.
 */
function PurposeBundleCard({ disabled, onAddedMany, onSessionLost, providers }: PurposeBundleCardProps) {
  const [endpoint, setEndpoint] = useState('');
  const [key, setKey] = useState('');
  const [selected, setSelected] = useState<ReadonlySet<ProviderPurpose>>(new Set());
  /** True once the user touches the purpose ticks — stop auto-suggesting. */
  const touchedPurposes = useRef(false);
  /** Models the endpoint reported (null = step 1 not run yet). */
  const [models, setModels] = useState<string[] | null>(null);
  /** purpose -> pinned models (kept in the endpoint's model order). */
  const [pins, setPins] = useState<Partial<Record<ProviderPurpose, string[]>>>({});
  /** Optional USD budget applied to EVERY created purpose profile (null = off). */
  const [budget, setBudget] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  // Keep the pre-ticked purposes in step with reality UNTIL the user picks
  // for themselves: no providers -> all six; same endpoint -> only the
  // purposes it lacks; new endpoint alongside others -> none (tick what this
  // endpoint is FOR, e.g. Vision only for a second vision provider).
  useEffect(() => {
    if (touchedPurposes.current) return;
    setSelected(new Set(suggestPurposesForAdd(endpoint, providers)));
    // Intended: providers/endpoint drive the suggestion; manual edits win.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providers]);

  const toggle = (purpose: ProviderPurpose): void => {
    touchedPurposes.current = true;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(purpose)) next.delete(purpose);
      else next.add(purpose);
      return next;
    });
  };

  const tickAll = (all: boolean): void => {
    touchedPurposes.current = true;
    setSelected(all ? new Set(PROVIDER_PURPOSES) : new Set());
  };

  /** Default assignment mirrors the core heuristic: vision keeps models that
   *  can see images; every other purpose gets the full list. Restricted to
   *  the purposes the user ticked. */
  const defaultPinsFor = (
    purposes: ProviderPurpose[],
    list: string[],
  ): Partial<Record<ProviderPurpose, string[]>> => {
    const visionModels = list.filter(isImageCapableModel);
    const next: Partial<Record<ProviderPurpose, string[]>> = {};
    for (const purpose of purposes) {
      next[purpose] =
        purpose === 'vision' && visionModels.length > 0 ? visionModels : [...list];
    }
    return next;
  };

  const handleDiscover = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (busy || disabled) return;
    const token = readStoredToken();
    if (!token) {
      onSessionLost();
      return;
    }
    const endpointError = validateEndpoint(endpoint);
    if (endpointError) {
      setError(endpointError);
      return;
    }
    if (key.trim().length === 0) {
      setError('The API key is required to list the endpoint\u2019s models.');
      return;
    }
    // Apply the purpose suggestion unless the user picked their own set, and
    // never discover models for zero purposes.
    const suggested = touchedPurposes.current
      ? PROVIDER_PURPOSES.filter((p) => selected.has(p))
      : suggestPurposesForAdd(endpoint, providers);
    if (suggested.length === 0) {
      setError(
        'Pick at least one purpose — tick only the purposes this endpoint should serve (e.g. Vision only for a dedicated vision provider).',
      );
      return;
    }
    if (!touchedPurposes.current) {
      setSelected(new Set(suggested));
    }
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const result = await discoverProviderModels(token, {
        endpoint: normalizeEndpoint(endpoint),
        key: key.trim(),
      });
      setModels(result.models);
      setPins(defaultPinsFor(suggested, result.models));
      setError(null);
      setNote(
        result.models.length > 0
          ? `Found ${result.models.length} model${result.models.length === 1 ? '' : 's'} — assign them to purposes below.`
          : 'The endpoint reported no models. You can still add the purpose profiles — set the model ids per persona in Personas (or per message in the chat picker) afterwards.',
      );
    } catch (cause) {
      if (isSessionLost(cause)) {
        onSessionLost();
        return;
      }
      setError(cause instanceof Error ? cause.message : 'Could not reach that endpoint.');
    } finally {
      setBusy(false);
    }
  };

  const selectedPurposes = PROVIDER_PURPOSES.filter((p) => selected.has(p));
  /** True when the endpoint reported models to pin per purpose. */
  const canPinModels = (models ?? []).length > 0;

  const toggleModel = (purpose: ProviderPurpose, model: string): void => {
    setPins((prev) => {
      const current = prev[purpose] ?? [];
      const has = current.includes(model);
      const chosen = new Set(has ? current.filter((m) => m !== model) : [...current, model]);
      // Keep the endpoint's model order — the first pinned model is default.
      const ordered = (models ?? []).filter((m) => chosen.has(m));
      return { ...prev, [purpose]: ordered };
    });
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (busy || disabled) return;
    if (canPinModels) {
      const missing = selectedPurposes.filter(
        (p) => (pins[p] ?? []).length === 0,
      );
      if (missing.length > 0) {
        setError(
          `Pick at least one model for ${missing.map((p) => purposeLabel(p)).join(', ')}, or uncheck ${missing.length === 1 ? 'that purpose' : 'those purposes'} above.`,
        );
        return;
      }
    }
    const parsedBudget = parseBudgetDollars(budget);
    if (!parsedBudget.ok) {
      setError(parsedBudget.error);
      return;
    }
    const token = readStoredToken();
    if (!token) {
      onSessionLost();
      return;
    }
    const modelPins = Object.fromEntries(
      selectedPurposes.map((p) => [p, pins[p] ?? []]),
    ) as Record<ProviderPurpose, string[]>;
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const result = await createPurposeProviders(token, {
        endpoint: normalizeEndpoint(endpoint),
        key: key.trim(),
        purposes: selectedPurposes,
        ...(canPinModels ? { modelPins } : {}),
        ...(parsedBudget.budgetCents !== null
          ? { budgetCents: parsedBudget.budgetCents }
          : {}),
      });
      setEndpoint('');
      setKey('');
      setBudget('');
      setModels(null);
      setPins({});
      setSelected(new Set());
      touchedPurposes.current = false;
      const names = result.created.map((p) => purposeLabel(p.purpose)).join(', ');
      setNote(`Added ${result.created.length} purpose provider${result.created.length === 1 ? '' : 's'} (${names}).`);
      onAddedMany(result.created);
    } catch (cause) {
      if (isSessionLost(cause)) {
        onSessionLost();
        return;
      }
      setError(cause instanceof Error ? cause.message : 'Could not add the purpose providers.');
    } finally {
      setBusy(false);
    }
  };

  const formDisabled = busy || disabled;

  return (
    <section className="card bundle-card" id="purpose-bundle-card" aria-label="Add purpose providers">
      <h2 className="card-title">Add purpose providers</h2>
      <p className="card-copy">
        One endpoint + one key creates a provider profile per purpose — General, Cheap, Deep,
        Coding, Vision and Research. Discover the endpoint&rsquo;s models, then choose which model
        each purpose uses; routing prefers the matching purpose profile automatically. The key is
        stored once per profile in your OS keychain and never in Partner.
      </p>

      <form className="form-stack" onSubmit={(event) => void (models === null ? handleDiscover(event) : handleSubmit(event))} aria-busy={busy}>
        {models === null ? (
          <>
            <div className="form-field">
              <label className="label" htmlFor="bundle-endpoint">
                Endpoint
              </label>
              <input
                id="bundle-endpoint"
                className="field"
                type="text"
                inputMode="url"
                autoComplete="off"
                spellCheck={false}
                value={endpoint}
                disabled={formDisabled}
                onChange={(event) => setEndpoint(event.target.value)}
                placeholder="https://api.ne1.dev/v1"
                aria-required="true"
              />
            </div>
            <div className="form-field">
              <label className="label" htmlFor="bundle-key">
                API key
              </label>
              <input
                id="bundle-key"
                className="field key-field"
                type="password"
                autoComplete="new-password"
                spellCheck={false}
                value={key}
                disabled={formDisabled}
                onChange={(event) => setKey(event.target.value)}
                placeholder="Paste the API key — one key for all purpose profiles"
                aria-required="true"
              />
              <p className="field-hint">
                Sent once over the loopback to list the endpoint&rsquo;s models, then stored per
                profile in the OS keychain. Cleared here after adding.
              </p>
            </div>
            <div className="form-field">
              <label className="label" htmlFor="bundle-budget">
                Budget per provider, USD (optional)
              </label>
              <input
                id="bundle-budget"
                className="field"
                type="text"
                inputMode="decimal"
                autoComplete="off"
                value={budget}
                disabled={formDisabled}
                onChange={(event) => setBudget(event.target.value)}
                placeholder="2.50"
              />
              <p className="field-hint">
                Applied to every created purpose profile; an empty budget means no cap. Remove a
                profile to drop its cap.
              </p>
            </div>
            <div className="bundle-purposes" role="group" aria-label="Purposes to create">
              <div className="bundle-purposes-head">
                <span className="label bundle-purposes-legend">Purposes</span>
                <span className="bundle-purposes-actions">
                  <button
                    type="button"
                    className="btn-link"
                    onClick={() => tickAll(true)}
                    disabled={formDisabled}
                  >
                    All
                  </button>
                  <button
                    type="button"
                    className="btn-link"
                    onClick={() => tickAll(false)}
                    disabled={formDisabled}
                  >
                    None
                  </button>
                </span>
              </div>
              <div className="bundle-purpose-row" role="group">
                {PROVIDER_PURPOSES.map((purpose) => (
                  <label key={purpose} className="bundle-purpose-pick">
                    <input
                      type="checkbox"
                      checked={selected.has(purpose)}
                      disabled={formDisabled}
                      onChange={() => toggle(purpose)}
                      aria-label={`${purposeLabel(purpose)} provider`}
                    />
                    {purposeLabel(purpose)}
                  </label>
                ))}
              </div>
              <p className="field-hint">
                Tick only the purposes this endpoint should serve. If you already have purpose
                providers for another endpoint, a dedicated endpoint usually adds just one — for
                example Vision for a second vision provider.
              </p>
            </div>
            <div className="form-actions">
              <button type="submit" className="btn btn-primary" disabled={formDisabled}>
                {busy ? 'Discovering…' : 'Discover models'}
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="bundle-assign" role="group" aria-label="Assign models to purposes">
              {canPinModels ? (
                <p className="form-hint bundle-assign-heading">
                  Pick which model(s) each purpose may use. The first picked model is that
                  purpose&rsquo;s default when a persona has no override — these models also show in
                  the chat model picker under each purpose.
                </p>
              ) : (
                <p className="form-hint bundle-assign-heading" role="status">
                  This endpoint reported no models, so the purpose profiles are added without
                  defaults. Set a model id per persona in Personas (or per message in the chat
                  picker) to use them.
                </p>
              )}
              {selectedPurposes.map((purpose) => (
                <div key={purpose} className="bundle-assign-row">
                  <span className="bundle-assign-purpose">{purposeLabel(purpose)}</span>
                  <div className="bundle-assign-models">
                    {(models ?? []).map((model) => {
                      const on = (pins[purpose] ?? []).includes(model);
                      return (
                        <label
                          key={model}
                          className={on ? 'chip bundle-model-chip is-on' : 'chip bundle-model-chip'}
                        >
                          <input
                            type="checkbox"
                            checked={on}
                            disabled={formDisabled}
                            onChange={() => toggleModel(purpose, model)}
                            aria-label={`${model}${isImageCapableModel(model) ? ' (vision)' : ''} for ${purposeLabel(purpose)}`}
                          />
                          {model}
                          {isImageCapableModel(model) ? ' · vision' : ''}
                        </label>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
            <div className="form-actions bundle-assign-actions">
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => {
                  setModels(null);
                  setNote(null);
                  setError(null);
                }}
                disabled={formDisabled}
              >
                ‹ Endpoint
              </button>
              <button type="submit" className="btn btn-primary" disabled={formDisabled}>
                {busy ? 'Adding…' : 'Add purpose providers'}
              </button>
            </div>
          </>
        )}
        <div className="form-feedback" aria-live="polite">
          {error ? (
            <p className="form-error" role="alert">
              {error}
            </p>
          ) : note ? (
            <p className="success-note">{note}</p>
          ) : null}
        </div>
      </form>
    </section>
  );
}


