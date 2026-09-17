/**
 * M11 F2 MCP manager (PLAN-M11.md — slice 2).
 *
 * Owns lifecycle rules a plain row store must not: naming validation,
 * default-deny (a created server is OFF until the user enables it),
 * enable/disable, removal, and per-invocation stdio sessions. Tools/call is
 * a USER-initiated action in this slice (the paired session is the user);
 * persona auto-calls arrive with the broker integration slice.
 *
 * Every sensitive action audits id/name only — never tool args or results
 * (owner data stays in the calling surface). The row's `actor` records WHO
 * asked: `web` for the user's paired session (the default), `skill` for a
 * skill reaching MCP through `./skillReach.js`, `persona` for a persona
 * auto-call through `./tool.js` — the labels `services/redaction.ts` lists.
 */
import { randomUUID } from 'node:crypto';
import type { McpCallInput, McpCallResult, McpServerInput, McpServerSummary, McpServerUpdate, McpToolInfo } from '@partner/shared';
import type { AuditService } from '../services/redaction.js';
import type { McpServerRow, McpServerStore } from '../stores/types.js';
import { createMcpStdioClient } from './client.js';
import { McpError, mcpError } from './errors.js';

const MAX_ARGS = 32;
const NAME_MAX = 120;
const COMMAND_MAX = 1000;

export interface McpManagerOptions {
  store: McpServerStore;
  audit: AuditService;
  now?: () => number;
}

export interface McpManager {
  list(): McpServerSummary[];
  get(id: string): McpServerSummary | null;
  create(input: McpServerInput): McpServerSummary;
  update(id: string, patch: McpServerUpdate): McpServerSummary;
  remove(id: string): void;
  /** Tool catalog for an ENABLED server (spawn + handshake + close). */
  listTools(id: string): Promise<McpToolInfo[]>;
  /**
   * One tool call on an ENABLED server.
   *
   * `actor` is the audit actor — WHO asked — and defaults to `web`, the user's
   * paired session. A caller that is not the user names itself: a skill's reach
   * is `skill`, a persona auto-call is `persona`. Without this the execution row
   * of a skill's reach read as a web request nobody made.
   */
  call(id: string, input: McpCallInput, actor?: string): Promise<McpCallResult>;
}

function toSummary(row: McpServerRow): McpServerSummary {
  return {
    id: row.id,
    name: row.name,
    transport: 'stdio',
    command: row.command,
    args: row.args === null ? [] : (JSON.parse(row.args) as string[]),
    enabled: row.enabled === 1,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function requireRow(store: McpServerStore, id: string): McpServerRow {
  const row = store.findById(id);
  if (!row) throw mcpError('not_found', 'MCP server not found');
  return row;
}

function requireEnabled(row: McpServerRow): McpServerRow {
  if (row.enabled !== 1) {
    throw mcpError('disabled', 'MCP server is disabled — enable it before use');
  }
  return row;
}

function normalizeName(raw: unknown): string {
  const name = typeof raw === 'string' ? raw.trim() : '';
  if (name === '') throw mcpError('invalid_input', 'name is required');
  return name.slice(0, NAME_MAX);
}

function normalizeCommand(raw: unknown): string {
  const command = typeof raw === 'string' ? raw.trim() : '';
  if (command === '') throw mcpError('invalid_input', 'command is required (stdio transport)');
  if (command.length > COMMAND_MAX) {
    throw mcpError('invalid_input', 'command is too long');
  }
  return command;
}

function normalizeArgs(raw: unknown): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw mcpError('invalid_input', 'args must be an array of strings');
  const args = raw.filter((entry): entry is string => typeof entry === 'string').slice(0, MAX_ARGS);
  return args;
}

export function createMcpManager(options: McpManagerOptions): McpManager {
  const { store, audit } = options;
  const now = options.now ?? Date.now;

  /** Open a session for an enabled server and always close it. */
  async function withSession<T>(
    id: string,
    run: (client: ReturnType<typeof createMcpStdioClient>) => Promise<T>,
  ): Promise<T> {
    const row = requireEnabled(requireRow(store, id));
    const summary = toSummary(row);
    const client = createMcpStdioClient({ command: summary.command, args: summary.args });
    try {
      return await run(client);
    } finally {
      try {
        client.close();
      } catch {
        // ignore close errors
      }
    }
  }

  function create(input: McpServerInput): McpServerSummary {
    const body = (input ?? {}) as McpServerInput;
    const name = normalizeName(body.name);
    const command = normalizeCommand(body.command);
    const args = normalizeArgs(body.args);
    const at = now();
    const id = randomUUID();
    const row: McpServerRow = {
      id,
      name,
      transport: 'stdio',
      command,
      args: args.length > 0 ? JSON.stringify(args) : null,
      // Default-deny: a fresh server is OFF until the user enables it.
      enabled: 0,
      createdAt: at,
      updatedAt: at,
    };
    store.insert(row);
    audit.log('web', 'mcp.create', id, { name, command });
    return toSummary(row);
  }

  function update(id: string, patch: McpServerUpdate): McpServerSummary {
    const row = requireRow(store, id);
    const body = (patch ?? {}) as McpServerUpdate;
    const rowPatch: { name?: string; command?: string; args?: string[] | null; enabled?: boolean; updatedAt: number } = {
      updatedAt: now(),
    };
    if (body.name !== undefined) rowPatch.name = normalizeName(body.name);
    if (body.command !== undefined) rowPatch.command = normalizeCommand(body.command);
    if (body.args !== undefined) rowPatch.args = normalizeArgs(body.args);
    if (body.enabled !== undefined) rowPatch.enabled = body.enabled === true;
    if (body.name !== undefined || body.command !== undefined || body.args !== undefined || body.enabled !== undefined) {
      store.update(id, rowPatch);
      audit.log('web', 'mcp.update', id, {
        name: rowPatch.name ?? row.name,
        enabled: rowPatch.enabled,
      });
    }
    return toSummary(store.findById(id) as McpServerRow);
  }

  function remove(id: string): void {
    requireRow(store, id);
    store.remove(id);
    audit.log('web', 'mcp.delete', id, {});
  }

  function list(): McpServerSummary[] {
    return store.list().map(toSummary);
  }

  function get(id: string): McpServerSummary | null {
    const row = store.findById(id);
    return row ? toSummary(row) : null;
  }

  async function listTools(id: string): Promise<McpToolInfo[]> {
    const tools = await withSession(id, async (client) => client.listTools());
    audit.log('web', 'mcp.tools', id, { count: tools.length });
    return tools;
  }

  async function call(id: string, input: McpCallInput, actor?: string): Promise<McpCallResult> {
    const body = (input ?? {}) as McpCallInput;
    if (typeof body.tool !== 'string' || body.tool.trim() === '') {
      throw mcpError('invalid_input', 'tool is required');
    }
    const timeoutMs =
      typeof body.timeoutMs === 'number' && Number.isFinite(body.timeoutMs)
        ? Math.min(Math.max(Math.round(body.timeoutMs), 1000), 120_000)
        : undefined;
    const result = await withSession(id, (client) =>
      client.callTool(body.tool.trim(), body.args ?? {}, timeoutMs),
    );
    audit.log(actor ?? 'web', 'mcp.call', id, {
      tool: body.tool,
      isError: result.isError,
      ms: result.ms,
      contentItems: result.content.length,
    });
    return result;
  }

  return { list, get, create, update, remove, listTools, call };
}
