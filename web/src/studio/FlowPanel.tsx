/**
 * M28 cut C/D — the Flow tab (PLAN-M28.md D1/D6/D7/D8).
 *
 * WHY this panel and the canvas are separate files: `SkillFlow.tsx` is a
 * PRESENTATIONAL canvas (it draws one graph and reports every edit through
 * `onChange`), while this panel owns the WRITES — save, compile, refine,
 * from-code, explain. That split is what lets the canvas be tested by rendering
 * it, and what keeps the milestone's honesty rules in one reviewable place:
 *
 *   1. **A save is not a compile (D1).** Save and Compile are two named
 *      actions; Compile is DISABLED while the graph has unsaved edits, so no
 *      button silently performs an extra write on the user's behalf.
 *   2. **The staleness banner states a fact and offers two honest exits (D6).**
 *      "The code is not what this flow compiles to" — Recompile (overwrites the
 *      code) or Keep code (the flow stays a sketch). It is armed two-step,
 *      because Recompile WRITES over the owner's source.
 *   3. **Refine proposes (D8).** The instruction goes out, a diff comes back,
 *      and only Accept writes. Reject changes nothing at all.
 *   4. **From code is lossy, by name (D7).** The starter card says what it is
 *      before the button is pressed, and the result is a proposal like any
 *      other.
 *
 * Redaction discipline: the graph, the instruction, the compiled code and the
 * walkthrough are the OWNER's own content. They render here for the owner and
 * are never logged, put in a URL, or embedded in an error string.
 */
import { useEffect, useMemo, useState } from 'react';
import type {
  FlowValidationError,
  SkillDraft,
  SkillFlow,
  SkillFlowProposal,
  SkillFlowState,
} from '@partner/shared';
import { flowToolIds, proposalDiffRows } from '../lib/flow-helpers.js';
import { toolOptions } from '../lib/skill-studio-helpers.js';
import {
  compileDraftFlow,
  draftFlowFromCode,
  explainDraftFlow,
  getDraftFlow,
  refineDraftFlow,
  saveDraftFlow,
} from '../lib/skills.js';
import { readStoredToken } from '../lib/token.js';
import { SkillFlowView } from '../SkillFlow.js';
import { isSessionLost, messageOf } from './shared.js';

// ---------------------------------------------------------------------------
// The proposal card (D8) — shared by the Flow tab and the from-code starter
// ---------------------------------------------------------------------------

export interface FlowProposalCardProps {
  proposal: SkillFlowProposal;
  /** Where the proposal came from, in the owner's words. */
  source: 'refine' | 'from-code';
  busy: boolean;
  disabled: boolean;
  onAccept: () => void;
  onReject: () => void;
}

/**
 * The accept/reject diff. It exists so the model cannot restructure a user's
 * graph behind their back: nothing is written until Accept, and Reject is a
 * plain discard rather than an undo (there is nothing to undo).
 */
export function FlowProposalCard({
  proposal,
  source,
  busy,
  disabled,
  onAccept,
  onReject,
}: FlowProposalCardProps): React.JSX.Element {
  const rows = proposalDiffRows(proposal.diff);
  return (
    <div className="flow-proposal" role="group" aria-label="Proposed flow changes">
      <p className="flow-proposal-head">
        {source === 'refine'
          ? 'A proposed change. Nothing has been saved — accept it or reject it.'
          : 'A proposed flow built from your code. Nothing has been saved, and the conversion is lossy: the model is guessing at what the code meant.'}
        {proposal.model !== null ? (
          <span className="studio-meta"> proposed by {proposal.model}</span>
        ) : null}
      </p>
      {rows.length === 0 ? (
        <p className="form-hint">
          The proposal changes nothing — the graph is exactly what it was.
        </p>
      ) : (
        <ul className="flow-proposal-rows">
          {rows.map((row) => (
            <li key={row.label} className="flow-proposal-row">
              <span className="flow-proposal-label">{row.label}</span>
              <span className="flow-proposal-detail studio-mono">{row.detail}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="flow-actions">
        <button
          type="button"
          className="btn btn-primary btn-sm"
          onClick={onAccept}
          disabled={disabled || busy}
          aria-busy={busy}
        >
          {busy ? 'Applying…' : 'Accept and save'}
        </button>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={onReject}
          disabled={disabled || busy}
        >
          Reject
        </button>
        <span className="form-hint">
          {source === 'refine'
            ? 'Saving writes the proposal into the draft. It does not compile it — the code still comes from Compile.'
            : 'Accepting stores the graph beside your code; nothing replaces the code until you compile.'}
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The Flow tab
// ---------------------------------------------------------------------------

export interface FlowPanelProps {
  draft: SkillDraft;
  /** True while the draft is installed: the core refuses every write. */
  readOnly: boolean;
  disabled: boolean;
  onSessionLost: () => void;
  /** A write changed the draft (compile) — the container re-reads it. */
  onDraftChanged: (draft: SkillDraft) => void;
}

/** The flow state + the issues most recently reported by the core. */
interface FlowRead {
  state: SkillFlowState | null;
  error: string | null;
  loading: boolean;
}

export function FlowPanel({
  draft,
  readOnly,
  disabled,
  onSessionLost,
  onDraftChanged,
}: FlowPanelProps): React.JSX.Element {
  const [read, setRead] = useState<FlowRead>({ state: null, error: null, loading: true });
  /** The graph being edited. Seeded from the core; replaced on every re-read. */
  const [working, setWorking] = useState<SkillFlow | null>(null);
  const [issues, setIssues] = useState<FlowValidationError[]>([]);
  const [busy, setBusy] = useState<null | 'save' | 'compile' | 'refine' | 'proposal' | 'explain'>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [instruction, setInstruction] = useState('');
  const [proposal, setProposal] = useState<SkillFlowProposal | null>(null);
  const [explanation, setExplanation] = useState<string | null>(null);
  const [recompileArmed, setRecompileArmed] = useState(false);
  const [bannerKept, setBannerKept] = useState(false);

  // One read per draft. The core is the source of truth for the graph, the
  // derived staleness and the palette gate (D9), so nothing here is inferred.
  useEffect(() => {
    const token = readStoredToken();
    if (token === null) {
      onSessionLost();
      return;
    }
    let cancelled = false;
    setRead({ state: null, error: null, loading: true });
    setIssues([]);
    setError(null);
    setNotice(null);
    setProposal(null);
    setExplanation(null);
    setRecompileArmed(false);
    setBannerKept(false);
    void (async () => {
      try {
        const state = await getDraftFlow(token, draft.id);
        if (cancelled) return;
        setRead({ state, error: null, loading: false });
        setWorking(state.flow);
      } catch (cause) {
        if (cancelled) return;
        if (isSessionLost(cause)) {
          onSessionLost();
          return;
        }
        setRead({
          state: null,
          error: messageOf(cause, 'Could not read this draft’s flow.'),
          loading: false,
        });
      }
    })();
    return () => {
      cancelled = true;
    };
    // Intended: reload for a different draft only; the session-lost handler is a
    // shell callback that is not identity-stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft.id]);

  const stored = read.state?.flow ?? null;
  const dirty = useMemo(() => {
    if (working === null || stored === null) return false;
    return JSON.stringify(working) !== JSON.stringify(stored);
  }, [working, stored]);

  const run = async (
    label: NonNullable<typeof busy>,
    work: () => Promise<void>,
  ): Promise<void> => {
    if (busy !== null || disabled || readOnly) return;
    setBusy(label);
    setError(null);
    setNotice(null);
    try {
      await work();
    } catch (cause) {
      if (isSessionLost(cause)) {
        onSessionLost();
        return;
      }
      setError(messageOf(cause, 'That did not work.'));
    } finally {
      setBusy(null);
    }
  };

  const save = (): Promise<void> =>
    run('save', async () => {
      const token = readStoredToken();
      if (token === null) {
        onSessionLost();
        return;
      }
      if (working === null) return;
      const result = await saveDraftFlow(token, draft.id, working);
      if (!result.ok) {
        // A malformed graph writes nothing and names every offender, so the
        // canvas can decorate the node each error points at.
        setIssues(result.errors);
        setError(result.errors[0]?.message ?? 'The flow was refused.');
        return;
      }
      setIssues([]);
      setNotice('Saved the graph. It is not compiled — the code is unchanged.');
      setRead({ state: result, error: null, loading: false });
      setWorking(result.flow);
    });

  const compile = (): Promise<void> =>
    run('compile', async () => {
      const token = readStoredToken();
      if (token === null) {
        onSessionLost();
        return;
      }
      const result = await compileDraftFlow(token, draft.id);
      if (!result.ok) {
        setIssues(result.errors);
        setError(result.errors[0]?.message ?? 'The flow does not compile.');
        return;
      }
      setIssues([]);
      setNotice(
        `Compiled. The code now comes from this graph${
          result.tools.length > 0 ? `, and it may request ${result.tools.join(', ')}` : ''
        }.`,
      );
      setRecompileArmed(false);
      setBannerKept(false);
      setRead({
        state: {
          flow: result.draft.flow,
          flowCompiledAt: result.draft.flowCompiledAt,
          flowStale: result.draft.flowStale,
          llmAvailable: read.state?.llmAvailable ?? false,
        },
        error: null,
        loading: false,
      });
      setWorking(result.draft.flow);
      onDraftChanged(result.draft);
    });

  const askForChange = (): Promise<void> =>
    run('refine', async () => {
      const token = readStoredToken();
      if (token === null) {
        onSessionLost();
        return;
      }
      const result = await refineDraftFlow(token, draft.id, instruction.trim());
      if (!result.ok) {
        setError(result.error);
        setIssues(result.errors);
        return;
      }
      setIssues([]);
      setProposal(result.proposal);
    });

  const explain = (): Promise<void> =>
    run('explain', async () => {
      const token = readStoredToken();
      if (token === null) {
        onSessionLost();
        return;
      }
      const result = await explainDraftFlow(token, draft.id);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setExplanation(result.text);
    });

  const acceptProposal = (): Promise<void> =>
    run('proposal', async () => {
      const token = readStoredToken();
      if (token === null) {
        onSessionLost();
        return;
      }
      if (proposal === null) return;
      const result = await saveDraftFlow(token, draft.id, proposal.flow);
      if (!result.ok) {
        setIssues(result.errors);
        setError(result.errors[0]?.message ?? 'The proposed graph was refused.');
        return;
      }
      setIssues([]);
      setProposal(null);
      setNotice('Saved the proposed graph. Compile when you want the code to follow it.');
      setRead({ state: result, error: null, loading: false });
      setWorking(result.flow);
    });

  if (read.loading && read.state === null) {
    return (
      <p className="skills-loading" aria-busy="true">
        Loading the flow…
      </p>
    );
  }
  if (read.error !== null && read.state === null) {
    return (
      <div className="skills-alert" role="alert">
        <p className="skills-alert-text">{read.error}</p>
      </div>
    );
  }

  const llmAvailable = read.state?.llmAvailable ?? false;
  const stale = read.state?.flowStale === true;
  const showBanner = stale && !bannerKept;
  // The palette's `tool` node picker offers the client-side registry mirror PLUS
  // any id the graph already names — the same discipline the manifest's tool
  // picker follows, so an id this build cannot mediate stays VISIBLE (and the
  // core's compiler names it) instead of being silently dropped.
  const toolIds = toolOptions(working === null ? [] : flowToolIds(working)).map(
    (option) => option.id,
  );

  return (
    <div className="flow-panel">
      {showBanner ? (
        <div className="flow-stale" role="status">
          <p className="flow-stale-text">
            The code is not what this flow compiles to — the draft was edited as code after this
            graph was last compiled, or the graph changed since. Installing now ships the code as
            it stands.
          </p>
          <div className="flow-actions">
            {recompileArmed ? (
              <>
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  onClick={() => void compile()}
                  disabled={disabled || readOnly || busy !== null || dirty}
                  aria-busy={busy === 'compile'}
                >
                  {busy === 'compile' ? 'Compiling…' : 'Yes, overwrite the code'}
                </button>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => setRecompileArmed(false)}
                  disabled={busy !== null}
                >
                  Cancel
                </button>
                <span className="form-hint">
                  This replaces the entry source with the graph’s output. Save the graph first.
                </span>
              </>
            ) : (
              <>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => setRecompileArmed(true)}
                  disabled={disabled || readOnly || busy !== null}
                >
                  Recompile…
                </button>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => setBannerKept(true)}
                  disabled={busy !== null}
                >
                  Keep the code
                </button>
                <span className="form-hint">
                  Keeping the code leaves this graph a sketch: it stays here, and the installed
                  skill runs the code as it stands.
                </span>
              </>
            )}
          </div>
        </div>
      ) : null}

      {working !== null ? (
        <SkillFlowView
          flow={working}
          llmAvailable={llmAvailable}
          toolIds={toolIds}
          readOnly={readOnly}
          disabled={disabled || busy !== null}
          errors={issues}
          onChange={setWorking}
        />
      ) : (
        <p className="flow-empty">
          This draft has no flow yet. Start one from the Code tab — either empty, or built from the
          code as a lossy proposal.
        </p>
      )}

      {working !== null ? (
        <div className="flow-actions">
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={() => void save()}
            disabled={disabled || readOnly || busy !== null || !dirty}
            aria-busy={busy === 'save'}
          >
            {busy === 'save' ? 'Saving…' : 'Save graph'}
          </button>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={() => void compile()}
            disabled={disabled || readOnly || busy !== null || dirty}
            aria-busy={busy === 'compile'}
            title={dirty ? 'Save the graph first — compiling reads the saved flow' : undefined}
          >
            {busy === 'compile' ? 'Compiling…' : 'Compile to code'}
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => void explain()}
            disabled={disabled || busy !== null}
            aria-busy={busy === 'explain'}
          >
            {busy === 'explain' ? 'Asking…' : 'Explain this flow'}
          </button>
          {dirty ? <span className="flow-dirty">Unsaved graph edits</span> : null}
        </div>
      ) : null}

      {working !== null ? (
        <div className="flow-refine">
          <label className="label" htmlFor="flow-refine-input">
            Ask the model to change this graph
          </label>
          <div className="flow-refine-row">
            <input
              id="flow-refine-input"
              className="field"
              type="text"
              value={instruction}
              onChange={(event) => setInstruction(event.target.value)}
              placeholder="e.g. keep only the notes that are not done yet"
              disabled={disabled || readOnly || busy !== null}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && instruction.trim() !== '') {
                  event.preventDefault();
                  void askForChange();
                }
              }}
            />
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => void askForChange()}
              disabled={disabled || readOnly || busy !== null || instruction.trim() === ''}
              aria-busy={busy === 'refine'}
            >
              {busy === 'refine' ? 'Asking…' : 'Propose a change'}
            </button>
          </div>
          <p className="form-hint">
            You get a proposal, never a rewrite: nothing is saved until you accept the diff. Unsaved
            graph edits are proposed against the SAVED graph — save first if they matter.
          </p>
        </div>
      ) : null}

      {proposal !== null ? (
        <FlowProposalCard
          proposal={proposal}
          source="refine"
          busy={busy === 'proposal'}
          disabled={disabled || readOnly}
          onAccept={() => void acceptProposal()}
          onReject={() => {
            setProposal(null);
            setNotice('Rejected. The graph is exactly as it was.');
          }}
        />
      ) : null}

      {explanation !== null ? (
        <div className="flow-explain">
          <p className="flow-explain-text">{explanation}</p>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => setExplanation(null)}
          >
            Close
          </button>
        </div>
      ) : null}

      {notice !== null ? (
        <p className="form-success" role="status">
          {notice}
        </p>
      ) : null}
      {error !== null ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The from-code starter (D7) — the flow-less draft's honest door
// ---------------------------------------------------------------------------

export interface FlowStarterProps {
  draft: SkillDraft;
  disabled: boolean;
  onSessionLost: () => void;
  /** A flow now exists (started empty, or a proposal was accepted). */
  onFlowStarted: () => void;
}

/**
 * D7 says plainly that there is NO decompiler: a code-authored draft has no
 * flow, and "generate a flow from the code" is an AI-assisted, LOSSY, declared
 * action — never a deterministic promise. This card is where that sentence
 * lives, next to the two buttons that can start a graph.
 */
export function FlowStarter({
  draft,
  disabled,
  onSessionLost,
  onFlowStarted,
}: FlowStarterProps): React.JSX.Element {
  const [busy, setBusy] = useState<null | 'empty' | 'from-code'>(null);
  const [proposal, setProposal] = useState<SkillFlowProposal | null>(null);
  const [error, setError] = useState<string | null>(null);

  const startEmpty = async (): Promise<void> => {
    const token = readStoredToken();
    if (token === null) {
      onSessionLost();
      return;
    }
    setBusy('empty');
    setError(null);
    try {
      const result = await saveDraftFlow(token, draft.id, { version: 1, nodes: [], edges: [] });
      if (!result.ok) {
        setError(result.errors[0]?.message ?? 'The empty graph was refused.');
        return;
      }
      onFlowStarted();
    } catch (cause) {
      if (isSessionLost(cause)) {
        onSessionLost();
        return;
      }
      setError(messageOf(cause, 'Could not start a flow.'));
    } finally {
      setBusy(null);
    }
  };

  const fromCode = async (): Promise<void> => {
    const token = readStoredToken();
    if (token === null) {
      onSessionLost();
      return;
    }
    setBusy('from-code');
    setError(null);
    try {
      const result = await draftFlowFromCode(token, draft.id);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setProposal(result.proposal);
    } catch (cause) {
      if (isSessionLost(cause)) {
        onSessionLost();
        return;
      }
      setError(messageOf(cause, 'Could not read the code into a flow.'));
    } finally {
      setBusy(null);
    }
  };

  const accept = async (): Promise<void> => {
    const token = readStoredToken();
    if (token === null) {
      onSessionLost();
      return;
    }
    if (proposal === null) return;
    setBusy('from-code');
    setError(null);
    try {
      const result = await saveDraftFlow(token, draft.id, proposal.flow);
      if (!result.ok) {
        setError(result.errors[0]?.message ?? 'The proposed graph was refused.');
        return;
      }
      onFlowStarted();
    } catch (cause) {
      if (isSessionLost(cause)) {
        onSessionLost();
        return;
      }
      setError(messageOf(cause, 'Could not save the proposed flow.'));
    } finally {
      setBusy(null);
    }
  };

  if (proposal !== null) {
    return (
      <FlowProposalCard
        proposal={proposal}
        source="from-code"
        busy={busy === 'from-code'}
        disabled={disabled}
        onAccept={() => void accept()}
        onReject={() => {
          setProposal(null);
          setError(null);
        }}
      />
    );
  }

  return (
    <div className="flow-starter">
      <p className="form-hint">
        This draft was written as code, so it has no flow. A flow is an optional canvas over the
        SAME artifact: the core compiles it into the entry source, and installing always consumes
        the code. There is no decompiler here — building a flow from your code asks the model to
        guess at what the code meant, which is lossy, and the result is a proposal you accept or
        reject.
      </p>
      <div className="flow-actions">
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={() => void startEmpty()}
          disabled={disabled || busy !== null}
          aria-busy={busy === 'empty'}
        >
          {busy === 'empty' ? 'Starting…' : 'Start an empty flow'}
        </button>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={() => void fromCode()}
          disabled={disabled || busy !== null}
          aria-busy={busy === 'from-code'}
        >
          {busy === 'from-code' ? 'Asking…' : 'Build a flow from this code (lossy)'}
        </button>
      </div>
      {error !== null ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
