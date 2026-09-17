/**
 * Skill manifest + entry validation (M8 PLAN-M8.md, extracted in M26
 * PLAN-M26.md cut A).
 *
 * Two pure, side-effect-free gates, shared by BOTH doors a skill bundle can
 * come through — the checked-in catalog (M8) and an authored draft (M26):
 *
 *   validateManifestShape(raw)  shape + defaults over a parsed manifest.json
 *   lintEntry(code)             a heuristic, textual lint of the entry source
 *
 * Why it lives in its own module: M26 holds a drafted manifest to the SAME bar
 * as an installed one, so there must be exactly one shape validator. Two
 * validators would mean a draft can validate `ok` and then be refused at
 * install — the single most confusing failure the authoring flow could have.
 *
 * `lintEntry` is deliberately labelled a LINT: it is a text scan, it cannot
 * prove anything about behaviour, and the sandboxed dry-run remains the ground
 * truth. What it CAN do honestly is refuse the two things that would otherwise
 * fail obscurely at load time — an entry that cannot export `run(args)`, and a
 * bare module specifier that the worker (cwd inside its own store dir, no
 * node_modules of its own) cannot resolve.
 *
 * Nothing here executes, reads the filesystem, or knows about the clock.
 */
import { builtinModules } from 'node:module';
import { basename } from 'node:path';
import type { SkillBudget, SkillManifest, ToolId } from '@partner/shared';

export const ENTRY_EXT = '.mjs';
export const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const RISKS: ReadonlySet<string> = new Set(['low', 'medium', 'high']);
export const DEFAULT_TIME_MS = 30_000;
/**
 * Hard ceiling on a skill's declared budget (M8 review finding 4). It lives
 * here, next to the other skill limits, because TWO doors enforce it: the
 * runner clamps an installed manifest, and the authoring clamp refuses to
 * write a draft that claims more — one number, so the two cannot drift.
 */
export const MAX_SKILL_TIME_MS = 300_000;
/**
 * Hard ceiling on the entry source we are willing to store/lint. A skill entry
 * is a single ES module that runs in a worker with a 30s budget; 256 KiB is
 * already far past anything reviewable by a human, which is the real limit.
 */
export const MAX_ENTRY_BYTES = 256 * 1024;
/**
 * How many MCP servers one skill may declare (M27 S2, PLAN-M27 D5). A skill's
 * declared reach is what the owner reads on the install card, so it has to stay
 * a short list: eight servers is already a skill doing several distinct things,
 * and a manifest that declares more is far more likely to be a generated mistake
 * than an intent.
 */
export const MAX_SKILL_MCP_SERVERS = 8;
/**
 * The risk tier an MCP-calling skill must present (M27 S2, PLAN-M27 D6). An MCP
 * tool's own risk is unknowable in advance, so the manifest must declare at
 * least this much and the owner consents to the worst case at install.
 */
export const MCP_MIN_RISK = 'medium';
const RISK_ORDER: readonly string[] = ['low', 'medium', 'high'];

export type ManifestValidation =
  | { ok: true; manifest: SkillManifest }
  | { ok: false; errors: string[] };

/**
 * Capabilities the RUNTIME can actually honour right now.
 *
 * Default-deny on purpose: a manifest may only declare what the sandbox can
 * deliver, so a declaration that would silently do nothing is refused with a
 * named error instead of being accepted and ignored. M27 flips these on as it
 * wires each reach (`notes.*` app tools, `mcpServers`, `llm`).
 */
export interface RuntimeCapabilities {
  /** M27 S2: `permissions.mcpServers` is reachable from the runner. */
  mcp: boolean;
  /** M27 S5: `permissions.llm` (partner.llm.complete) exists. */
  llm: boolean;
  /**
   * M27 S1: the app-scoped notes tools (`notes.list` / `notes.search` /
   * `notes.read`) are in the broker registry. A Studio template that needs
   * app-data reach gates its visibility on this, exactly as the `mcp` and `llm`
   * templates do — the picker must never offer a reach the sandbox lacks.
   */
  notes: boolean;
}

/** Today's truth: no optional reach is wired by the library default (M27 adds
 *  them at the call sites that can honour them). */
export const DEFAULT_RUNTIME_CAPABILITIES: RuntimeCapabilities = {
  mcp: false,
  llm: false,
  notes: false,
};

export interface ManifestValidateOptions {
  capabilities?: RuntimeCapabilities;
}

/**
 * Shape-validate an arbitrary parsed manifest.json against the shared
 * SkillManifest wire type, with the M8 defaults applied (budget.timeMs 30s,
 * tools [], network false, risk low). fs-free — the entrypoint FILE check
 * happens in the readers that know the bundle directory.
 */
export function validateManifestShape(
  raw: unknown,
  options: ManifestValidateOptions = {},
): ManifestValidation {
  const capabilities = options.capabilities ?? DEFAULT_RUNTIME_CAPABILITIES;
  const errors: string[] = [];
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: ['manifest must be a JSON object'] };
  }
  const value = raw as Record<string, unknown>;

  const id = typeof value.id === 'string' ? value.id.trim() : '';
  if (id === '' || !ID_RE.test(id)) {
    errors.push('id must match [A-Za-z0-9][A-Za-z0-9._-]{0,63}');
  }
  const name = typeof value.name === 'string' ? value.name.trim() : '';
  if (name === '') errors.push('name is required and must be a non-empty string');
  const description = typeof value.description === 'string' ? value.description.trim() : '';
  if (description === '') errors.push('description is required and must be a non-empty string');
  const author = typeof value.author === 'string' ? value.author.trim() : '';
  if (author === '') errors.push('author is required and must be a non-empty string');
  const version = typeof value.version === 'string' ? value.version.trim() : '';
  if (version === '') errors.push('version is required and must be a non-empty string');

  // entrypoint: a bare .mjs file name inside the bundle (no directories, no
  // traversal — install copies the whole bundle and the runner joins it onto
  // the code dir, so separators/.. would escape the sandbox store).
  const entrypoint = typeof value.entrypoint === 'string' ? value.entrypoint : '';
  if (entrypoint === '' || !entrypoint.endsWith(ENTRY_EXT)) {
    errors.push('entrypoint must be a single .mjs file inside the skill bundle');
  } else if (
    basename(entrypoint) !== entrypoint ||
    entrypoint.includes('/') ||
    entrypoint.includes('\\')
  ) {
    errors.push('entrypoint must be a bare file name (no path separators)');
  }

  // permissions
  const perms = value.permissions;
  if (perms === null || typeof perms !== 'object' || Array.isArray(perms)) {
    errors.push('permissions is required and must be an object');
  }
  const permsObj = (perms ?? {}) as Record<string, unknown>;
  const toolsRaw = permsObj.tools;
  const tools: string[] = [];
  if (toolsRaw === undefined) {
    // M8 default: no tools declared.
  } else if (!Array.isArray(toolsRaw)) {
    errors.push('permissions.tools must be an array of tool ids');
  } else {
    for (const tool of toolsRaw) {
      if (typeof tool !== 'string' || tool.trim() === '') {
        errors.push('permissions.tools must contain only non-empty string tool ids');
        break;
      }
      tools.push(tool.trim());
    }
  }
  const network = permsObj.network === true;
  if (permsObj.network !== undefined && typeof permsObj.network !== 'boolean') {
    errors.push('permissions.network must be a boolean');
  }
  const risk = typeof permsObj.risk === 'string' ? permsObj.risk : 'low';
  if (!RISKS.has(risk)) errors.push('permissions.risk must be one of low|medium|high');

  // M27 S2: MCP reach is declared per SERVER (the user enables a server; a
  // skill may not name a tool that does not exist yet). Shape, ceiling and
  // reach all checked here, at DRAFT time, so a manifest that could never run
  // is refused before it is reviewable rather than at run time (D9).
  const mcpRaw = permsObj.mcpServers;
  const mcpServers: string[] = [];
  if (mcpRaw !== undefined) {
    if (!Array.isArray(mcpRaw)) {
      errors.push('permissions.mcpServers must be an array of server ids');
    } else if (mcpRaw.length > MAX_SKILL_MCP_SERVERS) {
      errors.push(
        `permissions.mcpServers may declare at most ${MAX_SKILL_MCP_SERVERS} servers`,
      );
    } else {
      const seen = new Set<string>();
      for (const entry of mcpRaw) {
        if (typeof entry !== 'string' || entry.trim() === '') {
          errors.push('permissions.mcpServers must contain only non-empty string ids');
          break;
        }
        const id = entry.trim();
        if (id.startsWith('mcp:')) {
          errors.push('permissions.mcpServers holds SERVER ids, not "mcp:" tool ids');
          break;
        }
        // De-duplicate rather than refuse: a repeated server id grants nothing
        // extra, and the install card must list reach once.
        if (seen.has(id)) continue;
        seen.add(id);
        mcpServers.push(id);
      }
      if (RISK_ORDER.indexOf(risk) < RISK_ORDER.indexOf(MCP_MIN_RISK) && mcpServers.length > 0) {
        errors.push(
          `an MCP-calling skill must declare at least "${MCP_MIN_RISK}" risk — an MCP tool's own risk cannot be known in advance`,
        );
      }
      if (!capabilities.mcp && mcpServers.length > 0) {
        errors.push(
          'permissions.mcpServers is not supported yet — no skill can reach an MCP server',
        );
      }
    }
  }

  // M27 S5: model reach. Explicit, default false, and refused while unwired.
  const llmRaw = permsObj.llm;
  const llm = llmRaw === true;
  if (llmRaw !== undefined && typeof llmRaw !== 'boolean') {
    errors.push('permissions.llm must be a boolean');
  }
  if (llm && !capabilities.llm) {
    errors.push('permissions.llm is not supported yet — a skill cannot call a model');
  }

  // budget
  const budgetRaw = value.budget;
  let budget: SkillBudget;
  if (budgetRaw === undefined) {
    budget = { timeMs: DEFAULT_TIME_MS };
  } else if (budgetRaw === null || typeof budgetRaw !== 'object' || Array.isArray(budgetRaw)) {
    errors.push('budget must be an object');
    budget = { timeMs: DEFAULT_TIME_MS };
  } else {
    const budgetObj = budgetRaw as Record<string, unknown>;
    const timeMs = typeof budgetObj.timeMs === 'number' ? budgetObj.timeMs : 0;
    const maxTokens = budgetObj.maxTokens;
    if (!Number.isFinite(timeMs) || timeMs <= 0) {
      errors.push('budget.timeMs must be a positive number of ms');
      budget = { timeMs: DEFAULT_TIME_MS };
    } else if (
      maxTokens !== undefined &&
      (!Number.isFinite(maxTokens as number) || (maxTokens as number) <= 0)
    ) {
      errors.push('budget.maxTokens must be a positive number when present');
      budget = { timeMs };
    } else {
      budget = maxTokens === undefined ? { timeMs } : { timeMs, maxTokens: maxTokens as number };
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  const manifest: SkillManifest = {
    id,
    name,
    description,
    author,
    version,
    entrypoint,
    permissions: {
      tools: tools as ToolId[],
      network,
      risk: risk as SkillManifest['permissions']['risk'],
      ...(mcpServers.length > 0 ? { mcpServers } : {}),
      ...(llm ? { llm } : {}),
    },
    budget,
  };
  return { ok: true, manifest };
}

export interface EntryLint {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

/** Builtins, with and without the `node:` prefix — the worker's own runtime. */
const BUILTINS: ReadonlySet<string> = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
]);

/** Module-ish string literals the entry might depend on. */
const SPECIFIER_PATTERNS: readonly RegExp[] = [
  // import … from 'x' | import 'x'
  /\bimport\s+(?:[^;'"]*?\sfrom\s*)?['"]([^'"]+)['"]/g,
  // import('x')
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  // require('x')
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
];

/** The shapes that can actually provide `run` to the worker harness. */
const RUN_EXPORT_PATTERNS: readonly RegExp[] = [
  /\bexport\s+(?:async\s+)?function\s+run\s*\(/,
  /\bexport\s+(?:const|let|var)\s+run\s*[:=]/,
  /\bexport\s+default\b/,
  /\bexport\s*\{[^}]*\brun\b[^}]*\}/,
];

/**
 * Textual lint of one entry source. Heuristic by construction — the dry-run is
 * the ground truth — but it catches the two failures that otherwise surface as
 * an opaque `crashed`: an unresolvable import and a missing `run` export.
 */
export function lintEntry(code: string): EntryLint {
  const errors: string[] = [];
  const warnings: string[] = [];
  const source = typeof code === 'string' ? code : '';

  if (source.trim() === '') {
    return { ok: false, errors: ['entry source is empty'], warnings };
  }
  const bytes = Buffer.byteLength(source, 'utf8');
  if (bytes > MAX_ENTRY_BYTES) {
    errors.push(
      `entry source is ${bytes} bytes — over the ${MAX_ENTRY_BYTES}-byte limit`,
    );
  }

  // Imports: only the runtime's builtins and relative files resolve from the
  // worker's own directory (no node_modules of its own).
  for (const pattern of SPECIFIER_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source)) !== null) {
      const specifier = (match[1] ?? '').trim();
      if (specifier === '') continue;
      if (specifier.startsWith('./') || specifier.startsWith('../')) continue;
      if (BUILTINS.has(specifier)) continue;
      errors.push(
        `entry imports "${specifier}" — a skill may import only node builtins and its own relative files`,
      );
      break;
    }
  }

  if (!RUN_EXPORT_PATTERNS.some((pattern) => pattern.test(source))) {
    errors.push('entry must export a run(args) function (named or default)');
  }

  return { ok: errors.length === 0, errors, warnings };
}
