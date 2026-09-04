/**
 * M6 theme manager (PLAN-M6.md §"Core API" / "manager").
 *
 * Owns the lifecycle rules a plain row store must not: the lint + contrast
 * gate on every save/update (gates.ts), the two immutable preset rows seeded
 * only when the table is empty (presets.ts), the immutable-preset and
 * not-while-active delete refusals, global activation (settings key
 * `active_theme`), per-persona binding via the existing `colorTheme` column
 * (M3), and active resolution (persona -> global active -> preset-default).
 *
 * Privacy/redaction discipline (PLAN-M6): theme token bodies are NOT
 * secrets — but audit rows carry ids/names/source only, never the token
 * documents. Writes never touch the clock except through the injected `now`.
 */
import { randomUUID } from 'node:crypto';
import type {
  ActiveTheme,
  ThemeActivation,
  ThemeProfile,
  ThemeSaveInput,
  ThemeSource,
  ThemeTokens,
} from '@partner/shared';
import { TOKENS } from '@partner/shared';
import type { AuditService } from '../services/redaction.js';
import type { PersonaStore, SettingsStore, ThemeRow, ThemeStore } from '../stores/types.js';
import { themeError } from './errors.js';
import { validateTheme } from './gates.js';
import { PRESET_DEFAULT, THEME_PRESETS, presetProfile } from './presets.js';

/** Settings key holding the globally active theme id (default preset-default). */
export const ACTIVE_THEME_KEY = 'active_theme';

export interface ThemeManagerOptions {
  store: ThemeStore;
  /** M3 persona store — binding writes its existing `colorTheme` column. */
  personaStore: PersonaStore;
  /** M0 settings store — activation writes the `active_theme` key. */
  settings: SettingsStore;
  /** Injectable clock (epoch ms). */
  now?: () => number;
  audit: AuditService;
}

export interface ThemeManager {
  /** Presets first (Default, Midnight), then saved customs, oldest first. */
  list(): ThemeProfile[];
  /** Theme by id (preset or custom), or null when absent. */
  get(id: string): ThemeProfile | null;
  /**
   * Create a custom theme (id `custom-<uuid>`). The lint + contrast gate
   * runs first: a failing theme throws themeError('invalid_input', …) whose
   * .report carries the full ThemeReport for the UI. Blank name -> 400.
   */
  save(input: ThemeSaveInput): ThemeProfile;
  /**
   * Update a custom theme under the same gate (partial: omitted name keeps
   * the current one; omitted modes keep the current tokens; the MERGED theme
   * is what must pass). Presets -> conflict 409.
   */
  update(id: string, input: ThemeSaveInput): ThemeProfile;
  /** Remove a custom theme. Unknown -> 404; preset or currently active -> 409. */
  remove(id: string): void;
  /**
   * Activate a theme globally (settings `active_theme`), returning its
   * {id, source}. Unknown theme -> 404. Clears nothing per-persona — those
   * bindings still win for their persona (activate + clear-override lives in
   * the web layer by unbinding).
   */
  activate(id: string): ThemeActivation;
  /**
   * Bind/clear a persona's theme override (`colorTheme` column). themeId null
   * clears. Theme must exist (404 when not); persona must exist (404).
   */
  bindPersonaTheme(personaId: string, themeId: string | null): void;
  /**
   * Resolve the active theme for a request: persona.colorTheme (when the id
   * resolves) -> global active_theme -> preset-default. An unknown bound id
   * or persona silently falls back (the bound theme was deleted; resolution
   * never errors).
   */
  active(personaId?: string): ActiveTheme;
  /** Insert the preset rows ONLY when the themes table is empty (returns
   *  how many were inserted). Presets are static boot content, so seeding is
   *  NOT audited. */
  seedIfEmpty(): number;
}

// ---------------------------------------------------------------------------
// Row <-> profile serialization. JSON token docs parse leniently so a
// hand-edited or older row can never crash the surface; the fallback is the
// shipped token document for that mode.
// ---------------------------------------------------------------------------

function parseTokens(json: string, mode: 'light' | 'dark'): ThemeTokens {
  try {
    const parsed = JSON.parse(json) as unknown;
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as ThemeTokens;
    }
  } catch {
    // Fall through to the shipped tokens.
  }
  return { ...TOKENS[mode] };
}

function profileOf(row: ThemeRow): ThemeProfile {
  return {
    id: row.id,
    name: row.name,
    source: (row.source === 'preset' ? 'preset' : 'custom') as ThemeSource,
    light: parseTokens(row.lightJson, 'light'),
    dark: parseTokens(row.darkJson, 'dark'),
  };
}

/** The known profiles: shipped presets first (row when seeded, else module),
 *  then saved customs oldest-first. Presets always resolve even if a fresh
 *  database somehow booted without seed rows. */
function knownProfiles(store: ThemeStore): ThemeProfile[] {
  const rows = store.list();
  const presets: ThemeProfile[] = [];
  for (const preset of THEME_PRESETS) {
    const row = rows.find((r) => r.id === preset.id);
    presets.push(row ? profileOf(row) : presetProfile(preset));
  }
  const customs = rows
    .filter((r) => r.source !== 'preset')
    .map(profileOf);
  return [...presets, ...customs];
}

function bodyOf(input: unknown): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return {};
  return input as Record<string, unknown>;
}

function requireName(body: Record<string, unknown>): string {
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (name === '') throw themeError('invalid_input', 'theme name is required');
  return name;
}

/** Serialize a validated token doc (gate passed: every key is hex). */
function serializeDoc(doc: unknown): string {
  return JSON.stringify(doc);
}

export function createThemeManager(options: ThemeManagerOptions): ThemeManager {
  const { store, personaStore, settings, audit } = options;
  const now = options.now ?? Date.now;

  function get(id: string): ThemeProfile | null {
    const known = knownProfiles(store);
    const found = known.find((p) => p.id === id);
    return found ?? null;
  }

  function list(): ThemeProfile[] {
    return knownProfiles(store);
  }

  function save(input: ThemeSaveInput): ThemeProfile {
    const body = bodyOf(input);
    const name = requireName(body);
    const report = validateTheme({ light: body.light, dark: body.dark });
    if (!report.ok) {
      throw themeError('invalid_input', 'theme failed validation', report);
    }
    const at = now();
    const profile: ThemeProfile = {
      id: `custom-${randomUUID()}`,
      name,
      source: 'custom',
      light: body.light as ThemeTokens,
      dark: body.dark as ThemeTokens,
    };
    store.insert({
      id: profile.id,
      name: profile.name,
      source: 'custom',
      lightJson: serializeDoc(body.light),
      darkJson: serializeDoc(body.dark),
      createdAt: at,
      updatedAt: at,
    });
    audit.log('web', 'theme.create', profile.id, {
      name: profile.name,
      source: 'custom',
    });
    return profile;
  }

  function update(id: string, input: ThemeSaveInput): ThemeProfile {
    const row = store.findById(id);
    if (!row) throw themeError('not_found', 'theme not found');
    if (row.source === 'preset') {
      throw themeError('conflict', 'preset themes are immutable — copy one to customize');
    }
    const body = bodyOf(input);
    const current = profileOf(row);
    const name = body.name !== undefined ? requireName(body) : current.name;
    // Partial edit: omitted modes keep the current tokens; the MERGED theme
    // is what must pass the gate.
    const nextLight = body.light !== undefined ? body.light : current.light;
    const nextDark = body.dark !== undefined ? body.dark : current.dark;
    const report = validateTheme({ light: nextLight, dark: nextDark });
    if (!report.ok) {
      throw themeError('invalid_input', 'theme failed validation', report);
    }
    store.update(id, {
      name,
      lightJson: serializeDoc(nextLight),
      darkJson: serializeDoc(nextDark),
      updatedAt: now(),
    });
    audit.log('web', 'theme.update', id, { name, source: 'custom' });
    const updated = store.findById(id);
    if (!updated) throw themeError('not_found', 'theme not found');
    return profileOf(updated);
  }

  function remove(id: string): void {
    const row = store.findById(id);
    if (!row) throw themeError('not_found', 'theme not found');
    if (row.source === 'preset') {
      throw themeError('conflict', 'preset themes cannot be deleted');
    }
    if (settings.get(ACTIVE_THEME_KEY) === id) {
      throw themeError(
        'conflict',
        'the active theme cannot be deleted — activate another theme first',
      );
    }
    store.remove(id);
    audit.log('web', 'theme.delete', id, { name: row.name, source: 'custom' });
  }

  function activate(id: string): ThemeActivation {
    const profile = get(id);
    if (!profile) throw themeError('not_found', 'theme not found');
    settings.set(ACTIVE_THEME_KEY, profile.id, now());
    audit.log('web', 'theme.activate', profile.id, {
      name: profile.name,
      source: profile.source,
    });
    return { id: profile.id, source: profile.source };
  }

  function bindPersonaTheme(personaId: string, themeId: string | null): void {
    const persona = personaStore.findById(personaId);
    if (!persona) throw themeError('not_found', 'persona not found');
    let name: string | null = null;
    if (themeId !== null) {
      const profile = get(themeId);
      if (!profile) throw themeError('not_found', 'theme not found');
      name = profile.name;
    }
    personaStore.update(personaId, { colorTheme: themeId, updatedAt: now() });
    audit.log('web', 'theme.bind', personaId, {
      themeId,
      themeName: name,
    });
  }

  function active(personaId?: string): ActiveTheme {
    const known = knownProfiles(store);
    // 1. Per-persona override (persona.colorTheme). An unknown bound id or an
    //    unknown persona falls through to the global/global default.
    if (personaId !== undefined && personaId !== '') {
      const persona = personaStore.findById(personaId);
      if (persona?.colorTheme !== null && persona?.colorTheme !== undefined) {
        const bound = known.find((p) => p.id === persona.colorTheme);
        if (bound) return toActive(bound);
        // Bound theme was deleted — fall back (future warnings channel).
      }
    }
    // 2. Globally activated theme.
    const activeId = settings.get(ACTIVE_THEME_KEY);
    if (activeId !== null) {
      const globalTheme = known.find((p) => p.id === activeId);
      if (globalTheme) return toActive(globalTheme);
    }
    // 3. preset-default (module fallback so resolution can never come up empty).
    const presetDefault = known.find((p) => p.id === PRESET_DEFAULT.id);
    return toActive(presetDefault ?? PRESET_DEFAULT);
  }

  function seedIfEmpty(): number {
    if (store.count() > 0) return 0;
    const base = now();
    THEME_PRESETS.forEach((preset, index) => {
      const at = base + index;
      store.insert({
        id: preset.id,
        name: preset.name,
        source: 'preset',
        lightJson: serializeDoc(preset.light),
        darkJson: serializeDoc(preset.dark),
        createdAt: at,
        updatedAt: at,
      });
    });
    return THEME_PRESETS.length;
  }

  return { list, get, save, update, remove, activate, bindPersonaTheme, active, seedIfEmpty };
}

function toActive(profile: ThemeProfile): ActiveTheme {
  return {
    themeId: profile.id,
    source: profile.source,
    light: profile.light,
    dark: profile.dark,
  };
}
