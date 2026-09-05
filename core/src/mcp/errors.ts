/**
 * Typed errors for the M11 F2 MCP surface (PLAN-M11.md — slice 2).
 *
 * Codes map 1:1 onto loopback HTTP responses:
 *   invalid_input -> 400
 *   not_found     -> 404  (unknown/disabled server)
 *   not_configured-> 501? (route-level, not an error class)
 *   disabled      -> 409  (server exists but is OFF — enable first)
 *   transport     -> 400  (only stdio in this slice)
 *   upstream      -> 502  (spawn/handshake/tool failure from the server)
 *   timeout       -> 504  (tool call exceeded its budget)
 */
export type McpErrorCode =
  | 'invalid_input'
  | 'not_found'
  | 'disabled'
  | 'transport'
  | 'upstream'
  | 'timeout';

export class McpError extends Error {
  readonly code: McpErrorCode;

  constructor(code: McpErrorCode, message: string) {
    super(message);
    this.name = 'McpError';
    this.code = code;
  }
}

export function mcpError(code: McpErrorCode, message: string): McpError {
  return new McpError(code, message);
}

export function mcpErrorStatus(code: McpErrorCode): number {
  switch (code) {
    case 'not_found':
      return 404;
    case 'disabled':
      return 409;
    case 'transport':
      return 400;
    case 'upstream':
      return 502;
    case 'timeout':
      return 504;
    default:
      return 400;
  }
}
