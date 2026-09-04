/**
 * M3 persona API client (PLAN-M3.md).
 *
 * Same chokepoint rules as every other client (lib/api.ts): the pairing
 * token travels ONLY as `Authorization: Bearer …`; transport is injectable
 * for tests; non-2xx maps to ApiRequestError with a readable message.
 * Secrets discipline: persona system prompts and character text are sent to
 * the core once and never logged, echoed, or retained beyond the request —
 * nothing in this file prints or stores prompt bodies.
 */

import {
  ApiRequestError,
  expectJson,
  expectNoContent,
  type FetchLike,
} from './api.js';
import type { Persona, PersonaInput } from '@partner/shared';

const PERSONAS_PATH = '/v1/personas';

export type { FetchLike };

/** True when an ApiRequestError means the core session is gone. */
export function isSessionLost(cause: unknown): boolean {
  return cause instanceof ApiRequestError && (cause.status === 401 || cause.status === 403);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Normalize a single persona response: the core may serialize the persona
 * bare or under a `persona` key. Throws ApiRequestError on other shapes.
 */
export function parsePersona(value: unknown, status = 200): Persona {
  const record = isRecord(value) ? value : null;
  const direct = record;
  const enveloped =
    record && isRecord(record.persona) ? (record.persona as unknown as Persona) : null;
  const persona = enveloped ?? (direct as unknown as Persona | null);
  if (persona === null || typeof persona.id !== 'string' || typeof persona.name !== 'string') {
    throw new ApiRequestError(status, 'The persona response had an unexpected shape.');
  }
  return persona;
}

/**
 * Normalize a personas list response ({personas: [...]} or a bare array).
 * Throws ApiRequestError when neither shape is present.
 */
export function parsePersonaList(value: unknown, status = 200): Persona[] {
  if (Array.isArray(value)) return value as Persona[];
  if (isRecord(value) && Array.isArray(value.personas)) {
    return value.personas as unknown as Persona[];
  }
  throw new ApiRequestError(status, 'The personas response had an unexpected shape.');
}

/** GET /v1/personas -> every persona (never a system prompt elsewhere). */
export async function listPersonas(
  token: string,
  options: { fetchImpl?: FetchLike } = {},
): Promise<Persona[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(PERSONAS_PATH, {
    method: 'GET',
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
  });
  return parsePersonaList(await expectJson<unknown>(response), response.status);
}

/** POST /v1/personas -> the created persona. */
export async function createPersona(
  token: string,
  input: PersonaInput,
  options: { fetchImpl?: FetchLike } = {},
): Promise<Persona> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(PERSONAS_PATH, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify(input),
  });
  return parsePersona(await expectJson<unknown>(response), response.status);
}

/** PUT /v1/personas/:id -> the updated persona. */
export async function updatePersona(
  token: string,
  id: string,
  input: PersonaInput,
  options: { fetchImpl?: FetchLike } = {},
): Promise<Persona> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(`${PERSONAS_PATH}/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify(input),
  });
  return parsePersona(await expectJson<unknown>(response), response.status);
}

/** DELETE /v1/personas/:id -> 204 (the last default persona is refused). */
export async function deletePersona(
  token: string,
  id: string,
  options: { fetchImpl?: FetchLike } = {},
): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(`${PERSONAS_PATH}/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${token}` },
  });
  return expectNoContent(response, 'Deleting the persona');
}

/**
 * POST /v1/personas/:id/pause|resume -> the updated persona when the core
 * answers with a body, or null on a 204 no-content response. The UI treats
 * both as success and refetches the list afterwards.
 */
async function setPaused(
  token: string,
  id: string,
  action: 'pause' | 'resume',
  options: { fetchImpl?: FetchLike },
): Promise<Persona | null> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(`${PERSONAS_PATH}/${encodeURIComponent(id)}/${action}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
  });
  if (response.status === 204) return null;
  return parsePersona(await expectJson<unknown>(response), response.status);
}

/** POST /v1/personas/:id/pause — kill switch; paused personas refuse chat (423). */
export function pausePersona(
  token: string,
  id: string,
  options: { fetchImpl?: FetchLike } = {},
): Promise<Persona | null> {
  return setPaused(token, id, 'pause', options);
}

/** POST /v1/personas/:id/resume — restores chat + tool intents. */
export function resumePersona(
  token: string,
  id: string,
  options: { fetchImpl?: FetchLike } = {},
): Promise<Persona | null> {
  return setPaused(token, id, 'resume', options);
}
