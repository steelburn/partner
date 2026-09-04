/**
 * Typed errors for the M7 browser-scope surface (PLAN-M7.md).
 *
 * Codes map 1:1 onto loopback HTTP responses:
 *   invalid_input -> 400   (scope not in the SiteScope union, unparseable/
 *                           empty origin)
 *   not_found     -> 404   (mutation of a built-in hard-blocked origin — the
 *                           blocklist is immutable and cannot be configured)
 *
 * Messages never carry page content — origins are ids only (page text is the
 * owner's data and never reaches audit/logs/errors).
 */
export type BrowserErrorCode = 'invalid_input' | 'not_found';

export class BrowserError extends Error {
  readonly code: BrowserErrorCode;

  constructor(code: BrowserErrorCode, message: string) {
    super(message);
    this.name = 'BrowserError';
    this.code = code;
  }
}

export function browserError(code: BrowserErrorCode, message: string): BrowserError {
  return new BrowserError(code, message);
}

/** Loopback HTTP status for a BrowserError code. */
export function browserErrorStatus(code: BrowserErrorCode): number {
  switch (code) {
    case 'not_found':
      return 404;
    default:
      return 400;
  }
}
