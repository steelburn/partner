import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { sessionLostAction,sessionLostSentence } from './lib/auth-mode.js';
import type {
  EpisodeSummary,
  ForgetRequest,
  MemoryExportBundle,
  MemorySearchHit,
  Persona,
  ProfileEntry,
  ProfileEntryInput,
  ProfileEntryKind,
} from '@partner/shared';
import {
  MEMORY_BUNDLE_FILE,
  KIND_LABELS,
  bundleToFile,
  clampText,
  countEntriesInUse,
  dateValueToForgetIso,
  episodeTitle,
  isEntryInUse,
  isAutoDetected,
  kindLabel,
  kindTone,
  scopedLabel,
  sortEpisodes,
  statusLabel,
  tailoringInUseIds,
  validateBundle,
  validateBundleSize,
} from './lib/memory-helpers.js';
import {
  addProfileEntry,
  exportMemory,
  forgetMemory,
  getMemorySettings,
  importMemory,
  listEpisodes,
  listProfile,
  removeEpisode,
  removeProfileEntry,
  searchMemory,
  summarizeEpisode,
  updateMemorySettings,
  updateProfileEntry,
  type MemoryImportResult,
} from './lib/memory.js';
import { isSessionLost } from './lib/personas.js';
import { readStoredToken } from './lib/token.js';
import { timeAgo } from './lib/persona-helpers.js';

const KIND_OPTIONS: readonly ProfileEntryKind[] = ['preference', 'identity', 'rule', 'style'];

const HIT_KIND_LABELS: Record<MemorySearchHit['kind'], string> = {
  profile: 'Profile',
  episode: 'Episode',
};

/** How many entries are injected at chat time (lightweight 'in use'). */
function inUseLabel(count: number): string {
  return count === 1 ? '1 in use' : `${count} in use`;
}

/** Trigger a browser download of text as a file (memory view only). */
function downloadText(filename: string, text: string): void {
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function personaNameById(personas: readonly Persona[], id: string | null): string | null {
  if (id === null) return null;
  return personas.find((p) => p.id === id)?.name ?? null;
}

/** A full ProfileEntryInput built from an entry plus any field overrides. */
function inputFromEntry(
  entry: ProfileEntry,
  fields: { kind: ProfileEntryKind; key: string; value: string; scope: string },
  overrides: Partial<ProfileEntryInput> = {},
): ProfileEntryInput {
  const key = fields.key.trim();
  const scope = fields.scope.trim();
  return {
    kind: fields.kind,
    value: fields.value.trim(),
    ...(key.length > 0 ? { key } : {}),
    source: entry.source,
    status: entry.status,
    ...(scope === '' ? { personaScope: null } : { personaScope: scope }),
    ...overrides,
  };
}

export interface MemoryViewProps {
  /** Every persona (null while the shell is still loading them). */
  personas: Persona[] | null;
  /** Forget the session and return to the pairing gate (auth failure). */
  onUnpair: () => void;
  /** True while this view is the visible one (triggers a reload). */
  active?: boolean;
  /**
   * M20.A: a confirm/edit/reject changes how many suggestions are waiting, so
   * the shell re-reads its attention counts and the nav badge clears at once
   * instead of at the next poll. Only a count is involved — no entry text
   * crosses this callback.
   */
  onAttentionChanged?: () => void;
}

/**
 * M4 Memory view (PLAN-M4.md provisional): confirmed profile entries with an
 * "in use" marker, suggested entries (Confirm/Edit/Reject), an add-entry
 * form, episode summaries (re-summarize + delete), full-text search, and the
 * memory controls (forget all / forget before a date / export / import).
 * Memory content is user data: it is rendered to the OWNER only — nothing in
 * this view ever logs it, and errors/notes carry counts and ids, never text.
 */
export default function MemoryView({
  personas,
  onUnpair,
  active,
  onAttentionChanged,
}: MemoryViewProps) {
  const [entries, setEntries] = useState<ProfileEntry[] | null>(null);
  const [episodes, setEpisodes] = useState<EpisodeSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sessionLost, setSessionLost] = useState(false);
  const [reloadTick, setReloadTick] = useState(0);

  const load = async (): Promise<void> => {
    const token = readStoredToken();
    if (!token) {
      setSessionLost(true);
      return;
    }
    try {
      const [profile, episodeList] = await Promise.all([listProfile(token), listEpisodes(token)]);
      setEntries(profile);
      setEpisodes(sortEpisodes(episodeList));
      setLoadError(null);
    } catch (cause) {
      if (isSessionLost(cause)) {
        setSessionLost(true);
        return;
      }
      setLoadError(cause instanceof Error ? cause.message : 'Could not load memory.');
    }
  };

  // Reload on activation; reload quietly after a mutation.
  useEffect(() => {
    if (!active || sessionLost) return;
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, sessionLost, reloadTick]);

  const handleChanged = (): void => {
    setReloadTick((tick) => tick + 1);
    onAttentionChanged?.();
  };

  const handleSessionLost = (): void => setSessionLost(true);

  const list = personas ?? [];
  const inUseCount = countEntriesInUse(entries ?? [], list);
  const suggested = (entries ?? []).filter((entry) => entry.status === 'suggested');
  const confirmed = (entries ?? []).filter((entry) => entry.status === 'confirmed');

  return (
    <section className="memory" aria-label="Memory">
      <div className="memory-panel">
        <div className="page-head">
          <div className="page-head-titles">
            <div className="kicker">Context</div>
            <h1 className="page-title">Memory</h1>
          </div>
        </div>
        <p className="page-copy">
          What the partner knows about you and your conversations. Everything here is visible,
          editable and exportable — nothing is learned silently.
        </p>

        {sessionLost ? (
          <div className="memory-alert" role="alert">
            <p className="memory-alert-text">
              {sessionLostSentence('manage memory')}
            </p>
            <button type="button" className="btn btn-secondary" onClick={onUnpair}>
              {sessionLostAction()}
            </button>
          </div>
        ) : null}

        {!sessionLost && entries === null ? (
          <p className="memory-loading" aria-busy="true">
            Loading memory…
          </p>
        ) : !sessionLost && loadError ? (
          <div className="memory-alert" role="alert">
            <p className="memory-alert-text">{loadError}</p>
            <button type="button" className="btn btn-secondary" onClick={() => void load()}>
              Try again
            </button>
          </div>
        ) : null}

        {!sessionLost && entries !== null ? (
          <>
            <RememberSettingsCard onSessionLost={handleSessionLost} />
            <ProfileCard
              confirmed={confirmed}
              suggested={suggested}
              personas={list}
              inUseCount={inUseCount}
              onChanged={handleChanged}
              onSessionLost={handleSessionLost}
            />
            <EpisodesCard
              episodes={episodes}
              personas={list}
              onChanged={handleChanged}
              onSessionLost={handleSessionLost}
            />
            <SearchCard onSessionLost={handleSessionLost} />
            <ControlsCard
              entryCount={entries.length}
              episodeCount={episodes?.length ?? 0}
              onChanged={handleChanged}
              onSessionLost={handleSessionLost}
            />
            <p className="mem-privacy">
              Memory is stored locally in the core on this machine — never on a Partner server.
              Entries show their provenance, and you can forget or export all of it at any time.
              Only confirmed profile entries tailor replies, and only when a persona is routed
              through a provider. Automatic memory has two independent consents: the global
              setting above covers facts that apply everywhere, and each persona&apos;s private
              memory covers facts tied to it.
            </p>
          </>
        ) : null}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Automatic-memory settings (M19 follow-up: user-level global consent)
// ---------------------------------------------------------------------------

interface RememberSettingsCardProps {
  onSessionLost: () => void;
}

/**
 * The user-level consent for GLOBAL auto-remember. Independent of the
 * per-persona private-memory toggle, so facts that apply everywhere are
 * noticed even when no persona has private memory on. Loads lazily (the card
 * renders nothing until the setting arrives) and writes optimistically only
 * after the core confirms the stored value.
 */
function RememberSettingsCard({ onSessionLost }: RememberSettingsCardProps) {
  const [autoRememberGlobal, setAutoRememberGlobal] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const token = readStoredToken();
    if (!token) return;
    void getMemorySettings(token)
      .then((settings) => {
        if (!cancelled) setAutoRememberGlobal(settings.autoRememberGlobal);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        if (isSessionLost(cause)) {
          onSessionLost();
          return;
        }
        setError(cause instanceof Error ? cause.message : 'Could not load memory settings.');
      });
    return () => {
      cancelled = true;
    };
  }, [onSessionLost]);

  const toggle = async (next: boolean): Promise<void> => {
    if (busy) return;
    const token = readStoredToken();
    if (!token) {
      onSessionLost();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const saved = await updateMemorySettings(token, { autoRememberGlobal: next });
      setAutoRememberGlobal(saved.autoRememberGlobal);
    } catch (cause) {
      if (isSessionLost(cause)) {
        onSessionLost();
        return;
      }
      setError(cause instanceof Error ? cause.message : 'Could not save that setting.');
    } finally {
      setBusy(false);
    }
  };

  if (autoRememberGlobal === null && error === null) return null;

  return (
    <section className="card mem-settings" aria-label="Automatic memory">
      <div className="section-head">
        <h2 className="card-title">Automatic memory</h2>
      </div>
      <label className="check-label" htmlFor="mem-auto-global">
        <input
          id="mem-auto-global"
          className="check"
          type="checkbox"
          checked={autoRememberGlobal === true}
          disabled={busy}
          onChange={(event) => void toggle(event.target.checked)}
        />
        Notice facts that apply to every persona
      </label>
      <p className="card-copy">
        When on, the partner watches your chats for durable facts about you — name, role,
        language, standing tone — and files them as <strong>All personas</strong> suggestions.
        Nothing is used until you confirm it below. Facts tied to one persona are governed by that
        persona&apos;s private-memory setting in Personas.
      </p>
      {error ? (
        <p className="row-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Profile card: confirmed entries + suggestions + add/edit forms
// ---------------------------------------------------------------------------

interface ProfileCardProps {
  confirmed: ProfileEntry[];
  suggested: ProfileEntry[];
  personas: readonly Persona[];
  inUseCount: number;
  onChanged: () => void;
  onSessionLost: () => void;
}

function ProfileCard({ confirmed, suggested, personas, inUseCount, onChanged, onSessionLost }: ProfileCardProps) {
  const inUseIds = useMemo(() => tailoringInUseIds(confirmed, personas), [confirmed, personas]);
  return (
    <section className="card" aria-label="Profile">
      <div className="section-head">
        <h2 className="card-title">Profile</h2>
        {confirmed.length > 0 ? (
          <span className="chip" aria-label={`${confirmed.length} confirmed entries`}>
            {confirmed.length} confirmed
          </span>
        ) : null}
        {inUseCount > 0 ? (
          <span className="chip chip-accent" aria-label={inUseLabel(inUseCount)}>
            {inUseLabel(inUseCount)}
          </span>
        ) : null}
      </div>
      <p className="card-copy">
        Confirmed facts about you drive how the partner tailors replies. Global entries marked
        “in use” ride every persona&apos;s prompt at chat time; a persona with private memory on
        also honors its own scoped entries — only in chats with it.
      </p>

      {confirmed.length === 0 ? (
        <div className="empty-state empty-inline">
          <p className="empty-state-title">No confirmed entries yet</p>
          <p className="empty-state-copy">
            Add a fact below — your name, how you like replies, or a rule you want the partner to
            keep. You confirm everything the partner remembers.
          </p>
        </div>
      ) : (
        <ul className="mem-list">
          {confirmed.map((entry) => (
            <li key={entry.id}>
              <ProfileEntryRow
                entry={entry}
                personas={personas}
                inUse={inUseIds.has(entry.id)}
                deletable
                onChanged={onChanged}
                onSessionLost={onSessionLost}
              />
            </li>
          ))}
        </ul>
      )}

      {suggested.length > 0 ? (
        <div className="sub-panel mem-suggestions">
          <div className="sub-panel-title">Suggestions ({suggested.length})</div>
          <p className="sub-panel-copy">
            The partner noticed these and is waiting for your call — confirm what it got right,
            edit it, or reject it. Nothing here is used until confirmed, and a rejected fact is
            never suggested again.
          </p>
          <ul className="mem-list">
            {suggested.map((entry) => (
              <li key={entry.id}>
                <ProfileEntryRow
                  entry={entry}
                  personas={personas}
                  inUse={false}
                  deletable={false}
                  onChanged={onChanged}
                  onSessionLost={onSessionLost}
                />
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <AddEntryForm personas={personas} onAdded={onChanged} onSessionLost={onSessionLost} />
    </section>
  );
}

// ---------------------------------------------------------------------------
// One profile entry row (read mode + inline edit form)
// ---------------------------------------------------------------------------

interface ProfileEntryRowProps {
  entry: ProfileEntry;
  personas: readonly Persona[];
  /** True when this entry is in the server-side tailoring set (top 8 newest). */
  inUse?: boolean;
  /** Show Delete (confirmed rows). Suggested rows get Confirm/Reject instead. */
  deletable: boolean;
  onChanged: () => void;
  onSessionLost: () => void;
}

function ProfileEntryRow({
  entry,
  personas,
  inUse: inUseOverride,
  deletable,
  onChanged,
  onSessionLost,
}: ProfileEntryRowProps) {
  const [editing, setEditing] = useState(false);
  const [kind, setKind] = useState<ProfileEntryKind>(entry.kind);
  const [key, setKey] = useState(entry.key ?? '');
  const [value, setValue] = useState(entry.value);
  const [scope, setScope] = useState(entry.personaScope ?? '');
  const [busy, setBusy] = useState<'save' | 'confirm' | 'reject' | 'delete' | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [rowError, setRowError] = useState<string | null>(null);

  const tone = kindTone(entry.kind);
  const inUse = inUseOverride === undefined ? isEntryInUse(entry, personas) : inUseOverride;
  const personaScopeLabel = scopedLabel(entry.personaScope, personas);
  const unknownScope = entry.personaScope !== null && !personas.some((p) => p.id === entry.personaScope);

  const startEdit = (): void => {
    setKind(entry.kind);
    setKey(entry.key ?? '');
    setValue(entry.value);
    setScope(entry.personaScope ?? '');
    setRowError(null);
    setConfirming(false);
    setEditing(true);
  };

  const reset = (): void => {
    setBusy(null);
    setConfirming(false);
    setRowError(null);
    setEditing(false);
  };

  const save = async (): Promise<void> => {
    if (busy !== null) return;
    if (value.trim().length === 0) {
      setRowError('Enter the fact or preference first.');
      return;
    }
    const token = readStoredToken();
    if (!token) {
      onSessionLost();
      return;
    }
    setBusy('save');
    setRowError(null);
    try {
      await updateProfileEntry(token, entry.id, inputFromEntry(entry, { kind, key, value, scope }));
      reset();
      onChanged();
    } catch (cause) {
      if (isSessionLost(cause)) {
        onSessionLost();
        return;
      }
      setRowError(cause instanceof Error ? cause.message : 'Could not save the entry.');
    } finally {
      setBusy(null);
    }
  };

  const changeStatus = async (nextStatus: ProfileEntry['status']): Promise<void> => {
    if (busy !== null) return;
    const token = readStoredToken();
    if (!token) {
      onSessionLost();
      return;
    }
    setBusy(nextStatus === 'confirmed' ? 'confirm' : 'reject');
    setRowError(null);
    try {
      await updateProfileEntry(token, entry.id, inputFromEntry(entry, {
        kind: entry.kind,
        key: entry.key ?? '',
        value: entry.value,
        scope: entry.personaScope ?? '',
      }, { status: nextStatus }));
      reset();
      onChanged();
    } catch (cause) {
      if (isSessionLost(cause)) {
        onSessionLost();
        return;
      }
      setRowError(cause instanceof Error ? cause.message : 'Could not update the entry.');
    } finally {
      setBusy(null);
    }
  };

  const remove = async (): Promise<void> => {
    if (busy !== null) return;
    if (!confirming) {
      setConfirming(true);
      setRowError(null);
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
      await removeProfileEntry(token, entry.id);
      reset();
      onChanged();
    } catch (cause) {
      setConfirming(false);
      if (isSessionLost(cause)) {
        onSessionLost();
        return;
      }
      setRowError(cause instanceof Error ? cause.message : 'Could not delete the entry.');
    } finally {
      setBusy(null);
    }
  };

  const scopeOptions = personas.map((persona) => (
    <option key={persona.id} value={persona.id}>
      {persona.name}
    </option>
  ));

  if (editing) {
    return (
      <div className="mem-row mem-row-editing" aria-busy={busy === 'save'}>
        <div className="form-stack">
          <div className="form-row">
            <div className="form-field">
              <label className="label" htmlFor={`mem-kind-${entry.id}`}>
                Kind
              </label>
              <select
                id={`mem-kind-${entry.id}`}
                className="field"
                value={kind}
                disabled={busy !== null}
                onChange={(event) => setKind(event.target.value as ProfileEntryKind)}
              >
                {KIND_OPTIONS.map((kindOption) => (
                  <option key={kindOption} value={kindOption}>
                    {KIND_LABELS[kindOption]}
                  </option>
                ))}
              </select>
            </div>
            <div className="form-field">
              <label className="label" htmlFor={`mem-key-${entry.id}`}>
                Key <span className="label-optional">(optional)</span>
              </label>
              <input
                id={`mem-key-${entry.id}`}
                className="field"
                type="text"
                value={key}
                disabled={busy !== null}
                onChange={(event) => setKey(event.target.value)}
                placeholder="e.g. tone"
                spellCheck={false}
              />
            </div>
          </div>
          <div className="form-field">
            <label className="label" htmlFor={`mem-value-${entry.id}`}>
              Fact or preference
            </label>
            <textarea
              id={`mem-value-${entry.id}`}
              className="field"
              rows={2}
              value={value}
              disabled={busy !== null}
              onChange={(event) => setValue(event.target.value)}
              aria-required="true"
            />
          </div>
          <div className="form-field">
            <label className="label" htmlFor={`mem-scope-${entry.id}`}>
              Applies to
            </label>
            <select
              id={`mem-scope-${entry.id}`}
              className="field"
              value={scope}
              disabled={busy !== null}
              onChange={(event) => setScope(event.target.value)}
            >
              <option value="">All personas</option>
              {unknownScope && entry.personaScope !== null ? (
                <option value={entry.personaScope}>{personaScopeLabel}</option>
              ) : null}
              {scopeOptions}
            </select>
          </div>
          {entry.evidence !== null && entry.evidence.length > 0 ? (
            <p className="mem-evidence">Why: {entry.evidence}</p>
          ) : null}
          <div className="form-actions">
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={busy !== null}
              onClick={() => void save()}
              aria-busy={busy === 'save'}
            >
              {busy === 'save' ? 'Saving…' : 'Save'}
            </button>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              disabled={busy !== null}
              onClick={reset}
            >
              Cancel
            </button>
          </div>
          {rowError ? (
            <p className="row-error" role="alert">
              {rowError}
            </p>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className="mem-row">
      <div className="mem-row-main">
        <span className={`mem-chip mem-chip-${tone}`}>{kindLabel(entry.kind)}</span>
        <p className="mem-value">{entry.value}</p>
      </div>
      {entry.evidence !== null && entry.evidence.length > 0 ? (
        <p className="mem-evidence">Why: {entry.evidence}</p>
      ) : null}
      <div className="mem-row-meta">
        {inUse ? (
          <span className="mem-tag-inuse" title="Injected into persona prompts at chat time">
            In use
          </span>
        ) : null}
        {isAutoDetected(entry) ? (
          <span
            className="mem-chip mem-chip-neutral"
            title="Detected by the partner from your chats, not typed by you"
          >
            Auto-detected
          </span>
        ) : null}
        {entry.status !== 'confirmed' ? (
          <span className="mem-chip mem-chip-neutral">{statusLabel(entry.status)}</span>
        ) : null}
        <span className="mem-meta-item" aria-label="Scope">
          {personaScopeLabel}
        </span>
        <span className="mem-meta-item">
          {entry.source === 'user' ? 'You' : 'Partner'} · {timeAgo(entry.updatedAt)}
        </span>
        <span className="mem-actions">
          {entry.status === 'suggested' ? (
            <>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={busy !== null}
                onClick={() => void changeStatus('confirmed')}
                aria-busy={busy === 'confirm'}
              >
                {busy === 'confirm' ? 'Confirming…' : 'Confirm'}
              </button>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                disabled={busy !== null}
                onClick={startEdit}
              >
                Edit
              </button>
              <button
                type="button"
                className="btn btn-secondary btn-sm btn-danger"
                disabled={busy !== null}
                onClick={() => void changeStatus('rejected')}
                aria-busy={busy === 'reject'}
              >
                {busy === 'reject' ? 'Rejecting…' : 'Reject'}
              </button>
            </>
          ) : (
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              disabled={busy !== null}
              onClick={startEdit}
            >
              Edit
            </button>
          )}
          {deletable ? (
            <button
              type="button"
              className="btn btn-secondary btn-sm btn-danger"
              disabled={busy !== null}
              onClick={() => void remove()}
              aria-busy={busy === 'delete'}
              aria-label={
                confirming ? `Confirm deleting “${kindLabel(entry.kind)}” entry` : `Delete ${kindLabel(entry.kind)} entry`
              }
            >
              {busy === 'delete' ? 'Deleting…' : confirming ? 'Confirm delete' : 'Delete'}
            </button>
          ) : null}
        </span>
      </div>
      {rowError ? (
        <p className="row-error" role="alert">
          {rowError}
        </p>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Add-entry form
// ---------------------------------------------------------------------------

interface AddEntryFormProps {
  personas: readonly Persona[];
  onAdded: () => void;
  onSessionLost: () => void;
}

function AddEntryForm({ personas, onAdded, onSessionLost }: AddEntryFormProps) {
  const [kind, setKind] = useState<ProfileEntryKind>('preference');
  const [key, setKey] = useState('');
  const [value, setValue] = useState('');
  const [scope, setScope] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (busy) return;
    if (value.trim().length === 0) {
      setError('Enter the fact or preference first.');
      return;
    }
    const token = readStoredToken();
    if (!token) {
      onSessionLost();
      return;
    }
    const keyTrimmed = key.trim();
    const scopeTrimmed = scope.trim();
    const input: ProfileEntryInput = {
      kind,
      value: value.trim(),
      source: 'user',
      status: 'confirmed',
      ...(keyTrimmed.length > 0 ? { key: keyTrimmed } : {}),
      ...(scopeTrimmed === '' ? { personaScope: null } : { personaScope: scopeTrimmed }),
    };
    setBusy(true);
    setError(null);
    try {
      await addProfileEntry(token, input);
      setKey('');
      setValue('');
      setScope('');
      onAdded();
    } catch (cause) {
      if (isSessionLost(cause)) {
        onSessionLost();
        return;
      }
      setError(cause instanceof Error ? cause.message : 'Could not add the entry.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="sub-panel form-stack add-entry-form"
      onSubmit={(event) => void submit(event)}
      aria-busy={busy}
    >
      <div className="sub-panel-title">Add what the partner should know</div>
      <p className="sub-panel-copy">
        You are the source of everything here — the partner only uses facts you add or confirm.
      </p>
      <div className="form-row">
        <div className="form-field">
          <label className="label" htmlFor="mem-add-kind">
            Kind
          </label>
          <select
            id="mem-add-kind"
            className="field"
            value={kind}
            disabled={busy}
            onChange={(event) => setKind(event.target.value as ProfileEntryKind)}
          >
            {KIND_OPTIONS.map((kindOption) => (
              <option key={kindOption} value={kindOption}>
                {KIND_LABELS[kindOption]}
              </option>
            ))}
          </select>
        </div>
        <div className="form-field">
          <label className="label" htmlFor="mem-add-key">
            Key <span className="label-optional">(optional)</span>
          </label>
          <input
            id="mem-add-key"
            className="field"
            type="text"
            value={key}
            disabled={busy}
            onChange={(event) => setKey(event.target.value)}
            placeholder="e.g. language"
            spellCheck={false}
          />
        </div>
      </div>
      <div className="form-field">
        <label className="label" htmlFor="mem-add-value">
          Fact or preference
        </label>
        <textarea
          id="mem-add-value"
          className="field"
          rows={2}
          value={value}
          disabled={busy}
          onChange={(event) => {
            setValue(event.target.value);
            setError(null);
          }}
          placeholder="e.g. I prefer concise replies that start with the answer."
          aria-required="true"
        />
      </div>
      <div className="form-field">
        <label className="label" htmlFor="mem-add-scope">
          Applies to
        </label>
        <select
          id="mem-add-scope"
          className="field"
          value={scope}
          disabled={busy}
          onChange={(event) => setScope(event.target.value)}
        >
          <option value="">All personas</option>
          {personas.map((persona) => (
            <option key={persona.id} value={persona.id}>
              {persona.name}
            </option>
          ))}
        </select>
        <p className="form-hint">
          Facts scoped to one persona tailor only that persona. Global confirmed facts are the
          ones marked “in use”.
        </p>
      </div>
      <div className="form-actions">
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy ? 'Adding…' : 'Add entry'}
        </button>
      </div>
      <div className="form-feedback" aria-live="polite">
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Episodes card
// ---------------------------------------------------------------------------

interface EpisodesCardProps {
  episodes: EpisodeSummary[] | null;
  personas: readonly Persona[];
  onChanged: () => void;
  onSessionLost: () => void;
}

function EpisodesCard({ episodes, personas, onChanged, onSessionLost }: EpisodesCardProps) {
  return (
    <section className="card" aria-label="Episodes">
      <div className="section-head">
        <h2 className="card-title">Episodes</h2>
        {episodes !== null && episodes.length > 0 ? (
          <span className="chip" aria-label={`${episodes.length} episodes`}>
            {episodes.length}
          </span>
        ) : null}
      </div>
      <p className="card-copy">
        Condensed summaries of past conversations, one per conversation. Re-summarize updates the
        entry; summaries written in demo mode have no provider behind them and cannot be
        re-summarized.
      </p>
      {episodes === null ? (
        <p className="mem-loading-small" aria-busy="true">
          Loading episodes…
        </p>
      ) : episodes.length === 0 ? (
        <div className="empty-state empty-inline">
          <p className="empty-state-title">No episodes yet</p>
          <p className="empty-state-copy">
            Finished conversations that are summarized land here. Episodes give the partner a
            compact memory of what you worked on — each is editable via delete at any time.
          </p>
        </div>
      ) : (
        <ul className="mem-list">
          {episodes.map((episode) => (
            <li key={episode.id}>
              <EpisodeRow
                episode={episode}
                personas={personas}
                onChanged={onChanged}
                onSessionLost={onSessionLost}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function EpisodeRow({
  episode,
  personas,
  onChanged,
  onSessionLost,
}: {
  episode: EpisodeSummary;
  personas: readonly Persona[];
  onChanged: () => void;
  onSessionLost: () => void;
}) {
  const [busy, setBusy] = useState<'summarize' | 'delete' | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [rowError, setRowError] = useState<string | null>(null);
  const demo = episode.model === null;

  const resummarize = async (): Promise<void> => {
    if (busy !== null || demo) return;
    const token = readStoredToken();
    if (!token) {
      onSessionLost();
      return;
    }
    setBusy('summarize');
    setRowError(null);
    try {
      await summarizeEpisode(token, episode.conversationId);
      onChanged();
    } catch (cause) {
      if (isSessionLost(cause)) {
        onSessionLost();
        return;
      }
      setRowError(cause instanceof Error ? cause.message : 'Could not re-summarize the conversation.');
    } finally {
      setBusy(null);
    }
  };

  const remove = async (): Promise<void> => {
    if (busy !== null) return;
    if (!confirming) {
      setConfirming(true);
      setRowError(null);
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
      await removeEpisode(token, episode.id);
      setConfirming(false);
      onChanged();
    } catch (cause) {
      setConfirming(false);
      if (isSessionLost(cause)) {
        onSessionLost();
        return;
      }
      setRowError(cause instanceof Error ? cause.message : 'Could not delete the episode.');
    } finally {
      setBusy(null);
    }
  };

  const title = episodeTitle(episode);
  const personaLabel =
    episode.personaId === null
      ? 'no persona'
      : (personaNameById(personas, episode.personaId) ?? 'Removed persona');
  return (
    <div className="mem-row">
      <div className="mem-row-head">
        <h3 className="mem-row-title">{title}</h3>
        <span className="mem-actions">
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={busy !== null || demo}
            onClick={() => void resummarize()}
            aria-busy={busy === 'summarize'}
            title={demo ? 'Demo summaries have no provider behind them.' : undefined}
          >
            {busy === 'summarize' ? 'Summarizing…' : 'Re-summarize'}
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-sm btn-danger"
            disabled={busy !== null}
            onClick={() => void remove()}
            aria-busy={busy === 'delete'}
            aria-label={confirming ? `Confirm deleting episode ${title}` : `Delete episode ${title}`}
          >
            {busy === 'delete' ? 'Deleting…' : confirming ? 'Confirm delete' : 'Delete'}
          </button>
        </span>
      </div>
      <div className="mem-row-meta">
        {episode.personaId !== null ? (
          <span className="mem-chip mem-chip-neutral">{personaLabel}</span>
        ) : (
          <span className="mem-meta-item">{personaLabel}</span>
        )}
        {demo ? (
          <span className="mem-chip mem-chip-neutral" title="Placeholder summary written without a provider">
            Placeholder
          </span>
        ) : null}
        <span className="mem-meta-item">{timeAgo(episode.updatedAt)}</span>
      </div>
      <p className="mem-summary">{clampText(episode.summary, 220)}</p>
      {rowError ? (
        <p className="row-error" role="alert">
          {rowError}
        </p>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Search card
// ---------------------------------------------------------------------------

interface SearchCardProps {
  onSessionLost: () => void;
}

function SearchCard({ onSessionLost }: SearchCardProps) {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<MemorySearchHit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (searching) return;
    const q = query.trim();
    if (q.length === 0) {
      setHits(null);
      setError(null);
      return;
    }
    const token = readStoredToken();
    if (!token) {
      onSessionLost();
      return;
    }
    setSearching(true);
    setError(null);
    try {
      setHits(await searchMemory(token, q));
    } catch (cause) {
      if (isSessionLost(cause)) {
        onSessionLost();
        return;
      }
      setHits(null);
      setError(cause instanceof Error ? cause.message : 'Could not search memory.');
    } finally {
      setSearching(false);
    }
  };

  return (
    <section className="card" aria-label="Search memory">
      <div className="section-head">
        <h2 className="card-title">Search</h2>
      </div>
      <p className="card-copy">
        Full-text search across your profile entries and episode summaries — stored locally,
        ranked, capped at 50 hits.
      </p>
      <form className="mem-search-form" onSubmit={(event) => void run(event)}>
        <input
          className="field mem-search-input"
          type="search"
          value={query}
          placeholder="Search memory…"
          aria-label="Search memory"
          disabled={searching}
          onChange={(event) => {
            setQuery(event.target.value);
            setError(null);
          }}
        />
        <button type="submit" className="btn btn-secondary" disabled={searching} aria-busy={searching}>
          {searching ? 'Searching…' : 'Search'}
        </button>
      </form>
      {error ? (
        <p className="row-error" role="alert">
          {error}
        </p>
      ) : null}
      {hits !== null ? (
        hits.length === 0 ? (
          <p className="mem-search-empty">No matches — memory holds no entry containing that text.</p>
        ) : (
          <>
            <ul className="mem-list">
              {hits.map((hit) => (
                <li key={`${hit.kind}-${hit.refId}-${hit.rank}`}>
                  <div className="mem-row mem-row-hit">
                    <span
                      className={`mem-chip ${hit.kind === 'profile' ? 'mem-chip-accent' : 'mem-chip-neutral'}`}
                    >
                      {HIT_KIND_LABELS[hit.kind]}
                    </span>
                    <p className="mem-snippet">{hit.snippet}</p>
                  </div>
                </li>
              ))}
            </ul>
            <p className="mem-cap-note">Showing up to 50 hits.</p>
          </>
        )
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Memory controls: forget / export / import
// ---------------------------------------------------------------------------

interface ControlsCardProps {
  entryCount: number;
  episodeCount: number;
  onChanged: () => void;
  onSessionLost: () => void;
}

function ControlsCard({ entryCount, episodeCount, onChanged, onSessionLost }: ControlsCardProps) {
  const [forgetAllArmed, setForgetAllArmed] = useState(false);
  const [forgetAllBusy, setForgetAllBusy] = useState(false);
  const [date, setDate] = useState('');
  const [dateArmed, setDateArmed] = useState(false);
  const [dateBusy, setDateBusy] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const beforeIso = dateValueToForgetIso(date);
  const dateValid = beforeIso !== null;

  const clearFeedback = (): void => {
    setError(null);
    setNote(null);
  };

  const forgetAll = async (): Promise<void> => {
    if (forgetAllBusy) return;
    if (!forgetAllArmed) {
      setForgetAllArmed(true);
      clearFeedback();
      return;
    }
    const token = readStoredToken();
    if (!token) {
      onSessionLost();
      return;
    }
    setForgetAllBusy(true);
    try {
      await forgetMemory(token, { what: 'all' });
      setForgetAllArmed(false);
      setNote('Everything forgotten — profile and episodes are empty.');
      onChanged();
    } catch (cause) {
      setForgetAllArmed(false);
      if (isSessionLost(cause)) {
        onSessionLost();
        return;
      }
      setError(cause instanceof Error ? cause.message : 'Could not forget memory.');
    } finally {
      setForgetAllBusy(false);
    }
  };

  const forgetBefore = async (): Promise<void> => {
    if (dateBusy || !dateValid) return;
    if (!dateArmed) {
      setDateArmed(true);
      clearFeedback();
      return;
    }
    const token = readStoredToken();
    if (!token) {
      onSessionLost();
      return;
    }
    setDateBusy(true);
    try {
      const request: ForgetRequest = { what: 'all', before: beforeIso };
      await forgetMemory(token, request);
      setDateArmed(false);
      setDate('');
      setNote(`Forgotten everything before ${date} — that day and later are kept.`);
      onChanged();
    } catch (cause) {
      setDateArmed(false);
      if (isSessionLost(cause)) {
        onSessionLost();
        return;
      }
      setError(cause instanceof Error ? cause.message : 'Could not forget memory.');
    } finally {
      setDateBusy(false);
    }
  };

  const exportBundle = async (): Promise<void> => {
    if (exporting) return;
    const token = readStoredToken();
    if (!token) {
      onSessionLost();
      return;
    }
    setExporting(true);
    clearFeedback();
    try {
      const bundle = await exportMemory(token);
      downloadText(MEMORY_BUNDLE_FILE, bundleToFile(bundle));
      setNote(
        `Exported ${bundle.profile.length} profile ${bundle.profile.length === 1 ? 'entry' : 'entries'} and ${bundle.episodes.length} ${bundle.episodes.length === 1 ? 'episode' : 'episodes'} to ${MEMORY_BUNDLE_FILE}.`,
      );
    } catch (cause) {
      if (isSessionLost(cause)) {
        onSessionLost();
        return;
      }
      setError(cause instanceof Error ? cause.message : 'Could not export memory.');
    } finally {
      setExporting(false);
    }
  };

  const pickFile = (): void => {
    clearFeedback();
    fileRef.current?.click();
  };

  const onFile = async (file: File | undefined): Promise<void> => {
    if (!file || importing) return;
    const token = readStoredToken();
    if (!token) {
      onSessionLost();
      return;
    }
    setImporting(true);
    clearFeedback();
    try {
      const text = await file.text();
      const sizeError = validateBundleSize(text);
      if (sizeError) {
        setError(sizeError);
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        setError('That file is not valid JSON — use a file exported from Memory.');
        return;
      }
      const schemaError = validateBundle(parsed);
      if (schemaError) {
        setError(`Import refused: ${schemaError}`);
        return;
      }
      const result = await importMemory(token, parsed as MemoryExportBundle);
      setNote(importNote(result));
      onChanged();
    } catch (cause) {
      if (isSessionLost(cause)) {
        onSessionLost();
        return;
      }
      setError(cause instanceof Error ? cause.message : 'Could not import memory.');
    } finally {
      setImporting(false);
    }
  };

  return (
    <section className="card" aria-label="Memory controls">
      <div className="section-head">
        <h2 className="card-title">Memory controls</h2>
        <span className="chip" aria-label={`${entryCount} profile entries, ${episodeCount} episodes`}>
          {entryCount} profile · {episodeCount} episodes
        </span>
      </div>
      <p className="card-copy">
        Forgetting removes rows from this core&apos;s database and search index — it cannot be
        undone. Export first if you might want the data back.
      </p>

      {/* M20.A: portability first, destructive last, escalating in scope
       * (a dated boundary, then everything). "Forget everything" used to be
       * the FIRST row of this card — the most prominent position given to the
       * most irreversible action, one row above the Export that the copy above
       * tells the user to reach for first. The arm/confirm pattern is
       * unchanged; only the order and the separation are. */}
      <div className="mem-control-row">
        <div className="mem-control-text">
          <span className="mem-control-title">Export</span>
          <span className="mem-control-copy">
            Downloads profile + episodes as {MEMORY_BUNDLE_FILE} (JSON, memory/v1).
          </span>
        </div>
        <button
          type="button"
          className="btn btn-secondary"
          disabled={exporting || importing || forgetAllBusy || dateBusy}
          onClick={() => void exportBundle()}
          aria-busy={exporting}
        >
          {exporting ? 'Exporting…' : 'Export memory'}
        </button>
      </div>

      <div className="mem-control-row">
        <div className="mem-control-text">
          <span className="mem-control-title">Import</span>
          <span className="mem-control-copy">
            Adds a memory/v1 JSON file back into the core. Imports are additive — existing entries
            and episodes stay untouched.
          </span>
        </div>
        <button
          type="button"
          className="btn btn-secondary"
          disabled={importing || exporting || forgetAllBusy || dateBusy}
          onClick={pickFile}
          aria-busy={importing}
        >
          {importing ? 'Importing…' : 'Import memory'}
        </button>
        <input
          ref={fileRef}
          className="mem-file-input"
          type="file"
          accept=".json,application/json"
          onChange={(event) => void onFile(event.target.files?.[0]).then(() => {
            event.target.value = '';
          })}
          tabIndex={-1}
          aria-hidden="true"
        />
      </div>

      {/* Destructive group, separated by space (DESIGN.md: space → background
       * shift → elevation before a border). Narrower scope first so severity
       * escalates downward. */}
      <div className="mem-danger-group">
        <div className="mem-control-row">
          <div className="mem-control-text">
            <span className="mem-control-title">Forget before a date</span>
            <span className="mem-control-copy">
              Removes profile entries and episodes CREATED before the chosen day (a whole-memory boundary).
            </span>
          </div>
          <div className="mem-control-date">
            <input
              className="field mem-date-input"
              type="date"
              value={date}
              disabled={dateBusy || forgetAllBusy || importing || exporting}
              onChange={(event) => {
                setDate(event.target.value);
                setDateArmed(false);
                clearFeedback();
              }}
              aria-label="Forget memory before this date"
            />
            <button
              type="button"
              className="btn btn-secondary btn-danger"
              disabled={dateBusy || !dateValid || forgetAllBusy || importing || exporting}
              onClick={() => void forgetBefore()}
              aria-busy={dateBusy}
              aria-label={
                dateArmed ? `Confirm forgetting memory before ${date}` : 'Forget memory before the selected date'
              }
            >
              {dateBusy
                ? 'Forgetting…'
                : dateArmed
                  ? `Confirm before ${date}`
                  : 'Forget before'}
            </button>
          </div>
        </div>

        <div className="mem-control-row">
          <div className="mem-control-text">
            <span className="mem-control-title">Forget everything</span>
            <span className="mem-control-copy">Removes every profile entry and episode.</span>
          </div>
          <button
            type="button"
            className="btn btn-secondary btn-danger"
            disabled={forgetAllBusy || importing || exporting}
            onClick={() => void forgetAll()}
            aria-busy={forgetAllBusy}
            aria-label={forgetAllArmed ? 'Confirm forgetting everything' : 'Forget everything'}
          >
            {forgetAllBusy ? 'Forgetting…' : forgetAllArmed ? 'Confirm forget all' : 'Forget all'}
          </button>
        </div>
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
    </section>
  );
}

/** Human note for an import result (counts only — never content). */
function importNote(result: MemoryImportResult): string {
  const parts: string[] = ['Imported your memory as new copies — nothing existing was changed.'];
  if (result.profileImported !== null && result.episodesImported !== null) {
    parts.push(
      `Added ${result.profileImported} profile ${result.profileImported === 1 ? 'entry' : 'entries'} and ${result.episodesImported} ${result.episodesImported === 1 ? 'episode' : 'episodes'}.`,
    );
  }
  return parts.join(' ');
}

/** Show the persona label when a persona exists; episodes carry an id only. */
