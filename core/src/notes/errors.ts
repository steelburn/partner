/**
 * Typed errors for the M5 notes surface (PLAN-M5.md).
 *
 * Codes map 1:1 onto loopback HTTP responses (mirrors M4 memory errors):
 *   invalid_input    -> 400   (empty title/text, non-string content, bad tags)
 *   folder_not_found -> 400   (M17: unknown project/folder on scope/assignment)
 *   not_found        -> 404   (unknown note id)
 *   upstream         -> 502   (daily-summarize provider stream failed)
 *
 * Messages are always safe to surface — note/plan CONTENT never crosses an
 * error message, audit row or log (ids and lengths only).
 */
export type NoteErrorCode = 'invalid_input' | 'folder_not_found' | 'not_found' | 'upstream';

export class NoteError extends Error {
  readonly code: NoteErrorCode;

  constructor(code: NoteErrorCode, message: string) {
    super(message);
    this.name = 'NoteError';
    this.code = code;
  }
}

export function noteError(code: NoteErrorCode, message: string): NoteError {
  return new NoteError(code, message);
}

/** Loopback HTTP status for a NoteError code. */
export function noteErrorStatus(code: NoteErrorCode): number {
  switch (code) {
    case 'not_found':
      return 404;
    case 'upstream':
      return 502;
    default:
      // invalid_input + M17 folder_not_found both map to 400.
      return 400;
  }
}
