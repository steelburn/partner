import { useEffect, useRef, useState } from 'react';
import type {
  FileListEntry,
  FileSearchHit,
  PendingToolCall,
  ProjectRoot,
  ToolExecResponse,
  ToolId,
} from '@partner/shared/src/tools.js';
import { ApiRequestError } from './lib/api.js';
import {
  formatFileSize,
  parseListResult,
  parseReadResult,
  parseSearchResult,
  riskOf,
  summarizeTool,
} from './lib/roots.js';
import { decidePending, execTool } from './lib/tools.js';
import { readStoredToken } from './lib/token.js';

export interface TryToolPanelProps {
  root: ProjectRoot;
  /** Live approval queue (drives the external-decision hint). */
  pending: PendingToolCall[];
  onSessionLost: () => void;
  onRefreshPending: () => void;
}

const TRY_TOOLS: ToolId[] = ['files.list', 'files.read', 'files.search'];

type TryResult =
  | { kind: 'list'; entries: FileListEntry[] | null }
  | { kind: 'read'; content: string; truncated: boolean }
  | { kind: 'search'; hits: FileSearchHit[] | null };

interface TryWait {
  pendingId: string;
}

function isSessionLost(cause: unknown): boolean {
  return cause instanceof ApiRequestError && (cause.status === 401 || cause.status === 403);
}

/**
 * "Try a tool" demo panel (PLAN-M2 provisional UI): run files.list/read/
 * search against a project root. An un-granted run lands in the approval
 * queue; you can approve HERE (the approval executes the tool and returns
 * its result) or decide in the queue above — the panel never auto re-runs
 * (an external decision already executed server-side).
 */
export default function TryToolPanel({
  root,
  pending,
  onSessionLost,
  onRefreshPending,
}: TryToolPanelProps) {
  const [tool, setTool] = useState<ToolId>('files.list');
  const [path, setPath] = useState('.');
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [wait, setWait] = useState<TryWait | null>(null);
  const [result, setResult] = useState<TryResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const lastActionRef = useRef<{ toolId: ToolId; params: Record<string, unknown> } | null>(null);
  const pathRef = useRef(path);
  pathRef.current = path;
  const queryRef = useRef(query);
  queryRef.current = query;

  const handleError = (cause: unknown, fallback: string): void => {
    if (isSessionLost(cause)) {
      onSessionLost();
      return;
    }
    setError(cause instanceof Error ? cause.message : fallback);
  };

  const applyResult = (toolId: ToolId, payload: Record<string, unknown>): void => {
    if (toolId === 'files.list') {
      const entries = parseListResult(payload);
      setResult({ kind: 'list', entries });
      if (entries === null) setError('The list result had an unexpected shape.');
    } else if (toolId === 'files.read') {
      const read = parseReadResult(payload);
      if (read === null) {
        setError('The read result had an unexpected shape.');
        return;
      }
      setResult({ kind: 'read', content: read.content, truncated: read.truncated });
    } else {
      const hits = parseSearchResult(payload);
      setResult({ kind: 'search', hits });
      if (hits === null) setError('The search result had an unexpected shape.');
    }
  };

  const handleDecision = (response: ToolExecResponse): void => {
    if (response.outcome === 'executed') {
      const action = lastActionRef.current;
      setResult(null);
      setNote(null);
      if (action) applyResult(action.toolId, response.result);
      setWait(null);
      setBusy(false);
      return;
    }
    if (response.outcome === 'needs_approval') {
      setWait({ pendingId: response.pendingId });
      setBusy(false);
      onRefreshPending();
      return;
    }
    setWait(null);
    setBusy(false);
    setError(`Denied: ${response.reason}`);
  };

  const execute = async (toolId: ToolId, params: Record<string, unknown>): Promise<void> => {
    const token = readStoredToken();
    if (!token) {
      onSessionLost();
      return;
    }
    lastActionRef.current = { toolId, params };
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const response = await execTool(token, toolId, params);
      handleDecision(response);
    } catch (cause) {
      setBusy(false);
      handleError(cause, 'Could not run the tool.');
    }
  };

  const buildParams = (): Record<string, unknown> | null => {
    const trimmedPath = pathRef.current.trim();
    if (tool === 'files.search') {
      const trimmedQuery = queryRef.current.trim();
      if (trimmedQuery.length === 0) {
        setError('Enter a search query.');
        return null;
      }
      const params: Record<string, unknown> = { projectId: root.id, query: trimmedQuery };
      if (trimmedPath.length > 0 && trimmedPath !== '.') params.path = trimmedPath;
      return params;
    }
    return { projectId: root.id, path: trimmedPath.length > 0 ? trimmedPath : '.' };
  };

  const run = async (toolId: ToolId = tool): Promise<void> => {
    setResult(null);
    const params = buildParams();
    if (params === null) return;
    await execute(toolId, params);
  };

  /** Approve the waiting call INLINE — the decision executes once and returns
   *  the tool result, so we render it directly (no second execution). */
  const approveHere = async (): Promise<void> => {
    const token = readStoredToken();
    const waitFor = wait;
    if (!token) {
      onSessionLost();
      return;
    }
    if (waitFor === null) return;
    setBusy(true);
    setError(null);
    try {
      const outcome = await decidePending(token, waitFor.pendingId, { decision: 'approve' });
      setWait(null);
      if (outcome.executed) {
        const action = lastActionRef.current;
        setResult(null);
        if (action && outcome.result) applyResult(action.toolId, outcome.result);
        setNote('Approved — the tool ran once.');
      } else {
        setError(outcome.error ? `Not executed: ${outcome.error}` : 'The tool did not execute.');
      }
      onRefreshPending();
    } catch (cause) {
      handleError(cause, 'Could not approve the request.');
    } finally {
      setBusy(false);
    }
  };

  const denyHere = async (): Promise<void> => {
    const token = readStoredToken();
    const waitFor = wait;
    if (!token) {
      onSessionLost();
      return;
    }
    if (waitFor === null) return;
    setBusy(true);
    try {
      await decidePending(token, waitFor.pendingId, { decision: 'deny' });
      setWait(null);
      onRefreshPending();
    } catch (cause) {
      handleError(cause, 'Could not cancel the request.');
    } finally {
      setBusy(false);
    }
  };

  // If the row was decided in the QUEUE (not here), never auto re-run — the
  // decision already executed server-side. Just surface a hint.
  useEffect(() => {
    if (wait !== null && !pending.some((item) => item.id === wait.pendingId)) {
      setWait(null);
      setNote(
        'Decided in the queue above — press Run again to fetch the result (approve with "Remember" to avoid future prompts).',
      );
    }
  }, [pending, wait]);

  const controlsLocked = busy || wait !== null;

  return (
    <div className="sub-panel">
      <p className="sub-panel-title">Try a tool (browse demo)</p>
      <p className="sub-panel-copy">
        Run files.list, files.read or files.search against this root. Relative paths only — a
        first run may need your approval.
      </p>
      <div className="tool-row">
        <select
          className="field tool-select"
          value={tool}
          disabled={controlsLocked}
          onChange={(event) => {
            setTool(event.target.value as ToolId);
            setResult(null);
            setError(null);
          }}
          aria-label="Tool to try"
        >
          {TRY_TOOLS.map((id) => (
            <option key={id} value={id}>
              {summarizeTool(id).label} ({riskOf(id)})
            </option>
          ))}
        </select>
        <input
          className="field tool-path"
          type="text"
          value={path}
          disabled={controlsLocked}
          onChange={(event) => {
            setPath(event.target.value);
            setResult(null);
          }}
          placeholder="Relative path (. for root)"
          aria-label="Relative path"
          spellCheck={false}
        />
        {tool === 'files.search' ? (
          <input
            className="field tool-query"
            type="text"
            value={query}
            disabled={controlsLocked}
            onChange={(event) => {
              setQuery(event.target.value);
              setResult(null);
            }}
            placeholder="Content query"
            aria-label="Search query"
          />
        ) : null}
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => void run()}
          disabled={controlsLocked}
          aria-busy={busy}
        >
          {busy ? 'Running…' : 'Run'}
        </button>
      </div>

      {wait !== null ? (
        <div className="waiting-box" role="status">
          <span className="waiting-text">Waiting for approval…</span>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={busy}
            onClick={() => void approveHere()}
          >
            Approve here
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={busy}
            onClick={() => void denyHere()}
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

      {result !== null ? <TryResultView result={result} onRow={onRow} /> : null}
    </div>
  );

  function onRow(entry: FileListEntry): void {
    setResult(null);
    if (entry.kind === 'dir') {
      setPath(entry.path);
      void execute('files.list', { projectId: root.id, path: entry.path });
    } else {
      void execute('files.read', { projectId: root.id, path: entry.path });
    }
  }
}

function TryResultView({
  result,
  onRow,
}: {
  result: TryResult;
  onRow: (entry: FileListEntry) => void;
}) {
  if (result.kind === 'read') {
    const preview = result.content.length > 4000 ? result.content.slice(0, 4000) : result.content;
    return (
      <div className="result-block">
        <p className="result-meta">
          {preview.length} chars shown{result.truncated ? ' (server-capped)' : ''}
        </p>
        <pre className="pre-content">{preview}</pre>
      </div>
    );
  }
  if (result.kind === 'search') {
    const hits = result.hits ?? [];
    const shown = hits.slice(0, 100);
    return (
      <div className="result-block">
        <p className="result-meta">
          {hits.length} hit{hits.length === 1 ? '' : 's'}
        </p>
        {shown.length === 0 ? (
          <p className="result-empty">No matches.</p>
        ) : (
          <ul className="hit-list">
            {shown.map((hit, index) => (
              <li key={`${hit.path}:${String(hit.line)}:${index}`} className="hit-row">
                <span className="hit-loc">
                  {hit.path}
                  {hit.line !== null ? `:${hit.line}` : ''}
                </span>
                <span className="hit-text">{truncateLine(hit.text)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }
  const entries = result.entries ?? [];
  return (
    <div className="result-block">
      <p className="result-meta">
        {entries.length} entr{entries.length === 1 ? 'y' : 'ies'}
      </p>
      {entries.length === 0 ? (
        <p className="result-empty">Directory is empty.</p>
      ) : (
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
                onClick={() => onRow(entry)}
              >
                {entry.kind === 'dir' ? 'Open' : 'Read'}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function truncateLine(text: string): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  return compact.length > 200 ? `${compact.slice(0, 200)}…` : compact;
}
