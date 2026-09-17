/**
 * M28-era Studio split — the editor: manifest fields, the entry source, and the
 * hosted Validation panel — plus M28 cut C's FLOW tab.
 *
 * This is the biggest piece and the one that owns the tab strip. It renders
 * ValidationPanel next to the source because "the code and its verdict" is one
 * reading task, not two screens.
 *
 * THE TAB STRIP IS DECIDED BY THE DRAFT KIND (PLAN-M28.md cut C): a flow-backed
 * draft is authored on the canvas, so Flow leads and is opened first; a
 * code-authored draft has no graph to show and keeps the two-tab strip it always
 * had, with the honest door to a flow (an empty canvas, or a declared-LOSSY
 * from-code proposal) sitting in the Code panel rather than behind an empty tab.
 */
import { useEffect, useMemo, useState } from 'react';
import type { SkillDraft, SkillManifest } from '@partner/shared';
import type { ToolId } from '@partner/shared/src/tools.js';
import { formatBytes } from '../lib/skill-helpers.js';
import { draftDescription, toolOptions, type ConfirmStage } from '../lib/skill-studio-helpers.js';
import { updateDraft, validateDraft } from '../lib/skills.js';
import { readStoredToken } from '../lib/token.js';

import { FlowPanel, FlowStarter } from './FlowPanel.js';
import { ValidationPanel } from './ValidationPanel.js';
import { isSessionLost, messageOf } from './shared.js';

// ---------------------------------------------------------------------------
// Editor — manifest fields + the entry source (and, M28, the flow)
// ---------------------------------------------------------------------------

export interface DraftEditorProps {
  draft: SkillDraft;
  /** An installed draft is history: the core refuses writes, so the UI does too. */
  readOnly: boolean;
  disabled: boolean;
  onDraftChanged: (draft: SkillDraft) => void;
  onSessionLost: () => void;
}

type EditorTab = 'flow' | 'code' | 'validation';
/**
 * The manifest's OWN fields plus the entry source, one draft at a time.
 *
 * The manifest is edited as fields, not as JSON, so the tool picker can only
 * offer ids the registry knows and the risk select can only offer the three
 * tiers. The one exception is a manifest that does not parse: it is then shown
 * as text (and only then), because a draft with a broken manifest must stay
 * FIXABLE in the Studio rather than become a dead end.
 */
export function DraftEditor({
  draft,
  readOnly,
  disabled,
  onDraftChanged,
  onSessionLost,
}: DraftEditorProps) {
  const [tab, setTab] = useState<EditorTab>(draft.flow === null ? 'code' : 'flow');
  const [name, setName] = useState(draft.name);
  // The MANIFEST's description, not the row's: see draftDescription().
  const [description, setDescription] = useState(draftDescription(draft));
  const [version, setVersion] = useState(draft.manifest?.version ?? '');
  const [tools, setTools] = useState<string[]>(draft.manifest?.permissions.tools ?? []);
  const [risk, setRisk] = useState(draft.manifest?.permissions.risk ?? 'low');
  const [budgetMs, setBudgetMs] = useState(String(draft.manifest?.budget.timeMs ?? 30_000));
  const [code, setCode] = useState(draft.code);
  const [manifestText, setManifestText] = useState(draft.manifestText);
  const [stage, setStage] = useState<ConfirmStage>('idle');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // Re-seed the fields when a different draft (or a fresh server copy of this
  // one) arrives; otherwise a save could push stale values back.
  useEffect(() => {
    setName(draft.name);
    setDescription(draftDescription(draft));
    setVersion(draft.manifest?.version ?? '');
    setTools(draft.manifest?.permissions.tools ?? []);
    setRisk(draft.manifest?.permissions.risk ?? 'low');
    setBudgetMs(String(draft.manifest?.budget.timeMs ?? 30_000));
    setCode(draft.code);
    setManifestText(draft.manifestText);
    setStage('idle');
    setError(null);
  }, [draft]);

  // The tab STRIP follows the draft KIND, so it is re-decided when the draft
  // changes: an edit draft opens on its code, a flow-backed one on its canvas,
  // and starting a flow from the Code panel lands on the canvas it just made.
  useEffect(() => {
    setTab(draft.flow === null ? 'code' : 'flow');
  }, [draft.id, draft.flow === null]);

  const flowBacked = draft.flow !== null;
  const tabs: Array<{ id: EditorTab; label: string }> = flowBacked
    ? [
        { id: 'flow', label: 'Flow' },
        { id: 'code', label: 'Code' },
        { id: 'validation', label: 'Validation' },
      ]
    : [
        { id: 'code', label: 'Code' },
        { id: 'validation', label: 'Validation' },
      ];

  const manifest = draft.manifest;
  const options = useMemo(() => toolOptions(manifest?.permissions.tools ?? []), [manifest]);
  const bytes = useMemo(() => new TextEncoder().encode(code).length, [code]);
  const budgetValue = Number.parseInt(budgetMs, 10);
  const budgetOk = Number.isFinite(budgetValue) && budgetValue > 0;
  const dirty =
    name !== draft.name ||
    description !== draftDescription(draft) ||
    code !== draft.code ||
    manifestText !== draft.manifestText ||
    (manifest !== null &&
      (version !== manifest.version ||
        risk !== manifest.permissions.risk ||
        budgetMs !== String(manifest.budget.timeMs) ||
        tools.join(',') !== manifest.permissions.tools.join(',')));

  const toggleTool = (id: string): void => {
    setTools((prev) => (prev.includes(id) ? prev.filter((tool) => tool !== id) : [...prev, id]));
  };

  /** The manifest text the fields produce (or the raw text when it is broken). */
  const buildManifestText = (): string => {
    if (manifest === null) return manifestText;
    const next: SkillManifest = {
      ...manifest,
      name: name.trim() === '' ? manifest.name : name.trim(),
      description,
      version: version.trim() === '' ? manifest.version : version.trim(),
      // The picker holds plain strings because it must be able to SHOW an id the
      // registry does not know (removing it is the point); the core's validator
      // names such an id as an error, so the cast only loses a compile-time
      // guarantee the wire never had.
      permissions: { ...manifest.permissions, tools: tools as ToolId[], risk },
      budget: { ...manifest.budget, timeMs: budgetValue },
    };
    return JSON.stringify(next, null, 2);
  };

  const save = async (): Promise<void> => {
    if (busy || readOnly || disabled) return;
    const token = readStoredToken();
    if (!token) {
      onSessionLost();
      return;
    }
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const updated = await updateDraft(token, draft.id, {
        name: name.trim() === '' ? draft.name : name.trim(),
        // Seeded from the manifest (draftDescription), so saving an untouched
        // field writes the skill's own description back to BOTH the manifest
        // (below) and the row — they can no longer drift apart.
        description,
        manifestText: buildManifestText(),
        code,
      });
      onDraftChanged(updated);
      setSaved(true);
    } catch (cause) {
      if (isSessionLost(cause)) {
        onSessionLost();
        return;
      }
      setError(messageOf(cause, 'Could not save the draft.'));
    } finally {
      setBusy(false);
      setStage('idle');
    }
  };

  const revalidate = async (): Promise<void> => {
    if (busy || readOnly || disabled) return;
    const token = readStoredToken();
    if (!token) {
      onSessionLost();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const updated = await validateDraft(token, draft.id);
      onDraftChanged(updated);
    } catch (cause) {
      if (isSessionLost(cause)) {
        onSessionLost();
        return;
      }
      setError(messageOf(cause, 'Could not validate the draft.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card" aria-label="Draft editor">
      <div className="section-head">
        <h2 className="card-title">Draft</h2>
        {readOnly ? (
          <span className="skill-status skill-status-installed">Installed</span>
        ) : dirty ? (
          <span className="studio-dirty">Unsaved edits</span>
        ) : null}
      </div>
      {readOnly ? (
        <p className="card-copy">
          This draft has been installed, so it is read-only history — the core refuses further
          edits. Fork or edit the installed skill to change it; discarding the draft below does
          not uninstall the skill.
        </p>
      ) : null}

      <div className="form-stack">
        <div className="form-field">
          <label className="label" htmlFor="studio-id">
            Id
          </label>
          <input
            id="studio-id"
            className="field studio-mono"
            type="text"
            value={manifest?.id ?? draft.id}
            readOnly
            aria-readonly="true"
            disabled={disabled}
          />
          <p className="form-hint">
            {manifest === null
              ? 'The manifest does not parse, so there is no id to show — fix it below.'
              : 'Fixed once the draft exists: it is the name the installed skill and its grants use.'}
          </p>
        </div>

        <div className="form-field">
          <label className="label" htmlFor="studio-name">
            Name
          </label>
          <input
            id="studio-name"
            className="field"
            type="text"
            value={name}
            onChange={(event) => setName(event.target.value)}
            disabled={disabled || busy || readOnly}
          />
        </div>

        <div className="form-field">
          <label className="label" htmlFor="studio-description">
            Description
          </label>
          <textarea
            id="studio-description"
            className="field studio-describe"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            disabled={disabled || busy || readOnly}
          />
        </div>

        <div className="studio-field-row">
          <div className="form-field">
            <label className="label" htmlFor="studio-version">
              Version
            </label>
            <input
              id="studio-version"
              className="field"
              type="text"
              value={version}
              onChange={(event) => setVersion(event.target.value)}
              disabled={disabled || busy || readOnly || manifest === null}
              placeholder="0.1.0"
            />
          </div>
          <div className="form-field">
            <label className="label" htmlFor="studio-risk">
              Risk
            </label>
            <select
              id="studio-risk"
              className="field"
              value={risk}
              onChange={(event) => setRisk(event.target.value as typeof risk)}
              disabled={disabled || busy || readOnly || manifest === null}
            >
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
            </select>
          </div>
          <div className="form-field">
            <label className="label" htmlFor="studio-budget">
              Time budget (ms)
            </label>
            <input
              id="studio-budget"
              className="field"
              type="number"
              min={1}
              step={1000}
              value={budgetMs}
              onChange={(event) => setBudgetMs(event.target.value)}
              disabled={disabled || busy || readOnly || manifest === null}
              aria-describedby="studio-budget-hint"
            />
            <p id="studio-budget-hint" className="form-hint">
              The core clamps a run to the runner ceiling.
            </p>
          </div>
        </div>

        <fieldset className="studio-tools" disabled={disabled || busy || readOnly || manifest === null}>
          <legend className="label">Tools this skill may request</legend>
          {options.map((option) => (
            <label key={option.id} className="check-label studio-tool" htmlFor={`studio-tool-${option.id}`}>
              <input
                id={`studio-tool-${option.id}`}
                className="check"
                type="checkbox"
                checked={tools.includes(option.id)}
                onChange={() => toggleTool(option.id)}
                disabled={disabled || busy || readOnly || manifest === null}
              />
              <span className="studio-tool-label">{option.label}</span>
              <span className="studio-tool-id">{option.id}</span>
            </label>
          ))}
          {tools.length > 0 ? (
            <p className="form-hint">
              A declared tool still needs a grant at run time — the skill cannot widen its own
              access.
            </p>
          ) : (
            <p className="form-hint">
              No tools: this skill can only transform the arguments it is given.
            </p>
          )}
        </fieldset>

        {manifest === null ? (
          <div className="form-field">
            <label className="label" htmlFor="studio-manifest-text">
              Manifest (JSON)
            </label>
            <textarea
              id="studio-manifest-text"
              className="field studio-code"
              value={manifestText}
              onChange={(event) => setManifestText(event.target.value)}
              spellCheck={false}
              disabled={disabled || busy || readOnly}
              aria-describedby="studio-manifest-hint"
            />
            <p id="studio-manifest-hint" className="form-hint">
              This manifest does not parse, so the fields above are unavailable. Fix the JSON here
              and save — the core re-validates it immediately.
            </p>
          </div>
        ) : null}

        <div className="seg-tabs" role="group" aria-label="Flow, entry source or validation">
          {tabs.map((entry) => (
            <button
              key={entry.id}
              type="button"
              className="btn btn-secondary seg-tab"
              aria-pressed={tab === entry.id}
              onClick={() => setTab(entry.id)}
              disabled={disabled}
            >
              {entry.label}
            </button>
          ))}
        </div>

        <div className="form-field">
          {tab === 'flow' && flowBacked ? (
            <FlowPanel
              draft={draft}
              readOnly={readOnly}
              disabled={disabled}
              onDraftChanged={onDraftChanged}
              onSessionLost={onSessionLost}
            />
          ) : tab === 'validation' ? (
            <ValidationPanel
              validation={draft.validation}
              busy={busy}
              disabled={disabled || readOnly}
              onRevalidate={() => void revalidate()}
            />
          ) : (
            <>
              <div className="studio-pane-head">
                <label className="label" htmlFor="studio-code">
                  Entry source (entry.mjs)
                </label>
                <span className="studio-size-hint">{formatBytes(bytes)}</span>
              </div>
              <textarea
                id="studio-code"
                className="field studio-code"
                value={code}
                onChange={(event) => setCode(event.target.value)}
                spellCheck={false}
                disabled={disabled || busy || readOnly}
                aria-describedby="studio-code-hint"
              />
              <p id="studio-code-hint" className="form-hint">
                One ES module exporting <code className="studio-inline-mono">run(args)</code>. Its
                only reach is the <code className="studio-inline-mono">partner</code> global; the
                core refuses an entry over its size cap and names any import it cannot resolve.
              </p>
              {!readOnly && !flowBacked ? (
                <FlowStarter
                  draft={draft}
                  disabled={disabled}
                  onSessionLost={onSessionLost}
                  onFlowStarted={() => setTab('flow')}
                />
              ) : null}
            </>
          )}
        </div>

        {!readOnly ? (
          <div className="studio-actions">
            {stage === 'idle' ? (
              <>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => {
                    setSaved(false);
                    setStage('confirm');
                  }}
                  disabled={disabled || busy || !budgetOk}
                >
                  Save draft
                </button>
                {budgetMs !== '' && !budgetOk ? (
                  <span className="form-hint">The time budget must be a positive number of ms.</span>
                ) : null}
              </>
            ) : (
              <>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => void save()}
                  disabled={disabled || busy}
                  aria-busy={busy}
                >
                  {busy ? 'Saving…' : 'Save now'}
                </button>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setStage('idle')}
                  disabled={disabled || busy}
                >
                  Cancel
                </button>
                <span className="form-hint">
                  Saving writes your edits into the draft and re-validates them — nothing runs and
                  nothing installs.
                </span>
              </>
            )}
            {saved ? (
              <span className="form-success" role="status">
                Saved.
              </span>
            ) : null}
            {dirty ? (
              <span className="form-hint">
                These edits live in this page only — switching drafts drops them.
              </span>
            ) : null}
          </div>
        ) : null}

        {error !== null ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </section>
  );
}
