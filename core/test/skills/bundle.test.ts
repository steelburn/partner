/**
 * M26 cut E - unsigned bundle export/import (PLAN-M26.md D12).
 *
 * A bundle is the ONE artefact that can leave the machine and come back, so the
 * properties worth pinning are the ones that keep it unprivileged:
 *
 *   · export is the draft's own bytes, and import round-trips them into a NEW
 *     inert draft (de-duplicated slug, origin 'import') that installs nothing;
 *   · an imported manifest is re-pointed at its new slug, so a bundle cannot
 *     take over an INSTALLED skill's code through promote() with no consent
 *     diff to show;
 *   · a malformed or oversized bundle is refused as `invalid_input`;
 *   · the audit rows carry a byte LENGTH and never the code (asserted by
 *     serializing the whole audit list).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_CATALOG, demoHarness } from '../helpers.js';
import type { Harness } from '../helpers.js';
import type { SkillDraftManager } from '../../src/skills/drafts.js';
import { SkillError } from '../../src/skills/errors.js';

function draftsOf(h: Harness): SkillDraftManager {
  const drafts = h.skillDrafts;
  if (drafts === undefined) throw new Error('the harness wired no draft manager');
  return drafts;
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
    return 'no-error';
  } catch (err) {
    return err instanceof SkillError ? err.code : `other:${String(err)}`;
  }
}

const SECRET_CODE = 'export function run(){ return "SECRET-PAYLOAD"; }';

describe('M26 bundle export/import', () => {
  it('exports the draft bytes and imports them as a NEW inert draft', async () => {
    const h = demoHarness();
    try {
      const drafts = draftsOf(h);
      const created = await drafts.create({
        mode: 'template',
        template: 'pure',
        name: 'Tidy Text',
        description: 'uppercases text',
      });

      const bundle = drafts.exportBundle(created.id);
      expect(bundle).toEqual({
        version: 1,
        manifestText: created.manifestText,
        code: created.code,
      });

      // The original draft still exists, so the import must take the next free
      // slug - and de-duplication runs against drafts AND installed skills.
      const imported = drafts.importBundle(bundle);
      expect(imported.id).toBe('tidy-text-2');
      expect(imported.origin).toBe('import');
      expect(imported.status).toBe('draft');
      expect(imported.installedVersion).toBeNull();
      // The owner's code round-trips verbatim; the manifest is re-pointed at
      // the new slug (exactly as `fork` does).
      expect(imported.code).toBe(created.code);
      expect(imported.name).toBe('Tidy Text');
      expect(imported.manifest?.id).toBe('tidy-text-2');
      expect(imported.manifestText).not.toContain('"id": "tidy-text"');
      expect(imported.description).toBe(created.manifest?.description);
      expect(imported.validation.ok).toBe(true);

      // Inert: nothing installed, and the draft it came from is untouched.
      expect(h.skills?.list()).toEqual([]);
      expect(drafts.get(created.id)?.code).toBe(created.code);
    } finally {
      h.close();
    }
  });

  it('cannot take over an installed skill through an import', async () => {
    const h = demoHarness();
    try {
      const drafts = draftsOf(h);
      h.skills?.install('hello-skill');
      const before = h.skills?.get('hello-skill');

      // A bundle claiming the INSTALLED id, with the same permission set: D6
      // would find no widening to ask about, so the only thing standing between
      // it and a silent code swap is the re-pointed id.
      const imported = drafts.importBundle({
        version: 1,
        manifestText: readFileSync(join(REPO_CATALOG, 'hello-skill', 'manifest.json'), 'utf8'),
        code: readFileSync(join(REPO_CATALOG, 'hello-skill', 'entry.mjs'), 'utf8'),
      });
      expect(imported.id).toBe('hello-skill-2');
      expect(imported.manifest?.id).toBe('hello-skill-2');
      // Importing alone changed nothing that was installed...
      expect(h.skills?.get('hello-skill')?.sha256).toBe(before?.sha256);

      // ...and promoting the import can only ever CREATE another skill.
      const promoted = drafts.promote(imported.id);
      expect(promoted.mode).toBe('created');
      expect(promoted.skill.id).toBe('hello-skill-2');
      const after = h.skills?.get('hello-skill');
      expect(after?.sha256).toBe(before?.sha256);
      expect(after?.version).toBe(before?.version);
      expect(h.skills?.list().map((row) => row.id).sort()).toEqual([
        'hello-skill',
        'hello-skill-2',
      ]);
    } finally {
      h.close();
    }
  });

  it('refuses a malformed or oversized bundle as invalid_input', async () => {
    const h = demoHarness();
    try {
      const drafts = draftsOf(h);
      const malformed: unknown[] = [
        null,
        [],
        'a bundle',
        { manifestText: '{}', code: 'export function run(){}' }, // no version
        { version: 2, manifestText: '{}', code: 'export function run(){}' },
        { version: 1, manifestText: '{}' }, // no code
        { version: 1, code: 'export function run(){}' }, // no manifestText
        { version: 1, manifestText: '{}', code: 7 }, // wrong types
        { version: 1, manifestText: '   ', code: 'export function run(){}' },
        { version: 1, manifestText: '{}', code: '   ' },
      ];
      for (const bundle of malformed) {
        expect(codeOf(() => drafts.importBundle(bundle))).toBe('invalid_input');
      }

      // The same caps as any other draft write (256 KiB entry, 64 KiB manifest):
      // a bundle is not a way around them.
      expect(
        codeOf(() =>
          drafts.importBundle({
            version: 1,
            manifestText: '{}',
            code: `export function run(){ return "${'x'.repeat(300 * 1024)}"; }`,
          }),
        ),
      ).toBe('invalid_input');
      expect(
        codeOf(() =>
          drafts.importBundle({
            version: 1,
            manifestText: `{${'x'.repeat(70 * 1024)}}`,
            code: 'export function run(){}',
          }),
        ),
      ).toBe('invalid_input');
      expect(drafts.list()).toEqual([]);
    } finally {
      h.close();
    }
  });

  it('stages a bundle whose MANIFEST is broken, instead of refusing it', async () => {
    // The bundle SHAPE and size are gates; what is inside the manifest is the
    // Studio's validation panel's job. Refusing here would lock the owner out
    // of the one case import exists for: a bundle that needs fixing before it
    // can ever be installed.
    const h = demoHarness();
    try {
      const drafts = draftsOf(h);
      const imported = drafts.importBundle({
        version: 1,
        manifestText: '{ not json',
        code: 'export function run(){ return 1; }',
      });
      expect(imported.status).toBe('draft');
      expect(imported.manifest).toBeNull();
      expect(imported.manifestText).toBe('{ not json');
      expect(imported.validation.ok).toBe(false);
      // Still nothing installed and nothing runnable.
      expect(h.skills?.list()).toEqual([]);
      expect(codeOf(() => drafts.promote(imported.id))).toBe('invalid_input');
    } finally {
      h.close();
    }
  });

  it('audits a byte length and never the code', async () => {
    const h = demoHarness();
    try {
      const drafts = draftsOf(h);
      const created = await drafts.create({
        mode: 'manual',
        name: 'Secret Keeper',
        description: 'a private description',
      });
      drafts.update(created.id, { code: SECRET_CODE });

      const bundle = drafts.exportBundle(created.id);
      drafts.importBundle(bundle);

      const rows = h.audit.list(200).map((row) => ({ action: row.action, details: row.details }));
      const codeBytes = Buffer.byteLength(SECRET_CODE, 'utf8');
      const exported = rows.find((row) => row.action === 'skill.draft.export');
      expect(JSON.parse(exported?.details ?? '{}')).toEqual({ version: 1, codeBytes });
      const imported = rows.find((row) => row.action === 'skill.draft.import');
      expect(JSON.parse(imported?.details ?? '{}')).toEqual({ version: 1, codeBytes });

      // The rule, asserted over the WHOLE audit list: a length, never content.
      const serialized = JSON.stringify(rows);
      expect(serialized).not.toContain('SECRET-PAYLOAD');
      expect(serialized).not.toContain('a private description');
      expect(serialized).not.toContain('export function run');
    } finally {
      h.close();
    }
  });
});
