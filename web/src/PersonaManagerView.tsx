import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { sessionLostAction,sessionLostSentence } from './lib/auth-mode.js';
import { PersonaCompare } from './PersonaCompare.js';
import { declaredVisionModels, isImageCapableModel } from '@partner/shared';
import type {
  Folder,
  IndependenceLevel,
  Persona,
  PersonaInput,
  PersonaSchedule,
  ProviderSummary,
  TaskClass,
  ThemeProfile,
} from '@partner/shared';
import {
  LEVEL_ORDER,
  TASK_CLASS_OPTIONS,
  levelExplain,
  levelLabel,
  modelChoicesForTaskClass,
  personaInitials,
} from './lib/persona-helpers.js';
import {
  createPersona,
  deletePersona,
  isSessionLost,
  pausePersona,
  resumePersona,
  updatePersona,
} from './lib/personas.js';
import { listProviders } from './lib/api.js';
import { bindPersonaTheme } from './lib/themes.js';
import { listFolders } from './lib/folders.js';
import { readStoredToken } from './lib/token.js';
import { SchedulesSection } from './SchedulesSection.js';
import { IconClose } from './icons.js';

export interface PersonaManagerProps {
  /** Every persona (null while the shell is still loading them). */
  personas: Persona[] | null;
  /** Load-failure text for the list itself; shown with a retry action. */
  loadError: string | null;
  /** Every theme (M6) for the per-persona Theme bind select; null while loading. */
  themes: ThemeProfile[] | null;
  /** Load-failure text for the theme list (the bind select hides on error). */
  themesError: string | null;
  /** Forget the session and return to the pairing gate (auth failure). */
  onUnpair: () => void;
  /** Re-fetch personas from the core (keeps the shell + manager in sync). */
  onRefresh: () => void;
  /** Re-fetch the theme list (keeps the per-row bind select current). */
  onRefreshThemes: () => void;
  /** A persona theme binding changed — the shell re-resolves the active theme. */
  onPersonaThemeBound: () => void;
  /** M14 runs panel: jump to a scheduled run's conversation in Chat. */
  onOpenConversation?: (conversationId: string) => void;
  /** True while this view is the visible one (triggers one refresh). */
  active?: boolean;
}

/**
 * M3 Persona studio, M31 card-deck layout: a wall of persona “business
 * cards” (avatar, name, tagline, independence + routing facts) with the full
 * editor in a drawer that slides in from the side. Pause/Resume stays on the
 * card (the kill switch must be one click); delete is a two-step confirm on
 * the card; everything else is edited in the drawer.
 *
 * System prompts are edited in place and sent to the core only; they are
 * never logged, echoed or listed back by this view.
 *
 * M6 adds a per-persona Theme bind (None/global or one of the saved themes) —
 * now inside the drawer, since it is one of the persona's editable details.
 */
export default function PersonaManagerView({
  personas,
  loadError,
  themes,
  themesError,
  onUnpair,
  onRefresh,
  onRefreshThemes,
  onPersonaThemeBound,
  onOpenConversation,
  active,
}: PersonaManagerProps) {
  const [sessionLost, setSessionLost] = useState(false);
  /** M31: which editor is open, if any. `new` creates; `edit` targets one id. */
  const [drawer, setDrawer] = useState<{ kind: 'new' } | { kind: 'edit'; id: string } | null>(null);

  useEffect(() => {
    if (!active || sessionLost) return;
    onRefresh();
    onRefreshThemes();
    // Refresh on first activation only; edits re-call onRefresh themselves.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, sessionLost]);

  const handleSessionLost = (): void => setSessionLost(true);
  const list = personas ?? [];
  const hasDefault = list.some((p) => p.isDefault);
  const editing = drawer?.kind === 'edit' ? list.find((p) => p.id === drawer.id) ?? null : null;

  const closeDrawer = (): void => setDrawer(null);

  // The drawer is a modal surface: Escape closes it, and focus moves into the
  // form on open (a dialog the keyboard cannot enter is a dead end).
  useEffect(() => {
    if (drawer === null) return;
    const nameId = drawer.kind === 'new' ? 'persona-new-name' : `persona-${drawer.id}-name`;
    document.getElementById(nameId)?.focus();
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setDrawer(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drawer]);

  // If the edited persona disappears (deleted elsewhere), close the drawer
  // rather than editing a stale object.
  useEffect(() => {
    if (drawer?.kind !== 'edit' || personas === null) return;
    if (!personas.some((p) => p.id === drawer.id)) setDrawer(null);
  }, [personas, drawer]);

  return (
    <section className="personas" aria-label="Personas">
      <div className="personas-panel">
        <header className="personas-masthead">
          <div className="page-head-titles">
            <div className="kicker">Identity</div>
            <h1 className="page-title">Personas</h1>
          </div>
          {!sessionLost && loadError === null && personas !== null ? (
            <button type="button" className="btn btn-primary" onClick={() => setDrawer({ kind: 'new' })}>
              New persona
            </button>
          ) : null}
        </header>
        <p className="page-copy personas-deck">
          Personas give Partner a voice, a model routing and an independence level. Pause one to
          stop it from chatting or acting anywhere — the kill switch.
        </p>

        {sessionLost ? (
          <div className="personas-alert" role="alert">
            <p className="personas-alert-text">
              {sessionLostSentence('manage personas')}
            </p>
            <button type="button" className="btn btn-secondary" onClick={onUnpair}>
              {sessionLostAction()}
            </button>
          </div>
        ) : null}

        {!sessionLost && loadError !== null ? (
          <div className="personas-alert" role="alert">
            <p className="personas-alert-text">{loadError}</p>
            <button type="button" className="btn btn-secondary" onClick={onRefresh}>
              Try again
            </button>
          </div>
        ) : null}

        {!sessionLost && loadError === null && personas === null ? (
          <p className="personas-loading" aria-busy="true">
            Loading personas…
          </p>
        ) : !sessionLost && loadError === null && list.length === 0 ? (
          <div className="empty-state">
            <p className="empty-state-title">No personas yet</p>
            <p className="empty-state-copy">
              Until you create one, chat has no voice, routing or independence level of its own.
              Use <strong>New persona</strong> above — a name, a voice and a system prompt are
              all you need; the rest of the settings have safe defaults.
            </p>
          </div>
        ) : null}

        {!sessionLost && loadError === null && list.length > 0 ? (
          <ul className="persona-deck">
            {list.map((persona) => (
              <li key={persona.id}>
                <PersonaCard
                  persona={persona}
                  onEdit={() => setDrawer({ kind: 'edit', id: persona.id })}
                  onChanged={onRefresh}
                  onSessionLost={handleSessionLost}
                />
              </li>
            ))}
          </ul>
        ) : null}

        {!sessionLost && list.length >= 2 ? (
          <PersonaCompare personas={personas} onUnpair={handleSessionLost} />
        ) : null}
      </div>

      {drawer !== null ? (
        <>
          <div className="persona-drawer-scrim" aria-hidden="true" onClick={closeDrawer} />
          <aside
            className="persona-drawer"
            role="dialog"
            aria-modal="true"
            aria-label={
              drawer.kind === 'new' ? 'New persona' : `Edit persona ${editing?.name ?? ''}`.trim()
            }
          >
            <header className="persona-drawer-head">
              <div className="persona-drawer-titles">
                <span className="kicker">
                  {drawer.kind === 'new' ? 'New persona' : 'Edit persona'}
                </span>
                <h2 className="persona-drawer-title">{editing?.name ?? 'Untitled'}</h2>
              </div>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={closeDrawer}
                aria-label="Close editor"
              >
                <IconClose />
              </button>
            </header>
            <div className="persona-drawer-body">
              {drawer.kind === 'edit' && editing !== null ? (
                <PersonaThemeBind
                  persona={editing}
                  themes={themes}
                  themesError={themesError}
                  onChanged={onRefresh}
                  onPersonaThemeBound={onPersonaThemeBound}
                  onSessionLost={handleSessionLost}
                />
              ) : null}
              <PersonaEditor
                key={drawer.kind === 'new' ? 'new' : (editing?.id ?? 'edit')}
                persona={drawer.kind === 'new' ? null : editing}
                hasDefault={drawer.kind === 'new' ? hasDefault : Boolean(editing?.isDefault)}
                onSaved={() => {
                  closeDrawer();
                  onRefresh();
                }}
                onCancel={closeDrawer}
                onOpenConversation={onOpenConversation}
                onSessionLost={handleSessionLost}
              />
            </div>
          </aside>
        </>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Persona card (M31)
// ---------------------------------------------------------------------------

type CardOp = 'pause' | 'resume' | 'delete';

interface PersonaCardProps {
  persona: Persona;
  /** Open the slide-out editor on this persona. */
  onEdit: () => void;
  onChanged: () => void;
  onSessionLost: () => void;
}

/**
 * One persona as a “business card”: the card face opens the editor, while the
 * two actions that must not hide behind a click (pause — the kill switch — and
 * delete) sit in the card footer.
 */
function PersonaCard({ persona, onEdit, onChanged, onSessionLost }: PersonaCardProps) {
  const [busy, setBusy] = useState<CardOp | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [paused, setPaused] = useState(persona.paused);

  // Keep the local paused chip in step when the parent list refreshes.
  useEffect(() => {
    setPaused(persona.paused);
  }, [persona.paused]);

  const handleOpError = (cause: unknown, fallback: string): void => {
    if (isSessionLost(cause)) {
      onSessionLost();
      return;
    }
    setError(cause instanceof Error ? cause.message : fallback);
  };

  const togglePaused = async (): Promise<void> => {
    if (busy) return;
    const token = readStoredToken();
    if (!token) {
      onSessionLost();
      return;
    }
    const target: 'pause' | 'resume' = paused ? 'resume' : 'pause';
    setBusy(target);
    setError(null);
    setConfirming(false);
    try {
      await (target === 'pause' ? pausePersona : resumePersona)(token, persona.id);
      setPaused(target === 'pause');
      onChanged();
    } catch (cause) {
      handleOpError(cause, 'Could not update the persona.');
    } finally {
      setBusy(null);
    }
  };

  const handleDelete = async (): Promise<void> => {
    if (busy || persona.isDefault) return;
    const token = readStoredToken();
    if (!token) {
      onSessionLost();
      return;
    }
    if (!confirming) {
      setConfirming(true);
      return;
    }
    setBusy('delete');
    setError(null);
    try {
      await deletePersona(token, persona.id);
      setConfirming(false);
      onChanged();
    } catch (cause) {
      setConfirming(false);
      handleOpError(cause, 'Could not delete the persona.');
    } finally {
      setBusy(null);
    }
  };

  const idle = busy === null;
  const modelCount = Object.keys(persona.model.taskClasses).length;

  return (
    <article className={paused ? 'persona-card is-paused' : 'persona-card'}>
      <button
        type="button"
        className="persona-card-open"
        onClick={onEdit}
        aria-label={`Edit persona ${persona.name}`}
      >
        <span className="persona-card-top">
          <span className="persona-card-avatar" aria-hidden="true">
            {personaInitials(persona.name)}
          </span>
          <span className="persona-card-chips">
            {persona.isDefault ? <span className="chip chip-accent">Default</span> : null}
            {paused ? <span className="chip">Paused</span> : null}
          </span>
        </span>
        <span className="persona-card-name">{persona.name}</span>
        {persona.tagline ? (
          <span className="persona-card-tagline">{persona.tagline}</span>
        ) : (
          <span className="persona-card-tagline persona-card-tagline-empty">
            No tagline yet
          </span>
        )}
        <span className="persona-card-facts">
          <span className="persona-card-fact">
            <span className="persona-card-fact-value">
              {levelLabel(persona.independence.level)}
            </span>
            <span className="persona-card-fact-label">Level</span>
          </span>
          <span className="persona-card-fact">
            <span className="persona-card-fact-value">
              {modelCount > 0 ? `${modelCount} pinned` : 'Auto'}
            </span>
            <span className="persona-card-fact-label">Routing</span>
          </span>
          <span className="persona-card-fact">
            <span className="persona-card-fact-value">
              {persona.character.temperature.toFixed(1)}
            </span>
            <span className="persona-card-fact-label">Temp</span>
          </span>
        </span>
        <span className="persona-card-edit-hint">Edit details</span>
      </button>

      <div className="persona-card-actions">
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={() => void togglePaused()}
          disabled={!idle}
          aria-busy={busy === 'pause' || busy === 'resume'}
          aria-label={`${paused ? 'Resume' : 'Pause'} persona ${persona.name}`}
        >
          {busy === 'pause' ? 'Pausing…' : busy === 'resume' ? 'Resuming…' : paused ? 'Resume' : 'Pause'}
        </button>
        <button
          type="button"
          className="btn btn-secondary btn-sm btn-danger"
          onClick={() => void handleDelete()}
          disabled={!idle || persona.isDefault}
          aria-busy={busy === 'delete'}
          aria-label={
            confirming
              ? `Confirm deleting persona ${persona.name}`
              : `Delete persona ${persona.name}`
          }
          title={persona.isDefault ? 'The default persona cannot be deleted.' : undefined}
        >
          {busy === 'delete' ? 'Deleting…' : confirming ? 'Confirm delete' : 'Delete'}
        </button>
      </div>

      {persona.isDefault ? (
        <p className="form-hint persona-hint">
          New chats start with this persona — set another as default to delete this one.
        </p>
      ) : null}
      {error ? (
        <p className="row-error" role="alert">
          {error}
        </p>
      ) : null}
    </article>
  );
}

// ---------------------------------------------------------------------------
// Theme bind (M6) — shown at the top of the persona drawer
// ---------------------------------------------------------------------------

interface PersonaThemeBindProps {
  persona: Persona;
  themes: ThemeProfile[] | null;
  themesError: string | null;
  onChanged: () => void;
  /** A successful bind changes what theme applies to this persona. */
  onPersonaThemeBound: () => void;
  onSessionLost: () => void;
}

function PersonaThemeBind({
  persona,
  themes,
  themesError,
  onChanged,
  onPersonaThemeBound,
  onSessionLost,
}: PersonaThemeBindProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleBind = async (value: string): Promise<void> => {
    if (busy) return;
    const token = readStoredToken();
    if (!token) {
      onSessionLost();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await bindPersonaTheme(token, persona.id, value.length === 0 ? null : value);
      onChanged();
      onPersonaThemeBound();
    } catch (cause) {
      if (isSessionLost(cause)) {
        onSessionLost();
        return;
      }
      setError(cause instanceof Error ? cause.message : 'Could not update this persona’s theme.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="persona-drawer-theme">
      <div className="form-field">
        <label className="label" htmlFor={`persona-theme-${persona.id}`}>
          Theme
        </label>
        <PersonaThemeSelect
          personaId={persona.id}
          personaName={persona.name}
          bound={persona.colorTheme ?? ''}
          themes={themes}
          themesError={themesError}
          disabled={busy}
          busy={busy}
          onChange={(value) => void handleBind(value)}
        />
        <p className="form-hint">
          Binds this persona to a theme; “None (global)” follows the active theme set in
          Settings › Themes.
        </p>
      </div>
      {error ? (
        <p className="row-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Per-persona theme bind select (M6)
// ---------------------------------------------------------------------------

interface PersonaThemeSelectProps {
  personaId: string;
  personaName: string;
  /** The persona's bound theme id ('' = follow the global active theme). */
  bound: string;
  themes: ThemeProfile[] | null;
  themesError: string | null;
  disabled: boolean;
  busy: boolean;
  onChange: (value: string) => void;
}

function PersonaThemeSelect({
  personaId,
  personaName,
  bound,
  themes,
  themesError,
  disabled,
  busy,
  onChange,
}: PersonaThemeSelectProps) {
  const id = `persona-theme-${personaId}`;
  if (themesError !== null) {
    return (
      <p className="persona-theme-hint" role="note">
        Themes could not be loaded — the persona keeps its current look.
      </p>
    );
  }
  if (themes === null) {
    return (
      <select
        id={id}
        className="field persona-theme-select"
        disabled={disabled || themes === null}
        aria-busy
        aria-label={`Theme for persona ${personaName}`}
      >
        <option value="">Loading themes…</option>
      </select>
    );
  }
  // A bound theme that no longer exists (deleted elsewhere) would otherwise
  // leave the controlled select blank — surface it so it can be rebound.
  const boundMissing = bound.length > 0 && !themes.some((t) => t.id === bound);
  return (
    <select
      id={id}
      className="field persona-theme-select"
      value={bound}
      onChange={(event) => onChange(event.target.value)}
      disabled={disabled}
      aria-busy={busy}
      aria-label={`Theme for persona ${personaName}`}
    >
      {boundMissing ? (
        <option value={bound} disabled>
          Removed theme — pick another
        </option>
      ) : null}
      <option value="">None (global)</option>
      {themes.map((theme) => (
        <option key={theme.id} value={theme.id}>
          {theme.name}
        </option>
      ))}
    </select>
  );
}

// ---------------------------------------------------------------------------
// Persona editor (create + edit share this form)
// ---------------------------------------------------------------------------

interface PersonaEditorProps {
  /** Persona being edited; null when creating. */
  persona: Persona | null;
  /** True when this form is the only default (used for hints). */
  hasDefault: boolean;
  onSaved: () => void;
  onCancel: () => void;
  /** M14 runs panel: jump to a scheduled run's conversation in Chat. */
  onOpenConversation?: (conversationId: string) => void;
  onSessionLost: () => void;
}

const DEFAULT_MEMORY: PersonaInput['memory'] = {
  userProfile: 'none',
  episodes: 'none',
  personaMemory: 'off',
};

/** Comma-separated editor input -> trimmed string list. */
function list(raw: string): string[] {
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
}

function PersonaEditor({ persona, hasDefault, onSaved, onCancel, onOpenConversation, onSessionLost }: PersonaEditorProps) {
  const [folders, setFolders] = useState<Folder[] | null>(null);
  const [homeFolderId, setHomeFolderId] = useState(persona?.homeFolderId ?? '');  const editing = persona !== null;
  const [name, setName] = useState(persona?.name ?? '');
  const [tagline, setTagline] = useState(persona?.tagline ?? '');
  const [voice, setVoice] = useState(persona?.character.voice ?? '');
  const [systemPrompt, setSystemPrompt] = useState(persona?.character.systemPrompt ?? '');
  const [temperature, setTemperature] = useState(persona ? String(persona.character.temperature) : '0.6');
  const [level, setLevel] = useState<IndependenceLevel>(persona?.independence.level ?? 'assist');
  // M19: persona-private memory (facts scoped to this persona, recalled only
  // in chats with it; auto-detected facts land as suggestions in Memory).
  const [personaMemory, setPersonaMemory] = useState(persona?.memory.personaMemory === 'on');
  const [taskClasses, setTaskClasses] = useState<Record<TaskClass, string>>({
    chat: persona?.model.taskClasses.chat ?? '',
    deep: persona?.model.taskClasses.deep ?? '',
    coding: persona?.model.taskClasses.coding ?? '',
    vision: persona?.model.taskClasses.vision ?? '',
    cheap: persona?.model.taskClasses.cheap ?? '',
  });
  // A task-class override is opt-in: unticked rows save nothing, so the
  // persona keeps the provider's default routing for that class.
  const [modelTicks, setModelTicks] = useState<Record<TaskClass, boolean>>(() => {
    const initial = {} as Record<TaskClass, boolean>;
    for (const option of TASK_CLASS_OPTIONS) {
      initial[option.value] = (persona?.model.taskClasses[option.value] ?? '') !== '';
    }
    return initial;
  });
  // Enabled providers that reported models — the override selects' options.
  // null while loading; [] when loading failed or nothing is configured.
  const [providers, setProviders] = useState<ProviderSummary[] | null>(null);
  const [isDefault, setIsDefault] = useState(persona?.isDefault ?? false);
  // M14 schedules (drafts of independence.schedules[] — saved with the form).
  const [schedules, setSchedules] = useState<PersonaSchedule[]>(
    persona?.independence.schedules ?? [],
  );
  // Schedule ids the persona ALREADY persisted (run-now is offered for them).
  const knownScheduleIds = useMemo(
    () => new Set((persona?.independence.schedules ?? []).map((schedule) => schedule.id)),
    [persona],
  );

  // D10: load the folder tree so the editor can offer a home folder.
  useEffect(() => {
    const token = readStoredToken();
    if (!token) return;
    listFolders(token).then(setFolders).catch(() => undefined);
  }, []);
  // M13: the override selects only offer models an enabled provider actually
  // reported, so a freeform typo can never be saved. A failed load leaves []
  // (a saved override stays visible as "not in your providers").
  useEffect(() => {
    const token = readStoredToken();
    if (!token) return;
    let cancelled = false;
    listProviders(token)
      .then((rows) => {
        if (!cancelled) setProviders(rows.filter((p) => p.enabled && p.defaultModels.length > 0));
      })
      .catch(() => {
        if (!cancelled) setProviders([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  // M11 F3 capability policy (comma-separated editor fields).
  const [defaultSkills, setDefaultSkills] = useState(persona?.policy?.skills?.default?.join(', ') ?? '');
  const [bannedSkills, setBannedSkills] = useState(persona?.policy?.skills?.banned?.join(', ') ?? '');
  const [bannedTools, setBannedTools] = useState(persona?.policy?.tools?.banned?.join(', ') ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const idPrefix = editing ? `persona-${persona.id}` : 'persona-new';
  const formDisabled = busy;

  const save = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (busy) return;
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
    const parsedTemperature = Number(temperature);
    if (!Number.isFinite(parsedTemperature) || parsedTemperature < 0 || parsedTemperature > 2) {
      setError('Temperature must be a number between 0 and 2.');
      return;
    }

    const ticked = TASK_CLASS_OPTIONS.filter((option) => modelTicks[option.value]);
    const unpicked = ticked.find((option) => taskClasses[option.value].trim() === '');
    if (unpicked !== undefined) {
      setError(`Pick a model for the ${unpicked.label} override, or untick it.`);
      return;
    }
    const taskClassMap = Object.fromEntries(
      ticked.map((option) => [option.value, taskClasses[option.value].trim()] as const),
    ) as Partial<Record<TaskClass, string>>;

    const input: PersonaInput = {
      name: trimmedName,
      ...(tagline.trim().length > 0 ? { tagline: tagline.trim() } : {}),
      character: {
        voice: voice.trim().length > 0 ? voice.trim() : 'warm-professional',
        language: persona && persona.character.language.trim().length > 0
          ? persona.character.language.trim()
          : 'en',
        systemPrompt: systemPrompt.trim(),
        temperature: parsedTemperature,
      },
      model: {
        ...(persona?.model.providerId ? { providerId: persona.model.providerId } : {}),
        ...(persona?.model.fallback ? { fallback: persona.model.fallback } : {}),
        taskClasses: taskClassMap,
      },
      independence: {
        level,
        requireHumanFor: persona?.independence.requireHumanFor ?? ['high'],
        autoScopes: persona?.independence.autoScopes ?? [],
        schedules,
      },
      memory: {
        ...(persona?.memory ?? DEFAULT_MEMORY),
        personaMemory: personaMemory ? 'on' : 'off',
      },
      ...(defaultSkills.trim() !== '' || bannedSkills.trim() !== '' || bannedTools.trim() !== ''
        ? {
            policy: {
              ...(defaultSkills.trim() !== '' || bannedSkills.trim() !== ''
                ? {
                    skills: {
                      ...(defaultSkills.trim() !== '' ? { default: list(defaultSkills) } : {}),
                      ...(bannedSkills.trim() !== '' ? { banned: list(bannedSkills) } : {}),
                    },
                  }
                : {}),
              ...(bannedTools.trim() !== '' ? { tools: { banned: list(bannedTools) } } : {}),
            },
          }
        : {}),
      ...(homeFolderId.trim() !== '' ? { homeFolderId: homeFolderId.trim() } : {}),
      isDefault,
    };

    setBusy(true);
    setError(null);
    try {
      if (editing) {
        await updatePersona(token, persona.id, input);
      } else {
        await createPersona(token, input);
      }
      onSaved();
    } catch (cause) {
      if (isSessionLost(cause)) {
        onSessionLost();
        return;
      }
      setError(cause instanceof Error ? cause.message : 'Could not save the persona.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="persona-form" onSubmit={(event) => void save(event)} aria-busy={busy}>
      <div className="form-stack">
        <div className="form-row">
          <div className="form-field">
            <label className="label" htmlFor={`${idPrefix}-name`}>
              Name
            </label>
            <input
              id={`${idPrefix}-name`}
              className="field"
              type="text"
              value={name}
              onChange={(event) => setName(event.target.value)}
              disabled={formDisabled}
              placeholder="Maya"
              aria-required="true"
            />
          </div>
          <div className="form-field">
            <label className="label" htmlFor={`${idPrefix}-tagline`}>
              Tagline
            </label>
            <input
              id={`${idPrefix}-tagline`}
              className="field"
              type="text"
              value={tagline}
              onChange={(event) => setTagline(event.target.value)}
              disabled={formDisabled}
              placeholder="Your sharp research partner"
            />
          </div>
        </div>

        <div className="form-row">
          <div className="form-field">
            <label className="label" htmlFor={`${idPrefix}-voice`}>
              Voice
            </label>
            <input
              id={`${idPrefix}-voice`}
              className="field"
              type="text"
              value={voice}
              onChange={(event) => setVoice(event.target.value)}
              disabled={formDisabled}
              placeholder="warm-professional"
            />
          </div>
          <div className="form-field">
            <label className="label" htmlFor={`${idPrefix}-temperature`}>
              Temperature (0–2)
            </label>
            <input
              id={`${idPrefix}-temperature`}
              className="field"
              type="number"
              min={0}
              max={2}
              step={0.1}
              value={temperature}
              onChange={(event) => setTemperature(event.target.value)}
              disabled={formDisabled}
            />
          </div>
        </div>

        <div className="form-field">
          <label className="label" htmlFor={`${idPrefix}-system-prompt`}>
            System prompt
          </label>
          <textarea
            id={`${idPrefix}-system-prompt`}
            className="field persona-prompt-input"
            value={systemPrompt}
            onChange={(event) => setSystemPrompt(event.target.value)}
            disabled={formDisabled}
            placeholder="Who is this persona, and how should it talk and work?"
            spellCheck={false}
          />
        </div>

        <div className="form-field">
          <label className="label" htmlFor={`${idPrefix}-level`}>
            Independence level
          </label>
          <select
            id={`${idPrefix}-level`}
            className="field persona-level-select"
            value={level}
            onChange={(event) => setLevel(event.target.value as IndependenceLevel)}
            disabled={formDisabled}
          >
            {LEVEL_ORDER.map((option) => (
              <option key={option} value={option}>
                {levelLabel(option)}
              </option>
            ))}
          </select>
          <p className="form-hint">{levelExplain(level)}</p>
          <p className="form-hint">
            High-risk actions always ask you first, at every level. Pausing a persona stops it
            everywhere instantly.
          </p>
        </div>

        <fieldset className="persona-models">
          <legend className="label persona-models-legend">Model overrides (optional)</legend>
          <p className="form-hint persona-models-hint">
            Tick a task class to pin it to one of your providers' models. Unticked classes keep the
            provider's default routing.
          </p>
          {TASK_CLASS_OPTIONS.map((option) => {
            const ticked = modelTicks[option.value];
            const current = taskClasses[option.value];
            const groups =
              providers === null
                ? []
                : modelChoicesForTaskClass(option.value, providers, {
                    pinnedProviderId: persona?.model.providerId,
                  });
            // A saved model id may no longer exist on any provider (provider
            // removed, purpose re-pointed) — keep it selectable so editing
            // another field never silently drops the override.
            const currentListed =
              current === '' || groups.some((group) => group.models.includes(current));
            return (
              <div className="persona-model-row" key={option.value}>
                <label className="persona-model-toggle">
                  <input
                    type="checkbox"
                    checked={ticked}
                    disabled={formDisabled}
                    onChange={(event) => {
                      const on = event.target.checked;
                      setModelTicks((prev) => ({ ...prev, [option.value]: on }));
                    }}
                    aria-label={`Override the ${option.label} model for this persona`}
                  />
                  <span className="persona-model-label">{option.label}</span>
                </label>
                {ticked ? (
                  <select
                    id={`${idPrefix}-model-${option.value}`}
                    className="field"
                    value={current}
                    onChange={(event) =>
                      setTaskClasses((prev) => ({ ...prev, [option.value]: event.target.value }))
                    }
                    disabled={formDisabled || providers === null}
                    aria-label={`${option.label} model for this persona — ${option.hint}`}
                  >
                    <option value="">
                      {providers === null
                        ? 'Loading models…'
                        : groups.length === 0
                          ? 'No provider models available'
                          : `Select a model — ${option.hint.toLowerCase()}`}
                    </option>
                    {currentListed ? null : (
                      <option value={current}>{current} — saved, not in your providers</option>
                    )}
                    {groups.map((group) => {
                      // M24: the "vision" mark has to agree with what the core
                      // decides at send time, which includes the models this
                      // profile DECLARES capable (ticks, or a `vision`
                      // purpose) — not just what the id looks like.
                      const declared = declaredVisionModels(
                        providers?.find((p) => p.id === group.providerId),
                      );
                      return (
                        <optgroup key={group.providerId} label={group.label}>
                          {group.models.map((model) => (
                            <option key={model} value={model}>
                              {model}
                              {isImageCapableModel(model, declared) ? ' · vision' : ''}
                            </option>
                          ))}
                        </optgroup>
                      );
                    })}
                  </select>
                ) : (
                  <span className="persona-model-auto">{option.hint}</span>
                )}
              </div>
            );
          })}
          {providers !== null && providers.length === 0 ? (
            <p className="form-hint">
              No enabled provider has reported models yet — add or test a provider in Providers to
              choose models here.
            </p>
          ) : null}
        </fieldset>

        <fieldset className="persona-policy">
          <legend className="label persona-policy-legend">Capability policy (optional)</legend>
          <div className="form-field">
            <label className="label" htmlFor={`${idPrefix}-policy-default-skills`}>
              Default skills (comma-separated)
            </label>
            <input
              id={`${idPrefix}-policy-default-skills`}
              className="field"
              type="text"
              value={defaultSkills}
              disabled={formDisabled}
              onChange={(event) => setDefaultSkills(event.target.value)}
              placeholder="web-research, docgen"
            />
            <p className="form-hint">Loaded into new chats with this persona.</p>
          </div>
          <div className="form-field">
            <label className="label" htmlFor={`${idPrefix}-policy-banned-skills`}>
              Banned skills (comma-separated)
            </label>
            <input
              id={`${idPrefix}-policy-banned-skills`}
              className="field"
              type="text"
              value={bannedSkills}
              disabled={formDisabled}
              onChange={(event) => setBannedSkills(event.target.value)}
              placeholder="ship, email"
            />
            <p className="form-hint">
              Invoking a banned skill is refused server-side — not negotiable by the model.
            </p>
          </div>
          <div className="form-field">
            <label className="label" htmlFor={`${idPrefix}-policy-banned-tools`}>
              Banned tools (comma-separated)
            </label>
            <input
              id={`${idPrefix}-policy-banned-tools`}
              className="field"
              type="text"
              value={bannedTools}
              disabled={formDisabled}
              onChange={(event) => setBannedTools(event.target.value)}
              placeholder="deploy, files.delete"
            />
            <p className="form-hint">
              The persona may never direct-execute these — bans beat its autonomy envelope.
            </p>
          </div>
        </fieldset>

        <fieldset className="persona-memory">
          <legend className="label persona-memory-legend">Memory</legend>
          <label className="check-label" htmlFor={`${idPrefix}-memory`}>
            <input
              id={`${idPrefix}-memory`}
              className="check"
              type="checkbox"
              checked={personaMemory}
              onChange={(event) => setPersonaMemory(event.target.checked)}
              disabled={formDisabled}
            />
            Keep a private memory of me for this persona
          </label>
          <p className="form-hint">
            When on, this persona notices durable facts tied to it and recalls them only while you
            are chatting with it — never in another persona&apos;s chat. Facts that apply everywhere
            (name, language, standing tone) are handled by the separate Automatic memory setting in
            Memory, not this tick. New facts arrive as suggestions for you to confirm.
          </p>
        </fieldset>

        <SchedulesSection
          idPrefix={idPrefix}
          personaId={persona?.id ?? null}
          knownScheduleIds={knownScheduleIds}
          schedules={schedules}
          onChange={setSchedules}
          disabled={formDisabled}
          onOpenConversation={onOpenConversation}
          onSessionLost={onSessionLost}
        />

        <div className="form-field">
          <label className="label" htmlFor={`${idPrefix}-home-folder`}>
            Home folder (optional)
          </label>
          <select
            id={`${idPrefix}-home-folder`}
            className="field"
            value={homeFolderId}
            disabled={formDisabled}
            onChange={(event) => setHomeFolderId(event.target.value)}
          >
            <option value="">Inbox</option>
            {(folders ?? []).map((folder) => (
              <option key={folder.id} value={folder.id}>
                {folder.name}
              </option>
            ))}
          </select>
          <p className="form-hint">
            New chats with this persona start in this folder — leave Inbox for none.
          </p>
        </div>

        <label className="check-label" htmlFor={`${idPrefix}-default`}>
          <input
            id={`${idPrefix}-default`}
            className="check"
            type="checkbox"
            checked={isDefault}
            onChange={(event) => setIsDefault(event.target.checked)}
            disabled={formDisabled}
          />
          Make this the default persona
        </label>
        {editing && hasDefault && !persona.isDefault ? (
          <p className="form-hint">Setting a new default unmarks the current one.</p>
        ) : null}

        <div className="form-actions">
          <button type="submit" className="btn btn-primary" disabled={formDisabled}>
            {busy ? 'Saving…' : editing ? 'Save changes' : 'Create persona'}
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={onCancel}
            disabled={formDisabled}
          >
            Cancel
          </button>
        </div>
        <div className="form-feedback" aria-live="polite">
          {error ? (
            <p className="form-error" role="alert">
              {error}
            </p>
          ) : null}
        </div>
      </div>
    </form>
  );
}
