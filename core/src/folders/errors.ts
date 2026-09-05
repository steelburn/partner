/**
 * Typed errors for the M11 F11 folder surface (PLAN-M11.md).
 *
 * Codes map 1:1 onto loopback HTTP responses:
 *   invalid_input -> 400   (blank/overlong name)
 *   not_found     -> 404   (unknown folder / unknown parent)
 *   cycle         -> 409   (a folder cannot be its own parent or ancestor)
 *   too_deep      -> 409   (nesting bound exceeded)
 *
 * Messages are always safe to surface — never chat/file/secret content.
 */
export type FolderErrorCode = 'invalid_input' | 'not_found' | 'cycle' | 'too_deep';

export class FolderError extends Error {
  readonly code: FolderErrorCode;

  constructor(code: FolderErrorCode, message: string) {
    super(message);
    this.name = 'FolderError';
    this.code = code;
  }
}

export function folderError(code: FolderErrorCode, message: string): FolderError {
  return new FolderError(code, message);
}

/** Loopback HTTP status for a FolderError code. */
export function folderErrorStatus(code: FolderErrorCode): number {
  switch (code) {
    case 'not_found':
      return 404;
    case 'cycle':
    case 'too_deep':
      return 409;
    default:
      return 400;
  }
}
