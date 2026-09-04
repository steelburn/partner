/**
 * Typed errors for the M3 persona surface (PLAN-M3.md).
 *
 * Codes map 1:1 onto loopback HTTP responses:
 *   invalid_input -> 400
 *   not_found     -> 404
 *   conflict      -> 409   (default persona cannot be removed while it holds
 *                           the last isDefault flag — move it first)
 *
 * A paused persona is NOT an error of this class at the manager level: chat
 * (and later tool intent) refuses it with 423 persona_paused at the ROUTE,
 * because pausing is legal state, not a failed operation.
 *
 * Messages are always safe to surface — never file/system/secret content.
 */
export type PersonaErrorCode = 'invalid_input' | 'not_found' | 'conflict';

export class PersonaError extends Error {
  readonly code: PersonaErrorCode;

  constructor(code: PersonaErrorCode, message: string) {
    super(message);
    this.name = 'PersonaError';
    this.code = code;
  }
}

export function personaError(code: PersonaErrorCode, message: string): PersonaError {
  return new PersonaError(code, message);
}

/** Loopback HTTP status for a PersonaError code. */
export function personaErrorStatus(code: PersonaErrorCode): number {
  switch (code) {
    case 'invalid_input':
      return 400;
    case 'not_found':
      return 404;
    case 'conflict':
      return 409;
  }
}
