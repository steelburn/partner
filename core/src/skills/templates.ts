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
 * not from a wish list (a `notes` or `mcp` template appears only once M27 wires
 * that reach). `availableTemplates(capabilities)` is the single source of that
 * decision, so the Studio picker, the authoring prompt and the docs cannot
 * drift apart.
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

function withName(code: string, name: string): string {
  return code.replace('${name}', name);
}

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
