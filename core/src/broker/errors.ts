/**
 * Typed errors for the M2 tool surface (broker, roots, grants, file tools).
 *
 * Codes map 1:1 onto loopback HTTP responses via {@link toolErrorStatus}:
 *   bad_params / outside_root / too_large -> 400
 *   unknown_tool / not_found            -> 404
 *   exists                               -> 409
 *   everything else (denied, need_grant, unknown_project, read_only,
 *   not_pending)                        -> 403
 *
 * Messages are always safe to surface: they never contain a provider key,
 * keychain material, a session token, file contents, or an Authorization
 * header. File content never crosses audit/logs — summaries only carry
 * lengths/counts (see files/tools.ts + broker/broker.ts).
 */
export type ToolErrorCode =
  | 'bad_params'
  | 'unknown_tool'
  | 'unknown_project'
  | 'need_grant'
  | 'not_found'
  | 'too_large'
  | 'outside_root'
  | 'denied'
  | 'read_only'
  | 'not_pending'
  | 'exists';

export class ToolError extends Error {
  readonly code: ToolErrorCode;

  constructor(code: ToolErrorCode, message: string) {
    super(message);
    this.name = 'ToolError';
    this.code = code;
  }
}

export function toolError(code: ToolErrorCode, message: string): ToolError {
  return new ToolError(code, message);
}

const BAD_REQUEST_CODES: ReadonlySet<string> = new Set([
  'bad_params',
  'outside_root',
  'too_large',
]);
const NOT_FOUND_CODES: ReadonlySet<string> = new Set(['unknown_tool', 'not_found']);

/** Loopback HTTP status for a ToolError code (see the header comment). */
export function toolErrorStatus(code: ToolErrorCode): number {
  if (BAD_REQUEST_CODES.has(code)) return 400;
  if (NOT_FOUND_CODES.has(code)) return 404;
  if (code === 'exists') return 409;
  return 403;
}
