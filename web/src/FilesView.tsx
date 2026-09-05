import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import type {
  GrantRecord,
  PendingToolCall,
  ProjectRoot,
  ProjectRootInput,
  ToolDecisionInput,
  ToolId,
} from '@partner/shared/src/tools.js';
import { ApiRequestError } from './lib/api.js';
import {
  RISK_LABELS,
  RISK_TONE_CLASS,
  TOOL_LABELS,
  formatWhen,
  pendingLabel,
  summarizeTool,
  validateRootLabel,
  validateRootPath,
} from './lib/roots.js';
import {
  addGrant,
  addRoot,
  decidePending,
  listGrants,
  listRoots,
  removeGrant,
  removeRoot,
} from './lib/tools.js';
import { readStoredToken } from './lib/token.js';
import EditPreviewPanel from './RootEditor.js';
import TryToolPanel from './RootTryTool.js';

export interface FilesViewProps {
  onUnpair: () => void;
  /** True while this view is the visible one (drives loads + queue focus). */
  active?: boolean;
  /** Live pending-approval list, polled by the App shell (~4s). */
  pending: PendingToolCall[];
  /** Ask the App shell to re-fetch the pending list right now. */
  onRefreshPending: () => void;
}

function isSessionLost(cause: unknown): boolean {
  return cause instanceof ApiRequestError && (cause.status === 401 || cause.status === 403);
}

const GRANT_TOOLS = Object.keys(TOOL_LABELS) as ToolId[];

/**
 * M2 Files view (provisional): project-root manager (add/list/remove), the
 * per-root grant list with quick add/revoke, an approval queue with
 * Approve / Approve+remember / Deny, plus per-root "try a tool" and
 * "edit preview" demo panels. Token discipline: pending rows are summarized
 * (path/label only) and never show file content or search terms.
 */
export default function FilesView({
  onUnpair,
  active,
  pending,
  onRefreshPending,
}: FilesViewProps) {
  const [roots, setRoots] = useState<ProjectRoot[] | null>(null);
  const [grants, setGrants] = useState<GrantRecord[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sessionLost, setSessionLost] = useState(false);

  const refreshPendingRef = useRef(onRefreshPending);
  refreshPendingRef.current = onRefreshPending;

  const load = useCallback(async (): Promise<void> => {
    const token = readStoredToken();
    if (!token) {
      setSessionLost(true);
      return;
    }
    try {
      const [rootList, grantList] = await Promise.all([listRoots(token), listGrants(token)]);
      setRoots(rootList);
      setGrants(grantList);
      setLoadError(null);
    } catch (cause) {
      if (isSessionLost(cause)) {
        setSessionLost(true);
        return;
      }
      setLoadError(cause instanceof Error ? cause.message : 'Could not load roots.');
    }
  }, []);

  const loadQuiet = useCallback(async (): Promise<void> => {
    // Best-effort refresh after mutations; failures surface on next load().
    try {
      const token = readStoredToken();
      if (!token) return;
      const [rootList, grantList] = await Promise.all([listRoots(token), listGrants(token)]);
      setRoots(rootList);
      setGrants(grantList);
    } catch {
      // ignore transient refresh failures
    }
  }, []);

  // (Re)load roots + grants whenever the view becomes the active one, and
  // warm the queue once.
  useEffect(() => {
    if (!active) return;
    void load();
    refreshPendingRef.current();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, load]);

  const handleSessionLost = (): void => setSessionLost(true);

  const appendRoot = (created: ProjectRoot): void => {
    setRoots((prev) => [...(prev ?? []), created]);
  };

  const removeRootLocal = (id: string): void => {
    setRoots((prev) => prev?.filter((root) => root.id !== id) ?? prev);
    setGrants((prev) => prev?.filter((grant) => grant.projectId !== id) ?? prev);
  };

  const replaceGrant = (next: GrantRecord): void => {
    setGrants((prev) => [...(prev ?? []), next]);
  };

  const dropGrant = (id: string): void => {
    setGrants((prev) => prev?.filter((grant) => grant.id !== id) ?? prev);
  };

  const panelIntro =
    'Project roots are the only paths Partner’s tools can see. Register a folder, grant tools per root, and approve anything the broker asks about.';

  return (
    <section className="files" aria-label="Files and tools">
      <div className="files-panel">
        <h1 className="files-title">Files &amp; tools</h1>
        <p className="files-intro">{panelIntro}</p>

        {sessionLost ? (
          <div className="files-alert" role="alert">
            <p className="files-alert-text">
              Your session with the Partner core has expired. Pair again to manage roots.
            </p>
            <button type="button" className="btn btn-secondary" onClick={onUnpair}>
              Pair again
            </button>
          </div>
        ) : null}

        {!sessionLost && roots === null ? (
          <p className="files-loading" aria-busy="true">
            Loading roots…
          </p>
        ) : !sessionLost && loadError ? (
          <div className="files-alert" role="alert">
            <p className="files-alert-text">{loadError}</p>
            <button type="button" className="btn btn-secondary" onClick={() => void load()}>
              Try again
            </button>
          </div>
        ) : null}

        {!sessionLost ? (
          <QueueSection
            pending={pending}
            roots={roots ?? []}
            onRefreshPending={onRefreshPending}
            onRemembered={() => void loadQuiet()}
          />
        ) : null}

        {!sessionLost && roots !== null ? (
          <section className="card roots-card" aria-label="Project roots">
            <h2 className="card-title">Project roots</h2>
            <p className="card-copy">
              Everything outside a registered root is invisible to the tools. Removing a root also
              removes its grants.
            </p>
            {roots.length === 0 ? (
              <div className="empty-state empty-inline">
                <p className="empty-state-title">No roots yet</p>
                <p className="empty-state-copy">
                  Register the folder you want to work in below. Files tools can only act inside
                  registered roots.
                </p>
              </div>
            ) : (
              <ul className="roots-list">
                {roots.map((root) => (
                  <li key={root.id} className="root-card">
                    <RootCard
                      root={root}
                      grants={(grants ?? []).filter((grant) => grant.projectId === root.id)}
                      pending={pending}
                      onRefreshPending={onRefreshPending}
                      onSessionLost={handleSessionLost}
                      onRemoved={removeRootLocal}
                      onGrantAdded={replaceGrant}
                      onGrantRemoved={dropGrant}
                    />
                  </li>
                ))}
              </ul>
            )}
            <AddRootCard disabled={sessionLost} onAdded={appendRoot} onSessionLost={handleSessionLost} />
          </section>
        ) : null}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Approval queue
// ---------------------------------------------------------------------------

interface QueueSectionProps {
  pending: PendingToolCall[];
  roots: ProjectRoot[];
  onRefreshPending: () => void;
  /** A grant may have been created ("remember") — refresh the grant lists. */
  onRemembered: () => void;
}

function QueueSection({ pending, roots, onRefreshPending, onRemembered }: QueueSectionProps) {
  return (
    <section className="card queue-card" aria-label="Approval queue">
      <div className="section-head">
        <h2 className="section-title">Approval queue</h2>
        <span className="chip count-chip" aria-label={`${pending.length} pending`}>
          {pending.length} pending
        </span>
      </div>
      {pending.length === 0 ? (
        <div className="empty-state empty-inline">
          <p className="empty-state-title">Nothing waiting</p>
          <p className="empty-state-copy">
            Tools run only with your approval. Runs that need it will appear here with their risk
            level — approve, approve &amp; remember, or deny.
          </p>
        </div>
      ) : (
        <ul className="queue-list">
          {pending.map((item) => (
            <li key={item.id} className="queue-item">
              <QueueItem
                item={item}
                projectLabel={
                  roots.find((root) => root.id === item.params.projectId)?.label
                }
                onRefreshPending={onRefreshPending}
                onRemembered={onRemembered}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * Human requester tag for a queue row: persona rows show the persona's name
 * ("Builder · …" per PLAN-M9) with 'Persona' as the honest fallback; skill
 * and manual rows get their plain labels.
 */
function queueRequesterLabel(item: PendingToolCall): string {
  if (item.requestedBy === 'persona') {
    return item.personaName !== undefined && item.personaName !== null && item.personaName !== ''
      ? item.personaName
      : 'Persona';
  }
  if (item.requestedBy === 'skill') return 'Skill';
  return 'Web';
}

function QueueItem({
  item,
  projectLabel,
  onRefreshPending,
  onRemembered,
}: {
  item: PendingToolCall;
  projectLabel?: string;
  onRefreshPending: () => void;
  onRemembered: () => void;
}) {
  const [busy, setBusy] = useState<'approve' | 'remember' | 'deny' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { label, risk } = summarizeTool(item.toolId);

  const decide = async (input: ToolDecisionInput): Promise<void> => {
    const token = readStoredToken();
    if (!token) {
      setError('Your session has expired — pair again.');
      return;
    }
    setError(null);
    try {
      const outcome = await decidePending(token, item.id, input);
      if (input.decision === 'approve') {
        if (input.remember === true) onRemembered();
        if (!outcome.executed && outcome.error) {
          setError(`${label} was not executed: ${outcome.error}`);
        }
      }
      onRefreshPending();
    } catch (cause) {
      setError(cause instanceof ApiRequestError ? cause.message : 'Could not reach the Partner core.');
    } finally {
      setBusy(null);
    }
  };

  const handle = (kind: 'approve' | 'remember' | 'deny'): void => {
    if (busy !== null) return;
    setBusy(kind);
    void decide(
      kind === 'deny'
        ? { decision: 'deny' }
        : { decision: 'approve', remember: kind === 'remember' },
    );
  };

  const labelText = `${label} — approve, approve and remember, or deny`;

  return (
    <div className="queue-item-inner">
      <div className="queue-item-head">
        <div className="queue-item-title">
          <span className="queue-tool">{label}</span>
          <span className={`risk-text ${RISK_TONE_CLASS[risk]}`}>
            {RISK_LABELS[risk]} risk
          </span>
        </div>
        <div className="row-actions">
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={busy !== null}
            onClick={() => handle('approve')}
            aria-busy={busy === 'approve'}
            aria-label={`${labelText}, this time`}
          >
            {busy === 'approve' ? 'Approving…' : 'Approve'}
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={busy !== null}
            onClick={() => handle('remember')}
            aria-busy={busy === 'remember'}
            aria-label={`${labelText}, always for this root`}
          >
            {busy === 'remember' ? 'Approving…' : 'Approve + remember'}
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-sm btn-danger"
            disabled={busy !== null}
            onClick={() => handle('deny')}
            aria-busy={busy === 'deny'}
            aria-label={`Deny ${label}`}
          >
            {busy === 'deny' ? 'Denying…' : 'Deny'}
          </button>
        </div>
      </div>
      <p className="queue-params">
        {pendingLabel(item.toolId, item.params, { projectLabel })}
      </p>
      <p className="queue-meta">
        {queueRequesterLabel(item)} · {formatWhen(item.createdAt)}
      </p>
      {error ? (
        <p className="row-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// One project root: identity + grants + demo panels
// ---------------------------------------------------------------------------

interface RootCardProps {
  root: ProjectRoot;
  grants: GrantRecord[];
  pending: PendingToolCall[];
  onRefreshPending: () => void;
  onSessionLost: () => void;
  onRemoved: (id: string) => void;
  onGrantAdded: (grant: GrantRecord) => void;
  onGrantRemoved: (id: string) => void;
}

function RootCard({
  root,
  grants,
  pending,
  onRefreshPending,
  onSessionLost,
  onRemoved,
  onGrantAdded,
  onGrantRemoved,
}: RootCardProps) {
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [rowError, setRowError] = useState<string | null>(null);
  const [showTry, setShowTry] = useState(false);
  const [showEdit, setShowEdit] = useState(false);

  const handleRemove = async (): Promise<void> => {
    if (!confirmingRemove) {
      setConfirmingRemove(true);
      setRowError(null);
      return;
    }
    const token = readStoredToken();
    if (!token) {
      onSessionLost();
      return;
    }
    setRemoving(true);
    try {
      await removeRoot(token, root.id);
      onRemoved(root.id);
    } catch (cause) {
      setConfirmingRemove(false);
      if (isSessionLost(cause)) {
        onSessionLost();
        return;
      }
      setRowError(cause instanceof Error ? cause.message : 'Could not remove the root.');
    } finally {
      setRemoving(false);
    }
  };

  return (
    <article className="root-card-inner">
      <div className="root-head">
        <div className="root-identity">
          <h3 className="root-title">{root.label}</h3>
          {root.readOnly ? <span className="source-badge">Read-only</span> : null}
        </div>
        <div className="row-actions">
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            aria-expanded={showTry}
            onClick={() => {
              setShowTry((v) => !v);
              setRowError(null);
            }}
          >
            {showTry ? 'Hide try-a-tool' : 'Try a tool'}
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            aria-expanded={showEdit}
            onClick={() => {
              setShowEdit((v) => !v);
              setRowError(null);
            }}
          >
            {showEdit ? 'Hide edit preview' : 'Edit preview'}
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-sm btn-danger"
            onClick={() => void handleRemove()}
            disabled={removing}
            aria-busy={removing}
            aria-label={
              confirmingRemove ? `Confirm removing root ${root.label}` : `Remove root ${root.label}`
            }
          >
            {removing ? 'Removing…' : confirmingRemove ? 'Confirm remove' : 'Remove'}
          </button>
        </div>
      </div>
      <p className="root-path">{root.path}</p>

      {rowError ? (
        <p className="row-error" role="alert">
          {rowError}
        </p>
      ) : null}

      <GrantSection
        root={root}
        grants={grants}
        onSessionLost={onSessionLost}
        onGrantAdded={onGrantAdded}
        onGrantRemoved={onGrantRemoved}
      />

      {showTry ? (
        <TryToolPanel
          root={root}
          pending={pending}
          onSessionLost={onSessionLost}
          onRefreshPending={onRefreshPending}
        />
      ) : null}

      {showEdit ? (
        <EditPreviewPanel
          root={root}
          pending={pending}
          onSessionLost={onSessionLost}
          onRefreshPending={onRefreshPending}
        />
      ) : null}
    </article>
  );
}

function GrantSection({
  root,
  grants,
  onSessionLost,
  onGrantAdded,
  onGrantRemoved,
}: {
  root: ProjectRoot;
  grants: GrantRecord[];
  onSessionLost: () => void;
  onGrantAdded: (grant: GrantRecord) => void;
  onGrantRemoved: (id: string) => void;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [grantTool, setGrantTool] = useState<ToolId>('files.list');
  const [error, setError] = useState<string | null>(null);

  const revoke = async (grantId: string): Promise<void> => {
    const token = readStoredToken();
    if (!token) {
      onSessionLost();
      return;
    }
    setBusyId(grantId);
    setError(null);
    try {
      await removeGrant(token, grantId);
      onGrantRemoved(grantId);
    } catch (cause) {
      if (isSessionLost(cause)) {
        onSessionLost();
        return;
      }
      setError(cause instanceof Error ? cause.message : 'Could not revoke the grant.');
    } finally {
      setBusyId(null);
    }
  };

  const add = async (): Promise<void> => {
    const token = readStoredToken();
    if (!token) {
      onSessionLost();
      return;
    }
    setAdding(true);
    setError(null);
    try {
      const created = await addGrant(token, { toolId: grantTool, projectId: root.id });
      onGrantAdded(created);
    } catch (cause) {
      if (isSessionLost(cause)) {
        onSessionLost();
        return;
      }
      setError(cause instanceof Error ? cause.message : 'Could not add the grant.');
    } finally {
      setAdding(false);
    }
  };

  const busy = adding || busyId !== null;

  return (
    <div className="grant-section">
      <div className="grant-head">
        <span className="grant-title">Grants for this root</span>
        {grants.length > 0 ? <span className="chip">{grants.length}</span> : null}
      </div>
      {grants.length === 0 ? (
        <p className="grant-empty">No grants yet — nothing runs here until you allow it.</p>
      ) : (
        <ul className="grant-list">
          {grants.map((grant) => (
            <li key={grant.id} className="grant-row">
              <span className="grant-tool">{TOOL_LABELS[grant.toolId] ?? grant.toolId}</span>
              {grant.note ? <span className="grant-note">{grant.note}</span> : null}
              <button
                type="button"
                className="btn btn-secondary btn-sm btn-danger"
                disabled={busy}
                onClick={() => void revoke(grant.id)}
                aria-busy={busyId === grant.id}
                aria-label={`Revoke ${grant.toolId} grant for ${root.label}`}
              >
                {busyId === grant.id ? 'Revoking…' : 'Revoke'}
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="quick-grant-row">
        <label className="label quick-grant-label" htmlFor={`grant-tool-${root.id}`}>
          Add grant
        </label>
        <select
          id={`grant-tool-${root.id}`}
          className="field grant-select"
          value={grantTool}
          disabled={busy || root.readOnly}
          onChange={(event) => {
            setGrantTool(event.target.value as ToolId);
            setError(null);
          }}
          aria-label={`Tool to grant for ${root.label}`}
        >
          {GRANT_TOOLS.map((id) => (
            <option key={id} value={id}>
              {TOOL_LABELS[id]}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          disabled={busy || root.readOnly}
          onClick={() => void add()}
          aria-busy={adding}
        >
          {adding ? 'Adding…' : 'Add'}
        </button>
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
// Add-root form
// ---------------------------------------------------------------------------

interface AddRootCardProps {
  disabled: boolean;
  onAdded: (created: ProjectRoot) => void;
  onSessionLost: () => void;
}

function AddRootCard({ disabled, onAdded, onSessionLost }: AddRootCardProps) {
  const [label, setLabel] = useState('');
  const [path, setPath] = useState('');
  const [readOnly, setReadOnly] = useState(false);
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
    const labelError = validateRootLabel(label);
    if (labelError) {
      setError(labelError);
      return;
    }
    const pathError = validateRootPath(path);
    if (pathError) {
      setError(pathError);
      return;
    }
    const input: ProjectRootInput = {
      label: label.trim(),
      path: path.trim(),
      ...(readOnly ? { readOnly: true } : {}),
    };
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const created = await addRoot(token, input);
      setLabel('');
      setPath('');
      setReadOnly(false);
      setNote(`Root "${created.label}" added — canonical path ${created.path}.`);
      onAdded(created);
    } catch (cause) {
      if (isSessionLost(cause)) {
        onSessionLost();
        return;
      }
      setError(cause instanceof Error ? cause.message : 'Could not add the root.');
    } finally {
      setBusy(false);
    }
  };

  const formDisabled = busy || disabled;

  return (
    <form
      className="sub-panel form-stack add-root-form"
      onSubmit={(event) => void handleSubmit(event)}
      aria-busy={busy}
    >
      <h3 className="add-root-title">Add a project root</h3>
      <div className="form-row">
        <div className="form-field">
          <label className="label" htmlFor="root-label">
            Label
          </label>
          <input
            id="root-label"
            className="field"
            type="text"
            value={label}
            disabled={formDisabled}
            onChange={(event) => {
              setLabel(event.target.value);
              setError(null);
            }}
            placeholder="My project"
            aria-required="true"
          />
        </div>
        <div className="form-field">
          <label className="label" htmlFor="root-path">
            Absolute path
          </label>
          <input
            id="root-path"
            className="field"
            type="text"
            value={path}
            disabled={formDisabled}
            onChange={(event) => {
              setPath(event.target.value);
              setError(null);
            }}
            placeholder="/home/you/projects/foo"
            aria-required="true"
            spellCheck={false}
          />
        </div>
      </div>
      <label className="check-label">
        <input
          type="checkbox"
          className="check"
          checked={readOnly}
          disabled={formDisabled}
          onChange={(event) => setReadOnly(event.target.checked)}
        />
        Read-only root (view and search only)
      </label>
      <p className="form-hint">
        The path must exist and be absolute; Partner canonicalizes it (symlinks resolved) and only
        ever lets tools act inside registered roots.
      </p>
      <div className="form-actions">
        <button type="submit" className="btn btn-primary" disabled={formDisabled}>
          {busy ? 'Adding…' : 'Add root'}
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
  );
}
