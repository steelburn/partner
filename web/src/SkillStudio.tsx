/**
 * M26 Skill Studio (PLAN-M26.md cut D) — the authoring work area.
 *
 * WHY a separate file: the Studio is a whole workflow (describe -> read ->
 * fix -> test-run -> install), and folding it into the 900-line SkillsView would
 * make both harder to reason about. Installed and Catalog stay where they are;
 * this file owns the Build segment.
 *
 * SPLIT (2026-09-17): this file is now the CONTAINER only — it owns the draft
 * list, the selected draft, and every fetch. The panels live in `./studio/*`
 * (rail, empty state, editor, validation, run, install + confirm, actions) and
 * are re-exported below, so this module remains the one public door. The split
 * happened BEFORE M28's canvas work, so the canvas lands in a folder that
 * already separates rail / editor / validation / install instead of inheriting a
 * 2000-line file.
 *
 * The properties the UI has to make true, because the core cannot make them
 * true for the owner:
 *
 *   1. **A draft is inert, and the screen says so.** Nothing here executes draft
 *      code except the Test run the OWNER presses, and nothing installs without
 *      the two-step confirmation in front of it. The empty state states this in
 *      one sentence rather than assuming the reader knows.
 *   2. **The consent table comes before the acknowledgement (D6).** A widened
 *      permission set is rendered as before -> after rows, and the
 *      `acknowledgePermissions` flag travels only after that table is on screen
 *      (`installRequestBody` in lib/skill-studio-helpers.ts). When the core
 *      refuses with `permission_change` anyway, the answer is a next step
 *      ("review and confirm"), never a dead end.
 *   3. **States are honest.** Loading, empty, error, "no provider configured to
 *      generate with", "the worker crashed - here are its own log lines": each
 *      one is a rendered state, not a spinner over a dead end.
 *
 * Redaction discipline (repo rule): a draft's code, manifest text, dry-run args
 * and results are the OWNER's own content. They are rendered here for the owner
 * only — never logged, never put in a URL, never embedded in an error string.
 * The worker's log lines are shown because a dry-run with no log is exactly the
 * opaque `crashed` the milestone exists to remove.
 */
import { Fragment, useEffect, useMemo, useState } from 'react';
import type { Persona, SkillDraft, SkillDraftInstallResult, SkillDraftSummary, SkillManifest } from '@partner/shared';
import { listProviders } from './lib/api.js';
import { readyDraftsNeedingAttention } from './lib/attention.js';
import { DRAFT_ORIGIN_LABELS, permissionDiffRows, resolveSelectedDraft, templateOptions, validationSummary, type TemplateOption } from './lib/skill-studio-helpers.js';
import { getDraft, getSkill, listDrafts, listSkillTemplates } from './lib/skills.js';
import { timeAgo } from './lib/persona-helpers.js';
import { readStoredToken } from './lib/token.js';

import { DraftActions } from './studio/DraftActions.js';
import { DraftComposer } from './studio/DraftComposer.js';
import { DraftEditor } from './studio/DraftEditor.js';
import { DraftEmptyState } from './studio/DraftEmptyState.js';
import { DraftRail } from './studio/DraftRail.js';
import { InstallPanel } from './studio/InstallPanel.js';
import { RunPanel } from './studio/RunPanel.js';
import { isSessionLost, summarize, messageOf } from './studio/shared.js';

// ---------------------------------------------------------------------------
// The work area (container: the only place that fetches)
// ---------------------------------------------------------------------------

export interface SkillStudioProps {
  /** Deep-link intent: open this draft (a chat card's "Review in Studio"). */
  focusDraftId?: string | null;
  /** Called once the intent has been applied, so the shell can clear it. */
  onFocusHandled?: () => void;
  /** Personas, for naming the persona behind a chat-authored draft. */
  personas?: Persona[] | null;
  /** Open the conversation a chat-authored draft came from. */
  onOpenConversation?: (conversationId: string) => void;
  /** The core says this session is gone — the shell returns to the gate. */
  onSessionLost: () => void;
  /** True while the Skills view is visible; triggers the first load. */
  active?: boolean;
  /** The view is locked (session lost): every control goes disabled. */
  disabled?: boolean;
  /** Report the ready-draft count up for the Build segment's badge. */
  onReadyCountChange?: (ready: number) => void;
  /** A skill was installed — the shell refreshes its Installed list. */
  onInstalled?: (skillId: string) => void;
  /**
   * Bumped by the shell when another surface created a draft (Installed ->
   * Edit in Studio / Fork). The rail only re-reads on ACTIVATION otherwise, so
   * without this the list would show fewer drafts than the core holds — and a
   * focus intent naming the new one could not be resolved against it.
   */
  reloadToken?: number;
}

/**
 * The Build segment: a rail of drafts and the work area for the selected one.
 *
 * Loading is deliberately split in two: the RAIL needs only summaries (no
 * source), so it loads as soon as the view is visible — that is what lets the
 * segment badge count drafts the user has not opened yet. The selected draft's
 * full source is fetched only when it is actually selected.
 */
export default function SkillStudio({
  focusDraftId,
  onFocusHandled,
  personas,
  onOpenConversation,
  onSessionLost,
  active,
  disabled,
  onReadyCountChange,
  onInstalled,
  reloadToken,
}: SkillStudioProps) {
  const [drafts, setDrafts] = useState<SkillDraftSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [templates, setTemplates] = useState<TemplateOption[] | null>(null);
  const [templatesError, setTemplatesError] = useState<string | null>(null);
  const [providerConfigured, setProviderConfigured] = useState<boolean | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /**
   * A focus intent that has not been satisfied yet.
   *
   * The shell clears its half as soon as the segment switch is applied, and the
   * list this Studio holds reloads asynchronously — so between those two facts
   * there is a window in which the intent names a draft the loaded list does not
   * have. Resolving against that list fell through to `drafts[0]`: the owner
   * asked for the draft Edit/Fork just made and got an unrelated (often
   * read-only) one. Held here until the detail for it is on screen, or until the
   * owner picks a row.
   */
  const [pendingFocusId, setPendingFocusId] = useState<string | null>(null);
  /** Open the create form in the work area (rail's "New draft"). */
  const [composing, setComposing] = useState(false);
  const [detail, setDetail] = useState<SkillDraft | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  /** The installed skill sharing this draft's id — the "before" of a diff. */
  const [installed, setInstalled] = useState<{ manifest: SkillManifest; version: string } | null>(
    null,
  );
  /** Bumped to re-read the detail (manual retry, a fresh activation, or after
   *  an install). */
  const [reloadKey, setReloadKey] = useState(0);
  /**
   * The last install's outcome. It lives HERE rather than in the install panel
   * on purpose: a successful install flips the draft to `installed`, which
   * replaces the panel with the read-only editor in the same tick — a result
   * rendered inside it would never be read.
   */
  const [installNote, setInstallNote] = useState<SkillDraftInstallResult | null>(null);

  const handleSessionLost = (): void => onSessionLost();

  const loadDraftList = async (): Promise<void> => {
    const token = readStoredToken();
    if (!token) {
      handleSessionLost();
      return;
    }
    try {
      setDrafts(await listDrafts(token));
      setLoadError(null);
    } catch (cause) {
      if (isSessionLost(cause)) {
        handleSessionLost();
        return;
      }
      setLoadError(messageOf(cause, 'Could not load your drafts.'));
    }
  };

  const loadTemplates = async (): Promise<void> => {
    const token = readStoredToken();
    if (!token) {
      handleSessionLost();
      return;
    }
    try {
      setTemplates(templateOptions(await listSkillTemplates(token)));
      setTemplatesError(null);
    } catch (cause) {
      if (isSessionLost(cause)) {
        handleSessionLost();
        return;
      }
      // A template list is a convenience; the failure is shown next to the
      // picker rather than replacing the whole screen.
      setTemplates([]);
      setTemplatesError(messageOf(cause, 'Could not load the templates.'));
    }
  };

  /** Is a model provider configured? Only 'generate' needs one. */
  const loadProviderFlag = async (): Promise<void> => {
    const token = readStoredToken();
    if (!token) return;
    try {
      const providers = await listProviders(token);
      setProviderConfigured(providers.some((provider) => provider.enabled));
    } catch {
      // Unknown stays unknown: the empty state then says it is checking rather
      // than claiming there is no provider.
      setProviderConfigured(null);
    }
  };

  useEffect(() => {
    if (!active) return;
    // Re-read on EVERY activation, not once: a draft's state can change from
    // another surface (the persona's install ask approved in the chat, a
    // provider added in Providers), so a once-only load would leave the rail
    // showing "awaiting your approval" for a draft that is already installed.
    // `reloadToken` extends the same rule to a draft CREATED elsewhere while
    // this view is already open (Installed -> Edit in Studio / Fork).
    // It is summaries only - no draft source is fetched here.
    void loadDraftList();
    void loadTemplates();
    void loadProviderFlag();
    setReloadKey((key) => key + 1);
    // Intended: refresh whenever the view becomes visible or a draft was born
    // elsewhere; the loads are stable callbacks over mounted state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, reloadToken]);

  // The deep-link intent wins for the render it arrives in, then the local
  // choice takes over (the shell clears its half as soon as we have it).
  const activeId = resolveSelectedDraft(
    drafts ?? [],
    pendingFocusId ?? focusDraftId,
    selectedId,
  );

  useEffect(() => {
    if (focusDraftId === null || focusDraftId === undefined || focusDraftId === '') return;
    setSelectedId(focusDraftId);
    // Held, not consumed: the list may not contain it yet (see pendingFocusId).
    setPendingFocusId(focusDraftId);
    setComposing(false);
    onFocusHandled?.();
    // Intended: apply each intent once; `focusDraftId` is the signal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusDraftId]);

  useEffect(() => {
    if (activeId === null) {
      setDetail(null);
      setInstalled(null);
      setDetailError(null);
      return;
    }
    const token = readStoredToken();
    if (!token) {
      handleSessionLost();
      return;
    }
    let cancelled = false;
    setDetailLoading(true);
    setDetailError(null);
    void (async () => {
      // The installed skill this draft would UPDATE is keyed by the MANIFEST id,
      // not the draft id: an `edit` draft is stored under `<skill>-edit` while
      // its manifest keeps the installed skill's id (that binding is what makes
      // promote an update rather than another skill).
      let target = activeId;
      try {
        const full = await getDraft(token, activeId);
        if (cancelled) return;
        setDetail(full);
        target = full.manifest?.id ?? full.id;
        // The intent has landed: the local selection now names a draft that
        // exists, so the rail (and the resolver) can own the choice again.
        setPendingFocusId((current) => (current === activeId ? null : current));
      } catch (cause) {
        if (cancelled) return;
        if (isSessionLost(cause)) {
          handleSessionLost();
          return;
        }
        setDetailError(messageOf(cause, 'Could not load that draft.'));
      }
      try {
        // An installed skill with the same id is what this draft would update;
        // its manifest is the before side of the consent table.
        const skill = await getSkill(token, target);
        if (!cancelled) setInstalled({ manifest: skill.manifest, version: skill.version });
      } catch {
        if (!cancelled) setInstalled(null);
      }
      if (!cancelled) setDetailLoading(false);
    })();
    return () => {
      cancelled = true;
    };
    // Intended: reload only for a different draft or an explicit retry; the
    // session-lost handler is a shell callback that is not identity-stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, reloadKey]);

  const ready = useMemo(() => readyDraftsNeedingAttention(drafts ?? []), [drafts]);

  useEffect(() => {
    onReadyCountChange?.(ready);
    // Intended: report the count up whenever it changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  const selectDraft = (id: string): void => {
    setSelectedId(id);
    setPendingFocusId(null);
    setComposing(false);
    setDetailError(null);
    setInstallNote(null);
  };

  /** A create/import returned a draft: show it and put it in the rail. */
  const adoptDraft = (draft: SkillDraft): void => {
    setDrafts((prev) => {
      const others = (prev ?? []).filter((row) => row.id !== draft.id);
      return [summarize(draft), ...others];
    });
    setDetail(draft);
    setSelectedId(draft.id);
    setPendingFocusId(null);
    setComposing(false);
    setLoadError(null);
    setInstallNote(null);
  };

  const handleDraftChanged = (updated: SkillDraft): void => {
    setDetail(updated);
    setDrafts((prev) =>
      (prev ?? []).map((row) => (row.id === updated.id ? summarize(updated) : row)),
    );
  };

  const handleDiscarded = (id: string): void => {
    setDrafts((prev) => (prev ?? []).filter((row) => row.id !== id));
    setDetail(null);
    setSelectedId(null);
    setPendingFocusId(null);
    setComposing(false);
    setInstalled(null);
  };

  const handleInstalled = (result: SkillDraftInstallResult): void => {
    // Re-read the truth (status/installedVersion/validation) rather than
    // patching it locally, then let the shell refresh its Installed list.
    setInstallNote(result);
    setReloadKey((key) => key + 1);
    void loadDraftList();
    onInstalled?.(result.skill.id);
  };

  const personaName =
    detail?.personaId != null
      ? (personas ?? []).find((persona) => persona.id === detail.personaId)?.name ?? null
      : null;

  /** The chat a persona asked from — the deep-link target for the ask. */
  const askConversationId = detail?.conversationId ?? null;
  const shape = detail === null ? null : detail.manifest;
  const diffRows = detail === null ? [] : permissionDiffRows(installed?.manifest ?? null, shape);

  /** Open the create form beside the list it adds to. */
  const startComposing = (): void => {
    setComposing(true);
    setDetailError(null);
    setInstallNote(null);
  };

  return (
    <div className="studio">
      <DraftRail
        drafts={drafts}
        selectedId={activeId}
        onSelect={selectDraft}
        disabled={disabled === true}
        loading={drafts === null && loadError === null}
        loadError={loadError}
        onRetry={() => void loadDraftList()}
        onCompose={startComposing}
      />

      <div className="studio-work">
        {drafts === null && loadError !== null ? null : drafts !== null && drafts.length === 0 ? (
          <DraftEmptyState
            templates={templates}
            templatesError={templatesError}
            providerConfigured={providerConfigured}
            disabled={disabled === true}
            onCreated={adoptDraft}
            onSessionLost={handleSessionLost}
          />
        ) : composing ? (
          /* The same form the empty state mounts: a draft that exists no longer
           * has that door, and discarding the whole rail to get it back was
           * never a flow. */
          <section className="card" aria-label="New draft">
            <div className="section-head">
              <h2 className="card-title">New draft</h2>
            </div>
            <p className="card-copy">
              A draft is inert — nothing it contains runs or installs until you test it and
              install it yourself.
            </p>
            <DraftComposer
              templates={templates}
              templatesError={templatesError}
              providerConfigured={providerConfigured}
              disabled={disabled === true}
              onCreated={adoptDraft}
              onSessionLost={handleSessionLost}
            />
            <div className="studio-actions">
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setComposing(false)}
                disabled={disabled === true}
              >
                Back to the draft
              </button>
            </div>
          </section>
        ) : activeId === null ? (
          <p className="skills-loading" aria-busy="true">
            Loading drafts…
          </p>
        ) : detailLoading && detail === null ? (
          <p className="skills-loading" aria-busy="true">
            Loading that draft…
          </p>
        ) : detailError !== null ? (
          <div className="skills-alert" role="alert">
            <p className="skills-alert-text">{detailError}</p>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => setReloadKey((key) => key + 1)}
              disabled={disabled === true}
            >
              Try again
            </button>
          </div>
        ) : detail !== null ? (
          /* Keyed on the draft id: a panel's local state (run args, a run's
           * result, an armed install, a test outcome) belongs to ONE draft and
           * must not follow the selection to the next one. */
          <Fragment key={detail.id}>
            <header className="studio-head">
              <div className="studio-head-titles">
                <h2 className="studio-title">{detail.name}</h2>
                <p className="studio-subline">
                  <span className="skill-chip skill-chip-neutral">
                    {DRAFT_ORIGIN_LABELS[detail.origin] ?? detail.origin}
                  </span>
                  <span
                    className={
                      detail.validation.ok
                        ? 'studio-state studio-state-ok'
                        : 'studio-state studio-state-error'
                    }
                  >
                    {validationSummary(detail.validation).label}
                  </span>
                  <span className="studio-meta">{detail.manifest?.id ?? detail.id}</span>
                  <span className="studio-meta">updated {timeAgo(detail.updatedAt)}</span>
                  {detail.model !== null ? (
                    <span className="studio-meta">drafted by {detail.model}</span>
                  ) : null}
                </p>
              </div>
            </header>

            {detail.pendingInstallId !== null ? (
              <div className="studio-ask" role="status">
                <p className="studio-ask-text">
                  {personaName === null ? 'A persona' : personaName} asked you to install this
                  draft. Approving happens where the ask was made — in the chat, or in the
                  Files queue. It installs through the same path as the button below.
                </p>
                {askConversationId !== null && onOpenConversation !== undefined ? (
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => onOpenConversation(askConversationId)}
                  >
                    Open the chat
                  </button>
                ) : null}
              </div>
            ) : null}

            <DraftEditor
              draft={detail}
              readOnly={detail.status === 'installed'}
              disabled={disabled === true}
              onDraftChanged={handleDraftChanged}
              onSessionLost={handleSessionLost}
            />

            {installNote !== null ? (
              <p className="form-success" role="status">
                Installed {installNote.skill.name} v{installNote.skill.version} (
                {installNote.mode}). It now appears under Installed — uninstall it there if you
                change your mind.
              </p>
            ) : null}

            {detail.status === 'installed' ? null : (
              <>
                <RunPanel
                  draft={detail}
                  disabled={disabled === true}
                  onSessionLost={handleSessionLost}
                />
                <InstallPanel
                  draft={detail}
                  diffRows={diffRows}
                  installedVersion={installed?.version ?? null}
                  disabled={disabled === true}
                  onInstalled={handleInstalled}
                  onSessionLost={handleSessionLost}
                />
              </>
            )}

            <DraftActions
              draft={detail}
              disabled={disabled === true}
              onDiscarded={handleDiscarded}
              onImported={adoptDraft}
              onSessionLost={handleSessionLost}
            />
          </Fragment>
        ) : null}
      </div>
    </div>
  );
}


// The pieces live in ./studio/* — re-exported here so this module stays the one
// public door into the Studio (importers and the web tests did not have to move).
export { DraftRail } from './studio/DraftRail.js';
export { DraftEmptyState } from './studio/DraftEmptyState.js';
export { DraftComposer } from './studio/DraftComposer.js';
export { DraftEditor } from './studio/DraftEditor.js';
export { ValidationPanel } from './studio/ValidationPanel.js';
export { RunPanel } from './studio/RunPanel.js';
export { InstallPanel } from './studio/InstallPanel.js';
export { InstallConfirm } from './studio/InstallConfirm.js';
export { DraftActions } from './studio/DraftActions.js';
// M28 cut C/D: the Flow tab's panel and the from-code starter live beside the
// editor they belong to, and are re-exported here for the same reason as the
// rest — this module stays the one public door into the Studio.
export { FlowPanel, FlowStarter } from './studio/FlowPanel.js';
