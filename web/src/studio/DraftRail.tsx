/**
 * M28-era Studio split — the left rail (draft list) and the empty state.
 *
 * Both are "what can I open" concerns: the rail lists existing drafts, and the
 * empty state is what the rail shows when there are none. They were one block in
 * SkillStudio.tsx and are one file here.
 *
 * The rail never needs a draft's SOURCE — it renders SkillDraftSummary rows — so
 * this file cannot accidentally render (or leak) a draft body.
 */
import type { SkillDraftSummary } from '@partner/shared';
import { DRAFT_ORIGIN_LABELS, validationSummary } from '../lib/skill-studio-helpers.js';
import { timeAgo } from '../lib/persona-helpers.js';

// ---------------------------------------------------------------------------
// Left rail — the drafts
// ---------------------------------------------------------------------------

export interface DraftRailProps {
  drafts: SkillDraftSummary[] | null;
  selectedId: string | null;
  onSelect: (id: string) => void;
  disabled: boolean;
  loading: boolean;
  loadError: string | null;
  onRetry: () => void;
  /**
   * Open the create form. Offered only when there ARE drafts: the empty state
   * already owns creation at `drafts.length === 0`, and two doors to one form
   * would be two copies of the same ids.
   */
  onCompose?: () => void;
}

/**
 * The draft list. A row is a real button (selection is a keyboard action) and
 * carries the four facts the owner triages on: name, origin, validation state
 * and how long ago it changed — plus the one marker that means "something of
 * yours is waiting", which is what the attention badge counts.
 */
export function DraftRail({
  drafts,
  selectedId,
  onSelect,
  disabled,
  loading,
  loadError,
  onRetry,
  onCompose,
}: DraftRailProps) {
  const canCompose = onCompose !== undefined && drafts !== null && drafts.length > 0;
  return (
    <nav className="studio-rail" aria-label="Drafts">
      {/* .studio-pane-head is the shared title-beside-action row: no new rule,
       * no new shadow, and the action keeps the .btn state contract. */}
      <div className="studio-pane-head">
        <h2 className="studio-rail-title">Drafts</h2>
        {canCompose ? (
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={onCompose}
            disabled={disabled}
          >
            New draft
          </button>
        ) : null}
      </div>
      {loading ? (
        <p className="skills-loading" aria-busy="true">
          Loading drafts…
        </p>
      ) : loadError !== null ? (
        <div className="skills-alert" role="alert">
          <p className="skills-alert-text">{loadError}</p>
          <button type="button" className="btn btn-secondary btn-sm" onClick={onRetry} disabled={disabled}>
            Try again
          </button>
        </div>
      ) : drafts !== null && drafts.length === 0 ? (
        <p className="studio-note">No drafts yet.</p>
      ) : drafts !== null ? (
        <ul className="studio-rail-list">
          {drafts.map((draft) => {
            const state = validationSummary(draft.validation);
            const selected = draft.id === selectedId;
            return (
              <li key={draft.id}>
                <button
                  type="button"
                  className="btn btn-secondary studio-draft"
                  aria-current={selected ? 'true' : undefined}
                  onClick={() => onSelect(draft.id)}
                  disabled={disabled}
                >
                  <span className="studio-draft-name">{draft.name}</span>
                  <span className="studio-draft-meta">
                    <span className="skill-chip skill-chip-neutral">
                      {DRAFT_ORIGIN_LABELS[draft.origin] ?? draft.origin}
                    </span>
                    <span
                      className={
                        state.ok ? 'studio-state studio-state-ok' : 'studio-state studio-state-error'
                      }
                    >
                      {state.label}
                    </span>
                    <span className="studio-draft-time">{timeAgo(draft.updatedAt)}</span>
                    {/* D11 honesty: the canned generator answers when nothing is configured,
                     * so a draft that no model wrote must SAY so - otherwise "generated"
                     * implies a model produced it. */}
                    {draft.model === 'demo' ? (
                      <span className="studio-note studio-draft-time">
                        canned example - no model configured
                      </span>
                    ) : null}
                  </span>
                  {draft.pendingInstallId !== null ? (
                    <span className="studio-flag">Awaiting your approval</span>
                  ) : null}
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </nav>
  );
}
