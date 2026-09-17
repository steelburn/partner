/**
 * M28-era Studio split — the first-run surface.
 *
 * It carries the milestone's most important sentence for a new owner: a draft is
 * INERT until they install it. That belongs where someone with no drafts is
 * actually looking.
 *
 * The form itself lives in `DraftComposer`, because a second door to it exists:
 * once the owner HAS a draft, this empty state is gone (it renders at
 * `drafts.length === 0`), so the rail's "New draft" action mounts the same
 * composer. One form, two doors.
 */
import type { SkillDraft } from '@partner/shared';
import type { TemplateOption } from '../lib/skill-studio-helpers.js';

import { DraftComposer } from './DraftComposer.js';

// ---------------------------------------------------------------------------
// Empty state — the invite action
// ---------------------------------------------------------------------------

export interface DraftEmptyStateProps {
  templates: TemplateOption[] | null;
  templatesError: string | null;
  /**
   * Is a model provider configured? `null` means "still checking" — the honest
   * third state, because claiming there is none while the probe is in flight
   * would be a lie the owner cannot see through.
   */
  providerConfigured: boolean | null;
  disabled: boolean;
  onCreated: (draft: SkillDraft) => void;
  onSessionLost: () => void;
}

/**
 * The first-run surface: the inert-draft sentence, the numbered guide, and the
 * composer that starts one.
 */
export function DraftEmptyState({
  templates,
  templatesError,
  providerConfigured,
  disabled,
  onCreated,
  onSessionLost,
}: DraftEmptyStateProps) {
  return (
    <section className="empty-state" aria-label="Start a skill draft">
      <p className="empty-state-title">No drafts yet</p>
      <p className="empty-state-copy">
        A draft is a skill bundle this core can hold without running it: you read the code, test
        it in the sandbox, and only then install it. Nothing in a draft runs or installs until you
        ask it to.
      </p>
      <ol className="studio-steps">
        <li>Describe the skill you want, or start from a template this build ships.</li>
        <li>Read the code and fix anything the validator names.</li>
        <li>Test-run it in the sandbox with your own args.</li>
        <li>Install it — it then appears under Installed.</li>
      </ol>

      <DraftComposer
        templates={templates}
        templatesError={templatesError}
        providerConfigured={providerConfigured}
        disabled={disabled}
        onCreated={onCreated}
        onSessionLost={onSessionLost}
      />
    </section>
  );
}

