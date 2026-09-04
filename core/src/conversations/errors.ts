/**
 * Typed errors for the M3 conversation surface (PLAN-M3.md).
 *
 * Codes map 1:1 onto loopback HTTP responses:
 *   invalid_input -> 400   (bad role, malformed body)
 *   not_found     -> 404   (unknown conversation, unknown bound persona)
 *
 * Messages are always safe to surface — never chat/file/secret content.
 */
export type ConversationErrorCode = 'invalid_input' | 'not_found';

export class ConversationError extends Error {
  readonly code: ConversationErrorCode;

  constructor(code: ConversationErrorCode, message: string) {
    super(message);
    this.name = 'ConversationError';
    this.code = code;
  }
}

export function conversationError(
  code: ConversationErrorCode,
  message: string,
): ConversationError {
  return new ConversationError(code, message);
}

/** Loopback HTTP status for a ConversationError code. */
export function conversationErrorStatus(code: ConversationErrorCode): number {
  return code === 'not_found' ? 404 : 400;
}
