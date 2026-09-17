/**
 * M11 F2 MCP as chat tools (PLAN-M11.md).
 *
 * Persona MCP auto-calls ride the tool-pass external seam: a tool id of the
 * form `mcp:<serverId>/<toolName>` is resolved DYNAMICALLY via `match` for
 * ENABLED servers (default-deny), gated like any medium-risk external tool
 * (auto+ personas), and executed through the MCP manager (one stdio session
 * per call, sandboxed + timed out server-side).
 *
 * The actor the call executes under is `persona` — the same label the tool pass
 * audits its own decisions under — so the manager's execution row does not read
 * as a web request the user made.
 */
import type { ToolExecResponse, ToolId, ToolManifest } from '@partner/shared/tools.js';
import type { McpManager } from './manager.js';
import { McpError } from './errors.js';

const TOOL_ID_RE = /^mcp:([^/]+)\/(.+)$/;

function makeManifest(toolName: string): ToolManifest {
  return {
    // External-only tool id — never enters the broker's files-only catalog.
    id: `mcp:server/${toolName}` as ToolId,
    description: `MCP tool: ${toolName}`,
    risk: 'medium',
    confirm: 'once',
    network: true,
    scope: { kind: 'project' },
  };
}

function parse(toolId: string): { serverId: string; tool: string } | null {
  const match = TOOL_ID_RE.exec(toolId);
  if (!match) return null;
  return { serverId: decodeURIComponent(match[1] ?? ''), tool: decodeURIComponent(match[2] ?? '') };
}

/** External chat-tool provider for a configured MCP manager (undefined when
 *  no manager is wired). */
export function mcpToolExternal(
  mcp: McpManager | undefined,
): {
  manifests: ReadonlyArray<ToolManifest>;
  allow(toolId: string): boolean;
  exec(toolId: string, args: Record<string, unknown>): Promise<ToolExecResponse>;
  match?(toolId: string): ToolManifest | undefined;
} | undefined {
  if (mcp === undefined) return undefined;
  const serverEnabled = (serverId: string): boolean => mcp.get(serverId)?.enabled === true;
  return {
    manifests: [],
    allow: (toolId: string): boolean => {
      const parts = parse(toolId);
      return parts !== null && serverEnabled(parts.serverId);
    },
    match: (toolId: string): ToolManifest | undefined => {
      const parts = parse(toolId);
      if (parts === null || !serverEnabled(parts.serverId)) return undefined;
      return makeManifest(parts.tool);
    },
    exec: async (toolId: string, args: Record<string, unknown>): Promise<ToolExecResponse> => {
      const parts = parse(toolId);
      if (parts === null) return { outcome: 'denied', reason: 'unknown_tool' };
      if (!serverEnabled(parts.serverId)) return { outcome: 'denied', reason: 'disabled' };
      try {
        const result = await mcp.call(parts.serverId, { tool: parts.tool, args: args ?? {} }, 'persona');
        // Flatten text content so the generic summarizer keeps it legible.
        const flat: Record<string, unknown> = { tool: parts.tool, server: parts.serverId };
        let textIndex = 0;
        for (const item of result.content) {
          if (item.type === 'text' && typeof item.text === 'string' && item.text !== '') {
            textIndex += 1;
            flat[`output_${textIndex}`] = item.text;
          }
        }
        if (textIndex === 0) return { outcome: 'denied', reason: 'empty_result' };
        return { outcome: 'executed', result: flat };
      } catch (err) {
        return {
          outcome: 'denied',
          reason: err instanceof McpError ? err.code : 'upstream',
        };
      }
    },
  };
}
