/**
 * M9 playbooks + deploy-target API client (PLAN-M9.md).
 *
 * Follows the M0–M8 chokepoint rules exactly (see lib/api.ts): the pairing
 * token travels ONLY as `Authorization: Bearer …`; the transport is
 * injectable for tests; non-2xx maps to ApiRequestError with a readable
 * message. Secrets discipline: nothing here logs or echoes playbook input
 * content, tool args or tool results — the transcript rendered in the UI is
 * the OWNER's data (playbook text and tool results) and stays on the page.
 * Audit rows (ids/names/counts) are the only thing that ever leaves this
 * module as text in an error.
 *
 * The M9 run stream is SSE "like chat" (PLAN-M9.md): every data frame is a
 * JSON object with a `type` member — `delta`, `loop_step`, `persona_tool`,
 * `done`, `done_meta` or `error` — parsed here by the exported type guards
 * (asPlaybookRunEvent / readRunDoneMeta). The shared package carries the
 * REST entities (PlaybookSummary, DeployProfile, PackageResult, … in
 * shared/src/playbooks.ts) but not the stream event union, so this module
 * owns the web-side contract; guards are tolerant so an unexpected frame is
 * dropped instead of failing the stream (same discipline as asChatEvent).
 *
 * Route notes for integration: REST paths follow PLAN-M9.md
 * (`/v1/playbooks`, `/v1/playbooks/:id/run`, `/v1/deploy-profiles`). The
 * run *resume* route (a run that paused on a queued persona tool is
 * continued after the human approves it in the queue) is
 * `POST /v1/playbooks/runs/:runId/resume` — matching the core registration
 * (core/src/http/server.ts) so UI resume and the wire agree.
 */

import {
  ApiRequestError,
  expectJson,
  expectNoContent,
  readErrorMessage,
  type FetchLike,
} from './api.js';
import { parseSseStream } from './sse.js';
import type {
  DeployProfile,
  DeployProfileInput,
  PackageResult,
  PlaybookArea,
  PlaybookSummary,
} from '@partner/shared';

const PLAYBOOKS_PATH = '/v1/playbooks';
// Resume re-enters a paused run: POST /v1/playbooks/runs/:runId/resume
// (registered in core/src/http/server.ts — one constant, one route).
const PLAYBOOK_RUNS_PATH = '/v1/playbooks/runs';
const DEPLOY_PROFILES_PATH = '/v1/deploy-profiles';

export type { FetchLike };

// ---------------------------------------------------------------------------
// Run stream contract (web-side; see header comment)
// ---------------------------------------------------------------------------

/** playbook_runs.status values (PLAN-M9.md data model). */
export type PlaybookRunStatus = 'running' | 'done' | 'error' | 'loop_exhausted';

/**
 * One SSE frame of a playbook run stream. `persona_tool.queued` carries the
 * pending-approval id (the run pauses until the human decides it in the
 * queue — surface the hint, then resumeRun once it is gone). A `done_meta`
 * frame may appear mid-stream (a pause: status running + pendingId) and/or
 * at the very end (terminal status; noteId when the save-as-note landed).
 */
export type PlaybookRunEvent =
  | { type: 'delta'; text: string }
  | { type: 'loop_step'; round: number; message?: string }
  | {
      type: 'persona_tool';
      toolId: string;
      decision: 'executed' | 'queued' | 'refused';
      /** Present when decision is 'queued' (the approval-queue row id). */
      pendingId?: string;
      /** Reason carried with a refused decision. */
      reason?: string;
      /** Args the persona wanted to run (owner data — UI display only). */
      args?: Record<string, unknown>;
    }
  | { type: 'done' }
  | {
      type: 'done_meta';
      /** playbook_runs row id (needed to resume a paused run). */
      runId: string | null;
      status: PlaybookRunStatus | null;
      /** Set when this meta ends a pause (waiting on this approval). */
      pendingId: string | null;
      /** Set when the final answer was saved as a note. */
      noteId: string | null;
      noteTitle: string | null;
      /** Conversation the run persisted into (text playbooks). */
      conversationId: string | null;
    }
  | { type: 'error'; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Tolerant guard: unknown/non-JSON frames and malformed events -> null. */
export function asPlaybookRunEvent(value: unknown): PlaybookRunEvent | null {
  if (!isRecord(value)) return null;
  switch (value.type) {
    case 'delta':
      return typeof value.text === 'string' ? { type: 'delta', text: value.text } : null;
    case 'loop_step': {
      const round = value.round;
      if (typeof round !== 'number' || !Number.isFinite(round) || round < 1) return null;
      const message = optString(value.message);
      return message === undefined
        ? { type: 'loop_step', round }
        : { type: 'loop_step', round, message };
    }
    case 'persona_tool': {
      const toolId = optString(value.toolId);
      if (toolId === undefined) return null;
      const decision = value.decision;
      if (decision !== 'executed' && decision !== 'queued' && decision !== 'refused') {
        return null;
      }
      const pendingId = optString(value.pendingId);
      const reason = optString(value.reason);
      // A queued decision without its approval id cannot be surfaced or
      // resumed — treat the frame as malformed.
      if (decision === 'queued' && pendingId === undefined) return null;
      const args = isRecord(value.args) ? (value.args as Record<string, unknown>) : undefined;
      const event: PlaybookRunEvent = { type: 'persona_tool', toolId, decision };
      if (pendingId !== undefined) event.pendingId = pendingId;
      if (reason !== undefined) event.reason = reason;
      if (args !== undefined) event.args = args;
      return event;
    }
    case 'done':
      return { type: 'done' };
    case 'done_meta': {
      const runId = optString(value.runId) ?? null;
      const statusValue = value.status;
      const status: PlaybookRunStatus | null =
        statusValue === 'running' ||
        statusValue === 'done' ||
        statusValue === 'error' ||
        statusValue === 'loop_exhausted'
          ? statusValue
          : null;
      return {
        type: 'done_meta',
        runId,
        status,
        pendingId: optString(value.pendingId) ?? null,
        noteId: optString(value.noteId) ?? null,
        noteTitle: optString(value.noteTitle) ?? null,
        conversationId: optString(value.conversationId) ?? null,
      };
    }
    case 'error':
      return typeof value.message === 'string'
        ? { type: 'error', message: value.message }
        : null;
    default:
      return null;
  }
}

/**
 * Read the persisted-run meta off a `done_meta` frame (tolerant, null-safe).
 * A paused run's meta carries runId + the pendingId it waits on; the final
 * meta carries the terminal status (and noteId when saved as a note).
 */
export function readRunDoneMeta(value: unknown): PlaybookRunEvent | null {
  const event = asPlaybookRunEvent(value);
  if (event === null || event.type !== 'done_meta') return null;
  return event;
}

// ---------------------------------------------------------------------------
// List / run
// ---------------------------------------------------------------------------

/** Structural identity of a registry row (the fields that must be present). */
type PlaybookIdentityRow = {
  id: string;
  name: string;
  area: string;
  description: string;
} & Record<string, unknown>;

function hasPlaybookIdentity(value: Record<string, unknown>): value is PlaybookIdentityRow {
  return (
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    typeof value.name === 'string' &&
    typeof value.area === 'string' &&
    typeof value.description === 'string'
  );
}

/** Tolerant read of one registry row (id/name/area/description required). */
function readPlaybookRow(row: unknown, status: number, label: string): PlaybookSummary {
  if (!isRecord(row) || !hasPlaybookIdentity(row)) {
    throw new ApiRequestError(status, `${label} had an unexpected shape.`);
  }
  const area = row.area as PlaybookArea;
  const allowedTools = Array.isArray(row.allowedTools)
    ? row.allowedTools.filter((t): t is string => typeof t === 'string' && t.length > 0)
    : [];
  const defaultIndependence = row.defaultIndependence;
  const independence: PlaybookSummary['defaultIndependence'] =
    defaultIndependence === 'assist' ||
    defaultIndependence === 'suggest' ||
    defaultIndependence === 'auto' ||
    defaultIndependence === 'autonomous'
      ? defaultIndependence
      : 'suggest';
  const inputs = Array.isArray(row.inputs)
    ? row.inputs.flatMap((input) => {
        if (
          !isRecord(input) ||
          typeof input.name !== 'string' ||
          input.name.length === 0 ||
          typeof input.hint !== 'string'
        ) {
          return [];
        }
        // Optionality is preserved as the wire sent it (absent stays
        // absent; only an explicit true is carried forward).
        return input.optional === true
          ? [{ name: input.name, hint: input.hint, optional: true as const }]
          : [{ name: input.name, hint: input.hint }];
      })
    : [];
  return {
    id: row.id,
    name: row.name,
    area,
    description: row.description,
    allowedTools,
    defaultIndependence: independence,
    inputs,
  };
}

/**
 * Normalize a playbook-list response ({playbooks: [...]} or a bare array).
 * Rows need the registry identity fields; a bad row fails the whole list
 * loudly so contract drift cannot silently empty the Playbooks screen.
 */
export function parsePlaybookList(value: unknown, status = 200): PlaybookSummary[] {
  const list = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.playbooks)
      ? value.playbooks
      : null;
  if (list === null) {
    throw new ApiRequestError(status, 'The playbooks response had an unexpected shape.');
  }
  return list.map((row, index) => readPlaybookRow(row, status, `playbook ${index}`));
}

/** GET /v1/playbooks -> the playbook registry (metadata only). */
export async function listPlaybooks(
  token: string,
  options: { fetchImpl?: FetchLike } = {},
): Promise<PlaybookSummary[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(PLAYBOOKS_PATH, {
    method: 'GET',
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
  });
  return parsePlaybookList(await expectJson<unknown>(response), response.status);
}

/** Adapt a fetch ReadableStream into an async iterable of byte chunks. */
async function* streamChunks(stream: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value) yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

export interface StreamPlaybookRunOptions {
  token: string;
  playbookId: string;
  /** Inputs per the playbook's declared schema (owner data, sent once). */
  inputs: Record<string, unknown>;
  personaId?: string;
  conversationId?: string;
  /** Save-as-note shortcut: core persists the final answer as a note. */
  saveNote?: boolean;
  /** Dispatched as each valid SSE frame of the run stream arrives. */
  onEvent: (event: PlaybookRunEvent) => void;
  /** Receives every tolerated done_meta frame (pause or terminal). */
  onDoneMeta?: (meta: Extract<PlaybookRunEvent, { type: 'done_meta' }>) => void;
  signal?: AbortSignal;
  fetchImpl?: FetchLike;
}

/** Run-stream options that resume (or run) share — everything but the run
 *  body fields that only a fresh run carries. */
export interface StreamPlaybookRunShared {
  token: string;
  onEvent: (event: PlaybookRunEvent) => void;
  onDoneMeta?: (meta: Extract<PlaybookRunEvent, { type: 'done_meta' }>) => void;
  signal?: AbortSignal;
  fetchImpl?: FetchLike;
}

export type StreamPlaybookRunResult =
  | { ok: true }
  | {
      ok: false;
      status: number | null;
      unauthorized: boolean;
      /** True when the run failed up front because a persona is paused. */
      paused: boolean;
      message: string;
    };

/** Consume an SSE body into validated run events (shared by run + resume). */
async function consumeRunStream(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: PlaybookRunEvent) => void,
  onDoneMeta?: StreamPlaybookRunOptions['onDoneMeta'],
): Promise<void> {
  for await (const frame of parseSseStream(streamChunks(body))) {
    if (frame.data === '[DONE]') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(frame.data);
    } catch {
      continue; // Ignore non-JSON frames defensively.
    }
    const event = asPlaybookRunEvent(parsed);
    if (event) onEvent(event);
    const meta = readRunDoneMeta(parsed);
    if (meta && meta.type === 'done_meta') onDoneMeta?.(meta);
  }
}

async function openRunStream(
  path: string,
  body: Record<string, unknown>,
  options: StreamPlaybookRunShared,
): Promise<StreamPlaybookRunResult> {
  const { token, onEvent, onDoneMeta, signal, fetchImpl = fetch } = options;
  const response = await fetchImpl(path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) {
    const paused = response.status === 423;
    return {
      ok: false,
      status: response.status,
      unauthorized: response.status === 401 || response.status === 403,
      paused,
      message: paused
        ? 'The persona is paused — resume it in Personas to run a playbook.'
        : await readErrorMessage(response),
    };
  }
  if (response.body === null) {
    return {
      ok: false,
      status: response.status,
      unauthorized: false,
      paused: false,
      message: 'The run stream was empty.',
    };
  }
  await consumeRunStream(response.body, onEvent, onDoneMeta);
  return { ok: true };
}

/**
 * POST /v1/playbooks/:id/run and consume the SSE stream (deltas, loop
 * markers, persona tool events with queue hints, final done/done_meta).
 * Returns after the stream ends; a run that pauses on a queued persona tool
 * ends with a done_meta carrying runId + pendingId — call resumeRun once the
 * human has decided that approval in the queue.
 */
export async function runPlaybook(
  options: StreamPlaybookRunOptions,
): Promise<StreamPlaybookRunResult> {
  const { playbookId, inputs, personaId, conversationId, saveNote } = options;
  const body: Record<string, unknown> = { inputs };
  if (personaId) body.personaId = personaId;
  if (conversationId) body.conversationId = conversationId;
  if (saveNote === true) body.note = true;
  const { token, onEvent, onDoneMeta, signal, fetchImpl } = options;
  return openRunStream(
    `${PLAYBOOKS_PATH}/${encodeURIComponent(playbookId)}/run`,
    body,
    { token, onEvent, onDoneMeta, signal, fetchImpl },
  );
}

/**
 * POST /v1/playbooks/runs/:runId/resume {pendingId} — continue a run that
 * paused on a queued persona tool after the human approved/denied it. The
 * stream delivers the remaining loop events and the final done_meta.
 */
export async function resumeRun(
  runId: string,
  pendingId: string,
  options: StreamPlaybookRunShared,
): Promise<StreamPlaybookRunResult> {
  const body: Record<string, unknown> = { pendingId };
  return openRunStream(
    `${PLAYBOOK_RUNS_PATH}/${encodeURIComponent(runId)}/resume`,
    body,
    options,
  );
}

// ---------------------------------------------------------------------------
// Deploy profiles + package
// ---------------------------------------------------------------------------

function epoch(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return 0;
}

/** Structural identity of a profile row (the fields that must be present). */
type ProfileIdentityRow = {
  id: string;
  name: string;
  host: string;
} & Record<string, unknown>;

function hasProfileIdentity(value: Record<string, unknown>): value is ProfileIdentityRow {
  return (
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    typeof value.name === 'string' &&
    typeof value.host === 'string' &&
    value.host.length > 0
  );
}

function readProfileRow(row: unknown, status: number, label: string): DeployProfile {
  if (!isRecord(row) || !hasProfileIdentity(row)) {
    throw new ApiRequestError(status, `${label} had an unexpected shape.`);
  }
  const port = typeof row.port === 'number' && Number.isFinite(row.port) ? row.port : 22;
  const username = typeof row.username === 'string' && row.username.length > 0 ? row.username : null;
  const remoteBaseDir =
    typeof row.remoteBaseDir === 'string' && row.remoteBaseDir.length > 0
      ? row.remoteBaseDir
      : null;
  const createdAt = epoch(row.createdAt);
  const updatedAt = epoch(row.updatedAt);
  return {
    id: row.id,
    name: row.name,
    kind: 'docker-ssh',
    host: row.host,
    username,
    port,
    remoteBaseDir,
    createdAt,
    updatedAt,
  };
}

/**
 * Normalize a deploy-profiles response ({profiles: [...]} or a bare array).
 * Rows need id/name/host; port/timestamps default safely.
 */
export function parseProfileList(value: unknown, status = 200): DeployProfile[] {
  const list = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.profiles)
      ? value.profiles
      : null;
  if (list === null) {
    throw new ApiRequestError(status, 'The deploy profiles response had an unexpected shape.');
  }
  return list.map((row, index) => readProfileRow(row, status, `profile ${index}`));
}

/** GET /v1/deploy-profiles -> saved deploy targets. */
export async function listDeployProfiles(
  token: string,
  options: { fetchImpl?: FetchLike } = {},
): Promise<DeployProfile[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(DEPLOY_PROFILES_PATH, {
    method: 'GET',
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
  });
  return parseProfileList(await expectJson<unknown>(response), response.status);
}

/**
 * Normalize one profile response (bare or {profile: …} envelope). Required:
 * id/name/host; everything else defaults safely.
 */
export function parseProfile(value: unknown, status = 200): DeployProfile {
  const record = isRecord(value) ? value : null;
  const enveloped = record && isRecord(record.profile) ? (record.profile as unknown) : value;
  return readProfileRow(enveloped, status, 'The deploy profile');
}

/** POST /v1/deploy-profiles {name, host, …} -> the created profile. */
export async function createDeployProfile(
  token: string,
  input: DeployProfileInput,
  options: { fetchImpl?: FetchLike } = {},
): Promise<DeployProfile> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(DEPLOY_PROFILES_PATH, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify(input),
  });
  return parseProfile(await expectJson<unknown>(response), response.status);
}

/** DELETE /v1/deploy-profiles/:id -> 204. */
export async function deleteDeployProfile(
  token: string,
  profileId: string,
  options: { fetchImpl?: FetchLike } = {},
): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(`${DEPLOY_PROFILES_PATH}/${encodeURIComponent(profileId)}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${token}` },
  });
  return expectNoContent(response, 'Deleting the deploy profile');
}

/** Normalize a package result (required: profileId/outDir/files/dockerfile). */
export function parsePackageResult(value: unknown, status = 200): PackageResult {
  if (
    !isRecord(value) ||
    typeof value.profileId !== 'string' ||
    value.profileId.length === 0 ||
    typeof value.outDir !== 'string' ||
    value.outDir.length === 0 ||
    typeof value.dockerfile !== 'string' ||
    !Array.isArray(value.files)
  ) {
    throw new ApiRequestError(status, 'The package response had an unexpected shape.');
  }
  const files = value.files.filter((f): f is string => typeof f === 'string' && f.length > 0);
  return { profileId: value.profileId, outDir: value.outDir, files, dockerfile: value.dockerfile };
}

/**
 * POST /v1/deploy-profiles/:id/package {projectDir, outDir} -> the built
 * bundle (absolute paths under the granted project root). This only bundles
 * locally — live ship to the host stays environment-gated.
 */
export async function packageProfile(
  token: string,
  profileId: string,
  input: { projectDir: string; outDir: string },
  options: { fetchImpl?: FetchLike } = {},
): Promise<PackageResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(`${DEPLOY_PROFILES_PATH}/${encodeURIComponent(profileId)}/package`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify(input),
  });
  return parsePackageResult(await expectJson<unknown>(response), response.status);
}
