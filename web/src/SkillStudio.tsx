/**
 * M26 Skill Studio (PLAN-M26.md cut D) — the authoring work area.
 *
 * WHY a separate file: the Studio is a whole workflow (describe -> read ->
 * fix -> test-run -> install), and folding it into the 900-line SkillsView would
 * make both harder to reason about. Installed and Catalog stay where they are;
 * this file owns the Build segment.
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

import {
  Fragment,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
} from 'react';
import type {
  Persona,
  SkillDraft,
  SkillDraftInstallResult,
  SkillDraftSummary,
  SkillDraftValidation,
  SkillManifest,
} from '@partner/shared';
import type { ToolId } from '@partner/shared/src/tools.js';
import { ApiRequestError, listProviders } from './lib/api.js';
import { readyDraftsNeedingAttention } from './lib/attention.js';
import { downloadTextFile } from './lib/download.js';
import { formatBytes, permissionSummary, type PermissionChip } from './lib/skill-helpers.js';
import {
  DRAFT_ORIGIN_LABELS,
  dryRunArgs,
  installRequestBody,
  permissionDiffRows,
  resolveSelectedDraft,
  slugPreview,
  templateOptions,
  toolOptions,
  validationSummary,
  warningCount,
  type ConfirmStage,
  type PermissionDiffRow,
  type TemplateOption,
} from './lib/skill-studio-helpers.js';
import {
  createDraft,
  discardDraft,
  exportDraftBundle,
  getDraft,
  getSkill,
  importDraftBundle,
  installDraft,
  listDrafts,
  listSkillTemplates,
  runDraft,
  updateDraft,
  validateDraft,
} from './lib/skills.js';
import { invocationErrorLabel } from './lib/skill-helpers.js';
import { timeAgo } from './lib/persona-helpers.js';
import { readStoredToken } from './lib/token.js';

/** True when an ApiRequestError means the core session is gone. */
function isSessionLost(cause: unknown): boolean {
  return cause instanceof ApiRequestError && (cause.status === 401 || cause.status === 403);
}

/** Pretty render of a dry-run result (the owner's own data, owner-only view). */
function renderResult(result: unknown): string {
  if (typeof result === 'string') return result;
  try {
    return JSON.stringify(result, null, 2);
  } catch {
    return String(result);
  }
}

/** The summary half of a full draft (the rail never needs the source). */
function summarize(draft: SkillDraft): SkillDraftSummary {
  return {
    id: draft.id,
    name: draft.name,
    description: draft.description,
    status: draft.status,
    origin: draft.origin,
    manifest: draft.manifest,
    validation: draft.validation,
    model: draft.model,
    conversationId: draft.conversationId,
    personaId: draft.personaId,
    pendingInstallId: draft.pendingInstallId,
    createdAt: draft.createdAt,
    updatedAt: draft.updatedAt,
  };
}

function messageOf(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message !== '' ? cause.message : fallback;
}

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
}: SkillStudioProps) {
  const [drafts, setDrafts] = useState<SkillDraftSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [templates, setTemplates] = useState<TemplateOption[] | null>(null);
  const [templatesError, setTemplatesError] = useState<string | null>(null);
  const [providerConfigured, setProviderConfigured] = useState<boolean | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
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
    // It is summaries only - no draft source is fetched here.
    void loadDraftList();
    void loadTemplates();
    void loadProviderFlag();
    setReloadKey((key) => key + 1);
    // Intended: refresh whenever the view becomes visible; the loads are stable
    // callbacks over mounted state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  // The deep-link intent wins for the render it arrives in, then the local
  // choice takes over (the shell clears its half as soon as we have it).
  const activeId = resolveSelectedDraft(drafts ?? [], focusDraftId, selectedId);

  useEffect(() => {
    if (focusDraftId === null || focusDraftId === undefined || focusDraftId === '') return;
    setSelectedId(focusDraftId);
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
}: DraftRailProps) {
  return (
    <nav className="studio-rail" aria-label="Drafts">
      <h2 className="studio-rail-title">Drafts</h2>
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

type CreateMode = 'generate' | 'template' | 'manual';

/**
 * The first-run surface: describe the skill you want, start from a template the
 * core can actually honour, or open a blank draft. Generation is the only path
 * that needs a provider, so it is the only one that changes shape when none is
 * configured — the other two work with no credentials at all.
 */
export function DraftEmptyState({
  templates,
  templatesError,
  providerConfigured,
  disabled,
  onCreated,
  onSessionLost,
}: DraftEmptyStateProps) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [template, setTemplate] = useState('');
  const [busy, setBusy] = useState<CreateMode | null>(null);
  const [error, setError] = useState<string | null>(null);

  const options = templates ?? [];
  const selectedTemplate = options.find((option) => option.id === template) ?? null;
  const slug = slugPreview(name);
  const canDescribe = name.trim() !== '' && description.trim() !== '';
  const generating = providerConfigured === true;

  const start = async (mode: CreateMode): Promise<void> => {
    if (busy !== null || disabled) return;
    const token = readStoredToken();
    if (!token) {
      onSessionLost();
      return;
    }
    setBusy(mode);
    setError(null);
    try {
      const draft = await createDraft(token, {
        mode,
        name: name.trim(),
        description: description.trim(),
        ...(mode === 'generate' ? { prompt: description.trim() } : {}),
        ...(mode === 'template' ? { template } : {}),
        ...(slug !== '' ? { id: slug } : {}),
      });
      onCreated(draft);
      setName('');
      setDescription('');
      setTemplate('');
    } catch (cause) {
      if (isSessionLost(cause)) {
        onSessionLost();
        return;
      }
      setError(messageOf(cause, 'Could not create the draft.'));
    } finally {
      setBusy(null);
    }
  };

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

      <div className="studio-form">
        <div className="form-stack">
          <div className="form-field">
            <label className="label" htmlFor="studio-new-name">
              Name
            </label>
            <input
              id="studio-new-name"
              className="field"
              type="text"
              value={name}
              onChange={(event) => setName(event.target.value)}
              disabled={disabled || busy !== null}
              placeholder="Scratch notes to checklist"
              aria-describedby="studio-new-id"
            />
            <p id="studio-new-id" className="form-hint">
              {slug === ''
                ? 'The core turns the name into a lowercase id once you start the draft.'
                : `The core will id it “${slug}” (and make it unique if that id is taken).`}
            </p>
          </div>

          <div className="form-field">
            <label className="label" htmlFor="studio-new-description">
              Describe the skill you want
            </label>
            <textarea
              id="studio-new-description"
              className="field studio-describe"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              disabled={disabled || busy !== null}
              placeholder="Turn a folder of scratch notes into a single markdown checklist."
            />
          </div>
        </div>

        <div className="empty-actions">
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void start('generate')}
            disabled={disabled || busy !== null || !canDescribe || !generating}
            aria-busy={busy === 'generate'}
          >
            {busy === 'generate' ? 'Drafting…' : 'Generate draft'}
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => void start('manual')}
            disabled={disabled || busy !== null || name.trim() === ''}
            aria-busy={busy === 'manual'}
          >
            {busy === 'manual' ? 'Creating…' : 'Start blank'}
          </button>
        </div>

        {providerConfigured === null ? (
          <p className="form-hint">Checking whether a model provider is configured…</p>
        ) : generating ? null : (
          <p className="form-hint">
            Connect a provider to generate, or start from a template below — the template path
            needs no model at all.
          </p>
        )}
      </div>

      <div className="studio-templates">
        <h3 className="sub-panel-title">Templates</h3>
        {templatesError !== null ? (
          <p className="row-error" role="alert">
            {templatesError}
          </p>
        ) : templates === null ? (
          <p className="skills-loading" aria-busy="true">
            Loading templates…
          </p>
        ) : options.length === 0 ? (
          <p className="studio-note">
            This build offers no templates. Describe the skill and start blank instead.
          </p>
        ) : (
          <>
            <ul className="studio-template-list">
              {options.map((option) => (
                <li key={option.id} className="studio-template">
                  <span className="studio-template-name">{option.label}</span>
                  <span className="studio-template-copy">{option.description}</span>
                  {option.reach !== '' ? (
                    <span className="studio-template-reach">{option.reach}</span>
                  ) : null}
                </li>
              ))}
            </ul>
            <div className="form-field">
              <label className="label" htmlFor="studio-new-template">
                Template
              </label>
              <select
                id="studio-new-template"
                className="field"
                value={template}
                onChange={(event) => setTemplate(event.target.value)}
                disabled={disabled || busy !== null}
              >
                <option value="">Choose a template</option>
                {options.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
              {selectedTemplate !== null && selectedTemplate.reach !== '' ? (
                <p className="form-hint">{selectedTemplate.reach}</p>
              ) : null}
            </div>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => void start('template')}
              disabled={disabled || busy !== null || template === '' || name.trim() === ''}
              aria-busy={busy === 'template'}
            >
              {busy === 'template' ? 'Creating…' : 'Create from template'}
            </button>
          </>
        )}
      </div>

      {error !== null ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Editor — manifest fields + the entry source
// ---------------------------------------------------------------------------

export interface DraftEditorProps {
  draft: SkillDraft;
  /** An installed draft is history: the core refuses writes, so the UI does too. */
  readOnly: boolean;
  disabled: boolean;
  onDraftChanged: (draft: SkillDraft) => void;
  onSessionLost: () => void;
}

type EditorTab = 'code' | 'validation';
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
  const [tab, setTab] = useState<EditorTab>('code');
  const [name, setName] = useState(draft.name);
  const [description, setDescription] = useState(draft.description);
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
    setDescription(draft.description);
    setVersion(draft.manifest?.version ?? '');
    setTools(draft.manifest?.permissions.tools ?? []);
    setRisk(draft.manifest?.permissions.risk ?? 'low');
    setBudgetMs(String(draft.manifest?.budget.timeMs ?? 30_000));
    setCode(draft.code);
    setManifestText(draft.manifestText);
    setStage('idle');
    setError(null);
  }, [draft]);

  const manifest = draft.manifest;
  const options = useMemo(() => toolOptions(manifest?.permissions.tools ?? []), [manifest]);
  const bytes = useMemo(() => new TextEncoder().encode(code).length, [code]);
  const budgetValue = Number.parseInt(budgetMs, 10);
  const budgetOk = Number.isFinite(budgetValue) && budgetValue > 0;
  const dirty =
    name !== draft.name ||
    description !== draft.description ||
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

        <div className="seg-tabs" role="group" aria-label="Entry source or validation">
          <button
            type="button"
            className="btn btn-secondary seg-tab"
            aria-pressed={tab === 'code'}
            onClick={() => setTab('code')}
            disabled={disabled}
          >
            Code
          </button>
          <button
            type="button"
            className="btn btn-secondary seg-tab"
            aria-pressed={tab === 'validation'}
            onClick={() => setTab('validation')}
            disabled={disabled}
          >
            Validation
          </button>
        </div>

        <div className="form-field">
          {tab === 'code' ? (
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
            </>
          ) : (
            <ValidationPanel
              validation={draft.validation}
              busy={busy}
              disabled={disabled || readOnly}
              onRevalidate={() => void revalidate()}
            />
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

// ---------------------------------------------------------------------------
// Discard / export / import
// ---------------------------------------------------------------------------

export interface DraftActionsProps {
  draft: SkillDraft;
  disabled: boolean;
  onDiscarded: (id: string) => void;
  onImported: (draft: SkillDraft) => void;
  onSessionLost: () => void;
}

/**
 * The three bundle-level acts: export (a download the owner keeps), import (a
 * bundle lands as a NEW inert draft) and discard (the draft row leaves this
 * core). Discard keeps the existing two-step arming pattern because it destroys
 * content the owner may not have exported yet — and it deliberately says what it
 * does NOT do (uninstall the skill).
 */
export function DraftActions({
  draft,
  disabled,
  onDiscarded,
  onImported,
  onSessionLost,
}: DraftActionsProps) {
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState<'discard' | 'export' | 'import' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const exportBundle = async (): Promise<void> => {
    if (busy !== null || disabled) return;
    const token = readStoredToken();
    if (!token) {
      onSessionLost();
      return;
    }
    setBusy('export');
    setError(null);
    setNote(null);
    try {
      const bundle = await exportDraftBundle(token, draft.id);
      const filename = `${draft.id}-skill-bundle.json`;
      await downloadTextFile(filename, JSON.stringify(bundle, null, 2), 'application/json');
      setNote(
        `Saved ${filename} — an unsigned bundle. Importing it lands as a draft; it installs nothing.`,
      );
    } catch (cause) {
      if (isSessionLost(cause)) {
        onSessionLost();
        return;
      }
      setError(messageOf(cause, 'Could not export the draft.'));
    } finally {
      setBusy(null);
    }
  };

  const importFile = async (file: File | undefined): Promise<void> => {
    if (file === undefined || busy !== null || disabled) return;
    const token = readStoredToken();
    if (!token) {
      onSessionLost();
      return;
    }
    setBusy('import');
    setError(null);
    setNote(null);
    try {
      const text = await file.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text) as unknown;
      } catch {
        setError('That file is not JSON — a bundle is the JSON this Studio exported.');
        return;
      }
      const imported = await importDraftBundle(token, parsed);
      onImported(imported);
      setNote(
        `Imported “${imported.name}” as a draft. Imported skills are drafts — nothing runs until you test and install them.`,
      );
    } catch (cause) {
      if (isSessionLost(cause)) {
        onSessionLost();
        return;
      }
      setError(messageOf(cause, 'Could not import that bundle.'));
    } finally {
      setBusy(null);
    }
  };

  const discard = async (): Promise<void> => {
    if (busy !== null || disabled) return;
    const token = readStoredToken();
    if (!token) {
      onSessionLost();
      return;
    }
    setBusy('discard');
    setError(null);
    try {
      await discardDraft(token, draft.id);
      onDiscarded(draft.id);
    } catch (cause) {
      if (isSessionLost(cause)) {
        onSessionLost();
        return;
      }
      setError(messageOf(cause, 'Could not discard the draft.'));
      setArmed(false);
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="card" aria-label="Bundle">
      <h2 className="card-title">Bundle</h2>
      <p className="card-copy">
        Move this draft as a file. Export writes an unsigned bundle; the import below always lands
        as a new draft in this core.
      </p>

      <div className="studio-actions">
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => void exportBundle()}
          disabled={disabled || busy !== null}
          aria-busy={busy === 'export'}
        >
          {busy === 'export' ? 'Exporting…' : 'Export bundle'}
        </button>
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => fileRef.current?.click()}
          disabled={disabled || busy !== null}
          aria-busy={busy === 'import'}
        >
          {busy === 'import' ? 'Importing…' : 'Import bundle'}
        </button>
        {/* A visually hidden file input, the Memory-import pattern: it is
          * triggered only by the Import button, so it stays out of the tab order
          * (tabIndex -1 + aria-hidden) rather than becoming an invisible stop. */}
        <input
          ref={fileRef}
          className="sr-only"
          type="file"
          accept=".json,application/json"
          tabIndex={-1}
          aria-hidden="true"
          onChange={(event: ChangeEvent<HTMLInputElement>) => {
            void importFile(event.target.files?.[0]).then(() => {
              event.target.value = '';
            });
          }}
        />
        {armed ? (
          <>
            <button
              type="button"
              className="btn btn-secondary btn-danger"
              onClick={() => void discard()}
              disabled={disabled || busy !== null}
              aria-busy={busy === 'discard'}
            >
              {busy === 'discard' ? 'Discarding…' : 'Discard now'}
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => setArmed(false)}
              disabled={disabled || busy !== null}
            >
              Cancel
            </button>
          </>
        ) : (
          <button
            type="button"
            className="btn btn-secondary btn-danger"
            onClick={() => {
              setNote(null);
              setArmed(true);
            }}
            disabled={disabled || busy !== null}
          >
            Discard draft
          </button>
        )}
      </div>

      {armed ? (
        <p className="skill-uninstall-warn" role="alert">
          Discarding deletes this draft and its code from this core. An installed skill stays
          installed — uninstall it from Installed if that is what you meant. Press Discard now to
          confirm.
        </p>
      ) : null}

      <p className="form-hint">
        Imported skills are drafts — nothing runs until you test and install them.
      </p>

      {note !== null ? (
        <p className="form-success" role="status">
          {note}
        </p>
      ) : null}
      {error !== null ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
