/**
 * M8 skills API client (PLAN-M8.md).
 *
 * Follows the M0–M7 chokepoint rules exactly (see lib/api.ts): the pairing
 * token travels ONLY as `Authorization: Bearer …`; the transport is
 * injectable for tests; non-2xx maps to ApiRequestError with a readable
 * message unless it carries a recognized coded invocation failure.
 *
 * Redaction discipline (unchanged): skill CODE and skill LOGS are developer
 * content — this client never receives them, and it never logs args or
 * results. Invocation args are sent to the core once as user data; invoke
 * RESULTS are returned to the owner's UI only. The audit row lives in the
 * core as ids/versions/counts; nothing here writes or echoes content.
 *
 * Envelope tolerance: the core serializes each list either bare or under a
 * key; this client accepts both so web stays robust to either spelling of
 * the same contract. Wire types (SkillSummary, SkillDetail, CatalogSkill,
 * SkillInvocationMeta, …) live in shared/src/skills.ts.
 */

import {
  ApiRequestError,
  expectJson,
  expectNoContent,
  extractErrorMessage,
  type FetchLike,
} from './api.js';
import type {
  CatalogSkill,
  FlowValidationError,
  SkillBundle,
  SkillDetail,
  SkillDraft,
  SkillDraftCreateInput,
  SkillDraftInstallResult,
  SkillDraftRun,
  SkillDraftSummary,
  SkillFlow,
  SkillFlowCompileResponse,
  SkillFlowExplainResponse,
  SkillFlowProposalResponse,
  SkillFlowSaveResult,
  SkillFlowState,
  SkillInvocationMeta,
  SkillInvokeInput,
  SkillSummary,
} from '@partner/shared';

const SKILLS_PATH = '/v1/skills';

export type { FetchLike };

/** Coded invocation failures the core returns (PLAN-M8.md core API). */
export const INVOCATION_ERROR_CODES = [
  'not_found',
  'disabled',
  'budget_exceeded',
  'crashed',
  'denied',
  'tool_denied',
  'caps_exceeded',
  'skill_error',
  'aborted',
  'integrity',
  'persona_paused',
  'no_provider',
] as const;

export type InvocationErrorCode = (typeof INVOCATION_ERROR_CODES)[number];

/** Outcome of POST /v1/skills/:id/invoke. */
export type SkillInvokeResult =
  | { ok: true; result: unknown }
  | { ok: false; code: InvocationErrorCode; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function skillPath(id: string, suffix = ''): string {
  return `${SKILLS_PATH}/${encodeURIComponent(id)}${suffix}`;
}

/** Pull a skill row out of a bare object or a `{skill: …}` envelope. */
function unwrapSkill(value: unknown): unknown {
  if (isRecord(value) && isRecord(value.skill)) return value.skill;
  return value;
}

/** Minimal guard for a wire SkillSummary-ish row (id + status). */
function isSummaryRow(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    typeof value.status === 'string'
  );
}

/** Tolerant parse of one installed row (summary or full detail). */
function parseSummary(value: unknown, status: number): SkillSummary {
  const row = unwrapSkill(value);
  if (!isSummaryRow(row)) {
    throw new ApiRequestError(status, 'The skills response had an unexpected shape.');
  }
  return row as unknown as SkillSummary;
}

/** Tolerant parse of a list response: a bare array or a {key: […]} envelope. */
function parseList<T>(parsed: unknown, keys: readonly string[], noun: string, status: number): T[] {
  if (Array.isArray(parsed)) return parsed as T[];
  if (isRecord(parsed)) {
    for (const key of keys) {
      if (Array.isArray(parsed[key])) return parsed[key] as T[];
    }
  }
  throw new ApiRequestError(status, `The ${noun} response had an unexpected shape.`);
}

async function getList<T>(
  token: string,
  path: string,
  keys: readonly string[],
  noun: string,
  options: { fetchImpl?: FetchLike },
): Promise<T[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(path, {
    method: 'GET',
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
  });
  return parseList<T>(await expectJson<unknown>(response), keys, noun, response.status);
}

// ---------------------------------------------------------------------------
// Installed skills
// ---------------------------------------------------------------------------

/** GET /v1/skills -> installed skill summaries. */
export async function listSkills(
  token: string,
  options: { fetchImpl?: FetchLike } = {},
): Promise<SkillSummary[]> {
  return getList<SkillSummary>(token, SKILLS_PATH, ['skills', 'installed'], 'skills', options);
}

/** GET /v1/skills/catalog -> the local catalog listing (read-only). */
export async function listCatalog(
  token: string,
  options: { fetchImpl?: FetchLike } = {},
): Promise<CatalogSkill[]> {
  return getList<CatalogSkill>(
    token,
    `${SKILLS_PATH}/catalog`,
    ['skills', 'catalog'],
    'catalog',
    options,
  );
}

/**
 * POST /v1/skills/install {catalogId} -> the installed row. The core
 * validates the manifest, copies the code and records the sha256; a 409 is
 * the already-installed conflict (thrown as ApiRequestError so callers can
 * distinguish it). A 204/empty 2xx means "installed" without a body — the
 * caller refetches the list.
 */
export async function installSkill(
  token: string,
  catalogId: string,
  options: { fetchImpl?: FetchLike } = {},
): Promise<SkillSummary | null> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(`${SKILLS_PATH}/install`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({ catalogId }),
  });
  if (response.status === 204) return null;
  return parseSummary(await expectJson<unknown>(response), response.status);
}

/** GET /v1/skills/:id -> full detail (manifest + permissions summary). */
export async function getSkill(
  token: string,
  id: string,
  options: { fetchImpl?: FetchLike } = {},
): Promise<SkillDetail> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(skillPath(id), {
    method: 'GET',
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
  });
  const parsed = await expectJson<unknown>(response);
  const row = unwrapSkill(parsed);
  if (!isSummaryRow(row) || !isRecord(row.manifest)) {
    throw new ApiRequestError(response.status, 'The skill response had an unexpected shape.');
  }
  return row as unknown as SkillDetail;
}

/**
 * POST /v1/skills/:id/disable|/enable -> the updated row when the core
 * answers with a body, or null on a 204. The UI treats both as success and
 * refetches the list afterwards.
 */
async function setStatus(
  token: string,
  id: string,
  action: 'disable' | 'enable',
  options: { fetchImpl?: FetchLike },
): Promise<SkillSummary | null> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(skillPath(id, `/${action}`), {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
  });
  if (response.status === 204) return null;
  return parseSummary(await expectJson<unknown>(response), response.status);
}

/** POST /v1/skills/:id/disable — stops the skill from being invoked. */
export function disableSkill(
  token: string,
  id: string,
  options: { fetchImpl?: FetchLike } = {},
): Promise<SkillSummary | null> {
  return setStatus(token, id, 'disable', options);
}

/** POST /v1/skills/:id/enable — restores the skill for invocation. */
export function enableSkill(
  token: string,
  id: string,
  options: { fetchImpl?: FetchLike } = {},
): Promise<SkillSummary | null> {
  return setStatus(token, id, 'enable', options);
}

/** DELETE /v1/skills/:id -> 204 (uninstall wipes the skill's store). */
export async function uninstallSkill(
  token: string,
  id: string,
  options: { fetchImpl?: FetchLike } = {},
): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(skillPath(id), {
    method: 'DELETE',
    headers: { authorization: `Bearer ${token}` },
  });
  return expectNoContent(response, 'Uninstalling the skill');
}

// ---------------------------------------------------------------------------
// Invocation
// ---------------------------------------------------------------------------

function isKnownCode(value: unknown): value is InvocationErrorCode {
  return typeof value === 'string' && (INVOCATION_ERROR_CODES as readonly string[]).includes(value);
}

/** Human fallback per coded error (mirrors skill-helpers' label map). */
const INVOCATION_ERROR_LABELS_FOR_CLIENT: Record<InvocationErrorCode, string> = {
  not_found: 'Skill not found',
  disabled: 'Skill is disabled',
  budget_exceeded: 'Budget exceeded — run stopped',
  crashed: 'Skill crashed',
  denied: 'Invocation denied',
  tool_denied: 'A tool request was denied',
  caps_exceeded: 'Result was too large — run stopped',
  skill_error: 'The skill reported an error',
  aborted: 'Run aborted',
  integrity: 'Skill code changed since install — refused',
  persona_paused: 'That persona is paused',
  no_provider: 'No model provider configured',
};


/** Pull {error.code | error | code | message} out of an error body. */
function readFailureParts(parsed: unknown): {
  code: InvocationErrorCode | null;
  message: unknown;
} {
  if (!isRecord(parsed)) return { code: null, message: null };
  if (isRecord(parsed.error)) {
    return {
      code: isKnownCode(parsed.error.code) ? parsed.error.code : null,
      message: parsed.error.message ?? null,
    };
  }
  if (typeof parsed.error === 'string') {
    return { code: isKnownCode(parsed.error) ? parsed.error : null, message: parsed.error };
  }
  return { code: isKnownCode(parsed.code) ? parsed.code : null, message: parsed.message ?? null };
}

/**
 * POST /v1/skills/:id/invoke {args?, personaId?} -> the worker's result.
 *
 * A 2xx body carries `{result}` (the result is JSON-serializable; it is user
 * data returned to the owner's UI only). Coded failures the core documents
 * (`not_found`, `disabled`, `budget_exceeded`, `crashed`, `denied`,
 * `tool_denied`) come back as a typed {ok:false} outcome — recognized codes
 * win even when the HTTP status is ambiguous (e.g. a 403 denied vs a lost
 * session). A 401/403 WITHOUT a coded body means the core session is gone
 * and throws ApiRequestError, exactly like every other client.
 */
export async function invokeSkill(
  token: string,
  id: string,
  input: SkillInvokeInput = {},
  options: { fetchImpl?: FetchLike } = {},
): Promise<SkillInvokeResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const body: Record<string, unknown> = {};
  if (input.args !== undefined) body.args = input.args;
  if (input.personaId !== undefined && input.personaId !== null) body.personaId = input.personaId;
  const response = await fetchImpl(skillPath(id, '/invoke'), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    // Buffer the body once: it may carry a recognized coded failure, and it
    // is the only source for the fallback error text.
    const text = await response.text();
    let parsed: unknown = null;
    try {
      parsed = text.length > 0 ? (JSON.parse(text) as unknown) : null;
    } catch {
      // Non-JSON failure — fall through to the generic mapping.
    }
    const { code, message } = readFailureParts(parsed);
    if (code !== null) {
      const fallback = INVOCATION_ERROR_LABELS_FOR_CLIENT[code];
      const human =
        typeof message === 'string' && message.length > 0 && message !== code
          ? message
          : fallback;
      return { ok: false, code, message: human };
    }
    throw new ApiRequestError(response.status, extractErrorMessage(text, response.status));
  }

  const parsed = await expectJson<unknown>(response);
  if (isRecord(parsed) && 'result' in parsed) {
    return { ok: true, result: parsed.result };
  }
  // The core answers runner outcomes (tool_denied/budget_exceeded/crashed/
  // caps_exceeded/...) as HTTP 200 {ok:false, error, meta} — map those here
  // so the console can render the real code (M8 review finding 1).
  if (isRecord(parsed) && parsed.ok === false && typeof parsed.error === 'string') {
    const code = isKnownCode(parsed.error) ? parsed.error : null;
    if (code !== null) {
      return { ok: false, code, message: INVOCATION_ERROR_LABELS_FOR_CLIENT[code] };
    }
  }
  throw new ApiRequestError(response.status, 'The invoke response had an unexpected shape.');
}

// ---------------------------------------------------------------------------
// Recent invocations (metadata only — ids/timestamps/counts/error codes)
// ---------------------------------------------------------------------------

/** GET /v1/skills/:id/invocations -> recent runs of one skill (metadata). */
export async function listInvocations(
  token: string,
  id: string,
  options: { fetchImpl?: FetchLike } = {},
): Promise<SkillInvocationMeta[]> {
  return getList<SkillInvocationMeta>(
    token,
    skillPath(id, '/invocations'),
    ['invocations', 'items'],
    'invocations',
    options,
  );
}

// ---------------------------------------------------------------------------
// M26 skill authoring — drafts (PLAN-M26.md cut D)
//
// A draft is INERT: listing it, reading it, validating it and editing it run
// nothing. The two calls that DO something are separate and owner-initiated —
// `runDraft` (a sandboxed dry-run the owner asks for) and `installDraft` (the
// one door into the skills store).
//
// Redaction discipline: a draft's `manifestText` and `code` are the OWNER's own
// content. They travel from the core to this UI and are rendered for the owner
// only; this client never logs them, never puts them in a URL, and the install
// consent (M26 D6) is the only place a permission set is negotiated.
// ---------------------------------------------------------------------------

const DRAFTS_PATH = `${SKILLS_PATH}/drafts`;

/** One Studio template (M26): a complete bundle the core builds offline. */
export interface SkillTemplateSummary {
  id: string;
  name: string;
  description: string;
  /** Plain-language line: what the template's skill can reach, and what not. */
  reach: string;
}

/** Pull a draft row out of a bare object or a `{draft: …}` envelope. */
function unwrapDraft(value: unknown): unknown {
  if (isRecord(value) && isRecord(value.draft)) return value.draft;
  return value;
}

/** Minimal guard for a wire draft row (id + name + a validation record). */
function isDraftRow(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    isRecord(value.validation)
  );
}

/** Tolerant parse of one draft (summary or full detail). */
function parseDraft(value: unknown, status: number): SkillDraft {
  const row = unwrapDraft(value);
  if (!isDraftRow(row)) {
    throw new ApiRequestError(status, 'The draft response had an unexpected shape.');
  }
  return row as unknown as SkillDraft;
}

/** POST/PUT helpers that send a JSON body and parse one draft back. */
async function writeDraft(
  token: string,
  path: string,
  method: 'POST' | 'PUT',
  body: unknown,
  options: { fetchImpl?: FetchLike },
): Promise<SkillDraft> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(path, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify(body),
  });
  return parseDraft(await expectJson<unknown>(response), response.status);
}

/** GET /v1/skills/drafts -> draft SUMMARIES, newest first (no code). */
export async function listDrafts(
  token: string,
  options: { fetchImpl?: FetchLike } = {},
): Promise<SkillDraftSummary[]> {
  return getList<SkillDraftSummary>(token, DRAFTS_PATH, ['drafts'], 'draft', options);
}

/** GET /v1/skills/drafts/:id -> the full draft, including its editable source. */
export async function getDraft(
  token: string,
  id: string,
  options: { fetchImpl?: FetchLike } = {},
): Promise<SkillDraft> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(`${DRAFTS_PATH}/${encodeURIComponent(id)}`, {
    method: 'GET',
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
  });
  return parseDraft(await expectJson<unknown>(response), response.status);
}

/**
 * POST /v1/skills/drafts -> a new draft (201). `mode: 'generate'` costs one
 * bounded model call and needs a configured provider; the core answers a coded
 * refusal when it has none, which the Studio renders as its honest line rather
 * than as a failure of the draft itself.
 */
export async function createDraft(
  token: string,
  input: SkillDraftCreateInput,
  options: { fetchImpl?: FetchLike } = {},
): Promise<SkillDraft> {
  return writeDraft(token, DRAFTS_PATH, 'POST', input, options);
}

/** Patch shape of PUT /v1/skills/drafts/:id — every field optional. */
export interface DraftPatchInput {
  name?: string;
  description?: string;
  /** Raw manifest text; the core re-parses and re-validates it. */
  manifestText?: string;
  code?: string;
}

/**
 * PUT /v1/skills/drafts/:id -> the re-validated draft. The core refuses a write
 * to an already-installed draft with 409 (thrown), which the Studio shows as a
 * named reason instead of retrying.
 */
export async function updateDraft(
  token: string,
  id: string,
  patch: DraftPatchInput,
  options: { fetchImpl?: FetchLike } = {},
): Promise<SkillDraft> {
  return writeDraft(token, `${DRAFTS_PATH}/${encodeURIComponent(id)}`, 'PUT', patch, options);
}

/** POST /v1/skills/drafts/:id/validate -> the deterministic result. Never runs it. */
export async function validateDraft(
  token: string,
  id: string,
  options: { fetchImpl?: FetchLike } = {},
): Promise<SkillDraft> {
  return writeDraft(
    token,
    `${DRAFTS_PATH}/${encodeURIComponent(id)}/validate`,
    'POST',
    {},
    options,
  );
}

/**
 * Coded refusals the promote route documents (M26 D6). They arrive as a typed
 * outcome rather than an exception, because each one has a NEXT STEP the owner
 * can take — above all `permission_change`: review the before/after table and
 * confirm, which is precisely not a dead end.
 */
export const DRAFT_INSTALL_ERROR_CODES = [
  'permission_change',
  'invalid_input',
  'conflict',
  'not_found',
] as const;

export type DraftInstallErrorCode = (typeof DRAFT_INSTALL_ERROR_CODES)[number];

/** Outcome of POST /v1/skills/drafts/:id/install. */
export type DraftInstallOutcome =
  | { ok: true; result: SkillDraftInstallResult }
  | { ok: false; code: DraftInstallErrorCode; message: string };

function isDraftInstallCode(value: unknown): value is DraftInstallErrorCode {
  return (
    typeof value === 'string' &&
    (DRAFT_INSTALL_ERROR_CODES as readonly string[]).includes(value)
  );
}

/** Pull the coded refusal out of `{error, message}` / `{error: {code}}`. */
function readDraftInstallFailure(parsed: unknown): {
  code: DraftInstallErrorCode | null;
  message: string | null;
} {
  if (!isRecord(parsed)) return { code: null, message: null };
  const nested = isRecord(parsed.error) ? parsed.error : null;
  const code = nested !== null ? nested.code : parsed.error;
  const message = nested !== null ? nested.message : parsed.message;
  return {
    code: isDraftInstallCode(code) ? code : null,
    message: typeof message === 'string' && message.length > 0 ? message : null,
  };
}

/**
 * POST /v1/skills/drafts/:id/install -> the installed skill + the install mode.
 *
 * `acknowledgePermissions` is sent by the caller that has ALREADY shown the
 * before/after table; the core refuses a widened permission set without it
 * (409 `permission_change`, returned here as `{ok:false, code}` so the UI can
 * say "review the change and confirm"). A 401/403 without a coded body still
 * throws ApiRequestError — that is a lost session, not a decision.
 */
export async function installDraft(
  token: string,
  id: string,
  input: { acknowledgePermissions?: boolean } = {},
  options: { fetchImpl?: FetchLike } = {},
): Promise<DraftInstallOutcome> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const body: Record<string, unknown> = {};
  if (input.acknowledgePermissions === true) body.acknowledgePermissions = true;
  const response = await fetchImpl(`${DRAFTS_PATH}/${encodeURIComponent(id)}/install`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await response.text();
    let parsed: unknown = null;
    try {
      parsed = text.length > 0 ? (JSON.parse(text) as unknown) : null;
    } catch {
      // Non-JSON failure — the generic mapping below reports it.
    }
    const failure = readDraftInstallFailure(parsed);
    if (failure.code !== null) {
      return {
        ok: false,
        code: failure.code,
        message: failure.message ?? 'The install was refused.',
      };
    }
    throw new ApiRequestError(response.status, extractErrorMessage(text, response.status));
  }
  const parsed = await expectJson<unknown>(response);
  if (!isRecord(parsed) || !isRecord(parsed.skill) || typeof parsed.mode !== 'string') {
    throw new ApiRequestError(response.status, 'The install response had an unexpected shape.');
  }
  return { ok: true, result: parsed as unknown as SkillDraftInstallResult };
}

/** DELETE /v1/skills/drafts/:id -> 204 (the draft and its code are gone). */
export async function discardDraft(
  token: string,
  id: string,
  options: { fetchImpl?: FetchLike } = {},
): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(`${DRAFTS_PATH}/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${token}` },
  });
  return expectNoContent(response, 'Discarding the draft');
}

/**
 * POST /v1/skills/drafts/:id/run -> a SANDBOXED dry-run (201-free, 200 body).
 * The answer carries the worker's own redacted log lines, which is what makes
 * an import-time crash readable in the Studio instead of an opaque `crashed`.
 * No invocation row is written: a dry-run is not history.
 */
export async function runDraft(
  token: string,
  id: string,
  input: { args?: unknown; timeoutMs?: number } = {},
  options: { fetchImpl?: FetchLike } = {},
): Promise<SkillDraftRun> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const body: Record<string, unknown> = {};
  if (input.args !== undefined) body.args = input.args;
  if (input.timeoutMs !== undefined) body.timeoutMs = input.timeoutMs;
  const response = await fetchImpl(`${DRAFTS_PATH}/${encodeURIComponent(id)}/run`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify(body),
  });
  const parsed = await expectJson<unknown>(response);
  if (!isRecord(parsed) || typeof parsed.ok !== 'boolean') {
    throw new ApiRequestError(response.status, 'The run response had an unexpected shape.');
  }
  return parsed as unknown as SkillDraftRun;
}

/**
 * POST /v1/skills/:id/fork -> a NEW draft copied from an installed skill. The
 * installed skill is untouched; the copy gets a fresh slug and a fresh row.
 */
export async function forkSkill(
  token: string,
  id: string,
  options: { fetchImpl?: FetchLike } = {},
): Promise<SkillDraft> {
  return writeDraft(token, skillPath(id, '/fork'), 'POST', {}, options);
}

/**
 * POST /v1/skills/:id/edit -> a draft BOUND to the installed skill's id, so
 * promoting it updates that skill in place (and its permission diff is the
 * consent the owner sees before any new power is granted).
 */
export async function editSkill(
  token: string,
  id: string,
  options: { fetchImpl?: FetchLike } = {},
): Promise<SkillDraft> {
  return writeDraft(token, skillPath(id, '/edit'), 'POST', {}, options);
}

/** GET /v1/skills/templates -> the templates THIS build can honour. */
export async function listSkillTemplates(
  token: string,
  options: { fetchImpl?: FetchLike } = {},
): Promise<SkillTemplateSummary[]> {
  return getList<SkillTemplateSummary>(
    token,
    `${SKILLS_PATH}/templates`,
    ['templates'],
    'template',
    options,
  );
}

/**
 * POST /v1/skills/drafts/:id/bundle -> the draft's own bytes as an UNSIGNED
 * bundle (M26 D12) for the owner to save. Export is a read of the owner's own
 * content: nothing is installed and no capability is granted by it.
 */
export async function exportDraftBundle(
  token: string,
  id: string,
  options: { fetchImpl?: FetchLike } = {},
): Promise<SkillBundle> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(`${DRAFTS_PATH}/${encodeURIComponent(id)}/bundle`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
  });
  const parsed = await expectJson<unknown>(response);
  if (!isRecord(parsed) || typeof parsed.manifestText !== 'string' || typeof parsed.code !== 'string') {
    throw new ApiRequestError(response.status, 'The bundle response had an unexpected shape.');
  }
  return parsed as unknown as SkillBundle;
}

/**
 * POST /v1/skills/drafts/import -> a NEW INERT draft (201). The core re-points
 * the manifest at a fresh, de-duplicated slug and validates it: an import can
 * never overwrite an installed skill, and nothing runs until the owner tests
 * and installs the draft it produced.
 */
export async function importDraftBundle(
  token: string,
  bundle: unknown,
  options: { fetchImpl?: FetchLike } = {},
): Promise<SkillDraft> {
  return writeDraft(token, `${DRAFTS_PATH}/import`, 'POST', bundle, options);
}

// ---------------------------------------------------------------------------
// M28 — the FLOW surface (PLAN-M28.md)
//
// A flow is an AUTHORING view, never a second artifact: the core compiles it
// deterministically into `code`, and install always consumes that code. These
// six calls are the whole client side of it.
//
// Redaction discipline (unchanged): the flow DOCUMENT is the owner's own
// content, exactly like the entry source beside it. It travels between this
// client and the owner's own core, is never logged here, and never lands in a
// URL. The model round-trips (`refine`, `from-code`, `explain`) send an
// instruction the owner typed and return text for the owner's eyes; nothing
// echoes them into an error string.
// ---------------------------------------------------------------------------

const FLOW_SUFFIX = '/flow';

/** Minimal guard for a flow state row (a flow field + the derived flag). */
function isFlowState(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  return 'flow' in value && typeof value.flowStale === 'boolean';
}

/** The per-node errors a refused save carries (`flowErrors` on the 400). */
function flowErrorsOf(parsed: unknown): FlowValidationError[] {
  if (!isRecord(parsed) || !Array.isArray(parsed.flowErrors)) return [];
  return parsed.flowErrors as FlowValidationError[];
}

function warningsOf(parsed: unknown): FlowValidationError[] {
  if (!isRecord(parsed) || !Array.isArray(parsed.warnings)) return [];
  return parsed.warnings as FlowValidationError[];
}

/** GET /v1/skills/drafts/:id/flow -> the graph + the DERIVED `flowStale` (D6). */
export async function getDraftFlow(
  token: string,
  id: string,
  options: { fetchImpl?: FetchLike } = {},
): Promise<SkillFlowState> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(`${DRAFTS_PATH}/${encodeURIComponent(id)}${FLOW_SUFFIX}`, {
    method: 'GET',
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
  });
  const parsed = await expectJson<unknown>(response);
  if (!isFlowState(parsed)) {
    throw new ApiRequestError(response.status, 'The flow response had an unexpected shape.');
  }
  return parsed as unknown as SkillFlowState;
}

/**
 * PUT /v1/skills/drafts/:id/flow -> the canvas save. A save is NOT a compile:
 * `code` and the permissions derived from the graph are untouched, and a
 * structurally malformed graph answers `{ok:false}` with a per-node error list
 * (the core's 400) instead of throwing — the canvas decorates the offender.
 */
export async function saveDraftFlow(
  token: string,
  id: string,
  flow: SkillFlow,
  options: { fetchImpl?: FetchLike } = {},
): Promise<SkillFlowSaveResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(`${DRAFTS_PATH}/${encodeURIComponent(id)}${FLOW_SUFFIX}`, {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify(flow),
  });
  if (!response.ok) {
    const text = await response.text();
    let parsed: unknown = null;
    try {
      parsed = text.length > 0 ? (JSON.parse(text) as unknown) : null;
    } catch {
      // A non-JSON failure has no per-node errors; the caller reports the status.
    }
    if (isRecord(parsed) && parsed.error === 'invalid_input') {
      return { ok: false, errors: flowErrorsOf(parsed), warnings: warningsOf(parsed) };
    }
    throw new ApiRequestError(response.status, extractErrorMessage(text, response.status));
  }
  const parsed = await expectJson<unknown>(response);
  if (!isRecord(parsed) || parsed.ok !== true || !isFlowState(parsed)) {
    throw new ApiRequestError(response.status, 'The flow save response had an unexpected shape.');
  }
  return parsed as unknown as SkillFlowSaveResult;
}

/**
 * POST /v1/skills/drafts/:id/flow/compile -> D1's ONLY writer of code from a
 * flow. A flow that does not compile answers `ok:false` with named errors and
 * writes nothing (a 200, like `/validate`); a successful compile carries the
 * rewritten draft, because a compile IS a write.
 */
export async function compileDraftFlow(
  token: string,
  id: string,
  options: { fetchImpl?: FetchLike } = {},
): Promise<SkillFlowCompileResponse> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(
    `${DRAFTS_PATH}/${encodeURIComponent(id)}${FLOW_SUFFIX}/compile`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
    },
  );
  const parsed = await expectJson<unknown>(response);
  if (!isRecord(parsed) || typeof parsed.ok !== 'boolean') {
    throw new ApiRequestError(response.status, 'The compile response had an unexpected shape.');
  }
  return parsed as unknown as SkillFlowCompileResponse;
}

/** Read one proposal-or-refusal body (both AI routes answer this shape). */
function readProposal(parsed: unknown, status: number): SkillFlowProposalResponse {
  if (!isRecord(parsed) || typeof parsed.ok !== 'boolean') {
    throw new ApiRequestError(status, 'The flow proposal response had an unexpected shape.');
  }
  return parsed as unknown as SkillFlowProposalResponse;
}

/**
 * POST /v1/skills/drafts/:id/flow/refine -> a PROPOSAL (D8). It writes nothing:
 * the caller renders the diff and only a later `saveDraftFlow` stores it.
 */
export async function refineDraftFlow(
  token: string,
  id: string,
  instruction: string,
  options: { fetchImpl?: FetchLike } = {},
): Promise<SkillFlowProposalResponse> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(
    `${DRAFTS_PATH}/${encodeURIComponent(id)}${FLOW_SUFFIX}/refine`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({ instruction }),
    },
  );
  return readProposal(await expectJson<unknown>(response), response.status);
}

/**
 * POST /v1/skills/drafts/:id/flow/from-code -> D7's declared-LOSSY conversion
 * of the draft's current entry source into a flow, as a proposal. Never
 * applied automatically: the model is guessing at intent.
 */
export async function draftFlowFromCode(
  token: string,
  id: string,
  options: { fetchImpl?: FetchLike } = {},
): Promise<SkillFlowProposalResponse> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(
    `${DRAFTS_PATH}/${encodeURIComponent(id)}${FLOW_SUFFIX}/from-code`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
    },
  );
  return readProposal(await expectJson<unknown>(response), response.status);
}

/** POST /v1/skills/drafts/:id/flow/explain -> a walkthrough, owner's eyes only. */
export async function explainDraftFlow(
  token: string,
  id: string,
  options: { fetchImpl?: FetchLike } = {},
): Promise<SkillFlowExplainResponse> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(
    `${DRAFTS_PATH}/${encodeURIComponent(id)}${FLOW_SUFFIX}/explain`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
    },
  );
  const parsed = await expectJson<unknown>(response);
  if (!isRecord(parsed) || typeof parsed.ok !== 'boolean') {
    throw new ApiRequestError(response.status, 'The explain response had an unexpected shape.');
  }
  return parsed as unknown as SkillFlowExplainResponse;
}
