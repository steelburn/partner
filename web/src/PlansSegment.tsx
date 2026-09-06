import { useEffect, useState, type FormEvent } from 'react';
import type { Persona, Plan, PlanSummary, TaskStatus } from '@partner/shared';
import { isSessionLost } from './lib/personas.js';
import { readStoredToken } from './lib/token.js';
import { clampText } from './lib/memory-helpers.js';
import { downloadTextFile } from './lib/download.js';
import { uid } from './NoteEditor.js';
import {
  planBundleToFile,
  planProgress,
  planToExportFileName,
  TASK_STATUSES,
  TASK_STATUS_LABELS,
} from './lib/note-helpers.js';
import {
  createPlan,
  deletePlan,
  exportPlan,
  getPlan,
  listPlans,
  setTaskStatus,
  updatePlan,
} from './lib/plans.js';

export interface PlansSegmentProps {
  /** True while this segment is the visible one (loads on first activation). */
  active: boolean;
  /** Personas available as task owners (null while the shell loads them). */
  personas: Persona[] | null;
  /** Forget the session and return to the pairing gate (auth failure). */
  onUnpair: () => void;
}

function sortPlans(list: readonly PlanSummary[]): PlanSummary[] {
  return [...list].sort(
    (a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt || a.id.localeCompare(b.id),
  );
}

function personaNameById(personas: readonly Persona[], id: string | null): string | null {
  if (id === null) return null;
  return personas.find((persona) => persona.id === id)?.name ?? null;
}

/**
 * M5 Plans segment (PLAN-M5.md): plan list (title, clamped description,
 * progress), a live planner (add milestone, add task with an optional owner
 * persona, checkbox/select status transitions with an optional note,
 * two-step deletes), and per-plan JSON export. Plan content is the OWNER's
 * data: it renders in the list and planner only — feedback carries titles,
 * counts and statuses, never task bodies.
 */
export default function PlansSegment({ active, personas, onUnpair }: PlansSegmentProps) {
  const [plans, setPlans] = useState<PlanSummary[] | null>(null);
  const [plansError, setPlansError] = useState<string | null>(null);
  const [sessionLost, setSessionLost] = useState(false);
  const [reloadTick, setReloadTick] = useState(0);
  const [newOpen, setNewOpen] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newBusy, setNewBusy] = useState(false);
  const [newError, setNewError] = useState<string | null>(null);
  const [openPlan, setOpenPlan] = useState<Plan | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);

  const load = async (quiet = false): Promise<void> => {
    const token = readStoredToken();
    if (!token) {
      setSessionLost(true);
      return;
    }
    if (!quiet) setPlansError(null);
    try {
      setPlans(sortPlans(await listPlans(token)));
    } catch (cause) {
      if (isSessionLost(cause)) {
        setSessionLost(true);
        return;
      }
      if (!quiet) {
        setPlansError(cause instanceof Error ? cause.message : 'Could not load plans.');
      }
    }
  };

  useEffect(() => {
    if (!active || sessionLost) return;
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, sessionLost, reloadTick]);

  const handleSessionLost = (): void => setSessionLost(true);
  const quietRefresh = (): void => setReloadTick((tick) => tick + 1);

  const create = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (newBusy) return;
    const title = newTitle.trim();
    if (title.length === 0) {
      setNewError('Name the plan first.');
      return;
    }
    const token = readStoredToken();
    if (!token) {
      handleSessionLost();
      return;
    }
    setNewBusy(true);
    setNewError(null);
    try {
      const plan = await createPlan(token, { title });
      setNewTitle('');
      setNewOpen(false);
      setOpenPlan(plan);
      void load(true);
    } catch (cause) {
      if (isSessionLost(cause)) {
        handleSessionLost();
        return;
      }
      setNewError(cause instanceof Error ? cause.message : 'Could not create the plan.');
    } finally {
      setNewBusy(false);
    }
  };

  const openById = async (id: string): Promise<void> => {
    if (openPlan?.id === id) return;
    const token = readStoredToken();
    if (!token) {
      handleSessionLost();
      return;
    }
    setOpenPlan(null);
    setOpenError(null);
    try {
      setOpenPlan(await getPlan(token, id));
    } catch (cause) {
      if (isSessionLost(cause)) {
        handleSessionLost();
        return;
      }
      setOpenError(cause instanceof Error ? cause.message : 'Could not open the plan.');
    }
  };

  const handlePlanChanged = (plan: Plan): void => {
    setOpenPlan(plan);
    void load(true);
  };

  const list = personas ?? [];
  const sorted = plans ?? [];

  return (
    <div className="p-segment">
      {sessionLost ? (
        <div className="memory-alert" role="alert">
          <p className="memory-alert-text">
            Your session with the Partner core has expired. Pair again to keep plans.
          </p>
          <button type="button" className="btn btn-secondary" onClick={onUnpair}>
            Pair again
          </button>
        </div>
      ) : null}

      {!sessionLost && plans === null && plansError === null ? (
        <p className="notes-loading" aria-busy="true">
          Loading plans…
        </p>
      ) : null}

      {!sessionLost && plansError !== null ? (
        <div className="memory-alert" role="alert">
          <p className="memory-alert-text">{plansError}</p>
          <button type="button" className="btn btn-secondary" onClick={() => void load()}>
            Try again
          </button>
        </div>
      ) : null}

      {!sessionLost && plans !== null ? (
        <>
          <section className="card" aria-label="Plan actions">
            <div className="n-toolbar">
              <button
                type="button"
                className="btn btn-primary"
                disabled={newBusy}
                onClick={() => {
                  setNewOpen((open) => !open);
                  setNewError(null);
                }}
                aria-expanded={newOpen}
              >
                {newOpen ? 'Close' : 'New plan'}
              </button>
            </div>
          </section>

          {newOpen ? (
            <section className="card" aria-label="Create a plan">
              <div className="sub-panel-title">New plan</div>
              <p className="sub-panel-copy">
                Plans hold milestones and tasks with owners. Start with a title; you add
                milestones and tasks next.
              </p>
              <form
                className="mem-search-form"
                onSubmit={(event) => void create(event)}
              >
                <input
                  className="field mem-search-input"
                  type="text"
                  value={newTitle}
                  placeholder="Plan title"
                  aria-label="New plan title"
                  disabled={newBusy}
                  onChange={(event) => {
                    setNewTitle(event.target.value);
                    setNewError(null);
                  }}
                />
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={newBusy}
                  aria-busy={newBusy}
                >
                  {newBusy ? 'Creating…' : 'Create plan'}
                </button>
              </form>
              {newError ? (
                <p className="row-error" role="alert">
                  {newError}
                </p>
              ) : null}
            </section>
          ) : null}

          <section className="card" aria-label="Plans">
            <div className="section-head">
              <h2 className="card-title">Plans</h2>
              {plans.length > 0 ? (
                <span className="chip" aria-label={`${plans.length} plans`}>
                  {plans.length}
                </span>
              ) : null}
            </div>
            <p className="card-copy">
              Structured goals with milestones and tasks. Open a plan to check tasks off,
              assign owners and note blockers.
            </p>
            {plans.length === 0 ? (
              <div className="empty-state empty-inline">
                <p className="empty-state-title">No plans yet</p>
                <p className="empty-state-copy">
                  Create a plan for anything you want to move forward — a project, a routine, a
                  season.
                </p>
              </div>
            ) : (
              <ul className="p-list">
                {sorted.map((row) => {
                  const progress = planProgress(row);
                  return (
                    <li key={row.id}>
                      <button
                        type="button"
                        className="p-row"
                        onClick={() => void openById(row.id)}
                        aria-label={`Open plan ${row.title}`}
                      >
                        <span className="p-row-title">{row.title}</span>
                        {row.description !== null && row.description.length > 0 ? (
                          <span className="p-row-desc">{clampText(row.description, 180)}</span>
                        ) : null}
                        <span className="p-row-meta">
                          {progress.total === 0
                            ? 'No tasks yet'
                            : `${progress.done}/${progress.total} done`}
                        </span>
                        {progress.total > 0 ? (
                          <span className="progress-track" aria-hidden="true">
                            <span
                              className="progress-fill"
                              style={{ width: `${progress.pct}%` }}
                            />
                          </span>
                        ) : null}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          {openError ? (
            <div className="memory-alert" role="alert">
              <p className="memory-alert-text">{openError}</p>
            </div>
          ) : null}

          {openPlan !== null ? (
            <PlannerPanel
              key={openPlan.id}
              plan={openPlan}
              personas={list}
              onChanged={handlePlanChanged}
              onClosed={() => setOpenPlan(null)}
              onDeleted={() => {
                setOpenPlan(null);
                quietRefresh();
              }}
              onSessionLost={handleSessionLost}
            />
          ) : null}
        </>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Planner panel: meta + milestones + tasks, live-saved against the core
// ---------------------------------------------------------------------------

interface PlannerPanelProps {
  plan: Plan;
  personas: readonly Persona[];
  /** Every server-confirmed mutation reports the refreshed plan here. */
  onChanged: (plan: Plan) => void;
  onClosed: () => void;
  /** Fired after the whole plan is deleted. */
  onDeleted: () => void;
  onSessionLost: () => void;
}

function PlannerPanel({
  plan,
  personas,
  onChanged,
  onClosed,
  onDeleted,
  onSessionLost,
}: PlannerPanelProps) {
  const [titleDraft, setTitleDraft] = useState(plan.title);
  const [descDraft, setDescDraft] = useState(plan.description ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [deleteArmed, setDeleteArmed] = useState(false);
  const [milestoneDraft, setMilestoneDraft] = useState('');
  const [exporting, setExporting] = useState(false);

  const progress = planProgress(plan);

  /** Update meta + document in one audited PUT, then sync drafts. */
  const commit = async (
    title: string,
    description: string,
    document: Plan['document'],
  ): Promise<boolean> => {
    if (busy) return false;
    const token = readStoredToken();
    if (!token) {
      onSessionLost();
      return false;
    }
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const descriptionValue = description.trim();
      const updated = await updatePlan(token, plan.id, {
        title: title.trim(),
        ...(descriptionValue.length > 0 ? { description: descriptionValue } : { description: null }),
        document,
      });
      setTitleDraft(updated.title);
      setDescDraft(updated.description ?? '');
      onChanged(updated);
      return true;
    } catch (cause) {
      if (isSessionLost(cause)) {
        onSessionLost();
        return false;
      }
      setError(cause instanceof Error ? cause.message : 'Could not save the plan.');
      return false;
    } finally {
      setBusy(false);
    }
  };

  /** A status transition (audited server-side); returns success. */
  const transition = async (
    taskId: string,
    status: TaskStatus,
    statusNote?: string,
  ): Promise<boolean> => {
    if (busy) return false;
    const token = readStoredToken();
    if (!token) {
      onSessionLost();
      return false;
    }
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const updated = await setTaskStatus(token, plan.id, taskId, {
        status,
        ...(statusNote !== undefined ? { note: statusNote } : {}),
      });
      setTitleDraft(updated.title);
      setDescDraft(updated.description ?? '');
      onChanged(updated);
      return true;
    } catch (cause) {
      if (isSessionLost(cause)) {
        onSessionLost();
        return false;
      }
      setError(cause instanceof Error ? cause.message : 'Could not update the task.');
      return false;
    } finally {
      setBusy(false);
    }
  };

  const saveMeta = (): void => {
    void commit(titleDraft, descDraft, plan.document).then(() => undefined);
  };

  const addMilestone = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const title = milestoneDraft.trim();
    if (title.length === 0) return;
    const document = {
      milestones: [
        ...plan.document.milestones,
        { id: uid(), title, tasks: [] },
      ],
    };
    void commit(titleDraft, descDraft, document).then((ok) => {
      if (ok) setMilestoneDraft('');
    });
  };

  const removePlan = async (): Promise<void> => {
    if (busy) return;
    if (!deleteArmed) {
      setDeleteArmed(true);
      setError(null);
      return;
    }
    const token = readStoredToken();
    if (!token) {
      onSessionLost();
      return;
    }
    setBusy(true);
    try {
      await deletePlan(token, plan.id);
      onDeleted();
    } catch (cause) {
      setDeleteArmed(false);
      if (isSessionLost(cause)) {
        onSessionLost();
        return;
      }
      setError(cause instanceof Error ? cause.message : 'Could not delete the plan.');
    } finally {
      setBusy(false);
    }
  };

  const exportCurrent = async (): Promise<void> => {
    if (exporting || busy) return;
    const token = readStoredToken();
    if (!token) {
      onSessionLost();
      return;
    }
    setExporting(true);
    setError(null);
    setNote(null);
    try {
      const bundle = await exportPlan(token, plan.id);
      const filename = planToExportFileName(plan);
      downloadTextFile(filename, planBundleToFile(bundle));
      setNote(`Exported to ${filename}.`);
    } catch (cause) {
      if (isSessionLost(cause)) {
        onSessionLost();
        return;
      }
      setError(cause instanceof Error ? cause.message : 'Could not export the plan.');
    } finally {
      setExporting(false);
    }
  };

  const milestoneOps: MilestoneOps = {
    updateTask: (milestoneId, taskId, next) => {
      const document: Plan['document'] = {
        milestones: plan.document.milestones.map((milestone) =>
          milestone.id === milestoneId
            ? {
                ...milestone,
                tasks: milestone.tasks.map((task) => {
                  if (task.id !== taskId) return task;
                  // Clear the owner by omitting the key (matches add-task
                  // semantics — ownerPersonaId is optional on the wire).
                  const cleared: Plan['document']['milestones'][number]['tasks'][number] = {
                    ...task,
                    title: next.title,
                  };
                  delete (cleared as { ownerPersonaId?: string }).ownerPersonaId;
                  if (next.ownerPersonaId !== null) {
                    cleared.ownerPersonaId = next.ownerPersonaId;
                  }
                  return cleared;
                }),
              }
            : milestone,
        ),
      };
      return commit(titleDraft, descDraft, document);
    },
    addTask: (milestoneId, title, ownerPersonaId) => {
      const document: Plan['document'] = {
        milestones: plan.document.milestones.map((milestone) =>
          milestone.id === milestoneId
            ? {
                ...milestone,
                tasks: [
                  ...milestone.tasks,
                  {
                    id: uid(),
                    title,
                    status: 'open',
                    ...(ownerPersonaId !== null ? { ownerPersonaId } : {}),
                  },
                ],
              }
            : milestone,
        ),
      };
      return commit(titleDraft, descDraft, document);
    },
    deleteTask: (milestoneId, taskId) => {
      const document: Plan['document'] = {
        milestones: plan.document.milestones.map((milestone) =>
          milestone.id === milestoneId
            ? { ...milestone, tasks: milestone.tasks.filter((task) => task.id !== taskId) }
            : milestone,
        ),
      };
      return commit(titleDraft, descDraft, document);
    },
    deleteMilestone: (milestoneId) => {
      const document: Plan['document'] = {
        milestones: plan.document.milestones.filter((milestone) => milestone.id !== milestoneId),
      };
      return commit(titleDraft, descDraft, document);
    },
  };

  return (
    <section className="card p-planner" aria-label={`Plan ${plan.title}`}>
      <div className="section-head">
        <h2 className="card-title">Plan</h2>
        <span className="chip" aria-label="Task progress">
          {progress.total === 0 ? 'No tasks yet' : `${progress.done}/${progress.total} done`}
        </span>
        <span className="mem-actions">
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={busy || exporting}
            onClick={() => void exportCurrent()}
            aria-busy={exporting}
          >
            {exporting ? 'Exporting…' : 'Export plan'}
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-sm btn-danger"
            disabled={busy || exporting}
            onClick={() => void removePlan()}
            aria-busy={busy && deleteArmed}
          >
            {deleteArmed ? 'Confirm delete' : 'Delete plan'}
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={busy || exporting}
            onClick={onClosed}
          >
            Close
          </button>
        </span>
      </div>

      {progress.total > 0 ? (
        <div className="p-progress">
          <span className="progress-track" aria-hidden="true">
            <span className="progress-fill" style={{ width: `${progress.pct}%` }} />
          </span>
          <span className="p-progress-label">
            {progress.pct}% done · {progress.total - progress.done} open
          </span>
        </div>
      ) : null}

      <div className="form-stack">
        <div className="form-field">
          <label className="label" htmlFor="plan-title-input">
            Title
          </label>
          <input
            id="plan-title-input"
            className="field"
            type="text"
            value={titleDraft}
            disabled={busy || exporting}
            onChange={(event) => {
              setTitleDraft(event.target.value);
              setError(null);
              setDeleteArmed(false);
            }}
            aria-required="true"
            spellCheck={false}
          />
        </div>
        <div className="form-field">
          <label className="label" htmlFor="plan-desc-input">
            Description <span className="label-optional">(optional)</span>
          </label>
          <textarea
            id="plan-desc-input"
            className="field"
            rows={2}
            value={descDraft}
            disabled={busy || exporting}
            onChange={(event) => {
              setDescDraft(event.target.value);
              setError(null);
              setDeleteArmed(false);
            }}
          />
        </div>
        <div className="form-actions">
          <button
            type="button"
            className="btn btn-secondary"
            disabled={busy || exporting || titleDraft.trim().length === 0}
            onClick={saveMeta}
            aria-busy={busy}
          >
            {busy ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      </div>

      <div className="sub-panel p-milestones">
        <div className="sub-panel-title">
          Milestones ({plan.document.milestones.length})
        </div>
        <p className="sub-panel-copy">
          Add milestones, then tasks under each. A task&apos;s owner is the persona you mean to
          work it; checking tasks off records the change with the core.
        </p>

        {plan.document.milestones.length === 0 ? (
          <p className="n-muted-line">No milestones yet — add the first one below.</p>
        ) : (
          <ul className="p-milestone-list">
            {plan.document.milestones.map((milestone) => (
              <li key={milestone.id}>
                <MilestoneCard
                  milestone={milestone}
                  personas={personas}
                  busy={busy || exporting}
                  ops={milestoneOps}
                  transition={transition}
                  onSessionLost={onSessionLost}
                />
              </li>
            ))}
          </ul>
        )}

        <form className="p-add-milestone" onSubmit={addMilestone}>
          <input
            className="field"
            type="text"
            value={milestoneDraft}
            placeholder="Add a milestone…"
            aria-label="New milestone title"
            disabled={busy || exporting}
            onChange={(event) => setMilestoneDraft(event.target.value)}
          />
          <button
            type="submit"
            className="btn btn-secondary"
            disabled={busy || exporting || milestoneDraft.trim().length === 0}
          >
            Add milestone
          </button>
        </form>
      </div>

      <div className="form-feedback" aria-live="polite">
        {error ? (
          <p className="row-error" role="alert">
            {error}
          </p>
        ) : note ? (
          <p className="success-note">{note}</p>
        ) : null}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// One milestone: task list + add-task + milestone delete
// ---------------------------------------------------------------------------

/** Document-shape ops the task/milestone rows can trigger. */
interface MilestoneOps {
  /** Rename a task and/or reassign its owner persona (null clears it). */
  updateTask: (
    milestoneId: string,
    taskId: string,
    next: { title: string; ownerPersonaId: string | null },
  ) => Promise<boolean>;
  addTask: (
    milestoneId: string,
    title: string,
    ownerPersonaId: string | null,
  ) => Promise<boolean>;
  deleteTask: (milestoneId: string, taskId: string) => Promise<boolean>;
  deleteMilestone: (milestoneId: string) => Promise<boolean>;
}

interface MilestoneCardProps {
  milestone: Plan['document']['milestones'][number];
  personas: readonly Persona[];
  busy: boolean;
  ops: MilestoneOps;
  transition: (taskId: string, status: TaskStatus, note?: string) => Promise<boolean>;
  onSessionLost: () => void;
}

function MilestoneCard({
  milestone,
  personas,
  busy,
  ops,
  transition,
  onSessionLost,
}: MilestoneCardProps) {
  const [adding, setAdding] = useState(false);
  const [taskTitle, setTaskTitle] = useState('');
  const [ownerId, setOwnerId] = useState('');
  const [addBusy, setAddBusy] = useState(false);
  const [deleteArmed, setDeleteArmed] = useState(false);
  const [rowError, setRowError] = useState<string | null>(null);

  const addTask = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (addBusy || busy) return;
    const title = taskTitle.trim();
    if (title.length === 0) return;
    setAddBusy(true);
    setRowError(null);
    try {
      const ok = await ops.addTask(
        milestone.id,
        title,
        ownerId.trim().length > 0 ? ownerId.trim() : null,
      );
      if (ok) {
        setTaskTitle('');
        setOwnerId('');
        setAdding(false);
      }
    } catch (cause) {
      if (isSessionLost(cause)) {
        onSessionLost();
        return;
      }
      setRowError(cause instanceof Error ? cause.message : 'Could not add the task.');
    } finally {
      setAddBusy(false);
    }
  };

  const removeMilestone = async (): Promise<void> => {
    if (busy || addBusy) return;
    if (!deleteArmed) {
      setDeleteArmed(true);
      setRowError(null);
      return;
    }
    setRowError(null);
    const ok = await ops.deleteMilestone(milestone.id);
    if (ok) setDeleteArmed(false);
  };

  const done = milestone.tasks.filter((task) => task.status === 'done').length;

  return (
    <div className="p-milestone">
      <div className="p-milestone-head">
        <h3 className="p-milestone-title">{milestone.title}</h3>
        <span className="chip" aria-label="Milestone progress">
          {milestone.tasks.length === 0
            ? 'No tasks'
            : `${done}/${milestone.tasks.length} done`}
        </span>
        <span className="mem-actions">
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={busy || addBusy}
            onClick={() => {
              setAdding((open) => !open);
              setDeleteArmed(false);
              setRowError(null);
            }}
            aria-expanded={adding}
          >
            {adding ? 'Close' : 'Add task'}
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-sm btn-danger"
            disabled={busy || addBusy}
            onClick={() => void removeMilestone()}
            aria-label={
              deleteArmed
                ? `Confirm deleting milestone ${milestone.title}`
                : `Delete milestone ${milestone.title}`
            }
          >
            {deleteArmed ? 'Confirm delete' : 'Delete'}
          </button>
        </span>
      </div>

      {adding ? (
        <form className="p-add-task" onSubmit={(event) => void addTask(event)}>
          <input
            className="field"
            type="text"
            value={taskTitle}
            placeholder="Task title"
            aria-label="New task title"
            disabled={busy || addBusy}
            onChange={(event) => {
              setTaskTitle(event.target.value);
              setRowError(null);
            }}
          />
          <select
            className="field p-owner-select"
            value={ownerId}
            disabled={busy || addBusy}
            onChange={(event) => setOwnerId(event.target.value)}
            aria-label="Task owner persona"
          >
            <option value="">No owner</option>
            {personas.map((persona) => (
              <option key={persona.id} value={persona.id}>
                {persona.name}
              </option>
            ))}
          </select>
          <button
            type="submit"
            className="btn btn-primary btn-sm"
            disabled={busy || addBusy || taskTitle.trim().length === 0}
            aria-busy={addBusy}
          >
            {addBusy ? 'Adding…' : 'Add'}
          </button>
        </form>
      ) : null}

      {milestone.tasks.length > 0 ? (
        <ul className="p-task-list">
          {milestone.tasks.map((task) => (
            <li key={task.id}>
              <TaskRow
                task={task}
                milestoneId={milestone.id}
                personas={personas}
                busy={busy || addBusy}
                transition={transition}
                ops={ops}
                onSessionLost={onSessionLost}
              />
            </li>
          ))}
        </ul>
      ) : null}

      {rowError ? (
        <p className="row-error" role="alert">
          {rowError}
        </p>
      ) : null}
    </div>
  );
}

interface TaskRowProps {
  task: Plan['document']['milestones'][number]['tasks'][number];
  milestoneId: string;
  personas: readonly Persona[];
  busy: boolean;
  transition: (taskId: string, status: TaskStatus, note?: string) => Promise<boolean>;
  ops: MilestoneOps;
  onSessionLost: () => void;
}

function TaskRow({
  task,
  milestoneId,
  personas,
  busy,
  transition,
  ops,
  onSessionLost,
}: TaskRowProps) {
  const [noteOpen, setNoteOpen] = useState(false);
  const [noteDraft, setNoteDraft] = useState('');
  const [deleteArmed, setDeleteArmed] = useState(false);
  const [localBusy, setLocalBusy] = useState(false);
  const [rowError, setRowError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [titleDraft, setTitleDraft] = useState(task.title);
  const [ownerDraft, setOwnerDraft] = useState(task.ownerPersonaId ?? '');

  const disabled = busy || localBusy;
  const ownerName = personaNameById(personas, task.ownerPersonaId ?? null);
  const hasNote = task.note !== undefined && task.note.length > 0;

  const startEdit = (): void => {
    setEditing(true);
    setTitleDraft(task.title);
    setOwnerDraft(task.ownerPersonaId ?? '');
    setDeleteArmed(false);
    setRowError(null);
  };

  const saveTitle = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (disabled) return;
    const title = titleDraft.trim();
    if (title.length === 0) {
      setRowError('Task title cannot be empty.');
      return;
    }
    setLocalBusy(true);
    setRowError(null);
    try {
      const ownerPersonaId = ownerDraft.trim().length > 0 ? ownerDraft.trim() : null;
      const ok = await ops.updateTask(milestoneId, task.id, { title, ownerPersonaId });
      if (ok) {
        setEditing(false);
        setTitleDraft(title);
      }
    } catch (cause) {
      if (isSessionLost(cause)) {
        onSessionLost();
        return;
      }
      setRowError(cause instanceof Error ? cause.message : 'Could not update the task.');
    } finally {
      setLocalBusy(false);
    }
  };


  const setStatus = async (
    status: TaskStatus,
    statusNote?: string,
  ): Promise<boolean> => {
    if (disabled) return false;
    setLocalBusy(true);
    setRowError(null);
    try {
      return await transition(task.id, status, statusNote);
    } catch (cause) {
      if (isSessionLost(cause)) {
        onSessionLost();
        return false;
      }
      setRowError(cause instanceof Error ? cause.message : 'Could not update the task.');
      return false;
    } finally {
      setLocalBusy(false);
    }
  };

  const toggle = (checked: boolean): void => {
    void setStatus(checked ? 'done' : 'open');
  };

  const saveNote = (): void => {
    void setStatus(task.status, noteDraft.trim()).then((ok) => {
      if (ok) {
        setNoteOpen(false);
        setNoteDraft('');
      }
    });
  };

  const removeTask = async (): Promise<void> => {
    if (disabled) return;
    if (!deleteArmed) {
      setDeleteArmed(true);
      setRowError(null);
      return;
    }
    setLocalBusy(true);
    setRowError(null);
    try {
      const ok = await ops.deleteTask(milestoneId, task.id);
      if (ok) setDeleteArmed(false);
    } catch (cause) {
      if (isSessionLost(cause)) {
        onSessionLost();
        return;
      }
      setRowError(cause instanceof Error ? cause.message : 'Could not delete the task.');
    } finally {
      setLocalBusy(false);
    }
  };

  const statusId = `task-status-${task.id}`;

  return (
    <div className="p-task">
      <div className="p-task-head">
        {editing ? (
          <form className="p-task-edit" onSubmit={(event) => void saveTitle(event)}>
            <input
              className="field"
              type="text"
              value={titleDraft}
              placeholder="Task title"
              aria-label={`Rename task ${task.title}`}
              disabled={disabled}
              autoFocus
              spellCheck={false}
              onChange={(event) => {
                setTitleDraft(event.target.value);
                setRowError(null);
              }}
            />
            <select
              className="field p-owner-select"
              value={ownerDraft}
              disabled={disabled}
              aria-label={`Owner of ${titleDraft || task.title}`}
              onChange={(event) => setOwnerDraft(event.target.value)}
            >
              <option value="">No owner</option>
              {personas.map((persona) => (
                <option key={persona.id} value={persona.id}>
                  {persona.name}
                </option>
              ))}
            </select>
            <button
              type="submit"
              className="btn btn-primary btn-sm"
              disabled={disabled || titleDraft.trim().length === 0}
              aria-busy={localBusy}
            >
              {localBusy ? 'Saving…' : 'Save'}
            </button>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              disabled={localBusy}
              onClick={() => {
                setEditing(false);
                setRowError(null);
              }}
            >
              Cancel
            </button>
          </form>
        ) : (
          <>
            <label className="p-task-check">
              <input
                type="checkbox"
                checked={task.status === 'done'}
                disabled={disabled}
                onChange={(event) => toggle(event.target.checked)}
                aria-label={`Mark ${task.title} done`}
              />
              <span className="p-task-title">{task.title}</span>
            </label>
            <select
              id={statusId}
              className="field p-task-status"
              value={task.status}
              disabled={disabled}
              aria-label={`Status of ${task.title}`}
              onChange={(event) => void setStatus(event.target.value as TaskStatus)}
            >
              {TASK_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {TASK_STATUS_LABELS[status]}
                </option>
              ))}
            </select>
            {ownerName !== null ? (
              <span className="mem-chip mem-chip-accent" title="Owning persona">
                {ownerName}
              </span>
            ) : null}
          </>
        )}
        <span className="mem-actions">
          {!editing ? (
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              disabled={disabled}
              onClick={startEdit}
              aria-label={`Edit task ${task.title}`}
            >
              Edit
            </button>
          ) : null}
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={disabled || editing}
            aria-expanded={noteOpen}
            onClick={() => {
              setNoteOpen((open) => !open);
              setDeleteArmed(false);
              setNoteDraft(task.note ?? '');
            }}
          >
            {hasNote ? 'Edit note' : 'Note'}
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-sm btn-danger"
            disabled={disabled || editing}
            onClick={() => void removeTask()}
            aria-label={
              deleteArmed ? `Confirm deleting task ${task.title}` : `Delete task ${task.title}`
            }
          >
            {deleteArmed ? 'Confirm' : 'Delete'}
          </button>
        </span>
      </div>

      {hasNote && !noteOpen ? (
        <p className="p-task-note">{clampText(task.note as string, 220)}</p>
      ) : null}

      {noteOpen ? (
        <div className="p-task-note-editor">
          <textarea
            className="field"
            rows={2}
            value={noteDraft}
            disabled={disabled}
            placeholder="Why this status? (kept with the task)"
            aria-label={`Status note for ${task.title}`}
            onChange={(event) => {
              setNoteDraft(event.target.value);
              setRowError(null);
            }}
          />
          <div className="form-actions">
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              disabled={disabled}
              onClick={saveNote}
            >
              Save note
            </button>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              disabled={disabled}
              onClick={() => {
                setNoteOpen(false);
                setRowError(null);
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      {rowError ? (
        <p className="row-error" role="alert">
          {rowError}
        </p>
      ) : null}
    </div>
  );
}
