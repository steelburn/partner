/**
 * M6 theme API client (PLAN-M6.md).
 *
 * Same chokepoint rules as every other client (lib/api.ts): the pairing
 * token travels ONLY as `Authorization: Bearer …`; transport is injectable
 * for tests; non-2xx maps to ApiRequestError with a readable message.
 * Redaction/audit discipline: theme bodies are the user's own tokens (not
 * secrets — the studio shows them back) — but this module still never logs
 * or embeds full bodies in errors; messages carry ids and names at most.
 *
 * Envelope tolerance: every read accepts the payload bare OR wrapped under
 * the conventional key ({themes}, {profile}, {activation}, {active}, …);
 * a 400 save failure carries the core's ThemeReport body inline and is
 * returned as {ok:false, report} instead of throwing, so the studio can
 * render per-token errors.
 */

import { ApiRequestError, expectJson, readErrorMessage, type FetchLike } from './api.js';
import { isThemeTokens } from './theme-helpers.js';
import type {
  ActiveTheme,
  ThemeActivation,
  ThemeMode,
  ThemeProfile,
  ThemeReport,
  ThemeReportIssue,
  ThemeSaveInput,
  ThemeSource,
} from '@partner/shared';

const THEMES_PATH = '/v1/themes';
const ACTIVE_THEME_PATH = '/v1/theme/active';
const PERSONAS_PATH = '/v1/personas';

export type { FetchLike };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSource(value: unknown): value is ThemeSource {
  return value === 'preset' || value === 'custom';
}

function isMode(value: unknown): value is ThemeMode {
  return value === 'light' || value === 'dark';
}

/**
 * Normalize one report issue. Drops rows that do not name a token and a mode
 * with a message (defensive against a half-serialized report).
 */
function normalizeIssue(raw: unknown): ThemeReportIssue | null {
  if (!isRecord(raw)) return null;
  const token = raw.token;
  const message = raw.message;
  const mode = raw.mode;
  if (typeof token !== 'string' || typeof message !== 'string' || !isMode(mode)) return null;
  const issue: ThemeReportIssue = { token, mode, message };
  if (typeof raw.apca === 'number' && Number.isFinite(raw.apca)) issue.apca = raw.apca;
  if (typeof raw.wcag === 'number' && Number.isFinite(raw.wcag)) issue.wcag = raw.wcag;
  return issue;
}

function normalizeIssues(raw: unknown): ThemeReportIssue[] {
  if (!Array.isArray(raw)) return [];
  const out: ThemeReportIssue[] = [];
  for (const entry of raw) {
    const issue = normalizeIssue(entry);
    if (issue !== null) out.push(issue);
  }
  return out;
}

/**
 * Dig a ThemeReport out of any plausible 400 envelope: the bare report
 * ({ok, errors, warnings}), wrapped under {report}, or under the common
 * error envelope {error: {report}} / {error: {...report fields}}. Returns
 * null when the body is not report-shaped (callers then fall back to the
 * generic error message).
 */
export function parseThemeReport(value: unknown): ThemeReport | null {
  if (!isRecord(value)) return null;
  let report: unknown = isRecord(value.report) ? value.report : value;
  if (isRecord(report) && isRecord(report.error)) {
    report = isRecord(report.error.report) ? report.error.report : report.error;
  }
  if (!isRecord(report)) return null;
  const errorsRaw = report.errors;
  const warningsRaw = report.warnings;
  const hasOk = typeof report.ok === 'boolean';
  if (errorsRaw === undefined && warningsRaw === undefined && !hasOk) return null;
  const errors = normalizeIssues(errorsRaw);
  const warnings = normalizeIssues(warningsRaw);
  const ok = hasOk ? (report.ok as boolean) : errors.length === 0;
  return { ok, errors, warnings };
}

/**
 * Normalize a single theme profile (bare, or wrapped under `profile`/`theme`).
 * Throws ApiRequestError when identity/token fields are missing or wrong.
 */
export function parseThemeProfile(value: unknown, status = 200): ThemeProfile {
  if (!isRecord(value)) {
    throw new ApiRequestError(status, 'The theme response had an unexpected shape.');
  }
  const direct = value;
  const enveloped = isRecord(value.profile)
    ? value.profile
    : isRecord(value.theme)
      ? value.theme
      : null;
  const profile = (enveloped ?? direct) as Record<string, unknown>;
  if (
    typeof profile.id !== 'string' ||
    profile.id.length === 0 ||
    typeof profile.name !== 'string' ||
    !isThemeTokens(profile.light) ||
    !isThemeTokens(profile.dark)
  ) {
    throw new ApiRequestError(status, 'The theme response had an unexpected shape.');
  }
  const source: ThemeSource = isSource(profile.source) ? profile.source : 'custom';
  return {
    id: profile.id,
    name: profile.name,
    source,
    light: profile.light,
    dark: profile.dark,
  };
}

/** Normalize a theme list response ({themes: [...]} or a bare array). */
export function parseThemeList(value: unknown, status = 200): ThemeProfile[] {
  const raw = Array.isArray(value) ? value : isRecord(value) && Array.isArray(value.themes) ? value.themes : null;
  if (raw === null) {
    throw new ApiRequestError(status, 'The themes response had an unexpected shape.');
  }
  return raw.map((entry) => parseThemeProfile(entry, status));
}

/** Normalize an activation response ({id, source} bare or under `activation`). */
export function parseActivation(value: unknown, status = 200): ThemeActivation {
  const record = isRecord(value) ? value : null;
  const direct = record;
  const enveloped = record && isRecord(record.activation) ? record.activation : null;
  const activation = (enveloped ?? direct) as Record<string, unknown> | null;
  if (activation === null || typeof activation.id !== 'string' || activation.id.length === 0) {
    throw new ApiRequestError(status, 'The activation response had an unexpected shape.');
  }
  return { id: activation.id, source: isSource(activation.source) ? activation.source : 'custom' };
}

/**
 * Normalize the resolved active theme (bare ActiveTheme, or wrapped under
 * `active`/`theme`). Throws ApiRequestError when tokens are missing.
 */
export function parseActiveTheme(value: unknown, status = 200): ActiveTheme {
  if (!isRecord(value)) {
    throw new ApiRequestError(status, 'The active theme response had an unexpected shape.');
  }
  const direct = value;
  const enveloped = isRecord(value.active)
    ? value.active
    : isRecord(value.theme)
      ? value.theme
      : null;
  const active = (enveloped ?? direct) as Record<string, unknown>;
  if (
    typeof active.themeId !== 'string' ||
    active.themeId.length === 0 ||
    !isThemeTokens(active.light) ||
    !isThemeTokens(active.dark)
  ) {
    throw new ApiRequestError(status, 'The active theme response had an unexpected shape.');
  }
  return {
    themeId: active.themeId,
    source: isSource(active.source) ? active.source : 'custom',
    light: active.light,
    dark: active.dark,
  };
}

/** GET /v1/themes -> presets + saved themes (each with both modes' tokens). */
export async function listThemes(
  token: string,
  options: { fetchImpl?: FetchLike } = {},
): Promise<ThemeProfile[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(THEMES_PATH, {
    method: 'GET',
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
  });
  return parseThemeList(await expectJson<unknown>(response), response.status);
}

export type ThemeSaveResult =
  | { ok: true; profile: ThemeProfile }
  | { ok: false; status: number; report: ThemeReport | null; message: string };

/**
 * Consume a create/update response: 2xx -> {ok:true, profile}; a 400 with a
 * report body -> {ok:false, report} (NOT thrown — the report is the UI's
 * inline feedback); other failures -> thrown ApiRequestError.
 */
async function readSaveResult(response: Response): Promise<ThemeSaveResult> {
  let text = '';
  try {
    text = await response.text();
  } catch {
    text = '';
  }
  if (!response.ok) {
    if (response.status === 400) {
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
      const report = parsed === null ? null : parseThemeReport(parsed);
      return { ok: false, status: response.status, report, message: extractSaveMessage(text, response.status) };
    }
    throw new ApiRequestError(response.status, extractSaveMessage(text, response.status));
  }
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    throw new ApiRequestError(response.status, 'The theme response was empty.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new ApiRequestError(response.status, 'The theme response was not valid JSON.');
  }
  return { ok: true, profile: parseThemeProfile(parsed, response.status) };
}

/** Message text from a save response body (capped, mirrored from api.ts). */
function extractSaveMessage(text: string, status: number): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) return `Request failed (${status}).`;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (isRecord(parsed)) {
      const nested = isRecord(parsed.error) ? parsed.error : null;
      const candidate = nested ?? parsed;
      if (typeof candidate.message === 'string' && candidate.message.length > 0) {
        return candidate.message.length <= 280 ? candidate.message : `${candidate.message.slice(0, 280)}…`;
      }
      if (typeof candidate.error === 'string' && candidate.error.length > 0) {
        return candidate.error.length <= 280 ? candidate.error : `${candidate.error.slice(0, 280)}…`;
      }
    }
  } catch {
    // Not JSON — fall through to the raw (capped) text.
  }
  return trimmed.length <= 280 ? trimmed : `${trimmed.slice(0, 280)}…`;
}

/** POST /v1/themes {name, light, dark} -> profile, or a 400 gate report. */
export async function createTheme(
  token: string,
  input: ThemeSaveInput,
  options: { fetchImpl?: FetchLike } = {},
): Promise<ThemeSaveResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(THEMES_PATH, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify(input),
  });
  return readSaveResult(response);
}

/** PUT /v1/themes/:id (same gate as create). */
export async function updateTheme(
  token: string,
  id: string,
  input: ThemeSaveInput,
  options: { fetchImpl?: FetchLike } = {},
): Promise<ThemeSaveResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(`${THEMES_PATH}/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify(input),
  });
  return readSaveResult(response);
}

/** DELETE /v1/themes/:id -> 204 (refused while active; presets are not deletable). */
export async function deleteTheme(
  token: string,
  id: string,
  options: { fetchImpl?: FetchLike } = {},
): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(`${THEMES_PATH}/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    throw new ApiRequestError(response.status, await readErrorMessage(response));
  }
}

/**
 * POST /v1/themes/:id/activate -> the activation {id, source}; null when the
 * core answers 204 no-content (callers treat both as success + refetch).
 */
export async function activateTheme(
  token: string,
  id: string,
  options: { fetchImpl?: FetchLike } = {},
): Promise<ThemeActivation | null> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(`${THEMES_PATH}/${encodeURIComponent(id)}/activate`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
  });
  if (!response.ok) {
    throw new ApiRequestError(response.status, await readErrorMessage(response));
  }
  if (response.status === 204) return null;
  return parseActivation(await expectJson<unknown>(response), response.status);
}

/**
 * GET /v1/theme/active?personaId= — the resolved tokens for a request
 * (persona.colorTheme -> global active -> preset-default). Omit personaId to
 * resolve the global active theme.
 */
export async function getActiveTheme(
  token: string,
  personaId?: string | null,
  options: { fetchImpl?: FetchLike } = {},
): Promise<ActiveTheme> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const query = personaId && personaId.length > 0 ? `?personaId=${encodeURIComponent(personaId)}` : '';
  const response = await fetchImpl(`${ACTIVE_THEME_PATH}${query}`, {
    method: 'GET',
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
  });
  if (!response.ok) {
    throw new ApiRequestError(response.status, await readErrorMessage(response));
  }
  if (response.status === 204) {
    throw new ApiRequestError(response.status, 'The active theme response was empty.');
  }
  return parseActiveTheme(await expectJson<unknown>(response), response.status);
}

/**
 * POST /v1/personas/:id/theme {themeId|null} — bind a theme to a persona
 * (null clears to the global active). Resolves on 2xx; the core returns
 * {personaId, themeId} (a 204 is also tolerated).
 */
export async function bindPersonaTheme(
  token: string,
  personaId: string,
  themeId: string | null,
  options: { fetchImpl?: FetchLike } = {},
): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(
    `${PERSONAS_PATH}/${encodeURIComponent(personaId)}/theme`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({ themeId: themeId ?? null }),
    },
  );
  if (!response.ok) {
    throw new ApiRequestError(response.status, await readErrorMessage(response));
  }
}
