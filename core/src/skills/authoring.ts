/**
 * Skill authoring: the model-facing half, PURE (M26 cut B, PLAN-M26.md).
 *
 * Three pure functions, and the reason each exists:
 *
 *   buildAuthoringPrompt   what the model is TOLD. It restates the skill
 *                          contract by calling `entryContract()` from
 *                          `runtime.ts`, the same text the chat instructions
 *                          use, so the prompt cannot describe a runtime that
 *                          does not exist. The tool ids are the caller's real
 *                          broker registry, not a wish list.
 *   parseAuthoringReply    what the model RETURNED. Tolerant (fences, prose
 *                          around the object) but typed on failure - a model
 *                          reply is untrusted input and must never throw into
 *                          a route.
 *   normalizeAuthoredBundle  what the core is willing to STORE. The model's
 *                          manifest is sanitised before it can become a draft:
 *                          the id is forced to the draft's own slug (a model
 *                          returning "../../evil" cannot escape), the budget
 *                          is clamped to the runner ceiling, unknown tool ids
 *                          are dropped and named, and a reach this build cannot
 *                          honour (`network`, `llm`, `mcpServers`) is refused
 *                          instead of stored as a permission that does nothing.
 *
 * No I/O, no clock, no model: everything here is unit-testable without a
 * provider, and the same input always produces the same output.
 */
import { DEFAULT_RUNTIME_CAPABILITIES, ID_RE, MAX_SKILL_TIME_MS } from './manifest.js';
import type { RuntimeCapabilities } from './manifest.js';
import { entryContract } from './runtime.js';
import { findTemplate } from './templates.js';

export interface AuthoringPromptInput {
  /** The owner's own words: what the skill should do. */
  description: string;
  /** The name the owner gave the draft. */
  name: string;
  /** The broker tool ids this build can actually grant. */
  toolIds: readonly string[];
  /** Which reaches the runtime can honour - an unwired one is not offered. */
  capabilities: RuntimeCapabilities;
}

/**
 * The one-shot authoring prompt. It teaches the contract the RUNNER implements
 * (via `entryContract`), states the caps and the two absolute limits (no
 * network, no install), and demands exactly one JSON object.
 */
export function buildAuthoringPrompt(input: AuthoringPromptInput): string {
  const capabilities = input.capabilities ?? DEFAULT_RUNTIME_CAPABILITIES;
  const name = input.name.trim();
  const description = input.description.trim();
  const whatItDoes =
    description === ''
      ? '(the owner gave no description - draft a small, honest pure skill)'
      : description;
  const lines: string[] = [
    'You are drafting ONE skill bundle for Partner: a manifest plus its entry',
    'module. You write the text; the core stores it as an INERT draft. Nothing',
    'you write runs until the owner test-runs and installs it.',
    '',
    'SKILL TO DRAFT',
    `  name: ${name}`,
    `  what it must do: ${whatItDoes}`,
    '',
    'REPLY WITH EXACTLY ONE JSON OBJECT AND NOTHING ELSE:',
    '  {"manifest": { <manifest.json> }, "code": "<the entry.mjs source>"}',
    'No prose, no explanation, no markdown fences. "code" is ONE string holding',
    'the whole ES module.',
    '',
    'manifest.json fields (all required):',
    '  "id"           a slug; the core assigns the draft its own id, so whatever',
    '                 you write here is replaced.',
    `  "name"         "${name}"`,
    '  "description"  one sentence saying what the skill does',
    '  "author"       "Partner"',
    '  "version"      "0.1.0"',
    '  "entrypoint"   "entry.mjs"',
    '  "permissions"  { "tools": [<ids from the list below>], "network": false,',
    '                   "risk": "low" | "medium" | "high" }',
    '  "budget"       { "timeMs": <a number of ms, at most 300000> }',
    '',
    'Declare the FEWEST tools that make the skill work. A tool id outside the',
    'list below is refused, so declaring reach you do not use only makes the',
    'bundle invalid.',
    '',
    entryContract(input.toolIds),
    '',
    'LIMITS THE CORE ENFORCES (a bundle that breaks one is refused, not fixed):',
    '  - args are capped at 64 KiB and the result at 1 MiB',
    '  - budget.timeMs is clamped to 300000 ms (the runner ceiling)',
    '  - "permissions.network": true is refused - a skill has no network access',
    '  - permissions.tools may name ONLY the tool ids listed above',
    '  - the entry exports run(args) (named, default, or export { run })',
  ];
  if (!capabilities.llm) {
    lines.push('  - "permissions.llm" is refused in this build - do not declare it');
  }
  if (!capabilities.mcp) {
    lines.push('  - "permissions.mcpServers" is refused in this build - do not declare it');
  }
  lines.push(
    '',
    'YOU CANNOT INSTALL. You cannot run the skill, install it, or make it',
    'executable in any way; the owner installs it after reading the code. Write',
    'the bundle, say nothing about installing it, and stop.',
  );
  return lines.join('\n');
}

/** The `{ manifest, code }` object the model is asked to return. */
export interface AuthoredBundle {
  manifest: Record<string, unknown>;
  code: string;
}

export type AuthoringParseResult =
  | { ok: true; bundle: AuthoredBundle }
  | { ok: false; errors: string[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Drop a leading/trailing markdown fence. Only the OUTER fences are removed -
 * a fence inside the entry source is legitimate code text and survives.
 */
function stripFences(text: string): string {
  return text
    .replace(/^```[A-Za-z0-9]*[ \t]*\r?\n?/, '')
    .replace(/\r?\n?[ \t]*```[ \t]*$/, '');
}

/**
 * Parse a model reply into `{ manifest, code }`. Tolerant of fences and of
 * prose around the object (first `{` to last `}`), and NEVER throws: a reply
 * that cannot be read is a typed failure the route can render.
 */
export function parseAuthoringReply(text: string): AuthoringParseResult {
  if (typeof text !== 'string' || text.trim() === '') {
    return { ok: false, errors: ['the reply was empty'] };
  }
  const unfenced = stripFences(text.trim());
  const start = unfenced.indexOf('{');
  const end = unfenced.lastIndexOf('}');
  if (start === -1 || end <= start) {
    return { ok: false, errors: ['the reply contains no JSON object'] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(unfenced.slice(start, end + 1)) as unknown;
  } catch {
    return { ok: false, errors: ['the reply is not valid JSON'] };
  }
  if (!isRecord(parsed)) {
    return { ok: false, errors: ['the reply must be a JSON object'] };
  }
  const errors: string[] = [];
  if (!isRecord(parsed.manifest)) errors.push('"manifest" must be a JSON object');
  if (typeof parsed.code !== 'string' || parsed.code.trim() === '') {
    errors.push('"code" must be a non-empty string');
  }
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    bundle: { manifest: parsed.manifest as Record<string, unknown>, code: parsed.code as string },
  };
}

export interface NormalizeAuthoringOptions {
  /** The draft's id - the ONLY id the stored manifest may carry. */
  slug: string;
  /** The broker tool ids this build can grant. */
  toolIds: readonly string[];
  capabilities?: RuntimeCapabilities;
}

/**
 * The sanitised bundle is returned in BOTH branches: a caller that stages a
 * bundle despite refusals still stages the SAFE one (the id is the slug, no
 * unknown tool survived, the budget is clamped). `ok` is the gate.
 */
export type AuthoringNormalizeResult = {
  ok: boolean;
  manifestText: string;
  code: string;
  errors: string[];
};

/**
 * Sanitise a model-authored manifest against what this build can actually
 * honour (M26 D3). Deterministic: same input, same output.
 */
export function normalizeAuthoredBundle(
  raw: unknown,
  options: NormalizeAuthoringOptions,
): AuthoringNormalizeResult {
  const errors: string[] = [];
  const capabilities = options.capabilities ?? DEFAULT_RUNTIME_CAPABILITIES;
  const record = isRecord(raw) ? raw : {};
  const code = typeof record.code === 'string' ? record.code : '';
  const rawManifest = isRecord(record.manifest) ? record.manifest : null;
  const slug = typeof options.slug === 'string' ? options.slug.trim() : '';
  const knownTools = new Set(options.toolIds);

  if (slug === '' || !ID_RE.test(slug)) {
    errors.push(`the draft id "${slug}" is not a usable skill id`);
  }
  if (rawManifest === null) {
    return {
      ok: false,
      manifestText: '',
      code,
      errors: [...errors, 'the bundle carries no manifest object'],
    };
  }

  const permissions = isRecord(rawManifest.permissions) ? rawManifest.permissions : {};
  if (rawManifest.permissions !== undefined && !isRecord(rawManifest.permissions)) {
    errors.push('permissions must be an object');
  }
  const declaredRaw = permissions.tools;
  const declared: unknown[] = Array.isArray(declaredRaw) ? declaredRaw : [];
  if (declaredRaw !== undefined && !Array.isArray(declaredRaw)) {
    errors.push('permissions.tools must be an array of tool ids');
  }
  const tools: string[] = [];
  const dropped: string[] = [];
  for (const entry of declared) {
    const toolId = typeof entry === 'string' ? entry.trim() : '';
    if (toolId === '') continue;
    if (!knownTools.has(toolId)) {
      dropped.push(toolId);
      continue;
    }
    if (!tools.includes(toolId)) tools.push(toolId);
  }
  if (dropped.length > 0) {
    // Dropped even though it is an error: a caller that stages anyway must not
    // store reach this build cannot mediate.
    errors.push(
      `declares unknown tool${dropped.length === 1 ? '' : 's'}: ${dropped.join(', ')}`,
    );
  }

  if (permissions.network === true) {
    errors.push(
      'permissions.network: true is refused (network_not_supported) - no skill has network access',
    );
  }

  const mcpAllowed = capabilities.mcp;
  const mcpServers = Array.isArray(permissions.mcpServers)
    ? permissions.mcpServers
        .filter((server): server is string => typeof server === 'string')
        .map((server) => server.trim())
        .filter((server) => server !== '')
    : [];
  if (mcpServers.length > 0 && !mcpAllowed) {
    errors.push(
      'permissions.mcpServers is refused - this build cannot let a skill reach an MCP server',
    );
  }

  const llmRequested = permissions.llm === true;
  if (llmRequested && !capabilities.llm) {
    errors.push('permissions.llm is refused - this build cannot let a skill call a model');
  }

  const budget: Record<string, unknown> = isRecord(rawManifest.budget)
    ? { ...rawManifest.budget }
    : {};
  if (rawManifest.budget !== undefined && !isRecord(rawManifest.budget)) {
    errors.push('budget must be an object of { timeMs }');
  }
  const timeMs = budget.timeMs;
  if (typeof timeMs === 'number' && Number.isFinite(timeMs) && timeMs > MAX_SKILL_TIME_MS) {
    budget.timeMs = MAX_SKILL_TIME_MS;
  }

  const manifest: Record<string, unknown> = {
    ...rawManifest,
    id: slug,
    permissions: {
      tools,
      network: false,
      risk: typeof permissions.risk === 'string' ? permissions.risk : 'low',
      ...(llmRequested && capabilities.llm ? { llm: true } : {}),
      ...(mcpServers.length > 0 && mcpAllowed ? { mcpServers } : {}),
    },
    ...(Object.keys(budget).length > 0 ? { budget } : {}),
  };

  return {
    ok: errors.length === 0,
    manifestText: JSON.stringify(manifest, null, 2),
    code,
    errors,
  };
}

/**
 * A template's bundle as draft text - delegated to `templates.ts` so template
 * source exists in exactly one place. Null when this build has no such
 * template (the caller names the ones it does have).
 */
export function templateBundle(
  templateId: string,
  name: string,
  id: string,
): { manifestText: string; code: string } | null {
  const template = findTemplate(templateId);
  if (!template) return null;
  const bundle = template.build(name, id);
  return { manifestText: JSON.stringify(bundle.manifest, null, 2), code: bundle.code };
}
