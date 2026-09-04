/**
 * Project-root manager (M2) — the ONLY filesystem surface the broker sees.
 *
 * add() validates that the path is absolute and an existing directory, then
 * canonicalizes + symlink-resolves it (fs.realpath) so the stored path can
 * never be a symlink pointing elsewhere later. Duplicate canonical paths are
 * rejected. List/remove are plain; grants referencing a removed root are
 * left behind (harmless — hasGrant still needs a tool call, which needs the
 * root to exist first).
 */
import { randomUUID } from 'node:crypto';
import { existsSync, realpathSync, statSync } from 'node:fs';
import type { Stats } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { ProjectRoot, ProjectRootInput } from '@partner/shared/tools.js';
import { ToolError, toolError } from './errors.js';
import type { ProjectRootRow, ProjectRootStore } from '../stores/types.js';

/** Injectable fs slice (defaults to node:fs — tests use real temp dirs). */
export interface RootFs {
  existsSync(path: string): boolean;
  statSync(path: string): Stats;
  realpathSync(path: string): string;
}

const REAL_FS: RootFs = { existsSync, statSync, realpathSync };

export interface ProjectRootManagerOptions {
  store: ProjectRootStore;
  /** Injectable clock (epoch ms). */
  now?: () => number;
  /** Injectable fs (defaults to node:fs). */
  fs?: RootFs;
}

export interface ProjectRootManager {
  /** Validate + canonicalize + store; throws typed ToolErrors. */
  add(input: ProjectRootInput): ProjectRoot;
  list(): ProjectRoot[];
  getById(id: string): ProjectRoot | null;
  /** Revoke by id; throws not_found when absent. */
  remove(id: string): void;
}

function toRoot(row: ProjectRootRow): ProjectRoot {
  return {
    id: row.id,
    label: row.label,
    path: row.path,
    readOnly: row.readOnly === 1,
    addedAt: row.addedAt,
  };
}

export function createProjectRootManager(options: ProjectRootManagerOptions): ProjectRootManager {
  const { store } = options;
  const now = options.now ?? Date.now;
  const fs = options.fs ?? REAL_FS;

  function add(input: ProjectRootInput): ProjectRoot {
    const body = (input ?? {}) as ProjectRootInput;
    const label = typeof body.label === 'string' ? body.label.trim() : '';
    if (label === '') throw toolError('bad_params', 'label is required');
    const rawPath = typeof body.path === 'string' ? body.path.trim() : '';
    if (rawPath === '') throw toolError('bad_params', 'path is required');
    if (!isAbsolute(rawPath)) {
      throw toolError('bad_params', 'path must be absolute');
    }
    if (!fs.existsSync(rawPath)) {
      throw toolError('bad_params', 'path does not exist');
    }
    let canonical: string;
    try {
      const stat = fs.statSync(rawPath);
      if (!stat.isDirectory()) {
        throw toolError('bad_params', 'path is not a directory');
      }
      canonical = fs.realpathSync(rawPath);
    } catch (err) {
      if (err instanceof ToolError) throw err;
      throw toolError('bad_params', 'path is not resolvable');
    }
    if (store.findByPath(canonical)) {
      throw toolError('exists', 'project root already registered');
    }
    const id = randomUUID();
    const at = now();
    const row: ProjectRootRow = {
      id,
      label,
      path: canonical,
      readOnly: body.readOnly === true ? 1 : 0,
      addedAt: at,
    };
    store.insert(row);
    return toRoot(row);
  }

  function list(): ProjectRoot[] {
    return store.list().map(toRoot);
  }

  function getById(id: string): ProjectRoot | null {
    const row = store.findById(id);
    return row ? toRoot(row) : null;
  }

  function remove(id: string): void {
    if (!store.findById(id)) throw toolError('not_found', 'project root not found');
    store.remove(id);
  }

  return { add, list, getById, remove };
}
