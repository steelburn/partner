/**
 * Typed errors for the M11 F1 chat-attachment surface (PLAN-M11.md).
 *
 * Codes map 1:1 onto loopback HTTP responses:
 *   invalid_input -> 400  (missing name/mime/payload, empty)
 *   unsupported   -> 415  (mime/extension outside the allowlist)
 *   too_large     -> 413  (size cap)
 *   not_found     -> 404  (unknown attachment / staged in another conversation)
 */
export type AttachmentErrorCode = 'invalid_input' | 'unsupported' | 'too_large' | 'not_found';

export class AttachmentError extends Error {
  readonly code: AttachmentErrorCode;

  constructor(code: AttachmentErrorCode, message: string) {
    super(message);
    this.name = 'AttachmentError';
    this.code = code;
  }
}

export function attachmentError(code: AttachmentErrorCode, message: string): AttachmentError {
  return new AttachmentError(code, message);
}

/** Loopback HTTP status for an AttachmentError code. */
export function attachmentErrorStatus(code: AttachmentErrorCode): number {
  switch (code) {
    case 'unsupported':
      return 415;
    case 'too_large':
      return 413;
    case 'not_found':
      return 404;
    default:
      return 400;
  }
}
