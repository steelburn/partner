/**
 * M14 schedules + runs section (PLAN-M14.md S6) — rendered inside the
 * persona editor form, right under the capability policy.
 *
 * Schedules are DRAFTS of the persona's `independence.schedules[]`: the
 * persona editor owns the array; this section lists them (when summary,
 * enabled toggle), lets the user add/edit/remove one at a time (a local
 * working copy commits on Done — the persona form saves everything at
 * once), and offers "Run now" ONLY for schedule ids the persona already
 * persisted (a draft id would 404 server-side). The runs mini-panel reads
 * the schedule's own history (newest first) with a plain-language status
 * and refreshes after a run-now.
 *
 * All interaction states ride the design-system .btn/.field/.check rules —
 * focus-visible + disabled come from app.css tokens, never local CSS.
 */
import { useEffect, useState } from 'react';
import type { PersonaSchedule, ScheduleWeekday, ScheduleWhen } from '@partner/shared';
import { isSessionLost } from './lib/personas.js';
import { listScheduleRuns, runScheduleNow, type ScheduleRun } from './lib/schedules.js';
import { readStoredToken } from './lib/token.js';

const WEEKDAY_NAMES: readonly string[] = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
];

const pad2 = (value: number): string => String(value).padStart(2, '0');

export function scheduleWhenText(when: ScheduleWhen, tz?: string): string {
  let base: string;
  if (when.kind === 'daily') {
    base = `Daily at ${pad2(when.hour)}:${pad2(when.minute)}`;
  } else if (when.kind === 'weekly') {
    const name = WEEKDAY_NAMES[when.weekday] ?? '';
    base = `Weekly on ${name} at ${pad2(when.hour)}:${pad2(when.minute)}`;
  } else {
    base = `Every ${when.everyMinutes} min`;
  }
  return tz !== undefined && tz !== '' ? `${base} · ${tz}` : base;
}

export function scheduleStatusText(status: string): string {
  switch (status) {
    case 'running':
      return 'Running';
    case 'queued':
      return 'Waiting for approval';
    case 'done':
      return 'Done';
    case 'error':
      return 'Failed';
    case 'loop_exhausted':
      return 'Stopped (round cap)';
    default:
      return status;
  }
}

function timeAgo(epochMs: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - epochMs) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return `${days} d ago`;
}

function newScheduleId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

interface ScheduleEditorDraft {
  label: string;
  kind: 'daily' | 'weekly' | 'interval';
  weekday: ScheduleWeekday;
  time: string; // 'HH:MM'
  everyMinutes: string;
  prompt: string;
  saveNote: boolean;
  maxRounds: string;
  tz: string;
}

function toDraft(schedule: PersonaSchedule): ScheduleEditorDraft {
  const when = schedule.when;
  const common = {
    label: schedule.label,
    prompt: schedule.prompt,
    saveNote: schedule.saveNote === true,
    maxRounds: schedule.maxRounds !== undefined ? String(schedule.maxRounds) : '',
    tz: schedule.tz ?? '',
  };
  if (when.kind === 'interval') {
    return {
      ...common,
      kind: 'interval',
      weekday: 0,
      time: '08:00',
      everyMinutes: String(when.everyMinutes),
    };
  }
  return {
    ...common,
    kind: when.kind,
    weekday: when.kind === 'weekly' ? when.weekday : 0,
    time: `${pad2(when.hour)}:${pad2(when.minute)}`,
    everyMinutes: '60',
  };
}

/** Build a PersonaSchedule from the working copy; null when invalid. */
function fromDraft(draft: ScheduleEditorDraft): PersonaSchedule | null {
  const label = draft.label.trim();
  const prompt = draft.prompt.trim();
  if (label === '' || prompt === '') return null;
  const everyMinutes = Number(draft.everyMinutes);
  const maxRoundsRaw = draft.maxRounds.trim();
  const maxRoundsParsed = maxRoundsRaw === '' ? undefined : Number(maxRoundsRaw);
  if (maxRoundsRaw !== '') {
    if (
      maxRoundsParsed === undefined ||
      !Number.isInteger(maxRoundsParsed) ||
      maxRoundsParsed < 1 ||
      maxRoundsParsed > 8
    ) {
      return null;
    }
  }
  let when: ScheduleWhen;
  if (draft.kind === 'interval') {
    if (!Number.isInteger(everyMinutes) || everyMinutes < 5 || everyMinutes > 10080) return null;
    when = { kind: 'interval', everyMinutes };
  } else {
    const timeMatch = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(draft.time.trim());
    if (timeMatch === null) return null;
    when =
      draft.kind === 'weekly'
        ? {
            kind: 'weekly',
            weekday: draft.weekday,
            hour: Number(timeMatch[1]),
            minute: Number(timeMatch[2]),
          }
        : { kind: 'daily', hour: Number(timeMatch[1]), minute: Number(timeMatch[2]) };
  }
  const tz = draft.tz.trim();
  const schedule: PersonaSchedule = {
    id: '',
    label,
    when,
    prompt,
    enabled: true,
  };
  if (tz !== '') schedule.tz = tz;
  if (draft.saveNote) schedule.saveNote = true;
  if (maxRoundsParsed !== undefined) schedule.maxRounds = maxRoundsParsed;
  return schedule;
}

interface ScheduleRowEditorProps {
  idPrefix: string;
  initial: PersonaSchedule;
  /** The owning persona when persisted (null while creating a persona). */
  personaId: string | null;
  busy: boolean;
  onCommit(schedule: PersonaSchedule): void;
  onRemove(): void;
  onCancel(): void;
  onStarted(): void;
  onSessionLost(): void;
}

function ScheduleRowEditor({
  idPrefix,
  initial,
  personaId,
  busy,
  onCommit,
  onRemove,
  onCancel,
  onStarted,
  onSessionLost,
}: ScheduleRowEditorProps) {
  const [draft, setDraft] = useState<ScheduleEditorDraft>(() => toDraft(initial));
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [runNote, setRunNote] = useState<string | null>(null);

  const commit = (): void => {
    const schedule = fromDraft(draft);
    if (schedule === null) {
      setError('Give the schedule a label, a prompt and a valid time or interval.');
      return;
    }
    schedule.id = initial.id;
    schedule.enabled = initial.enabled !== false;
    onCommit(schedule);
  };

  const runNow = async (): Promise<void> => {
    if (running || personaId === null) return;
    const token = readStoredToken();
    if (!token) {
      onSessionLost();
      return;
    }
    setRunning(true);
    setError(null);
    setRunNote(null);
    try {
      await runScheduleNow(token, personaId, initial.id);
      setRunNote('Run started — results land in its conversation thread.');
      onStarted();
    } catch (cause) {
      if (isSessionLost(cause)) {
        onSessionLost();
        return;
      }
      setError(cause instanceof Error ? cause.message : 'Could not start the run.');
    } finally {
      setRunning(false);
    }
  };

  const set = (patch: Partial<ScheduleEditorDraft>): void => {
    setDraft((prev) => ({ ...prev, ...patch }));
    setError(null);
  };

  return (
    <div className="schedule-editor-card">
      <div className="form-row">
        <div className="form-field">
          <label className="label" htmlFor={`${idPrefix}-label`}>
            Label
          </label>
          <input
            id={`${idPrefix}-label`}
            className="field"
            type="text"
            value={draft.label}
            onChange={(event) => set({ label: event.target.value })}
            disabled={busy || running}
            placeholder="Morning brief"
            aria-required="true"
          />
        </div>
        <div className="form-field">
          <label className="label" htmlFor={`${idPrefix}-kind`}>
            When
          </label>
          <select
            id={`${idPrefix}-kind`}
            className="field"
            value={draft.kind}
            onChange={(event) => set({ kind: event.target.value as ScheduleEditorDraft['kind'] })}
            disabled={busy || running}
          >
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
            <option value="interval">Every N minutes</option>
          </select>
        </div>
      </div>

      <div className="form-row">
        {draft.kind === 'weekly' ? (
          <div className="form-field">
            <label className="label" htmlFor={`${idPrefix}-weekday`}>
              Weekday
            </label>
            <select
              id={`${idPrefix}-weekday`}
              className="field"
              value={draft.weekday}
              onChange={(event) => set({ weekday: Number(event.target.value) as ScheduleWeekday })}
              disabled={busy || running}
            >
              {WEEKDAY_NAMES.map((name, index) => (
                <option key={name} value={index}>
                  {name}
                </option>
              ))}
            </select>
          </div>
        ) : null}
        {draft.kind !== 'interval' ? (
          <div className="form-field">
            <label className="label" htmlFor={`${idPrefix}-time`}>
              Time
            </label>
            <input
              id={`${idPrefix}-time`}
              className="field"
              type="time"
              value={draft.time}
              onChange={(event) => set({ time: event.target.value })}
              disabled={busy || running}
            />
          </div>
        ) : (
          <div className="form-field">
            <label className="label" htmlFor={`${idPrefix}-every`}>
              Every N minutes (5–10080)
            </label>
            <input
              id={`${idPrefix}-every`}
              className="field"
              type="number"
              min={5}
              max={10080}
              step={5}
              value={draft.everyMinutes}
              onChange={(event) => set({ everyMinutes: event.target.value })}
              disabled={busy || running}
            />
          </div>
        )}
        <div className="form-field">
          <label className="label" htmlFor={`${idPrefix}-tz`}>
            Timezone (optional)
          </label>
          <input
            id={`${idPrefix}-tz`}
            className="field"
            type="text"
            value={draft.tz}
            onChange={(event) => set({ tz: event.target.value })}
            disabled={busy || running}
            placeholder="Blank = this machine"
            spellCheck={false}
          />
        </div>
        <div className="form-field">
          <label className="label" htmlFor={`${idPrefix}-rounds`}>
            Max rounds (1–8)
          </label>
          <input
            id={`${idPrefix}-rounds`}
            className="field"
            type="number"
            min={1}
            max={8}
            step={1}
            value={draft.maxRounds}
            onChange={(event) => set({ maxRounds: event.target.value })}
            disabled={busy || running}
            placeholder="Engine default"
          />
        </div>
      </div>

      <div className="form-field">
        <label className="label" htmlFor={`${idPrefix}-prompt`}>
          What it should do
        </label>
        <textarea
          id={`${idPrefix}-prompt`}
          className="field schedule-prompt-input"
          value={draft.prompt}
          onChange={(event) => set({ prompt: event.target.value })}
          disabled={busy || running}
          rows={3}
          placeholder="Summarise yesterday and plan today, then file a short note."
          spellCheck={false}
        />
      </div>

      <div className="schedule-editor-row">
        <label className="check-label" htmlFor={`${idPrefix}-note`}>
          <input
            id={`${idPrefix}-note`}
            className="check"
            type="checkbox"
            checked={draft.saveNote}
            onChange={(event) => set({ saveNote: event.target.checked })}
            disabled={busy || running}
          />
          Save the finished answer as a note
        </label>
        <div className="schedule-editor-actions">
          {personaId !== null ? (
            <button
              type="button"
              className="btn btn-sm btn-secondary"
              onClick={() => void runNow()}
              disabled={busy || running}
            >
              {running ? 'Starting…' : 'Run now'}
            </button>
          ) : null}
          <button type="button" className="btn btn-sm btn-secondary" onClick={onRemove} disabled={busy || running}>
            Remove
          </button>
          <button type="button" className="btn btn-sm btn-secondary" onClick={onCancel} disabled={busy || running}>
            Cancel
          </button>
          <button type="button" className="btn btn-sm btn-primary" onClick={commit} disabled={busy || running}>
            Done
          </button>
        </div>
      </div>
      <div className="form-feedback" aria-live="polite">
        {error !== null ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
        {runNote !== null ? <p className="form-success">{runNote}</p> : null}
      </div>
    </div>
  );
}

interface RunsPanelProps {
  personaId: string;
  /** Bumped after a run-now so the list refreshes. */
  refreshSignal: number;
  onSessionLost(): void;
}

function RunsPanel({ personaId, refreshSignal, onSessionLost }: RunsPanelProps) {
  const [runs, setRuns] = useState<ScheduleRun[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const token = readStoredToken();
    if (!token) {
      onSessionLost();
      return;
    }
    setError(null);
    listScheduleRuns(token, { personaId, limit: 6 })
      .then((rows) => {
        if (!cancelled) setRuns(rows);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        if (isSessionLost(cause)) {
          onSessionLost();
          return;
        }
        setError(cause instanceof Error ? cause.message : 'Could not load recent runs.');
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [personaId, refreshSignal]);

  return (
    <div className="schedule-runs">
      <div className="schedule-runs-head">
        <span className="label schedule-runs-title">Recent runs</span>
        <button
          type="button"
          className="btn btn-sm btn-secondary"
          onClick={() => setRuns(null)}
          disabled={false}
        >
          Refresh
        </button>
      </div>
      {error !== null ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : runs === null ? (
        <p className="schedule-runs-state" aria-busy="true">
          Loading runs…
        </p>
      ) : runs.length === 0 ? (
        <p className="schedule-runs-state">
          No runs yet — they appear here after a schedule fires or you press “Run now”.
        </p>
      ) : (
        <ul className="schedule-runs-list">
          {runs.map((run) => (
            <li className="schedule-run-row" key={run.id}>
              <span className={`run-status run-status-${run.status}`}>
                {scheduleStatusText(run.status)}
              </span>
              <span className="schedule-run-label">{run.label}</span>
              <span className="schedule-run-meta">
                {run.status === 'queued'
                  ? 'Decide the approval in Chat or Files to continue automatically.'
                  : `${timeAgo(run.startedAt)}${run.model !== null ? ` · ${run.model}` : ''}`}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export interface SchedulesSectionProps {
  idPrefix: string;
  /** Persona id when editing an existing persona (null while creating). */
  personaId: string | null;
  /** Schedule ids the persona has ALREADY persisted (runnable now). */
  knownScheduleIds: ReadonlySet<string>;
  /** Drafts owned by the persona editor. */
  schedules: PersonaSchedule[];
  onChange(next: PersonaSchedule[]): void;
  disabled: boolean;
  onSessionLost(): void;
}

export function SchedulesSection({
  idPrefix,
  personaId,
  knownScheduleIds,
  schedules,
  onChange,
  disabled,
  onSessionLost,
}: SchedulesSectionProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [runVersion, setRunVersion] = useState(0);
  const [runError, setRunError] = useState<string | null>(null);

  const addSchedule = (): void => {
    const draft: PersonaSchedule = {
      id: newScheduleId(),
      label: '',
      when: { kind: 'daily', hour: 8, minute: 0 },
      prompt: '',
      enabled: true,
    };
    onChange([...schedules, draft]);
    setEditingId(draft.id);
  };

  const commit = (updated: PersonaSchedule): void => {
    onChange(schedules.map((schedule) => (schedule.id === updated.id ? updated : schedule)));
    setEditingId(null);
  };

  const remove = (id: string): void => {
    onChange(schedules.filter((schedule) => schedule.id !== id));
    if (editingId === id) setEditingId(null);
  };

  const toggleEnabled = (id: string): void => {
    onChange(
      schedules.map((schedule) =>
        schedule.id === id
          ? { ...schedule, enabled: schedule.enabled !== false ? false : true }
          : schedule,
      ),
    );
  };

  const runNow = async (scheduleId: string): Promise<void> => {
    if (personaId === null) return;
    const token = readStoredToken();
    if (!token) {
      onSessionLost();
      return;
    }
    setRunError(null);
    try {
      await runScheduleNow(token, personaId, scheduleId);
      setRunVersion((version) => version + 1);
    } catch (cause) {
      if (isSessionLost(cause)) {
        onSessionLost();
        return;
      }
      setRunError(cause instanceof Error ? cause.message : 'Could not start the run.');
    }
  };

  const editing =
    editingId !== null ? (schedules.find((schedule) => schedule.id === editingId) ?? null) : null;

  return (
    <fieldset className="schedules-fieldset">
      <legend className="label schedules-legend">Schedules (autonomous work)</legend>
      <p className="form-hint">
        Runs only when this persona is unpaused with an auto or autonomous independence level. Each
        brief lands in its own conversation thread; if it needs an approval the run pauses and
        continues automatically after you decide.
      </p>

      {schedules.length === 0 ? (
        <p className="schedules-empty">
          No schedules yet — add one for a daily brief, a weekly digest or background work.
        </p>
      ) : (
        <ul className="schedules-list">
          {schedules.map((schedule) => {
            const isEditing = schedule.id === editingId;
            return (
              <li className="schedule-item" key={schedule.id}>
                {isEditing && editing !== null ? (
                  <ScheduleRowEditor
                    idPrefix={`${idPrefix}-sched-${schedule.id}`}
                    initial={editing}
                    personaId={personaId}
                    busy={disabled}
                    onCommit={commit}
                    onRemove={() => remove(editing.id)}
                    onCancel={() => setEditingId(null)}
                    onStarted={() => setRunVersion((version) => version + 1)}
                    onSessionLost={onSessionLost}
                  />
                ) : (
                  <div className="schedule-item-row">
                    <label
                      className="check-label schedule-enabled"
                      htmlFor={`${idPrefix}-enabled-${schedule.id}`}
                    >
                      <input
                        id={`${idPrefix}-enabled-${schedule.id}`}
                        className="check"
                        type="checkbox"
                        checked={schedule.enabled !== false}
                        onChange={() => toggleEnabled(schedule.id)}
                        disabled={disabled}
                        aria-label={`Enabled: ${schedule.label}`}
                      />
                    </label>
                    <div className="schedule-summary">
                      <span
                        className={
                          schedule.enabled === false
                            ? 'schedule-label-text schedule-disabled'
                            : 'schedule-label-text'
                        }
                      >
                        {schedule.label}
                      </span>
                      <span className="schedule-when-text">
                        {scheduleWhenText(schedule.when, schedule.tz)}
                      </span>
                    </div>
                    <div className="schedule-item-actions">
                      {knownScheduleIds.has(schedule.id) ? (
                        <button
                          type="button"
                          className="btn btn-sm btn-secondary"
                          onClick={() => void runNow(schedule.id)}
                          disabled={disabled}
                          aria-label={`Run ${schedule.label} now`}
                        >
                          Run now
                        </button>
                      ) : null}
                      <button
                        type="button"
                        className="btn btn-sm btn-secondary"
                        onClick={() => setEditingId(schedule.id)}
                        disabled={disabled}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        className="btn btn-sm btn-secondary"
                        onClick={() => remove(schedule.id)}
                        disabled={disabled}
                      >
                        Remove
                      </button>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <div className="schedule-add-row">
        <button
          type="button"
          className="btn btn-sm btn-secondary"
          onClick={addSchedule}
          disabled={disabled}
        >
          ＋ Add schedule
        </button>
        {runError !== null ? (
          <p className="form-error schedule-run-error" role="alert">
            {runError}
          </p>
        ) : null}
      </div>

      {personaId !== null && schedules.length > 0 ? (
        <RunsPanel personaId={personaId} refreshSignal={runVersion} onSessionLost={onSessionLost} />
      ) : null}
    </fieldset>
  );
}

// Re-exported so tests can pin the pure helpers without React DOM.
export { WEEKDAY_NAMES };
