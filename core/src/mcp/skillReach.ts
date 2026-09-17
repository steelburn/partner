/**
 * M27 S2 — MCP reach from the skill sandbox (PLAN-M27.md S2, decisions D5–D8).
 *
 * WHY THIS IS A SEAM AND NOT A BRANCH IN THE MANAGER: MCP is reachable today
 * only as a chat-side external tool (`mcp/tool.ts`), where the paired session IS
 * the user and a medium-risk tool request rides the approval queue. A SKILL is
 * not the user and cannot be asked anything (M8), so its access rules are
 * different in kind, not in degree: the declaration lives in the manifest, the
 * consent happened when the owner enabled the server, and every failure is a
 * CODE the skill can catch. Keeping that in one file is what lets
 * `core/src/skills/runner.ts` stay ignorant of MCP entirely — it takes a
 * `SkillMcpReach` and never imports `mcp/`.
 *
 * THE GATE ORDER IS THE CONTROL (mirrors `broker.exec`'s documented order):
 *
 *   1. **id shape** — is this an `mcp:<server>/<tool>` id at all?
 *   2. **class envelope** — `mcp.call` for the acting session's class. FIRST
 *      among the reach gates, exactly as the broker checks the envelope before
 *      params and before the root/grant: a session that may not call MCP must
 *      learn NOTHING about whether a server is declared, configured or enabled.
 *      Desktop keeps its reach; mobile and extension are allowlists that do not
 *      contain `mcp.call`, so a phone cannot reach an MCP server through a skill
 *      even if it somehow holds a grant.
 *   3. **declaration** — the server id must be in `permissions.mcpServers`
 *      (D5: servers, never tool names — a manifest cannot name a tool that does
 *      not exist yet, because servers are configured later).
 *   4. **ceiling** — the manifest must present as at least `medium` (D6). An MCP
 *      tool's own risk is unknowable in advance, so the owner consents to the
 *      worst case at install; the validator refuses a `low` manifest at DRAFT
 *      time, and this re-checks at run time because an installed manifest
 *      predating the rule must not become a loophole.
 *   5. **the server itself** — configured in this core and ENABLED. Enabling is
 *      the user's default-deny act, and it must have happened BEFORE the run:
 *      there is no pending row to leave behind (D8).
 *
 * ON D5's "the tool exists" CONDITION: this seam does NOT pre-flight
 * `tools/list` to predict it. A session opens per operation in the manager, so a
 * pre-flight would cost a SECOND spawn + handshake on every call and double the
 * failure surface, to guess an answer the server is about to give anyway — and
 * gives authoritatively: a name it does not serve comes back as a JSON-RPC
 * error, which this seam answers `upstream`. The consequence is deliberate and
 * worth knowing: a typo'd tool name and a broken server are the SAME code. The
 * alternative (a cached `listTools` per invocation) would mean threading
 * invocation state through the seam for a marginal gain in an error string.
 *
 * Audit discipline: the manager's own `mcp.call` row is the execution record
 * (ids/counts only), and this seam makes it name the truthful actor — `skill`,
 * never the `web` default that belongs to the user's session. Every DENIAL adds
 * ONE more row of its own, `mcp.call.denied` (server id + the code + the tool
 * id, nothing else). That row is load-bearing rather than noise: a denial is
 * exactly the event an audit asking "did this skill or phone try to reach MCP"
 * is looking for, and the invocation itself does NOT record it — the MCP
 * template catches the coded refusal, so `skill.invoke` says ok:true with
 * toolCalls:1, and a denial above the server lookup never reaches the manager's
 * own `mcp.call` row at all.
 */
import { capabilityDenial } from '../http/capabilities.js';
import type { ToolRisk } from '@partner/shared';
import type { AuditService } from '../services/redaction.js';
import type {
  SkillMcpDenialCode,
  SkillMcpOutcome,
  SkillMcpReach,
  SkillMcpRequest,
} from '../skills/runner.js';
import { McpError } from './errors.js';
import type { McpManager } from './manager.js';

/** The id shape a skill uses to reach one tool on one server. */
export const MCP_SKILL_TOOL_RE = /^mcp:([^/]+)\/(.+)$/;

/** `medium` is the floor an MCP-calling manifest must present (D6). */
const MCP_MIN_RISK: ToolRisk = 'medium';
const RISK_RANK: Record<ToolRisk, number> = { low: 0, medium: 1, high: 2 };

/** Percent-decoded, like the chat external: server and tool ids may be encoded. */
export function parseMcpToolId(
  toolId: string,
): { server: string; tool: string } | null {
  const match = MCP_SKILL_TOOL_RE.exec(toolId);
  if (!match) return null;
  const server = decodeURIComponent(match[1] ?? '').trim();
  const tool = decodeURIComponent(match[2] ?? '').trim();
  if (server === '' || tool === '') return null;
  return { server, tool };
}

/**
 * The MCP content a skill receives.
 *
 * Text items are flattened to `output_1…n` EXACTLY as the chat-side external
 * does, so one MCP server reads the same whichever surface called it. Non-text
 * items (images, resources) are NOT carried: they are large, and a skill cannot
 * meaningfully consume them — but they are COUNTED, so a result is never
 * silently thinner than the server sent.
 */
function toResult(words: {
  server: string;
  tool: string;
  ms: number;
  content: ReadonlyArray<{ type: string; text?: string }>;
}): Record<string, unknown> {
  const out: Record<string, unknown> = { server: words.server, tool: words.tool };
  let index = 0;
  let nonText = 0;
  for (const item of words.content) {
    if (item.type === 'text' && typeof item.text === 'string' && item.text !== '') {
      index += 1;
      out[`output_${index}`] = item.text;
    } else {
      nonText += 1;
    }
  }
  out.contentItems = words.content.length;
  if (nonText > 0) out.nonTextItems = nonText;
  out.ms = words.ms;
  return out;
}

/**
 * Build the seam over a manager. `undefined` is a legal manager: a build with no
 * MCP store still needs to recognise the id shape so the refusal is coded.
 *
 * `audit` is optional so a test can drive the seam bare; every core wires the
 * same `AuditService` the manager and the runner already write to.
 */
export function createMcpSkillReach(
  mcp: McpManager | undefined,
  audit?: AuditService,
): SkillMcpReach {
  /**
   * Answer one denial AND write its audit row. One row per refusal, ids and the
   * code ONLY — never the tool arguments, the server's command line or a secret
   * (the same rule the manager's `mcp.call` row follows).
   */
  const deny = (code: SkillMcpDenialCode, target: string, tool?: string): SkillMcpOutcome => {
    audit?.log('skill', 'mcp.call.denied', target, {
      code,
      ...(tool === undefined || tool === '' ? {} : { tool }),
    });
    return { ok: false, code };
  };

  return {
    matches: (toolId: string): boolean => MCP_SKILL_TOOL_RE.test(toolId),

    exec: async (request: SkillMcpRequest): Promise<SkillMcpOutcome> => {
      const parts = parseMcpToolId(request.toolId);
      // Gate 1: not an MCP id at all (an empty server or tool once decoded). The
      // row still names the id that was asked for — a tool id, never args.
      if (parts === null) return deny('tool_denied', request.toolId);

      // D7 — the envelope first, so a class that may not call MCP learns
      // nothing about what is declared or configured behind it.
      if (capabilityDenial(request.clientClass ?? 'desktop', 'mcp.call') !== null) {
        return deny('capability_denied', parts.server, parts.tool);
      }

      if (mcp === undefined) return deny('tool_denied', parts.server, parts.tool);

      if (!request.declaredServers.includes(parts.server)) {
        return deny('mcp_not_declared', parts.server, parts.tool);
      }

      // D6 — re-checked here as well as at validate time (an installed manifest
      // from before the rule must not be a loophole).
      if (RISK_RANK[request.manifestRisk] < RISK_RANK[MCP_MIN_RISK]) {
        return deny('tool_denied', parts.server, parts.tool);
      }

      const server = mcp.get(parts.server);
      if (server === null || !server.enabled) {
        return deny('mcp_disabled', parts.server, parts.tool);
      }

      try {
        // `skill` is this seam's actor: the call was decided by a skill, not by
        // the user's session, and the execution row must say so.
        const result = await mcp.call(
          parts.server,
          { tool: parts.tool, args: request.args ?? {} },
          'skill',
        );
        if (result.isError) return deny('upstream', parts.server, parts.tool);
        return {
          ok: true,
          result: toResult({
            server: parts.server,
            tool: parts.tool,
            ms: result.ms,
            content: result.content,
          }),
        };
      } catch (err) {
        // The manager already validated the server above, so a `disabled` here
        // is a race (the owner switched it off mid-call) and keeps its own code;
        // everything else — spawn, handshake, timeout, tool failure — is the
        // server's doing and answers `upstream`.
        if (err instanceof McpError && err.code === 'disabled') {
          return deny('mcp_disabled', parts.server, parts.tool);
        }
        return deny('upstream', parts.server, parts.tool);
      }
    },
  };
}
