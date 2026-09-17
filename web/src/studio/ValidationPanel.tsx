/**
 * M28-era Studio split — the validation verdict (errors, warnings, the reach
 * lines the core reported).
 *
 * Split from the editor because it is pure presentation of a value the editor
 * already holds: it fetches nothing and owns no state beyond the busy flag.
 */
import type { SkillDraftValidation } from '@partner/shared';
import { validationSummary, warningCount } from '../lib/skill-studio-helpers.js';

// ---------------------------------------------------------------------------
// Validation panel
// ---------------------------------------------------------------------------

export interface ValidationPanelProps {
  validation: SkillDraftValidation;
  busy: boolean;
  disabled: boolean;
  onRevalidate: () => void;
}

/**
 * The deterministic result, in the two halves the core draws: what is WRONG
 * (errors — the install would be refused) and what it MEANS (warnings — what
 * the declared reach actually lets this skill do).
 */
export function ValidationPanel({
  validation,
  busy,
  disabled,
  onRevalidate,
}: ValidationPanelProps) {
  const summary = validationSummary(validation);
  const warnings = warningCount(validation);
  return (
    <div className="studio-validation">
      <div className="studio-pane-head">
        <span className={summary.ok ? 'studio-state studio-state-ok' : 'studio-state studio-state-error'}>
          {summary.label}
        </span>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={onRevalidate}
          disabled={disabled || busy}
          aria-busy={busy}
        >
          {busy ? 'Checking…' : 'Re-validate'}
        </button>
      </div>
      {summary.ok ? (
        <p className="form-success" role="status">
          The manifest and entry pass every check the installer applies. A test run is still the
          only proof it works.
        </p>
      ) : (
        <ul className="studio-error-list">
          {validation.errors.map((problem) => (
            <li key={problem} className="studio-error-item">
              {problem}
            </li>
          ))}
        </ul>
      )}
      {warnings > 0 ? (
        <>
          <h3 className="sub-panel-title">What this skill can reach</h3>
          <ul className="studio-warn-list">
            {validation.warnings.map((note) => (
              <li key={note} className="studio-warn-item">
                {note}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}
