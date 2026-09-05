/**
 * M11 F2 MCP wire contracts (PLAN-M11.md — slice 2).
 *
 * Model Context Protocol CLIENT only (server exposure stays a non-goal).
 * v1 transport: stdio (command + args). Each installed server is OFF until
 * the user enables it; tools/call is a USER-initiated action (a paired
 * session), never a persona auto-call in this slice.
 */
export interface McpServerSummary {
  id: string;
  name: string;
  /** 'stdio' only in this slice ('http' reserved). */
  transport: 'stdio';
  command: string;
  args: string[];
  /** Off until the user flips it — default-deny. */
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface McpServerInput {
  name: string;
  command: string;
  args?: string[];
  enabled?: boolean;
}

/** Partial update — only the given fields change. */
export interface McpServerUpdate {
  name?: string;
  command?: string;
  args?: string[];
  enabled?: boolean;
}

export interface McpToolInfo {
  /** Full tool name as MCP namespaces it (server.tool). */
  name: string;
  description?: string | null;
  /** JSON Schema input; may be null when the server declares none. */
  inputSchema?: unknown;
}

export interface McpCallInput {
  tool: string;
  args?: Record<string, unknown>;
  /** Optional timeout ms override (default 30_000). */
  timeoutMs?: number;
}

export interface McpCallResult {
  /** MCP content items (text/image/resource…). */
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
  isError: boolean;
  ms: number;
}
