/**
 * M11 F1 chat attachments module (PLAN-M11.md).
 *
 * Staged uploads -> bound message turns, blob-backed payloads, conversation-
 * scoped content reads (F12 preview), and capped text extraction for model
 * context. Tables + row stores live in core/src/stores (schema v12).
 */
export { createAttachmentManager, MAX_ATTACHMENT_BYTES, MAX_EXTRACT_CHARS } from './manager.js';
export type { AttachmentManager, AttachmentManagerOptions, AttachmentMeta, AttachmentContent } from './manager.js';
export { AttachmentError, attachmentError, attachmentErrorStatus } from './errors.js';
export type { AttachmentErrorCode } from './errors.js';
