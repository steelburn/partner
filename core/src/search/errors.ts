/**
 * Typed errors for the M11 F2 search surface (PLAN-M11.md).
 *
 * Codes map 1:1 onto loopback HTTP responses:
 *   invalid_input -> 400
 *   disabled      -> 409  (backend not enabled / no key stored)
 *   upstream      -> 502
 *   timeout       -> 504
 */
export type SearchErrorCode = 'invalid_input' | 'disabled' | 'upstream' | 'timeout';

export class SearchError extends Error {
  readonly code: SearchErrorCode;

  constructor(code: SearchErrorCode, message: string) {
    super(message);
    this.name = 'SearchError';
    this.code = code;
  }
}

export function searchError(code: SearchErrorCode, message: string): SearchError {
  return new SearchError(code, message);
}

export function searchErrorStatus(code: SearchErrorCode): number {
  switch (code) {
    case 'disabled':
      return 409;
    case 'upstream':
      return 502;
    case 'timeout':
      return 504;
    default:
      return 400;
  }
}
