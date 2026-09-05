/**
 * M11 F2 MCP module (PLAN-M11.md — slice 2).
 *
 * Stdio client (JSON-RPC 2.0 over newline-delimited stdio), default-deny
 * server config, per-invocation sessions. Table + row store live in
 * core/src/stores (schema v12).
 */
export { createMcpStdioClient, DEFAULT_CALL_TIMEOUT_MS } from './client.js';
export type { McpStdioClient } from './client.js';
export { createMcpManager } from './manager.js';
export type { McpManager, McpManagerOptions } from './manager.js';
export { McpError, mcpError, mcpErrorStatus } from './errors.js';
export type { McpErrorCode } from './errors.js';
