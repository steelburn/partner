/**
 * M28-era Studio split — the dry run.
 *
 * The ONLY place in the Studio that executes draft code, and only when the OWNER
 * presses Run. It is separate from the editor so that fact is visible at a
 * glance: no other file in this folder can spawn a worker.
 */
import { useMemo, useState, type FormEvent } from 'react';
import type { SkillDraft } from '@partner/shared';
import { formatBytes } from '../lib/skill-helpers.js';
import { dryRunArgs, toolDeniedHint } from '../lib/skill-studio-helpers.js';
import { runDraft } from '../lib/skills.js';
import { invocationErrorLabel } from '../lib/skill-helpers.js';
import { readStoredToken } from '../lib/token.js';

import { isSessionLost, renderResult, messageOf } from './shared.js';

// ---------------------------------------------------------------------------
// Test run (the dry run)
// ---------------------------------------------------------------------------

export interface RunPanelProps {
  draft: SkillDraft;
  disabled: boolean;
  onSessionLost: () => void;
}

type RunOutcome =
  | { kind: 'ok'; value: unknown; logs: string[]; ms: number }
  | { kind: 'error'; code: string; logs: string[]; ms: number };

/**
 * The dry run. It is the ONLY thing in this file that executes draft code, and
 * it only happens when the owner presses Run. An invalid draft is refused
 * before the request (the sandbox refuses it too), and a failure shows the
 * worker's own log lines — which is what turns an opaque `crashed` into
 * something the owner can fix.
 */
export function RunPanel({ draft, disabled, onSessionLost }: RunPanelProps) {
  const [argsText, setArgsText] = useState('');
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<RunOutcome | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);

  const argsCheck = useMemo(() => dryRunArgs(argsText), [argsText]);
  const runnable = draft.validation.ok;

  const run = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (busy || disabled || !runnable || !argsCheck.ok) return;
    const token = readStoredToken();
    if (!token) {
      onSessionLost();
      return;
    }
    setBusy(true);
    setOutcome(null);
    setRequestError(null);
    try {
      const result = await runDraft(token, draft.id, {
        ...(argsCheck.value !== undefined ? { args: argsCheck.value } : {}),
      });
      setOutcome(
        result.ok
          ? { kind: 'ok', value: result.result, logs: result.logs ?? [], ms: result.ms }
          : { kind: 'error', code: result.error, logs: result.logs ?? [], ms: result.ms },
      );
    } catch (cause) {
      if (isSessionLost(cause)) {
        onSessionLost();
        return;
      }
      setRequestError(messageOf(cause, 'Could not start the run.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card" aria-label="Test run">
      <h2 className="card-title">Test run</h2>
      <p className="card-copy">
        Runs the draft in its own sandbox with the manifest&apos;s own budget, using the same
        worker an installed skill uses. Nothing is recorded as an invocation and nothing is
        installed.
      </p>
      <form className="form-stack" onSubmit={(event) => void run(event)} aria-busy={busy}>
        <div className="form-field">
          <div className="studio-pane-head">
            <label className="label" htmlFor="studio-run-args">
              Args (JSON)
            </label>
            <span className="studio-size-hint">
              {argsText.trim().length > 0 ? formatBytes(argsCheck.bytes) : '≤ 64 KB'}
            </span>
          </div>
          <textarea
            id="studio-run-args"
            className="field skill-args"
            value={argsText}
            onChange={(event) => setArgsText(event.target.value)}
            disabled={disabled || busy}
            spellCheck={false}
            placeholder="{}"
            aria-describedby="studio-run-args-hint"
          />
          <p id="studio-run-args-hint" className="form-hint">
            Passed to <code className="studio-inline-mono">run(args)</code> verbatim. A tool the
            manifest does not declare — or that has no grant — is refused by the sandbox.
          </p>
          {!argsCheck.ok ? (
            <p className="form-error" role="alert">
              {argsCheck.error}
            </p>
          ) : null}
        </div>
        <div className="studio-actions">
          <button
            type="submit"
            className="btn btn-primary"
            disabled={disabled || busy || !runnable || !argsCheck.ok}
          >
            {busy ? 'Running…' : 'Run draft'}
          </button>
          {!runnable ? (
            <span className="form-hint">
              The sandbox refuses a draft the validator rejects — fix the validation problems
              first.
            </span>
          ) : null}
        </div>
      </form>

      {requestError !== null ? (
        <p className="form-error" role="alert">
          {requestError}
        </p>
      ) : null}

      {outcome !== null ? (
        <div className="studio-outcome" aria-live="polite">
          {outcome.kind === 'ok' ? (
            <>
              <p className="result-meta">
                Result{outcome.ms > 0 ? ` — ran in ${outcome.ms} ms` : ''}
              </p>
              {outcome.value === undefined ? (
                <p className="result-empty">The skill returned nothing.</p>
              ) : (
                <pre className="pre-content">{renderResult(outcome.value)}</pre>
              )}
            </>
          ) : (
            <>
              <p className="form-error" role="alert">
                {invocationErrorLabel(outcome.code)}
                <span className="invoke-code" title={`Error code: ${outcome.code}`}>
                  {outcome.code}
                </span>
              </p>
              {outcome.code === 'tool_denied' ? (
                // M27 S1: name WHERE the grant goes. A dry-run runs the real
                // sandbox, so "denied" here means "not granted yet" — and the
                // fix differs by scope (App data vs a registered root).
                <p className="result-meta">
                  {toolDeniedHint(draft.manifest?.permissions.tools ?? [])}
                </p>
              ) : null}
              {outcome.ms > 0 ? <p className="result-meta">Ran for {outcome.ms} ms.</p> : null}
            </>
          )}
          <h3 className="sub-panel-title">Worker log</h3>
          {outcome.logs.length === 0 ? (
            <p className="result-empty">The worker produced no log lines.</p>
          ) : (
            <pre className="studio-logs">{outcome.logs.join('\n')}</pre>
          )}
        </div>
      ) : null}
    </section>
  );
}
