/**
 * Entry-point guard (M22) — PURE, so the rule is testable without spawning.
 *
 * `core/src/index.ts` ends with `if (isDirectEntryPoint(...)) main()`. The rule
 * used to be "no import.meta.url ⇒ a bundled artifact ⇒ run", which was true
 * while the CJS bundle was only ever the ENTRY file — and became wrong the moment
 * an operator tool `require()`d it: `node tools/user.mjs` then started a server,
 * hit `EADDRINUSE` against the core already listening in the same container, and
 * the CLI failed for a reason that had nothing to do with accounts.
 *
 * The rule now compares the file the interpreter was given with THIS file:
 *  - ESM/tsx (`import.meta.url` present): compare it with the entry URL.
 *  - CJS bundle (`import.meta.url` empty, `__filename` present): compare the
 *    resolved paths.
 *  - Anything else (no entry arg, no self path): do NOT run, so an unexpected
 *    embedding cannot start a listener by accident.
 */
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** True only when the process was started with THIS file as its entry. */
export function isDirectEntryPoint(input: {
  /** `process.argv[1]`. */
  entryArg: string | undefined;
  /** `import.meta.url` ('' in a CJS bundle). */
  metaUrl: string | undefined;
  /** `__filename` (undefined under ESM). */
  selfFile?: string;
}): boolean {
  const { entryArg, metaUrl, selfFile } = input;
  if (typeof entryArg !== 'string' || entryArg === '') return false;

  if (typeof metaUrl === 'string' && metaUrl !== '') {
    try {
      return metaUrl === pathToFileURL(entryArg).href;
    } catch {
      return false;
    }
  }

  if (typeof selfFile !== 'string' || selfFile === '') return false;
  try {
    return realpathSync(resolve(entryArg)) === realpathSync(resolve(selfFile));
  } catch {
    return false;
  }
}
