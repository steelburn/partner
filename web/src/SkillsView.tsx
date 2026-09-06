import { useEffect, useMemo, useState, type FormEvent } from 'react';
import type {
  CatalogSkill,
  Persona,
  SkillManifest,
  SkillPermissions,
  SkillSummary,
} from '@partner/shared';
import { ApiRequestError } from './lib/api.js';
import { readStoredToken } from './lib/token.js';
import {
  disableSkill,
  enableSkill,
  getSkill,
  installSkill,
  invokeSkill,
  listCatalog,
  listInvocations,
  listSkills,
  uninstallSkill,
  type InvocationErrorCode,
} from './lib/skills.js';
import {
  formatBytes,
  formatInvocations,
  permissionSummary,
  sortSkills,
  validateArgsJson,
  type InvocationRow,
  type PermissionChip,
} from './lib/skill-helpers.js';

export type SkillsSegment = 'installed' | 'catalog';

export interface SkillsViewProps {
  /** Personas available to run skills as (null while the shell loads them). */
  personas: Persona[] | null;
  /** Forget the session and return to the pairing gate (auth failure). */
  onUnpair: () => void;
  /** True while this view is the visible one; triggers the first load. */
  active?: boolean;
}

/** One installed skill: its summary plus the manifest detail (for chips). */
interface InstalledSkill {
  summary: SkillSummary;
  manifest: SkillManifest | null;
}

type RowOp = 'disable' | 'enable' | 'uninstall';

/** True when an ApiRequestError means the core session is gone. */
function isSessionLost(cause: unknown): boolean {
  return cause instanceof ApiRequestError && (cause.status === 401 || cause.status === 403);
}

/** Pretty render of an invoke result (user data, owner-only display). */
function renderResult(result: unknown): string {
  if (typeof result === 'string') return result;
  try {
    return JSON.stringify(result, null, 2);
  } catch {
    return String(result);
  }
}

function ManifestChips({ manifest }: { manifest: SkillManifest | null }) {
  const source: SkillPermissions | null = manifest?.permissions ?? null;
  if (source === null) return null;
  return <Chips source={source} />;
}

/** Sort installed rows (summary fields) without losing their manifests. */
function orderRows(rows: InstalledSkill[]): InstalledSkill[] {
  const byId = new Map(rows.map((row) => [row.summary.id, row]));
  return sortSkills(rows.map((row) => row.summary)).map((summary) => byId.get(summary.id)!);
}

function CatalogChips({ skill }: { skill: CatalogSkill }) {
  return <Chips source={skill.permissions} />;
}

function Chips({ source }: { source: SkillPermissions }) {
  const chips = permissionSummary(source);
  return (
    <div className="skill-chips" aria-label="Permissions">
      {chips.map((chip: PermissionChip) => (
        <span key={chip.id} className={`skill-chip skill-chip-${chip.tone}`} title={chip.title}>
          {chip.label}
        </span>
      ))}
    </div>
  );
}

/**
 * M8 Skills view (PLAN-M8.md): Installed skills (permission chips incl. risk,
 * disable/enable, two-step uninstall) and the local Catalog (permission
 * summary + Install) in two segments, plus an Invoke console with a persona
 * picker, JSON args (validated, 64 KB cap) and a recent-invocations list.
 *
 * Redaction discipline: skill code/logs never reach this view; args typed in
 * the console and results rendered here are the owner's own data and stay on
 * the page — nothing is echoed into errors, copied into labels, or logged.
 */
export default function SkillsView({ personas, onUnpair, active }: SkillsViewProps) {
  const [segment, setSegment] = useState<SkillsSegment>('installed');
  const [installed, setInstalled] = useState<InstalledSkill[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<CatalogSkill[] | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [sessionLost, setSessionLost] = useState(false);
  const [loadedOnce, setLoadedOnce] = useState(false);
  /** Per-row op busy map: {skillId: op} — one op at a time per row. */
  const [busy, setBusy] = useState<Record<string, RowOp>>({});
  /** Two-step uninstall arming per skill id. */
  const [armed, setArmed] = useState<Record<string, boolean>>({});
  /** Per-row action errors (row-level only; never arg/result content). */
  const [rowError, setRowError] = useState<Record<string, string>>({});
  /** Catalog row currently installing (single at a time). */
  const [installingId, setInstallingId] = useState<string | null>(null);
  /** Skill selected in the Invoke console. */
  const [invokeId, setInvokeId] = useState<string | null>(null);

  const loadInstalled = async (): Promise<void> => {
    const token = readStoredToken();
    if (!token) {
      setSessionLost(true);
      return;
    }
    try {
      const summaries = await listSkills(token);
      // Manifests (permissions for chips) are per-skill detail reads; a
      // failed detail read degrades to a chip-less row rather than failing
      // the whole list.
      const withManifests = await Promise.all(
        summaries.map(async (summary) => {
          try {
            const detail = await getSkill(token, summary.id);
            return { summary, manifest: detail.manifest };
          } catch {
            return { summary, manifest: null };
          }
        }),
      );
      setInstalled(orderRows(withManifests));
      setLoadError(null);
    } catch (cause) {
      if (isSessionLost(cause)) {
        setSessionLost(true);
        return;
      }
      setLoadError(cause instanceof Error ? cause.message : 'Could not load skills.');
    }
  };

  const loadCatalog = async (): Promise<void> => {
    const token = readStoredToken();
    if (!token) {
      setSessionLost(true);
      return;
    }
    try {
      setCatalog(await listCatalog(token));
      setCatalogError(null);
    } catch (cause) {
      if (isSessionLost(cause)) {
        setSessionLost(true);
        return;
      }
      setCatalogError(cause instanceof Error ? cause.message : 'Could not load the catalog.');
    }
  };

  useEffect(() => {
    // Load both lists the first time the tab becomes the visible view (the
    // view stays mounted when paired, so switching back never refetches).
    if (!active || loadedOnce) return;
    setLoadedOnce(true);
    void loadInstalled();
    void loadCatalog();
    // Intended: load on first activation; mutations update local state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, loadedOnce]);

  // Keep the console selection valid as the installed set changes (prefer
  // an enabled skill; fall back to any, then none).
  useEffect(() => {
    if (installed === null) return;
    setInvokeId((prev) => {
      if (prev !== null && installed.some((row) => row.summary.id === prev)) return prev;
      const enabled = installed.find((row) => row.summary.status === 'installed');
      const first = enabled ?? installed[0];
      return first ? first.summary.id : null;
    });
  }, [installed]);

  const handleSessionLost = (): void => setSessionLost(true);

  const sorted = installed;

  const replaceOrDrop = (summary: SkillSummary | null, id: string): void => {
    setInstalled((prev) => {
      if (prev === null) return prev;
      const next = summary === null ? prev.filter((row) => row.summary.id !== id) : prev;
      if (summary === null) return next;
      return orderRows(
        next.map((row) =>
          row.summary.id === id ? { ...row, summary: { ...row.summary, ...summary } } : row,
        ),
      );
    });
  };

  const runRowOp = async (skillId: string, op: RowOp): Promise<void> => {
    if (busy[skillId] !== undefined) return;
    const token = readStoredToken();
    if (!token) {
      handleSessionLost();
      return;
    }
    // Any new row action disarms a pending uninstall confirm.
    setArmed((prev) => ({ ...prev, [skillId]: false }));
    setBusy((prev) => ({ ...prev, [skillId]: op }));
    setRowError((prev) => ({ ...prev, [skillId]: '' }));
    try {
      const result =
        op === 'disable'
          ? await disableSkill(token, skillId)
          : op === 'enable'
            ? await enableSkill(token, skillId)
            : null;
      if (op === 'uninstall') {
        await uninstallSkill(token, skillId);
        replaceOrDrop(null, skillId);
        return;
      }
      // Status change: the core usually returns the updated row; when it
      // answers 204 we refetch to stay truthful.
      if (result !== null) {
        replaceOrDrop(result, skillId);
      } else {
        await loadInstalled();
      }
    } catch (cause) {
      if (isSessionLost(cause)) {
        handleSessionLost();
        return;
      }
      const message =
        cause instanceof ApiRequestError
          ? cause.message
          : cause instanceof Error
            ? cause.message
            : 'The action could not be completed.';
      setRowError((prev) => ({ ...prev, [skillId]: message }));
    } finally {
      setBusy((prev) => {
        const next = { ...prev };
        delete next[skillId];
        return next;
      });
    }
  };

  const armUninstall = (skillId: string): void => {
    if (busy[skillId] !== undefined) return;
    setRowError((prev) => ({ ...prev, [skillId]: '' }));
    setArmed((prev) => {
      const armedFor = prev[skillId] === true;
      return { ...prev, [skillId]: !armedFor };
    });
  };

  const handleInstall = async (catalogId: string): Promise<void> => {
    if (installingId !== null) return;
    const token = readStoredToken();
    if (!token) {
      handleSessionLost();
      return;
    }
    setInstallingId(catalogId);
    setCatalogError(null);
    try {
      await installSkill(token, catalogId);
      // Installed: refresh the Installed list and take the user there.
      await loadInstalled();
      setSegment('installed');
    } catch (cause) {
      if (isSessionLost(cause)) {
        handleSessionLost();
        return;
      }
      if (cause instanceof ApiRequestError && cause.status === 409) {
        // Already installed (race or repeat click): treat as success.
        await loadInstalled();
        setSegment('installed');
        return;
      }
      setCatalogError(
        cause instanceof Error
          ? `Could not install “${catalogId}”: ${cause.message}`
          : 'Could not install the skill.',
      );
    } finally {
      setInstallingId(null);
    }
  };

  const installedIds = useMemo(
    () => new Set((installed ?? []).map((row) => row.summary.id)),
    [installed],
  );

  const selectedSkill =
    (installed ?? []).find((row) => row.summary.id === invokeId)?.summary ?? null;
  const viewLocked = sessionLost;

  return (
    <section className="skills" aria-label="Skills">
      <div className="skills-panel">
        <div className="page-head">
          <div className="page-head-titles">
            <div className="kicker">Extensions</div>
            <h1 className="page-title">Skills</h1>
          </div>
        </div>
        <p className="page-copy">
          Capability bundles this core can run for you. Install is default-deny: every skill
          shows the tools and risk it declares before you add it, runs in its own sandboxed
          worker with a time budget, and its store is wiped on uninstall.
        </p>

        {sessionLost ? (
          <div className="skills-alert" role="alert">
            <p className="skills-alert-text">
              Your session with the Partner core has expired. Pair again to manage skills.
            </p>
            <button type="button" className="btn btn-secondary" onClick={onUnpair}>
              Pair again
            </button>
          </div>
        ) : null}

        <div className="seg-tabs" role="group" aria-label="Skills segments">
          <button
            type="button"
            className="btn btn-secondary seg-tab"
            onClick={() => setSegment('installed')}
            aria-pressed={segment === 'installed'}
            disabled={viewLocked}
          >
            Installed
          </button>
          <button
            type="button"
            className="btn btn-secondary seg-tab"
            onClick={() => setSegment('catalog')}
            aria-pressed={segment === 'catalog'}
            disabled={viewLocked}
          >
            Catalog
          </button>
        </div>

        {/* ------------------------- Installed segment ------------------------ */}
        <div className={segment === 'installed' ? 'skills-seg skills-seg-active' : 'skills-seg'}>
          {!viewLocked && installed === null ? (
            <p className="skills-loading" aria-busy="true">
              Loading installed skills…
            </p>
          ) : !viewLocked && loadError ? (
            <div className="skills-alert" role="alert">
              <p className="skills-alert-text">{loadError}</p>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => void loadInstalled()}
              >
                Try again
              </button>
            </div>
          ) : installed !== null && installed.length === 0 && !loadError ? (
            <div className="empty-state">
              <p className="empty-state-title">No skills installed</p>
              <p className="empty-state-copy">
                Skills are capability bundles that run sandboxed on this machine. Browse the
                catalog to see what is available — each one shows its declared permissions
                before you install it.
              </p>
              <div className="empty-actions">
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => setSegment('catalog')}
                  disabled={viewLocked}
                >
                  Browse catalog
                </button>
              </div>
            </div>
          ) : sorted !== null && sorted.length > 0 ? (
            <>
              <ul className="skill-list">
                {sorted.map((row) => (
                  <li key={row.summary.id} className="skill-card">
                    <div className="skill-card-inner">
                      <div className="skill-card-head">
                        <div className="skill-identity">
                          <h3 className="skill-name">{row.summary.name}</h3>
                          <span className="skill-author">
                            {row.summary.author}@{row.summary.version}
                          </span>
                          <span
                            className={`skill-status skill-status-${row.summary.status}`}
                            aria-label={
                              row.summary.status === 'disabled' ? 'Disabled' : 'Installed'
                            }
                          >
                            {row.summary.status === 'disabled' ? 'Disabled' : 'Installed'}
                          </span>
                        </div>
                        <div className="row-actions">
                          {row.summary.status === 'installed' ? (
                            <button
                              type="button"
                              className="btn btn-secondary btn-sm"
                              onClick={() => void runRowOp(row.summary.id, 'disable')}
                              disabled={busy[row.summary.id] !== undefined || viewLocked}
                              aria-busy={busy[row.summary.id] === 'disable'}
                            >
                              {busy[row.summary.id] === 'disable' ? 'Disabling…' : 'Disable'}
                            </button>
                          ) : (
                            <button
                              type="button"
                              className="btn btn-secondary btn-sm"
                              onClick={() => void runRowOp(row.summary.id, 'enable')}
                              disabled={busy[row.summary.id] !== undefined || viewLocked}
                              aria-busy={busy[row.summary.id] === 'enable'}
                            >
                              {busy[row.summary.id] === 'enable' ? 'Enabling…' : 'Enable'}
                            </button>
                          )}
                          {armed[row.summary.id] ? (
                            <>
                              <button
                                type="button"
                                className="btn btn-secondary btn-sm btn-danger"
                                onClick={() => void runRowOp(row.summary.id, 'uninstall')}
                                disabled={busy[row.summary.id] !== undefined || viewLocked}
                                aria-busy={busy[row.summary.id] === 'uninstall'}
                              >
                                {busy[row.summary.id] === 'uninstall' ? 'Uninstalling…' : 'Uninstall now'}
                              </button>
                              <button
                                type="button"
                                className="btn btn-secondary btn-sm"
                                onClick={() => armUninstall(row.summary.id)}
                                disabled={busy[row.summary.id] !== undefined || viewLocked}
                              >
                                Cancel
                              </button>
                            </>
                          ) : (
                            <button
                              type="button"
                              className="btn btn-secondary btn-sm btn-danger"
                              onClick={() => armUninstall(row.summary.id)}
                              disabled={busy[row.summary.id] !== undefined || viewLocked}
                              aria-label={`Uninstall ${row.summary.name} — wipes its store`}
                            >
                              Uninstall
                            </button>
                          )}
                        </div>
                      </div>

                      {armed[row.summary.id] ? (
                        <p className="skill-uninstall-warn" role="alert">
                          Uninstalling wipes this skill&apos;s store from the machine — press
                          Uninstall now to confirm.
                        </p>
                      ) : null}

                      <p className="skill-desc">
                        {row.summary.description && row.summary.description.length > 0
                          ? row.summary.description
                          : 'No description.'}
                      </p>

                      <ManifestChips manifest={row.manifest} />

                      {rowError[row.summary.id] ? (
                        <p className="row-error" role="alert">
                          {rowError[row.summary.id]}
                        </p>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>

              {selectedSkill ? (
                <InvokeConsole
                  skills={(installed ?? []).map((row) => row.summary)}
                  selectedId={invokeId}
                  onSelect={setInvokeId}
                  personas={personas}
                  disabled={viewLocked}
                  onSessionLost={handleSessionLost}
                  onRowError={(message) =>
                    setRowError((prev) => ({ ...prev, [selectedSkill.id]: message }))
                  }
                />
              ) : null}
            </>
          ) : null}
        </div>

        {/* -------------------------- Catalog segment ------------------------- */}
        <div className={segment === 'catalog' ? 'skills-seg skills-seg-active' : 'skills-seg'}>
          {!viewLocked && catalog === null ? (
            <p className="skills-loading" aria-busy="true">
              Loading the catalog…
            </p>
          ) : !viewLocked && catalogError ? (
            <div className="skills-alert" role="alert">
              <p className="skills-alert-text">{catalogError}</p>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => void loadCatalog()}
              >
                Try again
              </button>
            </div>
          ) : catalog !== null && catalog.length === 0 && !catalogError ? (
            <div className="empty-state">
              <p className="empty-state-title">Catalog is empty</p>
              <p className="empty-state-copy">
                The core ships no local catalog entries yet — skills installed here earlier
                still appear under Installed.
              </p>
            </div>
          ) : catalog !== null && catalog.length > 0 ? (
            <ul className="skill-list">
              {catalog.map((skill) => {
                const isInstalled = installedIds.has(skill.id);
                const isInstalling = installingId === skill.id;
                return (
                  <li key={skill.id} className="skill-card">
                    <div className="skill-card-inner">
                      <div className="skill-card-head">
                        <div className="skill-identity">
                          <h3 className="skill-name">{skill.name}</h3>
                          <span className="skill-author">
                            {skill.author}@{skill.version}
                          </span>
                          {isInstalled ? (
                            <span className="skill-status skill-status-installed">Installed</span>
                          ) : null}
                        </div>
                        <div className="row-actions">
                          {isInstalled ? (
                            <button
                              type="button"
                              className="btn btn-secondary btn-sm"
                              onClick={() => setSegment('installed')}
                              disabled={viewLocked}
                            >
                              Manage
                            </button>
                          ) : (
                            <button
                              type="button"
                              className="btn btn-primary btn-sm"
                              onClick={() => void handleInstall(skill.id)}
                              disabled={installingId !== null || viewLocked}
                              aria-busy={isInstalling}
                            >
                              {isInstalling ? 'Installing…' : 'Install'}
                            </button>
                          )}
                        </div>
                      </div>

                      <p className="skill-desc">{skill.description}</p>
                      <CatalogChips skill={skill} />
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : null}
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Invoke console (panel under the Installed list)
// ---------------------------------------------------------------------------

interface InvokeConsoleProps {
  /** Installed skills to pick from (ordered by the parent). */
  skills: SkillSummary[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  personas: Persona[] | null;
  disabled: boolean;
  onSessionLost: () => void;
  /** Row-level error surfacing (e.g. disabled mid-run) — never content. */
  onRowError: (message: string) => void;
}

type InvokeOutcome =
  | { kind: 'ok'; value: unknown }
  | { kind: 'error'; label: string; code: InvocationErrorCode | null };

function InvokeConsole({
  skills,
  selectedId,
  onSelect,
  personas,
  disabled,
  onSessionLost,
  onRowError,
}: InvokeConsoleProps) {
  const [argsText, setArgsText] = useState('');
  const [personaId, setPersonaId] = useState('');
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<InvokeOutcome | null>(null);
  const [invocations, setInvocations] = useState<InvocationRow[] | null>(null);
  const [invLoadError, setInvLoadError] = useState<string | null>(null);

  const skill = skills.find((row) => row.id === selectedId) ?? null;
  const disabledSkill = skill?.status === 'disabled';

  const argsCheck = useMemo(() => validateArgsJson(argsText), [argsText]);

  const loadRecent = async (id: string): Promise<void> => {
    const token = readStoredToken();
    if (!token) {
      onSessionLost();
      return;
    }
    try {
      setInvocations(formatInvocations(await listInvocations(token, id)));
      setInvLoadError(null);
    } catch (cause) {
      if (isSessionLost(cause)) {
        onSessionLost();
        return;
      }
      setInvocations(null);
      setInvLoadError(cause instanceof Error ? cause.message : 'Could not load invocations.');
    }
  };

  // Load recent runs once per selected skill (effect keyed on the skill id,
  // so a segment flip back does not refetch every time).
  useEffect(() => {
    if (!skill) return;
    void loadRecent(skill.id);
    // Intended: refetch only when the selected skill changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [skill?.id]);

  const handleRun = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (busy || disabled || !skill || disabledSkill) return;
    const token = readStoredToken();
    if (!token) {
      onSessionLost();
      return;
    }
    if (!argsCheck.ok) {
      // Inline validation error is already visible under the textarea.
      return;
    }
    setBusy(true);
    setOutcome(null);
    onRowError('');
    try {
      const result = await invokeSkill(token, skill.id, {
        ...(argsCheck.value !== undefined ? { args: argsCheck.value } : {}),
        ...(personaId.length > 0 ? { personaId } : {}),
      });
      if (result.ok) {
        setOutcome({ kind: 'ok', value: result.result });
      } else {
        setOutcome({ kind: 'error', label: result.message, code: result.code });
      }
      // The newest invocation row is the run that just happened.
      await loadRecent(skill.id);
    } catch (cause) {
      if (isSessionLost(cause)) {
        onSessionLost();
        return;
      }
      setOutcome({
        kind: 'error',
        label: cause instanceof Error ? cause.message : 'Could not reach the Partner core.',
        code: null,
      });
    } finally {
      setBusy(false);
    }
  };

  const freshMeta = invocations?.[0] ?? null;
  const metadata =
    freshMeta && !freshMeta.running
      ? `${freshMeta.toolCalls} tool call${freshMeta.toolCalls === 1 ? '' : 's'}${
          freshMeta.ms !== null ? ` · ${freshMeta.ms} ms` : ''
        }`
      : null;

  return (
    <section className="card invoke-card" aria-label="Invoke a skill">
      <h2 className="card-title">Invoke</h2>
      <p className="card-copy">
        Run one of your installed skills with optional JSON args. Args are sent once to the
        core; results render here for you only.
      </p>

      <form className="form-stack" onSubmit={(event) => void handleRun(event)} aria-busy={busy}>
        <div className="form-field">
          <label className="label" htmlFor="invoke-skill-select">
            Skill
          </label>
          <select
            id="invoke-skill-select"
            className="field skill-select"
            value={skill?.id ?? ''}
            onChange={(event) => {
              const id = event.target.value;
              onSelect(id.length > 0 ? id : null);
              setOutcome(null);
            }}
            disabled={disabled || busy}
          >
            {skills.map((row) => (
              <option key={row.id} value={row.id}>
                {row.name}
                {row.status === 'disabled' ? ' (disabled)' : ''}
              </option>
            ))}
          </select>
        </div>

        <div className="form-field">
          <label className="label" htmlFor="invoke-persona-select">
            Run as persona <span className="label-optional">(optional)</span>
          </label>
          <select
            id="invoke-persona-select"
            className="field skill-select"
            value={personaId}
            onChange={(event) => setPersonaId(event.target.value)}
            disabled={disabled || busy}
          >
            <option value="">No persona</option>
            {(personas ?? []).map((persona) => (
              <option key={persona.id} value={persona.id}>
                {persona.name}
              </option>
            ))}
          </select>
        </div>

        <div className="form-field">
          <div className="invoke-args-head">
            <label className="label" htmlFor="invoke-args">
              Args (JSON)
            </label>
            <span className="invoke-size-hint">
              {argsText.trim().length > 0 ? formatBytes(argsCheck.bytes) : '≤ 64 KB'}
            </span>
          </div>
          <textarea
            id="invoke-args"
            className="field skill-args"
            value={argsText}
            onChange={(event) => setArgsText(event.target.value)}
            disabled={disabled || busy}
            spellCheck={false}
            placeholder='{}'
            aria-describedby="invoke-args-hint"
          />
          <p id="invoke-args-hint" className="form-hint">
            Valid JSON passed to the skill{disabledSkill ? '. This skill is disabled — enable it to run.' : '.'}
          </p>
          {!argsCheck.ok ? (
            <p className="form-error" role="alert">
              {argsCheck.error}
            </p>
          ) : null}
        </div>

        <div className="invoke-actions">
          <button
            type="submit"
            className="btn btn-primary"
            disabled={disabled || busy || disabledSkill || !argsCheck.ok}
          >
            {busy ? 'Running…' : 'Run'}
          </button>
          {disabledSkill ? (
            <span className="form-hint invoke-disabled-note">
              Enable the skill first — disabled skills refuse invocation.
            </span>
          ) : null}
        </div>
      </form>

      {outcome !== null ? (
        <div className="invoke-outcome" aria-live="polite">
          {outcome.kind === 'ok' ? (
            <>
              <p className="result-meta">Result{metadata !== null ? ` — ${metadata}` : ''}</p>
              {outcome.value === undefined ? (
                <p className="result-empty">The skill returned nothing.</p>
              ) : (
                <pre className="pre-content">{renderResult(outcome.value)}</pre>
              )}
            </>
          ) : (
            <>
              <p className="form-error invoke-error" role="alert">
                {outcome.label}
                {outcome.code !== null ? (
                  <span className="invoke-code" title={`Error code: ${outcome.code}`}>
                    {outcome.code}
                  </span>
                ) : null}
              </p>
              {metadata !== null ? <p className="result-meta">{metadata}</p> : null}
            </>
          )}
        </div>
      ) : null}

      <RecentInvocations
        rows={invocations}
        loadError={invLoadError}
        onRetry={() => {
          if (skill) void loadRecent(skill.id);
        }}
        disabled={disabled}
      />
    </section>
  );
}

function RecentInvocations({
  rows,
  loadError,
  onRetry,
  disabled,
}: {
  rows: InvocationRow[] | null;
  loadError: string | null;
  onRetry: () => void;
  disabled: boolean;
}) {
  return (
    <div className="invoke-recent">
      <div className="section-head">
        <h3 className="sub-panel-title">Recent invocations</h3>
        {rows !== null && rows.length > 0 ? (
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={onRetry}
            disabled={disabled}
          >
            Refresh
          </button>
        ) : null}
      </div>
      {rows === null && loadError === null ? (
        <p className="skills-loading" aria-busy="true">
          Loading recent invocations…
        </p>
      ) : loadError !== null ? (
        <div className="invoke-error-row" role="alert">
          <p className="row-error">{loadError}</p>
          <button type="button" className="btn btn-secondary btn-sm" onClick={onRetry} disabled={disabled}>
            Try again
          </button>
        </div>
      ) : rows !== null && rows.length === 0 ? (
        <p className="result-empty">No invocations yet — run this skill above.</p>
      ) : rows !== null ? (
        <ul className="invoke-run-list">
          {rows.map((row) => (
            <li
              key={row.id}
              className="invoke-run-row"
              aria-label={
                row.running
                  ? `Running since ${row.startedLabel}`
                  : row.ok
                    ? `Succeeded ${row.startedLabel}`
                    : `Failed ${row.startedLabel}`
              }
            >
              <span
                className={row.running ? 'invoke-dot invoke-dot-running' : row.ok ? 'invoke-dot invoke-dot-ok' : 'invoke-dot invoke-dot-error'}
                aria-hidden="true"
              />
              <span className="invoke-run-time">{row.startedLabel}</span>
              {row.running ? (
                <span className="invoke-run-status">running</span>
              ) : row.errorCode !== null ? (
                <span className="invoke-run-status invoke-run-status-error" title={row.errorCode ?? undefined}>
                  {row.errorLabel ?? row.errorCode}
                </span>
              ) : null}
              <span className="invoke-run-meta">
                {row.toolCalls} call{row.toolCalls === 1 ? '' : 's'}
                {row.ms !== null ? ` · ${row.ms} ms` : ''}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
