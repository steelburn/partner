/**
 * M10 Audit view (PLAN-M10 W4, eleventh tab): the core's redacted audit log
 * with actor/action/search filters and JSON/Markdown export.
 *
 * Token discipline + redaction: rows arrive already scrubbed (single
 * serialization point in the core); this view renders them and can never
 * reintroduce content — nothing typed in the filters is echoed into errors.
 * Export is built client-side from the fetched rows only.
 */
import { useEffect, useState, type FormEvent } from 'react';
import { listAudit, type AuditEntry } from './lib/audit.js';
import {
  auditAreaLabel,
  exportAuditJson,
  exportAuditMarkdown,
  prettyAuditDetails,
} from './lib/audit-helpers.js';
import { isSessionLost } from './lib/personas.js';
import { readStoredToken } from './lib/token.js';
import { formatWhen } from './lib/roots.js';

export interface AuditViewProps {
  onUnpair: () => void;
  /** True while this view is the visible one (drives load on activation). */
  active: boolean;
}

interface AuditFilters {
  actor: string;
  action: string;
  q: string;
}

const ACTOR_OPTIONS = ['', 'session', 'web', 'persona', 'skill'];

const EMPTY_FILTERS: AuditFilters = { actor: '', action: '', q: '' };

export default function AuditView({ onUnpair, active }: AuditViewProps) {
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState<AuditFilters>(EMPTY_FILTERS);
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [sessionLost, setSessionLost] = useState(false);

  const load = async (filter: AuditFilters): Promise<void> => {
    const token = readStoredToken();
    if (!token) {
      setSessionLost(true);
      return;
    }
    setBusy(true);
    try {
      const rows = await listAudit(token, {
        filter: {
          limit: 200,
          actor: filter.actor,
          action: filter.action,
          q: filter.q,
        },
      });
      setEntries(rows);
      setError(null);
    } catch (cause) {
      if (isSessionLost(cause)) {
        setSessionLost(true);
        return;
      }
      setError(cause instanceof Error ? cause.message : 'Could not load the audit log.');
    } finally {
      setBusy(false);
    }
  };

  // Load on first activation and whenever the view becomes visible again.
  useEffect(() => {
    if (active && entries === null) void load(EMPTY_FILTERS);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  if (sessionLost) {
    return (
      <div className="audit">
        <div className="audit-panel">
          <p className="pb-alert-text">
            Your session with the Partner core has expired. Pair again to continue.
          </p>
          <button type="button" className="btn btn-primary" onClick={onUnpair}>
            Pair again
          </button>
        </div>
      </div>
    );
  }

  const applyFilters = (event: FormEvent): void => {
    event.preventDefault();
    void load(filters);
  };

  const resetFilters = (): void => {
    setFilters(EMPTY_FILTERS);
    void load(EMPTY_FILTERS);
  };

  const toggleRow = (id: number): void => {
    setExpanded((prev) => ({ ...prev, [id]: !(prev[id] ?? false) }));
  };

  const filterDirty =
    filters.actor !== '' || filters.action !== '' || filters.q !== '';

  return (
    <div className="audit">
      <div className="audit-panel">
        <div className="page-head">
          <div className="page-head-titles">
            <div className="kicker">Activity</div>
            <h1 className="page-title">Audit</h1>
          </div>
        </div>
        <p className="page-copy">
          Every partner action lands here: tool runs, provider and budget
          events, persona and playbook activity, skill invocations. Secrets
          are scrubbed by the core before a row is ever stored — nothing in
          this view can show keys, tokens, or message/note content.
        </p>

        <form className="audit-filters" onSubmit={applyFilters}>
          <label className="label" htmlFor="audit-actor">
            Actor
          </label>
          <select
            id="audit-actor"
            className="field audit-actor"
            value={filters.actor}
            disabled={busy}
            onChange={(event) => setFilters((f) => ({ ...f, actor: event.target.value }))}
          >
            {ACTOR_OPTIONS.map((actor) => (
              <option key={actor} value={actor}>
                {actor === '' ? 'Any actor' : actor}
              </option>
            ))}
          </select>
          <label className="label" htmlFor="audit-action">
            Action contains
          </label>
          <input
            id="audit-action"
            className="field"
            type="text"
            placeholder="e.g. chat, playbook, provider"
            value={filters.action}
            disabled={busy}
            onChange={(event) => setFilters((f) => ({ ...f, action: event.target.value }))}
          />
          <label className="label" htmlFor="audit-q">
            Search
          </label>
          <input
            id="audit-q"
            className="field"
            type="text"
            placeholder="target or detail text"
            value={filters.q}
            disabled={busy}
            onChange={(event) => setFilters((f) => ({ ...f, q: event.target.value }))}
          />
          <button type="submit" className="btn btn-primary" disabled={busy} aria-busy={busy}>
            {busy ? 'Loading…' : 'Apply'}
          </button>
          {filterDirty ? (
            <button type="button" className="btn btn-secondary" onClick={resetFilters} disabled={busy}>
              Reset
            </button>
          ) : null}
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => void load(filters)}
            disabled={busy}
          >
            Refresh
          </button>
        </form>

        <div className="audit-export">
          <span className="audit-export-hint">Export the fetched rows</span>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={busy || entries === null || entries.length === 0}
            onClick={() => entries !== null && exportAuditJson(entries)}
          >
            Export JSON
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={busy || entries === null || entries.length === 0}
            onClick={() => entries !== null && exportAuditMarkdown(entries)}
          >
            Export Markdown
          </button>
        </div>

        {error ? (
          <p className="row-error" role="alert">
            {error}
          </p>
        ) : null}

        {entries !== null && entries.length === 0 ? (
          <div className="audit-empty" role="status">
            {filterDirty ? (
              <>
                <p className="audit-empty-text">
                  No rows match these filters. Widen or clear them to see more of the log.
                </p>
                <div className="empty-actions">
                  <button type="button" className="btn btn-secondary btn-sm" onClick={resetFilters}>
                    Clear filters
                  </button>
                </div>
              </>
            ) : (
              <p className="audit-empty-text">
                Nothing here yet — run a chat, tool, playbook or skill and the action lands
                here, scrubbed of secrets.
              </p>
            )}
          </div>
        ) : null}

        <ul className="audit-list" aria-label="Audit log entries">
          {entries?.map((entry) => {
            const open = expanded[entry.id] ?? false;
            return (
              <li key={entry.id} className="audit-row">
                <div className="audit-row-head">
                  <span className={`audit-chip audit-chip-${auditAreaLabel(entry.action)}`}>
                    {auditAreaLabel(entry.action)}
                  </span>
                  <span className="audit-time">{formatWhen(entry.createdAt)}</span>
                  <span className="audit-actor">{entry.actor}</span>
                  <code className="audit-action">{entry.action}</code>
                  <span className="audit-target">{entry.target}</span>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    aria-expanded={open}
                    aria-label={`${open ? 'Collapse' : 'Expand'} details for ${entry.action}`}
                    onClick={() => toggleRow(entry.id)}
                  >
                    {open ? 'Hide' : 'Details'}
                  </button>
                </div>
                {open ? (
                  <pre className="audit-details" role="region" aria-label="Row details">
                    {prettyAuditDetails(entry.details)}
                  </pre>
                ) : null}
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
