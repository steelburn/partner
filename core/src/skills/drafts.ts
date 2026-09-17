/**
 * Skill draft manager (M26 cut A, PLAN-M26.md).
 *
 * A draft is an INERT, editable bundle: manifest text + entry source + the
 * deterministic result of validating them. This module owns the whole lifecycle
 * and, deliberately, the only path from a draft to runnable code:
 *
 *   create    manual / template (generate lands in cut B via the `generate` hook)
 *   update    edit manifest text or code — refused once installed
 *   validate  deterministic: shape + registry + entry lint. NEVER executes.
 *   runDraft  M26 D5 dry-run: materialize into a core-owned scratch dir and
 *             invoke the REAL sandbox with sha256 '' (no install-time hash to
 *             check), a collected log sink and record:false (no invocation
 *             row). The owner asks for it; nothing else can start a run.
 *   bundle    M26 D12 export/import of an unsigned bundle. Export is plain
 *             JSON out; import ALWAYS lands as a new INERT draft (never an
 *             install, and the manifest is re-pointed at the new slug).
 *   fork      copy an INSTALLED skill into a fresh draft (edit a copy)
 *   promote   validate -> consent diff -> install (create or update)
 *   discard   hard delete; a draft is not history (the audit row is)
 *
 *   stageFromChat  M26 cut C: the bundle `skills.draft` writes from a chat turn
 *   requestInstall M26 D2b: a persona ASKING for an install. It writes a
 *                  `pending_tools` row of kind 'skill_install' and installs
 *                  nothing — the owner's Approve inside the chat card is what
 *                  calls `promote`, so both surfaces run one implementation.
 *
 *   getFlow    M28 cut B: the graph a flow-backed draft is authored as, plus the
 *   saveFlow   DERIVED `flowStale` (D6 — a hash comparison, never a flag). A
 *              save replaces the document and touches nothing else: a save is
 *              not a compile.
 *   compileFlow M28 cut B D1/D5: the ONLY writer of `code` from a flow. It runs
 *              the (pure, total, deterministic) slice-A compiler, writes the
 *              emitted bytes plus `flow_sha256`/`flow_compiled_at`, and REWRITES
 *              the manifest's derived permissions from the graph — both `tools`
 *              and `llm` — before re-running the M26 validation. Install still
 *              consumes `code`, so a stale flow is a UI-honesty state and never
 *              a precondition.
 *
 * The security property this file exists to hold: **drafting never executes and
 * never installs.** `promote` is the only mutating bridge to the skills store,
 * it is called by an owner-initiated route (the Studio button) or by an
 * owner-approved queue row, and it re-validates first. The single exception is
 * `runDraft` - a dry-run DOES spawn a worker, which is exactly why it is an
 * explicit owner action, materializes into a core-owned scratch dir the route
 * (never the caller) builds, and keeps no history.
 *
 * Audit discipline (repo rule): ids/counts/lengths/booleans only. Draft code,
 * manifest text, the generation prompt and the description are the owner's own
 * content — they cross the loopback to the owner's UI and never reach audit.
 */
import type {
  FlowValidationError,
  PermissionDiffEntry,
  SkillBundle,
  SkillDetail,
  SkillDraft,
  SkillDraftCreateInput,
  SkillDraftInstallResult,
  SkillDraftRun,
  SkillDraftSummary,
  SkillDraftValidation,
  SkillFlow,
  SkillFlowCompileResponse,
  SkillFlowExplainResponse,
  SkillFlowProposal,
  SkillFlowProposalResponse,
  SkillFlowSaveResult,
  SkillFlowState,
  SkillManifest,
  SkillSummary,
} from '@partner/shared';
import type { PendingToolCall, ToolRisk } from '@partner/shared/tools.js';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AuditService } from '../services/redaction.js';
import type { SkillDraftRow, SkillDraftRowPatch, SkillDraftStore } from '../stores/types.js';
import { skillError } from './errors.js';
// M28 slice B: the compiler is slice A's, imported under a distinct name so the
// manager method can keep the spec's word (`compileFlow`). Nothing here
// re-implements emission — it decides WHAT to write.
import { compileFlow as compileSkillFlow, sha256Of } from './flow/compile.js';
import type { FlowCompileOptions } from './flow/compile.js';
import { diffFlows } from './flow/refine.js';
import { validateFlow } from './flow/schema.js';
import type { FlowAiHook } from './flow/ai.js';
import {
  DEFAULT_TIME_MS,
  ID_RE,
  MAX_SKILL_TIME_MS,
  lintEntry,
  validateManifestShape,
} from './manifest.js';
import type { RuntimeCapabilities } from './manifest.js';
import { DEFAULT_RUNTIME_CAPABILITIES } from './manifest.js';
import { permissionSummary, unknownTools } from './runtime.js';
import type { SkillRunner } from './runner.js';
import { availableTemplates, findTemplate } from './templates.js';

/** The subset of the skill manager a draft needs (structural — easy to fake). */
export interface DraftSkillStore {
  /** Installed detail for the consent diff + fork source; null when absent. */
  get(id: string): { manifest: SkillManifest; version: string } | null;
  /** Read the installed entry source (fork). Throws when unreadable. */
  readEntrySource(id: string): string;
  /** Write a validated bundle into the store + record the row (D1's one door). */
  installFromBundle(
    bundle: { manifest: SkillManifest; code: string },
    options: { update: boolean; source: 'authored' },
  ): SkillSummary;
}

export interface GenerateInput {
  description: string;
  name: string;
  id: string;
  toolIds: readonly string[];
}

export interface GeneratedBundle {
  manifestText: string;
  code: string;
  /** Which model drafted it ('demo' in demo mode); never a key/endpoint. */
  model: string;
}

/**
 * The one-shot generation hook (M26 cut B): drafts text in, drafts text out.
 * Absent = `mode:'generate'` is refused by name, which is what a build with no
 * provider configured does.
 */
export type SkillGenerateHook = (input: GenerateInput) => Promise<GeneratedBundle>;

/**
 * The subset of the approval queue a draft needs (M26 D2b, structural).
 *
 * An install ask is an APPROVAL, not an action: the row it writes can only be
 * closed by `settleInstall` (never by `broker.decide`, which executes broker
 * tools) and the single install implementation stays `promote`.
 */
export interface DraftInstallQueue {
  enqueue(input: {
    toolId: string;
    projectId: string;
    params: Record<string, unknown>;
    risk: ToolRisk;
    requestedBy: 'persona';
    conversationId?: string | null;
    personaId?: string | null;
    kind?: 'skill_install';
    draftId?: string | null;
  }): string;
  /** Open rows only (oldest first) - how a draft finds its own open ask. */
  list(): PendingToolCall[];
  /** Close an install row once its own executor decided it. */
  settleInstall(id: string, decision: 'approve' | 'deny', by: string): unknown;
}

export interface SkillDraftManagerOptions {
  store: SkillDraftStore;
  skills: DraftSkillStore;
  /** Broker tool registry — a declared tool outside it is a named error. */
  tools: ReadonlySet<string>;
  /**
   * M28 slice B (D5): the broker risk of a registered tool, so `compileFlow`
   * can refuse a graph whose `tool` node outranks the draft manifest's own
   * ceiling (`tool_requires_medium`) BEFORE it writes code or permissions.
   *
   * Required rather than optional on purpose: without it the compiler's ceiling
   * check silently does nothing, and a flow installs a bundle that can never run
   * — the same "compiles but is guaranteed to refuse" class `llm_not_available`
   * exists to prevent.
   */
  riskOf: (toolId: string) => ToolRisk | null;
  audit: AuditService;
  /** Which reaches the runtime can honour (M27 flips these). */
  capabilities?: RuntimeCapabilities;
  /** Cut B: one-shot generation. Absent = 'generate' is refused, clearly. */
  generate?: SkillGenerateHook;
  /**
   * M28 cut D: the flow authoring model (generate a graph, refine one, convert
   * code to one, explain one). Absent = every AI flow verb is refused BY NAME
   * rather than silently downgraded — the same rule `generate` follows, and the
   * reason a build with no model can still draw, save, compile and install a
   * flow by hand.
   */
  flowAi?: FlowAiHook;
  /**
   * M26 cut E: the core-owned scratch root a dry-run materializes into
   * (config.skillRunsDir). One fresh dir per run, wiped in a finally.
   */
  runsDir: string;
  /**
   * M26 cut E: the M8 sandbox runner, used ONLY by `runDraft`. Optional so a
   * build without one refuses a dry-run by name instead of crashing - the
   * typed-error path a test can reach.
   */
  runner?: SkillRunner;
  /**
   * M26 cut C: the approval queue an install ask rides. Optional so a build
   * without one refuses `requestInstall` by name instead of throwing.
   */
  pending?: DraftInstallQueue;
  now?: () => number;
}

/**
 * M26 cut C: the bundle `skills.draft` writes from a chat turn. Same door as
 * `create` (one allocator, one validator, one insert) plus the two things only
 * chat has: the origin 'chat' and the conversation/persona the draft belongs
 * to, so a chat-authored draft can be linked back to the turn that asked.
 */
export interface ChatStageInput {
  /** An EXISTING draft to update; absent = a new chat-authored draft. */
  id?: string;
  name: string;
  description?: string;
  /** The manifest exactly as the model wrote it (validated verbatim). */
  manifestText: string;
  /** The entry source exactly as the model wrote it. */
  code: string;
  conversationId?: string | null;
  personaId?: string | null;
}

/** What `requestInstall` carries about the ask (M26 D2b). */
export interface RequestInstallOptions {
  conversationId?: string | null;
  personaId?: string | null;
}

/**
 * M28 cut E: the `flow` payload `skills.draft` accepts instead of `code`.
 *
 * One tool, not two (D2 of the milestone's implementation notes): a persona that
 * can author a skill can author it as a graph, and the bundle it produces is the
 * same artifact — a compiled `entry.mjs`. The flow arrives as untrusted input
 * (the model wrote it), so it goes through `validateFlow` AND the compiler
 * before any text is stored.
 */
export interface ChatFlowStageInput {
  /** An EXISTING draft to update; absent = a new chat-authored draft. */
  id?: string;
  name: string;
  description?: string;
  /** The graph exactly as the model wrote it (validated verbatim). */
  flow: unknown;
  conversationId?: string | null;
  personaId?: string | null;
}

/** `POST /drafts/:id/run` body: the caller's args + an optional shorter budget. */
export interface DraftRunOptions {
  args?: unknown;
  /** Clamps the manifest's own budget DOWN only - never extends it. */
  timeoutMs?: number;
  /**
   * M27 S3 (PLAN-M27 D7): the acting session's client class, read by the ROUTE
   * from `res.locals.session` and forwarded to the runner, so a dry-run applies
   * the same capability envelope a real invocation does. A dry-run reaches the
   * SAME runner, so it must carry the same class - otherwise it would be a way
   * around the envelope rather than a rehearsal of it. NEVER derived here and
   * never read from the request body. Absent = an internal caller with no
   * session, which keeps the desktop envelope (see SkillInvokeContext).
   */
  clientClass?: string;
}

export interface PromoteOptions {
  /**
   * M26 D6: an install that WIDENS the permission set needs this, and the UI
   * must have shown the before→after table first. Never defaulted on.
   */
  acknowledgePermissions?: boolean;
  /** For the audit row: which surface asked (both call the same promote). */
  via?: 'studio' | 'approval';
}

export interface SkillDraftManager {
  list(): SkillDraftSummary[];
  get(id: string): SkillDraft | null;
  create(input: SkillDraftCreateInput): Promise<SkillDraft>;
  update(id: string, patch: DraftPatch): SkillDraft;
  validate(id: string): SkillDraft;
  discard(id: string): void;
  /**
   * M26 cut C: stage the bundle a chat model wrote - a NEW draft (origin
   * 'chat', linked to the conversation) or an in-place update of an existing
   * one (L2's fix-the-validation loop). It installs nothing and runs nothing.
   */
  stageFromChat(input: ChatStageInput): SkillDraft;
  /**
   * M26 D2b: the persona ASKS for an install. Writes a `pending_tools` row of
   * kind 'skill_install' and returns its id; it creates nothing executable.
   * Re-asking while an ask is open returns that same ask instead of stacking
   * duplicates.
   */
  requestInstall(id: string, options?: RequestInstallOptions): { pendingId: string };
  /**
   * M26 D5 dry-run. The ONLY thing in this file that executes draft code, and
   * only because the owner asked: the bundle is materialized into a fresh dir
   * under `runsDir`, the real sandbox runs it with no recorded hash, and the
   * worker's own redacted log lines come back beside the outcome. No
   * skill_invocations row is written (a dry-run is not history).
   */
  runDraft(id: string, options?: DraftRunOptions): Promise<SkillDraftRun>;
  /** M26 D12: the draft as an UNSIGNED bundle (plain JSON, no signature). */
  exportBundle(id: string): SkillBundle;
  /**
   * M26 D12: an imported bundle ALWAYS becomes a new, inert draft. It never
   * installs, it never overwrites another draft, and a malformed or oversized
   * bundle is refused as `invalid_input`.
   */
  importBundle(bundle: unknown): SkillDraft;
  /**
   * `fork` — copy an installed skill under a NEW id. Promote creates a second
   * skill; the original is never touched. This is the safe default.
   */
  fork(skillId: string): SkillDraft;
  /**
   * `edit` — open a draft BOUND TO THE INSTALLED ID, so promoting it updates
   * that skill in place (and has to clear D6's consent gate when it widens
   * permissions). Without this the consent machinery would only be reachable by
   * hand-editing a manifest to reuse an id, which is not a user flow.
   */
  edit(skillId: string): SkillDraft;
  promote(id: string, options?: PromoteOptions): SkillDraftInstallResult;
  /** The templates this build can honour (the Studio picker's source). */
  templates(): Array<{ id: string; name: string; description: string; reach: string }>;
  /**
   * M28 B (PLAN-M28.md D6): the flow document, its `flowCompiledAt`, and the
   * DERIVED `flowStale`. A code-authored draft reports `flow: null` — the
   * honest answer for a draft that has no graph.
   */
  getFlow(id: string): SkillFlowState;
  /**
   * M28 B: replace the flow (the canvas save). The raw value is validated
   * structurally and refused with per-node errors when malformed — nothing is
   * written. A save is NOT a compile: `code`, and therefore the permissions
   * derived from the graph, are untouched (D1).
   */
  saveFlow(id: string, raw: unknown): SkillFlowSaveResult;
  /**
   * M28 B (D1/D5): the ONLY writer of `code` from a flow. It emits the entry,
   * stores `flow_sha256` + `flow_compiled_at`, REWRITES the manifest's derived
   * permissions (`tools` and `llm`), re-runs the M26 validation, and returns
   * the compile result with the rewritten draft — or the error list, having
   * written nothing.
   */
  compileFlow(id: string): SkillFlowCompileResponse;
  /**
   * M28 D (D8): ask the model to change the graph, and get a PROPOSAL back.
   * Nothing is written — the draft row is byte-identical afterwards — and the
   * only thing that stores a proposal is `saveFlow` after a human accepts it.
   * A reply the core cannot use is refused with a sentence (and the named
   * errors when it was a flow that failed validation), still writing nothing.
   */
  refineFlow(id: string, instruction: string): Promise<SkillFlowProposalResponse>;
  /**
   * M28 D (D7): the DECLARED-LOSSY conversion of the draft's entry source into
   * a graph, as a proposal. There is no decompiler; the model is guessing at
   * intent, so this is never applied automatically and the UI says so by name.
   */
  flowFromCode(id: string): Promise<SkillFlowProposalResponse>;
  /**
   * M28 D: a plain-language walkthrough of the graph, for the OWNER's eyes.
   * Writes nothing and audits nothing (there is no state to record).
   */
  explainFlow(id: string): Promise<SkillFlowExplainResponse>;
  /**
   * M28 cut E: stage the FLOW a chat model wrote — a NEW flow-backed draft, or
   * an in-place update of an existing one when an id is given (L2's
   * fix-the-problems loop, for graphs). It compiles the graph, derives the
   * manifest's permissions from it (D5), and installs nothing.
   */
  stageFlowFromChat(input: ChatFlowStageInput): SkillDraft;
}

export interface DraftPatch {
  name?: string;
  description?: string;
  manifestText?: string;
  code?: string;
}

const MAX_CODE_BYTES = 256 * 1024;
const MAX_TEXT_BYTES = 64 * 1024;

/** A minimal valid starter entry, so a manual draft validates from birth. */
const STARTER_CODE = `/**
 * Describe what this skill does here.
 *
 * run(args) receives the arguments the caller supplied and returns
 * JSON-serializable data. partner.tools.exec(id, params) makes a
 * broker-mediated tool call, if the manifest declares that tool.
 */
export async function run(args = {}) {
  return { ok: true, args };
}
`;

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Point a manifest at the id it MUST carry, keeping the text verbatim when it
 * does not parse (validation then says why). Why this exists, in one line: a
 * bundle that names the id of an ALREADY INSTALLED skill could otherwise make
 * `promote` replace that skill's code with no consent diff to show (D6 only
 * asks about a WIDENED set) - the same hole `importBundle` closes.
 */
function pointManifestAt(manifestText: string, id: string): string {
  try {
    const parsed = JSON.parse(manifestText) as unknown;
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return JSON.stringify({ ...(parsed as Record<string, unknown>), id }, null, 2);
    }
  } catch {
    // Unreadable text stays exactly as written; `validateParts` reports it.
  }
  return manifestText;
}

/** A trimmed id, or null for an absent/blank one (the optional-column convention). */
function normaliseId(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/**
 * The description the ROW carries, given the manifest it was just built from.
 *
 * `description` is the skill's own short description (`prompt` is the ask it was
 * generated from, a different column), and the Studio shows and edits exactly
 * this one — seeded from the MANIFEST, written back to both
 * (`web/src/studio/DraftEditor.tsx`). A create that let them start out different
 * (a template or blank draft is created with no description typed, while its
 * manifest carries one) therefore showed an empty field over a real manifest
 * value — and the first save wrote that emptiness back into the manifest,
 * invalidating a draft nobody had edited.
 *
 * Birth is the only place this can be settled: whenever the manifest parses, its
 * own description is the one that travels with the skill. The caller's text
 * stays the fallback for a manifest that does not parse (an author's broken
 * JSON, where there is nothing better to show).
 */
function rowDescriptionOf(manifest: SkillManifest | null, fallback: string): string {
  const fromManifest = manifest?.description;
  return typeof fromManifest === 'string' && fromManifest.trim() !== '' ? fromManifest : fallback;
}

/** Deterministic slug that satisfies ID_RE, or '' when nothing usable remains. */
export function slugifySkillId(raw: string): string {
  const slug = String(raw ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-._]+/, '')
    .replace(/[-._]+$/, '')
    .slice(0, 48);
  return ID_RE.test(slug) ? slug : '';
}

/**
 * M26 D6: which permission fields WIDENED. Only widening needs re-consent —
 * narrowing (or an unchanged set) is not a new power, so it must not nag.
 * Pure + exhaustive over the permission surface: adding a field here without
 * adding it to the diff would silently skip consent, so the test enumerates it.
 */
export function permissionDiff(
  before: SkillManifest | null,
  after: SkillManifest,
): PermissionDiffEntry[] {
  if (before === null) return [];
  const entries: PermissionDiffEntry[] = [];
  const setDiff = (field: PermissionDiffEntry['field'], from: string[], to: string[]): void => {
    const added = to.filter((value) => !from.includes(value));
    if (added.length > 0) {
      entries.push({ field, before: from.join(', ') || '—', after: to.join(', ') || '—' });
    }
  };
  setDiff('tools', before.permissions.tools, after.permissions.tools);
  setDiff('mcpServers', before.permissions.mcpServers ?? [], after.permissions.mcpServers ?? []);

  const riskRank: Record<string, number> = { low: 0, medium: 1, high: 2 };
  if ((riskRank[after.permissions.risk] ?? 0) > (riskRank[before.permissions.risk] ?? 0)) {
    entries.push({
      field: 'risk',
      before: before.permissions.risk,
      after: after.permissions.risk,
    });
  }
  if (after.permissions.network && !before.permissions.network) {
    entries.push({ field: 'network', before: 'false', after: 'true' });
  }
  if (after.permissions.llm === true && before.permissions.llm !== true) {
    entries.push({ field: 'llm', before: 'false', after: 'true' });
  }
  const beforeTime = before.budget?.timeMs ?? 0;
  const afterTime = after.budget?.timeMs ?? 0;
  if (afterTime > beforeTime) {
    entries.push({ field: 'budget.timeMs', before: String(beforeTime), after: String(afterTime) });
  }
  const beforeTokens = before.budget?.maxTokens ?? 0;
  const afterTokens = after.budget?.maxTokens ?? 0;
  if (afterTokens > beforeTokens) {
    entries.push({
      field: 'budget.maxTokens',
      before: String(beforeTokens),
      after: String(afterTokens),
    });
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

function parseValidation(text: string, fallbackAt: number): SkillDraftValidation {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const value = parsed as Partial<SkillDraftValidation>;
      return {
        ok: value.ok === true,
        errors: Array.isArray(value.errors) ? value.errors.map(String) : [],
        warnings: Array.isArray(value.warnings) ? value.warnings.map(String) : [],
        checkedAt:
          typeof value.checkedAt === 'number' && Number.isFinite(value.checkedAt)
            ? value.checkedAt
            : fallbackAt,
      };
    }
  } catch {
    // Fall through: an unreadable blob reads as "not validated", never as ok.
  }
  return { ok: false, errors: ['validation record unreadable'], warnings: [], checkedAt: fallbackAt };
}

function parseManifest(json: string | null): SkillManifest | null {
  if (json === null || json === '') return null;
  try {
    const parsed = JSON.parse(json) as unknown;
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const manifest = parsed as SkillManifest;
      return typeof manifest.id === 'string' && manifest.id !== '' ? manifest : null;
    }
  } catch {
    // Invalid JSON is not a manifest — the caller reports null and says so.
  }
  return null;
}

function toSummary(row: SkillDraftRow, pendingInstallId: string | null): SkillDraftSummary {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    status: row.status === 'installed' ? 'installed' : 'draft',
    origin: row.origin as SkillDraftSummary['origin'],
    manifest: parseManifest(row.manifestJson),
    validation: parseValidation(row.validationJson, row.updatedAt),
    model: row.model,
    conversationId: row.conversationId,
    personaId: row.personaId,
    // M26 D2b: the open install ask, when the persona has one for this draft.
    // A closed ask (approved or denied) is NOT reported - the card is gone.
    pendingInstallId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** A parsed JSON object, or null when the text is not one (never throws). */
function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Not JSON; the caller names the problem it caused.
  }
  return null;
}

/**
 * The stored flow document, or null when there is none (a code-authored draft)
 * or the stored text is not one. The document was validated when it was SAVED,
 * so this is a reader, not a second validator — but a row written by an older
 * build, or corrupted, must read as "no flow" rather than crash the surface.
 */
function parseFlow(json: string | null): SkillFlow | null {
  if (json === null || json === '') return null;
  try {
    const parsed = JSON.parse(json) as unknown;
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const flow = parsed as SkillFlow;
      if (flow.version === 1 && Array.isArray(flow.nodes) && Array.isArray(flow.edges)) {
        return flow;
      }
    }
  } catch {
    // Unreadable text is not a flow — the next save replaces it.
  }
  return null;
}

/**
 * M28 D6 — the ONE staleness rule, and it is DERIVED on every read.
 *
 * `flow_sha256` is the hash of the code the flow last compiled to, so "stale"
 * means "this draft's code is not what the flow produced". Nothing stores the
 * answer: a hand-edit that restores the compiled bytes clears it by itself, and
 * there is no boolean to drift out of sync.
 *
 * BOTH SIDES OF THE COMPARISON ARE CHECKED, and that is a deliberate
 * strengthening of the spec's formula (`sha256(code) !== flow_sha256`), found by
 * walking the slice-D lifecycle: because a canvas SAVE does not touch the code,
 * a graph edited after a compile left a draft reading FRESH while its code was
 * the PREVIOUS graph's output. The Studio would then offer no Recompile, and a
 * user who drew a change would install the old behaviour.
 *
 * So a flow is stale when EITHER side has moved away from the last compile:
 *   - `sha256(code) !== flow_sha256` — the code was hand-edited; or
 *   - `compile(flow).sha256 !== flow_sha256` — the GRAPH was edited (or the
 *     graph no longer compiles on this build at all, in which case its code
 *     cannot be that flow's output either).
 *
 * Recompiling the stored graph on read is affordable (the compiler is pure, the
 * graph is capped at 200 nodes, and only a single draft is read at a time) and
 * it is passed NO risk ceiling on purpose: the compile's ceiling decides whether
 * a graph may be INSTALLED, never what bytes it emits, so it has no business in
 * a byte comparison.
 *
 * Two edges are deliberate:
 *   - a draft with NO flow is never stale (there is no flow to be coherent
 *     with), which is what keeps a code-authored draft's badge off; and
 *   - a flow that has NEVER compiled IS stale, because its code cannot be the
 *     flow's output. That is the honest reading of "the code is not the flow",
 *     and it is what makes the Studio offer Recompile on a freshly drawn graph.
 *
 * Staleness is UI honesty, NOT a security state: install consumes `code`, which
 * is re-validated at install time, so a stale flow never blocks anything.
 */
function flowStaleFor(
  row: SkillDraftRow,
  flow: SkillFlow | null,
  compileOptions: FlowCompileOptions,
): boolean {
  if (flow === null) return false;
  if (row.flowSha256 === null) return true;
  if (sha256Of(row.code) !== row.flowSha256) return true;
  const compiled = compileSkillFlow(flow, compileOptions);
  return !compiled.ok || compiled.sha256 !== row.flowSha256;
}

/**
 * The compiler inputs a STALENESS comparison uses: this build's registry and
 * whether it has model reach. No risk ceiling and no per-tool risk — see the
 * note above: neither can change a single emitted byte.
 */
function flowCompareOptions(
  tools: ReadonlySet<string>,
  llmAvailable: boolean,
): FlowCompileOptions {
  return { registry: tools, llmAvailable };
}

/** The flow surface's read shape for one row (GET/PUT `…/flow`). */
function flowStateOf(row: SkillDraftRow, compileOptions: FlowCompileOptions): SkillFlowState {
  const flow = parseFlow(row.flowJson);
  return {
    flow,
    flowCompiledAt: row.flowCompiledAt,
    flowStale: flowStaleFor(row, flow, compileOptions),
    // D9's palette gate, answered by the core because only the core knows
    // whether this build has model reach (M27 S5).
    llmAvailable: compileOptions.llmAvailable === true,
  };
}

/**
 * M28 slice D: the bundle a FLOW-BACKED draft is born with — the ONE place a
 * chat/tool/generate-flow graph becomes a draft's `code` + manifest.
 *
 * Two decisions are fixed here, and both exist so the artifact and the consent
 * summary cannot drift (D5):
 *
 *   - `permissions.tools` and `permissions.llm` come from the COMPILER's
 *     derived set, never from the caller's text;
 *   - the manifest's `risk` tier is the HIGHEST risk among the graph's tool
 *     nodes (low when it reaches nothing). Deriving it means a flow that uses
 *     `files.apply` declares `high` and compiles, instead of failing D5's own
 *     ceiling check against a tier nobody chose. The tier is the tool's own
 *     risk, which is also exactly what the install card promises.
 *
 * A graph that does not compile writes nothing and returns the compiler's named
 * errors: there is no "store it anyway" path, because an uncompilable flow has
 * no code to store.
 */
interface FlowDraftIdentity {
  id: string;
  name: string;
  description: string;
}

type FlowBundleResult =
  | {
      ok: true;
      manifestText: string;
      code: string;
      sha256: string;
      tools: string[];
      usesLlm: boolean;
      warnings: FlowValidationError[];
    }
  | { ok: false; errors: FlowValidationError[]; warnings: FlowValidationError[] };

function bundleFromFlow(
  flow: SkillFlow,
  identity: FlowDraftIdentity,
  options: {
    registry: ReadonlySet<string>;
    riskOf: (toolId: string) => ToolRisk | null;
    llmAvailable: boolean;
  },
): FlowBundleResult {
  const RISK_RANK: Record<ToolRisk, number> = { low: 0, medium: 1, high: 2 };
  const risks: ToolRisk[] = ['low'];
  for (const node of flow.nodes) {
    if (node.type !== 'tool') continue;
    const risk = options.riskOf(node.data.toolId);
    if (risk !== null) risks.push(risk);
  }
  const risk = risks.reduce((worst, next) =>
    RISK_RANK[next] > RISK_RANK[worst] ? next : worst,
  );

  const compiled = compileSkillFlow(flow, {
    registry: options.registry,
    llmAvailable: options.llmAvailable,
    riskCeiling: risk,
    riskOf: options.riskOf,
  });
  if (!compiled.ok) return { ok: false, errors: compiled.errors, warnings: compiled.warnings };

  const manifest = {
    id: identity.id,
    name: identity.name,
    description:
      identity.description === '' ? 'A skill built on a flow.' : identity.description,
    author: 'Partner',
    version: '0.1.0',
    entrypoint: 'entry.mjs',
    permissions: {
      tools: compiled.tools,
      network: false,
      risk,
      // Written in BOTH directions (D5): an absent value means false, and
      // writing it keeps the derived set visibly equal to the graph.
      llm: compiled.usesLlm,
    },
    budget: { timeMs: 10_000 },
  };
  return {
    ok: true,
    manifestText: JSON.stringify(manifest, null, 2),
    code: compiled.code,
    sha256: compiled.sha256,
    tools: compiled.tools,
    usesLlm: compiled.usesLlm,
    warnings: compiled.warnings,
  };
}

/** The empty graph a diff is measured against when a draft has no flow yet. */
const EMPTY_FLOW: SkillFlow = { version: 1, nodes: [], edges: [] };

function toDetail(
  row: SkillDraftRow,
  pendingInstallId: string | null,
  compileOptions: FlowCompileOptions,
): SkillDraft {
  const manifest = parseManifest(row.manifestJson);
  const flow = parseFlow(row.flowJson);
  return {
    ...toSummary(row, pendingInstallId),
    code: row.code,
    prompt: row.prompt,
    manifestText: row.manifestText,
    installedVersion: row.installedVersion,
    // M28: the flow document and its DERIVED staleness. A code-authored draft
    // carries no flow, and a stale flag with no flow would be meaningless.
    flow,
    flowSha256: row.flowSha256,
    flowCompiledAt: row.flowCompiledAt,
    flowStale: flowStaleFor(row, flow, compileOptions),
  };
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

export function createSkillDraftManager(options: SkillDraftManagerOptions): SkillDraftManager {
  const { store, skills, tools, audit, runsDir, runner, pending } = options;
  const capabilities = options.capabilities ?? DEFAULT_RUNTIME_CAPABILITIES;
  const now = options.now ?? Date.now;
  /**
   * M28 D6: the compiler inputs a staleness READ uses (see `flowStaleFor`).
   * Built once per manager so a read path cannot accidentally compare against a
   * different registry than the compile route uses.
   */
  const compareOptions = flowCompareOptions(tools, capabilities.llm === true);

  function requireRow(id: string): SkillDraftRow {
    const clean = typeof id === 'string' ? id.trim() : '';
    const row = clean === '' ? undefined : store.findById(clean);
    if (!row) throw skillError('not_found', `skill draft "${clean}" not found`);
    return row;
  }

  /**
   * The OPEN install ask for a draft, if the persona has one (M26 D2b).
   * `pending.list()` is already the OPEN rows, so a decided ask disappears by
   * itself. A linear scan is honest at this scale (a handful of rows) and keeps
   * the manager free of a second index it would have to keep in sync.
   */
  function openInstallId(draftId: string): string | null {
    if (pending === undefined) return null;
    const ask = pending
      .list()
      .find((row) => row.kind === 'skill_install' && row.draftId === draftId);
    return ask?.id ?? null;
  }

  /** A draft as the wire sees it, carrying its live install ask. */
  function detail(row: SkillDraftRow): SkillDraft {
    return toDetail(row, openInstallId(row.id), compareOptions);
  }

  function summary(row: SkillDraftRow): SkillDraftSummary {
    return toSummary(row, openInstallId(row.id));
  }

  /** Deterministic, collision-free slug across drafts AND installed skills. */
  function allocateId(preferred: string, name: string): string {
    const base = slugifySkillId(preferred) || slugifySkillId(name) || 'skill';
    let candidate = base;
    let suffix = 2;
    while (store.findById(candidate) !== undefined || skills.get(candidate) !== null) {
      candidate = `${base.slice(0, 44)}-${suffix}`;
      suffix += 1;
    }
    return candidate;
  }

  /**
   * The one validation implementation. Deterministic, side-effect-free, and it
   * never executes the entry: shape -> registry -> entry lint. Warnings are the
   * plain-language reach lines the owner will read at install.
   */
  function validateParts(manifestText: string, code: string, at: number): {
    manifest: SkillManifest | null;
    validation: SkillDraftValidation;
  } {
    const errors: string[] = [];
    const warnings: string[] = [];

    let raw: unknown;
    try {
      raw = JSON.parse(manifestText) as unknown;
    } catch {
      return {
        manifest: null,
        validation: {
          ok: false,
          errors: ['manifest is not valid JSON'],
          warnings,
          checkedAt: at,
        },
      };
    }

    const shape = validateManifestShape(raw, { capabilities });
    let manifest: SkillManifest | null = null;
    if (!shape.ok) {
      errors.push(...shape.errors);
    } else {
      manifest = shape.manifest;
      const missing = unknownTools(manifest, tools);
      if (missing.length > 0) {
        errors.push(
          `declares unknown tool${missing.length === 1 ? '' : 's'}: ${missing.join(', ')}`,
        );
      }
    }

    const lint = lintEntry(code);
    errors.push(...lint.errors);
    warnings.push(...lint.warnings);

    if (manifest !== null) {
      // The reach lines are warnings (informational), never errors.
      for (const line of permissionSummary(manifest)) warnings.push(line);
    }

    return {
      manifest: errors.length === 0 ? manifest : null,
      validation: { ok: errors.length === 0, errors, warnings, checkedAt: at },
    };
  }

  /** Re-validate a row in place and return the fresh row. */
  function refresh(row: SkillDraftRow): SkillDraftRow {
    const at = now();
    const { manifest, validation } = validateParts(row.manifestText, row.code, at);
    store.update(row.id, {
      manifestJson: manifest === null ? null : JSON.stringify(manifest),
      validationJson: JSON.stringify(validation),
      updatedAt: at,
    });
    return requireRow(row.id);
  }

  function list(): SkillDraftSummary[] {
    return store.list().map(summary);
  }

  function get(id: string): SkillDraft | null {
    const clean = typeof id === 'string' ? id.trim() : '';
    const row = clean === '' ? undefined : store.findById(clean);
    return row ? detail(row) : null;
  }

  async function create(input: SkillDraftCreateInput): Promise<SkillDraft> {
    const mode = input?.mode;
    if (mode !== 'manual' && mode !== 'template' && mode !== 'generate' && mode !== 'generate-flow') {
      throw skillError('invalid_input', 'mode must be manual|template|generate|generate-flow');
    }
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (name === '') throw skillError('invalid_input', 'name is required');
    const description = typeof input.description === 'string' ? input.description.trim() : '';

    const id = allocateId(input.id ?? '', name);
    const at = now();

    let manifestText: string;
    let code: string;
    let origin: string;
    let model: string | null = null;
    let prompt = '';
    /** M28 D: a flow-backed birth writes all three together (D1/D6). */
    let flowJson: string | null = null;
    let flowSha256: string | null = null;
    let flowCompiledAt: number | null = null;

    if (mode === 'template') {
      const requested = String(input.template ?? '');
      const template = findTemplate(requested);
      if (!template) {
        const known = availableTemplates(capabilities)
          .map((entry) => entry.id)
          .join(', ');
        throw skillError(
          'invalid_input',
          `unknown template "${requested}" — this build offers: ${known}`,
        );
      }
      if (template.requires !== undefined && !capabilities[template.requires]) {
        throw skillError(
          'invalid_input',
          `template "${template.id}" needs a capability this build does not have`,
        );
      }
      const bundle = template.build(name, id);
      manifestText = JSON.stringify(bundle.manifest, null, 2);
      code = bundle.code;
      origin = 'template';
    } else if (mode === 'generate') {
      if (!options.generate) {
        throw skillError(
          'invalid_input',
          'generation is unavailable — connect a model provider, or start from a template',
        );
      }
      const generated = await options.generate({
        description,
        name,
        id,
        toolIds: [...tools],
      });
      manifestText = generated.manifestText;
      code = generated.code;
      origin = 'generated';
      model = generated.model;
      prompt = description;
    } else if (mode === 'generate-flow') {
      // M28 D: the model returns a GRAPH, not code. The core validates it (the
      // schema door), COMPILES it (the only writer of code from a flow) and
      // derives the manifest from what the graph actually reaches (D5). A graph
      // the core refuses is refused by name, having written nothing — exactly as
      // `generate` refuses an unusable bundle.
      if (options.flowAi === undefined) {
        throw skillError(
          'invalid_input',
          'generating a flow is unavailable — connect a model provider, or draw the flow in the Studio',
        );
      }
      const generated = await options.flowAi.generate({
        name,
        description,
        toolIds: [...tools],
        llmAvailable: capabilities.llm === true,
      });
      if (!generated.ok) throw skillError('invalid_input', generated.message);
      const validated = validateFlow(generated.flow);
      if (!validated.ok) {
        throw skillError(
          'invalid_input',
          `the model's graph is not a valid flow: ${validated.errors[0]?.message ?? 'unknown problem'}`,
        );
      }
      const bundle = bundleFromFlow(validated.flow, { id, name, description }, {
        registry: tools,
        riskOf: options.riskOf,
        llmAvailable: capabilities.llm === true,
      });
      if (!bundle.ok) {
        throw skillError(
          'invalid_input',
          `the model's graph does not compile: ${bundle.errors[0]?.message ?? 'unknown problem'}`,
        );
      }
      manifestText = bundle.manifestText;
      code = bundle.code;
      origin = 'flow';
      model = generated.model;
      prompt = description;
      flowJson = JSON.stringify(validated.flow);
      flowSha256 = bundle.sha256;
      flowCompiledAt = at;
    } else {
      // manual: a valid, honest starter the author edits.
      origin = 'manual';
      manifestText = JSON.stringify(
        {
          id,
          name,
          description: description === '' ? 'Describe what this skill does.' : description,
          author: 'You',
          version: '0.1.0',
          entrypoint: 'entry.mjs',
          permissions: { tools: [], network: false, risk: 'low' },
          budget: { timeMs: 10_000 },
        },
        null,
        2,
      );
      code = STARTER_CODE;
    }

    if (Buffer.byteLength(manifestText, 'utf8') > MAX_TEXT_BYTES) {
      throw skillError('invalid_input', 'manifest text is too large');
    }
    if (Buffer.byteLength(code, 'utf8') > MAX_CODE_BYTES) {
      throw skillError('invalid_input', 'entry source is too large');
    }

    const { manifest, validation } = validateParts(manifestText, code, at);
    store.insert({
      id,
      name,
      // The row and the manifest carry ONE description (see rowDescriptionOf).
      description: rowDescriptionOf(manifest, description),
      status: 'draft',
      origin,
      manifestJson: manifest === null ? null : JSON.stringify(manifest),
      manifestText,
      code,
      prompt,
      model,
      validationJson: JSON.stringify(validation),
      conversationId: null,
      personaId: null,
      installedVersion: null,
      // M28: a code-authored draft starts with NO flow; `generate-flow` is
      // born compiled, so it carries the graph and the hash it compiled to.
      flowJson,
      flowSha256,
      flowCompiledAt,
      createdAt: at,
      updatedAt: at,
    });
    audit.log('web', 'skill.draft.create', id, {
      origin,
      mode,
      hasModel: model !== null,
    });
    return detail(requireRow(id));
  }

  function update(id: string, patch: DraftPatch): SkillDraft {
    const row = requireRow(id);
    if (row.status === 'installed') {
      throw skillError('conflict', 'this draft has already been installed');
    }
    const next: SkillDraftRowPatch = { updatedAt: row.updatedAt };
    const changed: string[] = [];

    if (typeof patch.name === 'string') {
      const name = patch.name.trim();
      if (name === '') throw skillError('invalid_input', 'name cannot be empty');
      if (name !== row.name) changed.push('name');
      next.name = name;
    }
    if (typeof patch.description === 'string') {
      if (patch.description !== row.description) changed.push('description');
      next.description = patch.description;
    }
    if (typeof patch.manifestText === 'string') {
      if (Buffer.byteLength(patch.manifestText, 'utf8') > MAX_TEXT_BYTES) {
        throw skillError('invalid_input', 'manifest text is too large');
      }
      if (patch.manifestText !== row.manifestText) changed.push('manifest');
      next.manifestText = patch.manifestText;
    }
    if (typeof patch.code === 'string') {
      if (Buffer.byteLength(patch.code, 'utf8') > MAX_CODE_BYTES) {
        throw skillError('invalid_input', 'entry source is too large');
      }
      if (patch.code !== row.code) changed.push('code');
      next.code = patch.code;
    }

    const merged = { ...row, ...next } as SkillDraftRow;
    const { manifest, validation } = validateParts(merged.manifestText, merged.code, next.updatedAt);
    store.update(id, {
      ...next,
      manifestJson: manifest === null ? null : JSON.stringify(manifest),
      validationJson: JSON.stringify(validation),
    });
    audit.log('web', 'skill.draft.update', id, { changed });
    return detail(requireRow(id));
  }

  function validate(id: string): SkillDraft {
    const row = requireRow(id);
    if (row.status === 'installed') {
      throw skillError('conflict', 'this draft has already been installed');
    }
    const refreshed = refresh(row);
    const validation = parseValidation(refreshed.validationJson, refreshed.updatedAt);
    audit.log('web', 'skill.draft.validate', id, {
      ok: validation.ok,
      errorCount: validation.errors.length,
    });
    return detail(refreshed);
  }

  /**
   * M26 cut C: stage what a chat model wrote. Two branches, and neither runs or
   * installs anything:
   *
   *   - no `id`  -> a NEW draft, origin 'chat', linked to the conversation the
   *                 persona asked from (so the Studio can link back to it). One
   *                 insert through the same validator/allocator `create` uses.
   *   - with id  -> an in-place UPDATE of that draft (L2: the model fixes the
   *                 validation errors it was handed and re-calls with the same
   *                 id). Delegated to `update`, so the two cannot drift.
   *
   * The bundle text is sanitised BEFORE it gets here (`normalizeAuthoredBundle`
   * in authoring.ts), but this method does not trust that: the caps, the entry
   * lint and the manifest shape are re-checked by `validateParts` either way.
   */
  function stageFromChat(input: ChatStageInput): SkillDraft {
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (name === '') throw skillError('invalid_input', 'name is required');
    const description = typeof input.description === 'string' ? input.description.trim() : '';
    const manifestText = typeof input.manifestText === 'string' ? input.manifestText : '';
    const code = typeof input.code === 'string' ? input.code : '';
    if (manifestText.trim() === '') {
      throw skillError('invalid_input', 'a manifest is required');
    }
    if (code.trim() === '') throw skillError('invalid_input', 'entry source is required');
    // The same caps as every other draft write: chat is not a way around them.
    if (Buffer.byteLength(manifestText, 'utf8') > MAX_TEXT_BYTES) {
      throw skillError('invalid_input', 'manifest text is too large');
    }
    if (Buffer.byteLength(code, 'utf8') > MAX_CODE_BYTES) {
      throw skillError('invalid_input', 'entry source is too large');
    }

    const existing = typeof input.id === 'string' ? input.id.trim() : '';
    if (existing !== '') {
      // UPDATE. The manifest may not CHANGE which skill it points at: it keeps
      // the id the draft already carried (for an `edit` draft that is the
      // INSTALLED skill's id, which is what makes promote an update).
      const row = requireRow(existing);
      const bound = parseManifest(row.manifestJson)?.id ?? row.id;
      return update(existing, {
        name,
        description,
        manifestText: pointManifestAt(manifestText, bound),
        code,
      });
    }

    const id = allocateId('', name);
    const at = now();
    // A NEW chat draft owns the id the allocator handed it, so the manifest is
    // re-pointed at that slug before anything is stored.
    const owned = pointManifestAt(manifestText, id);
    const { manifest, validation } = validateParts(owned, code, at);
    store.insert({
      id,
      name,
      // Same one-description rule as `create`: the model's manifest is the
      // skill's description, and the row mirrors it (see rowDescriptionOf).
      description: rowDescriptionOf(manifest, description),
      status: 'draft',
      origin: 'chat',
      manifestJson: manifest === null ? null : JSON.stringify(manifest),
      manifestText: owned,
      code,
      // The prompt was the user's own words in the chat turn; the tool does not
      // restate them, so the field stays empty rather than invented.
      prompt: '',
      model: null,
      validationJson: JSON.stringify(validation),
      conversationId: normaliseId(input.conversationId),
      personaId: normaliseId(input.personaId),
      installedVersion: null,
      // A chat-authored draft starts as code (cut E adds the `flow` payload).
      flowJson: null,
      flowSha256: null,
      flowCompiledAt: null,
      createdAt: at,
      updatedAt: at,
    });
    audit.log('web', 'skill.draft.create', id, { origin: 'chat', mode: 'chat', hasModel: false });
    return detail(requireRow(id));
  }

  /**
   * M28 cut E: the `flow` half of `skills.draft`.
   *
   * WHY it lives here and not in `tool.ts`: the tool layer must not learn how a
   * graph becomes an artifact. Everything that makes a flow-backed draft
   * trustworthy is already in this file — the schema door, the compiler, the
   * derived permissions, the caps and the store — so the tool passes the graph
   * through and this function does the same thing `create`'s `generate-flow`
   * branch does, for a graph a PERSONA wrote instead of a Studio generator.
   *
   * Both paths end at the same place: a draft whose `code` is the compiled
   * graph, whose manifest's permissions are derived from it (D5), and whose
   * `flow_sha256` records what it compiled to (D6). Nothing runs, nothing
   * installs, and the audit row carries counts only.
   */
  function stageFlowFromChat(input: ChatFlowStageInput): SkillDraft {
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (name === '') throw skillError('invalid_input', 'name is required');
    const description = typeof input.description === 'string' ? input.description.trim() : '';
    const validated = validateFlow(input.flow);
    if (!validated.ok) {
      // A malformed graph is refused BY NAME, with the per-node errors, so the
      // model is told exactly what to fix instead of storing a sketch.
      throw skillError(
        'invalid_input',
        `the flow is not valid: ${validated.errors[0]?.message ?? 'unknown problem'}`,
      );
    }

    const existing = typeof input.id === 'string' ? input.id.trim() : '';
    const at = now();
    // A chat-authored flow owns a slug the allocator hands out, so the manifest
    // is built against THAT id; an update keeps the id the draft already had.
    const id = existing === '' ? allocateId('', name) : existing;
    const row = existing === '' ? null : requireRow(existing);
    if (row !== null && row.status === 'installed') {
      throw skillError('conflict', 'this draft has already been installed');
    }
    // An `edit` draft's manifest carries the INSTALLED skill's id, and that
    // binding is what makes promote an update — so it is preserved here exactly
    // as `stageFromChat` preserves it for a code bundle.
    const bound = row === null ? id : parseManifest(row.manifestJson)?.id ?? row.id;

    const bundle = bundleFromFlow(validated.flow, { id: bound, name, description }, {
      registry: tools,
      riskOf: options.riskOf,
      llmAvailable: capabilities.llm === true,
    });
    if (!bundle.ok) {
      throw skillError(
        'invalid_input',
        `the flow does not compile: ${bundle.errors[0]?.message ?? 'unknown problem'}`,
      );
    }
    if (Buffer.byteLength(bundle.manifestText, 'utf8') > MAX_TEXT_BYTES) {
      throw skillError('invalid_input', 'manifest text is too large');
    }
    if (Buffer.byteLength(bundle.code, 'utf8') > MAX_CODE_BYTES) {
      throw skillError('invalid_input', 'entry source is too large');
    }

    const { manifest, validation } = validateParts(bundle.manifestText, bundle.code, at);
    const flowJson = JSON.stringify(validated.flow);
    if (row !== null) {
      store.update(row.id, {
        name,
        description,
        manifestText: bundle.manifestText,
        manifestJson: manifest === null ? null : JSON.stringify(manifest),
        code: bundle.code,
        validationJson: JSON.stringify(validation),
        flowJson,
        flowSha256: bundle.sha256,
        flowCompiledAt: at,
        updatedAt: at,
      });
      audit.log('web', 'skill.draft.stageFlow', row.id, {
        mode: 'update',
        nodes: validated.flow.nodes.length,
        edges: validated.flow.edges.length,
        tools: bundle.tools,
        usesLlm: bundle.usesLlm,
      });
      return detail(requireRow(row.id));
    }

    store.insert({
      id,
      name,
      description,
      status: 'draft',
      origin: 'chat',
      manifestJson: manifest === null ? null : JSON.stringify(manifest),
      manifestText: bundle.manifestText,
      code: bundle.code,
      // The prompt was the user's own words in the chat turn; a flow payload
      // does not restate them, so the field stays empty rather than invented.
      prompt: '',
      model: null,
      validationJson: JSON.stringify(validation),
      conversationId: normaliseId(input.conversationId),
      personaId: normaliseId(input.personaId),
      installedVersion: null,
      flowJson,
      flowSha256: bundle.sha256,
      flowCompiledAt: at,
      createdAt: at,
      updatedAt: at,
    });
    audit.log('web', 'skill.draft.stageFlow', id, {
      mode: 'create',
      nodes: validated.flow.nodes.length,
      edges: validated.flow.edges.length,
      tools: bundle.tools,
      usesLlm: bundle.usesLlm,
    });
    return detail(requireRow(id));
  }

  /**
   * M26 D2b: the persona ASKS for an install. This is the whole of it - write
   * one queue row of kind 'skill_install' and return its id. Nothing becomes
   * executable here: the owner's Approve on that row is what calls `promote`.
   *
   * Refusals, each named: an unknown draft (`not_found`), an already-installed
   * one (`conflict` - it cannot be promoted again), a draft that does not
   * validate (`invalid_input` - the ask could only fail on approval, so the
   * model is told to fix it instead), and a build with no approval queue
   * (`invalid_input`, said plainly).
   */
  function requestInstall(id: string, installOptions: RequestInstallOptions = {}): {
    pendingId: string;
  } {
    const row = requireRow(id);
    if (pending === undefined) {
      throw skillError(
        'invalid_input',
        'install approvals are unavailable - the approval queue is not wired in this build',
      );
    }
    if (row.status === 'installed') {
      throw skillError('conflict', 'this draft has already been installed');
    }
    const { manifest, validation } = validateParts(row.manifestText, row.code, now());
    if (manifest === null || !validation.ok) {
      throw skillError(
        'invalid_input',
        `this draft does not validate - fix it before asking to install it: ${
          validation.errors[0] ?? 'unknown problem'
        }`,
      );
    }
    // Re-asking while an ask is open reuses it: two open rows for one draft
    // would render two cards and count twice in the queue.
    const open = openInstallId(row.id);
    if (open !== null) {
      audit.log('web', 'skill.draft.request', row.id, { reused: true });
      return { pendingId: open };
    }

    const conversationId = normaliseId(installOptions.conversationId) ?? row.conversationId;
    const personaId = normaliseId(installOptions.personaId) ?? row.personaId;
    const pendingId = pending.enqueue({
      toolId: 'skill.install',
      // No project root: an install is not a files.* action.
      projectId: '',
      // Stored verbatim so the approval card can render the ask without
      // re-reading the draft; the draft id is the payload that matters.
      params: { draftId: row.id },
      // The skill's OWN declared risk, so the queue reads honestly (an install
      // is still an owner act either way - this row can only be decided by the
      // install route, never by broker.decide).
      risk: manifest.permissions.risk,
      requestedBy: 'persona',
      ...(conversationId !== null ? { conversationId } : {}),
      ...(personaId !== null ? { personaId } : {}),
      kind: 'skill_install',
      draftId: row.id,
    });
    audit.log('web', 'skill.draft.request', row.id, {
      reused: false,
      hasConversation: conversationId !== null,
    });
    return { pendingId };
  }

  function discard(id: string): void {
    const row = requireRow(id);
    // Close any open install ask FIRST: a discarded draft must not leave a card
    // the owner could approve into a promote of a row that no longer exists.
    const openAsks = (pending?.list() ?? []).filter(
      (ask) => ask.kind === 'skill_install' && ask.draftId === row.id,
    );
    for (const ask of openAsks) pending?.settleInstall(ask.id, 'deny', 'web');
    store.remove(id);
    // Lengths/flags only: the code itself is the owner's content.
    audit.log('web', 'skill.draft.discard', id, {
      codeBytes: Buffer.byteLength(row.code, 'utf8'),
      hasPending: openAsks.length > 0,
    });
  }

  /**
   * Shared body of fork/edit: start a draft from an INSTALLED skill.
   * `keepId` selects "edit this skill" (same manifest id, promote updates it)
   * over "copy it" (new id, promote creates another skill).
   */
  function draftFromInstalled(skillId: string, keepId: boolean): SkillDraft {
    const clean = typeof skillId === 'string' ? skillId.trim() : '';
    const installed = clean === '' ? null : skills.get(clean);
    if (installed === null) {
      throw skillError('not_found', `skill "${clean}" is not installed`);
    }
    const code = skills.readEntrySource(clean);
    const name = keepId ? installed.manifest.name : `${installed.manifest.name} (copy)`;
    // An edit keeps the manifest id (promote must land on the same skill); a
    // fork takes a fresh one (promote must NOT clobber the original).
    const manifestId = keepId ? clean : allocateId(`${clean}-copy`, name);
    const draftId = keepId ? `${clean}-edit` : manifestId;
    const at = now();
    const manifestText = JSON.stringify(
      { ...installed.manifest, id: manifestId, name },
      null,
      2,
    );
    const { manifest, validation } = validateParts(manifestText, code, at);
    // A second edit of the same skill replaces the first draft (there is one
    // editable copy per skill, so two stale drafts cannot both promote).
    const existingDraft = store.findById(draftId);
    if (existingDraft !== undefined) {
      if (existingDraft.status === 'installed') {
        store.remove(draftId);
      } else {
        store.update(draftId, {
          name,
          manifestJson: manifest === null ? null : JSON.stringify(manifest),
          manifestText,
          code,
          validationJson: JSON.stringify(validation),
          updatedAt: at,
        });
        audit.log('web', 'skill.fork', draftId, {
          fromId: clean,
          version: installed.version,
          mode: keepId ? 'edit' : 'copy',
        });
        return detail(requireRow(draftId));
      }
    }
    store.insert({
      id: draftId,
      name,
      description: installed.manifest.description,
      status: 'draft',
      origin: keepId ? 'edit' : 'fork',
      manifestJson: manifest === null ? null : JSON.stringify(manifest),
      manifestText,
      code,
      prompt: '',
      model: null,
      validationJson: JSON.stringify(validation),
      conversationId: null,
      personaId: null,
      installedVersion: installed.version,
      // A fork/edit copies the installed CODE; there is no flow to copy (D7).
      flowJson: null,
      flowSha256: null,
      flowCompiledAt: null,
      createdAt: at,
      updatedAt: at,
    });
    audit.log('web', 'skill.fork', draftId, {
      fromId: clean,
      version: installed.version,
      mode: keepId ? 'edit' : 'copy',
    });
    return detail(requireRow(draftId));
  }

  function fork(skillId: string): SkillDraft {
    return draftFromInstalled(skillId, false);
  }

  function edit(skillId: string): SkillDraft {
    return draftFromInstalled(skillId, true);
  }

  /**
   * The manifest budget for a dry-run, clamped by the caller's `timeoutMs` and
   * by the runtime ceiling. `timeoutMs` can only ever SHORTEN a run: a caller
   * must not be able to hold a worker past what the manifest claims.
   */
  function runBudgetMs(manifest: SkillManifest, timeoutMs: number | undefined): number {
    const declared = manifest.budget?.timeMs;
    const manifestMs =
      typeof declared === 'number' && Number.isFinite(declared) && declared > 0
        ? declared
        : DEFAULT_TIME_MS;
    const requested = timeoutMs === undefined ? manifestMs : Math.min(manifestMs, timeoutMs);
    return Math.max(1, Math.min(requested, MAX_SKILL_TIME_MS));
  }

  /**
   * Wipe one materialized run dir, retrying briefly.
   *
   * A worker killed milliseconds ago can still pin its own cwd on Windows
   * (EPERM on the directory itself, before any file is even looked at), and the
   * wipe happens in a `finally` where throwing would turn a FINISHED run into a
   * transport error. So it retries with a short pause, and a last-resort
   * failure is swallowed: the dir is scratch under a core-owned root, its name
   * carries a uuid, and it is never scanned for installable code - a leftover is
   * a hygiene issue, not a correctness one.
   */
  async function wipeRunDir(dir: string): Promise<void> {
    for (let attempt = 0; attempt < 8; attempt++) {
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
      }
    }
  }

  /**
   * M26 D5 - the dry-run. The sequence is deliberately boring: materialize the
   * row's own bytes somewhere the core owns, launch the REAL sandbox against
   * that dir, collect its redacted lines, wipe the dir in a finally.
   */
  async function runDraft(id: string, runOptions: DraftRunOptions = {}): Promise<SkillDraftRun> {
    const row = requireRow(id);
    if (row.status === 'installed') {
      throw skillError('conflict', 'this draft has already been installed');
    }
    if (runner === undefined) {
      throw skillError(
        'invalid_input',
        'dry runs are unavailable - the skill runner is not wired in this build',
      );
    }
    // A dry-run consumes the VALIDATED manifest: without one there is no
    // entrypoint to materialize, and the honest answer is "fix the draft".
    const manifest = parseManifest(row.manifestJson);
    if (manifest === null) {
      throw skillError('invalid_input', 'this draft does not validate - fix it before running it');
    }
    const timeoutMs = runOptions.timeoutMs;
    if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
      throw skillError('invalid_input', 'timeoutMs must be a positive number of milliseconds');
    }

    // A FRESH dir per run: two concurrent dry-runs (or a worker still exiting)
    // cannot collide, and a leftover can never be mistaken for a bundle.
    const dir = join(runsDir, `${row.id}-${randomUUID()}`);
    const logs: string[] = [];
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
      // The manifest's OWN entrypoint name, verbatim: materializing under a
      // different name would fail obscurely at load time.
      writeFileSync(join(dir, manifest.entrypoint), row.code, 'utf8');
      const detail: SkillDetail = {
        id: row.id,
        name: row.name,
        description: row.description,
        author: manifest.author,
        version: manifest.version,
        source: 'authored',
        status: 'installed',
        // '' SKIPS the integrity check on purpose (the runner already treats it
        // as "no baseline"): a draft has no install-time hash, and the bundle
        // was written from the row microseconds ago by this process.
        sha256: '',
        installedAt: row.createdAt,
        updatedAt: row.updatedAt,
        manifest: {
          ...manifest,
          budget: { ...manifest.budget, timeMs: runBudgetMs(manifest, timeoutMs) },
        },
      };
      const result = await runner.invoke(detail, runOptions.args ?? {}, {
        dirOverride: dir,
        // M27 S3: the class the route read off the session row rides into the
        // same broker calls a real invocation makes.
        clientClass: runOptions.clientClass,
        logSink: (line) => {
          logs.push(line);
        },
        // A dry-run is not history: no skill_invocations row. The runner's
        // skill.invoke audit row and the skill.draft.run row below still say
        // that a run happened (ids/counts only, never a log line).
        record: false,
      });
      const ms = result.meta.ms ?? 0;
      audit.log('web', 'skill.draft.run', row.id, {
        ok: result.ok,
        error: result.ok ? null : result.error,
        toolCalls: result.meta.toolCalls,
        ms,
      });
      return result.ok
        ? { ok: true, result: result.result, logs, ms }
        : { ok: false, error: String(result.error), logs, ms };
    } finally {
      // The materialized bundle is scratch: nothing about it outlives the run.
      await wipeRunDir(dir);
    }
  }

  /** M26 D12 export: the draft's own bytes as an unsigned bundle. */
  function exportBundle(id: string): SkillBundle {
    const row = requireRow(id);
    const bundle: SkillBundle = { version: 1, manifestText: row.manifestText, code: row.code };
    // A LENGTH, never the code (repo audit rule).
    audit.log('web', 'skill.draft.export', id, {
      version: bundle.version,
      codeBytes: Buffer.byteLength(row.code, 'utf8'),
    });
    return bundle;
  }

  /**
   * M26 D12 import: an unsigned bundle, and nothing else. Two properties are
   * the whole point:
   *
   *   1. It NEVER installs. No install path is reachable from here, so a bundle
   *      has no privileged door into the skills store and signing can be added
   *      later without touching the trust model.
   *   2. The manifest is RE-POINTED at the new slug, exactly as `fork` does.
   *      Otherwise a bundle could name an INSTALLED skill's id while declaring
   *      the same permission set, and promoting the draft would replace that
   *      skill's code with no consent diff to show (D6 only asks about a
   *      WIDENED set) - an import would be an install with its consent step
   *      skipped.
   */
  function importBundle(bundle: unknown): SkillDraft {
    if (bundle === null || typeof bundle !== 'object' || Array.isArray(bundle)) {
      throw skillError('invalid_input', 'a bundle must be a JSON object');
    }
    const value = bundle as { version?: unknown; manifestText?: unknown; code?: unknown };
    if (value.version !== 1) {
      throw skillError('invalid_input', 'bundle version must be 1');
    }
    if (typeof value.manifestText !== 'string' || typeof value.code !== 'string') {
      throw skillError('invalid_input', 'a bundle must carry manifestText and code as strings');
    }
    if (value.manifestText.trim() === '' || value.code.trim() === '') {
      throw skillError('invalid_input', 'a bundle must carry a manifest and an entry source');
    }
    // The same caps as any other draft write: a bundle is not a way around them.
    if (Buffer.byteLength(value.manifestText, 'utf8') > MAX_TEXT_BYTES) {
      throw skillError('invalid_input', 'bundle manifest text is too large');
    }
    if (Buffer.byteLength(value.code, 'utf8') > MAX_CODE_BYTES) {
      throw skillError('invalid_input', 'bundle entry source is too large');
    }

    const at = now();
    // A bundle whose manifest does not parse still imports as a DRAFT (its text
    // is kept verbatim and validation says why): refusing it here would lock the
    // owner out of the case import exists for, a bundle that needs fixing.
    const parsed = parseManifest(value.manifestText);
    const rawName = typeof parsed?.name === 'string' ? parsed.name.trim() : '';
    const name = rawName === '' ? 'Imported skill' : rawName;
    const id = allocateId(parsed?.id ?? '', name);
    const manifestText =
      parsed === null ? value.manifestText : JSON.stringify({ ...parsed, id }, null, 2);
    const { manifest, validation } = validateParts(manifestText, value.code, at);
    store.insert({
      id,
      name,
      description: typeof parsed?.description === 'string' ? parsed.description : '',
      status: 'draft',
      origin: 'import',
      manifestJson: manifest === null ? null : JSON.stringify(manifest),
      manifestText,
      code: value.code,
      prompt: '',
      model: null,
      validationJson: JSON.stringify(validation),
      conversationId: null,
      personaId: null,
      installedVersion: null,
      // A bundle import brings manifest text + code, never a graph (D7).
      flowJson: null,
      flowSha256: null,
      flowCompiledAt: null,
      createdAt: at,
      updatedAt: at,
    });
    audit.log('web', 'skill.draft.import', id, {
      version: 1,
      codeBytes: Buffer.byteLength(value.code, 'utf8'),
    });
    return detail(requireRow(id));
  }

  /**
   * Promote a draft — the SINGLE install path (M26 D2b: the Studio button and
   * the approved chat card both land here, so they cannot diverge).
   */
  function promote(id: string, promoteOptions: PromoteOptions = {}): SkillDraftInstallResult {
    const row = requireRow(id);
    if (row.status === 'installed') {
      throw skillError('conflict', 'this draft has already been installed');
    }
    const at = now();
    const { manifest, validation } = validateParts(row.manifestText, row.code, at);
    store.update(id, {
      manifestJson: manifest === null ? null : JSON.stringify(manifest),
      validationJson: JSON.stringify(validation),
      updatedAt: at,
    });
    if (manifest === null || !validation.ok) {
      throw skillError(
        'invalid_input',
        `this draft does not validate: ${validation.errors[0] ?? 'unknown problem'}`,
      );
    }

    const existing = skills.get(manifest.id);
    const diff = permissionDiff(existing?.manifest ?? null, manifest);
    if (diff.length > 0 && promoteOptions.acknowledgePermissions !== true) {
      throw skillError(
        'permission_change',
        `this install widens the skill's permissions (${diff
          .map((entry) => entry.field)
          .join(', ')}) — review and confirm`,
      );
    }

    const summary = skills.installFromBundle(
      { manifest, code: row.code },
      { update: existing !== null, source: 'authored' },
    );
    store.update(id, {
      status: 'installed',
      installedVersion: manifest.version,
      updatedAt: now(),
    });
    audit.log('web', 'skill.draft.install', id, {
      mode: existing === null ? 'created' : 'updated',
      version: manifest.version,
      acked: diff.length > 0,
      via: promoteOptions.via ?? 'studio',
    });
    return { skill: summary, mode: existing === null ? 'created' : 'updated', permissionDiff: diff };
  }

  /**
   * M28 cut B (D6): the flow document + its derived staleness. Read-only, and
   * it never compiles anything — asking "is this stale" must not have the side
   * effect of making it not stale.
   */
  function getFlow(id: string): SkillFlowState {
    return flowStateOf(requireRow(id), compareOptions);
  }

  /**
   * M28 cut B: the canvas save. Structural validation only (`validateFlow`, the
   * slice-A door), so a half-drawn graph is refused by name and NOTHING is
   * written — while a well-formed graph that a compile would refuse later (no
   * output node yet, a cycle mid-edit) still saves, because drawing is not
   * compiling.
   *
   * What this deliberately does NOT do: touch `code`, or the permissions derived
   * from the graph. Those change in exactly one place — `compileFlow` below — so
   * there is no way to make a draft runnable by saving a graph.
   */
  function saveFlow(id: string, raw: unknown): SkillFlowSaveResult {
    const row = requireRow(id);
    if (row.status === 'installed') {
      throw skillError('conflict', 'this draft has already been installed');
    }
    const validated = validateFlow(raw);
    if (!validated.ok) return { ok: false, errors: validated.errors, warnings: validated.warnings };

    const at = now();
    const flowJson = JSON.stringify(validated.flow);
    store.update(id, { flowJson, updatedAt: at });
    // Counts + a boolean, never the graph (repo audit rule). `stale` is the
    // draft's derived state AFTER the save, which a save cannot change: it is a
    // fact about the code, and the code did not move.
    audit.log('web', 'skill.flow.save', id, {
      nodes: validated.flow.nodes.length,
      edges: validated.flow.edges.length,
      stale: flowStaleFor({ ...row, flowJson }, validated.flow, compareOptions),
    });
    return { ok: true, ...flowStateOf(requireRow(id), compareOptions) };
  }

  /**
   * M28 cut B (D1/D5) — compile the stored flow into the draft's `code`.
   *
   * The order is the whole design:
   *   1. the flow must exist and must COMPILE (the compiler is total, so every
   *      failure is a named error and nothing is written) — which includes D5's
   *      `tool_requires_medium` ceiling, supplied from the draft's own manifest,
   *      so a graph reaching above what that manifest could ever call is refused
   *      instead of becoming an installed bundle that always refuses at run time;
   *   2. the manifest's derived permissions are rewritten from the graph —
   *      `tools` AND `llm`, because deriving only the tools leaves a flow with
   *      an `llm` node installing a manifest that refuses every model call
   *      (`llm_not_declared`), a bundle that can never run (D5);
   *   3. `code`, `flow_sha256` and `flow_compiled_at` are written together, so
   *      the hash the staleness comparison reads always describes the code
   *      beside it;
   *   4. the M26 validation is re-run, so a compile cannot leave a draft whose
   *      stored validation (or manifest JSON) disagrees with what is now in it.
   *      A compile that produces a draft which fails that validation still
   *      returns OK: the compile did exactly what it promised, and the draft
   *      now REPORTS its problem instead of hiding it.
   */
  function compileFlow(id: string): SkillFlowCompileResponse {
    const row = requireRow(id);
    if (row.status === 'installed') {
      throw skillError('conflict', 'this draft has already been installed');
    }
    const flow = parseFlow(row.flowJson);
    if (flow === null) {
      throw skillError('invalid_input', 'this draft has no flow — save one before compiling it');
    }

    // The manifest is the owner's own text; only its permissions are derived
    // here, but its RISK CEILING is an INPUT to the compile (D5). An unreadable
    // manifest cannot be reconciled with the graph, so the compile is refused
    // BEFORE anything is written rather than inventing one.
    const manifest = parseJsonObject(row.manifestText);
    if (manifest === null) {
      throw skillError(
        'invalid_input',
        "this draft's manifest is not a JSON object — fix it before compiling a flow into it",
      );
    }
    const declaredPermissions = manifest.permissions;
    const permissions =
      declaredPermissions !== null &&
      typeof declaredPermissions === 'object' &&
      !Array.isArray(declaredPermissions)
        ? (declaredPermissions as Record<string, unknown>)
        : {};
    // A missing or unreadable risk gets the STRICTEST ceiling rather than no
    // check at all — the same default the manifest validator applies (`low`).
    const declaredRisk = permissions.risk;
    const riskCeiling: ToolRisk =
      declaredRisk === 'medium' || declaredRisk === 'high' ? declaredRisk : 'low';

    const compiled = compileSkillFlow(flow, {
      registry: tools,
      // D9's "only offer what exists", enforced at the door: a build with no
      // model reach refuses an `llm` node instead of emitting a call that would
      // fail at run time.
      llmAvailable: capabilities.llm,
      // D5's ceiling, supplied from THIS draft's manifest: without it the
      // compiler would happily emit a call the manifest's own `permissions.tools`
      // refuses, so the bundle would install and then fail every run — the same
      // "compiles but is guaranteed to refuse" class as `llm_not_available`.
      riskCeiling,
      riskOf: options.riskOf,
    });
    const nodes = flow.nodes.length;
    const edges = flow.edges.length;
    if (!compiled.ok) {
      audit.log('web', 'skill.flow.compile', id, {
        ok: false,
        nodes,
        edges,
        tools: [],
        errorCount: compiled.errors.length,
        codeBytes: 0,
      });
      return { ok: false, errors: compiled.errors, warnings: compiled.warnings };
    }

    // The manifest is the owner's own text; only its permissions are derived
    // here — `tools` and `llm` — and they were read above, before the compile.
    //
    // `llm` is written as a boolean in BOTH directions: an absent/false value is
    // what the manifest already means, and writing it keeps the derived set and
    // the graph visibly equal (an unused `llm: true` grant on a graph with no
    // `llm` node is exactly the drift D5 exists to prevent).
    const manifestText = JSON.stringify(
      {
        ...manifest,
        permissions: { ...permissions, tools: compiled.tools, llm: compiled.usesLlm },
      },
      null,
      2,
    );

    const at = now();
    const { manifest: normalised, validation } = validateParts(manifestText, compiled.code, at);
    store.update(id, {
      manifestText,
      manifestJson: normalised === null ? null : JSON.stringify(normalised),
      code: compiled.code,
      flowSha256: compiled.sha256,
      flowCompiledAt: at,
      validationJson: JSON.stringify(validation),
      updatedAt: at,
    });
    audit.log('web', 'skill.flow.compile', id, {
      ok: true,
      nodes,
      edges,
      // Tool IDS, never the graph or the code — the repo's audit vocabulary
      // allows ids/counts/lengths and nothing else.
      tools: compiled.tools,
      errorCount: 0,
      codeBytes: Buffer.byteLength(compiled.code, 'utf8'),
    });
    return { ...compiled, draft: detail(requireRow(id)) };
  }

  /**
   * M28 D (D8): the refine PROPOSAL. Writes nothing, ever — the draft row after
   * this call is byte-identical to the row before it (asserted in the tests),
   * which is what makes "the model cannot restructure the graph behind your
   * back" a structural fact rather than a promise.
   *
   * Three refusals, each named, and all three write nothing:
   *   - the draft is already installed (`conflict`), like every other write here;
   *   - there is no flow to refine (`invalid_input`) — the Flow surface does not
   *     exist for a code-authored draft (D7), so there is nothing to propose
   *     against;
   *   - the instruction is empty, or this build has no flow model wired.
   *
   * A model that answers with something the core cannot read is NOT an
   * exception: it comes back as `{ok:false}` with a sentence (and the named
   * errors when the reply was a flow that failed validation), because the
   * request succeeded in determining the answer.
   */
  async function refineFlow(id: string, instruction: string): Promise<SkillFlowProposalResponse> {
    const row = requireRow(id);
    if (row.status === 'installed') {
      throw skillError('conflict', 'this draft has already been installed');
    }
    const flow = parseFlow(row.flowJson);
    if (flow === null) {
      throw skillError(
        'invalid_input',
        'this draft has no flow to refine — draw one on the Flow tab first',
      );
    }
    const text = typeof instruction === 'string' ? instruction.trim() : '';
    if (text === '') throw skillError('invalid_input', 'an instruction is required');
    const flowAi = options.flowAi;
    if (flowAi === undefined) {
      throw skillError(
        'invalid_input',
        'refining a flow needs a model provider, and this build has none wired',
      );
    }

    const outcome = await flowAi.refine({
      flow,
      instruction: text,
      toolIds: [...tools],
      llmAvailable: capabilities.llm === true,
    });
    if (!outcome.ok) {
      // Counts only: the instruction and the graph never reach the audit trail.
      audit.log('web', 'skill.flow.refine', id, {
        ok: false,
        nodesAdded: 0,
        nodesRemoved: 0,
        nodesChanged: 0,
        edgesChanged: 0,
        model: null,
      });
      return { ok: false, error: outcome.message, errors: [], warnings: [] };
    }

    // The hook validated the reply through the schema door; this is the second,
    // independent check, because a proposal is one accepted click away from
    // being stored and the door must not depend on the caller having used it.
    const validated = validateFlow(outcome.flow);
    if (!validated.ok) {
      audit.log('web', 'skill.flow.refine', id, {
        ok: false,
        nodesAdded: 0,
        nodesRemoved: 0,
        nodesChanged: 0,
        edgesChanged: 0,
        model: outcome.model,
      });
      return {
        ok: false,
        error: 'the model proposed a graph the core refuses',
        errors: validated.errors,
        warnings: validated.warnings,
      };
    }

    const diff = diffFlows(flow, validated.flow);
    audit.log('web', 'skill.flow.refine', id, {
      ok: true,
      nodesAdded: diff.nodesAdded.length,
      nodesRemoved: diff.nodesRemoved.length,
      nodesChanged: diff.nodesChanged.length,
      edgesChanged: diff.edgesChanged,
      model: outcome.model,
    });
    const proposal: SkillFlowProposal = {
      flow: validated.flow,
      diff,
      model: outcome.model,
      warnings: [...outcome.warnings, ...validated.warnings],
    };
    return { ok: true, proposal };
  }

  /**
   * M28 D (D7): the DECLARED-LOSSY `from-code` conversion, as a proposal.
   *
   * It is not a decompiler and never claims to be one: there is no read of the
   * entry source by the core at all — the model is handed the code and asked to
   * guess at intent, and the answer is a proposal the owner accepts or rejects
   * by name (the UI's button says "lossy").
   *
   * The diff is measured against the draft's CURRENT flow when it has one, and
   * against the EMPTY graph when it does not — so a code-authored draft's first
   * proposal reads as "everything here is new", which is the honest reading.
   */
  async function flowFromCode(id: string): Promise<SkillFlowProposalResponse> {
    const row = requireRow(id);
    if (row.status === 'installed') {
      throw skillError('conflict', 'this draft has already been installed');
    }
    const flowAi = options.flowAi;
    if (flowAi === undefined) {
      throw skillError(
        'invalid_input',
        'turning code into a flow needs a model provider, and this build has none wired',
      );
    }
    const outcome = await flowAi.fromCode({
      code: row.code,
      manifestText: row.manifestText,
      toolIds: [...tools],
      llmAvailable: capabilities.llm === true,
    });
    if (!outcome.ok) {
      audit.log('web', 'skill.flow.fromCode', id, {
        ok: false,
        nodes: 0,
        edges: 0,
        model: null,
      });
      return { ok: false, error: outcome.message, errors: [], warnings: [] };
    }
    const validated = validateFlow(outcome.flow);
    if (!validated.ok) {
      audit.log('web', 'skill.flow.fromCode', id, {
        ok: false,
        nodes: 0,
        edges: 0,
        model: outcome.model,
      });
      return {
        ok: false,
        error: 'the model returned a graph the core refuses',
        errors: validated.errors,
        warnings: validated.warnings,
      };
    }
    const before = parseFlow(row.flowJson) ?? EMPTY_FLOW;
    const diff = diffFlows(before, validated.flow);
    audit.log('web', 'skill.flow.fromCode', id, {
      ok: true,
      nodes: validated.flow.nodes.length,
      edges: validated.flow.edges.length,
      model: outcome.model,
    });
    const proposal: SkillFlowProposal = {
      flow: validated.flow,
      diff,
      model: outcome.model,
      warnings: [...outcome.warnings, ...validated.warnings],
    };
    return { ok: true, proposal };
  }

  /**
   * M28 D: a plain-language walkthrough of the graph, for the OWNER's eyes.
   *
   * It writes nothing and audits NOTHING: the milestone's audit vocabulary names
   * four rows (save, compile, refine, fromCode) and an explanation is not a
   * state change — it is the same graph said in words. The warnings are the
   * graph's own structural warnings, so a merge whose declared keys do not match
   * its inbound edges is visible next to the prose about it.
   */
  async function explainFlow(id: string): Promise<SkillFlowExplainResponse> {
    const row = requireRow(id);
    const flow = parseFlow(row.flowJson);
    if (flow === null) {
      throw skillError('invalid_input', 'this draft has no flow to explain');
    }
    const flowAi = options.flowAi;
    if (flowAi === undefined) {
      throw skillError(
        'invalid_input',
        'explaining a flow needs a model provider, and this build has none wired',
      );
    }
    const validated = validateFlow(flow);
    const outcome = await flowAi.explain({
      flow,
      toolIds: [...tools],
      llmAvailable: capabilities.llm === true,
    });
    if (!outcome.ok) return { ok: false, error: outcome.message };
    return {
      ok: true,
      text: outcome.text,
      model: outcome.model,
      warnings: validated.ok ? validated.warnings : [],
    };
  }

  function templates(): Array<{ id: string; name: string; description: string; reach: string }> {
    // Derived from what the runtime can honour, so a template can never produce
    // a bundle the sandbox would refuse (M26 D9).
    return availableTemplates(capabilities).map((template) => ({
      id: template.id,
      name: template.name,
      description: template.description,
      reach: template.reach,
    }));
  }

  return {
    list,
    get,
    create,
    update,
    validate,
    discard,
    stageFromChat,
    requestInstall,
    fork,
    edit,
    promote,
    templates,
    getFlow,
    saveFlow,
    compileFlow,
    refineFlow,
    flowFromCode,
    explainFlow,
    stageFlowFromChat,
    runDraft,
    exportBundle,
    importBundle,
  };
}
