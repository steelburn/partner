/**
 * Project-root path safety (PLAN-M2 §Security rules 3, §files/paths).
 *
 * The broker can only ever see paths INSIDE a registered root: this module is
 * the single enforcement point every file tool funnels through. All roots are
 * canonical absolute paths (symlinks resolved at registration) — resolution
 * here re-verifies on every call so a symlink planted AFTER registration can
 * never smuggle a read/write outside the root (TOCTOU guard).
 *
 * Rejections are typed ToolErrors:
 *   - not a string / empty for file targets   -> bad_params
 *   - absolute input                          -> outside_root
 *   - '..' traversal escaping the root        -> outside_root
 *   - symlink (or realpath) escaping the root -> outside_root
 *   - a file target whose PARENT chain does   -> outside_root
 *     not exist (nothing to realpath-check)
 *
 * `path` segments in tool params/results are RELATIVE (POSIX form) — the
 * absolute filesystem location never leaks into the wire or audit.
 */
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { existsSync, realpathSync } from 'node:fs';
import { toolError } from '../broker/errors.js';

/** Win-style drive prefix (C:/…) — treated as absolute even on POSIX. */
const WINDOWS_DRIVE = /^[A-Za-z]:[\\/]/;

export interface ResolveResult {
  /** Absolute path inside the root (may not exist on disk yet). */
  absolute: string;
  /** Relative path, POSIX-normalized ('' for the root itself). */
  rel: string;
}

/**
 * Canonicalize a path: resolve + symlink-resolve (fs.realpath). Throws
 * ENOENT when the path does not exist — callers decide whether that is a
 * ToolError and which code (root add -> bad_params; tool target -> handled
 * by resolveInRoot's parent-existence rule).
 */
export function canonicalize(input: string): string {
  return realpathSync(input);
}

function isAbsoluteInput(rel: string): boolean {
  return rel.startsWith('/') || rel.startsWith('\\') || WINDOWS_DRIVE.test(rel);
}

/**
 * Resolve a RELATIVE path inside a canonical project root to an absolute
 * path, verifying it cannot escape:
 *  1. containment of the naive join (`..` traversal);
 *  2. realpath containment of the deepest EXISTING ancestor (symlink escape);
 *  3. for a missing TARGET, the parent dir must exist inside the root —
 *     otherwise there is no realpath to vouch for the location.
 *
 * `opts.allowDot` permits '' / '.' to resolve to the root itself (used by
 * files.list / files.search where the target is a directory). Read/edit/
 * delete targets are files and reject dot-paths.
 */
export function resolveInRoot(
  rootPath: string,
  relInput: unknown,
  opts: { allowDot?: boolean } = {},
): ResolveResult {
  if (typeof relInput !== 'string' || relInput.trim() === '') {
    throw toolError('bad_params', 'path must be a non-empty string');
  }
  const rel = relInput.trim();
  if (rel.includes('\0')) {
    throw toolError('bad_params', 'path contains a NUL byte');
  }
  if (isAbsoluteInput(rel)) {
    throw toolError('outside_root', 'absolute paths are not allowed — pass a path relative to the root');
  }
  if (rel === '.' || rel === './') {
    if (!opts.allowDot) {
      throw toolError('bad_params', 'a file path is required (the root itself is not a file)');
    }
    return { absolute: rootPath, rel: '' };
  }

  const joined = resolve(rootPath, rel);
  if (joined !== rootPath && !joined.startsWith(rootPath + sep)) {
    throw toolError('outside_root', 'path escapes the project root');
  }
  const relOut = relative(rootPath, joined).split(sep).join('/');

  // Prove the target's LOCATION is real and inside the root. The anchor is
  // the deepest existing ancestor of the target: the target itself when it
  // exists, otherwise its immediate parent. A missing INTERMEDIATE directory
  // means there is nothing on disk to realpath-vouch for the path, so the
  // read/edit/delete is refused outright (nothing may become reachable
  // through a directory that appears later as a symlink).
  const parentDir = dirname(joined);
  const targetExists = existsSync(joined);
  if (!targetExists && !existsSync(parentDir)) {
    throw toolError('outside_root', 'path does not exist under the root (missing directory)');
  }
  const anchor = targetExists ? joined : parentDir;
  let real: string;
  try {
    real = realpathSync(anchor);
  } catch {
    throw toolError('outside_root', 'path does not resolve to an existing location under the root');
  }
  if (real !== rootPath && !real.startsWith(rootPath + sep)) {
    throw toolError('outside_root', 'path resolves outside the project root (symlink escape)');
  }

  return { absolute: joined, rel: relOut };
}
