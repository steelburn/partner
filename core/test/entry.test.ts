/**
 * M22 — the entry-point guard.
 *
 * Regression this pins: the guard treated every bundled CJS artifact as "the
 * entry", so `docker compose exec partner node tools/user.mjs add owner` — which
 * `require()`s the bundle to reach the account managers — started a SECOND server
 * inside the container, failed with `EADDRINUSE` against the core already
 * listening, and looked like a tooling bug rather than a guard bug.
 *
 * The fixtures are real files and platform-correct URLs: `pathToFileURL` adds a
 * drive letter on Windows and `realpathSync` needs the path to exist, so made-up
 * POSIX paths would test the test rather than the guard.
 */
import { describe, expect, it } from 'vitest';
import { relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDirectEntryPoint } from '../src/entry.js';

const selfPath = fileURLToPath(new URL('../src/index.ts', import.meta.url));
const otherPath = fileURLToPath(new URL('../src/entry.ts', import.meta.url));
const selfUrl = pathToFileURL(selfPath).href;

describe('isDirectEntryPoint', () => {
  it('ESM (tsx): runs only when import.meta.url is the entry', () => {
    expect(isDirectEntryPoint({ entryArg: selfPath, metaUrl: selfUrl })).toBe(true);
    expect(isDirectEntryPoint({ entryArg: otherPath, metaUrl: selfUrl })).toBe(false);
  });

  it('CJS bundle: runs only when the ENTRY FILE is the bundle itself', () => {
    // `node core-bundle.cjs` — the shell's sidecar, and the container CMD.
    expect(isDirectEntryPoint({ entryArg: selfPath, metaUrl: '', selfFile: selfPath })).toBe(true);
    // `node tools/user.mjs` requiring the bundle — must NOT start a server.
    expect(isDirectEntryPoint({ entryArg: otherPath, metaUrl: '', selfFile: selfPath })).toBe(
      false,
    );
    // A relative entry resolves against the CWD, exactly as the interpreter does.
    expect(
      isDirectEntryPoint({ entryArg: relative(process.cwd(), selfPath), metaUrl: '', selfFile: selfPath }),
    ).toBe(true);
  });

  it('fails closed when it cannot tell', () => {
    expect(isDirectEntryPoint({ entryArg: undefined, metaUrl: '', selfFile: selfPath })).toBe(false);
    expect(isDirectEntryPoint({ entryArg: '', metaUrl: '', selfFile: selfPath })).toBe(false);
    expect(isDirectEntryPoint({ entryArg: selfPath, metaUrl: '', selfFile: undefined })).toBe(false);
    // A path that does not exist cannot be proven to be this file.
    expect(
      isDirectEntryPoint({ entryArg: `${selfPath}.nope`, metaUrl: '', selfFile: selfPath }),
    ).toBe(false);
  });
});
