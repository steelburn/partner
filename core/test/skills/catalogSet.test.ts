/**
 * The checked-in SAMPLE SET installs and RUNS (skills-catalog/).
 *
 * Why this file exists: the samples are reference material an author copies, so
 * a sample that validates but does not actually run is worse than no sample at
 * all — the author copies a pattern that fails at the sandbox. `catalog.test.ts`
 * holds the reader to the manifest bar; this holds the three new bundles to a
 * real install (catalog -> store -> sha256) and a real invocation through the
 * sandbox and the broker, including the two states that matter for consent:
 *
 *   · WITHOUT a grant   -> the sample reports the broker's own code
 *                          (`tool_denied`), not an empty, successful-looking result;
 *   · WITH a grant      -> the sample returns its shaped summary.
 *
 * No network, no model: the files tools and the app-scoped notes tools are the
 * only reaches any sample declares.
 */
import { describe, expect, it } from 'vitest';
import { realpathSync } from 'node:fs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SkillDetail } from '@partner/shared';
import { APP_SCOPE_ID } from '@partner/shared';
import { demoHarness, makeTempRoot, removeTempRoot } from '../helpers.js';
import type { Harness } from '../helpers.js';

/** Every bundle this file is about, in the order the README lists them. */
const SAMPLE_SET = ['file-inventory', 'content-audit', 'notes-digest'] as const;

const roots: string[] = [];
const harnesses: Harness[] = [];
const stores: string[] = [];

function closeAll(): void {
  for (const h of harnesses.splice(0)) {
    try {
      h.close();
    } catch {
      // ignore
    }
  }
  for (const dir of [...roots.splice(0), ...stores.splice(0)]) removeTempRoot(dir);
}

function env(): Harness {
  const storeDir = makeTempRoot();
  stores.push(storeDir);
  const h = demoHarness({ skills: { storeDir } });
  harnesses.push(h);
  return h;
}

/** A granted project root with a small, known tree in it. */
function projectRoot(h: Harness): { projectId: string; path: string } {
  const path = realpathSync(makeTempRoot());
  roots.push(path);
  const broker = h.broker;
  if (broker === undefined) throw new Error('the broker is unwired in this harness');
  const root = broker.roots.add({ label: 'samples', path, readOnly: true });
  mkdirSync(join(path, 'docs'), { recursive: true });
  writeFileSync(join(path, 'README.md'), '# Sample\nSee the checklist in NOTES.md.\n');
  writeFileSync(join(path, 'NOTES.md'), '- [ ] send the invites\n- [x] book the room\n');
  writeFileSync(join(path, 'docs', 'plan.md'), 'The invites go out on Friday.\n');
  writeFileSync(join(path, 'logo.png'), 'not really a png');
  return { projectId: root.id, path };
}

function detailOf(h: Harness, id: string): SkillDetail {
  const found = h.skills?.get(id);
  if (found === null || found === undefined) throw new Error(`skill ${id} is not installed`);
  return found;
}

/** Run one installed sample through the REAL sandbox. */
async function invoke(
  h: Harness,
  id: string,
  args: unknown,
): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  const runner = h.skillRunner;
  if (runner === undefined) throw new Error('the skill runner is unwired in this harness');
  const res = await runner.invoke(detailOf(h, id), args);
  return res.ok ? { ok: true, result: res.result } : { ok: false, error: res.error };
}

describe('the sample set installs from the checked-in catalog', () => {
  it('every sample installs, and none of them is refused by the manifest bar', () => {
    const h = env();
    try {
      for (const id of SAMPLE_SET) {
        const summary = h.skills?.install(id);
        expect(summary?.id, id).toBe(id);
        // Declared reach is what the install card shows: files/notes only.
        const detail = detailOf(h, id);
        expect(detail.manifest.permissions.network, id).toBe(false);
        expect(detail.manifest.permissions.mcpServers, id).toBeUndefined();
        expect(detail.manifest.permissions.llm, id).toBeUndefined();
      }
    } finally {
      closeAll();
    }
  });
});

describe('file-inventory — files.list only, bounded, honest about truncation', () => {
  it('refuses without the grant, reporting the broker code', async () => {
    const h = env();
    try {
      h.skills?.install('file-inventory');
      const { projectId } = projectRoot(h);
      const refused = await invoke(h, 'file-inventory', { projectId });
      expect(refused.ok).toBe(true);
      expect(refused.result).toMatchObject({ ok: false, reason: 'tool_denied' });
    } finally {
      closeAll();
    }
  });

  it('counts a granted root by extension, and never reads a file body', async () => {
    const h = env();
    try {
      h.skills?.install('file-inventory');
      const { projectId } = projectRoot(h);
      h.broker?.grants.add('files.list', projectId);

      const run = await invoke(h, 'file-inventory', { projectId, depth: 2 });
      expect(run.ok).toBe(true);
      const result = run.result as {
        ok: boolean;
        files: number;
        directories: number;
        bytes: number;
        extensions: Array<{ extension: string; count: number }>;
        truncated: boolean;
      };
      expect(result.ok).toBe(true);
      // README.md, NOTES.md, docs/plan.md, logo.png
      expect(result.files).toBe(4);
      expect(result.directories).toBe(1);
      expect(result.truncated).toBe(false);
      expect(result.bytes).toBeGreaterThan(0);
      expect(result.extensions).toEqual([
        { extension: 'md', count: 3 },
        { extension: 'png', count: 1 },
      ]);
      // The skill declares files.list ONLY, so no content can be in the result.
      expect(JSON.stringify(result)).not.toContain('send the invites');
    } finally {
      closeAll();
    }
  });

  it('reports a missing projectId as a refusal rather than an empty inventory', async () => {
    const h = env();
    try {
      h.skills?.install('file-inventory');
      const run = await invoke(h, 'file-inventory', {});
      expect(run.result).toMatchObject({ ok: false });
      expect(String((run.result as { reason: string }).reason)).toContain('projectId');
    } finally {
      closeAll();
    }
  });
});

describe('content-audit — files.search only, grouped and capped', () => {
  it('refuses without the grant, reporting the broker code', async () => {
    const h = env();
    try {
      h.skills?.install('content-audit');
      const { projectId } = projectRoot(h);
      const refused = await invoke(h, 'content-audit', { projectId, query: 'invites' });
      expect(refused.result).toMatchObject({ ok: false, reason: 'tool_denied' });
    } finally {
      closeAll();
    }
  });

  it('groups the hits by file, with the total before the per-file cap', async () => {
    const h = env();
    try {
      h.skills?.install('content-audit');
      const { projectId } = projectRoot(h);
      h.broker?.grants.add('files.search', projectId);

      const run = await invoke(h, 'content-audit', { projectId, query: 'invites' });
      const result = run.result as {
        ok: boolean;
        hits: number;
        files: number;
        matches: Array<{ path: string; count: number; samples: Array<{ line: number; text: string }> }>;
      };
      expect(result.ok).toBe(true);
      // NOTES.md and docs/plan.md mention the invites; README.md does not.
      expect(result.files).toBe(2);
      expect(result.hits).toBe(2);
      expect(result.matches.map((m) => m.path).sort()).toEqual(['NOTES.md', 'docs/plan.md']);
      const notes = result.matches.find((m) => m.path === 'NOTES.md');
      expect(notes?.count).toBe(1);
      // The sample line is the file's own text, capped — that is the report.
      expect(notes?.samples[0]?.text).toContain('send the invites');
      expect(notes?.samples[0]?.line).toBe(1);
    } finally {
      closeAll();
    }
  });

  it('requires a query', async () => {
    const h = env();
    try {
      h.skills?.install('content-audit');
      const { projectId } = projectRoot(h);
      h.broker?.grants.add('files.search', projectId);
      const run = await invoke(h, 'content-audit', { projectId });
      expect(run.result).toMatchObject({ ok: false });
    } finally {
      closeAll();
    }
  });
});

describe('notes-digest — app-scoped notes, measurements only', () => {
  it('refuses without app data (no root involved)', async () => {
    const h = env();
    try {
      h.skills?.install('notes-digest');
      const refused = await invoke(h, 'notes-digest', {});
      expect(refused.result).toMatchObject({ ok: false, reason: 'tool_denied' });
      // App reach never registers a root.
      expect(h.broker?.roots.list() ?? []).toEqual([]);
    } finally {
      closeAll();
    }
  });

  it('reports words and checklist tallies, never note bodies', async () => {
    const h = env();
    try {
      h.skills?.install('notes-digest');
      const notes = h.notes;
      if (notes === undefined) throw new Error('notes are unwired in this harness');
      notes.create({ title: 'Launch plan', content: '- [ ] send the invites\n- [x] book the room\n' });
      notes.create({ title: 'Shopping', content: 'milk\nbread\n' });
      for (const tool of ['notes.list', 'notes.search', 'notes.read']) {
        h.broker?.grants.add(tool, APP_SCOPE_ID);
      }

      const run = await invoke(h, 'notes-digest', { limit: 10 });
      const result = run.result as {
        ok: boolean;
        notes: number;
        words: number;
        checklistOpen: number;
        checklistDone: number;
        digest: Array<{ title: string; words: number; nextOpen: string | null }>;
      };
      expect(result.ok).toBe(true);
      expect(result.notes).toBe(2);
      expect(result.checklistOpen).toBe(1);
      expect(result.checklistDone).toBe(1);
      expect(result.words).toBeGreaterThan(0);
      const launch = result.digest.find((entry) => entry.title === 'Launch plan');
      expect(launch?.nextOpen).toBe('send the invites');
      // Counts, not contents: the body must not travel in the result.
      expect(JSON.stringify(result)).not.toContain('book the room');
      expect(JSON.stringify(result)).not.toContain('milk');
    } finally {
      closeAll();
    }
  });

  it('searches by text when given a query', async () => {
    const h = env();
    try {
      h.skills?.install('notes-digest');
      const notes = h.notes;
      if (notes === undefined) throw new Error('notes are unwired in this harness');
      notes.create({ title: 'Launch plan', content: 'invites\n' });
      notes.create({ title: 'Shopping', content: 'milk\n' });
      for (const tool of ['notes.list', 'notes.search', 'notes.read']) {
        h.broker?.grants.add(tool, APP_SCOPE_ID);
      }
      const run = await invoke(h, 'notes-digest', { query: 'Launch' });
      const result = run.result as { mode: string; notes: number; digest: Array<{ title: string }> };
      expect(result.mode).toBe('search');
      expect(result.notes).toBe(1);
      expect(result.digest[0]?.title).toBe('Launch plan');
    } finally {
      closeAll();
    }
  });
});
