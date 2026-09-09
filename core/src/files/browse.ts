/**
 * M16 F7 (PLAN-M16.md add-on): filesystem directory browser for the Files →
 * "Absolute path" root picker.
 *
 * The paired OWNER browses the machine's folders to choose a project-root
 * path instead of typing one. This endpoint lists DIRECTORY names only —
 * never file contents — and canonicalizes each step so the UI always shows
 * the resolved path. It is a user-initiated UI action (not a persona tool):
 * loopback + pairing + audit row, exactly like the roots surface. Windows
 * drive enumeration is supported from the start screen ('' = system root).
 *
 * Security notes: refuses relative paths and NUL bytes; errors carry the
 * reason and path shape but never directory contents; audit logs the browsed
 * path (the same shape the roots list already exposes).
 */
import { readdirSync, statSync } from 'node:fs';
import { isAbsolute, dirname, join, normalize, resolve, sep } from 'node:path';

export interface BrowseEntry {
  name: string;
  /** True when the entry is a directory (symlinked dirs resolve to dirs). */
  isDir: boolean;
}

export interface BrowseResult {
  /** The resolved directory being shown (canonical shape for the input). */
  path: string;
  /** Parent path to go "up" from here; null at the filesystem/drive root. */
  parent: string | null;
  /** Directory entries, directories first then alphabetical, capped. */
  entries: BrowseEntry[];
  /** True when more directories exist beyond the cap. */
  truncated: boolean;
}

export type BrowseErrorCode = 'invalid_path' | 'not_found' | 'denied' | 'failed';

export class BrowseError extends Error {
  readonly code: BrowseErrorCode;

  constructor(code: BrowseErrorCode, message: string) {
    super(message);
    this.name = 'BrowseError';
    this.code = code;
  }
}

export function browseError(code: BrowseErrorCode, message: string): BrowseError {
  return new BrowseError(code, message);
}

/** List of present Windows drive roots ('C:\\', …) — probed, cheap. */
function windowsDrives(): BrowseResult {
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
  const entries: BrowseEntry[] = [];
  for (const letter of letters) {
    const probe = `${letter}:\\`;
    try {
      statSync(probe);
      entries.push({ name: probe, isDir: true });
    } catch {
      // drive not present — skip
    }
  }
  return { path: '', parent: null, entries, truncated: false };
}

/** Entry cap — a pathological directory must not flood the UI. */
const BROWSE_ENTRY_CAP = 500;

function readEntries(dir: string): { entries: BrowseEntry[]; truncated: boolean } {
  const dirents = readdirSync(dir, { withFileTypes: true });
  const entries: BrowseEntry[] = [];
  for (const dirent of dirents) {
    let isDir = dirent.isDirectory();
    if (!isDir && dirent.isSymbolicLink()) {
      try {
        isDir = statSync(join(dir, dirent.name)).isDirectory();
      } catch {
        isDir = false; // dangling symlink — not enterable, skip as a folder
      }
    }
    if (!isDir) continue; // roots are folders — only directories are offered
    entries.push({ name: dirent.name, isDir: true });
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const truncated = entries.length > BROWSE_ENTRY_CAP;
  return { entries: entries.slice(0, BROWSE_ENTRY_CAP), truncated };
}

/**
 * Browse one directory. `raw` may be '' (platform start: '/' on POSIX, the
 * drive list on Windows). Throws typed BrowseErrors mapped to loopback
 * statuses by the route.
 */
export function browseDirectory(raw: string): BrowseResult {
  if (raw.includes('\0')) throw browseError('invalid_path', 'Paths cannot contain NUL bytes.');
  const isWindows = process.platform === 'win32';
  if (isWindows && raw.trim() === '') return windowsDrives();
  const input = raw.trim() === '' ? (isWindows ? '' : '/') : raw.trim();
  if (isWindows) {
    // Windows: 'C:foo' vs 'C:\foo' — require an absolute drive path.
    const driveRoot = /^[A-Za-z]:[\\/]?$/.exec(input);
    if (!/^[A-Za-z]:[\\/]/.test(input) && driveRoot === null) {
      throw browseError('invalid_path', 'Enter an absolute Windows path like C:\\Users\\me');
    }
    if (driveRoot !== null) {
      const listed = readEntries(input.replace(/[\\/]$/, ''));
      return { path: input.replace(/[\\/]$/, ''), parent: null, ...listed };
    }
  } else if (!isAbsolute(input)) {
    throw browseError('invalid_path', 'Browsing needs an absolute path.');
  }

  let dir: string;
  try {
    dir = normalize(resolve(input));
  } catch {
    throw browseError('invalid_path', 'That path could not be resolved.');
  }

  let parent: string | null;
  if (isWindows) {
    parent = /^[A-Za-z]:[\\/]?$/.test(dir) ? null : dirname(dir);
  } else {
    parent = dir === sep ? null : dirname(dir);
  }
  try {
    const listed = readEntries(dir);
    return { path: dir, parent, ...listed };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      throw browseError('not_found', `No folder at ${dir}`);
    }
    if (code === 'EACCES' || code === 'EPERM') {
      throw browseError('denied', `No permission to read ${dir}`);
    }
    throw browseError('failed', `Could not read ${dir}`);
  }
}
