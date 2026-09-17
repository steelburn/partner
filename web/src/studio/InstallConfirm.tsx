/**
 * M28-era Studio split — the second install step (the explicit acknowledgement).
 *
 * Separated from InstallPanel on purpose: the confirmation is the whole consent
 * mechanism, and keeping it in its own file means no future edit to the panel can
 * quietly fold the two steps into one.
 */
import type { SkillDraft } from '@partner/shared';
import type { PermissionDiffRow } from '../lib/skill-studio-helpers.js';

// ---------------------------------------------------------------------------
// Step 2 of the install — what the owner is consenting to
// ---------------------------------------------------------------------------

export interface InstallConfirmProps {
  draft: SkillDraft;
  /** Before -> after rows of a widened permission set (empty on a create). */
  diffRows: PermissionDiffRow[];
  isUpdate: boolean;
  busy: boolean;
  disabled: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * The confirmation, and the ONLY thing whose button sends a promote request
 * (M26 D6). It carries the change table when the install widens a permission
 * set, and says plainly when it does not — so the acknowledgement is never sent
 * against a table the owner has not seen.
 */
export function InstallConfirm({
  draft,
  diffRows,
  isUpdate,
  busy,
  disabled,
  onConfirm,
  onCancel,
}: InstallConfirmProps) {
  return (
    <div className="studio-confirm">
      {diffRows.length > 0 ? (
        <div className="studio-diff">
          <h3 className="sub-panel-title">What this update adds</h3>
          <p className="form-hint">
            This install widens what the skill may do. Compare before and after before you confirm.
          </p>
          <table className="studio-diff-table">
            <caption className="sr-only">Permission changes in this update</caption>
            <thead>
              <tr>
                <th scope="col">Field</th>
                <th scope="col">Before</th>
                <th scope="col">After</th>
              </tr>
            </thead>
            <tbody>
              {diffRows.map((row) => (
                <tr key={row.field}>
                  <th scope="row">{row.label}</th>
                  <td className="studio-diff-before">{row.before}</td>
                  <td className="studio-diff-after">{row.after}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : isUpdate ? (
        <p className="form-hint">This update does not widen what the skill can do.</p>
      ) : null}

      <div className="studio-actions">
        <button
          type="button"
          className="btn btn-primary"
          onClick={onConfirm}
          disabled={disabled || busy}
          aria-busy={busy}
        >
          {busy ? 'Installing…' : isUpdate ? 'Update now' : 'Install now'}
        </button>
        <button
          type="button"
          className="btn btn-secondary"
          onClick={onCancel}
          disabled={disabled || busy}
        >
          Cancel
        </button>
        <span className="form-hint">
          The summary above is what you are approving
          {diffRows.length > 0 ? ' — including every line in the change table' : ''}.{' '}
          {draft.name} stays editable until then.
        </span>
      </div>
    </div>
  );
}
