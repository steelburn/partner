/**
 * Path-safety tests (PLAN-M2 §files/paths): resolution stays inside the
 * canonical root — traversal, absolute inputs, symlink escapes, and missing
 * intermediate directories are all rejected with typed ToolErrors.
 */
import { mkdirSync, realpathSync, symlinkSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalize, resolveInRoot } from '../../src/files/paths.js';
import type { ToolError } from '../../src/broker/errors.js';
import { makeTempRoot, removeTempRoot } from '../helpers.js';

const dirs: string[] = [];

function tempDir(): string {
  const dir = realpathSync(makeTempRoot());
  dirs.push(dir);
  return dir;
}

function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (err) {
    expect((err as ToolError).code).toBe(code);
    return;
  }
  throw new Error(`expected ToolError ${code}`);
}

afterEach(() => {
  for (const dir of dirs.splice(0)) removeTempRoot(dir);
});

describe('canonicalize', () => {
  it('resolves symlinks to the real path', () => {
    const root = tempDir();
    mkdirSync(join(root, 'real-dir'));
    symlinkSync(join(root, 'real-dir'), join(root, 'alias'));
    expect(canonicalize(join(root, 'alias'))).toBe(join(root, 'real-dir'));
  });

  it('throws for a missing path', () => {
    const root = tempDir();
    expect(() => canonicalize(join(root, 'missing'))).toThrow();
  });
});

describe('resolveInRoot basics', () => {
  it('resolves a plain file and a nested file to absolute paths inside the root', () => {
    const root = tempDir();
    writeFileSync(join(root, 'a.txt'), 'a');
    mkdirSync(join(root, 'dir'));
    writeFileSync(join(root, 'dir', 'b.txt'), 'b');

    const top = resolveInRoot(root, 'a.txt');
    expect(top.absolute).toBe(join(root, 'a.txt'));
    expect(top.rel).toBe('a.txt');

    const nested = resolveInRoot(root, 'dir/b.txt');
    expect(nested.absolute).toBe(join(root, 'dir', 'b.txt'));
    expect(nested.rel).toBe('dir/b.txt');
  });

  it('allows "." only with allowDot (root itself)', () => {
    const root = tempDir();
    const dot = resolveInRoot(root, '.', { allowDot: true });
    expect(dot.absolute).toBe(root);
    expect(dot.rel).toBe('');
    expectCode(() => resolveInRoot(root, '.'), 'bad_params');
    expectCode(() => resolveInRoot(root, ''), 'bad_params');
    expectCode(() => resolveInRoot(root, '   '), 'bad_params');
    expectCode(() => resolveInRoot(root, 42 as unknown as string), 'bad_params');
  });

  it('a missing FILE under an existing parent resolves (the tool reports not_found)', () => {
    const root = tempDir();
    const missing = resolveInRoot(root, 'missing.txt');
    expect(missing.absolute).toBe(join(root, 'missing.txt'));
  });
});

describe('resolveInRoot rejections', () => {
  it('rejects parent traversal and deep traversal', () => {
    const root = tempDir();
    mkdirSync(join(root, 'a'));
    writeFileSync(join(root, 'a', 'x.txt'), 'x');
    expectCode(() => resolveInRoot(root, '../x'), 'outside_root');
    expectCode(() => resolveInRoot(root, 'a/../../x'), 'outside_root');
    expectCode(() => resolveInRoot(root, '..'), 'outside_root');
  });

  it('rejects absolute inputs (posix and windows forms)', () => {
    const root = tempDir();
    expectCode(() => resolveInRoot(root, '/etc/passwd'), 'outside_root');
    expectCode(() => resolveInRoot(root, '/tmp/anything'), 'outside_root');
    expectCode(() => resolveInRoot(root, 'C:\\Windows\\x'), 'outside_root');
    expectCode(() => resolveInRoot(root, 'C:/Windows/x'), 'outside_root');
  });

  it('rejects a symlink whose realpath escapes the root (dir and file links)', () => {
    const root = tempDir();
    const outside = tempDir();
    writeFileSync(join(outside, 'secret.txt'), 'secret');
    mkdirSync(join(root, 'tree'));
    symlinkSync(outside, join(root, 'tree', 'escape'));

    // Symlinked DIRECTORY escape (target exists through the link).
    expectCode(() => resolveInRoot(root, 'tree/escape/secret.txt'), 'outside_root');
    // Symlinked FILE escape.
    symlinkSync(join(outside, 'secret.txt'), join(root, 'link.txt'));
    expectCode(() => resolveInRoot(root, 'link.txt'), 'outside_root');
    // A MISSING file through the escaping dir is also refused (no realpath).
    expectCode(() => resolveInRoot(root, 'tree/escape/missing.txt'), 'outside_root');
  });

  it('rejects missing intermediate directories', () => {
    const root = tempDir();
    // 'no' does not exist -> the path has no real location under the root.
    expectCode(() => resolveInRoot(root, 'no/dir/file.txt'), 'outside_root');
    expectCode(() => resolveInRoot(root, 'no/file.txt'), 'outside_root');
  });

  it('accepts a symlink that stays INSIDE the root', () => {
    const root = tempDir();
    mkdirSync(join(root, 'real'));
    writeFileSync(join(root, 'real', 'ok.txt'), 'ok');
    symlinkSync(join(root, 'real'), join(root, 'alias'));
    const resolved = resolveInRoot(root, 'alias/ok.txt');
    // The caller sees the (in-root) joined path; its REAL path is inside root.
    expect(resolved.absolute.startsWith(root + '/')).toBe(true);
    expect(realpathSync(resolved.absolute)).toBe(join(root, 'real', 'ok.txt'));
  });
});
