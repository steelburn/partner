/**
 * The skill-install approval card (M26 D2b, chat + Files queue).
 *
 * WHY this exists as its own component: a persona can now ASK for two different
 * things — install a draft it authored, or UPDATE a skill the user already has —
 * and the owner has to be able to GRANT either one from where the ask appears.
 * The core already writes the row (`pending_tools`, kind 'skill_install') and
 * decides it through `drafts.promote`, the same function the Studio's button
 * calls; what was missing was the surface: the queue rendered such a row with no
 * name, no permissions and no way to acknowledge a widening, so an update ask
 * could only ever be answered in the Studio — or refused as `permission_change`
 * with no next step.
 *
 * The consent rule is the Studio's, unchanged and NOT re-implemented: the
 * before→after table must be on screen BEFORE `acknowledgePermissions` travels
 * (`skillInstallDecision` below is the whole rule, and the same shape as
 * `installRequestBody` in lib/skill-studio-helpers.ts). The card loads the draft
 * and — when the draft would UPDATE an installed skill — that skill, so the
 * table is computed from the same two manifests the core will compare.
 *
 * Nothing here installs anything by itself: pressing Approve sends the decision
 * the owner just made, exactly like the Studio's confirm.
 */
import { useEffect, useMemo, useState } from 'react';
import type { PendingToolCall, SkillDraft, SkillManifest } from '@partner/shared';
import { permissionSummary, type PermissionChip } from './lib/skill-helpers.js';
import { permissionDiffRows, type PermissionDiffRow } from './lib/skill-studio-helpers.js';
import { getDraft, getSkill } from './lib/skills.js';
import { readStoredToken } from './lib/token.js';

/** A fetch stand-in (the suite injects one; the app uses the global). */
type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

// ---------------------------------------------------------------------------
// The rule, as a pure function (asserted on its own)
// ---------------------------------------------------------------------------

/**
 * What the decide request carries. The acknowledgement travels ONLY when the
 * change table is on screen: a widened permission set without it is refused by
 * the core (`permission_change`), which is the whole point of D6 — consent is
 * shown, not implied.
 */
export function skillInstallDecision(rows: readonly PermissionDiffRow[]): {
  acknowledgePermissions?: true;
} {
  return rows.length > 0 ? { acknowledgePermissions: true } : {};
}

/** What the card is looking at, once it has loaded it. */
export interface SkillInstallView {
  draft: SkillDraft;
  /** The installed skill this draft would UPDATE, when one exists. */
  installed: { manifest: SkillManifest; version: string } | null;
  rows: PermissionDiffRow[];
}

/**
 * Load the two manifests the consent decision needs.
 *
 * The installed skill is keyed by the MANIFEST id, not the draft id: an `edit`
 * draft is stored as `<skill>-edit` while its manifest keeps the installed
 * skill's id — that binding is what makes promoting an update rather than a new
 * skill (the same probe SkillStudio makes).
 */
export async function loadSkillInstallView(
  token: string,
  draftId: string,
  options: { fetchImpl?: FetchLike } = {},
): Promise<SkillInstallView> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const draft = await getDraft(token, draftId, { fetchImpl });
  const target = draft.manifest?.id ?? draft.id;
  let installed: { manifest: SkillManifest; version: string } | null = null;
  try {
    const skill = await getSkill(token, target, { fetchImpl });
    installed = { manifest: skill.manifest, version: skill.version };
  } catch {
    // Not installed = a first install; that is not an error.
    installed = null;
  }
  return { draft, installed, rows: permissionDiffRows(installed?.manifest ?? null, draft.manifest) };
}

// ---------------------------------------------------------------------------
// The card
// ---------------------------------------------------------------------------

export interface SkillInstallCardProps {
  row: PendingToolCall;
  /** True while a decision for ANY row is in flight (one at a time). */
  busy: boolean;
  /** True while THIS row is being decided (the button shows it). */
  deciding: boolean;
  /** A refusal from the last decision, shown in place of a dead end. */
  error: string | null;
  onDecide: (
    decision: 'approve' | 'deny',
    options?: { acknowledgePermissions?: boolean },
  ) => void;
}

/** What both the loading card and the loaded body need from their parent. */
export type SkillInstallBodyProps = Omit<SkillInstallCardProps, 'row'> & {
  /** The ask's draft name, so the loading state already names the skill. */
  draftName: string;
  view: SkillInstallView | null;
  /** A failure to read the draft (discarded, or the session is gone). */
  loadError?: string | null;
};

/**
 * The card body for a LOADED view (or the loading/error states). Split out so the
 * whole consent surface is renderable without a network: the effect that fetches
 * belongs to `SkillInstallCard`, and every state the owner can see is asserted
 * against this component.
 */
export function SkillInstallBody({
  draftName,
  view,
  loadError = null,
  busy,
  deciding,
  error,
  onDecide,
}: SkillInstallBodyProps) {
  // `permissionChange` is the core's own answer that the acknowledgement is
  // still owed: it is rendered as the next step, never as a failure.
  const needsAck = error !== null && error.includes('permission_change');
  const chips: PermissionChip[] = useMemo(
    () => (view?.draft.manifest ? permissionSummary(view.draft.manifest.permissions) : []),
    [view],
  );

  const name = view?.draft.name ?? draftName;
  const isUpdate = view?.installed !== null && view?.installed !== undefined;
  const rows = view?.rows ?? [];
  const action = isUpdate ? 'Update' : 'Install';

  if (loadError !== null) {
    return (
      <div className="queue-item-inner">
        <div className="queue-item-head">
          <div className="queue-item-title">
            <span className="queue-tool">Skill install</span>
          </div>
        </div>
        <p className="row-error" role="alert">
          {loadError}
        </p>
      </div>
    );
  }

  if (view === null) {
    return (
      <div className="queue-item-inner">
        <div className="queue-item-head">
          <div className="queue-item-title">
            <span className="queue-tool">Skill install: {draftName}</span>
          </div>
        </div>
        <p className="form-hint" aria-busy="true">
          Reading the draft…
        </p>
      </div>
    );
  }

  return (
    <div className="queue-item-inner">
      <div className="queue-item-head">
        <div className="queue-item-title">
          <span className="queue-tool">
            {action} skill: {name}
          </span>
          {view.installed !== null ? (
            <span className="studio-meta">
              v{view.installed.version} → v{view.draft.manifest?.version ?? view.installed.version}
            </span>
          ) : (
            <span className="studio-meta">v{view.draft.manifest?.version ?? '—'}</span>
          )}
        </div>
        <div className="row-actions">
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={busy}
            onClick={() => onDecide('approve', skillInstallDecision(rows))}
            aria-busy={deciding}
            aria-label={
              rows.length > 0
                ? `${action} ${name} — including every line in the change table`
                : `${action} ${name}`
            }
          >
            {deciding ? 'Working…' : rows.length > 0 ? `${action} now` : action}
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-sm btn-danger"
            disabled={busy}
            onClick={() => onDecide('deny')}
            aria-label={`Deny ${name} — nothing is installed or changed`}
          >
            Deny
          </button>
        </div>
      </div>

      {chips.length > 0 ? (
        <div className="skill-chips" aria-label="Permissions">
          {chips.map((chip) => (
            <span key={chip.id} className={`skill-chip skill-chip-${chip.tone}`} title={chip.title}>
              {chip.label}
            </span>
          ))}
        </div>
      ) : null}

      {rows.length > 0 ? (
        <div className="studio-diff">
          <p className="form-hint">
            This {isUpdate ? 'update' : 'install'} widens what the skill may do. Compare before and
            after before you approve.
          </p>
          <table className="studio-diff-table">
            <caption className="sr-only">Permission changes in this install</caption>
            <thead>
              <tr>
                <th scope="col">Field</th>
                <th scope="col">Before</th>
                <th scope="col">After</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
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
      ) : (
        <p className="form-hint">
          Installing copies this bundle into your skills store. It runs only when you invoke it.
        </p>
      )}

      {needsAck ? (
        <p className="row-error" role="alert">
          The core wants this widening acknowledged: read the table above, then press {action} now.
          Cancel by denying.
        </p>
      ) : error !== null ? (
        <p className="row-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * The card as the queue and the chat mount it: it reads the two manifests the
 * consent decision needs, then hands them to {@link SkillInstallBody}.
 */
export function SkillInstallCard({ row, busy, deciding, error, onDecide }: SkillInstallCardProps) {
  const [view, setView] = useState<SkillInstallView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  /**
   * Bumped to re-read the two manifests. The one case that needs it: the core
   * answered `permission_change`, which can only happen when THIS card's view is
   * stale (the draft gained a permission after it loaded) — the fix is to show
   * the table the refusal is about, not to tell the owner to confirm something
   * that is not on screen.
   */
  const [reloadKey, setReloadKey] = useState(0);
  const draftId = row.draftId ?? '';
  const draftName = row.draftName ?? 'skill draft';

  useEffect(() => {
    if (error === null || !error.includes('permission_change')) return;
    setReloadKey((key) => key + 1);
  }, [error]);

  useEffect(() => {
    if (draftId === '') {
      setLoadError('This ask names no draft — nothing can be installed from it.');
      return;
    }
    const token = readStoredToken();
    if (!token) {
      setLoadError('Your session has expired — pair again to decide this.');
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const loaded = await loadSkillInstallView(token, draftId);
        if (!cancelled) setView(loaded);
      } catch {
        if (!cancelled) setLoadError('Could not read that draft — it may have been discarded.');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [draftId, reloadKey]);

  return (
    <SkillInstallBody
      draftName={draftName}
      view={view}
      loadError={loadError}
      busy={busy}
      deciding={deciding}
      error={error}
      onDecide={onDecide}
    />
  );
}
