import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { PersonaCompare } from './PersonaCompare.js';
import type {
  Folder,
  IndependenceLevel,
  Persona,
  PersonaInput,
  PersonaSchedule,
  TaskClass,
  ThemeProfile,
} from '@partner/shared';
import {
  LEVEL_ORDER,
  TASK_CLASS_OPTIONS,
  levelExplain,
  levelLabel,
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
import { bindPersonaTheme } from './lib/themes.js';
import { listFolders } from './lib/folders.js';
import { readStoredToken } from './lib/token.js';
import { SchedulesSection } from './SchedulesSection.js';

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
 * M3 provisional Persona studio: list + Pause/Resume + Edit (inline form:
 * name, tagline, voice, system prompt, temperature, task-class model
 * overrides, independence level + explainer, default toggle) + Delete with a
 * two-step confirm (the default persona's delete is refused with a hint).
 * System prompts are edited in place and sent to the core only; they are
 * never logged, echoed or listed back by this view.
 *
 * M6 adds a per-row Theme bind (None/global or one of the saved themes) that
 * writes persona.colorTheme via bindPersonaTheme — the core resolves what
 * actually applies (persona -> global active -> preset).
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
  const [creating, setCreating] = useState(false);

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

  return (
    <section className="personas" aria-label="Personas">
      <div className="personas-panel">
        <div className="page-head">
          <div className="page-head-titles">
            <div className="kicker">Identity</div>
            <h1 className="page-title">Personas</h1>
          </div>
        </div>
        <p className="page-copy">
          Personas give Partner a voice, a model routing and an independence level. Pause one to
          stop it from chatting or acting anywhere — the kill switch.
        </p>

        {sessionLost ? (
          <div className="personas-alert" role="alert">
            <p className="personas-alert-text">
              Your session with the Partner core has expired. Pair again to manage personas.
            </p>
            <button type="button" className="btn btn-secondary" onClick={onUnpair}>
              Pair again
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
              Use <strong>New persona</strong> below — a name, a voice and a system prompt are
              all you need; the rest of the settings have safe defaults.
            </p>
          </div>
        ) : null}

        {!sessionLost && loadError === null && list.length > 0 ? (
          <ul className="persona-list">
            {list.map((persona) => (
              <li key={persona.id} className="persona-card">
                <PersonaRow
                  persona={persona}
                  themes={themes}
                  themesError={themesError}
                  onChanged={onRefresh}
                  onPersonaThemeBound={onPersonaThemeBound}
                  onOpenConversation={onOpenConversation}
                  onSessionLost={handleSessionLost}
                />
              </li>
            ))}
          </ul>
        ) : null}

        {!sessionLost ? (
          <section className="card" aria-label="New persona">
            {creating ? (
              <PersonaEditor
                persona={null}
                hasDefault={hasDefault}
                onSaved={() => {
                  setCreating(false);
                  onRefresh();
                }}
                onCancel={() => setCreating(false)}
                onOpenConversation={onOpenConversation}
                onSessionLost={handleSessionLost}
              />
            ) : (
              <div className="section-head">
                <h2 className="card-title">New persona</h2>
                <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>
                  New persona
                </button>
              </div>
            )}
          </section>
        ) : null}

        {!sessionLost && list.length >= 2 ? (
          <PersonaCompare personas={personas} onUnpair={handleSessionLost} />
        ) : null}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Persona row
// ---------------------------------------------------------------------------

type RowOp = 'pause' | 'resume' | 'delete' | 'bind';

interface PersonaRowProps {
  persona: Persona;
  themes: ThemeProfile[] | null;
  themesError: string | null;
  onChanged: () => void;
  /** A successful bind changes what theme applies to this persona. */
  onPersonaThemeBound: () => void;
  /** M14 runs panel: jump to a scheduled run's conversation in Chat. */
  onOpenConversation?: (conversationId: string) => void;
  onSessionLost: () => void;
}

function PersonaRow({ persona, themes, themesError, onChanged, onPersonaThemeBound, onOpenConversation, onSessionLost }: PersonaRowProps) {
  const [busy, setBusy] = useState<RowOp | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [editing, setEditing] = useState(false);
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
      // The core is the source of truth; flip locally + confirm via refresh.
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

  // M6 per-persona theme bind: '' = clear to the global active theme.
  const handleBindTheme = async (value: string): Promise<void> => {
    if (busy) return;
    const token = readStoredToken();
    if (!token) {
      onSessionLost();
      return;
    }
    const themeId = value.length === 0 ? null : value;
    setBusy('bind');
    setError(null);
    setConfirming(false);
    try {
      await bindPersonaTheme(token, persona.id, themeId);
      onChanged();
      onPersonaThemeBound();
    } catch (cause) {
      handleOpError(cause, 'Could not update this persona\'s theme.');
    } finally {
      setBusy(null);
    }
  };

  const idle = busy === null;
  const modelCount = Object.keys(persona.model.taskClasses).length;
  const metaParts: string[] = [];
  if (modelCount > 0) metaParts.push(`${modelCount} model override${modelCount === 1 ? '' : 's'}`);
  metaParts.push(`${persona.character.temperature.toFixed(1)} temp`);

  return (
    <article className="persona-card-inner">
      <div className="persona-card-head">
        <span className="persona-avatar" aria-hidden="true">
          {personaInitials(persona.name)}
        </span>
        <div className="persona-identity">
          <h3 className="persona-name">{persona.name}</h3>
          <div className="persona-chips">
            {persona.isDefault ? <span className="chip">Default</span> : null}
            {paused ? <span className="chip">Paused</span> : null}
            <span className="chip">{levelLabel(persona.independence.level)}</span>
          </div>
        </div>
        <div className="row-actions">
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => void togglePaused()}
            disabled={!idle}
            aria-busy={busy === 'pause' || busy === 'resume'}
            aria-label={`${paused ? 'Resume' : 'Pause'} persona ${persona.name}`}
          >
            {busy === 'pause'
              ? 'Pausing…'
              : busy === 'resume'
                ? 'Resuming…'
                : paused
                  ? 'Resume'
                  : 'Pause'}
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => {
              setConfirming(false);
              setError(null);
              setEditing((open) => !open);
            }}
            disabled={!idle}
            aria-expanded={editing}
          >
            {editing ? 'Close edit' : 'Edit'}
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
      </div>

      {persona.tagline ? <p className="persona-tagline">{persona.tagline}</p> : null}

      <p className="persona-meta">{metaParts.join(' · ')}</p>

      <div className="persona-theme-bind">
        <label className="label persona-theme-label" htmlFor={`persona-theme-${persona.id}`}>
          Theme
        </label>
        <PersonaThemeSelect
          personaId={persona.id}
          personaName={persona.name}
          bound={persona.colorTheme ?? ''}
          themes={themes}
          themesError={themesError}
          disabled={!idle}
          busy={busy === 'bind'}
          onChange={(value) => void handleBindTheme(value)}
        />
        <p className="persona-theme-hint">
          Binds this persona to a theme; “None (global)” follows the active theme set in Themes.
        </p>
      </div>

      {persona.isDefault ? (
        <p className="form-hint persona-hint">
          The default persona is what new chats start with — set another persona as default to
          delete this one.
        </p>
      ) : null}
      {error ? (
        <p className="row-error" role="alert">
          {error}
        </p>
      ) : null}

      {editing ? (
        <div className="row-form">
          <PersonaEditor
            persona={persona}
            hasDefault={persona.isDefault}
            onSaved={onChanged}
            onCancel={() => setEditing(false)}
            onOpenConversation={onOpenConversation}
            onSessionLost={onSessionLost}
          />
        </div>
      ) : null}
    </article>
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

const DEFAULT_MEMORY: PersonaInput['memory'] = { userProfile: 'none', episodes: 'none' };

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
  const [taskClasses, setTaskClasses] = useState<Record<TaskClass, string>>({
    chat: persona?.model.taskClasses.chat ?? '',
    deep: persona?.model.taskClasses.deep ?? '',
    coding: persona?.model.taskClasses.coding ?? '',
    vision: persona?.model.taskClasses.vision ?? '',
    cheap: persona?.model.taskClasses.cheap ?? '',
  });
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

    const taskClassMap = Object.fromEntries(
      Object.entries(taskClasses)
        .map(([taskClass, model]) => [taskClass, model.trim()] as const)
        .filter(([, model]) => model.length > 0),
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
      memory: persona?.memory ?? DEFAULT_MEMORY,
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
          {TASK_CLASS_OPTIONS.map((option) => (
            <div className="persona-model-row" key={option.value}>
              <label
                className="label persona-model-label"
                htmlFor={`${idPrefix}-model-${option.value}`}
              >
                {option.label}
              </label>
              <input
                id={`${idPrefix}-model-${option.value}`}
                className="field"
                type="text"
                value={taskClasses[option.value]}
                onChange={(event) =>
                  setTaskClasses((prev) => ({ ...prev, [option.value]: event.target.value }))
                }
                disabled={formDisabled}
                placeholder={option.hint}
                aria-label={`${option.label} model for this persona — ${option.hint}`}
              />
            </div>
          ))}
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
