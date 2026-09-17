/**
 * M26 cut B - pure skill authoring (PLAN-M26.md).
 *
 * Everything in `authoring.ts` is text in, text out: no provider, no clock,
 * no filesystem. What these tests pin, in order of how much it matters:
 *
 *   1. The prompt teaches the contract the RUNNER implements (it embeds
 *      `entryContract()` verbatim) and names only tool ids the registry
 *      actually has - a prompt that offered reach the broker cannot mediate
 *      would produce drafts that can never validate.
 *   2. A model reply is UNTRUSTED: parsing is tolerant but typed, and never
 *      throws into a route.
 *   3. Normalisation is where the core's authority lives: the id is the draft's
 *      slug (never the model's `id`), the budget is clamped to the runner
 *      ceiling, an unknown tool is dropped AND named, and reach this build
 *      cannot honour is refused instead of stored as a permission that does
 *      nothing.
 */
import { describe, expect, it } from 'vitest';
import {
  buildAuthoringPrompt,
  normalizeAuthoredBundle,
  parseAuthoringReply,
  templateBundle,
} from '../../src/skills/authoring.js';
import {
  DEFAULT_RUNTIME_CAPABILITIES,
  lintEntry,
  MAX_SKILL_TIME_MS,
  validateManifestShape,
} from '../../src/skills/manifest.js';
import type { RuntimeCapabilities } from '../../src/skills/manifest.js';
import { entryContract, unknownTools } from '../../src/skills/runtime.js';
import { availableTemplates, SKILL_TEMPLATES } from '../../src/skills/templates.js';

/** The v1 broker registry (the six files.* ids) - the real authoring input. */
const TOOLS = [
  'files.list',
  'files.read',
  'files.search',
  'files.edit',
  'files.apply',
  'files.delete',
];

const OFF: RuntimeCapabilities = { mcp: false, llm: false, notes: false };
const ON: RuntimeCapabilities = { mcp: true, llm: true, notes: true };

function manifest(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'tidy-text',
    name: 'Tidy Text',
    description: 'uppercases the text argument',
    author: 'Partner',
    version: '0.1.0',
    entrypoint: 'entry.mjs',
    permissions: { tools: [], network: false, risk: 'low' },
    budget: { timeMs: 5000 },
    ...over,
  };
}

function parseJson(text: string): Record<string, unknown> {
  return JSON.parse(text) as Record<string, unknown>;
}

describe('buildAuthoringPrompt', () => {
  it('embeds the runtime contract verbatim and the real registry tool ids', () => {
    const prompt = buildAuthoringPrompt({
      description: 'turn scratch notes into a checklist',
      name: 'Scratch Checklist',
      toolIds: TOOLS,
      capabilities: OFF,
    });
    expect(prompt).toContain(entryContract(TOOLS));
    for (const id of TOOLS) expect(prompt).toContain(id);
    // Nothing the registry does NOT offer may be advertised as declarable.
    expect(prompt).not.toContain('notes.read');
    expect(prompt).not.toContain('mcp:');
  });

  it('states the caps, the no-network rule and that the model cannot install', () => {
    const prompt = buildAuthoringPrompt({
      description: 'x',
      name: 'X',
      toolIds: TOOLS,
      capabilities: OFF,
    });
    expect(prompt).toContain('64 KiB');
    expect(prompt).toContain('1 MiB');
    expect(prompt).toContain(String(MAX_SKILL_TIME_MS));
    expect(prompt).toContain('"permissions.network": true is refused');
    expect(prompt).toMatch(/YOU CANNOT INSTALL/);
    // The demand for one JSON object is explicit, not implied.
    expect(prompt).toContain('"manifest"');
    expect(prompt).toContain('"code"');
    // No model reply may carry a fence when the prompt forbids one.
    expect(prompt).toMatch(/No prose, no explanation, no markdown fences\./);
  });

  it('carries the name and description the owner gave', () => {
    const prompt = buildAuthoringPrompt({
      description: 'summarize a folder of notes',
      name: 'Folder Digest',
      toolIds: TOOLS,
      capabilities: OFF,
    });
    expect(prompt).toContain('Folder Digest');
    expect(prompt).toContain('summarize a folder of notes');
  });

  it('offers only the reach this build can honour', () => {
    const off = buildAuthoringPrompt({
      description: 'x',
      name: 'X',
      toolIds: TOOLS,
      capabilities: OFF,
    });
    expect(off).toContain('"permissions.llm" is refused in this build');
    expect(off).toContain('"permissions.mcpServers" is refused in this build');
    const on = buildAuthoringPrompt({
      description: 'x',
      name: 'X',
      toolIds: TOOLS,
      capabilities: ON,
    });
    expect(on).not.toContain('"permissions.llm" is refused in this build');
    expect(on).not.toContain('"permissions.mcpServers" is refused in this build');
  });
});

describe('parseAuthoringReply', () => {
  const body = JSON.stringify({ manifest: manifest(), code: 'export function run() {}\n' });

  it('parses a bare JSON object', () => {
    const parsed = parseAuthoringReply(body);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error('unreachable');
    expect(parsed.bundle.manifest.id).toBe('tidy-text');
    expect(parsed.bundle.code).toContain('export function run');
  });

  it('parses fenced JSON and prose around the object', () => {
    for (const reply of [
      '```json\n' + body + '\n```',
      '```\n' + body + '\n```',
      'Here is the skill you asked for:\n\n' + body + '\n\nLet me know if you want changes.',
      '```json' + body + '```',
    ]) {
      const parsed = parseAuthoringReply(reply);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(parsed.bundle.manifest.name).toBe('Tidy Text');
    }
  });

  it('returns a typed failure - never a throw - for an unreadable reply', () => {
    const replies = [
      '',
      '   ',
      'I cannot draft that skill.',
      '{ "manifest": { "id": "x" } }', // no code
      '{ "manifest": [], "code": "export function run(){}" }', // manifest is not an object
      '{ "manifest": { "id": "x" }, "code": "   " }', // empty code
      '{ "manifest": { "id": "x" , "code": "y" }} trailing }',
    ];
    for (const reply of replies) {
      let parsed: ReturnType<typeof parseAuthoringReply>;
      expect(() => {
        parsed = parseAuthoringReply(reply);
      }).not.toThrow();
      expect(parsed!.ok).toBe(false);
      if (!parsed!.ok) expect(parsed!.errors.length).toBeGreaterThan(0);
    }
  });
});

describe('normalizeAuthoredBundle', () => {
  const base = { slug: 'scratch-checklist', toolIds: TOOLS, capabilities: OFF };

  it('forces the id to the slug, so a traversal id cannot escape', () => {
    const result = normalizeAuthoredBundle(
      { manifest: manifest({ id: '../../evil' }), code: 'export function run() {}\n' },
      base,
    );
    expect(result.ok).toBe(true);
    expect(parseJson(result.manifestText).id).toBe('scratch-checklist');
  });

  it('refuses a slug that is not a usable skill id', () => {
    const result = normalizeAuthoredBundle(
      { manifest: manifest(), code: 'export function run() {}\n' },
      { ...base, slug: '../evil' },
    );
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toContain('not a usable skill id');
  });

  it('clamps budget.timeMs to the runner ceiling', () => {
    const result = normalizeAuthoredBundle(
      {
        manifest: manifest({ budget: { timeMs: MAX_SKILL_TIME_MS * 10 } }),
        code: 'export function run() {}\n',
      },
      base,
    );
    expect(result.ok).toBe(true);
    expect(parseJson(result.manifestText).budget).toEqual({ timeMs: MAX_SKILL_TIME_MS });
  });

  it('keeps a legal budget untouched', () => {
    const result = normalizeAuthoredBundle(
      { manifest: manifest({ budget: { timeMs: 2500 } }), code: 'export function run() {}\n' },
      base,
    );
    expect(parseJson(result.manifestText).budget).toEqual({ timeMs: 2500 });
  });

  it('drops an unknown tool AND names it', () => {
    const result = normalizeAuthoredBundle(
      {
        manifest: manifest({
          permissions: { tools: ['files.read', 'notes.read'], network: false, risk: 'low' },
        }),
        code: 'export function run() {}\n',
      },
      base,
    );
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toContain('declares unknown tool');
    expect(result.errors.join(' ')).toContain('notes.read');
    // Dropped even on failure: a caller that stages anyway stores no reach the
    // broker cannot mediate.
    const permissions = parseJson(result.manifestText).permissions as { tools: string[] };
    expect(permissions.tools).toEqual(['files.read']);
  });

  it('refuses network: true', () => {
    const result = normalizeAuthoredBundle(
      {
        manifest: manifest({
          permissions: { tools: [], network: true, risk: 'low' },
        }),
        code: 'export function run() {}\n',
      },
      base,
    );
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toContain('network_not_supported');
    const permissions = parseJson(result.manifestText).permissions as { network: boolean };
    expect(permissions.network).toBe(false);
  });

  it('refuses llm and mcpServers while those capabilities are off', () => {
    const result = normalizeAuthoredBundle(
      {
        manifest: manifest({
          permissions: {
            tools: [],
            network: false,
            risk: 'low',
            llm: true,
            mcpServers: ['local-notes'],
          },
        }),
        code: 'export function run() {}\n',
      },
      base,
    );
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toContain('permissions.llm is refused');
    expect(result.errors.join(' ')).toContain('permissions.mcpServers is refused');
    const permissions = parseJson(result.manifestText).permissions as Record<string, unknown>;
    expect(permissions.llm).toBeUndefined();
    expect(permissions.mcpServers).toBeUndefined();
  });

  it('keeps llm and mcpServers when the build can honour them', () => {
    const result = normalizeAuthoredBundle(
      {
        manifest: manifest({
          permissions: {
            tools: ['files.read'],
            network: false,
            risk: 'medium',
            llm: true,
            mcpServers: ['local-notes'],
          },
        }),
        code: 'export function run() {}\n',
      },
      { ...base, capabilities: ON },
    );
    expect(result.ok).toBe(true);
    const permissions = parseJson(result.manifestText).permissions as Record<string, unknown>;
    expect(permissions).toMatchObject({
      tools: ['files.read'],
      llm: true,
      mcpServers: ['local-notes'],
    });
  });

  it('is deterministic - the same input produces the same text', () => {
    const raw = {
      manifest: manifest({ budget: { timeMs: 99_999_999 }, name: 'Same' }),
      code: 'export function run() {}\n',
    };
    const first = normalizeAuthoredBundle(raw, base);
    const second = normalizeAuthoredBundle(raw, base);
    expect(first).toEqual(second);
  });

  it('reports a bundle with no manifest instead of inventing one', () => {
    const result = normalizeAuthoredBundle({ code: 'export function run() {}\n' }, base);
    expect(result.ok).toBe(false);
    expect(result.manifestText).toBe('');
    expect(result.errors.join(' ')).toContain('no manifest object');
  });

  it('names a malformed permissions or budget instead of quietly defaulting it', () => {
    const result = normalizeAuthoredBundle(
      {
        manifest: manifest({ permissions: 'files.read', budget: 'soon' }),
        code: 'export function run() {}\n',
      },
      base,
    );
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toContain('permissions must be an object');
    expect(result.errors.join(' ')).toContain('budget must be an object');
    expect(parseJson(result.manifestText).permissions).toMatchObject({
      tools: [],
      network: false,
    });
  });
});

describe('templateBundle', () => {
  it('delegates to the shipped templates and yields bundles that validate ok', () => {
    for (const template of SKILL_TEMPLATES) {
      const bundle = templateBundle(template.id, 'Tidy Text', 'tidy-text');
      expect(bundle).not.toBeNull();
      if (bundle === null) throw new Error('unreachable');
      const shape = validateManifestShape(parseJson(bundle.manifestText));
      expect(shape.ok).toBe(true);
      if (!shape.ok) continue;
      expect(shape.manifest.id).toBe('tidy-text');
      expect(unknownTools(shape.manifest, new Set(TOOLS))).toEqual([]);
      expect(lintEntry(bundle.code).ok).toBe(true);
    }
  });

  it('lists only the templates this build can honour', () => {
    expect(availableTemplates(DEFAULT_RUNTIME_CAPABILITIES).map((t) => t.id)).toEqual([
      'pure',
      'reads-files',
    ]);
  });

  it('returns null for an unknown template rather than inventing one', () => {
    expect(templateBundle('notes-checklist', 'X', 'x')).toBeNull();
  });
});
