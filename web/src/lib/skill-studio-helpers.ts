/**
 * M26 Skill Studio helpers (PLAN-M26.md cut D) — DOM-free logic for the
 * authoring surface.
 *
 * Why this file exists: the Studio's job is to make an INERT draft reviewable,
 * and three of its rules are load-bearing enough that they must not live inside
 * JSX where a later edit can quietly change them:
 *
 *   1. **The consent table (D6).** An install that WIDENS a permission set may
 *      only carry `acknowledgePermissions` after the owner has seen the
 *      before -> after table. `installRequestBody` is the single place that
 *      flag is decided, and it answers `null` while the confirmation has not
 *      been shown, so no component can send it early.
 *   2. **The slug the owner will actually get.** The core allocates and
 *      de-duplicates the id; this only PREVIEWS the same slug rules, so the
 *      Studio can show "your skill will be called x" without pretending to
 *      own the allocation.
 *   3. **The tool vocabulary.** The core publishes no broker-registry route
 *      (`GET /v1/tools` does not exist), so the picker is fed by the shared
 *      `ToolId` union — the same vocabulary `core/src/broker/toolManifests.ts`
 *      implements — plus whatever a draft already declares (so an id this
 *      build cannot run stays VISIBLE and gets named by the core's validator,
 *      rather than being silently dropped in the UI). The core's deterministic
 *      validation remains the authority.
 *
 * Redaction discipline (unchanged from M0-M8): a draft's manifest text and code
 * are the owner's own content. These helpers derive labels, chips and rows from
 * SHAPE and declared ids only — never from code text — and embed no content in
 * an error string.
 */

import type {
  PermissionDiffEntry,
  SkillDraftOrigin,
  SkillDraftValidation,
  SkillManifest,
} from '@partner/shared';
import { TOOL_LABELS } from './roots.js';
import { APP_TOOL_IDS } from './roots.js';
import { validateArgsJson, type ArgsValidation } from './skill-helpers.js';
import type { SkillTemplateSummary } from './skills.js';

// ---------------------------------------------------------------------------
// Identity: the slug the core will allocate
// ---------------------------------------------------------------------------

/**
 * The core's id rule (`ID_RE` in `core/src/skills/manifest.ts`). Kept as a
 * local mirror ON PURPOSE: importing core into the web bundle is not allowed,
 * and a preview that disagrees with the allocator would be worse than none.
 */
const SKILL_ID_RE = /^[a-z0-9][a-z0-9._-]*$/;

/**
 * Preview of the slug a name produces, or '' when nothing usable remains.
 * Mirrors `slugifySkillId` in `core/src/skills/drafts.ts` (lowercase, runs of
 * anything else become '-', leading/trailing separators go, 48-char cap).
 * The core still de-duplicates, which is why the Studio labels this a preview.
 */
export function slugPreview(raw: string): string {
  const slug = String(raw ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-._]+/, '')
    .replace(/[-._]+$/, '')
    .slice(0, 48);
  return SKILL_ID_RE.test(slug) ? slug : '';
}

/** How a draft got here, in the owner's words (never a raw enum on screen). */
export const DRAFT_ORIGIN_LABELS: Record<SkillDraftOrigin, string> = {
  generated: 'Generated',
  template: 'Template',
  manual: 'Manual',
  chat: 'From chat',
  fork: 'Fork',
  edit: 'Edit',
  import: 'Imported',
  // M28: born as a flow (a generated graph, or a chat call carrying one).
  flow: 'From a flow',
};

/** Chip label for an origin; an unknown value is named, never invented. */
export function draftOriginLabel(origin: string): string {
  return DRAFT_ORIGIN_LABELS[origin as SkillDraftOrigin] ?? origin;
}

// ---------------------------------------------------------------------------
// Validation summary (the left rail's state line)
// ---------------------------------------------------------------------------

export interface ValidationSummary {
  ok: boolean;
  /** "ok" / "1 problem" / "3 problems" — the rail's one-line state. */
  label: string;
}

/**
 * The rail's validation line. Deliberately not "valid" / "invalid": the owner
 * needs the COUNT, because the Studio's whole loop is fixing a named number.
 * A record that is not ok with no errors is "not validated" rather than
 * "0 problems", which would read like a pass.
 */
export function validationSummary(validation: SkillDraftValidation): ValidationSummary {
  const errors = Array.isArray(validation.errors) ? validation.errors.length : 0;
  if (validation.ok) return { ok: true, label: 'ok' };
  if (errors === 0) return { ok: false, label: 'not validated' };
  return { ok: false, label: errors === 1 ? '1 problem' : `${errors} problems` };
}

/** Warnings are shown as plain language; this is the count for the panel head. */
export function warningCount(validation: SkillDraftValidation): number {
  return Array.isArray(validation.warnings) ? validation.warnings.length : 0;
}

// ---------------------------------------------------------------------------
// The tool picker's vocabulary
// ---------------------------------------------------------------------------

export interface StudioToolOption {
  id: string;
  label: string;
}

/**
 * Options for the manifest's tools multi-select: the registry vocabulary first
 * (the shared `ToolId` union, in registry order), then any id the draft already
 * declares that is not in it. Keeping the declared extras is the honest choice:
 * an unknown id is exactly what the owner needs to SEE to remove it.
 */
export function toolOptions(declared: readonly string[] = []): StudioToolOption[] {
  const ids = Object.keys(TOOL_LABELS);
  for (const tool of declared) {
    if (typeof tool === 'string' && tool !== '' && !ids.includes(tool)) ids.push(tool);
  }
  return ids.map((id) => ({ id, label: TOOL_LABELS[id as keyof typeof TOOL_LABELS] ?? id }));
}

// ---------------------------------------------------------------------------
// M27 S1 — the actionable line under a `tool_denied` dry-run
// ---------------------------------------------------------------------------

/**
 * A dry-run executes the REAL sandbox, so a validated draft that reaches an
 * ungranted tool fails exactly as an installed skill would — skills are
 * non-interactive, so there is no approval prompt to wait for.
 *
 * "A tool request was denied" is true but useless to someone authoring: the fix
 * is a grant, and WHERE the grant lives depends on the tool's SCOPE. File tools
 * need a registered root; app-scoped note tools need the App data group and no
 * root at all. This names the right place, and for the pure app-scope case it
 * names the group exactly.
 *
 * Only meaningful for a draft whose validation passed: a declared-but-unknown
 * tool or a risk-ceiling refusal is already named by the validator, so those
 * cannot be the cause here.
 */
export function toolDeniedHint(declaredTools: readonly string[]): string {
  const appTools = declaredTools.filter((id) => (APP_TOOL_IDS as readonly string[]).includes(id));
  if (appTools.length === 0) {
    return 'Nothing is granted yet, so the tool call was refused. Register a root under Files \u2192 Project roots, grant the tool there, then run again.';
  }
  if (appTools.length === declaredTools.length) {
    return `Your notes are not granted yet, so nothing can read them. Allow ${appTools.join(', ')} under Files \u2192 App data, then run again.`;
  }
  return 'A tool call was refused. Allow the note tools under Files \u2192 App data, and grant the file tools for a registered root, then run again.';
}

// ---------------------------------------------------------------------------
// Template picker options
// ---------------------------------------------------------------------------

export interface TemplateOption {
  id: string;
  label: string;
  description: string;
  /** Plain-language reach line — shown under the option, not as a title. */
  reach: string;
}

/**
 * Shape the template list the core reports. An entry without an id cannot be
 * requested (the core refuses an unknown template by name), so it is dropped
 * rather than rendered as an option that would fail; a missing name falls back
 * to the id so the picker never shows a blank row.
 */
export function templateOptions(templates: readonly SkillTemplateSummary[]): TemplateOption[] {
  const options: TemplateOption[] = [];
  for (const template of templates) {
    if (typeof template?.id !== 'string' || template.id === '') continue;
    options.push({
      id: template.id,
      label: typeof template.name === 'string' && template.name !== '' ? template.name : template.id,
      description: typeof template.description === 'string' ? template.description : '',
      reach: typeof template.reach === 'string' ? template.reach : '',
    });
  }
  return options;
}

// ---------------------------------------------------------------------------
// The install consent table (M26 D6)
// ---------------------------------------------------------------------------

/** Plain-language name for each permission field a diff row can carry. */
export const PERMISSION_FIELD_LABELS: Record<PermissionDiffEntry['field'], string> = {
  tools: 'Tools',
  mcpServers: 'MCP servers',
  risk: 'Risk',
  network: 'Network',
  llm: 'Model reach',
  'budget.timeMs': 'Time budget (ms)',
  'budget.maxTokens': 'Token budget',
};

export interface PermissionDiffRow {
  /** Field id (stable React key + the wire value). */
  field: PermissionDiffEntry['field'];
  label: string;
  before: string;
  after: string;
}

const RISK_RANK: Record<string, number> = { low: 0, medium: 1, high: 2 };

/**
 * The before -> after rows of an install that changes what a skill may do.
 *
 * This mirrors `permissionDiff` in `core/src/skills/drafts.ts` — the same
 * fields, and the same rule that ONLY a WIDENING is a consent event (narrowing
 * a skill must not nag). The mirror exists because the core reports its diff on
 * the install RESPONSE, and the owner has to see the table before that request
 * is sent; the core stays the authority, which is why the Studio also handles
 * its `permission_change` refusal as a step ("review and confirm") rather than
 * as a dead end. A widened field missing from this list would show an
 * incomplete table; it cannot grant anything, because the core refuses the
 * request until the ack arrives.
 */
export function permissionDiffRows(
  before: SkillManifest | null,
  after: SkillManifest | null,
): PermissionDiffRow[] {
  if (before === null || after === null) return [];
  const rows: PermissionDiffRow[] = [];
  const setRow = (
    field: 'tools' | 'mcpServers',
    from: readonly string[],
    to: readonly string[],
  ): void => {
    const added = to.filter((value) => !from.includes(value));
    if (added.length === 0) return;
    rows.push({
      field,
      label: PERMISSION_FIELD_LABELS[field],
      before: from.join(', ') || '—',
      after: to.join(', ') || '—',
    });
  };
  setRow('tools', before.permissions.tools, after.permissions.tools);
  setRow('mcpServers', before.permissions.mcpServers ?? [], after.permissions.mcpServers ?? []);

  if ((RISK_RANK[after.permissions.risk] ?? 0) > (RISK_RANK[before.permissions.risk] ?? 0)) {
    rows.push({
      field: 'risk',
      label: PERMISSION_FIELD_LABELS.risk,
      before: before.permissions.risk,
      after: after.permissions.risk,
    });
  }
  if (after.permissions.network && !before.permissions.network) {
    rows.push({
      field: 'network',
      label: PERMISSION_FIELD_LABELS.network,
      before: 'false',
      after: 'true',
    });
  }
  if (after.permissions.llm === true && before.permissions.llm !== true) {
    rows.push({ field: 'llm', label: PERMISSION_FIELD_LABELS.llm, before: 'false', after: 'true' });
  }
  const beforeTime = before.budget?.timeMs ?? 0;
  const afterTime = after.budget?.timeMs ?? 0;
  if (afterTime > beforeTime) {
    rows.push({
      field: 'budget.timeMs',
      label: PERMISSION_FIELD_LABELS['budget.timeMs'],
      before: String(beforeTime),
      after: String(afterTime),
    });
  }
  const beforeTokens = before.budget?.maxTokens ?? 0;
  const afterTokens = after.budget?.maxTokens ?? 0;
  if (afterTokens > beforeTokens) {
    rows.push({
      field: 'budget.maxTokens',
      label: PERMISSION_FIELD_LABELS['budget.maxTokens'],
      before: String(beforeTokens),
      after: String(afterTokens),
    });
  }
  return rows;
}

/**
 * Where a two-step control stands. `confirm` is the ONLY stage that may send a
 * destructive or privileged request at all, which is what makes "install" and
 * "save" deliberate acts with a reviewable summary in front of them.
 */
export type ConfirmStage = 'idle' | 'confirm';

/**
 * The promote request body, or `null` while the confirmation has not been
 * shown. `acknowledgePermissions` travels ONLY when the table it refers to has
 * rows — an ack with nothing to acknowledge is a claim the owner never saw.
 *
 * `coreDemanded` covers the one case this screen cannot compute on its own: the
 * core refused with `permission_change`, so IT found a widening (its check is
 * the authority). The owner has the summary and the core's own sentence naming
 * the changed fields on screen, so the confirmed retry acknowledges.
 */
export function installRequestBody(
  stage: ConfirmStage,
  rows: readonly PermissionDiffRow[],
  options: { coreDemanded?: boolean } = {},
): Record<string, unknown> | null {
  if (stage !== 'confirm') return null;
  if (rows.length > 0 || options.coreDemanded === true) return { acknowledgePermissions: true };
  return {};
}

// ---------------------------------------------------------------------------
// Dry-run args (the same 64 KiB guard as an invocation, named for this field)
// ---------------------------------------------------------------------------

/**
 * Guard the dry-run args field. A draft's args are capped by the same core
 * constant as an invocation's, so this delegates to `validateArgsJson` instead
 * of carrying a second cap that could drift from it.
 */
export function dryRunArgs(text: string): ArgsValidation {
  return validateArgsJson(text);
}

// ---------------------------------------------------------------------------
// Selection: the deep-link intent
// ---------------------------------------------------------------------------

/**
 * Which draft the work area shows.
 *
 * Two rules, both easy to get wrong:
 *
 *   1. A deep-link intent WINS. A chat card's "Review in Studio" must land on
 *      the draft it names even if the rail had already selected another one —
 *      and even before the list has loaded, because the intent arrives with the
 *      view switch.
 *   2. Once the intent is cleared, the local choice sticks only while it is
 *      still in the list (a discarded draft must not leave the editor pointing
 *      at nothing); otherwise the newest draft is shown, and an empty list
 *      selects nothing.
 */
export function resolveSelectedDraft(
  drafts: readonly { id: string }[],
  focusDraftId: string | null | undefined,
  selectedId: string | null,
): string | null {
  if (typeof focusDraftId === 'string' && focusDraftId !== '') return focusDraftId;
  if (selectedId !== null && drafts.some((draft) => draft.id === selectedId)) return selectedId;
  return drafts[0]?.id ?? null;
}

/**
 * The description the editor's Description field shows and owns.
 *
 * The wire carries TWO descriptions with one name: the draft's own (`description`
 * — the skill's short description, and what the Studio's field shows) and the
 * manifest's. A template or blank draft is created with the row's empty while its
 * manifest carries a real one, so an editor that seeded the field from the row
 * showed nothing over a real value — and then wrote that nothing back into the
 * manifest on the first save, leaving a draft nobody had edited failing
 * `description is required`. The CORE now settles that at birth
 * (`rowDescriptionOf()` in `core/src/skills/drafts.ts`); this is the other half:
 * the MANIFEST is the field's source of truth.
 *
 * The row's description is the fallback, and only for a manifest that does not
 * parse: there the raw JSON above the field is what has to be fixed, and the
 * closest thing to a description the draft still has is the row's.
 */
export function draftDescription(draft: {
  description: string;
  manifest: { description: string } | null;
}): string {
  return draft.manifest === null ? draft.description : draft.manifest.description;
}
