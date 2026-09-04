/**
 * Typed errors for the M5 plans surface (PLAN-M5.md).
 *
 * Codes map 1:1 onto loopback HTTP responses (mirrors M4 memory errors):
 *   invalid_input -> 400   (bad title, malformed document/task status)
 *   not_found     -> 404   (unknown plan / milestone / task)
 *
 * Messages are always safe to surface — plan document CONTENT never crosses
 * an error message, audit row or log (ids and lengths only; validation
 * messages name the offending field path, never its value).
 */
export type PlanErrorCode = 'invalid_input' | 'not_found';

export class PlanError extends Error {
  readonly code: PlanErrorCode;

  constructor(code: PlanErrorCode, message: string) {
    super(message);
    this.name = 'PlanError';
    this.code = code;
  }
}

export function planError(code: PlanErrorCode, message: string): PlanError {
  return new PlanError(code, message);
}

/** Loopback HTTP status for a PlanError code. */
export function planErrorStatus(code: PlanErrorCode): number {
  return code === 'not_found' ? 404 : 400;
}
