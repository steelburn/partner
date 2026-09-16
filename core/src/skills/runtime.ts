/**
 * The skill runtime vocabulary (M26 cut A, PLAN-M26.md).
 *
 * ONE place that answers "what can a skill do, and how do we say that to a
 * human?" — because four surfaces have to agree on the answer and none of them
 * can be allowed to drift:
 *
 *   1. the authoring prompt + the chat instructions (what the model is told)
 *   2. the deterministic validator (what is refused)
 *   3. the install summary and the approval card (what the owner consents to)
 *   4. the Studio's palette + permission panel (what is offered)
 *
 * The plain-language reach lines are written for consequence, not for
 * completeness: "can read files under a root you grant", not "files.read".
 */
import type { SkillManifest } from '@partner/shared';
import { DEFAULT_SKILL_LLM_MAX_TOKENS } from './llm.js';

/** Plain-language consequence of one declared tool. */
const TOOL_REACH: Readonly<Record<string, string>> = {
  'files.list': 'list directories under a root you grant',
  'files.read': 'read files under a root you grant',
  'files.search': 'search file contents under a root you grant',
  'files.edit': 'propose edits to files under a root you grant',
  'files.apply': 'write files under a root you grant',
  'files.delete': 'delete files under a root you grant',
  'notes.list': 'list your notes',
  'notes.search': 'search your notes',
  'notes.read': 'read your notes',
};

/** Unknown ids are named as themselves — never silently described as safe. */
export function describeToolReach(toolId: string): string {
  return TOOL_REACH[toolId] ?? `use the tool "${toolId}"`;
}

/**
 * The lines a human reads before installing. Order is stable so the install
 * summary, the approval card and the permission diff agree line for line.
 */
export function permissionSummary(manifest: SkillManifest): string[] {
  const permissions = manifest.permissions;
  const lines: string[] = [];
  for (const tool of permissions.tools) lines.push(`can ${describeToolReach(tool)}`);
  for (const server of permissions.mcpServers ?? []) {
    lines.push(`can call tools on the MCP server "${server}"`);
  }
  if (permissions.llm === true) {
    lines.push('can send the data it reads to your configured model provider');
  }
  if (permissions.network) {
    lines.push('can reach the network');
  } else {
    lines.push('cannot reach the network');
  }
  lines.push(`is treated as ${permissions.risk} risk`);
  const seconds = Math.max(1, Math.round((manifest.budget?.timeMs ?? 30_000) / 1000));
  lines.push(`runs for at most ${seconds}s per invocation`);
  if (typeof manifest.budget?.maxTokens === 'number') {
    lines.push(`may spend at most ${manifest.budget.maxTokens} model tokens per invocation`);
  } else if (permissions.llm === true) {
    // M27 S5 D11: a declaration WITHOUT a ceiling is not unbounded - the runner
    // applies DEFAULT_SKILL_LLM_MAX_TOKENS - and the owner has to read which
    // number actually binds before they install. Same constant, so the summary
    // and the runner's arithmetic cannot drift.
    lines.push(
      `may spend at most ${DEFAULT_SKILL_LLM_MAX_TOKENS} model tokens per invocation (the default ceiling)`,
    );
  }
  return lines;
}

/** Which of a manifest's declared tools are NOT in the broker registry. */
export function unknownTools(
  manifest: SkillManifest,
  registry: ReadonlySet<string>,
): string[] {
  return manifest.permissions.tools.filter((tool) => !registry.has(tool));
}

/**
 * The contract a skill entry must satisfy — stated once, verbatim, so the
 * authoring prompt and the chat instructions cannot describe it differently
 * from what the worker harness actually does.
 *
 * `options.llm` (M27 S5) adds the model verb, and only where the build can
 * honour it: describing `partner.llm.complete` to a build whose runner answers
 * `llm_not_declared` for every call would produce a draft that cannot run.
 */
export function entryContract(
  toolIds: readonly string[],
  options: { llm?: boolean } = {},
): string {
  return [
    'A skill entry is ONE ES module exporting run(args):',
    '  export async function run(args) { … return <JSON-serializable>; }',
    '(or `export default`, or `export { run }`).',
    '',
    'Its only interface to the core is a global named `partner`:',
    '  partner.log(text)                    — a line on the core console',
    '  partner.tools.exec(toolId, params)   — one broker-mediated tool call',
    ...(options.llm === true
      ? [
          '  partner.llm.complete({prompt, maxTokens?}) — one model call,',
          "    resolving {text, usage}; needs permissions.llm, and the manifest's",
          '    token ceiling bounds what the whole run may spend on it',
        ]
      : []),
    'No imports are available except node builtins and files next to the entry.',
    'There is no network access.',
    '',
    'Rules the runtime enforces (an entry that breaks them fails to run):',
    '  · return JSON-serializable data (the result is capped at 1 MiB)',
    '  · args are capped at 64 KiB',
    '  · the whole run is killed when the manifest budget expires',
    '  · a tool call must be declared in the manifest AND covered by a user grant;',
    '    a skill is non-interactive, so a missing grant is a hard denial',
    ...(options.llm === true
      ? [
          '  · a model call must be declared as permissions.llm; the ceiling is',
          '    per INVOCATION (every call in one run counts against it), and passing',
          '    it fails the whole run instead of returning a partial result',
        ]
      : []),
    '',
    toolIds.length > 0
      ? `Declarable tool ids: ${toolIds.join(', ')}.`
      : 'No tool ids are available in this build.',
  ].join('\n');
}
