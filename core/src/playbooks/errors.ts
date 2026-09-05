/**
 * Typed errors for the M9 playbook + deploy surfaces (PLAN-M9.md).
 *
 * Codes map 1:1 onto loopback HTTP responses (mirrors M4/M5 errors):
 *   invalid_input -> 400   (bad profile fields, unknown playbook id shape)
 *   not_found     -> 404   (unknown playbook/run/profile)
 *   conflict      -> 409   (duplicate deploy profile name, not_decided resume)
 *   no_provider   -> 501   (tool loops REQUIRE a real provider — never demo)
 *
 * Messages are always safe to surface — playbook text, tool results and
 * note content never cross an error message, audit row or log.
 */
export type PlaybookErrorCode =
  | 'invalid_input'
  | 'not_found'
  | 'conflict'
  | 'no_provider'
  | 'persona_paused';

export class PlaybookError extends Error {
  readonly code: PlaybookErrorCode;

  constructor(code: PlaybookErrorCode, message: string) {
    super(message);
    this.name = 'PlaybookError';
    this.code = code;
  }
}

export function playbookError(code: PlaybookErrorCode, message: string): PlaybookError {
  return new PlaybookError(code, message);
}

/** Loopback HTTP status for a PlaybookError code. */
export function playbookErrorStatus(code: PlaybookErrorCode): number {
  switch (code) {
    case 'not_found':
      return 404;
    case 'conflict':
      return 409;
    case 'no_provider':
      return 501;
    case 'persona_paused':
      return 423;
    default:
      return 400;
  }
}
