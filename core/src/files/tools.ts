/**
 * The six v1 file tool implementations (PLAN-M2). Each runs against ONE
 * canonical project root and returns a redaction-safe result — file CONTENT
 * is part of an explicit read/edit payload (the user asked for it), but it
 * never reaches audit/logs (the broker summarizes with lengths only).
 *
 * Write discipline (files.edit/apply/delete):
 *  - edit NEVER mutates the filesystem: it snapshots the original (content +
 *    mtime) into a proposal row and returns the preview payload;
 *  - apply re-checks the proposal is open and the root is still writable,
 *    then performs an ATOMIC write (tmp file in the same dir + rename) with
 *    the original preserved as `<name>.bak` — rename preserves the original
 *    inode, so .bak keeps the ORIGINAL mtime;
 *  - delete is trash-first: rename into `<root>/.partner-trash/<ts>-<name>`.
 *
 * All path inputs resolve through files/paths.ts (outside-root / traversal /
 * symlink-escape / missing-dir rejections) and read-only roots refuse every
 * writer. Errors are typed ToolErrors (bad_params/not_found/too_large/
 * outside_root/read_only/not_pending).
 */
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type {
  FileListEntry,
  FileSearchHit,
  FilesApplyParams,
  FilesEditParams,
  FilesPathParams,
  FilesReadParams,
  FilesSearchParams,
  ProjectRoot,
  ToolId,
} from '@partner/shared/tools.js';
import { toolError } from '../broker/errors.js';
import type { FileProposalRow, FileProposalStore } from '../stores/types.js';
import { resolveInRoot } from './paths.js';

export interface FileToolDeps {
  proposals: FileProposalStore;
  /** Injectable clock (epoch ms). */
  now?: () => number;
  /** Per-call read cap default (1 MiB per PLAN-M2). */
  defaultMaxReadBytes?: number;
  /** Server-enforced absolute read cap regardless of the per-call override. */
  hardMaxReadBytes?: number;
  /** Search reads files up to this size (skip larger). */
  maxSearchFileBytes?: number;
}

const DEFAULT_MAX_READ = 1024 * 1024; // 1 MiB
const HARD_MAX_READ = 8 * 1024 * 1024; // 8 MiB server cap
const DEFAULT_MAX_SEARCH_FILE = 2 * 1024 * 1024; // skip files > 2 MiB in search
const MAX_SEARCH_HITS = 500;
const MAX_SEARCH_LINE = 500;
const TRASH_DIR = '.partner-trash';
const SKIP_DIRS: ReadonlySet<string> = new Set(['.git', 'node_modules', '.partner-trash']);

function asRecord(raw: unknown): Record<string, unknown> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw toolError('bad_params', 'params must be an object');
  }
  return raw as Record<string, unknown>;
}

function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw toolError('bad_params', `${key} is required and must be a non-empty string`);
  }
  return value;
}

function requireOptionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim() === '') {
    throw toolError('bad_params', `${key} must be a non-empty string`);
  }
  return value;
}

function requireNonNegativeInt(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw toolError('bad_params', `${key} must be a positive integer`);
  }
  return value;
}

function isMissing(err: unknown): boolean {
  return err instanceof Error && (err as NodeJS.ErrnoException).code === 'ENOENT';
}

/** mtime in epoch ms (SQLite row profile uses ms). */
function mtimeMs(st: { mtimeMs: number }): number {
  return Math.round(st.mtimeMs);
}

function relName(baseRel: string, name: string): string {
  return baseRel === '' ? name : `${baseRel}/${name}`;
}

export interface ToolExecutor<P, R> {
  /** Shape-validate raw params -> typed params (throws bad_params). */
  validate(raw: unknown): P;
  /** Execute against the canonical root (throws typed ToolErrors). */
  run(root: ProjectRoot, params: P): R;
}

export type ListResult = { entries: FileListEntry[] };
export type ReadResult = { content: string; bytes: number };
export type SearchResult = { hits: FileSearchHit[] };
export type EditResult = {
  proposalId: string;
  path: string;
  originalContent: string;
  proposedContent: string;
};
export type ApplyResult = { path: string; bytes: number };
export type DeleteResult = { path: string; trashPath: string };

export interface FileTools {
  'files.list': ToolExecutor<FilesPathParams, ListResult>;
  'files.read': ToolExecutor<FilesReadParams, ReadResult>;
  'files.search': ToolExecutor<FilesSearchParams, SearchResult>;
  'files.edit': ToolExecutor<FilesEditParams, EditResult>;
  'files.apply': ToolExecutor<FilesApplyParams, ApplyResult>;
  'files.delete': ToolExecutor<FilesPathParams, DeleteResult>;
}

function listImpl(root: ProjectRoot, path: string): ListResult {
  const { absolute, rel } = resolveInRoot(root.path, path, { allowDot: true });
  let st;
  try {
    st = statSync(absolute);
  } catch (err) {
    if (isMissing(err)) throw toolError('not_found', 'no such directory');
    throw err;
  }
  if (!st.isDirectory()) {
    throw toolError('bad_params', 'path is not a directory — use files.read for a file');
  }

  const entries: FileListEntry[] = [];
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    if (entry.name === TRASH_DIR) continue;
    const entryAbs = join(absolute, entry.name);
    let entryStat;
    try {
      entryStat = lstatSync(entryAbs);
    } catch {
      continue; // vanished mid-listing — skip
    }
    if (entryStat.isSymbolicLink()) continue; // never leak outside-root metadata
    const isDir = entryStat.isDirectory();
    entries.push({
      name: entry.name,
      path: relName(rel, entry.name),
      kind: isDir ? 'dir' : 'file',
      size: isDir ? null : entryStat.size,
      mtime: mtimeMs(entryStat),
    });
  }
  entries.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
  return { entries };
}

function readImpl(root: ProjectRoot, p: FilesReadParams, deps: FileToolDeps): ReadResult {
  const { absolute } = resolveInRoot(root.path, p.path);
  let st;
  try {
    st = statSync(absolute);
  } catch (err) {
    if (isMissing(err)) throw toolError('not_found', 'no such file');
    throw err;
  }
  if (st.isDirectory()) {
    throw toolError('bad_params', 'path is a directory — use files.list');
  }
  const hardCap = deps.hardMaxReadBytes ?? HARD_MAX_READ;
  const defaultCap = deps.defaultMaxReadBytes ?? DEFAULT_MAX_READ;
  const requested = p.maxBytes ?? defaultCap;
  const effective = Math.min(Math.max(1, requested), hardCap);
  if (st.size > effective) {
    throw toolError('too_large', `file is ${st.size} bytes — exceeds the ${effective}-byte read cap`);
  }
  const content = readFileSync(absolute, 'utf8');
  return { content, bytes: st.size };
}

function searchImpl(root: ProjectRoot, p: FilesSearchParams, deps: FileToolDeps): SearchResult {
  const query = p.query.toLowerCase();
  const target =
    p.path === undefined
      ? { absolute: root.path, rel: '' }
      : resolveInRoot(root.path, p.path, { allowDot: true });
  const maxFileBytes = deps.maxSearchFileBytes ?? DEFAULT_MAX_SEARCH_FILE;
  const hits: FileSearchHit[] = [];

  const walk = (dirAbs: string, dirRel: string): boolean => {
    let names: string[];
    try {
      names = readdirSync(dirAbs).sort();
    } catch {
      return false;
    }
    for (const name of names) {
      if (hits.length >= MAX_SEARCH_HITS) return true;
      if (name === TRASH_DIR || name === '.git' || name === 'node_modules') continue;
      const childAbs = join(dirAbs, name);
      let ls;
      try {
        ls = lstatSync(childAbs);
      } catch {
        continue;
      }
      if (ls.isSymbolicLink()) continue; // never follow symlinks while searching
      const childRel = relName(dirRel, name);
      if (ls.isDirectory()) {
        const stop = walk(childAbs, childRel);
        if (stop) return true;
        continue;
      }
      if (!ls.isFile() || ls.size > maxFileBytes) continue;
      let text: string;
      try {
        const buffer = readFileSync(childAbs);
        if (buffer.subarray(0, 8192).includes(0)) continue; // binary sniff
        text = buffer.toString('utf8');
      } catch {
        continue;
      }
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i] as string;
        if (line.toLowerCase().includes(query)) {
          hits.push({ path: childRel, line: i + 1, text: line.slice(0, MAX_SEARCH_LINE) });
          if (hits.length >= MAX_SEARCH_HITS) return true;
        }
      }
    }
    return false;
  };

  let st;
  try {
    st = statSync(target.absolute);
  } catch (err) {
    if (isMissing(err)) throw toolError('not_found', 'no such directory');
    throw err;
  }
  if (!st.isDirectory()) {
    throw toolError('bad_params', 'path is not a directory');
  }
  walk(target.absolute, target.rel);
  return { hits };
}

function editImpl(root: ProjectRoot, p: FilesEditParams, deps: FileToolDeps): EditResult {
  if (root.readOnly) {
    throw toolError('read_only', 'project root is read-only — edits are refused');
  }
  const { absolute, rel } = resolveInRoot(root.path, p.path);
  let st;
  try {
    st = statSync(absolute);
  } catch (err) {
    if (isMissing(err)) throw toolError('not_found', 'no such file');
    throw err;
  }
  if (st.isDirectory()) {
    throw toolError('bad_params', 'path is a directory — point files.edit at a file');
  }
  // Same cap as files.read: edit never pulls unbounded files into memory/DB.
  const hardCap = deps.hardMaxReadBytes ?? HARD_MAX_READ;
  if (st.size > hardCap) {
    throw toolError('too_large', `file exceeds the ${hardCap} byte edit cap`);
  }
  const originalContent = readFileSync(absolute, 'utf8');
  const at = (deps.now ?? Date.now)();
  const row: FileProposalRow = {
    id: randomUUID(),
    projectId: root.id,
    path: rel,
    originalMtime: mtimeMs(st),
    originalContent,
    proposedContent: p.proposedContent,
    createdAt: at,
    appliedAt: null,
    discardedAt: null,
  };
  deps.proposals.insert(row);
  return { proposalId: row.id, path: rel, originalContent, proposedContent: p.proposedContent };
}

/**
 * Atomic apply with drift protection and a crash-safe .bak:
 *  1. stat the CURRENT file: if its mtime differs from the proposal snapshot
 *     the file changed on disk -> refuse (changed_since_proposal);
 *  2. write .bak as a COPY of the current bytes (preserving its mtime) BEFORE
 *     touching the original, so the real file is never moved away;
 *  3. write a tmp file in the same dir, rename over the original.
 * A crash at any point leaves the original file present and intact.
 */
function applyImpl(root: ProjectRoot, p: FilesApplyParams, deps: FileToolDeps): ApplyResult {
  if (root.readOnly) {
    throw toolError('read_only', 'project root is read-only — applies are refused');
  }
  const row = deps.proposals.findById(p.proposalId);
  if (!row) throw toolError('not_found', 'proposal not found');
  if (row.projectId !== root.id) {
    throw toolError('not_found', 'proposal does not belong to this project');
  }
  if (row.appliedAt !== null) throw toolError('not_pending', 'proposal was already applied');
  if (row.discardedAt !== null) throw toolError('not_pending', 'proposal was discarded');

  const { absolute, rel } = resolveInRoot(root.path, row.path);
  if (!existsSync(absolute)) {
    throw toolError('not_found', 'target file no longer exists');
  }
  // Drift protection: refuse to clobber a file that changed since the proposal.
  const currentStat = statSync(absolute);
  if (mtimeMs(currentStat) !== row.originalMtime) {
    throw toolError(
      'changed_since_proposal',
      'the file changed on disk since this proposal was created — re-propose instead of overwriting',
    );
  }

  const originalBytes = readFileSync(absolute);
  const bakPath = `${absolute}.bak`;
  const tmpPath = join(dirname(absolute), `.${basename(absolute)}.${randomUUID()}.partner-tmp`);
  try {
    // .bak first, from a copy, preserving the original's timestamps: the real
    // file is never moved or destroyed, so a crash mid-apply is safe.
    writeFileSync(bakPath, originalBytes);
    utimesSync(bakPath, currentStat.atime, currentStat.mtime);
    writeFileSync(tmpPath, row.proposedContent, 'utf8');
    renameSync(tmpPath, absolute);
  } catch (err) {
    // Best-effort cleanup: the partial tmp is removed; the original was never
    // displaced, so no restore dance is needed.
    try {
      if (existsSync(tmpPath)) rmSync(tmpPath, { force: true });
    } catch {
      // Ignore cleanup failures.
    }
    if (err instanceof Error && isMissing(err)) {
      throw toolError('not_found', 'target file vanished during apply');
    }
    throw toolError('denied', 'apply failed — no changes were written');
  }
  deps.proposals.markApplied(row.id, (deps.now ?? Date.now)());
  return { path: rel, bytes: Buffer.byteLength(row.proposedContent, 'utf8') };
}

function deleteImpl(root: ProjectRoot, path: string, deps: FileToolDeps): DeleteResult {
  if (root.readOnly) {
    throw toolError('read_only', 'project root is read-only — deletes are refused');
  }
  const { absolute, rel } = resolveInRoot(root.path, path);
  let st;
  try {
    st = statSync(absolute);
  } catch (err) {
    if (isMissing(err)) throw toolError('not_found', 'no such file');
    throw err;
  }
  if (st.isDirectory()) {
    throw toolError('bad_params', 'path is a directory — files.delete targets files only');
  }

  const ts = (deps.now ?? Date.now)();
  const trashDir = join(root.path, TRASH_DIR);
  mkdirSync(trashDir, { recursive: true });
  const baseName = basename(absolute);
  let trashName = `${ts}-${baseName}`;
  if (existsSync(join(trashDir, trashName))) {
    trashName = `${ts}-${randomUUID().slice(0, 8)}-${baseName}`;
  }
  const trashPathAbs = join(trashDir, trashName);
  try {
    renameSync(absolute, trashPathAbs);
  } catch (err) {
    if (err instanceof Error && isMissing(err)) throw toolError('not_found', 'no such file');
    throw toolError('denied', 'delete failed — file was not moved');
  }
  return { path: rel, trashPath: `${TRASH_DIR}/${trashName}` };
}

/** Build the six tool executors over a proposal store. */
export function createFileTools(deps: FileToolDeps): FileTools {
  return {
    'files.list': {
      validate(raw: unknown): FilesPathParams {
        const p = asRecord(raw);
        return { projectId: requireString(p, 'projectId'), path: requireString(p, 'path') };
      },
      run(root: ProjectRoot, params: FilesPathParams): ListResult {
        return listImpl(root, params.path);
      },
    },
    'files.read': {
      validate(raw: unknown): FilesReadParams {
        const p = asRecord(raw);
        const base: FilesPathParams = {
          projectId: requireString(p, 'projectId'),
          path: requireString(p, 'path'),
        };
        const maxBytes = requireNonNegativeInt(p, 'maxBytes');
        return maxBytes === undefined ? base : { ...base, maxBytes };
      },
      run(root: ProjectRoot, params: FilesReadParams): ReadResult {
        return readImpl(root, params, deps);
      },
    },
    'files.search': {
      validate(raw: unknown): FilesSearchParams {
        const p = asRecord(raw);
        const base: FilesSearchParams = {
          projectId: requireString(p, 'projectId'),
          query: requireString(p, 'query'),
        };
        const path = requireOptionalString(p, 'path');
        return path === undefined ? base : { ...base, path };
      },
      run(root: ProjectRoot, params: FilesSearchParams): SearchResult {
        return searchImpl(root, params, deps);
      },
    },
    'files.edit': {
      validate(raw: unknown): FilesEditParams {
        const p = asRecord(raw);
        const base: FilesPathParams = {
          projectId: requireString(p, 'projectId'),
          path: requireString(p, 'path'),
        };
        if (typeof p.proposedContent !== 'string') {
          throw toolError('bad_params', 'proposedContent must be a string');
        }
        return { ...base, proposedContent: p.proposedContent };
      },
      run(root: ProjectRoot, params: FilesEditParams): EditResult {
        return editImpl(root, params, deps);
      },
    },
    'files.apply': {
      validate(raw: unknown): FilesApplyParams {
        const p = asRecord(raw);
        return {
          projectId: requireString(p, 'projectId'),
          proposalId: requireString(p, 'proposalId'),
        };
      },
      run(root: ProjectRoot, params: FilesApplyParams): ApplyResult {
        return applyImpl(root, params, deps);
      },
    },
    'files.delete': {
      validate(raw: unknown): FilesPathParams {
        const p = asRecord(raw);
        return { projectId: requireString(p, 'projectId'), path: requireString(p, 'path') };
      },
      run(root: ProjectRoot, params: FilesPathParams): DeleteResult {
        return deleteImpl(root, params.path, deps);
      },
    },
  };
}

/** All v1 tool ids — mirrors the registry in broker/toolManifests.ts. */
export const FILE_TOOL_IDS: readonly ToolId[] = [
  'files.list',
  'files.read',
  'files.search',
  'files.edit',
  'files.apply',
  'files.delete',
];
