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

/**
 * The `input` node's field types (M28 D2/D3) — ONE spelling, used by the flow
 * contract below, by the core validator (`flow/schema.ts`) and by the Studio's
 * palette, which mirrors this string rather than inventing its own.
 */
export const FLOW_FIELD_TYPE_LIST = 'string | number | boolean | json';

/** The `filter`/`branch` operator whitelist (M28 D2/D3), in one place. */
export const FLOW_OPERATOR_LIST = 'eq | neq | gt | gte | lt | lte | contains | exists';

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
  // M27 S5 D11 + review fix: a token ceiling is only part of the CONSENT when
  // the skill actually HAS model reach. A tool-only manifest may still carry a
  // `budget.maxTokens` (the field is shared and validated whenever present), but
  // printing it would promise a spend the runner never makes - the same lie the
  // reach vocabulary exists to prevent. So the line is gated on `llm`, and the
  // ceiling shown is the one that BINDS: the declared number, else the default.
  if (permissions.llm === true) {
    if (typeof manifest.budget?.maxTokens === 'number') {
      lines.push(`may spend at most ${manifest.budget.maxTokens} model tokens per invocation`);
    } else {
      // A declaration WITHOUT a ceiling is not unbounded - the runner applies
      // DEFAULT_SKILL_LLM_MAX_TOKENS - and the owner has to read which number
      // actually binds before they install. Same constant, so the summary and
      // the runner's arithmetic cannot drift.
      lines.push(
        `may spend at most ${DEFAULT_SKILL_LLM_MAX_TOKENS} model tokens per invocation (the default ceiling)`,
      );
    }
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
 * `options.mcp` (M27 S2) does the same for MCP reach, which needs no new verb —
 * it is `partner.tools.exec` with an `mcp:<server>/<tool>` id — so what it adds
 * is the id shape and the rules that go with it.
 */
export function entryContract(
  toolIds: readonly string[],
  options: { llm?: boolean; mcp?: boolean } = {},
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
    ...(options.mcp === true
      ? [
          '  · partner.tools.exec("mcp:<server>/<tool>", args) reaches ONE tool on',
          '    an MCP server the manifest declares in permissions.mcpServers. The',
          '    user must have CONFIGURED and ENABLED that server before the run —',
          '    there is no prompt, so a disabled or undeclared server is a coded',
          '    refusal (mcp_not_declared / mcp_disabled / upstream); catch it',
          '  · because an MCP tool\'s own risk cannot be known in advance, a skill',
          '    that declares mcpServers must declare at least "medium" risk',
        ]
      : []),
    '',
    toolIds.length > 0
      ? `Declarable tool ids: ${toolIds.join(', ')}.`
      : 'No tool ids are available in this build.',
  ].join('\n');
}

/**
 * The FLOW vocabulary — the same ten node types `core/src/skills/flow/schema.ts`
 * validates, stated once for the three surfaces that have to agree on it:
 *
 *   1. the model prompts (`flow/refine.ts`: generate, refine, from-code, explain)
 *   2. the chat authoring instructions (a persona can stage a flow, M28 cut E)
 *   3. the Studio's palette — which MIRRORS this text client-side (it cannot
 *      import core), the same way `TOOL_LABELS` mirrors the broker registry
 *
 * Driven by the caller's capability object like `entryContract`, so a build
 * without model reach does not describe an `llm` node it would refuse
 * (`llm_not_available`), and a build whose registry is a subset never lists a
 * tool id the compile would reject.
 */
export function flowContract(
  toolIds: readonly string[],
  options: { llm?: boolean } = {},
): string {
  const llmWired = options.llm === true;
  const nodeLines: string[] = [
    '  input    {"fields":[{"name":"text","type":"' +
      FLOW_FIELD_TYPE_LIST +
      '","required":true}]}',
    '           EXACTLY ONE per flow; declares the arguments (also the test form)',
    '  const    {"value": <any JSON>}',
    '  tool     {"toolId":"<an id from the list below>","args":{"name":"<path>|<json>"}}',
    '  template {"text":"literal text with {{path}} placeholders"}',
    '  filter   {"path":"items","op":"' + FLOW_OPERATOR_LIST + '","value":<json>}',
    '           keeps the items of an array whose path satisfies the test',
    '  map      {"select":{"name":"path"}} — one object per array item',
    '  branch   {"path":"…","op":"…","value":<json>} — emits a `then` and an `else` output',
    '  merge    {"shape":"object"|"array","keys":["a","b"]} — joins its inbound edges',
    ...(llmWired
      ? ['  llm      {"prompt":"text with {{path}} placeholders"} — ONE model call']
      : []),
    '  output   {"shape":"json"|"text"} — EXACTLY ONE per flow; what run(args) returns',
  ];
  return [
    'A FLOW is the other way to author the same entry: a small typed graph that',
    'Partner COMPILES into the entry module for you. You write the graph, never',
    'JavaScript. Its whole shape:',
    '  {"version":1,',
    '   "nodes":[{"id":"n1","type":"input","position":{"x":0,"y":0},"data":{…}}],',
    '   "edges":[{"id":"e1","source":"n1","target":"n2","sourceHandle":null,"targetHandle":null}]}',
    '',
    'Node types and their `data` — the COMPLETE vocabulary (no other node, no',
    'loop, no expression language, no imports):',
    ...nodeLines,
    '',
    'Rules the compiler enforces (a flow that breaks one is refused BY NAME):',
    '  · exactly one input and exactly one output node',
    '  · data moves ONE way (a cycle is refused); a node\u2019s input is its single',
    '    inbound edge, or the skill\u2019s args when it has none — so a node whose',
    '    input is `undefined` does nothing, which is how `branch` skips a port',
    '  · a path is `a.b[0].c`: identifiers and integer indexes only. It compiles to',
    '    a safe accessor; `__proto__`, `constructor` and `prototype` are refused.',
    '    In filter/map the path is relative to the ARRAY ITEM, elsewhere to the',
    '    node\u2019s input value',
    '  · a `tool` node\u2019s string arg is a PATH reference when it looks like a path,',
    '    otherwise a literal; write {"$literal":"text"} for a string literal that',
    '    would otherwise be mistaken for a path',
    '  · template text is escaped on emit, so {{path}} is the ONLY substitution',
    ...(llmWired
      ? [
          '  · an `llm` node needs permissions.llm, and the manifest\u2019s token ceiling',
          '    bounds what the whole run may spend on model calls',
        ]
      : ['  · the `llm` node does NOT exist in this build — never emit one']),
    '',
    toolIds.length > 0
      ? `A \`tool\` node may only name one of these ids: ${toolIds.join(', ')}.`
      : 'No tool ids are available in this build, so a `tool` node cannot be used.',
  ].join('\n');
}
