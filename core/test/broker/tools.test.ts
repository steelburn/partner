/**
 * File-tool tests (M2) against REAL temp roots (node:os tmpdir + mkdtemp):
 * list isolation from .partner-trash, read size caps, search skipping
 * binaries/.git/node_modules/.partner-trash, edit -> proposal, apply = atomic
 * write + .bak with the ORIGINAL mtime, delete = trash-first rename, second
 * apply rejected, discard respected.
 */
import {
  existsSync,
  mkdirSync,
  realpathSync,
  statSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/stores/db.js';
import { createFileProposalStore } from '../../src/stores/db.js';
import { createFileTools } from '../../src/files/tools.js';
import type { FileTools } from '../../src/files/tools.js';
import type { ProjectRoot } from '@partner/shared/tools.js';
import type { ToolError } from '../../src/broker/errors.js';
import type { FileProposalStore } from '../../src/stores/types.js';
import { makeTempRoot, removeTempRoot } from '../helpers.js';

const dirs: string[] = [];

function tempRoot(): string {
  const dir = realpathSync(makeTempRoot());
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) removeTempRoot(dir);
});

function write(root: string, rel: string, content: string): void {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return (err as ToolError).code;
  }
  return 'no-error';
}

interface Env {
  tools: FileTools;
  proposals: FileProposalStore;
  root: ProjectRoot;
  rootPath: string;
  db: ReturnType<typeof openDatabase>;
}

function env(readOnly = false): Env {
  const db = openDatabase(':memory:');
  const rootPath = tempRoot();
  const proposals = createFileProposalStore(db);
  const tools = createFileTools({ proposals });
  return {
    tools,
    proposals,
    rootPath,
    root: { id: 'root-1', label: 'test', path: rootPath, readOnly, addedAt: 0 },
    db,
  };
}

const FIXTURE = {
  hello: 'hello world\nsecond line\n',
  nested: 'needle in the haystack\nplain line\n',
};

describe('files.list', () => {
  it('lists entries sorted dirs-first, hiding .partner-trash', () => {
    const { tools, root, rootPath } = env();
    write(rootPath, 'zeta.txt', 'z');
    write(rootPath, 'alpha.txt', 'a');
    write(rootPath, 'dir/b.txt', FIXTURE.nested);
    write(rootPath, 'node_modules/x.js', 'x');
    write(rootPath, '.git/config', 'git');
    write(rootPath, '.partner-trash/old.txt', 'gone');

    const { entries } = tools['files.list'].run(root, { projectId: root.id, path: '.' });
    const names = entries.map((e) => e.name);
    expect(names).toEqual(['.git', 'dir', 'node_modules', 'alpha.txt', 'zeta.txt']);
    expect(names).not.toContain('.partner-trash');
    const dirEntry = entries.find((e) => e.name === 'dir');
    expect(dirEntry).toMatchObject({ kind: 'dir', size: null });
    expect(typeof dirEntry?.mtime).toBe('number');

    const nested = tools['files.list'].run(root, { projectId: root.id, path: 'dir' });
    expect(nested.entries.map((e) => e.path)).toEqual(['dir/b.txt']);
  });

  it('reports not_found for a missing dir and bad_params for a file target', () => {
    const { tools, root, rootPath } = env();
    write(rootPath, 'file.txt', 'x');
    expect(codeOf(() => tools['files.list'].run(root, { projectId: root.id, path: 'nope' }))).toBe('not_found');
    expect(codeOf(() => tools['files.list'].run(root, { projectId: root.id, path: 'file.txt' }))).toBe('bad_params');
  });
});

describe('files.read', () => {
  it('reads a file with its byte size', () => {
    const { tools, root, rootPath } = env();
    write(rootPath, 'hello.txt', FIXTURE.hello);
    const result = tools['files.read'].run(root, { projectId: root.id, path: 'hello.txt' });
    expect(result.content).toBe(FIXTURE.hello);
    expect(result.bytes).toBe(Buffer.byteLength(FIXTURE.hello));
  });

  it('refuses files over the default 1 MiB cap with too_large', () => {
    const { tools, root, rootPath } = env();
    write(rootPath, 'big.txt', 'x'.repeat(1_600_000));
    expect(codeOf(() => tools['files.read'].run(root, { projectId: root.id, path: 'big.txt' }))).toBe('too_large');

    // A per-call override can raise the cap up to the server hard cap (8 MiB)…
    const ok = tools['files.read'].run(root, { projectId: root.id, path: 'big.txt', maxBytes: 2_000_000 });
    expect(ok.content.length).toBe(1_600_000);
    expect(ok.bytes).toBe(1_600_000);

    // …but never beyond it, and a too-small override still refuses.
    expect(
      codeOf(() => tools['files.read'].run(root, { projectId: root.id, path: 'big.txt', maxBytes: 100 })),
    ).toBe('too_large');

    // A file ABOVE the hard cap cannot be read even with a huge override.
    write(rootPath, 'huge.txt', 'y'.repeat(9_000_000));
    expect(
      codeOf(() => tools['files.read'].run(root, { projectId: root.id, path: 'huge.txt', maxBytes: 9_000_000 })),
    ).toBe('too_large');
  });

  it('typed errors: missing file not_found, dir bad_params, escapes outside_root', () => {
    const { tools, root, rootPath } = env();
    write(rootPath, 'hello.txt', FIXTURE.hello);
    mkdirSync(join(rootPath, 'adir'));
    expect(codeOf(() => tools['files.read'].run(root, { projectId: root.id, path: 'missing.txt' }))).toBe('not_found');
    expect(codeOf(() => tools['files.read'].run(root, { projectId: root.id, path: 'adir' }))).toBe('bad_params');
    expect(codeOf(() => tools['files.read'].run(root, { projectId: root.id, path: '../outside' }))).toBe('outside_root');
    expect(codeOf(() => tools['files.read'].run(root, { projectId: root.id, path: '/etc/passwd' }))).toBe('outside_root');
    expect(codeOf(() => tools['files.read'].run(root, { projectId: root.id, path: 'no/dir/file.txt' }))).toBe('outside_root');
  });

  it('validation: missing path / bad maxBytes are bad_params', () => {
    const { tools, root } = env();
    expect(codeOf(() => tools['files.read'].validate({ projectId: root.id }))).toBe('bad_params');
    expect(
      codeOf(() => tools['files.read'].validate({ projectId: root.id, path: 'a.txt', maxBytes: -1 })),
    ).toBe('bad_params');
    expect(
      codeOf(() => tools['files.read'].validate({ projectId: root.id, path: 'a.txt', maxBytes: 1.5 })),
    ).toBe('bad_params');
  });
});

describe('files.search', () => {
  it('finds plain text and skips node_modules, .git, .partner-trash, symlinks and binaries', () => {
    const { tools, root, rootPath } = env();
    const outside = tempRoot();
    write(outside, 'out.txt', 'needle outside root');
    write(rootPath, 'a.txt', 'alpha needle\nnothing\n');
    write(rootPath, 'dir/b.txt', FIXTURE.nested);
    write(rootPath, 'node_modules/x.js', 'needle hidden in deps\n');
    write(rootPath, '.git/config', 'needle in git');
    write(rootPath, '.partner-trash/old.txt', 'needle in trash');
    write(rootPath, 'bin.dat', 'needle\x00binary\x00');
    write(rootPath, 'deep/node_modules/dep.txt', 'needle nested dep');
    symlinkSync(join(outside, 'out.txt'), join(rootPath, 'linked.txt'));

    const { hits } = tools['files.search'].run(root, { projectId: root.id, query: 'needle' });
    const paths = hits.map((h) => h.path).sort();
    expect(paths).toEqual(['a.txt', 'dir/b.txt']);
    const hit = hits.find((h) => h.path === 'dir/b.txt');
    expect(hit?.line).toBe(1);
    expect(hit?.text).toBe('needle in the haystack');
  });

  it('searches a subdirectory when path is given and caps line length at 500', () => {
    const { tools, root, rootPath } = env();
    write(rootPath, 'sub/inner.txt', `long needle ${'y'.repeat(600)}\n`);
    const { hits } = tools['files.search'].run(root, { projectId: root.id, query: 'needle', path: 'sub' });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.path).toBe('sub/inner.txt');
    expect(hits[0]?.text.length).toBe(500);
  });

  it('caps hits at 500 and validates inputs', () => {
    const { tools, root, rootPath } = env();
    write(rootPath, 'many.txt', 'needle line\n'.repeat(600));
    const { hits } = tools['files.search'].run(root, { projectId: root.id, query: 'needle' });
    expect(hits.length).toBe(500);
    expect(codeOf(() => tools['files.search'].validate({ projectId: root.id, query: ' ' }))).toBe('bad_params');
    // A missing subdir is a RUNTIME error (not_found), not a shape error.
    expect(codeOf(() => tools['files.search'].run(root, { projectId: root.id, query: 'x', path: 'nope' }))).toBe('not_found');
  });
});

describe('files.edit -> proposal', () => {
  it('creates a proposal row with the exact original; never mutates the file', () => {
    const { tools, root, rootPath, proposals } = env();
    write(rootPath, 'editme.txt', 'alpha\n');
    const before = statSync(join(rootPath, 'editme.txt'));

    const result = tools['files.edit'].run(root, {
      projectId: root.id,
      path: 'editme.txt',
      proposedContent: 'beta\n',
    });
    expect(result.path).toBe('editme.txt');
    expect(result.originalContent).toBe('alpha\n');
    expect(result.proposedContent).toBe('beta\n');
    expect(result.proposalId).toBeTruthy();

    // Disk untouched; proposal row snapshot is exact incl. mtime.
    expect(readFileSync(join(rootPath, 'editme.txt'), 'utf8')).toBe('alpha\n');
    const row = proposals.findById(result.proposalId);
    expect(row).toBeDefined();
    expect(row?.originalContent).toBe('alpha\n');
    expect(row?.proposedContent).toBe('beta\n');
    expect(row?.originalMtime).toBe(Math.round(before.mtimeMs));
    expect(row?.path).toBe('editme.txt');
    expect(row?.appliedAt).toBeNull();
  });

  it('refuses read-only roots, missing files, directories, and escapes', () => {
    const ro = env(true);
    const { tools, root, rootPath } = env();
    write(rootPath, 'x.txt', 'x');
    expect(
      codeOf(() =>
        ro.tools['files.edit'].run(ro.root, { projectId: ro.root.id, path: 'x.txt', proposedContent: 'y' }),
      ),
    ).toBe('read_only');
    expect(
      codeOf(() => tools['files.edit'].run(root, { projectId: root.id, path: 'missing.txt', proposedContent: 'y' })),
    ).toBe('not_found');
    mkdirSync(join(rootPath, 'adir'));
    expect(
      codeOf(() => tools['files.edit'].run(root, { projectId: root.id, path: 'adir', proposedContent: 'y' })),
    ).toBe('bad_params');
    expect(
      codeOf(() => tools['files.edit'].run(root, { projectId: root.id, path: '../x', proposedContent: 'y' })),
    ).toBe('outside_root');
    // Param-shape validation is the validate() stage (missing proposedContent).
    expect(codeOf(() => tools['files.edit'].validate({ projectId: root.id, path: 'x.txt' }))).toBe('bad_params');
  });
});

describe('files.apply', () => {
  it('applies atomically: content changed, .bak exists with ORIGINAL content and mtime', () => {
    const { tools, root, rootPath } = env();
    write(rootPath, 'app.txt', 'original-body');
    const originalStat = statSync(join(rootPath, 'app.txt'));

    const edit = tools['files.edit'].run(root, {
      projectId: root.id,
      path: 'app.txt',
      proposedContent: 'new-body',
    });
    const applied = tools['files.apply'].run(root, { projectId: root.id, proposalId: edit.proposalId });
    expect(applied.path).toBe('app.txt');
    expect(applied.bytes).toBe(Buffer.byteLength('new-body'));

    expect(readFileSync(join(rootPath, 'app.txt'), 'utf8')).toBe('new-body');
    expect(readFileSync(join(rootPath, 'app.txt.bak'), 'utf8')).toBe('original-body');
    // .bak keeps the ORIGINAL mtime (rename preserves the inode); the live
    // file is a NEW inode written after the original (>= on coarse fs clocks).
    expect(Math.round(statSync(join(rootPath, 'app.txt.bak')).mtimeMs)).toBe(Math.round(originalStat.mtimeMs));
    expect(Math.round(statSync(join(rootPath, 'app.txt')).mtimeMs)).toBeGreaterThanOrEqual(
      Math.round(originalStat.mtimeMs),
    );
  });

  it('second apply of the same proposal is rejected; unknown proposal is not_found', () => {
    const { tools, root, rootPath } = env();
    write(rootPath, 'app.txt', 'one');
    const edit = tools['files.edit'].run(root, { projectId: root.id, path: 'app.txt', proposedContent: 'two' });
    tools['files.apply'].run(root, { projectId: root.id, proposalId: edit.proposalId });
    expect(
      codeOf(() => tools['files.apply'].run(root, { projectId: root.id, proposalId: edit.proposalId })),
    ).toBe('not_pending');
    expect(codeOf(() => tools['files.apply'].run(root, { projectId: root.id, proposalId: 'nope' }))).toBe('not_found');
  });

  it('apply of a discarded proposal is rejected (not_pending)', () => {
    const { tools, root, rootPath, proposals } = env();
    write(rootPath, 'app.txt', 'one');
    const edit = tools['files.edit'].run(root, { projectId: root.id, path: 'app.txt', proposedContent: 'two' });
    proposals.markDiscarded(edit.proposalId, Date.now());
    expect(
      codeOf(() => tools['files.apply'].run(root, { projectId: root.id, proposalId: edit.proposalId })),
    ).toBe('not_pending');
  });

  it('apply refuses a vanished target file (original read at apply time)', () => {
    const { tools, root, rootPath } = env();
    write(rootPath, 'app.txt', 'one');
    const edit = tools['files.edit'].run(root, { projectId: root.id, path: 'app.txt', proposedContent: 'two' });
    rmSync(join(rootPath, 'app.txt'));
    expect(
      codeOf(() => tools['files.apply'].run(root, { projectId: root.id, proposalId: edit.proposalId })),
    ).toBe('not_found');
  });
});

describe('files.delete', () => {
  it('trash-first: renames into <root>/.partner-trash/<ts>-<name>', () => {
    const { tools, root, rootPath } = env();
    write(rootPath, 'todelete.txt', 'bye');
    const result = tools['files.delete'].run(root, { projectId: root.id, path: 'todelete.txt' });
    expect(result.path).toBe('todelete.txt');
    expect(existsSync(join(rootPath, 'todelete.txt'))).toBe(false);
    expect(result.trashPath.startsWith('.partner-trash/')).toBe(true);
    expect(result.trashPath).toContain('todelete.txt');
    expect(existsSync(join(rootPath, result.trashPath))).toBe(true);
    expect(readFileSync(join(rootPath, result.trashPath), 'utf8')).toBe('bye');

    // Trash directory exists and list hides it.
    expect(readdirSync(join(rootPath, '.partner-trash'))).toHaveLength(1);
    const names = tools['files.list'].run(root, { projectId: root.id, path: '.' }).entries.map((e) => e.name);
    expect(names).not.toContain('.partner-trash');
  });

  it('refuses read-only roots, directories, missing files, and escapes', () => {
    const { tools, root, rootPath } = env();
    write(rootPath, 'x.txt', 'x');
    mkdirSync(join(rootPath, 'adir'));
    expect(codeOf(() => tools['files.delete'].run(root, { projectId: root.id, path: 'missing.txt' }))).toBe('not_found');
    expect(codeOf(() => tools['files.delete'].run(root, { projectId: root.id, path: 'adir' }))).toBe('bad_params');
    expect(codeOf(() => tools['files.delete'].run(root, { projectId: root.id, path: '../x' }))).toBe('outside_root');

    const ro = env(true);
    write(ro.rootPath, 'y.txt', 'y');
    expect(codeOf(() => ro.tools['files.delete'].run(ro.root, { projectId: ro.root.id, path: 'y.txt' }))).toBe('read_only');
  });
});
