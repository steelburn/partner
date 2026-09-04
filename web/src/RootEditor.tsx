import { useCallback, useMemo, useRef, useState } from 'react';
import type {
  FileListEntry,
  FilesApplyParams,
  PendingToolCall,
  ProjectRoot,
  ToolExecResponse,
  ToolId,
} from '@partner/shared/src/tools.js';
import { ApiRequestError } from './lib/api.js';
import {
  computeLineDiff,
  formatFileSize,
  parseListResult,
  parseReadResult,
  parseProposalId,
} from './lib/roots.js';
import { applyProposal, decidePending, discardProposal, execTool } from './lib/tools.js';
import { readStoredToken } from './lib/token.js';
import { useEffect } from 'react';

export interface EditPreviewPanelProps {
  root: ProjectRoot;
  pending: PendingToolCall[];
  onSessionLost: () => void;
  onRefreshPending: () => void;
}

type BrowseAction = 'list' | 'read';
type FlowAction = BrowseAction | 'edit' | 'apply';

interface LocalProposal {
  proposalId: string;
  path: string;
  originalContent: string;
  proposedContent: string;
}

interface EditWait {
  action: FlowAction;
  pendingId: string;
}

function isSessionLost(cause: unknown): boolean {
  return cause instanceof ApiRequestError && (cause.status === 401 || cause.status === 403);
}

/**
 * Write-preview flow (PLAN-M2): browse a root, load a file, edit its text,
 * and propose the change. files.edit never mutates — it returns a proposal
 * that renders as a line diff here. Apply is a second brokered call
 * (files.apply, high risk → becomes an approval item first) that performs the
 * atomic write + .bak backup core-side.
 */
export default function EditPreviewPanel({
  root,
  pending,
  onSessionLost,
  onRefreshPending,
}: EditPreviewPanelProps) {
  const [dirPath, setDirPath] = useState('.');
  const [entries, setEntries] = useState<FileListEntry[] | null>(null);
  const [target, setTarget] = useState<{ path: string; content: string } | null>(null);
  const [draft, setDraft] = useState('');
  const [proposal, setProposal] = useState<LocalProposal | null>(null);
  const [applied, setApplied] = useState(false);
  const [busy, setBusy] = useState<FlowAction | null>(null);
  const [wait, setWait] = useState<EditWait | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const lastActionRef = useRef<{
    action: FlowAction;
    toolId: ToolId;
    params: Record<string, unknown>;
    /** files.apply rides the dedicated /v1/proposals/:id/apply route. */
    via: 'exec' | 'apply';
  } | null>(null);

  const handleError = (cause: unknown, fallback: string): void => {
    if (isSessionLost(cause)) {
      onSessionLost();
      return;
    }
    setError(cause instanceof Error ? cause.message : fallback);
  };

  const clearTransient = (): void => {
    setError(null);
    setNote(null);
  };

  /** Route an executed result into the right panel state. */
  const interpret = (action: FlowAction, payload: Record<string, unknown>): void => {
    if (action === 'list') {
      setEntries(parseListResult(payload));
      if (parseListResult(payload) === null) setError('The list result had an unexpected shape.');
      return;
    }
    if (action === 'read') {
      const read = parseReadResult(payload);
      if (read === null) {
        setError('The read result had an unexpected shape.');
        return;
      }
      const rawPath = lastActionRef.current?.params.path;
      const loadedPath = typeof rawPath === 'string' ? rawPath : '';
      setTarget({ path: loadedPath, content: read.content });
      setDraft(read.content);
      setProposal(null);
      setApplied(false);
      return;
    }
    if (action === 'edit') {
      const proposalId = parseProposalId(payload);
      const t = targetRef.current;
      const d = draftRef.current;
      if (proposalId === null || t === null) {
        setError('The edit result did not include a proposal id.');
        return;
      }
      setProposal({
        proposalId,
        path: t.path,
        originalContent: t.content,
        proposedContent: d,
      });
      setApplied(false);
      setNote('Proposal ready — review the diff below before applying.');
      return;
    }
    // apply
    setApplied(true);
    setNote('Applied. The file was written with a .bak backup and its original file time preserved.');
  };

  const handleDecision = (response: ToolExecResponse): void => {
    if (response.outcome === 'executed') {
      const action = lastActionRef.current?.action ?? null;
      if (action) interpret(action, response.result);
      setWait(null);
      setBusy(null);
      return;
    }
    if (response.outcome === 'needs_approval') {
      const action = lastActionRef.current?.action ?? 'edit';
      setWait({ action, pendingId: response.pendingId });
      setBusy(null);
      onRefreshPending();
      return;
    }
    setWait(null);
    setBusy(null);
    setError(`Denied: ${response.reason}`);
  };

  const execute = useCallback(
    async (
      action: FlowAction,
      toolId: ToolId,
      params: Record<string, unknown>,
      via: 'exec' | 'apply' = 'exec',
    ): Promise<void> => {
      const token = readStoredToken();
      if (!token) {
        onSessionLost();
        return;
      }
      lastActionRef.current = { action, toolId, params, via };
      setBusy(action);
      clearTransient();
      try {
        const response =
          via === 'apply'
            ? await applyProposal(token, params as unknown as FilesApplyParams)
            : await execTool(token, toolId, params);
        handleDecision(response);
      } catch (cause) {
        setBusy(null);
        handleError(cause, 'Could not run the tool.');
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [onSessionLost],
  );

  const targetRef = useRef<typeof target>(null);
  targetRef.current = target;
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const proposalRef = useRef<typeof proposal>(null);
  proposalRef.current = proposal;
  const dirPathRef = useRef(dirPath);
  dirPathRef.current = dirPath;

  const listDir = useCallback(
    (path: string): Promise<void> =>
      execute('list', 'files.list', { projectId: root.id, path }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [execute],
  );

  const readFile = useCallback(
    (path: string): Promise<void> =>
      execute('read', 'files.read', { projectId: root.id, path }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [execute],
  );

  /** Approve the waiting call INLINE — the decision executes the tool once
   *  and returns its result, so we continue the flow directly here (no
   *  second execution anywhere). */
  const approveHere = async (): Promise<void> => {
    const token = readStoredToken();
    const waitFor = wait;
    if (!token) {
      onSessionLost();
      return;
    }
    if (waitFor === null) return;
    setBusy(waitFor.action);
    clearTransient();
    try {
      const outcome = await decidePending(token, waitFor.pendingId, { decision: 'approve' });
      setWait(null);
      if (outcome.executed) {
        const action = waitFor.action;
        interpret(action, outcome.result ?? {});
        setNote(
          action === 'apply'
            ? 'Approved — applied. The file was written with a .bak backup.'
            : action === 'edit'
              ? 'Approved — the edit proposal is ready below.'
              : 'Approved — the tool ran once.',
        );
      } else {
        setError(outcome.error ? `Not executed: ${outcome.error}` : 'The tool did not execute.');
      }
      onRefreshPending();
    } catch (cause) {
      handleError(cause, 'Could not approve the request.');
    } finally {
      setBusy(null);
    }
  };

  // If the row was decided in the QUEUE (not here), never auto re-run — the
  // decision already executed server-side. Just surface a hint.
  useEffect(() => {
    if (wait !== null && !pending.some((item) => item.id === wait.pendingId)) {
      setWait(null);
      setNote(
        'Decided in the queue above — press the action again to continue (approve with "Remember" to avoid future prompts).',
      );
    }
  }, [pending, wait]);

  const openDir = async (path: string): Promise<void> => {
    setDirPath(path);
    await listDir(path);
  };

  const propose = async (): Promise<void> => {
    if (busy !== null || wait !== null) return;
    const t = targetRef.current;
    if (t === null) {
      setError('Load a file first.');
      return;
    }
    const nextDraft = draftRef.current;
    if (nextDraft === t.content) {
      setError('No changes yet — edit the text before proposing.');
      return;
    }
    await execute('edit', 'files.edit', {
      projectId: root.id,
      path: t.path,
      proposedContent: nextDraft,
    });
  };

  const applyNow = async (): Promise<void> => {
    if (busy !== null || wait !== null) return;
    const p = proposalRef.current;
    if (p === null) return;
    await execute('apply', 'files.apply', { projectId: root.id, proposalId: p.proposalId }, 'apply');
  };

  const discardNow = async (): Promise<void> => {
    if (busy !== null || wait !== null) return;
    const p = proposalRef.current;
    if (p === null) return;
    const token = readStoredToken();
    if (!token) {
      onSessionLost();
      return;
    }
    setBusy('apply');
    clearTransient();
    try {
      await discardProposal(token, p.proposalId);
      setProposal(null);
      setNote('Proposal discarded — nothing was written.');
    } catch (cause) {
      handleError(cause, 'Could not discard the proposal.');
    } finally {
      setBusy(null);
    }
  };

  const cancelWait = async (pendingId: string): Promise<void> => {
    const token = readStoredToken();
    if (!token) {
      onSessionLost();
      return;
    }
    setBusy('apply');
    try {
      await decidePending(token, pendingId, { decision: 'deny' });
      setWait(null);
      onRefreshPending();
    } catch (cause) {
      handleError(cause, 'Could not cancel the request.');
    } finally {
      setBusy(null);
    }
  };

  const reload = async (): Promise<void> => {
    const t = targetRef.current;
    if (t) await readFile(t.path);
  };

  const diff = useMemo(() => {
    if (proposal === null) return null;
    return computeLineDiff(proposal.originalContent, proposal.proposedContent);
  }, [proposal]);

  const waitingAction = wait?.action ?? null;
  const controlsLocked = busy !== null || wait !== null;

  return (
    <div className="sub-panel">
      <p className="sub-panel-title">Edit preview</p>
      <p className="sub-panel-copy">
        Pick a file under the root, edit its text, and propose the change. Proposing never
        mutates — it prepares a diff. Apply is a separate high-risk step (atomic write + .bak
        backup core-side).
      </p>

      <div className="tool-row">
        <input
          className="field tool-path"
          type="text"
          value={dirPath}
          disabled={controlsLocked}
          onChange={(event) => setDirPath(event.target.value)}
          placeholder="Directory to browse (. for root)"
          aria-label="Directory to browse"
          spellCheck={false}
        />
        <button
          type="button"
          className="btn btn-secondary"
          disabled={controlsLocked}
          onClick={() => void openDir(dirPathRef.current.trim() || '.')}
          aria-busy={busy === 'list'}
        >
          {busy === 'list' ? 'Listing…' : 'List'}
        </button>
      </div>

      {entries !== null ? (
        <ul className="entry-list">
          {entries.map((entry) => (
            <li key={entry.path} className="entry-row">
              <span className={`entry-kind ${entry.kind === 'dir' ? 'kind-dir' : 'kind-file'}`}>
                {entry.kind === 'dir' ? 'dir' : 'file'}
              </span>
              <span className="entry-name">{entry.name}</span>
              <span className="entry-size">{formatFileSize(entry.size)}</span>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                disabled={controlsLocked}
                onClick={() => void (entry.kind === 'dir' ? openDir(entry.path) : readFile(entry.path))}
              >
                {entry.kind === 'dir' ? 'Open' : 'Edit'}
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {target !== null ? (
        <div className="editor-block">
          <div className="editor-head">
            <span className="editor-path">{target.path}</span>
            <span className="editor-meta">
              {target.content.length} chars loaded{proposal !== null ? ' · has proposal' : ''}
            </span>
          </div>
          <textarea
            className="field editor-textarea"
            value={draft}
            disabled={controlsLocked}
            onChange={(event) => {
              setDraft(event.target.value);
              if (proposal !== null) {
                // An edit invalidates the prepared proposal until re-proposed.
                setProposal(null);
                setApplied(false);
              }
              clearTransient();
            }}
            aria-label={`Proposed content for ${target.path}`}
            spellCheck={false}
          />
          <div className="tool-row">
            <button
              type="button"
              className="btn btn-primary"
              disabled={controlsLocked || draft === target.content}
              onClick={() => void propose()}
              aria-busy={busy === 'edit'}
            >
              {busy === 'edit' ? 'Proposing…' : 'Propose edit'}
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={controlsLocked}
              onClick={() => void reload()}
              aria-busy={busy === 'read'}
            >
              {busy === 'read' ? 'Loading…' : 'Reload file'}
            </button>
          </div>
        </div>
      ) : null}

      {proposal !== null && diff !== null ? (
        <div className="diff-block">
          <div className="diff-head">
            <span className="diff-path">{proposal.path}</span>
            <span className="diff-meta">
              +{diff.added} / −{diff.removed}
              {diff.added === 0 && diff.removed === 0 ? ' · no changes' : ''}
            </span>
          </div>
          <div className="diff-well" aria-label="Line diff">
            {diff.rows.map((row, index) => (
              <div key={index} className={`diff-row diff-row-${row.type}`}>
                <span className="diff-sign" aria-hidden="true">
                  {row.type === 'add' ? '+' : row.type === 'remove' ? '−' : ''}
                </span>
                <span className="diff-text">{row.text}</span>
              </div>
            ))}
          </div>
          {diff.truncated ? (
            <p className="diff-note">Preview truncated to the first 400 lines.</p>
          ) : null}
          <div className="tool-row">
            <button
              type="button"
              className="btn btn-primary"
              disabled={controlsLocked || applied}
              onClick={() => void applyNow()}
              aria-busy={busy === 'apply'}
            >
              {busy === 'apply' && !wait ? 'Applying…' : applied ? 'Applied' : 'Apply (high risk)'}
            </button>
            <button
              type="button"
              className="btn btn-secondary btn-danger"
              disabled={controlsLocked || applied}
              onClick={() => void discardNow()}
            >
              Discard
            </button>
          </div>
          <p className="form-hint">
            Apply runs files.apply — it always asks unless you approve with "Remember". Core-side it
            writes atomically, keeps a .bak backup and restores the original file time.
          </p>
        </div>
      ) : null}

      {wait !== null ? (
        <div className="waiting-box" role="status">
          <span className="waiting-text">
            {waitingAction === 'apply' ? 'Applying needs approval…' : 'Waiting for approval…'}
          </span>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={controlsLocked}
            onClick={() => void approveHere()}
            aria-busy={busy === waitingAction}
          >
            {busy === waitingAction ? 'Approving…' : 'Approve here'}
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={controlsLocked}
            onClick={() => void cancelWait(wait.pendingId)}
          >
            Deny
          </button>
        </div>
      ) : null}

      {error ? (
        <p className="row-error" role="alert">
          {error}
        </p>
      ) : null}
      {note ? <p className="success-note">{note}</p> : null}
    </div>
  );
}
