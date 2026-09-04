/**
 * M8 catalog reader tests (PLAN-M8.md). The repo's checked-in skills-catalog/
 * must read clean (hello-skill, note-echo, files-preview with their declared
 * permissions); a fixture catalog proves the exclusion rules: network skills
 * are excluded with a clear warning and REFUSED at load with the typed
 * network_not_supported error, unknown/missing tools and malformed bundles
 * are excluded with warnings, and install-time loads throw typed errors.
 */
import { describe, expect, it } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  readCatalog,
  loadCatalogSkill,
  validateManifestShape,
} from '../../src/skills/catalog.js';
import { SkillError } from '../../src/skills/errors.js';
import { REPO_CATALOG, makeTempRoot, removeTempRoot } from '../helpers.js';

describe('catalog reader (repo skills-catalog/)', () => {
  it('lists the three sample skills with their declared permissions', () => {
    const { skills, warnings } = readCatalog(REPO_CATALOG);
    expect(warnings).toEqual([]);
    expect(skills.map((s) => s.id).sort()).toEqual(['files-preview', 'hello-skill', 'note-echo']);
    const hello = skills.find((s) => s.id === 'hello-skill');
    expect(hello).toMatchObject({
      name: 'Hello Skill',
      author: 'Partner Samples',
      version: '0.1.0',
      permissions: { tools: [], network: false, risk: 'low' },
    });
    const files = skills.find((s) => s.id === 'files-preview');
    expect(files?.permissions).toMatchObject({
      tools: ['files.read'],
      network: false,
      risk: 'medium',
    });
    const note = skills.find((s) => s.id === 'note-echo');
    expect(note?.permissions.tools).toEqual([]);
  });

  it('validateManifestShape applies M8 defaults and rejects malformed input', () => {
    const ok = validateManifestShape({
      id: 'x-skill',
      name: 'X',
      description: 'd',
      author: 'a',
      version: '1',
      entrypoint: 'entry.mjs',
      permissions: {},
    });
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.manifest.permissions).toEqual({ tools: [], network: false, risk: 'low' });
      expect(ok.manifest.budget).toEqual({ timeMs: 30_000 });
    }
    const bad = validateManifestShape({ id: '../evil', entrypoint: '../../etc/passwd' });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors.length).toBeGreaterThan(0);
  });
});

describe('catalog exclusions (fixture catalog)', () => {
  /** A temp catalog with one valid skill + one broken skill per rule. */
  function makeFixtureCatalog(): string {
    const root = makeTempRoot();
    const write = (id: string, manifest: unknown, entry = 'export function run(){ return {}; }'): void => {
      const dir = join(root, id);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest));
      writeFileSync(join(dir, 'entry.mjs'), entry);
    };
    write('good-skill', {
      id: 'good-skill',
      name: 'Good',
      description: 'valid',
      author: 't',
      version: '1',
      entrypoint: 'entry.mjs',
      permissions: { tools: [], risk: 'low' },
    });
    write('net-skill', {
      id: 'net-skill',
      name: 'Net',
      description: 'network',
      author: 't',
      version: '1',
      entrypoint: 'entry.mjs',
      permissions: { network: true, risk: 'low' },
    });
    write('tool-skill', {
      id: 'tool-skill',
      name: 'Tool',
      description: 'unknown tool',
      author: 't',
      version: '1',
      entrypoint: 'entry.mjs',
      permissions: { tools: ['browser.navigate'], risk: 'low' },
    });
    write('missing-skill', {
      id: 'missing-skill',
      name: 'Missing',
      description: 'entrypoint missing',
      author: 't',
      version: '1',
      entrypoint: 'nope.mjs',
      permissions: {},
    });
    write('mismatch-skill', {
      id: 'different-id',
      name: 'Mismatch',
      description: 'folder != manifest id',
      author: 't',
      version: '1',
      entrypoint: 'entry.mjs',
      permissions: {},
    });
    write('bad-json-skill', '{ not json ');
    return root;
  }

  it('readCatalog lists only the valid skill and warns per excluded entry', () => {
    const dir = makeFixtureCatalog();
    try {
      const { skills, warnings } = readCatalog(dir);
      expect(skills.map((s) => s.id)).toEqual(['good-skill']);
      const joined = warnings.join('\n');
      expect(joined).toContain('[net-skill] network skills are not supported in M8');
      expect(joined).toContain('[tool-skill]');
      expect(joined).toContain('unknown tool');
      expect(joined).toContain('[missing-skill]');
      expect(joined).toContain('nope.mjs is missing');
      expect(joined).toContain('[mismatch-skill]');
      expect(joined).toContain('does not match its folder');
      expect(joined).toContain('[bad-json-skill]');
    } finally {
      removeTempRoot(dir);
    }
  });

  it('loadCatalogSkill throws typed errors (not_found / network_not_supported / invalid_input)', () => {
    const dir = makeFixtureCatalog();
    try {
      // Valid skill loads with its manifest.
      const loaded = loadCatalogSkill(dir, 'good-skill');
      expect(loaded.manifest.id).toBe('good-skill');

      // Network skill: the M8 rejection is a clear TYPED error.
      try {
        loadCatalogSkill(dir, 'net-skill');
        expect.unreachable('network skill must be refused');
      } catch (err) {
        expect(err).toBeInstanceOf(SkillError);
        expect((err as SkillError).code).toBe('network_not_supported');
        expect((err as SkillError).message).toContain('network');
      }
      // Unknown catalog id.
      try {
        loadCatalogSkill(dir, 'ghost');
        expect.unreachable('ghost must be not_found');
      } catch (err) {
        expect((err as SkillError).code).toBe('not_found');
      }
      // Declares a tool that does not exist in M8's broker registry.
      try {
        loadCatalogSkill(dir, 'tool-skill');
        expect.unreachable('unknown tool must be refused');
      } catch (err) {
        expect((err as SkillError).code).toBe('invalid_input');
      }
    } finally {
      removeTempRoot(dir);
    }
  });

  it('readCatalog on a missing dir returns empty + a warning (never throws)', () => {
    const { skills, warnings } = readCatalog(join(makeTempRoot(), 'no-such-catalog'));
    expect(skills).toEqual([]);
    expect(warnings.length).toBeGreaterThan(0);
  });
});
