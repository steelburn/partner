/**
 * M11 F2 MCP stdio client (PLAN-M11.md — slice 2).
 *
 * Minimal JSON-RPC 2.0 client over the MCP **stdio** transport
 * (newline-delimited JSON, per the MCP spec). Supports the calls a chat
 * tool-catalog needs: initialize handshake, tools/list, tools/call.
 * Guardrails: spawn timeout, per-call budget (kill), bounded output lines,
 * and the child is killed on completion/error — never left running.
 *
 * Child processes run with the user's privileges (like every local tool);
 * the user must have explicitly enabled the server before any call.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { McpCallResult, McpToolInfo } from '@partner/shared';
import { McpError, mcpError } from './errors.js';

export const DEFAULT_CALL_TIMEOUT_MS = 30_000;
export const HANDSHAKE_TIMEOUT_MS = 10_000;
export const MAX_PENDING = 64;
export const MAX_TEXT_LINES = 400;
export const MAX_TEXT_CHARS = 200_000;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
}

export interface McpStdioClient {
  close(): void;
  listTools(): Promise<McpToolInfo[]>;
  callTool(tool: string, args: Record<string, unknown> | undefined, timeoutMs?: number): Promise<McpCallResult>;
}
interface RawMessage {
  id?: number | string;
  jsonrpc: string;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

export function createMcpStdioClient(options: {
  command: string;
  args?: string[];
  timeoutMs?: number;
}): McpStdioClient {
  const child: ChildProcessWithoutNullStreams = spawn(options.command, options.args ?? [], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let nextId = 1;
  const pending = new Map<number | string, PendingRequest>();
  let stderrTail = '';
  let closed = false;

  const failAll = (reason: Error): void => {
    for (const [, entry] of pending) {
      clearTimeout(entry.timer);
      entry.reject(reason);
    }
    pending.clear();
  };

  child.on('error', (err) => {
    closed = true;
    failAll(mcpError('upstream', `could not start MCP server: ${err.message}`));
  });
  child.on('exit', (code, signal) => {
    closed = true;
    const reason = mcpError(
      'upstream',
      `MCP server exited unexpectedly (code=${code ?? 'null'}, signal=${signal ?? 'null'})`,
    );
    failAll(reason);
  });
  child.stderr.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf8');
    stderrTail = (stderrTail + text).slice(-2000);
  });

  let buffer = '';
  let initPromise: Promise<void> | null = null;

  /** MCP requires an initialize request + initialized notification first. */
  function ensureInit(): Promise<void> {
    if (initPromise !== null) return initPromise;
    initPromise = (async () => {
      await request<unknown>(
        'initialize',
        {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'partner-core', version: '0.1.0' },
        },
        HANDSHAKE_TIMEOUT_MS,
      );
      if (!closed) {
        child.stdin.write(
          `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
        );
      }
    })();
    return initPromise;
  }
  child.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line !== '') {
        try {
          handleMessage(JSON.parse(line) as RawMessage);
        } catch {
          // Malformed frames from the server are ignored (never crash us).
        }
      }
      newline = buffer.indexOf('\n');
    }
  });

  function handleMessage(message: RawMessage): void {
    if (message.id === undefined || message.id === null) return; // server push — ignore in v1
    const entry = pending.get(message.id);
    if (!entry) return;
    clearTimeout(entry.timer);
    pending.delete(message.id);
    if (message.error !== undefined && message.error !== null) {
      entry.reject(
        mcpError('upstream', `MCP server error: ${message.error.message ?? 'unknown'}`),
      );
      return;
    }
    entry.resolve(message.result);
  }

  function request<T>(method: string, params: unknown, timeoutMs: number): Promise<T> {
    if (closed) {
      return Promise.reject(mcpError('upstream', 'MCP server is not running'));
    }
    if (pending.size >= MAX_PENDING) {
      return Promise.reject(mcpError('upstream', 'too many in-flight MCP requests'));
    }
    const id = nextId;
    nextId += 1;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(mcpError('timeout', `MCP request ${method} timed out`));
        // A hung server should not linger: tear the child down.
        closeChild();
      }, timeoutMs);
      pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  function closeChild(): void {
    if (closed) return;
    closed = true;
    try {
      child.stdin.end();
    } catch {
      // already closed
    }
    const killer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // already gone
      }
    }, 1500);
    killer.unref();
  }

  function client(): McpStdioClient {
    return {
      close(): void {
        closeChild();
        failAll(mcpError('upstream', 'MCP client closed'));
      },
      async listTools(): Promise<McpToolInfo[]> {
        await ensureInit();
        const result = await request<{ tools?: Array<{ name: string; description?: string; inputSchema?: unknown }> }>(
          'tools/list',
          {},
          HANDSHAKE_TIMEOUT_MS,
        );
        const tools = result?.tools ?? [];
        return tools.map((entry) => {
          const tool = entry as { name: string; description?: string; inputSchema?: unknown };
          return {
            name: tool.name,
            description: tool.description ?? null,
            inputSchema: tool.inputSchema ?? undefined,
          };
        });
      },
      async callTool(tool, args, timeoutMs): Promise<McpCallResult> {
        await ensureInit();
        const started = Date.now();
        const result = await request<{ content?: unknown; isError?: boolean }>(
          'tools/call',
          { name: tool, arguments: args ?? {} },
          timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS,
        );
        const contentRaw = Array.isArray(result?.content) ? result.content : [];
        const content = (contentRaw as Array<{ type?: string; text?: string; data?: string; mimeType?: string }>).map((entry) => {
          const item = entry as { type?: string; text?: string; data?: string; mimeType?: string };
          if (item.type === 'text' && typeof item.text === 'string') {
            let text = item.text;
            const lines = text.split('\n');
            if (lines.length > MAX_TEXT_LINES) {
              text = `${lines.slice(0, MAX_TEXT_LINES).join('\n')}\n… (truncated)`;
            }
            if (text.length > MAX_TEXT_CHARS) text = `${text.slice(0, MAX_TEXT_CHARS)}…`;
            return { type: 'text', text };
          }
          return {
            type: item.type ?? 'unknown',
            ...(typeof item.text === 'string' ? { text: item.text } : {}),
            ...(typeof item.data === 'string' ? { data: item.data } : {}),
            ...(typeof item.mimeType === 'string' ? { mimeType: item.mimeType } : {}),
          };
        });
        return {
          content,
          isError: result?.isError === true,
          ms: Date.now() - started,
        };
      },
    };
  }

  void randomUUID;
  void stderrTail;
  return client();
}

/** True when a spawn error message suggests the command is missing. */
export function isMissingCommandError(err: McpError): boolean {
  return err.code === 'upstream' && /could not start/.test(err.message);
}
