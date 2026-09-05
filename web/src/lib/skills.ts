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
  SkillDetail,
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
