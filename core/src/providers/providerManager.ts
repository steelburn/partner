/**
 * Provider manager (M1, PLAN-M1.md §"Provider API").
 *
 * Owns the lifecycle rules a plain row store must not: input validation, id
 * generation, keychain coordination (service `partner`, account
 * `provider:<id>`), live health probing through the OpenAI-compatible client,
 * and the audit rows for every sensitive action. The plaintext key NEVER
 * touches SQLite — only `keyRef` (the provider id) sits in the row; the
 * secret lives exclusively in the keychain.
 */
import { randomUUID } from 'node:crypto';
import type {
  Keychain,
  ProviderHealth,
  ProviderInput,
  ProviderPatch,
  ProviderPurpose,
  ProviderSource,
  ProviderSummary,
} from '@partner/shared';
import { isProviderPurpose } from '@partner/shared';
import { KEYCHAIN_SERVICE } from '../keychain/keychain.js';
import type { AuditService } from '../services/redaction.js';
import type { ProviderRow, ProviderRowPatch, ProviderStore } from '../stores/types.js';
import { createOpenAICompatibleClient } from '../gateway/openaiCompatible.js';
import type { OpenAICompatibleClient } from '../gateway/openaiCompatible.js';
import { safeUpstreamMessage } from '../gateway/openaiCompatible.js';
import { ProviderError } from './errors.js';

const KEYCHAIN_ACCOUNT_PREFIX = 'provider:';
const keychainAccount = (id: string): string => `${KEYCHAIN_ACCOUNT_PREFIX}${id}`;

/** "Empty" health for a provider that has never been probed. */
function emptyHealth(): ProviderHealth {
  return { ok: false, latencyMs: null, error: null, models: [], checkedAt: null };
}

function parseJsonArray(text: string | null): string[] {
  if (text === null || text === '') return [];
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is string => typeof entry === 'string');
  } catch {
    return [];
  }
}

function parseHealth(text: string | null): ProviderHealth {
  if (text === null || text === '') return emptyHealth();
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (parsed === null || typeof parsed !== 'object') return emptyHealth();
    const models = Array.isArray(parsed.models)
      ? parsed.models.filter((entry): entry is string => typeof entry === 'string')
      : [];
    return {
      ok: parsed.ok === true,
      latencyMs: typeof parsed.latencyMs === 'number' ? parsed.latencyMs : null,
      error: typeof parsed.error === 'string' ? parsed.error : null,
      models,
      checkedAt: typeof parsed.checkedAt === 'number' ? parsed.checkedAt : null,
    };
  } catch {
    return emptyHealth();
  }
}

/** Row -> wire summary. Never exposes keyRef or any key material. */
export function toSummary(row: ProviderRow): ProviderSummary {
  const purpose: ProviderPurpose = isProviderPurpose(row.purpose) ? row.purpose : 'general';
  return {
    id: row.id,
    name: row.name,
    kind: 'openai-compatible',
    source: row.source === 'llm-self-service' ? 'llm-self-service' : 'manual',
    purpose,
    endpoint: row.endpoint,
    defaultModels: parseJsonArray(row.defaultModels),
    visionModels: parseJsonArray(row.visionModels ?? null),
    enabled: row.enabled === 1,
    budgetCents: row.budgetCents,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    health: parseHealth(row.lastHealth),
  };
}

/** Validate a list of model ids: array of non-empty strings, trimmed, deduped. */
function normalizeModelIds(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) {
    throw new ProviderError('invalid_input', `${field} must be an array of model id strings`);
  }
  const ids: string[] = [];
  for (const entry of value as unknown[]) {
    if (typeof entry !== 'string') {
      throw new ProviderError('invalid_input', `${field} must be an array of model id strings`);
    }
    const trimmed = entry.trim();
    if (trimmed !== '' && !ids.includes(trimmed)) ids.push(trimmed);
  }
  return ids;
}

/** Validate + normalize a provider endpoint: trim, https or loopback http, ONE trailing slash stripped. */
export function normalizeEndpoint(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw new ProviderError('invalid_endpoint', 'endpoint is required and must be a string');
  }
  const trimmed = raw.trim();
  if (trimmed === '') throw new ProviderError('invalid_endpoint', 'endpoint is required');
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new ProviderError('invalid_endpoint', 'endpoint must be a valid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ProviderError('invalid_endpoint', 'endpoint must be http(s)');
  }
  if (url.protocol === 'http:') {
    // http is only ever acceptable on a loopback host (local fakes/tests) —
    // an https requirement everywhere else (PLAN.md §11).
    const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1';
    if (!loopback) {
      throw new ProviderError(
        'invalid_endpoint',
        'http endpoints must be on a loopback host (127.0.0.1/localhost) — use https elsewhere',
      );
    }
  }
  if (url.hostname === '') throw new ProviderError('invalid_endpoint', 'endpoint must include a host');
  return trimmed.endsWith('/') ? trimmed.slice(0, -1) : trimmed;
}

export interface ProviderManagerOptions {
  store: ProviderStore;
  keychain: Keychain;
  audit: AuditService;
  /** Injectable clock (epoch ms). */
  now?: () => number;
  /** Client connect timeout for live probes/streams (default 15s). */
  connectTimeoutMs?: number;
  /** Client idle timeout for live streams (default 60s). */
  idleTimeoutMs?: number;
}

export interface ProviderManager {
  /** Validate + store a profile; returns a summary with NO key material. */
  create(input: ProviderInput, source?: ProviderSource): Promise<ProviderSummary>;
  /**
   * M24: edit a profile's non-secret fields (model lists, purpose, name,
   * enabled, budget). `undefined` leaves a field alone; the endpoint and the
   * key are never touched here (the key lives in the keychain under the id).
   */
  update(id: string, patch: ProviderPatch): ProviderSummary;
  /** All profiles in creation order — never keyRef/key. */
  list(): ProviderSummary[];
  get(id: string): ProviderSummary | null;
  /** Delete the row AND the keychain entry `provider:<id>`. */
  remove(id: string): Promise<void>;
  /** Store/rotate the key in the keychain ONLY (never the DB). */
  setKey(id: string, key: string): Promise<void>;
  /** Read the key from the keychain (null when absent). */
  getKey(id: string): Promise<string | null>;
  /** Live probe (listModels + timeout); updates default_models + last_health. */
  test(id: string): Promise<ProviderSummary>;
  /** Client bound to the stored key (for the chat route). */
  clientFor(id: string): Promise<OpenAICompatibleClient>;
}

export function createProviderManager(options: ProviderManagerOptions): ProviderManager {
  const { store, keychain, audit } = options;
  const now = options.now ?? Date.now;
  const connectTimeoutMs = options.connectTimeoutMs;
  const idleTimeoutMs = options.idleTimeoutMs;

  const safeKeychainMessage = 'OS keychain unavailable — start a keyring daemon (Linux) or use demo mode';

  async function create(input: ProviderInput, source: ProviderSource = 'manual'): Promise<ProviderSummary> {
    const body = (input ?? {}) as ProviderInput;
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (name === '') throw new ProviderError('invalid_input', 'name is required');

    const kindRaw = body.kind ?? 'openai-compatible';
    if (String(kindRaw) !== 'openai-compatible') {
      throw new ProviderError('invalid_kind', 'unsupported kind — v1 supports openai-compatible only');
    }

    const endpoint = normalizeEndpoint(body.endpoint);

    const rawModels = body.defaultModels ?? [];
    if (!Array.isArray(rawModels) || rawModels.some((m) => typeof m !== 'string')) {
      throw new ProviderError('invalid_input', 'defaultModels must be an array of model id strings');
    }
    const defaultModels = rawModels as string[];
    // M24: the vision declaration is optional; absent = nothing declared (the
    // name heuristic alone decides). A bad shape is refused rather than stored
    // half-valid, because a silently-dropped declaration is the bug this fixes.
    const visionModels =
      body.visionModels === undefined || body.visionModels === null
        ? []
        : normalizeModelIds(body.visionModels, 'visionModels');

    let budgetCents: number | null;
    if (body.budgetCents === null || body.budgetCents === undefined) {
      budgetCents = null;
    } else if (
      typeof body.budgetCents === 'number' &&
      Number.isFinite(body.budgetCents) &&
      body.budgetCents >= 0
    ) {
      budgetCents = Math.round(body.budgetCents);
    } else {
      throw new ProviderError('invalid_input', 'budgetCents must be a non-negative number of cents or null');
    }

    const enabled = (body.enabled ?? true) === true;
    const purpose: ProviderPurpose = isProviderPurpose(body.purpose) ? body.purpose : 'general';
    const id = randomUUID();
    const at = now();
    const row: ProviderRow = {
      id,
      name,
      kind: 'openai-compatible',
      source,
      purpose,
      endpoint,
      defaultModels: defaultModels.length > 0 ? JSON.stringify(defaultModels) : null,
      visionModels: visionModels.length > 0 ? JSON.stringify(visionModels) : null,
      enabled: enabled ? 1 : 0,
      budgetCents,
      keyRef: id,
      lastHealth: null,
      createdAt: at,
      updatedAt: at,
    };
    store.insert(row);
    audit.log('provider', 'provider.create', id, {
      name,
      kind: 'openai-compatible',
      source,
      purpose,
      enabled,
      visionDeclared: visionModels.length,
    });
    return toSummary(row);
  }

  function list(): ProviderSummary[] {
    return store.list().map(toSummary);
  }

  function get(id: string): ProviderSummary | null {
    const row = store.findById(id);
    return row ? toSummary(row) : null;
  }

  /**
   * M24 — edit a profile's non-secret fields. Exists so a vision declaration
   * can be fixed on a WORKING provider: before this the only way to tell
   * Partner "this model can see" was to delete the profile and re-add it.
   * Audit records field names and counts, never model lists or endpoints.
   */
  function update(id: string, patch: ProviderPatch): ProviderSummary {
    const row = store.findById(id);
    if (!row) throw new ProviderError('not_found', 'provider not found');
    const body = (patch ?? {}) as ProviderPatch;
    const next: ProviderRowPatch = { updatedAt: now() };
    const fields: string[] = [];
    let visionDeclared: number | null = null;

    if (body.name !== undefined) {
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (name === '') throw new ProviderError('invalid_input', 'name must be a non-empty string');
      next.name = name;
      fields.push('name');
    }
    if (body.purpose !== undefined) {
      if (!isProviderPurpose(body.purpose)) {
        throw new ProviderError('invalid_input', 'purpose is not a known purpose tag');
      }
      next.purpose = body.purpose;
      fields.push('purpose');
    }
    if (body.enabled !== undefined) {
      if (typeof body.enabled !== 'boolean') {
        throw new ProviderError('invalid_input', 'enabled must be a boolean');
      }
      next.enabled = body.enabled ? 1 : 0;
      fields.push('enabled');
    }
    if (body.budgetCents !== undefined) {
      if (
        body.budgetCents !== null &&
        !(typeof body.budgetCents === 'number' && Number.isFinite(body.budgetCents) && body.budgetCents >= 0)
      ) {
        throw new ProviderError('invalid_input', 'budgetCents must be a non-negative number of cents or null');
      }
      next.budgetCents = body.budgetCents === null ? null : Math.round(body.budgetCents);
      fields.push('budgetCents');
    }
    if (body.defaultModels !== undefined) {
      const models = normalizeModelIds(body.defaultModels, 'defaultModels');
      next.defaultModels = models.length > 0 ? JSON.stringify(models) : null;
      fields.push('defaultModels');
    }
    if (body.visionModels !== undefined) {
      const models = normalizeModelIds(body.visionModels, 'visionModels');
      next.visionModels = models.length > 0 ? JSON.stringify(models) : null;
      visionDeclared = models.length;
      fields.push('visionModels');
    }

    if (fields.length === 0) return toSummary(row);
    store.update(id, next);
    if (visionDeclared !== null) {
      audit.log('provider', 'provider.vision_declared', id, { count: visionDeclared });
    }
    audit.log('provider', 'provider.update', id, { fields });
    const updated = store.findById(id);
    return toSummary(updated ?? row);
  }

  async function remove(id: string): Promise<void> {
    const row = store.findById(id);
    if (!row) throw new ProviderError('not_found', 'provider not found');
    try {
      await keychain.delete(KEYCHAIN_SERVICE, keychainAccount(id));
    } catch {
      throw new ProviderError('keychain_unavailable', safeKeychainMessage);
    }
    store.remove(id);
    audit.log('provider', 'provider.delete', id, { name: row.name });
  }

  async function setKey(id: string, key: string): Promise<void> {
    if (!store.findById(id)) throw new ProviderError('not_found', 'provider not found');
    if (typeof key !== 'string' || key === '') {
      throw new ProviderError('invalid_input', 'key must be a non-empty string');
    }
    try {
      await keychain.set(KEYCHAIN_SERVICE, keychainAccount(id), key);
    } catch {
      throw new ProviderError('keychain_unavailable', safeKeychainMessage);
    }
    audit.log('provider', 'provider.set_key', id, { ok: true });
  }

  async function getKey(id: string): Promise<string | null> {
    try {
      return await keychain.get(KEYCHAIN_SERVICE, keychainAccount(id));
    } catch {
      throw new ProviderError('keychain_unavailable', safeKeychainMessage);
    }
  }

  /** Chat probe timeout (single token, just proving /chat/completions works). */
  const PROBE_TIMEOUT_MS = 10_000;

  async function test(id: string): Promise<ProviderSummary> {
    const row = store.findById(id);
    if (!row) throw new ProviderError('not_found', 'provider not found');
    const key = await getKey(id);
    if (key === null) throw new ProviderError('missing_key', 'provider has no key — set one before testing');

    const client = createOpenAICompatibleClient({
      endpoint: row.endpoint,
      apiKey: key,
      connectTimeoutMs,
      idleTimeoutMs,
    });
    const started = Date.now();
    const checkedAt = now();

    // A proxy is only 'Healthy' when BOTH /models and a minimal chat round
    // work — a broken /chat/completions must not pass as healthy (PLAN-M1).
    try {
      const models = await client.listModels();
      let probeError: string | null = null;
      if (models.length > 0) {
        const probeSignal = AbortSignal.timeout(PROBE_TIMEOUT_MS);
        let sawDone = false;
        for await (const event of client.chatStream({
          model: models[0] as string,
          messages: [{ role: 'user', content: 'ping' }],
          stream: true,
          signal: probeSignal,
        })) {
          if (event.type === 'error') {
            probeError = `chat probe failed: ${event.message}`;
            break;
          }
          if (event.type === 'done') {
            sawDone = true;
            break;
          }
        }
        if (!sawDone && probeError === null) probeError = 'chat probe failed: no reply (timeout?)';
      }

      const latencyMs = Date.now() - started;
      // M13: Test refreshes HEALTH but never clobbers a curated model list —
      // purpose profiles carry exactly the models the user pinned. Only a
      // profile with NO defaults yet is auto-populated from the live list
      // (fresh single-provider adds). The fresh list still rides lastHealth
      // so the UI reports the upstream's current models.
      const existingModels = parseJsonArray(row.defaultModels);
      const defaultModelsUpdate =
        existingModels.length === 0
          ? { defaultModels: models.length > 0 ? JSON.stringify(models) : null }
          : {};
      if (probeError !== null) {
        store.update(id, {
          ...defaultModelsUpdate,
          lastHealth: JSON.stringify({ ok: false, latencyMs, error: probeError, models: [], checkedAt }),
          updatedAt: checkedAt,
        });
        audit.log('provider', 'provider.test', id, { ok: false, latencyMs, error: probeError });
      } else {
        store.update(id, {
          ...defaultModelsUpdate,
          lastHealth: JSON.stringify({ ok: true, latencyMs, error: null, models, checkedAt }),
          updatedAt: checkedAt,
        });
        audit.log('provider', 'provider.test', id, { ok: true, latencyMs, models: models.length });
      }
    } catch (err) {
      const latencyMs = Date.now() - started;
      const message = safeUpstreamMessage(err);
      store.update(id, {
        lastHealth: JSON.stringify({ ok: false, latencyMs, error: message, models: [], checkedAt }),
        updatedAt: checkedAt,
      });
      audit.log('provider', 'provider.test', id, { ok: false, latencyMs, error: message });
    }
    const updated = store.findById(id);
    return toSummary(updated ?? row);
  }

  async function clientFor(id: string): Promise<OpenAICompatibleClient> {
    const row = store.findById(id);
    if (!row) throw new ProviderError('not_found', 'provider not found');
    const key = await getKey(id);
    if (key === null) throw new ProviderError('missing_key', 'provider has no key — set one before chatting');
    return createOpenAICompatibleClient({
      endpoint: row.endpoint,
      apiKey: key,
      connectTimeoutMs,
      idleTimeoutMs,
    });
  }

  return { create, list, get, update, remove, setKey, getKey, test, clientFor };
}
