import { useCallback, useRef, useState } from 'react';
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
import { useDecisionRerun } from './useDecisionRerun.js';

export interface TryToolPanelProps {
  root: ProjectRoot;
  /** Live approval queue (drives the auto re-exec on decision). */
  pending: PendingToolCall[];
  onSessionLost: () => void;
  onRefreshPending: () => void;
}

/** How many times a wait may re-ask before the panel stops asking (approve
 * with "remember" to skip future prompts for this tool + root). */
const MAX_ASKS = 2;

const TRY_TOOLS: ToolId[] = ['files.list', 'files.read', 'files.search'];

type TryResult =
  | { kind: 'list'; entries: FileListEntry[] | null }
  | { kind: 'read'; content: string; truncated: boolean }
  | { kind: 'search'; hits: FileSearchHit[] | null };

interface TryWait {
  pendingId: string;
  ask: number;
}

function isSessionLost(cause: unknown): boolean {
  return cause instanceof ApiRequestError && (cause.status === 401 || cause.status === 403);
}

/**
 * "Try a tool" demo panel (PLAN-M2 provisional UI): pick one of the low-risk
 * file tools plus a relative path/query and run it against a project root.
 * An un-granted run lands in the approval queue and this panel shows
 * "Waiting for approval…" until the queue decides, then re-executes to fetch
 * the real result.
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

  // Refs mirroring state so the (stable) run handlers never read stale values.
  const waitRef = useRef<TryWait | null>(null);
  waitRef.current = wait;
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
      if (action) applyResult(action.toolId, response.result);
      setWait(null);
      setBusy(false);
      return;
    }
    if (response.outcome === 'needs_approval') {
      const ask = (waitRef.current?.ask ?? 0) + 1;
      if (ask > MAX_ASKS) {
        setWait(null);
        setBusy(false);
        setError(
          'Still waiting after repeated prompts — approve with "Remember" so this tool can run without asking again.',
        );
        return;
      }
      setWait({ pendingId: response.pendingId, ask });
      setBusy(false);
      onRefreshPending();
      return;
    }
    setWait(null);
    setBusy(false);
    setError(`Denied: ${response.reason}`);
  };

  const execute = useCallback(
    async (toolId: ToolId, params: Record<string, unknown>): Promise<void> => {
      const token = readStoredToken();
      if (!token) {
        onSessionLost();
        return;
      }
      lastActionRef.current = { toolId, params };
      setBusy(true);
      setError(null);
      try {
        const response = await execTool(token, toolId, params);
        handleDecision(response);
      } catch (cause) {
        setBusy(false);
        handleError(cause, 'Could not run the tool.');
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [onSessionLost],
  );

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

  // Auto re-exec exactly once the queue resolves the row we are waiting on.
  const rerun = useCallback(() => {
    const last = lastActionRef.current;
    if (last) void execute(last.toolId, last.params);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [execute]);

  useDecisionRerun(pending, wait?.pendingId ?? null, rerun);

  const cancelWait = async (pendingId: string): Promise<void> => {
    const token = readStoredToken();
    if (!token) {
      onSessionLost();
      return;
    }
    setBusy(true);
    try {
      await decidePending(token, pendingId, { decision: 'deny' });
      setWait(null);
      onRefreshPending();
    } catch (cause) {
      handleError(cause, 'Could not cancel the request.');
    } finally {
      setBusy(false);
    }
  };

  const controlsLocked = busy || wait !== null;

  return (
    <div className="sub-panel">
      <p className="sub-panel-title">Try a tool (browse demo)</p>
      <p className="sub-panel-copy">
        Run files.list, files.read or files.search against this root. Relative paths only — a
        first run may need your approval in the queue above.
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
            className="btn btn-secondary btn-sm"
            disabled={busy}
            onClick={() => void cancelWait(wait.pendingId)}
          >
            Cancel request
          </button>
        </div>
      ) : null}

      {error ? (
        <p className="row-error" role="alert">
          {error}
        </p>
      ) : null}

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
