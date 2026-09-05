import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { ProviderInput, ProviderPurpose, ProviderSummary } from '@partner/shared';
import { PROVIDER_PURPOSES } from '@partner/shared';
import {
  ApiRequestError,
  connectSelfService,
  createProvider,
  deleteProvider,
  fetchSelfServiceLoginKey,
  listProviders,
  setProviderKey,
  testProvider,
} from './lib/api.js';
import { encryptPasswordWithPublicKey } from './lib/cryptoEnvelope.js';
import {
  budgetLabel,
  describeHealth,
  normalizeEndpoint,
  parseBudgetDollars,
  parseModelList,
  purposeLabel,
  remainingBudgetLabel,
  sourceLabel,
  validateEndpoint,
} from './lib/providers.js';
import { readStoredToken } from './lib/token.js';
import { McpPanel } from './McpPanel.js';

export interface ProvidersViewProps {
  /** Forget the session and return to the pairing gate (auth failure). */
  onUnpair: () => void;
  /** True while this view is the visible one; triggers the first load. */
  active?: boolean;
}

const IMPORT_DEFAULT_ENDPOINT = 'https://enter.ne1.dev';

/** True when an ApiRequestError means the core session is gone. */
function isSessionLost(cause: unknown): boolean {
  return (
    cause instanceof ApiRequestError && (cause.status === 401 || cause.status === 403)
  );
}

/**
 * M1 Providers screen (provisional): list + per-row Test/Set key/Delete,
 * an inline "Add provider" form, and the "Connect llm-self-service" import
 * card. Secrets policy: provider keys and the org password live only in
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
  const [keyHintId, setKeyHintId] = useState<string | null>(null);
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

  const appendProvider = (created: ProviderSummary): void => {
    setProviders((prev) => [...(prev ?? []), created]);
    setKeyHintId(created.id);
  };

  const handleSessionLost = (): void => setSessionLost(true);

  const panelIntro =
    'Endpoints Partner may call, with keys kept in your OS keychain. Add an OpenAI-compatible endpoint, then test it from here.';

  return (
    <section className="providers" aria-label="Providers">
      <div className="providers-panel">
        <h1 className="providers-title">Providers</h1>
        <p className="providers-intro">{panelIntro}</p>

        {sessionLost ? (
          <div className="providers-alert" role="alert">
            <p className="providers-alert-text">
              Your session with the Partner core has expired. Pair again to manage providers.
            </p>
            <button type="button" className="btn btn-secondary" onClick={onUnpair}>
              Pair again
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
            <p className="empty-state-title">No providers yet</p>
            <p className="empty-state-copy">
              Add an OpenAI-compatible endpoint below, or connect llm-self-service to pull in
              your provisioned key.
            </p>
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
                      openKey={provider.id === keyHintId}
                      onUpdated={replaceProvider}
                      onRemoved={removeProvider}
                      onSessionLost={handleSessionLost}
                    />
                  </li>
                ))}
            </ul>
          </>
        ) : null}

        <AddProviderCard
          disabled={sessionLost}
          onAdded={appendProvider}
          onSessionLost={handleSessionLost}
        />
        <ImportCard
          disabled={sessionLost}
          onConnected={appendProvider}
          onSessionLost={handleSessionLost}
        />
        <McpPanel onUnpair={handleSessionLost} />
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
  openKey: boolean;
  onUpdated: (next: ProviderSummary) => void;
  onRemoved: (id: string) => void;
  onSessionLost: () => void;
}

function ProviderRow({ provider, openKey, onUpdated, onRemoved, onSessionLost }: ProviderRowProps) {
  const [busy, setBusy] = useState<RowOp | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [keyOpen, setKeyOpen] = useState(false);
  const keyRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (openKey) setKeyOpen(true);
  }, [openKey]);

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
// Add provider form
// ---------------------------------------------------------------------------

interface AddProviderCardProps {
  disabled: boolean;
  onAdded: (created: ProviderSummary) => void;
  onSessionLost: () => void;
}

function AddProviderCard({ disabled, onAdded, onSessionLost }: AddProviderCardProps) {
  const [name, setName] = useState('');
  const [endpoint, setEndpoint] = useState('');
  const [purpose, setPurpose] = useState<ProviderPurpose>('general');
  const [models, setModels] = useState('');
  const [budget, setBudget] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (busy || disabled) return;
    const token = readStoredToken();
    if (!token) {
      onSessionLost();
      return;
    }

    const trimmedName = name.trim();
    if (trimmedName.length === 0) {
      setError('Name is required.');
      return;
    }
    const endpointError = validateEndpoint(endpoint);
    if (endpointError) {
      setError(endpointError);
      return;
    }
    const parsedBudget = parseBudgetDollars(budget);
    if (!parsedBudget.ok) {
      setError(parsedBudget.error);
      return;
    }
    const defaultModels = parseModelList(models);

    const input: ProviderInput = {
      name: trimmedName,
      endpoint: normalizeEndpoint(endpoint),
      purpose,
      ...(defaultModels.length > 0 ? { defaultModels } : {}),
      ...(parsedBudget.budgetCents !== null ? { budgetCents: parsedBudget.budgetCents } : {}),
    };

    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const created = await createProvider(token, input);
      setName('');
      setEndpoint('');
      setPurpose('general');
      setModels('');
      setBudget('');
      setNote(`Provider "${created.name}" added — paste its API key to finish.`);
      onAdded(created);
    } catch (cause) {
      if (isSessionLost(cause)) {
        onSessionLost();
        return;
      }
      setError(cause instanceof Error ? cause.message : 'Could not add the provider.');
    } finally {
      setBusy(false);
    }
  };

  const formDisabled = busy || disabled;

  return (
    <section className="card add-card" aria-label="Add provider">
      <h2 className="card-title">Add provider</h2>
      <p className="card-copy">
        Point Partner at any OpenAI-compatible endpoint. The key is added in a separate step and
        never stored by the page.
      </p>
      <form className="form-stack" onSubmit={(event) => void handleSubmit(event)} aria-busy={busy}>
        <div className="form-field">
          <label className="label" htmlFor="provider-name">
            Name
          </label>
          <input
            id="provider-name"
            className="field"
            type="text"
            value={name}
            disabled={formDisabled}
            onChange={(event) => setName(event.target.value)}
            placeholder="My provider"
            aria-required="true"
          />
        </div>
        <div className="form-field">
          <label className="label" htmlFor="provider-endpoint">
            Endpoint
          </label>
          <input
            id="provider-endpoint"
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
          <label className="label" htmlFor="provider-purpose">
            Purpose
          </label>
          <select
            id="provider-purpose"
            className="field"
            value={purpose}
            disabled={formDisabled}
            onChange={(event) => setPurpose(event.target.value as ProviderPurpose)}
          >
            {PROVIDER_PURPOSES.map((option) => (
              <option key={option} value={option}>
                {purposeLabel(option)}
              </option>
            ))}
          </select>
          <p className="field-hint">
            What this endpoint is best for. Routing prefers the matching purpose, then General.
          </p>
        </div>
        <div className="form-row">
          <div className="form-field">
            <label className="label" htmlFor="provider-models">
              Default models (optional, comma-separated)
            </label>
            <input
              id="provider-models"
              className="field"
              type="text"
              autoComplete="off"
              spellCheck={false}
              value={models}
              disabled={formDisabled}
              onChange={(event) => setModels(event.target.value)}
              placeholder="gpt-4o, gpt-4o-mini"
            />
          </div>
          <div className="form-field">
            <label className="label" htmlFor="provider-budget">
              Budget per session, USD (optional)
            </label>
            <input
              id="provider-budget"
              className="field"
              type="text"
              inputMode="decimal"
              autoComplete="off"
              value={budget}
              disabled={formDisabled}
              onChange={(event) => setBudget(event.target.value)}
              placeholder="2.50"
            />
          </div>
        </div>
        <div className="form-actions">
          <button type="submit" className="btn btn-primary" disabled={formDisabled}>
            {busy ? 'Adding…' : 'Add provider'}
          </button>
        </div>
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

// ---------------------------------------------------------------------------
// Connect llm-self-service import card
// ---------------------------------------------------------------------------

interface ImportCardProps {
  disabled: boolean;
  onConnected: (created: ProviderSummary) => void;
  onSessionLost: () => void;
}

function ImportCard({ disabled, onConnected, onSessionLost }: ImportCardProps) {
  const [endpoint, setEndpoint] = useState(IMPORT_DEFAULT_ENDPOINT);
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const passwordRef = useRef<HTMLInputElement | null>(null);
  // Never leave the plaintext password in the DOM after the view unmounts.
  useEffect(
    () => () => {
      if (passwordRef.current) passwordRef.current.value = '';
    },
    [],
  );

  const handleSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (busy || disabled) return;
    const token = readStoredToken();
    if (!token) {
      onSessionLost();
      return;
    }

    const normalizedEndpoint = normalizeEndpoint(endpoint);
    const endpointError = validateEndpoint(normalizedEndpoint);
    if (endpointError) {
      setError(endpointError);
      return;
    }
    const trimmedEmail = email.trim();
    if (trimmedEmail.length === 0) {
      setError('Enter the email you use on the llm-self-service portal.');
      return;
    }
    const plaintext = passwordRef.current?.value ?? '';
    if (plaintext.length === 0) {
      setError('Enter the password for that account.');
      return;
    }
    // Read + clear the password immediately so the plaintext exists only for
    // the duration of this submit handler (never state, never stored).
    if (passwordRef.current) passwordRef.current.value = '';

    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const loginKey = await fetchSelfServiceLoginKey(token, normalizedEndpoint);
      const passwordCipher = await encryptPasswordWithPublicKey(loginKey.publicKeyPem, plaintext);
      const created = await connectSelfService(token, {
        endpoint: normalizedEndpoint,
        email: trimmedEmail,
        passwordCipher,
      });
      setEmail('');
      setNote(`Connected — provider "${created.name}" is ready to use.`);
      onConnected(created);
    } catch (cause) {
      if (cause instanceof ApiRequestError) {
        setError(cause.message);
      } else if (cause instanceof Error) {
        setError(cause.message);
      } else {
        setError('Could not reach the Partner core.');
      }
    } finally {
      setBusy(false);
    }
  };

  const formDisabled = busy || disabled;

  return (
    <section className="card import-card" aria-label="Connect llm-self-service">
      <h2 className="card-title">Connect llm-self-service</h2>
      <p className="card-copy">
        Sign in with the same org credentials as the llm-self-service portal. Your password is
        encrypted in this page, exchanged for your provisioned key, and never sent anywhere else.
      </p>
      <form className="form-stack" onSubmit={(event) => void handleSubmit(event)} aria-busy={busy}>
        <div className="form-field">
          <label className="label" htmlFor="import-endpoint">
            Self-service endpoint
          </label>
          <input
            id="import-endpoint"
            className="field"
            type="text"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            value={endpoint}
            disabled={formDisabled}
            onChange={(event) => setEndpoint(event.target.value)}
            placeholder="https://enter.ne1.dev"
          />
        </div>
        <div className="form-field">
          <label className="label" htmlFor="import-email">
            Org email
          </label>
          <input
            id="import-email"
            className="field"
            type="email"
            autoComplete="username"
            spellCheck={false}
            value={email}
            disabled={formDisabled}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="you@example.com"
            aria-required="true"
          />
        </div>
        <div className="form-field">
          <label className="label" htmlFor="import-password">
            Password
          </label>
          <input
            id="import-password"
            ref={passwordRef}
            className="field"
            type="password"
            autoComplete="new-password"
            aria-required="true"
            disabled={formDisabled}
            placeholder="Org account password"
          />
        </div>
        <div className="form-actions">
          <button type="submit" className="btn btn-primary" disabled={formDisabled}>
            {busy ? 'Connecting…' : 'Connect'}
          </button>
        </div>
        <p className="form-hint keychain-note">
          The provisioned key is stored in your OS keychain by the Partner core — nothing key-shaped
          ever returns to this page.
        </p>
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
