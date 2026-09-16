/**
 * M26 cut A — shared manifest/entry validation (PLAN-M26.md).
 *
 * The point of these tests: a DRAFT is held to the same bar as an installed
 * bundle, so this module is the single place that decides both. Anything that
 * would be refused at install must be refused here, at validate time, where the
 * author can still fix it — and a declaration the runtime cannot honour must be
 * a named error rather than a silent no-op.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RUNTIME_CAPABILITIES,
  MAX_ENTRY_BYTES,
  lintEntry,
  validateManifestShape,
} from '../../src/skills/manifest.js';

const BASE = {
  id: 'x-skill',
  name: 'X',
  description: 'does x',
  author: 'me',
  version: '1.0.0',
  entrypoint: 'entry.mjs',
  permissions: {},
};

describe('validateManifestShape (shared bar for catalog + drafts)', () => {
  it('applies the M8 defaults', () => {
    const result = validateManifestShape({ ...BASE });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.permissions).toEqual({ tools: [], network: false, risk: 'low' });
    expect(result.manifest.budget).toEqual({ timeMs: 30_000 });
  });

  it('refuses a capability the runtime cannot honour yet, naming it', () => {
    // M27 wires these. Until then, accepting the declaration would install a
    // skill whose permission summary promises something nothing can deliver.
    expect(DEFAULT_RUNTIME_CAPABILITIES).toEqual({ mcp: false, llm: false });
    const mcp = validateManifestShape({
      ...BASE,
      permissions: { mcpServers: ['github'] },
    });
    expect(mcp.ok).toBe(false);
    if (!mcp.ok) expect(mcp.errors.join(' ')).toContain('mcpServers');

    const llm = validateManifestShape({ ...BASE, permissions: { llm: true } });
    expect(llm.ok).toBe(false);
    if (!llm.ok) expect(llm.errors.join(' ')).toContain('cannot call a model');
  });

  it('accepts them when the capability is declared wired', () => {
    const caps = { mcp: true, llm: true };
    const ok = validateManifestShape(
      { ...BASE, permissions: { tools: [], network: false, risk: 'medium', mcpServers: ['github'], llm: true } },
      { capabilities: caps },
    );
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    expect(ok.manifest.permissions.mcpServers).toEqual(['github']);
    expect(ok.manifest.permissions.llm).toBe(true);
  });

  it('refuses an mcp: TOOL id in mcpServers (that field holds server ids)', () => {
    const result = validateManifestShape(
      { ...BASE, permissions: { mcpServers: ['mcp:github/create_issue'] } },
      { capabilities: { mcp: true, llm: true } },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(' ')).toContain('SERVER ids');
  });

  it('keeps the traversal + type refusals it inherited', () => {
    expect(validateManifestShape({ id: '../evil', entrypoint: '../../etc/passwd' }).ok).toBe(false);
    expect(validateManifestShape({ ...BASE, permissions: { risk: 'extreme' } }).ok).toBe(false);
    expect(validateManifestShape({ ...BASE, permissions: { llm: 'yes' } }).ok).toBe(false);
  });
});

describe('lintEntry (heuristic — the dry-run stays the ground truth)', () => {
  it('accepts the export shapes the worker harness can actually load', () => {
    const shapes = [
      'export function run(args) { return { ok: true }; }',
      'export async function run(args) { return null; }',
      'export const run = (args) => args;',
      'export default function (args) { return args; }',
      'function run(args) { return args; }\nexport { run };',
    ];
    for (const code of shapes) {
      expect(lintEntry(code), code).toMatchObject({ ok: true });
    }
  });

  it('refuses an entry that cannot export run', () => {
    const result = lintEntry('const run = 1;\nconsole.log(run);');
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toContain('export a run(args)');
  });

  it('refuses an empty entry and one over the size cap', () => {
    expect(lintEntry('   ').ok).toBe(false);
    const huge = `export function run(a){return a;}\n${'//'.padEnd(MAX_ENTRY_BYTES + 64, 'x')}`;
    const result = lintEntry(huge);
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toContain(String(MAX_ENTRY_BYTES));
  });

  it('allows node builtins and relative files, refuses a bare specifier', () => {
    expect(lintEntry("import { readFileSync } from 'node:fs';\nexport function run(){return 1;}").ok).toBe(true);
    expect(lintEntry("import { join } from 'path';\nexport function run(){return join('a','b');}").ok).toBe(true);
    expect(lintEntry("import './helper.mjs';\nexport function run(){return 1;}").ok).toBe(true);
    expect(lintEntry("import x from 'fs';").ok).toBe(false);

    for (const code of [
      "import { z } from 'zod';\nexport function run(){return z;}",
      "const x = require('lodash');\nexport function run(){return x;}",
      "export async function run(){ const m = await import('axios'); return m; }",
      "import '@partner/shared';\nexport function run(){return 1;}",
    ]) {
      const result = lintEntry(code);
      expect(result.ok, code).toBe(false);
      // The message names the specifier so an author (or a model) can fix it.
      expect(result.errors[0]).toMatch(/imports "/);
    }
  });

  it('does not mistake an unrelated string for an import', () => {
    const result = lintEntry(
      "export function run(args){ return { text: \"from 'nowhere'\" }; }",
    );
    expect(result.ok).toBe(true);
  });
});
