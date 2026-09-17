/**
 * Skill Studio templates (M26 cut A, PLAN-M26.md).
 *
 * A template is a COMPLETE, valid bundle — manifest + entry source — emitted
 * deterministically. That is what makes the Studio usable with no provider
 * configured: authoring a skill should not require a working model, and the
 * template path is also the honest fallback when generation is unavailable.
 *
 * Rule that keeps this module small: a template may only use capabilities the
 * runtime can actually honour. The palette is therefore derived from reality,
 * not from a wish list (the `notes` and `mcp` templates appeared only once M27
 * wired those reaches — S1 and S2). `availableTemplates(capabilities)` is the
 * single source of that decision, so the Studio picker, the authoring prompt
 * and the docs cannot drift apart.
 *
 * Every template's bundle must BOTH validate and run: `templates.test.ts` holds
 * each one to a real dry-run, not to a lint.
 */
import type { SkillManifest, ToolId } from '@partner/shared';
import type { RuntimeCapabilities } from './manifest.js';

export interface SkillTemplate {
  id: string;
  name: string;
  description: string;
  /** Plain-language line for the picker: what the template's skill can do. */
  reach: string;
  /** Capability this template needs; absent = always available. */
  requires?: keyof RuntimeCapabilities;
  build(name: string, id: string): { manifest: SkillManifest; code: string };
}

const PURE_CODE = `/**
 * ${'{name}'} — a pure skill: it transforms its arguments and returns a value.
 *
 * A skill entry exports run(args) and returns JSON-serializable data. This one
 * needs no tools and no network, so it cannot be denied by anything.
 */
export function run(args = {}) {
  const text = typeof args.text === 'string' ? args.text : '';
  const upper = typeof args.upper === 'boolean' ? args.upper : false;
  return {
    text: upper ? text.toUpperCase() : text,
    length: text.length,
  };
}
`;

const READS_FILES_CODE = `/**
 * ${'{name}'} — reads files under a project root you have granted.
 *
 * Every call goes through the broker: without a user grant for the root, the
 * call is denied (a skill can never widen its own access). \`projectId\` is the
 * granted root's id, and \`path\` is relative to it.
 */
export async function run(args = {}) {
  const projectId = typeof args.projectId === 'string' ? args.projectId : '';
  const path = typeof args.path === 'string' && args.path !== '' ? args.path : '.';
  if (projectId === '') {
    return { ok: false, reason: 'projectId is required (a granted project root)' };
  }
  const listing = await partner.tools.exec('files.list', { projectId, path });
  const entries = Array.isArray(listing?.entries) ? listing.entries : [];
  return {
    ok: true,
    path,
    count: entries.length,
    // Names only — this template deliberately returns nothing else, so it
    // cannot be used to exfiltrate file content by accident.
    names: entries.map((entry) => entry?.name).filter((n) => typeof n === 'string'),
  };
}
`;

const NOTES_CHECKLIST_CODE = `/**
 * ${'{name}'} — one checklist out of the checklist items in your notes.
 *
 * All three calls are APP-SCOPED: they take no \`projectId\` and touch no
 * project root — the core's own note store IS the scope, and the owner grants it
 * once as app data ("your notes, read-only") beside their roots. Until that
 * grant exists every call is refused with \`tool_denied\`, which this entry
 * reports rather than throwing.
 *
 * The work is bounded: at most \`limit\` notes are listed or matched and one
 * \`notes.read\` per note, so a large store cannot turn this into an unbounded
 * loop of tool calls that the manifest's time budget would kill.
 */
export async function run(args = {}) {
  const query = typeof args.query === 'string' ? args.query.trim() : '';
  const requested = typeof args.limit === 'number' && args.limit > 0 ? Math.floor(args.limit) : 10;
  const limit = Math.min(requested, 25);
  try {
    let notes = [];
    if (query === '') {
      const listed = await partner.tools.exec('notes.list', { limit });
      notes = Array.isArray(listed && listed.notes) ? listed.notes : [];
    } else {
      const found = await partner.tools.exec('notes.search', { query, limit });
      notes = Array.isArray(found && found.matches) ? found.matches : [];
    }
    const items = [];
    for (const summary of notes) {
      const note = await partner.tools.exec('notes.read', { id: summary.id });
      const content = typeof note?.content === 'string' ? note.content : '';
      // Markdown task items only: "- [ ] …" / "* [x] …".
      for (const line of content.split('\\n')) {
        const match = /^\\s*[-*]\\s*\\[([ xX])\\]\\s*(.+?)\\s*$/.exec(line);
        if (match === null) continue;
        items.push({
          note: typeof note.title === 'string' ? note.title : summary.id,
          done: match[1].toLowerCase() === 'x',
          text: match[2],
        });
      }
    }
    return {
      ok: true,
      notes: notes.length,
      open: items.filter((item) => item.done === false).length,
      done: items.filter((item) => item.done === true).length,
      items,
    };
  } catch (err) {
    // A refusal is a CODE (tool_denied until app data is granted), never an
    // empty checklist that would read as "nothing left to do".
    return { ok: false, reason: err && typeof err.code === 'string' ? err.code : 'failed' };
  }
}
`;

const MCP_CALL_CODE = `/**
 * ${'{name}'} — calls ONE tool on an MCP server you configured.
 *
 * The server must be declared in this skill's manifest
 * \`permissions.mcpServers\` AND configured and ENABLED in Partner before the
 * run. A skill cannot be asked anything, so an undeclared, disabled or failing
 * server is a coded refusal this entry reports — never a prompt, and never a
 * failed run:
 *
 *   mcp_not_declared  the manifest does not name that server
 *   mcp_disabled      the server is not configured, or not enabled
 *   tool_denied       the manifest's risk is below "medium"
 *   upstream         the server failed, or serves no tool by that name
 *
 * Server ids are generated when a server is added, so a template cannot know
 * yours: the manifest shipped with this one carries a placeholder id to replace
 * before install.
 */
export async function run(args = {}) {
  const server = typeof args.server === 'string' ? args.server.trim() : '';
  const tool = typeof args.tool === 'string' ? args.tool.trim() : '';
  if (server === '' || tool === '') {
    return {
      ok: false,
      reason: 'server and tool are required: an MCP server id you configured, and a tool it serves',
    };
  }
  const params = args.params !== null && typeof args.params === 'object' ? args.params : {};
  try {
    const out = await partner.tools.exec('mcp:' + server + '/' + tool, params);
    const result = out !== null && typeof out === 'object' ? out : {};
    // The reach flattens the server's text items to output_1…n and counts every
    // item, so a result is never silently thinner than the server sent.
    const text = [];
    for (let index = 1; typeof result['output_' + index] === 'string'; index += 1) {
      text.push(result['output_' + index]);
    }
    return {
      ok: true,
      server,
      tool,
      contentItems: typeof result.contentItems === 'number' ? result.contentItems : 0,
      ms: typeof result.ms === 'number' ? result.ms : 0,
      text: text.join('\\n'),
    };
  } catch (err) {
    return { ok: false, reason: err && typeof err.code === 'string' ? err.code : 'failed' };
  }
}
`;

/**
 * The placeholder server id in the MCP template's manifest.
 *
 * MCP server ids are generated when the owner adds a server, so no template can
 * name the real one. The id must still be PRESENT for the manifest to be a
 * truthful example of the reach — `permissions.mcpServers` plus the `medium`
 * ceiling — and it is the one field the author edits before installing.
 */
export const MCP_TEMPLATE_SERVER_ID = 'your-mcp-server';

function withName(code: string, name: string): string {
  return code.replace('${name}', name);
}

const CONTENT_AUDIT_CODE = `/**
 * ${'{name}'} — finds a phrase under a project root you have granted.
 *
 * ONE declared tool: \`files.search\`, the broker's own capped, binary-skipping
 * content search. Every call goes through the broker, so without a grant it is
 * refused with \`tool_denied\` — and this entry REPORTS that code rather than
 * returning an empty match list that would read as "the phrase is not there".
 *
 * The result is reduced to a shape worth reading: per-file hit counts plus a
 * couple of sample lines, capped, with the total before the cap.
 */
const MAX_FILES = 40;
const MAX_SAMPLES = 2;

export async function run(args = {}) {
  const projectId = typeof args.projectId === 'string' ? args.projectId.trim() : '';
  if (projectId === '') {
    return { ok: false, reason: 'projectId is required (a granted project root)' };
  }
  const query = typeof args.query === 'string' ? args.query.trim() : '';
  if (query === '') return { ok: false, reason: 'query is required' };
  const path = typeof args.path === 'string' && args.path !== '' ? args.path : '.';

  let listing;
  try {
    listing = await partner.tools.exec('files.search', { projectId, path, query });
  } catch (err) {
    return { ok: false, reason: err && err.code ? err.code : 'failed' };
  }

  const hits = Array.isArray(listing && listing.hits) ? listing.hits : [];
  const byFile = new Map();
  for (const hit of hits) {
    const file = typeof hit.path === 'string' ? hit.path : '(unknown)';
    const group = byFile.get(file) ?? { path: file, count: 0, samples: [] };
    group.count += 1;
    if (group.samples.length < MAX_SAMPLES) {
      group.samples.push({
        line: typeof hit.line === 'number' ? hit.line : 0,
        text: typeof hit.text === 'string' ? hit.text.trim().slice(0, 160) : '',
      });
    }
    byFile.set(file, group);
  }

  const files = [...byFile.values()].sort((a, b) => b.count - a.count);
  return {
    ok: true,
    query,
    root: path,
    hits: hits.length,
    files: files.length,
    truncated: files.length > MAX_FILES || hits.length >= 500,
    matches: files.slice(0, MAX_FILES),
  };
}
`;

export const SKILL_TEMPLATES: readonly SkillTemplate[] = [
  {
    id: 'pure',
    name: 'Pure skill',
    description: 'Transforms the arguments it is given and returns a value. No tools, no network.',
    reach: 'Nothing outside itself — it cannot read your files or reach the network.',
    build: (name, id) => ({
      manifest: {
        id,
        name,
        description: 'Transforms the text argument it is given.',
        author: 'You',
        version: '0.1.0',
        entrypoint: 'entry.mjs',
        permissions: { tools: [], network: false, risk: 'low' },
        budget: { timeMs: 10_000 },
      },
      code: withName(PURE_CODE, name),
    }),
  },
  {
    id: 'reads-files',
    name: 'Reads files under a root',
    description: 'Lists and reads files inside a project root that you have granted.',
    reach: 'Files under a root you grant — read-only, and only while the grant exists.',
    build: (name, id) => ({
      manifest: {
        id,
        name,
        description: 'Lists the entries of a directory under a granted project root.',
        author: 'You',
        version: '0.1.0',
        entrypoint: 'entry.mjs',
        permissions: {
          tools: ['files.list', 'files.read'] as ToolId[],
          network: false,
          risk: 'medium',
        },
        budget: { timeMs: 30_000 },
      },
      code: withName(READS_FILES_CODE, name),
    }),
  },
  {
    id: 'notes-checklist',
    name: 'Checklist from your notes',
    description:
      'Collects the checklist items out of the notes you have granted it.',
    reach:
      'Your notes — read-only, and only while you have granted this skill app data.',
    requires: 'notes',
    build: (name, id) => ({
      manifest: {
        id,
        name,
        description: 'Collects the checklist items from the notes the user grants it.',
        author: 'You',
        version: '0.1.0',
        entrypoint: 'entry.mjs',
        permissions: {
          // App-scoped: no `projectId`, and no root to grant — the grant is
          // keyed on APP_SCOPE_ID, which is exactly what the picker's "App
          // data" group consents to (M27 D1/D4).
          tools: ['notes.list', 'notes.search', 'notes.read'] as ToolId[],
          network: false,
          // Same ceiling the other read-only template presents: reading the
          // owner's own notes is data they consent to explicitly, and the
          // broker manifests for all three tools are `low`, so nothing is
          // refused by declaring it here.
          risk: 'medium',
        },
        budget: { timeMs: 30_000 },
      },
      code: withName(NOTES_CHECKLIST_CODE, name),
    }),
  },
  {
    id: 'mcp-call',
    name: 'Calls an MCP server tool',
    description:
      'Calls one tool on an MCP server you have configured and enabled.',
    reach:
      'One tool on an MCP server you enable — nothing else on it is reachable.',
    requires: 'mcp',
    build: (name, id) => ({
      manifest: {
        id,
        name,
        description: 'Calls one tool on a declared MCP server and returns its text content.',
        author: 'You',
        version: '0.1.0',
        entrypoint: 'entry.mjs',
        permissions: {
          // No broker tool: the reach is the server, not a tool id (M27 D5).
          tools: [],
          network: false,
          // D6: an MCP tool's own risk is unknowable in advance, so a manifest
          // that declares a server must present at least `medium` — the
          // validator refuses anything lower at draft time.
          risk: 'medium',
          mcpServers: [MCP_TEMPLATE_SERVER_ID],
        },
        budget: { timeMs: 30_000 },
      },
      code: withName(MCP_CALL_CODE, name),
    }),
  },
  {
    // The authorable twin of the catalog's `content-audit` bundle: same idea,
    // same single declared tool, so "install it from the Catalog" and "start it
    // from a template" are two doors onto one worked example (skills-catalog/
    // README.md says so). `requires` is absent on purpose — the files tools are
    // always wired, so the picker offers this in every build.
    id: 'content-audit',
    name: 'Audit file contents',
    description: 'Searches the text inside a project root for a phrase and groups the hits by file.',
    reach: 'File contents under a root you grant — read-only, and only while the grant exists.',
    build: (name, id) => ({
      manifest: {
        id,
        name,
        description: 'Searches file contents under a granted project root and groups the hits by file.',
        author: 'You',
        version: '0.1.0',
        entrypoint: 'entry.mjs',
        permissions: { tools: ['files.search'], network: false, risk: 'medium' },
        budget: { timeMs: 30_000 },
      },
      code: withName(CONTENT_AUDIT_CODE, name),
    }),
  },
];

/** The templates this build can actually honour (M26 D9 / M27 D9). */
export function availableTemplates(
  capabilities: RuntimeCapabilities,
): readonly SkillTemplate[] {
  return SKILL_TEMPLATES.filter(
    (template) => template.requires === undefined || capabilities[template.requires],
  );
}

export function findTemplate(id: string): SkillTemplate | undefined {
  return SKILL_TEMPLATES.find((template) => template.id === id);
}
