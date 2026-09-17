/**
 * M28-era Studio split — the install surface and its two-step confirmation.
 *
 * Owns the consent contract: the before -> after permission table renders BEFORE
 * any acknowledgement can travel (`installRequestBody` decides that, in
 * lib/skill-studio-helpers.ts), and InstallConfirm holds the second step so no
 * panel can skip it.
 */
import { useState } from 'react';
import type { SkillDraft, SkillDraftInstallResult } from '@partner/shared';
import { permissionSummary, type PermissionChip } from '../lib/skill-helpers.js';
import { installRequestBody, type ConfirmStage, type PermissionDiffRow } from '../lib/skill-studio-helpers.js';
import { installDraft } from '../lib/skills.js';
import { readStoredToken } from '../lib/token.js';

import { InstallConfirm } from './InstallConfirm.js';
import { isSessionLost, messageOf } from './shared.js';

// ---------------------------------------------------------------------------
// Install (two-step, with the consent table)
// ---------------------------------------------------------------------------

export interface InstallPanelProps {
  draft: SkillDraft;
  /** Before -> after rows for a widened permission set (empty on a create). */
  diffRows: PermissionDiffRow[];
  /** Version of the installed skill this would update, when one exists. */
  installedVersion: string | null;
  disabled: boolean;
  onInstalled: (result: SkillDraftInstallResult) => void;
  onSessionLost: () => void;
}

/** A refusal the owner can act on (a coded outcome from the client). */
interface InstallRefusal {
  code: string;
  message: string;
}

/**
 * The install — always two steps, and never from a row in a list.
 *
 * The summary the owner reads (plain-language permission chips, the declared
 * tool ids, risk, budget) is on screen BEFORE the button, and the before/after
 * table for an update is shown in full. `installRequestBody` refuses to build a
 * body until the confirmation step is reached, and only ever adds the
 * acknowledgement when there is something to acknowledge.
 *
 * When the core still refuses with `permission_change` (its own widening check
 * is the authority, and it can know something this screen does not), that is
 * rendered as the next step — "review the summary and confirm" — and the next
 * confirmed press acknowledges. A refusal is never a dead end.
 */
export function InstallPanel({
  draft,
  diffRows,
  installedVersion,
  disabled,
  onInstalled,
  onSessionLost,
}: InstallPanelProps) {
  const [stage, setStage] = useState<ConfirmStage>('idle');
  const [busy, setBusy] = useState(false);
  const [coreDemandedAck, setCoreDemandedAck] = useState(false);
  const [refusal, setRefusal] = useState<InstallRefusal | null>(null);

  const manifest = draft.manifest;
  const chips = manifest === null ? [] : permissionSummary(manifest.permissions);
  const installedTools = manifest?.permissions.tools ?? [];
  const isUpdate = installedVersion !== null;
  const blocked = !draft.validation.ok || manifest === null;

  const install = async (): Promise<void> => {
    const body = installRequestBody(stage, diffRows, { coreDemanded: coreDemandedAck });
    if (body === null || busy || disabled) return;
    const token = readStoredToken();
    if (!token) {
      onSessionLost();
      return;
    }
    setBusy(true);
    setRefusal(null);
    try {
      const result = await installDraft(
        token,
        draft.id,
        body.acknowledgePermissions === true ? { acknowledgePermissions: true } : {},
      );
      if (result.ok) {
        setStage('idle');
        // The container renders the outcome: a successful install flips this
        // draft to `installed`, which replaces this panel in the same tick.
        onInstalled(result.result);
      } else {
        setRefusal({ code: result.code, message: result.message });
        if (result.code === 'permission_change') {
          // The core's check is the authority: confirm again to acknowledge.
          setCoreDemandedAck(true);
          setStage('confirm');
        }
      }
    } catch (cause) {
      if (isSessionLost(cause)) {
        onSessionLost();
        return;
      }
      setRefusal({
        code: 'request_failed',
        message: messageOf(cause, 'Could not install the draft.'),
      });
      setStage('idle');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card" aria-label="Install">
      <h2 className="card-title">Install</h2>
      <p className="card-copy">
        Installing copies this bundle into your skills store as{' '}
        <code className="studio-inline-mono">{manifest?.id ?? draft.id}</code>
        {isUpdate
          ? ` — it updates the installed copy (v${installedVersion}) in place.`
          : ' as a new skill.'}{' '}
        This is the only step that makes it runnable.
      </p>

      <div className="studio-install-summary">
        <p className="studio-install-line">
          <span className="studio-install-name">{manifest?.name ?? draft.name}</span>
          <span className="studio-meta">v{manifest?.version ?? installedVersion ?? '—'}</span>
        </p>
        {chips.length > 0 ? (
          <div className="skill-chips" aria-label="Permissions">
            {chips.map((chip: PermissionChip) => (
              <span key={chip.id} className={`skill-chip skill-chip-${chip.tone}`} title={chip.title}>
                {chip.label}
              </span>
            ))}
          </div>
        ) : null}
        <dl className="studio-install-facts">
          <dt>Tools</dt>
          <dd>{installedTools.length === 0 ? 'None' : installedTools.join(', ')}</dd>
          <dt>Network</dt>
          <dd>Not available to skills — this build never grants it.</dd>
          <dt>Risk</dt>
          <dd>{manifest?.permissions.risk ?? '—'}</dd>
          <dt>Time budget</dt>
          <dd>{manifest === null ? '—' : `${manifest.budget.timeMs} ms`}</dd>
        </dl>
      </div>

      {refusal !== null ? (
        <p className="form-error" role="alert">
          {refusal.message}
          {refusal.code === 'permission_change'
            ? ' The permission summary above is what you are acknowledging: confirm to install, or cancel and edit the draft.'
            : null}
        </p>
      ) : null}

      {blocked ? (
        <p className="form-hint">
          Fix the validation problems first — the core refuses to install a draft it cannot
          validate.
        </p>
      ) : stage === 'idle' ? (
        <div className="studio-actions">
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => {
              setRefusal(null);
              setStage('confirm');
            }}
            disabled={disabled || busy}
          >
            {isUpdate ? 'Update skill…' : 'Install skill…'}
          </button>
        </div>
      ) : (
        <InstallConfirm
          draft={draft}
          diffRows={diffRows}
          isUpdate={isUpdate}
          busy={busy}
          disabled={disabled}
          onConfirm={() => void install()}
          onCancel={() => {
            setStage('idle');
            setCoreDemandedAck(false);
          }}
        />
      )}
    </section>
  );
}
