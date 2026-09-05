/**
 * Persona manager (M3, PLAN-M3.md §"Persona model" + §"Starter personas").
 *
 * Owns the lifecycle rules a plain row store must not: input normalization
 * + validation, the EIGHT starter personas seeded on first run, the
 * single-isDefault invariant, pause state, and audit rows. Conversations
 * keep personaId denormalized, so remove() simply deletes the row — a
 * persona can be deleted while conversations reference it. The ONLY removal
 * refusal is the default-persona guard: a persona holding the (single)
 * isDefault flag cannot be removed (409 conflict) — set another persona as
 * default first. That keeps a default persona present for as long as any
 * persona exists in the normal (seeded) flow.
 *
 * Wire shapes are the shared Persona/PersonaInput types; nested character /
 * model routing / independence / memory objects round-trip via the flattened
 * row store (JSON string columns for the map/array fields).
 */
import { randomUUID } from 'node:crypto';
import type {
  IndependenceLevel,
  Persona,
  PersonaCharacter,
  PersonaIndependence,
  PersonaMemoryFlags,
  PersonaModelRouting,
  PersonaPolicy,
  TaskClass,
  TaskClassMap,
} from '@partner/shared';
import type { AuditService } from '../services/redaction.js';
import type { PersonaRow, PersonaRowPatch, PersonaStore } from '../stores/types.js';
import { PersonaError, personaError } from './errors.js';

const INDEPENDENCE_LEVELS: ReadonlySet<string> = new Set([
  'assist',
  'suggest',
  'auto',
  'autonomous',
]);
const HUMAN_TIERS: ReadonlySet<string> = new Set(['high', 'medium']);
const TASK_CLASSES: readonly TaskClass[] = ['chat', 'deep', 'coding', 'vision', 'cheap'];
const USER_PROFILE_ACCESS: ReadonlySet<string> = new Set(['read', 'none']);
const EPISODE_ACCESS: ReadonlySet<string> = new Set(['read+write', 'none']);

/** Lower/upper bound for character.temperature (clamped, not rejected). */
const TEMPERATURE_MIN = 0;
const TEMPERATURE_MAX = 2;

export interface PersonaManagerOptions {
  store: PersonaStore;
  audit: AuditService;
  /** Injectable clock (epoch ms). */
  now?: () => number;
}

/** Partial create input — only name is required; every other field has a
 *  safe default (the route/web UI send partial bodies). */
export interface PersonaDraft {
  name: string;
  tagline?: string;
  avatar?: string;
  colorTheme?: string;
  character?: Partial<PersonaCharacter>;
  model?: Partial<PersonaModelRouting>;
  independence?: Partial<PersonaIndependence>;
  memory?: Partial<PersonaMemoryFlags>;
  /** M11 F3 capability policy (skills/tools defaults + bans). */
  policy?: PersonaPolicy;
  /** D10 home folder id (optional). */
  homeFolderId?: string;
  isDefault?: boolean;
}

/** Update input: same shape as the draft, but name becomes optional. */
export type PersonaPatch = Omit<PersonaDraft, 'name'> & { name?: string };

export interface PersonaManager {
  /** All personas in creation order (oldest first). */
  list(): Persona[];
  /** Persona by id, or null when absent. */
  get(id: string): Persona | null;
  /** Validate + normalize + store; single-default invariant enforced. */
  create(input: PersonaDraft): Persona;
  /** Partial update (re-normalized); not_found when the persona is absent. */
  update(id: string, patch: PersonaPatch): Persona;
  /** Delete the row. not_found when absent; conflict when it is the default
   *  persona (the single default cannot be removed — move it first). */
  remove(id: string): void;
  /** Insert the eight starter personas ONLY when the table is empty
   *  (idempotent by construction). Returns how many were inserted. */
  seedIfEmpty(): number;
  /** Kill switch on (a paused persona refuses chat/tool intent, 423). */
  pause(id: string): Persona;
  resume(id: string): Persona;
  /** True when the persona exists and is paused (false when absent). */
  isPaused(id: string): boolean;
}

// ---------------------------------------------------------------------------
// Seed data — the EIGHT starter personas (PLAN-M3.md). Names/levels/defaults
// come straight from the plan; character text is M3 starter content (no
// secrets, no tool scopes — autoScopes are enforced from M9).
// ---------------------------------------------------------------------------

const STARTER_SYSTEM_PROMPT =
  'You are the user\'s partner inside their personal workspace. Be direct, honest and concrete. ' +
  'Answer in the persona\'s voice, respect the declared independence level, and never invent facts.';

interface StarterSeed {
  id: string;
  name: string;
  tagline: string;
  level: IndependenceLevel;
  temperature: number;
  isDefault: boolean;
}

const STARTER_SEEDS: StarterSeed[] = [
  {
    id: 'p-researcher',
    name: 'Researcher',
    tagline: 'Deep, cited research across the web and your files.',
    level: 'suggest',
    temperature: 0.4,
    isDefault: false,
  },
  {
    id: 'p-builder',
    name: 'Builder',
    tagline: 'Vibe-coding engineer — plans, writes and ships code with you.',
    level: 'auto',
    temperature: 0.3,
    isDefault: false,
  },
  {
    id: 'p-studio',
    name: 'Studio',
    tagline: 'Design partner — calm interfaces from tokens, not trends.',
    level: 'assist',
    temperature: 0.8,
    isDefault: false,
  },
  {
    id: 'p-scribe',
    name: 'Scribe',
    tagline: 'Emails, documents and polished prose in your voice.',
    level: 'assist',
    temperature: 0.6,
    isDefault: false,
  },
  {
    id: 'p-presenter',
    name: 'Presenter',
    tagline: 'Turns outlines into crisp decks and stories.',
    level: 'assist',
    temperature: 0.7,
    isDefault: false,
  },
  {
    id: 'p-analyst',
    name: 'Analyst',
    tagline: 'Numbers-first thinking — data, charts and honest takes.',
    level: 'assist',
    temperature: 0.2,
    isDefault: false,
  },
  {
    id: 'p-note-taker',
    name: 'Note-taker',
    tagline: 'Listens, summarizes and keeps your notes tidy.',
    level: 'assist',
    temperature: 0.3,
    isDefault: false,
  },
  {
    id: 'p-default',
    name: 'Default partner',
    tagline: 'Your everyday partner — chat, plans and help across the workspace.',
    level: 'assist',
    temperature: 0.7,
    isDefault: true,
  },
];

// ---------------------------------------------------------------------------
// Row <-> wire (de)serialization. JSON string columns parse leniently so a
// hand-edited or older row can never crash the surface.
// ---------------------------------------------------------------------------

function parseJsonObject(text: string | null): Record<string, unknown> {
  if (text === null || text === '') return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
}

function parseJsonStringArray(text: string | null): string[] {
  if (text === null || text === '') return [];
  try {
    const value = JSON.parse(text) as unknown;
    if (!Array.isArray(value)) return [];
    return value.filter((entry): entry is string => typeof entry === 'string');
  } catch {
    return [];
  }
}

function toTaskClasses(row: PersonaRow): TaskClassMap {
  const map: TaskClassMap = {};
  const raw = parseJsonObject(row.taskClasses);
  for (const taskClass of TASK_CLASSES) {
    const model = raw[taskClass];
    if (typeof model === 'string' && model !== '') map[taskClass] = model;
  }
  return map;
}

function toMemoryFlags(row: PersonaRow): PersonaMemoryFlags {
  const raw = parseJsonObject(row.memoryFlags);
  const userProfile =
    typeof raw.userProfile === 'string' && USER_PROFILE_ACCESS.has(raw.userProfile)
      ? (raw.userProfile as 'read' | 'none')
      : 'none';
  const episodes =
    typeof raw.episodes === 'string' && EPISODE_ACCESS.has(raw.episodes)
      ? (raw.episodes as 'read+write' | 'none')
      : 'none';
  return { userProfile, episodes };
}

function toRowPersona(row: PersonaRow): Persona {
  const requireHumanRaw = parseJsonStringArray(row.requireHuman);
  const requireHumanFor = requireHumanRaw.filter(
    (entry): entry is 'high' | 'medium' => HUMAN_TIERS.has(entry),
  );
  const autoScopes = parseJsonStringArray(row.autoScopes);
  const independence: PersonaIndependence = {
    level: (INDEPENDENCE_LEVELS.has(row.independenceLevel)
      ? row.independenceLevel
      : 'assist') as IndependenceLevel,
  };
  if (requireHumanFor.length > 0) independence.requireHumanFor = requireHumanFor;
  if (autoScopes.length > 0) independence.autoScopes = autoScopes;
  const policy = parsePolicyJson(row.policy);
  const homeFolderId = normalizeOptionalId(row.homeFolderId);

  const model: PersonaModelRouting = { taskClasses: toTaskClasses(row) };
  if (row.fallbackModel !== null) model.fallback = row.fallbackModel;
  if (row.providerId !== null) model.providerId = row.providerId;

  return {
    id: row.id,
    name: row.name,
    character: {
      voice: row.voice,
      language: row.language,
      systemPrompt: row.systemPrompt,
      temperature: row.temperature,
    },
    model,
    independence,
    memory: toMemoryFlags(row),
    ...(policy !== undefined ? { policy } : {}),
    ...(homeFolderId !== undefined ? { homeFolderId } : {}),
    isDefault: row.isDefault === 1,
    paused: row.paused === 1,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toPersona(row: PersonaRow): Persona {
  const persona = toRowPersona(row);
  if (row.tagline !== null) persona.tagline = row.tagline;
  if (row.avatar !== null) persona.avatar = row.avatar;
  if (row.colorTheme !== null) persona.colorTheme = row.colorTheme;
  return persona;
}

// ---------------------------------------------------------------------------
// Normalization + validation (shared by create and update).
// ---------------------------------------------------------------------------

function normalizeCharacter(raw: Partial<PersonaCharacter> | undefined): PersonaCharacter {
  const body = raw ?? {};
  const voice = typeof body.voice === 'string' ? body.voice.trim() : '';
  const language = typeof body.language === 'string' ? body.language.trim() : '';
  const systemPrompt = typeof body.systemPrompt === 'string' ? body.systemPrompt : '';
  let temperature = 0.7;
  if (body.temperature !== undefined) {
    if (typeof body.temperature !== 'number' || !Number.isFinite(body.temperature)) {
      throw personaError('invalid_input', 'character.temperature must be a finite number');
    }
    // Clamp into [0, 2] (PLAN-M3: "temperature clamped 0..2").
    temperature = Math.min(TEMPERATURE_MAX, Math.max(TEMPERATURE_MIN, body.temperature));
  }
  return {
    voice: voice === '' ? 'neutral' : voice,
    language: language === '' ? 'en' : language,
    systemPrompt,
    temperature,
  };
}

function normalizeModel(raw: Partial<PersonaModelRouting> | undefined): PersonaModelRouting {
  const body = raw ?? {};
  const taskClasses: TaskClassMap = {};
  const rawMap = body.taskClasses ?? {};
  for (const taskClass of TASK_CLASSES) {
    const model = rawMap[taskClass];
    if (typeof model === 'string' && model.trim() !== '') {
      taskClasses[taskClass] = model.trim();
    }
  }
  const model: PersonaModelRouting = { taskClasses };
  if (typeof body.fallback === 'string' && body.fallback.trim() !== '') {
    model.fallback = body.fallback.trim();
  }
  if (typeof body.providerId === 'string' && body.providerId.trim() !== '') {
    model.providerId = body.providerId.trim();
  }
  return model;
}

function normalizeIndependence(
  raw: Partial<PersonaIndependence> | undefined,
): PersonaIndependence {
  const body = raw ?? {};
  const level = body.level ?? 'assist';
  if (!INDEPENDENCE_LEVELS.has(level)) {
    throw personaError(
      'invalid_input',
      `independence.level must be one of assist|suggest|auto|autonomous (got ${String(level)})`,
    );
  }
  const independence: PersonaIndependence = { level };
  const requireHumanFor = body.requireHumanFor ?? ['high'];
  if (!Array.isArray(requireHumanFor) || requireHumanFor.some((t) => !HUMAN_TIERS.has(t))) {
    throw personaError('invalid_input', 'independence.requireHumanFor must list high|medium tiers');
  }
  if (requireHumanFor.length > 0) {
    independence.requireHumanFor = [...new Set(requireHumanFor)] as Array<'high' | 'medium'>;
  }
  const autoScopes = body.autoScopes ?? [];
  if (!Array.isArray(autoScopes) || autoScopes.some((s) => typeof s !== 'string')) {
    throw personaError('invalid_input', 'independence.autoScopes must be a string array');
  }
  if (autoScopes.length > 0) independence.autoScopes = autoScopes as string[];
  return independence;
}

function normalizeMemory(raw: Partial<PersonaMemoryFlags> | undefined): PersonaMemoryFlags {
  const body = raw ?? {};
  const userProfile = body.userProfile ?? 'none';
  const episodes = body.episodes ?? 'none';
  if (!USER_PROFILE_ACCESS.has(userProfile)) {
    throw personaError('invalid_input', "memory.userProfile must be 'read' or 'none'");
  }
  if (!EPISODE_ACCESS.has(episodes)) {
    throw personaError('invalid_input', "memory.episodes must be 'read+write' or 'none'");
  }
  return {
    userProfile: userProfile as 'read' | 'none',
    episodes: episodes as 'read+write' | 'none',
  };
}

/** Normalize an optional F3 policy: valid arrays only, trimmed, deduped. */
function normalizePolicy(raw: unknown): PersonaPolicy | undefined {
  if (raw === null || raw === undefined) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const body = raw as { skills?: unknown; tools?: unknown };
  const policy: PersonaPolicy = {};
  const strings = (value: unknown): string[] | undefined => {
    if (!Array.isArray(value)) return undefined;
    const cleaned = value
      .filter((entry): entry is string => typeof entry === 'string')
      .map((entry) => entry.trim())
      .filter((entry) => entry !== '');
    return [...new Set(cleaned)].slice(0, 200);
  };
  const skills = body.skills;
  if (skills !== undefined && skills !== null && typeof skills === 'object') {
    const defaults = strings((skills as { default?: unknown }).default);
    const banned = strings((skills as { banned?: unknown }).banned);
    if (defaults !== undefined || banned !== undefined) {
      policy.skills = {};
      if (defaults !== undefined && defaults.length > 0) policy.skills.default = defaults;
      if (banned !== undefined && banned.length > 0) policy.skills.banned = banned;
    }
  }
  const tools = body.tools;
  if (tools !== undefined && tools !== null && typeof tools === 'object') {
    const allowed = strings((tools as { allowed?: unknown }).allowed);
    const banned = strings((tools as { banned?: unknown }).banned);
    if (allowed !== undefined || banned !== undefined) {
      policy.tools = {};
      if (allowed !== undefined && allowed.length > 0) policy.tools.allowed = allowed;
      if (banned !== undefined && banned.length > 0) policy.tools.banned = banned;
    }
  }
  return Object.keys(policy).length === 0 ? undefined : policy;
}

/** Parse the stored policy JSON column back to a wire policy. */
function normalizeOptionalId(raw: unknown): string | undefined {
  if (raw === null || raw === undefined) return undefined;
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  return trimmed === '' ? undefined : trimmed;
}

function parsePolicyJson(json: string | null): PersonaPolicy | undefined {
  if (json === null || json === '') return undefined;
  try {
    return normalizePolicy(JSON.parse(json));
  } catch {
    return undefined;
  }
}

function requireName(raw: unknown): string {
  const name = typeof raw === 'string' ? raw.trim() : '';
  if (name === '') throw personaError('invalid_input', 'name is required and must be non-empty');
  return name;
}

/** Build a row from a full Persona wire object (after normalization). */
function personaToRow(persona: Persona): PersonaRow {
  return {
    id: persona.id,
    name: persona.name,
    tagline: persona.tagline ?? null,
    avatar: persona.avatar ?? null,
    colorTheme: persona.colorTheme ?? null,
    voice: persona.character.voice,
    language: persona.character.language,
    systemPrompt: persona.character.systemPrompt,
    temperature: persona.character.temperature,
    taskClasses:
      Object.keys(persona.model.taskClasses).length > 0
        ? JSON.stringify(persona.model.taskClasses)
        : null,
    fallbackModel: persona.model.fallback ?? null,
    providerId: persona.model.providerId ?? null,
    independenceLevel: persona.independence.level,
    requireHuman:
      persona.independence.requireHumanFor && persona.independence.requireHumanFor.length > 0
        ? JSON.stringify(persona.independence.requireHumanFor)
        : null,
    autoScopes:
      persona.independence.autoScopes && persona.independence.autoScopes.length > 0
        ? JSON.stringify(persona.independence.autoScopes)
        : null,
    memoryFlags: JSON.stringify(persona.memory),
    policy:
      persona.policy !== undefined && Object.keys(persona.policy).length > 0
        ? JSON.stringify(persona.policy)
        : null,
    homeFolderId: persona.homeFolderId ?? null,
    isDefault: persona.isDefault ? 1 : 0,
    paused: persona.paused ? 1 : 0,
    createdAt: persona.createdAt,
    updatedAt: persona.updatedAt,
  };
}

export function createPersonaManager(options: PersonaManagerOptions): PersonaManager {
  const { store, audit } = options;
  const now = options.now ?? Date.now;

  /** Clear the current default (single-default invariant). */
  function clearCurrentDefault(): void {
    const current = store.list().find((row) => row.isDefault === 1);
    if (current) {
      store.update(current.id, { isDefault: 0, updatedAt: now() });
    }
  }

  function auditPersona(action: string, persona: Persona, extra: Record<string, unknown> = {}): void {
    audit.log('web', action, persona.id, {
      name: persona.name,
      level: persona.independence.level,
      isDefault: persona.isDefault,
      paused: persona.paused,
      ...extra,
    });
  }

  function create(input: PersonaDraft): Persona {
    const body = (input ?? {}) as PersonaDraft;
    const name = requireName(body.name);
    const id = randomUUID();
    const at = now();
    const isDefault = body.isDefault === true;
    if (isDefault) clearCurrentDefault();

    const persona: Persona = {
      id,
      name,
      character: normalizeCharacter(body.character),
      model: normalizeModel(body.model),
      independence: normalizeIndependence(body.independence),
      memory: normalizeMemory(body.memory),
      isDefault,
      paused: false,
      createdAt: at,
      updatedAt: at,
    };
    if (body.tagline !== undefined) persona.tagline = body.tagline;
    if (body.avatar !== undefined) persona.avatar = body.avatar;
    if (body.colorTheme !== undefined) persona.colorTheme = body.colorTheme;
    if (body.policy !== undefined) persona.policy = normalizePolicy(body.policy);
    if (body.homeFolderId !== undefined) {
      persona.homeFolderId = normalizeOptionalId(body.homeFolderId);
      if (persona.homeFolderId === undefined) delete persona.homeFolderId;
    }
    store.insert(personaToRow(persona));
    auditPersona('persona.create', persona);
    return persona;
  }

  function get(id: string): Persona | null {
    const row = store.findById(id);
    return row ? toPersona(row) : null;
  }

  function list(): Persona[] {
    return store.list().map(toPersona);
  }

  function update(id: string, patch: PersonaPatch): Persona {
    const row = store.findById(id);
    if (!row) throw personaError('not_found', 'persona not found');
    const current = toRowPersona(row);
    const body = (patch ?? {}) as PersonaPatch;

    if (body.name !== undefined) current.name = requireName(body.name);
    if (body.tagline !== undefined) current.tagline = body.tagline;
    if (body.avatar !== undefined) current.avatar = body.avatar;
    if (body.colorTheme !== undefined) current.colorTheme = body.colorTheme;
    if (body.character !== undefined) {
      // Merge: partial character patches keep untouched fields.
      const merged: PersonaCharacter = {
        ...current.character,
        ...body.character,
      };
      current.character = normalizeCharacter(merged);
    }
    if (body.model !== undefined) {
      const merged: PersonaModelRouting = {
        ...current.model,
        ...body.model,
        taskClasses: { ...current.model.taskClasses, ...(body.model.taskClasses ?? {}) },
      };
      current.model = normalizeModel(merged);
    }
    if (body.independence !== undefined) {
      const merged: PersonaIndependence = {
        ...current.independence,
        ...body.independence,
        requireHumanFor: body.independence.requireHumanFor ?? current.independence.requireHumanFor,
        autoScopes: body.independence.autoScopes ?? current.independence.autoScopes,
      };
      current.independence = normalizeIndependence(merged);
    }
    if (body.memory !== undefined) {
      current.memory = normalizeMemory({ ...current.memory, ...body.memory });
    }
    if (body.policy !== undefined) {
      current.policy = normalizePolicy(body.policy);
      if (current.policy === undefined) delete current.policy;
    }
    if (body.homeFolderId !== undefined) {
      current.homeFolderId = normalizeOptionalId(body.homeFolderId);
      if (current.homeFolderId === undefined) delete current.homeFolderId;
    }
    if (body.isDefault !== undefined) {
      if (body.isDefault) {
        clearCurrentDefault();
        current.isDefault = true;
      } else if (current.isDefault) {
        // Invariant (PLAN-M3): a default persona must exist while personas
        // exist. Unsetting the sole default flag auto-relocates it to the
        // oldest remaining persona; refusing when this is the last persona.
        const others = store.list().filter((r) => r.id !== id);
        if (others.length === 0) {
          throw personaError('conflict', 'the default flag cannot be removed from the last persona');
        }
        const oldest = others.reduce((a, b) => (a.createdAt <= b.createdAt ? a : b));
        store.update(oldest.id, { isDefault: 1, updatedAt: now() });
        current.isDefault = false;
      }
    }

    const mergedPersona: Persona = { ...current, updatedAt: now() };
    store.update(id, personaRowPatch(mergedPersona));
    const updated = store.findById(id);
    if (!updated) throw personaError('not_found', 'persona not found');
    auditPersona('persona.update', toPersona(updated));
    return toPersona(updated);
  }

  function personaRowPatch(persona: Persona): PersonaRowPatch {
    const patch: PersonaRowPatch = { updatedAt: persona.updatedAt };
    patch.name = persona.name;
    patch.tagline = persona.tagline ?? null;
    patch.avatar = persona.avatar ?? null;
    patch.colorTheme = persona.colorTheme ?? null;
    patch.voice = persona.character.voice;
    patch.language = persona.character.language;
    patch.systemPrompt = persona.character.systemPrompt;
    patch.temperature = persona.character.temperature;
    patch.taskClasses =
      Object.keys(persona.model.taskClasses).length > 0
        ? JSON.stringify(persona.model.taskClasses)
        : null;
    patch.fallbackModel = persona.model.fallback ?? null;
    patch.providerId = persona.model.providerId ?? null;
    patch.independenceLevel = persona.independence.level;
    patch.requireHuman =
      persona.independence.requireHumanFor && persona.independence.requireHumanFor.length > 0
        ? JSON.stringify(persona.independence.requireHumanFor)
        : null;
    patch.autoScopes =
      persona.independence.autoScopes && persona.independence.autoScopes.length > 0
        ? JSON.stringify(persona.independence.autoScopes)
        : null;
    patch.memoryFlags = JSON.stringify(persona.memory);
    patch.policy =
      persona.policy !== undefined && Object.keys(persona.policy).length > 0
        ? JSON.stringify(persona.policy)
        : null;
    patch.homeFolderId = persona.homeFolderId ?? null;
    patch.isDefault = persona.isDefault ? 1 : 0;
    patch.paused = persona.paused ? 1 : 0;
    return patch;
  }

  function remove(id: string): void {
    const row = store.findById(id);
    if (!row) throw personaError('not_found', 'persona not found');
    // The default persona cannot be removed while it holds the single
    // isDefault flag ("the last isDefault persona cannot be removed") — the
    // caller must set another persona as default first. Conversations keep
    // personaId denormalized, so deleting a non-default persona never blocks.
    if (row.isDefault === 1) {
      throw personaError(
        'conflict',
        'the default persona cannot be deleted — set another persona as default first',
      );
    }
    store.remove(id);
    audit.log('web', 'persona.delete', id, { name: row.name, level: row.independenceLevel });
  }

  function seedIfEmpty(): number {
    if (store.count() > 0) return 0;
    const base = now();
    STARTER_SEEDS.forEach((seed, index) => {
      const character: PersonaCharacter = {
        voice: seed.level === 'auto' ? 'direct-engineer' : 'warm-professional',
        language: 'en',
        systemPrompt: STARTER_SYSTEM_PROMPT,
        temperature: seed.temperature,
      };
      const at = base + index;
      const persona: Persona = {
        id: seed.id,
        name: seed.name,
        tagline: seed.tagline,
        character,
        model: { taskClasses: {} },
        independence: { level: seed.level, requireHumanFor: ['high'] },
        memory: { userProfile: 'none', episodes: 'none' },
        isDefault: seed.isDefault,
        paused: false,
        createdAt: at,
        updatedAt: at,
      };
      store.insert(personaToRow(persona));
      auditPersona('persona.create', persona, { seed: true });
    });
    return STARTER_SEEDS.length;
  }

  function setPaused(id: string, paused: boolean): Persona {
    const row = store.findById(id);
    if (!row) throw personaError('not_found', 'persona not found');
    if ((row.paused === 1) === paused) return toPersona(row);
    store.update(id, { paused: paused ? 1 : 0, updatedAt: now() });
    const updated = store.findById(id);
    if (!updated) throw personaError('not_found', 'persona not found');
    audit.log('web', paused ? 'persona.pause' : 'persona.resume', id, {
      name: row.name,
    });
    return toPersona(updated);
  }

  function pause(id: string): Persona {
    return setPaused(id, true);
  }

  function resume(id: string): Persona {
    return setPaused(id, false);
  }

  function isPaused(id: string): boolean {
    const row = store.findById(id);
    return row ? row.paused === 1 : false;
  }

  return { list, get, create, update, remove, seedIfEmpty, pause, resume, isPaused };
}
