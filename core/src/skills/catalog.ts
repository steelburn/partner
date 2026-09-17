/**
 * Local skill catalog reader (M8, PLAN-M8.md). The v1 catalog is a checked-in
 * tree of skill bundles — `skills-catalog/<id>/manifest.json` + `entry.mjs`
 * (+ any assets) — with NO remote gallery or package signing (documented
 * deviation). Each manifest is validated against the shared SkillManifest
 * shape AND the broker tool registry (a declared tool that does not exist in
 * M8's files.* set excludes the skill) before it is listed.
 *
 * Network capability is reserved: a network:true skill is EXCLUDED from the
 * listing with a catalog warning and REFUSED at install with the typed
 * `network_not_supported` error (PLAN-M8: no network-capable tools exist in
 * M8, so a skill that declares network can never run within its manifest).
 *
 * The folder name IS the catalog id — a manifest whose id does not match its
 * folder is treated as a malformed entry (id drift would make install
 * ambiguous). readCatalog never throws on a bad entry: it records a warning
 * and excludes the skill so one broken bundle cannot take the catalog down.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { CatalogSkill, SkillManifest, ToolId } from '@partner/shared';
import { TOOL_MANIFESTS } from '../broker/toolManifests.js';
import { skillError, SkillError } from './errors.js';
// M26 cut A: the shape validator moved to ./manifest.js so an authored draft and
// an installed bundle are held to ONE bar. Re-exported here because this module
// was its only public door before the move (existing importers keep working).
import { ID_RE, validateManifestShape } from './manifest.js';
import type { RuntimeCapabilities } from './manifest.js';
export { validateManifestShape } from './manifest.js';
export type { ManifestValidation } from './manifest.js';


export interface CatalogReadOptions {
  /** Broker tool registry; defaults to the broker's manifest set. */
  tools?: ReadonlySet<string>;
  /**
   * M27 S5: which reaches this build's runtime can honour, forwarded to the
   * SHAPE validator so a checked-in bundle may declare a wired reach
   * (`permissions.llm`). Omitted keeps the conservative library default
   * (`{ mcp: false, llm: false }`) - the catalog is the door that reads
   * manifests from DISK, so it must be told, not assume.
   */
  capabilities?: RuntimeCapabilities;
}

export interface CatalogReadResult {
  /** Valid, listable skills only (network + malformed entries excluded). */
  skills: CatalogSkill[];
  /** Human-readable per-entry problems (never content — ids/reasons only). */
  warnings: string[];
}

/** A fully validated catalog skill bundle (install input for the manager). */
export interface LoadedCatalogSkill {
  manifest: SkillManifest;
  /** Absolute path of the bundle folder (manifest.json + code live here). */
  dir: string;
}


/** The default skill tool registry — derived from the broker's manifests. */
export function defaultToolRegistry(): ReadonlySet<string> {
  // M27 S1: derived from TOOL_MANIFESTS rather than hard-coding the files.*
  // ids. The registry the INSTALLER checks and the registry the BROKER
  // dispatches must be the same list, or a manifest that validates fails at run
  // time (and vice versa). One derivation, no drift.
  return new Set(TOOL_MANIFESTS.map((m) => m.id));
}

function toCatalogSkill(manifest: SkillManifest): CatalogSkill {
  return {
    id: manifest.id,
    name: manifest.name,
    description: manifest.description,
    author: manifest.author,
    version: manifest.version,
    permissions: manifest.permissions,
  };
}

/** Folder names that are never catalog skills (dotfiles, metadata). */
function isBundleDir(name: string): boolean {
  return name !== '' && !name.startsWith('.') && ID_RE.test(name);
}

/**
 * Read + validate every bundle under `dir`. Never throws on a broken entry:
 * problems become warnings and the offending skill is excluded, so a single
 * bad bundle cannot take the whole catalog down.
 */
export function readCatalog(dir: string, options: CatalogReadOptions = {}): CatalogReadResult {
  const warnings: string[] = [];
  const skills: CatalogSkill[] = [];
  const registry = options.tools ?? defaultToolRegistry();
  const capabilities = options.capabilities;

  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return { skills, warnings: [`catalog not found at ${dir}`] };
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || !isBundleDir(entry.name)) continue;
    const bundleDir = join(dir, entry.name);
    const warn = (message: string): void => {
      warnings.push(`[${entry.name}] ${message}`);
    };
    try {
      const loaded = loadBundle(bundleDir, entry.name, registry, capabilities);
      if (loaded.ok) {
        skills.push(toCatalogSkill(loaded.manifest));
      } else if (loaded.network === true) {
        warn('network skills are not supported in M8 — excluded');
      } else {
        for (const message of loaded.errors) warn(message);
      }
    } catch (err) {
      if (err instanceof SkillError) {
        warn(err.message);
      } else {
        warn('unreadable bundle');
      }
    }
  }
  return { skills, warnings };
}

type BundleLoad =
  | { ok: true; manifest: SkillManifest }
  | { ok: false; errors: string[]; network?: boolean };

/** Load + validate one bundle (shape + registry + entrypoint on disk). */
function loadBundle(
  bundleDir: string,
  expectedId: string,
  registry: ReadonlySet<string>,
  capabilities?: RuntimeCapabilities,
): BundleLoad {
  const manifestFile = join(bundleDir, 'manifest.json');
  let text: string;
  try {
    text = readFileSync(manifestFile, 'utf8');
  } catch {
    return { ok: false, errors: ['missing manifest.json'] };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    return { ok: false, errors: ['manifest.json is not valid JSON'] };
  }
  const shape = validateManifestShape(raw, capabilities === undefined ? {} : { capabilities });
  if (!shape.ok) return { ok: false, errors: shape.errors };
  const manifest = shape.manifest;
  if (manifest.id !== expectedId) {
    return { ok: false, errors: [`manifest id "${manifest.id}" does not match its folder`] };
  }
  if (manifest.permissions.network) {
    return { ok: false, errors: ['network skills are not supported in M8'], network: true };
  }
  const unknown = manifest.permissions.tools.filter((tool) => !registry.has(tool));
  if (unknown.length > 0) {
    return {
      ok: false,
      errors: [`declares unknown tool${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')}`],
    };
  }
  if (!existsSync(join(bundleDir, manifest.entrypoint))) {
    return { ok: false, errors: [`entrypoint ${manifest.entrypoint} is missing`] };
  }
  return { ok: true, manifest };
}

/**
 * Load + validate ONE catalog bundle by id for install. Throws typed
 * SkillErrors: not_found (unknown catalog id), invalid_input (malformed
 * bundle / unknown tools / missing entrypoint) and network_not_supported
 * (the PLAN-M8 network refusal).
 */
export function loadCatalogSkill(
  dir: string,
  id: string,
  options: CatalogReadOptions = {},
): LoadedCatalogSkill {
  const clean = typeof id === 'string' ? id.trim() : '';
  if (clean === '' || !isBundleDir(clean)) {
    throw skillError('not_found', `no skill "${clean}" in the catalog`);
  }
  const registry = options.tools ?? defaultToolRegistry();
  const bundleDir = join(dir, clean);
  if (!existsSync(join(bundleDir, 'manifest.json'))) {
    throw skillError('not_found', `no skill "${clean}" in the catalog`);
  }
  const loaded = loadBundle(bundleDir, clean, registry, options.capabilities);
  if (!loaded.ok) {
    if (loaded.network === true) {
      throw skillError(
        'network_not_supported',
        `skill "${clean}" declares network capability — network skills are not supported in M8`,
      );
    }
    throw skillError('invalid_input', `skill "${clean}" is not installable: ${loaded.errors[0]}`);
  }
  return { manifest: loaded.manifest, dir: bundleDir };
}
