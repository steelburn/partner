/**
 * Typed errors for the M4 memory surface (PLAN-M4.md).
 *
 * Codes map 1:1 onto loopback HTTP responses:
 *   invalid_input -> 400   (bad kind/status, empty value, malformed forget/import)
 *   not_found     -> 404   (unknown profile entry / episode / conversation)
 *   upstream      -> 502   (summarize provider stream failed)
 *
 * Messages are always safe to surface — memory content never crosses an
 * error message, audit row or log (lengths/ids only).
 */
export type MemoryErrorCode = 'invalid_input' | 'not_found' | 'upstream';

export class MemoryError extends Error {
  readonly code: MemoryErrorCode;

  constructor(code: MemoryErrorCode, message: string) {
    super(message);
    this.name = 'MemoryError';
    this.code = code;
  }
}

export function memoryError(code: MemoryErrorCode, message: string): MemoryError {
  return new MemoryError(code, message);
}

/** Loopback HTTP status for a MemoryError code. */
export function memoryErrorStatus(code: MemoryErrorCode): number {
  switch (code) {
    case 'not_found':
      return 404;
    case 'upstream':
      return 502;
    default:
      return 400;
  }
}
