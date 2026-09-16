/**
 * M26 cut A — skill draft manager tests (PLAN-M26.md).
 *
 * The invariants worth pinning, in order of how much they matter:
 *
 *   1. DRAFTING NEVER EXECUTES AND NEVER INSTALLS. Creating/updating/validating
 *      a draft writes no skill row and runs no worker. Only `promote` bridges
 *      into the skills store, and only after it re-validates.
 *   2. A draft is held to the INSTALL bar: whatever `validate` refuses is
 *      refused here, naming the offender.
 *   3. A widening update needs re-consent (`permission_change`), and a
 *      narrowing one must NOT nag.
 *   4. Audit rows carry ids/counts/lengths — never the code, manifest text or
 *      description (the repo's redaction rule).
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createSkillDraftManager,
  permissionDiff,
  slugifySkillId,
} from '../../src/skills/drafts.js';
import type { SkillDraftManagerOptions } from '../../src/skills/drafts.js';
import { createSkillManager } from '../../src/skills/manager.js';
import { SkillError } from '../../src/skills/errors.js';
import { REPO_CATALOG, makeTempRoot, removeTempRoot } from '../helpers.js';
import {
  createAuditStore,
  createSkillDraftStore,
  createSkillInvocationStore,
  createSkillStore,
  openDatabase,
} from '../../src/stores/db.js';
import { auditLog } from '../../src/services/redaction.js';

const TOOLS = new Set([
  'files.read',
  'files.list',
  'files.search',
  'files.edit',
  'files.apply',
  'files.delete',
]);

function env(overrides: Partial<SkillDraftManagerOptions> = {}) {
  const db = openDatabase(':memory:');
  const storeDir = makeTempRoot();
  // M26 cut E: the core-owned scratch root a dry-run would materialize into.
  // These tests never run one (draftRun.test.ts does), but the manager needs
  // the root it derives its run dirs from.
  const runsDir = makeTempRoot();
  const audit = auditLog({ store: createAuditStore(db) });
  const skills = createSkillManager({
    store: createSkillStore(db),
    invocations: createSkillInvocationStore(db),
    storeDir,
    catalogDir: REPO_CATALOG,
    tools: TOOLS,
    audit,
  });
  const drafts = createSkillDraftManager({
    store: createSkillDraftStore(db),
    skills,
    tools: TOOLS,
    audit,
    ...overrides,
    runsDir: overrides.runsDir ?? runsDir,
  });
  return {
    db,
    storeDir,
    runsDir,
    audit,
    skills,
    drafts,
    close(): void {
      db.close();
      removeTempRoot(storeDir);
      removeTempRoot(runsDir);
    },
  };
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
    return 'no-error';
  } catch (err) {
    return err instanceof SkillError ? err.code : `other:${String(err)}`;
  }
}

describe('slugifySkillId', () => {
  it('produces ids that satisfy the install-time id rule', () => {
    expect(slugifySkillId('Scratch Notes → Checklist!')).toBe('scratch-notes-checklist');
    expect(slugifySkillId('  ...weird  ')).toBe('weird');
    expect(slugifySkillId('a'.repeat(200))).toHaveLength(48);
    expect(slugifySkillId('!!!')).toBe('');
  });
});

describe('draft lifecycle', () => {
  it('creates a template draft that already validates, and installs nothing', async () => {
    const h = env();
    try {
      const draft = await h.drafts.create({
        mode: 'template',
        template: 'pure',
        name: 'Tidy Text',
        description: 'uppercases text',
      });
      expect(draft.id).toBe('tidy-text');
      expect(draft.origin).toBe('template');
      expect(draft.status).toBe('draft');
      expect(draft.validation.ok).toBe(true);
      expect(draft.manifest?.permissions).toMatchObject({ tools: [], network: false, risk: 'low' });
      // Invariant 1: a draft exists and NOTHING is installed or on disk.
      expect(h.skills.list()).toEqual([]);
      expect(existsSync(join(h.storeDir, 'tidy-text'))).toBe(false);

      const readOnly = h.drafts;
      expect(readOnly.get('tidy-text')?.code).toContain('export function run');
      expect(readOnly.list().map((row) => row.id)).toEqual(['tidy-text']);
    } finally {
      h.close();
    }
  });

  it('de-duplicates slugs against drafts AND installed skills', async () => {
    const h = env();
    try {
      const first = await h.drafts.create({
        mode: 'template',
        template: 'pure',
        name: 'Tidy Text',
        description: '',
      });
      const second = await h.drafts.create({
        mode: 'template',
        template: 'pure',
        name: 'Tidy Text',
        description: '',
      });
      expect(first.id).toBe('tidy-text');
      expect(second.id).toBe('tidy-text-2');

      // A slug already taken by an INSTALLED skill must be skipped too, or
      // promote() would either clobber it or fail at install time.
      h.skills.install('hello-skill');
      const third = await h.drafts.create({
        mode: 'manual',
        name: 'Hello Skill',
        description: '',
      });
      expect(third.id).toBe('hello-skill-2');
    } finally {
      h.close();
    }
  });

  it('refuses an unknown template by naming what this build offers', async () => {
    const h = env();
    try {
      const err = await h.drafts
        .create({ mode: 'template', template: 'notes-checklist', name: 'X', description: '' })
        .then(() => null)
        .catch((e: SkillError) => e);
      expect(err?.code).toBe('invalid_input');
      // M27 has not wired the notes reach, so the picker must not offer it.
      expect(err?.message).toContain('pure');
      expect(err?.message).toContain('reads-files');
    } finally {
      h.close();
    }
  });

  it('refuses generation when no generator is wired, with an actionable message', async () => {
    const h = env();
    try {
      const err = await h.drafts
        .create({ mode: 'generate', name: 'X', description: 'does x' })
        .then(() => null)
        .catch((e: SkillError) => e);
      expect(err?.code).toBe('invalid_input');
      expect(err?.message).toContain('template');
    } finally {
      h.close();
    }
  });

  it('generates through the injected hook (cut B seam) without installing', async () => {
    const h = env({
      generate: async ({ description, name, id }) => ({
        manifestText: JSON.stringify({
          id,
          name,
          description,
          author: 'model',
          version: '0.1.0',
          entrypoint: 'entry.mjs',
          permissions: { tools: [], network: false, risk: 'low' },
          budget: { timeMs: 5000 },
        }),
        code: 'export function run(){ return { generated: true }; }',
        model: 'test-model',
      }),
    });
    try {
      const draft = await h.drafts.create({
        mode: 'generate',
        name: 'Made Up',
        description: 'does a thing',
      });
      expect(draft.origin).toBe('generated');
      expect(draft.model).toBe('test-model');
      expect(draft.prompt).toBe('does a thing');
      expect(draft.validation.ok).toBe(true);
      expect(h.skills.list()).toEqual([]);
    } finally {
      h.close();
    }
  });
});

describe('validation (deterministic, never executes)', () => {
  it('names an unknown declared tool and records the failure on the draft', async () => {
    const h = env();
    try {
      const draft = await h.drafts.create({
        mode: 'manual',
        name: 'Bad Tool Use',
        description: '',
      });
      const text = JSON.stringify({
        id: draft.id,
        name: draft.name,
        description: 'x',
        author: 'me',
        version: '1',
        entrypoint: 'entry.mjs',
        permissions: { tools: ['files.read', 'notes.read'], network: false, risk: 'low' },
        budget: { timeMs: 5000 },
      });
      const updated = h.drafts.update(draft.id, { manifestText: text });
      expect(updated.validation.ok).toBe(false);
      expect(updated.validation.errors.join(' ')).toContain('notes.read');
      expect(updated.manifest).toBeNull();
    } finally {
      h.close();
    }
  });

  it('records a non-JSON manifest without inventing a manifest', async () => {
    const h = env();
    try {
      const draft = await h.drafts.create({ mode: 'manual', name: 'Broken', description: '' });
      const updated = h.drafts.update(draft.id, { manifestText: '{ not json' });
      expect(updated.validation.ok).toBe(false);
      expect(updated.validation.errors[0]).toContain('not valid JSON');
      expect(updated.manifest).toBeNull();
      expect(updated.manifestText).toBe('{ not json');
    } finally {
      h.close();
    }
  });

  it('validates code that would crash at import time WITHOUT running it', async () => {
    const h = env();
    try {
      const draft = await h.drafts.create({ mode: 'manual', name: 'Thrower', description: '' });
      // Import-time explosion + a valid export: the lint cannot see the throw,
      // and that is the point — validation reports shape, the dry-run reports
      // behaviour. What must NOT happen is validation executing this.
      const updated = h.drafts.update(draft.id, {
        code: "throw new Error('boom');\nexport function run(){ return 1; }",
      });
      expect(updated.validation.ok).toBe(true);
      expect(updated.validation.warnings.length).toBeGreaterThan(0);
    } finally {
      h.close();
    }
  });

  it('warns with the plain-language reach lines the owner will read', async () => {
    const h = env();
    try {
      const draft = await h.drafts.create({
        mode: 'template',
        template: 'reads-files',
        name: 'Looker',
        description: '',
      });
      const joined = draft.validation.warnings.join('\n');
      expect(joined).toContain('read files under a root you grant');
      expect(joined).toContain('cannot reach the network');
    } finally {
      h.close();
    }
  });

  it('refuses a write to an installed draft', async () => {
    const h = env();
    try {
      const draft = await h.drafts.create({
        mode: 'template',
        template: 'pure',
        name: 'Settled',
        description: '',
      });
      h.drafts.promote(draft.id);
      expect(codeOf(() => h.drafts.update(draft.id, { code: 'export function run(){}' }))).toBe(
        'conflict',
      );
      expect(codeOf(() => h.drafts.validate(draft.id))).toBe('conflict');
      expect(codeOf(() => h.drafts.promote(draft.id))).toBe('conflict');
    } finally {
      h.close();
    }
  });
});

describe('promote (the single install path)', () => {
  it('installs with source authored, a real hash, and no self-run', async () => {
    const h = env();
    try {
      const draft = await h.drafts.create({
        mode: 'template',
        template: 'pure',
        name: 'Tidy Text',
        description: '',
      });
      const result = h.drafts.promote(draft.id);
      expect(result.mode).toBe('created');
      expect(result.permissionDiff).toEqual([]);
      expect(result.skill).toMatchObject({ id: 'tidy-text', source: 'authored', status: 'installed' });
      expect(result.skill.sha256).toMatch(/^[0-9a-f]{64}$/);

      // The hash is of the file actually written, so the runner's integrity
      // check holds; the manifest.json beside it is the validated manifest.
      const dir = join(h.storeDir, 'tidy-text');
      const entry = readFileSync(join(dir, 'entry.mjs'), 'utf8');
      expect(entry).toBe(draft.code);
      const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as {
        id: string;
      };
      expect(manifest.id).toBe('tidy-text');

      // The draft is now marked installed and carries the shipped version.
      const after = h.drafts.get('tidy-text');
      expect(after?.status).toBe('installed');
      expect(after?.installedVersion).toBe('0.1.0');
    } finally {
      h.close();
    }
  });

  it('refuses an invalid draft and writes nothing', async () => {
    const h = env();
    try {
      const draft = await h.drafts.create({ mode: 'manual', name: 'Broken', description: '' });
      h.drafts.update(draft.id, { code: "import x from 'zod';\nexport function run(){return x;}" });
      expect(codeOf(() => h.drafts.promote(draft.id))).toBe('invalid_input');
      expect(h.skills.list()).toEqual([]);
      expect(existsSync(join(h.storeDir, 'broken'))).toBe(false);
    } finally {
      h.close();
    }
  });

  it('updates in place for a same-id draft, and requires consent to widen', async () => {
    const h = env();
    try {
      const draft = await h.drafts.create({
        mode: 'template',
        template: 'pure',
        name: 'Tidy Text',
        description: '',
      });
      h.drafts.promote(draft.id);

      // A fresh draft for the SAME id, now asking for a file tool + higher risk.
      const widened = await h.drafts.create({
        mode: 'manual',
        name: 'Tidy Text',
        description: '',
        id: 'tidy-text',
      });
      // The allocator refuses to collide with the installed id, so grant the
      // draft its own id explicitly by editing the manifest to reuse it.
      const manifest = {
        id: 'tidy-text',
        name: 'Tidy Text',
        description: 'now reads files',
        author: 'me',
        version: '0.2.0',
        entrypoint: 'entry.mjs',
        permissions: { tools: ['files.read'], network: false, risk: 'medium' },
        budget: { timeMs: 10_000 },
      };
      h.drafts.update(widened.id, {
        manifestText: JSON.stringify(manifest),
        code: 'export async function run(){ return await partner.tools.exec("files.read", {}); }',
      });

      // D6: widening requires an explicit acknowledgement.
      expect(codeOf(() => h.drafts.promote(widened.id))).toBe('permission_change');
      expect(h.skills.get('tidy-text')?.version).toBe('0.1.0');

      const result = h.drafts.promote(widened.id, { acknowledgePermissions: true, via: 'studio' });
      expect(result.mode).toBe('updated');
      expect(result.permissionDiff.map((entry) => entry.field).sort()).toEqual(['risk', 'tools']);
      expect(h.skills.get('tidy-text')?.version).toBe('0.2.0');
      expect(h.skills.get('tidy-text')?.manifest.permissions.risk).toBe('medium');
      // One installed skill, not two.
      expect(h.skills.list()).toHaveLength(1);
    } finally {
      h.close();
    }
  });

  it('does not nag when an update narrows or keeps permissions', async () => {
    const h = env();
    try {
      const first = await h.drafts.create({
        mode: 'template',
        template: 'reads-files',
        name: 'Looker',
        description: '',
      });
      h.drafts.promote(first.id);

      const second = await h.drafts.create({
        mode: 'manual',
        name: 'Looker',
        description: '',
        id: 'looker',
      });
      // Same tools, lower risk, shorter budget = strictly less power.
      h.drafts.update(second.id, {
        manifestText: JSON.stringify({
          id: 'looker',
          name: 'Looker',
          description: 'tamer',
          author: 'me',
          version: '0.1.1',
          entrypoint: 'entry.mjs',
          permissions: { tools: ['files.list', 'files.read'], network: false, risk: 'low' },
          budget: { timeMs: 5000 },
        }),
      });
      const result = h.drafts.promote(second.id);
      expect(result.permissionDiff).toEqual([]);
      expect(result.mode).toBe('updated');
    } finally {
      h.close();
    }
  });
});

describe('fork', () => {
  it('copies an installed skill into a fresh draft and runs nothing', () => {
    const h = env();
    try {
      h.skills.install('hello-skill');
      const draft = h.drafts.fork('hello-skill');
      expect(draft.id).toBe('hello-skill-copy');
      expect(draft.name).toBe('Hello Skill (copy)');
      expect(draft.origin).toBe('fork');
      expect(draft.status).toBe('draft');
      // The manifest id was rewritten to the new slug, so promote cannot
      // accidentally overwrite the skill it was forked from.
      expect(draft.manifest?.id).toBe('hello-skill-copy');
      expect(draft.code).toBe(readFileSync(join(REPO_CATALOG, 'hello-skill', 'entry.mjs'), 'utf8'));
      expect(draft.validation.ok).toBe(true);
      // Still exactly the one installed skill.
      expect(h.skills.list()).toHaveLength(1);
    } finally {
      h.close();
    }
  });

  it('404s for an unknown skill', () => {
    const h = env();
    try {
      expect(codeOf(() => h.drafts.fork('nope'))).toBe('not_found');
      expect(codeOf(() => h.drafts.edit('nope'))).toBe('not_found');
    } finally {
      h.close();
    }
  });

  it('edit opens a draft bound to the INSTALLED id, so promote updates it', () => {
    const h = env();
    try {
      h.skills.install('hello-skill');
      const draft = h.drafts.edit('hello-skill');
      expect(draft.id).toBe('hello-skill-edit');
      expect(draft.origin).toBe('edit');
      // The manifest id stays the installed one — that is what makes promote an
      // UPDATE rather than a second skill.
      expect(draft.manifest?.id).toBe('hello-skill');
      expect(draft.installedVersion).toBe('0.1.0');

      // The user's edit: a new version that narrows nothing and adds nothing.
      h.drafts.update(draft.id, {
        manifestText: draft.manifestText.replace('"0.1.0"', '"0.1.1"'),
      });
      const result = h.drafts.promote(draft.id);
      expect(result.mode).toBe('updated');
      expect(result.permissionDiff).toEqual([]);
      expect(h.skills.get('hello-skill')?.version).toBe('0.1.1');
      // Still one skill, still the original id — no duplicate was created.
      expect(h.skills.list().map((row) => row.id)).toEqual(['hello-skill']);

      // Editing again refreshes the ONE editable copy instead of piling up
      // drafts that would all promote onto the same skill.
      const again = h.drafts.edit('hello-skill');
      expect(again.id).toBe('hello-skill-edit');
      expect(h.drafts.list().filter((row) => row.origin === 'edit')).toHaveLength(1);
    } finally {
      h.close();
    }
  });
});

describe('discard + audit discipline', () => {
  it('hard-deletes the draft and audits a length, never the content', async () => {
    const h = env();
    try {
      const draft = await h.drafts.create({
        mode: 'template',
        template: 'pure',
        name: 'Temporary',
        description: 'a secret description',
      });
      h.drafts.discard(draft.id);
      expect(h.drafts.get(draft.id)).toBeNull();

      const rows = h.audit.list(50);
      expect(rows.map((row) => row.action)).toContain('skill.draft.discard');
      // The redaction rule: no audit row may carry the code, the description
      // or the manifest text.
      const serialized = JSON.stringify(rows);
      expect(serialized).not.toContain('a secret description');
      expect(serialized).not.toContain('export function run');
      expect(serialized).not.toContain('Tidy');
      const create = rows.find((row) => row.action === 'skill.draft.create');
      expect(JSON.parse(create?.details ?? '{}')).toMatchObject({
        origin: 'template',
        hasModel: false,
      });
    } finally {
      h.close();
    }
  });
});

describe('permissionDiff (pure)', () => {
  const manifest = (over: Record<string, unknown> = {}) =>
    ({
      id: 's',
      name: 'S',
      description: 'd',
      author: 'a',
      version: '1',
      entrypoint: 'entry.mjs',
      permissions: { tools: [], network: false, risk: 'low' },
      budget: { timeMs: 1000 },
      ...over,
    }) as never;

  it('is empty for a first install', () => {
    expect(permissionDiff(null, manifest())).toEqual([]);
  });

  it('reports only widenings', () => {
    const wider = permissionDiff(
      manifest(),
      manifest({
        permissions: { tools: ['files.read'], network: false, risk: 'high' },
        budget: { timeMs: 5000, maxTokens: 100 },
      }),
    );
    expect(wider.map((entry) => entry.field)).toEqual(['tools', 'risk', 'budget.timeMs', 'budget.maxTokens']);

    const narrower = permissionDiff(
      manifest({ permissions: { tools: ['files.read'], network: false, risk: 'high' } }),
      manifest(),
    );
    expect(narrower).toEqual([]);
  });

  it('treats a newly granted network or llm reach as a widening', () => {
    const wider = permissionDiff(
      manifest(),
      manifest({ permissions: { tools: [], network: true, risk: 'low', llm: true } }),
    );
    expect(wider.map((entry) => entry.field).sort()).toEqual(['llm', 'network']);
  });
});
