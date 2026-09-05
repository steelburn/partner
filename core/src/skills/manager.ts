/**
 * Skill manager (M8, PLAN-M8.md) — the installed-skill lifecycle over the
 * per-core store:
 *
 *   install(catalogId)  validate manifest -> sha256 the entry file -> copy
 *                       the whole bundle from the catalog into
 *                       storeDir/<id>/ (default-deny install: the catalog
 *                       listing already excluded network/malformed skills;
 *                       install re-validates and REFUSES network:true with
 *                       network_not_supported) -> record the row.
 *   list/get            installed summaries/details.
 *   disable/enable      status transitions (conflict on no-op transitions).
 *   remove(id)          uninstall: wipes the code dir + the skill row + its
 *                       invocation metadata.
 *
 * Installed skills are user-scoped (this core's profile): the store lives
 * under <data>/skills/ next to this core's SQLite. Audit rows carry
 * ids/versions only — never skill code, logs, args or results.
 */
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type {
  CatalogSkill,
  SkillDetail,
  SkillInvocationMeta,
  SkillManifest,
  SkillSummary,
} from '@partner/shared';
import type { AuditService } from '../services/redaction.js';
import type {
  SkillInvocationRow,
  SkillInvocationStore,
  SkillRow,
  SkillRowPatch,
  SkillStore,
} from '../stores/types.js';
import { loadCatalogSkill, readCatalog } from './catalog.js';
import type { CatalogReadResult } from './catalog.js';
import { skillError } from './errors.js';

export interface SkillManagerOptions {
  /** skills row store (same SQLite as the rest of the core). */
  store: SkillStore;
  /** skill_invocations row store (cascade on uninstall + history reads). */
  invocations: SkillInvocationStore;
  /** Where installed code lives: storeDir/<id>/ (config.skillsDir). */
  storeDir: string;
  /** The checked-in local catalog (repo skills-catalog/). */
  catalogDir: string;
  /** Broker tool registry — declared tools must exist in M8's set. */
  tools: ReadonlySet<string>;
  audit: AuditService;
  /** Injectable clock (epoch ms). */
  now?: () => number;
}

export interface SkillManager {
  /** Read-only catalog listing + per-entry warnings (excludes bad bundles). */
  catalog(): CatalogReadResult;
  /** Validate + copy code + record the row. Conflict when already installed. */
  install(catalogId: string): SkillSummary;
  /** Installed skills (any status), oldest first. */
  list(): SkillSummary[];
  /** Full detail incl. the parsed manifest; null when not installed. */
  get(id: string): SkillDetail | null;
  disable(id: string): SkillSummary;
  enable(id: string): SkillSummary;
  /** Uninstall: wipes code dir + rows; throws not_found for unknown ids. */
  remove(id: string): void;
  /** Recent invocation metadata for a skill (newest first). */
  listInvocations(skillId: string, limit?: number): SkillInvocationMeta[];
}

const DEFAULT_INVOCATION_LIMIT = 50;
const MAX_INVOCATION_LIMIT = 200;

function rowToSummary(row: SkillRow): SkillSummary {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? '',
    author: row.author,
    version: row.version,
    source: row.source as SkillSummary['source'],
    status: row.status as SkillSummary['status'],
    sha256: row.sha256,
    installedAt: row.installedAt,
    updatedAt: row.updatedAt,
  };
}

function rowToDetail(row: SkillRow): SkillDetail {
  return { ...rowToSummary(row), manifest: JSON.parse(row.manifestJson) as SkillManifest };
}

function rowToMeta(row: SkillInvocationRow): SkillInvocationMeta {
  return {
    id: row.id,
    skillId: row.skillId,
    personaId: row.personaId,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    ok: row.ok === 1,
    toolCalls: row.toolCalls,
    error: row.error,
    ms: row.ms,
  };
}

export function createSkillManager(options: SkillManagerOptions): SkillManager {
  const { store, invocations, storeDir, catalogDir, tools, audit } = options;
  const now = options.now ?? Date.now;

  /**
   * Wipe a directory tree, retrying briefly on Windows EBUSY/EPERM — a skill
   * worker that just exited (or an antivirus scanner) can hold a file handle
   * for a few hundred ms after the process is gone, and an uninstall/install
   * must not 500 on that transient race.
   */
  function removeTree(target: string): void {
    let lastError: unknown;
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
        return;
      } catch (error) {
        lastError = error;
        const end = Date.now() + 60 * (attempt + 1);
        while (Date.now() < end) {
          /* short pause before retry */
        }
      }
    }
    throw lastError;
  }

  function catalog(): CatalogReadResult {
    return readCatalog(catalogDir, { tools });
  }

  function requireRow(id: string): SkillRow {
    const row = store.findById(id);
    if (!row) throw skillError('not_found', `skill "${id}" is not installed`);
    return row;
  }

  function install(catalogId: string): SkillSummary {
    const clean = typeof catalogId === 'string' ? catalogId.trim() : '';
    if (clean === '') throw skillError('invalid_input', 'catalogId is required');
    if (store.findById(clean)) {
      throw skillError('conflict', `skill "${clean}" is already installed`);
    }
    const loaded = loadCatalogSkill(catalogDir, clean, { tools });
    const manifest = loaded.manifest;
    const entryAbs = join(loaded.dir, manifest.entrypoint);
    if (!existsSync(entryAbs)) {
      throw skillError('invalid_input', `skill "${clean}" entrypoint is missing`);
    }
    const sha256 = createHash('sha256').update(readEntry(entryAbs)).digest('hex');

    // Code store: wipe any stale dir (previous failed install), copy the
    // whole bundle (manifest.json + entry.mjs + assets) verbatim.
    const target = join(storeDir, manifest.id);
    mkdirSync(storeDir, { recursive: true });
    removeTree(target);
    cpSync(loaded.dir, target, { recursive: true });

    const at = now();
    store.insert({
      id: manifest.id,
      name: manifest.name,
      description: manifest.description,
      author: manifest.author,
      version: manifest.version,
      entrypoint: manifest.entrypoint,
      manifestJson: JSON.stringify(manifest),
      sha256,
      source: 'local',
      status: 'installed',
      installedAt: at,
      updatedAt: at,
    });
    audit.log('web', 'skill.install', manifest.id, {
      version: manifest.version,
      source: 'local',
    });
    return rowToSummary(store.findById(manifest.id) as SkillRow);
  }

  function list(): SkillSummary[] {
    return store.list().map(rowToSummary);
  }

  function get(id: string): SkillDetail | null {
    const row = store.findById(id);
    if (!row) return null;
    return rowToDetail(row);
  }

  function disable(id: string): SkillSummary {
    const row = requireRow(id);
    if (row.status === 'disabled') {
      throw skillError('conflict', `skill "${id}" is already disabled`);
    }
    const patch: SkillRowPatch = { status: 'disabled', updatedAt: now() };
    store.update(id, patch);
    audit.log('web', 'skill.disable', id, { version: row.version });
    return rowToSummary(requireRow(id));
  }

  function enable(id: string): SkillSummary {
    const row = requireRow(id);
    if (row.status === 'installed') {
      throw skillError('conflict', `skill "${id}" is not disabled`);
    }
    const patch: SkillRowPatch = { status: 'installed', updatedAt: now() };
    store.update(id, patch);
    audit.log('web', 'skill.enable', id, { version: row.version });
    return rowToSummary(requireRow(id));
  }

  function remove(id: string): void {
    const row = requireRow(id);
    // Wipe the code dir FIRST so a crash cannot leave a runnable orphan.
    removeTree(join(storeDir, id));
    invocations.removeBySkill(id);
    store.remove(id);
    audit.log('web', 'skill.uninstall', id, { version: row.version });
  }

  function listInvocations(skillId: string, limit?: number): SkillInvocationMeta[] {
    const raw = limit === undefined ? DEFAULT_INVOCATION_LIMIT : limit;
    const capped = Math.min(MAX_INVOCATION_LIMIT, Math.max(1, Math.floor(raw)));
    return invocations.listBySkill(skillId, capped).map(rowToMeta);
  }

  return { catalog, install, list, get, disable, enable, remove, listInvocations };
}

function readEntry(path: string): Buffer {
  return readFileSync(path);
}

/** Catalog listing shape is re-exported for route typing convenience. */
export type { CatalogSkill };
