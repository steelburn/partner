/**
 * M26 cut C: skill authoring as chat tools (PLAN-M26.md D2, D2b, D8).
 *
 * Two tools, and the line between them is the point of the whole milestone:
 *
 *   skills.draft          stages (or updates) an INERT draft. It cannot run
 *                         anything and it cannot install anything.
 *   skills.requestInstall ASKS the owner to install a draft. It writes one
 *                         approval row and installs nothing itself.
 *
 * Neither tool reaches `promote` or `runDraft`: there is no code path from here
 * to executable code, which is why "a model may write code and ask, but only
 * the owner's act makes it executable" holds structurally rather than by prompt
 * discipline. Approving the row the second tool writes calls the SAME
 * `drafts.promote()` the Studio button calls.
 *
 * M26 review addition — a persona can propose an UPDATE to an installed skill.
 * `skills.draft` takes an optional `skillId`: the installed skill it wants to
 * change. That path opens (or reuses) the skill's `edit` draft through the same
 * manager method the Studio's "Edit in Studio" calls, so the manifest keeps the
 * INSTALLED id binding and promoting it is an update rather than a second skill.
 * It still installs nothing — the ask goes through `skills.requestInstall`, and a
 * WIDENING permission set cannot be approved from the card until the owner has
 * been shown the before→after table and acknowledged it (`acknowledgePermissions`,
 * the same D6 gate the Studio applies). Without this a persona could only ever
 * create NEW skills, which is the gap the owner's review found.
 *
 * The provider carries `capability: 'skill.author'`, so the tool pass refuses it
 * by CLIENT CLASS before execute-vs-queue (a mobile or extension session may not
 * author at all), and `canAdvertiseAuthoring` states the D8 rule the chat route
 * uses to decide whether a turn is even told these tools exist.
 *
 * M28 cut E: `skills.draft` also accepts a `flow` payload instead of `code`. It
 * is deliberately the SAME tool, not a third one: a flow is an authoring view of
 * the SAME artifact (the core compiles it to `entry.mjs`), so a persona that can
 * write a skill can write it as a graph, and the Studio opens the result on the
 * canvas. The graph is untrusted input like any other bundle text — the manager
 * validates it (`validateFlow`), compiles it (the one compiler) and derives the
 * manifest's permissions from the graph's own `tool` nodes.
 *
 * The model's bundle is untrusted input: `manifestText` goes through
 * `normalizeAuthoredBundle` (forced id, clamped budget, unknown tools dropped
 * and named, `network: true` refused) before it is staged, exactly as a
 * generated bundle is.
 */
import type { ToolExecResponse, ToolId, ToolManifest } from '@partner/shared/tools.js';
import type { Persona, SkillDraft, SkillDraftValidation, SkillManifest } from '@partner/shared';
import { normalizeAuthoredBundle } from './authoring.js';
import type { ChatFlowStageInput, ChatStageInput, RequestInstallOptions } from './drafts.js';
import { permissionDiff, slugifySkillId } from './drafts.js';
import { capabilityDenial } from '../http/capabilities.js';
import type { Capability } from '../http/capabilities.js';
import { DEFAULT_RUNTIME_CAPABILITIES } from './manifest.js';
import type { RuntimeCapabilities } from './manifest.js';

export const DRAFT_TOOL_ID = 'skills.draft';
export const REQUEST_INSTALL_TOOL_ID = 'skills.requestInstall';

/** The tool ids this provider owns. ONE spelling: the route advertises these,
 *  the instructions name them, and the tests assert on them. */
export const AUTHORING_TOOL_IDS: readonly string[] = [DRAFT_TOOL_ID, REQUEST_INSTALL_TOOL_ID];

/** The JSON-schema advertisement for one authoring tool. */
export interface AuthoringToolSpec {
  id: string;
  description: string;
  parameters: Record<string, unknown>;
}

/**
 * The specs the model is shown. Built from the live broker registry and the
 * runtime's own capabilities, so the description cannot promise a tool id the
 * broker does not have or a reach this build refuses.
 */
export function authoringToolSpecs(
  toolIds: ReadonlySet<string>,
  capabilities: RuntimeCapabilities = DEFAULT_RUNTIME_CAPABILITIES,
): AuthoringToolSpec[] {
  const ids = [...toolIds];
  const refused: string[] = [];
  if (!capabilities.llm) refused.push('"permissions.llm"');
  if (!capabilities.mcp) refused.push('"permissions.mcpServers"');
  return [
    {
      id: DRAFT_TOOL_ID,
      description: [
        'Stage or update a skill DRAFT the user can review, test-run and install.',
        'Drafting is inert: it installs nothing and runs nothing.',
        'Give name + description + code (JavaScript, the manifest is built for you),',
        'or name + description + flow (a graph the core compiles for you), or a full',
        'manifestText when you need to control risk, version or budget.',
        'A flow is the safer authoring form: it is a small typed vocabulary with no',
        'loops, no imports and no arbitrary expressions, and its tool reach is',
        'derived from the graph.',
        ids.length > 0
          ? `Declarable tool ids (permissions.tools): ${ids.join(', ')}.`
          : 'No tool ids are available in this build.',
        'network: true is always refused.',
        ...(refused.length > 0 ? [`Refused in this build: ${refused.join(', ')}.`] : []),
        'Returns the draft id and the deterministic validation result; re-call with',
        'the same id and a fixed bundle to clear the errors.',
        'To CHANGE a skill the user already has installed, pass skillId (its id):',
        'the bundle is staged as an UPDATE to that skill, and nothing changes until',
        'the user approves an install ask. Never invent a skillId — use an id the',
        'user gave you or one that is installed.',
      ].join(' '),
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Existing draft id to update.' },
          skillId: {
            type: 'string',
            description: [
              'An INSTALLED skill id to stage this bundle as an UPDATE to.',
              'The core opens that skill\'s edit draft and binds the manifest to',
              'its id, so approving the install ask updates the skill in place.',
              'Mutually exclusive with `id` (which names a DRAFT).',
            ].join(' '),
          },
          name: { type: 'string', description: 'The skill name.' },
          description: { type: 'string', description: 'One sentence on what it does.' },
          manifestText: {
            type: 'string',
            description: 'manifest.json as text. Omit to have one built from tools.',
          },
          code: { type: 'string', description: 'The entry.mjs source (exports run).' },
          flow: {
            type: 'object',
            description: [
              'A FLOW graph ({version:1, nodes, edges}) INSTEAD of `code`.',
              'The core validates it, compiles it into the entry and derives',
              'permissions.tools from its `tool` nodes, so a flow cannot declare',
              'reach its code does not use. Pass `flow` or `code`, never both.',
            ].join(' '),
          },
          tools: {
            type: 'array',
            items: { type: 'string' },
            description: 'Broker tool ids the skill needs (used when manifestText is omitted).',
          },
        },
        required: ['name'],
        anyOf: [{ required: ['code'] }, { required: ['flow'] }],
      },
    },
    {
      id: REQUEST_INSTALL_TOOL_ID,
      description: [
        'Ask the user to install a skill draft. This installs NOTHING: it opens an',
        'approval card in this chat, and the user decides. Only they can install a',
        'skill - never call this to make code run by yourself.',
      ].join(' '),
      parameters: {
        type: 'object',
        properties: {
          draftId: { type: 'string', description: 'The draft to install (from skills.draft).' },
        },
        required: ['draftId'],
      },
    },
  ];
}

function toManifest(spec: AuthoringToolSpec): ToolManifest {
  return {
    // External-only tool id - never enters the broker's files-only catalog.
    id: spec.id as ToolId,
    description: spec.description,
    // LOW: both tools are INERT. Drafting writes text the owner can read, and
    // requesting an install writes an approval row - the install itself still
    // needs the owner's tap. Declaring them medium/high would make the gate
    // queue a generic broker approval for a tool no broker manifest exists for,
    // i.e. a dead end: nothing could execute it.
    risk: 'low',
    confirm: 'once',
    // A skill bundle is drafted locally; the network never enters this path.
    network: false,
    scope: { kind: 'project' },
  };
}

/**
 * M26 D8: may a turn be told about authoring at all?
 *
 * All four conditions must hold, and every one is a refusal the user can
 * predict: the session must be a DESKTOP client (the `skill.author` envelope;
 * mobile and extension are allowlists that exclude it), the persona must not be
 * at `assist` (that level answers and proposes only), and the persona must not
 * have banned either tool. "No advertisement when it cannot act" is the M12/F2
 * search rule, reused.
 */
export function canAdvertiseAuthoring(input: {
  persona: Pick<Persona, 'independence' | 'policy'>;
  clientClass: string;
}): boolean {
  if (capabilityDenial(input.clientClass, 'skill.author') !== null) return false;
  if (input.persona.independence.level === 'assist') return false;
  const banned = input.persona.policy?.tools?.banned ?? [];
  return !AUTHORING_TOOL_IDS.some((toolId) => banned.includes(toolId));
}

/** The subset of the drafts manager the tools use (structural - easy to fake). */
export interface AuthoringDraftStore {
  get(id: string): SkillDraft | null;
  stageFromChat(input: ChatStageInput): SkillDraft;
  /**
   * M28 cut E: the `flow` payload. The manager validates the graph, compiles it
   * and derives the manifest, so this stays a TWO-method seam and the tool layer
   * never learns how a graph becomes an artifact.
   */
  stageFlowFromChat(input: ChatFlowStageInput): SkillDraft;
  /**
   * M26 review: the edit draft of an INSTALLED skill, plus that skill's current
   * manifest (the `before` side of the consent table). Throws `not_found` when
   * the id is not installed — a persona may propose changes to a skill the owner
   * has, never to one that does not exist.
   */
  openUpdate(skillId: string): { draft: SkillDraft; installed: SkillManifest };
  requestInstall(id: string, options?: RequestInstallOptions): { pendingId: string };
}

export interface AuthoringToolOptions {
  /** Absent = the tools are not offered at all (a build with no drafts). */
  drafts?: AuthoringDraftStore;
  /** The broker tool ids a bundle may declare (this build's real registry). */
  toolIds: ReadonlySet<string>;
  /** Which reaches the runtime can honour (the description states the refusals). */
  capabilities?: RuntimeCapabilities;
  /**
   * The conversation/persona this turn belongs to. A draft staged here is
   * LINKED to that conversation, and an install ask rides it into the approval
   * card - a model cannot name these itself, so they come from the turn.
   */
  conversationId?: string | null;
  personaId?: string | null;
}

export interface AuthoringToolExternal {
  manifests: ReadonlyArray<ToolManifest>;
  allow(toolId: string): boolean;
  exec(toolId: string, args: Record<string, unknown>): ToolExecResponse;
  /**
   * The class envelope this provider needs, applied by the tool pass BEFORE
   * execute-vs-queue. Static externals (search) pass no capability; a
   * write-shaped one must not inherit that gap.
   */
  capability: Capability;
}

function readString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  return typeof value === 'string' ? value.trim() : '';
}

/** `tools: ['files.read']` -> a manifest object the one sanitiser can clean. */
function manifestFromTools(
  args: Record<string, unknown>,
  name: string,
  description: string,
): Record<string, unknown> {
  const raw = args.tools;
  const tools = Array.isArray(raw)
    ? raw.filter((entry): entry is string => typeof entry === 'string').map((entry) => entry.trim())
    : [];
  return {
    name,
    description: description === '' ? `The ${name} skill.` : description,
    author: 'Partner',
    version: '0.1.0',
    entrypoint: 'entry.mjs',
    permissions: {
      tools,
      network: false,
      // A skill that reaches NOTHING is low risk; one that reaches the user's
      // files is not, and `risk` is what the permission summary and the install
      // card say out loud. The model can pass manifestText to decide it itself.
      risk: tools.length === 0 ? 'low' : 'medium',
    },
    budget: { timeMs: 10_000 },
  };
}

/**
 * The chat-tool external executor for skill authoring. Undefined when the drafts
 * manager is not wired, so the tool pass simply never sees the ids.
 */
export function authoringToolExternal(
  options: AuthoringToolOptions,
): AuthoringToolExternal | undefined {
  const drafts = options.drafts;
  if (drafts === undefined) return undefined;
  const capabilities = options.capabilities ?? DEFAULT_RUNTIME_CAPABILITIES;
  const specs = authoringToolSpecs(options.toolIds, capabilities);

  /**
   * The refusal shape for a bundle the core will not store, kept IDENTICAL to
   * the staged one so the model reads the same fields either way.
   */
  function refusedResult(
    name: string,
    draftId: string | null,
    errors: string[],
  ): ToolExecResponse {
    return {
      outcome: 'executed',
      result: {
        ok: false,
        draftId,
        name,
        validation: { ok: false, errors, warnings: [] },
        problems: errors.join('; '),
        next:
          'Nothing was staged. Fix every problem and call skills.draft again' +
          (draftId === null ? '.' : ' with the same id.'),
      },
    };
  }

  /** A compact, legible result: the model reads this text, not a data shape. */
  function stagedResult(
    draft: SkillDraft,
    update: { installed: SkillManifest } | null = null,
  ): ToolExecResponse {
    const validation: SkillDraftValidation = draft.validation;
    // On an UPDATE the consent table the owner will be shown IS this diff, so the
    // model gets the same list — it has to be able to tell the user what changes
    // before asking them to approve it.
    const changes =
      update === null || draft.manifest === null
        ? []
        : permissionDiff(update.installed, draft.manifest);
    const updateFacts =
      update === null
        ? {}
        : {
            mode: 'update' as const,
            skillId: update.installed.id,
            installedVersion: update.installed.version,
            changes,
            // `null` = unknown (the manifest does not parse yet), which is
            // honest: a broken draft has no permission set to compare.
            widens: draft.manifest === null ? null : changes.length > 0,
          };
    return {
      outcome: 'executed',
      result: {
        ok: validation.ok,
        draftId: draft.id,
        name: draft.name,
        ...(update === null ? { mode: 'create' as const } : updateFacts),
        // The structured result for a caller that wants it...
        validation: {
          ok: validation.ok,
          errors: validation.errors,
          warnings: validation.warnings,
        },
        // ...and the SAME errors as one readable line, because the generic tool
        // summarizer collapses an array to "[n items]" - the model has to be
        // able to read the problem it must fix.
        problems: validation.errors.join('; '),
        next: nextFor(update, draft, changes, validation),
      },
    };
  }

  /** What the model should do once the bundle is staged (and nothing is live). */
  function nextFor(
    update: { installed: SkillManifest } | null,
    draft: SkillDraft,
    changes: ReturnType<typeof permissionDiff>,
    validation: SkillDraftValidation,
  ): string {
    if (update === null) {
      return (
        'Nothing has been installed. You cannot install or run a skill - the user does. ' +
        'Re-call skills.draft with the same draftId to fix problems, or ask with ' +
        'skills.requestInstall. The user can review, test and install it in Skills > Build.'
      );
    }
    if (!validation.ok) {
      return (
        `Nothing has changed yet: this UPDATE to "${update.installed.id}" does not validate. ` +
        'Re-call skills.draft with the same skillId and a fixed bundle.'
      );
    }
    if (draft.manifest === null) {
      return (
        `Nothing has changed yet: the manifest for this UPDATE to "${update.installed.id}" ` +
        'does not parse, so this build cannot tell what it would grant. Fix it first.'
      );
    }
    if (changes.length > 0) {
      const lines = changes.map((change) => `${change.field}: ${change.before} -> ${change.after}`);
      return (
        `Nothing has changed yet. This UPDATE to "${update.installed.id}" WIDENS what the skill may do ` +
        `(${lines.join('; ')}), so the user has to see the change table and acknowledge it. ` +
        'Tell them exactly what it adds, then ask with skills.requestInstall - they decide.'
      );
    }
    return (
      `Nothing has changed yet. This UPDATE to "${update.installed.id}" does not widen anything. ` +
      'Ask with skills.requestInstall and the user decides whether to apply it.'
    );
  }

  return {
    manifests: specs.map(toManifest),
    capability: 'skill.author',
    allow: (toolId: string): boolean => AUTHORING_TOOL_IDS.includes(toolId),
    exec: (toolId: string, args: Record<string, unknown>): ToolExecResponse => {
      if (!AUTHORING_TOOL_IDS.includes(toolId)) {
        return { outcome: 'denied', reason: 'unknown_tool' };
      }
      if (toolId === REQUEST_INSTALL_TOOL_ID) {
        const draftId = readString(args, 'draftId');
        if (draftId === '') return { outcome: 'denied', reason: 'missing_draft_id' };
        try {
          const { pendingId } = drafts.requestInstall(draftId, {
            conversationId: options.conversationId ?? null,
            personaId: options.personaId ?? null,
          });
          const draft = drafts.get(draftId);
          return {
            outcome: 'executed',
            result: {
              ok: true,
              pendingId,
              draftId,
              name: draft?.name ?? '',
              next:
                'The user decides this. Nothing is installed until they approve the card in ' +
                'this chat; do not claim the skill is installed.',
            },
          };
        } catch {
          // Typed refusals (not_found / conflict / invalid_input) are named by
          // the reason code only: the message is for the owner's UI, not for the
          // model's system note.
          return { outcome: 'denied', reason: 'install_not_available' };
        }
      }

      // skills.draft
      const name = readString(args, 'name');
      if (name === '') return { outcome: 'denied', reason: 'missing_name' };
      const code = typeof args.code === 'string' ? args.code : '';
      const rawFlow = args.flow;
      const hasFlow = rawFlow !== null && typeof rawFlow === 'object' && !Array.isArray(rawFlow);
      // A payload must carry ONE of the two artifact forms. "Neither" is a
      // refusal the model can act on; "both" is too, because staging one and
      // ignoring the other would silently drop half of what it asked for.
      if (!hasFlow && code.trim() === '') return { outcome: 'denied', reason: 'missing_code' };
      if (hasFlow && code.trim() !== '') {
        return refusedResult(name, readString(args, 'id') || null, [
          'pass either `flow` (a graph) or `code` (JavaScript), never both',
        ]);
      }
      const description = readString(args, 'description');
      const existingId = readString(args, 'id');
      const skillId = readString(args, 'skillId');

      // M26 review: an UPDATE is addressed by the INSTALLED skill's id, a draft
      // edit by the DRAFT's id. Both at once is ambiguous (which id would the
      // staged manifest carry?), so it is refused rather than guessed.
      if (skillId !== '' && existingId !== '') {
        return refusedResult(name, existingId, [
          'pass either `id` (a draft to update) or `skillId` (an installed skill to update), never both',
        ]);
      }
      // The update target: the skill's edit draft (ONE per skill - the same row
      // the Studio's "Edit in Studio" manages) plus the manifest being changed.
      let update: { draftId: string; installed: SkillManifest } | null = null;
      if (skillId !== '') {
        try {
          const opened = drafts.openUpdate(skillId);
          update = { draftId: opened.draft.id, installed: opened.installed };
        } catch {
          // Not installed (or the id is not a skill): nothing was staged, and the
          // model is told so it can stop guessing ids.
          return refusedResult(name, null, [
            `no installed skill with id "${skillId}" - nothing was staged. Ask the user which skill, or create a new one with `+
              'skills.draft without skillId.',
          ]);
        }
      }
      /** The row the bundle is written into: the edit draft, or the model's draft. */
      const targetId = update === null ? existingId : update.draftId;

      if (hasFlow) {
        // M28 E: the graph path. The manager does everything the code path does
        // — schema door, compile, derived permissions, caps — so what can come
        // back is the same kind of named problem, and the model is told it.
        try {
          return stagedResult(
            drafts.stageFlowFromChat({
              name,
              description,
              flow: rawFlow,
              conversationId: options.conversationId ?? null,
              personaId: options.personaId ?? null,
              ...(targetId !== '' ? { id: targetId } : {}),
            }),
            update === null ? null : { installed: update.installed },
          );
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : 'the flow could not be staged';
          return refusedResult(name, targetId === '' ? null : targetId, [message]);
        }
      }

      const manifestText = typeof args.manifestText === 'string' ? args.manifestText : '';
      const stage = (text: string): ToolExecResponse => {
        try {
          return stagedResult(
            drafts.stageFromChat({
              name,
              description,
              manifestText: text,
              code,
              conversationId: options.conversationId ?? null,
              personaId: options.personaId ?? null,
              ...(targetId !== '' ? { id: targetId } : {}),
            }),
            update === null ? null : { installed: update.installed },
          );
        } catch {
          return { outcome: 'denied', reason: 'stage_failed' };
        }
      };

      let raw: unknown;
      if (manifestText.trim() !== '') {
        try {
          // The sanitiser takes the `{ manifest, code }` shape the generator
          // produces, so a model-written manifest is handed over the same way.
          raw = { manifest: JSON.parse(manifestText) as unknown, code };
        } catch {
          // A manifest that does not even parse is a problem the model must fix.
          // The text is staged as written so the draft exists (with "manifest is
          // not valid JSON" reported) and the NEXT call can fix it by id; nothing
          // can be installed from a draft that does not validate.
          return stage(manifestText);
        }
      } else {
        raw = { manifest: manifestFromTools(args, name, description), code };
      }

      // The ONE sanitiser (M26 D3): the clamped budget, the dropped-and-named
      // unknown tools, the refused network. The slug it forces is a best-effort
      // one for a NEW draft - the manager re-points the manifest at the id it
      // actually allocated, exactly as an imported bundle is re-pointed.
      const clean = normalizeAuthoredBundle(raw, {
        // For an UPDATE the id that must survive is the INSTALLED one (the
        // manager re-points the manifest anyway, but naming it here keeps the
        // sanitiser's own slug in step with the skill being changed).
        slug:
          slugifySkillId(update !== null ? update.installed.id : existingId !== '' ? existingId : name) ||
          'skill',
        toolIds: [...options.toolIds],
        capabilities,
      });
      if (!clean.ok) {
        // REFUSED, not silently trimmed: the sanitiser drops a tool the broker
        // does not have, so staging anyway would install a skill with LESS reach
        // than the model declared - and the model would never find out. Saying
        // no, with every reason, is the honest answer.
        return refusedResult(name, targetId === '' ? null : targetId, clean.errors);
      }
      return stage(clean.manifestText);
    },
  };
}
