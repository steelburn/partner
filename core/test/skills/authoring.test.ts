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
import { compileFlow } from '../../src/skills/flow/compile.js';
import { buildFlowGeneratePrompt, parseFlowReply } from '../../src/skills/flow/refine.js';
import { demoHarness } from '../helpers.js';

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

  it('DESCRIBES each wired reach, so the prompt and the validator agree (M27 S2 D9)', () => {
    // The wiring is what decides the text: an unwired reach is refused in words,
    // a wired one is described with the same rules the validator enforces.
    const on = buildAuthoringPrompt({
      description: 'x',
      name: 'X',
      toolIds: TOOLS,
      capabilities: ON,
    });
    // MCP: the id shape, that the owner must have enabled the server, and the
    // ceiling rule that a `low` manifest declaring MCP is refused.
    expect(on).toContain('mcp:<server-id>/<tool-name>');
    expect(on).toContain('at least "medium" risk');
    expect(on).toContain('mcp_not_declared');
    // Model reach keeps its own description (regression guard on the same block).
    expect(on).toContain('partner.llm.complete');

    const off = buildAuthoringPrompt({
      description: 'x',
      name: 'X',
      toolIds: TOOLS,
      capabilities: OFF,
    });
    // Unwired: the reach is refused AND never described.
    expect(off).not.toContain('mcp:<server-id>/<tool-name>');
    expect(off).not.toContain('partner.llm.complete');
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
  // M27 S4: the palette now includes the notes and MCP templates, so every
  // template is validated against the build that OFFERS it (the wiring the
  // picker reads) and against a registry that has the app-scoped tool ids too.
  const ALL_TOOLS = [...TOOLS, 'notes.list', 'notes.search', 'notes.read'];

  it('delegates to the shipped templates and yields bundles that validate ok', () => {
    for (const template of SKILL_TEMPLATES) {
      const bundle = templateBundle(template.id, 'Tidy Text', 'tidy-text');
      expect(bundle).not.toBeNull();
      if (bundle === null) throw new Error('unreachable');
      const shape = validateManifestShape(parseJson(bundle.manifestText), {
        capabilities: ON,
      });
      expect(shape.ok, `${template.id}: ${shape.ok ? '' : shape.errors.join(' ')}`).toBe(true);
      if (!shape.ok) continue;
      expect(shape.manifest.id).toBe('tidy-text');
      expect(unknownTools(shape.manifest, new Set(ALL_TOOLS))).toEqual([]);
      expect(lintEntry(bundle.code).ok).toBe(true);
    }
  });

  it('lists only the templates this build can honour', () => {
    expect(availableTemplates(DEFAULT_RUNTIME_CAPABILITIES).map((t) => t.id)).toEqual([
      'pure',
      'reads-files',
      'content-audit',
    ]);
  });

  it('returns null for an unknown template rather than inventing one', () => {
    expect(templateBundle('no-such-template', 'X', 'x')).toBeNull();
  });
});

/**
 * M28 cut D/E — the FLOW half of authoring (PLAN-M28.md).
 *
 * The flow vocabulary is not a second prompt language: it is `flowContract()`
 * from `runtime.ts`, the same text the flow prompts and the Studio's palette
 * mirror. These tests pin the two properties the milestone's exit criteria name
 * for it:
 *
 *   1. The prompt teaches the NODE VOCABULARY and not JavaScript — it lists the
 *      available node types (and NOT `llm` when the build has no model reach)
 *      plus the registry's own tool ids, so a model that answers it produces a
 *      graph the compiler can take.
 *   2. A model reply containing a valid flow is parsed and compiled into an
 *      INSTALLABLE draft: the whole point of authoring a graph is that it ends
 *      as the same artifact a hand-written bundle does.
 */
describe('M28 D/E: the flow authoring prompt', () => {
  it('teaches the node vocabulary and not JavaScript', () => {
    const prompt = buildFlowGeneratePrompt({
      name: 'Notes digest',
      description: 'turn the text into a checklist',
      toolIds: TOOLS,
      llmAvailable: false,
    });
    // The vocabulary, stated once.
    expect(prompt).toContain('A FLOW is the other way to author the same entry');
    for (const type of ['input', 'const', 'tool', 'template', 'filter', 'map', 'branch', 'merge', 'output']) {
      expect(prompt).toContain(type);
    }
    // The registry's own ids, not a wish list.
    for (const tool of TOOLS) expect(prompt).toContain(tool);
    // No model reach in this build, so the node does not exist to offer.
    expect(prompt).not.toContain('llm      {');
    expect(prompt).toContain('the `llm` node does NOT exist in this build');
    // A vocabulary, not a language.
    expect(prompt).not.toContain('export ');
    expect(prompt).not.toContain('function ');
    expect(prompt).not.toContain('=>');
  });

  it('offers the llm node only when this build can compile one', () => {
    const wired = buildFlowGeneratePrompt({
      name: 'Digest',
      description: 'summarise',
      toolIds: TOOLS,
      llmAvailable: true,
    });
    expect(wired).toContain('llm      {"prompt"');
    expect(wired).not.toContain('does NOT exist in this build');
  });

  it('goes from a model REPLY to an installable draft (parse -> compile -> install)', async () => {
    // The reply is text, exactly as a model would return it: fenced, with prose
    // around it. `parseFlowReply` is the door the hook uses.
    const reply = [
      'Here is the graph you asked for:',
      '```json',
      JSON.stringify({
        version: 1,
        nodes: [
          {
            id: 'in',
            type: 'input',
            position: { x: 0, y: 0 },
            data: { fields: [{ name: 'text', type: 'string', required: true }] },
          },
          { id: 'msg', type: 'template', position: { x: 1, y: 0 }, data: { text: '{{text}}' } },
          { id: 'out', type: 'output', position: { x: 2, y: 0 }, data: { shape: 'text' } },
        ],
        edges: [
          { id: 'e0', source: 'in', target: 'msg' },
          { id: 'e1', source: 'msg', target: 'out' },
        ],
      }),
      '```',
    ].join('\n');
    const parsed = parseFlowReply(reply);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const compiled = compileFlow(parsed.flow, {
      registry: new Set(TOOLS),
      llmAvailable: false,
    });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    // The compiled module is held to the SAME M26 gates as a hand-written
    // bundle: it must pass the entry lint and its manifest must validate.
    expect(lintEntry(compiled.code).ok).toBe(true);
    const manifestText = JSON.stringify({
      id: 'flow-digest',
      name: 'Flow digest',
      description: 'turn the text into something else',
      author: 'Partner',
      version: '0.1.0',
      entrypoint: 'entry.mjs',
      permissions: { tools: compiled.tools, network: false, risk: 'low', llm: compiled.usesLlm },
      budget: { timeMs: 10_000 },
    });
    const shape = validateManifestShape(JSON.parse(manifestText) as unknown, {
      capabilities: { ...DEFAULT_RUNTIME_CAPABILITIES, llm: false },
    });
    expect(shape.ok).toBe(true);

    // And it INSTALLS: a persona/Studio flow ends as the same artifact any other
    // draft does, through the one promote path.
    const h = demoHarness();
    try {
      const draft = await h.skillDrafts!.create({
        mode: 'generate-flow',
        name: 'Flow digest',
        description: 'turn the text into something else',
      });
      const installed = h.skillDrafts!.promote(draft.id, {});
      expect(installed.mode).toBe('created');
      expect(installed.skill.id).toBe(draft.id);
      // Invoke it: the compiled graph really runs, in the real M8 sandbox.
      const runner = h.skillRunner;
      const detail = h.skills!.get(draft.id);
      if (runner === undefined || detail === null) {
        throw new Error('the skills runner is unwired in this harness');
      }
      const run = await runner.invoke(detail, { text: 'hello' }, { record: false });
      expect(run.ok).toBe(true);
      if (run.ok) expect(run.result).toBe('hello');
    } finally {
      h.close();
    }
  });
});
