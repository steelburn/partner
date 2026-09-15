/**
 * M11 F1 chat attachments manager (PLAN-M11.md).
 *
 * Uploads are staged per conversation (attachment row, message_id NULL),
 * validated against a mime/size allowlist, deduped by sha256 into chat_blobs
 * (payload bytes are owner data in the encrypted DB — never audit), then
 * bound to the persisted user turn when the next /v1/chat call names the
 * staged ids. Text-ish uploads get a capped extraction used to enrich the
 * model's context for that turn. Binary payloads are served back through the
 * conversation-scoped content route for thumbnails/preview (F12).
 *
 * Payloads arrive as BYTES (the request body), not base64: an envelope costs a
 * third more bytes and once forced every upload through the JSON body cap.
 */
import { randomUUID, createHash } from 'node:crypto';
import { attachmentTooLargeMessage, MAX_INLINE_IMAGE_BYTES } from '@partner/shared';
import type { AttachmentMeta } from '@partner/shared';
import type { AuditService } from '../services/redaction.js';
import type { AttachmentRow, AttachmentStore, ChatBlobRow, ChatBlobStore } from '../stores/types.js';
import { AttachmentError, attachmentError } from './errors.js';

export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
export const MAX_EXTRACT_CHARS = 6000;
/** Attachment rows bound to one message (turn) cap — protects context. */
export const MAX_ATTACHMENTS_PER_TURN = 12;

export type { AttachmentMeta };

export interface AttachmentContent {
  name: string;
  mime: string;
  size: number;
  data: Buffer;
}

export interface AttachmentManagerOptions {
  blobs: ChatBlobStore;
  attachments: AttachmentStore;
  audit: AuditService;
  now?: () => number;
  /**
   * R7: the per-attachment cap (default {@link MAX_ATTACHMENT_BYTES}). A hosted
   * deployment can tighten it without a code change — which is why it is an
   * option rather than only a constant. The HTTP layer sets the same number as
   * the upload route's body limit, so the cap a client is refused at and the
   * cap its 413 quotes are one value.
   */
  maxBytes?: number;
}

export interface AttachmentManager {
  /**
   * Stage one upload. `data` is the payload itself — the transport hands the
   * manager bytes, never a base64 envelope (see `shared/src/attachments.ts`).
   */
  upload(
    conversationId: string,
    input: { name: string; mime: string; data: Buffer },
  ): AttachmentMeta;
  list(conversationId: string): AttachmentMeta[];
  listByMessage(messageId: string): AttachmentMeta[];
  /** Bind staged uploads to a persisted message; unknown/mismatched -> error. */
  bindToMessage(conversationId: string, messageId: string, stagedIds: string[]): AttachmentMeta[];
  remove(conversationId: string, id: string): void;
  content(conversationId: string, id: string): AttachmentContent | null;
  /** Text context of a message's bound attachments (for upstream turns). */
  contextForMessage(messageId: string): string;
  /** Wire meta for rows bound to a message (history display). */
  metaForMessage(messageId: string): AttachmentMeta[];
}

const IMAGE_MIME: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
]);
/** Mimes whose bytes we may extract as UTF-8 text for model context. */
const TEXTISH: ReadonlySet<string> = new Set([
  'text/plain',
  'text/markdown',
  'text/html',
  'text/css',
  'text/csv',
  'application/json',
  'application/xml',
  'application/javascript',
  'text/javascript',
  'application/x-shellscript',
]);
/** Types accepted as opaque uploads (stored + listed; not extracted). */
const OPAQUE_MIME: ReadonlySet<string> = new Set(['application/pdf']);
/** Never accepted, whatever the declared mime says. */
const DANGEROUS_EXT = /\.(exe|com|bat|cmd|ps1|psm1|sh|msi|dll|so|dylib|app|scr|jar|pyc|vbs|jsx?|tsx?|wasm)$/i;

function toMeta(row: AttachmentRow): AttachmentMeta {
  const textish = row.extractText !== null;
  return {
    id: row.id,
    conversationId: row.conversationId,
    messageId: row.messageId,
    name: row.name,
    mime: row.mime,
    size: row.size,
    extractable: textish || IMAGE_MIME.has(row.mime),
    createdAt: row.createdAt,
  };
}

function cleanName(raw: unknown): string {
  const name = typeof raw === 'string' ? raw.trim().slice(0, 255) : '';
  if (name === '') throw attachmentError('invalid_input', 'attachment name is required');
  return name.replace(/[\\/]/g, '_');
}

function assertAllowed(mime: unknown, name: string): string {
  const kind = typeof mime === 'string' ? mime.trim().toLowerCase() : '';
  if (kind === '') throw attachmentError('invalid_input', 'attachment mime is required');
  if (kind.startsWith('image/heic') || kind.startsWith('image/heif')) {
    // The one refusal a phone user can actually hit. The SPA converts HEIC to
    // JPEG before uploading (lib/image-convert.ts); this answers a client that
    // did not — including "Safari already did it for me", which is why the
    // common case never sees this message.
    throw attachmentError(
      'unsupported',
      `${kind} is not supported — attach the photo as JPEG (Safari converts iPhone photos automatically)`,
    );
  }
  const ok =
    kind.startsWith('text/') ||
    IMAGE_MIME.has(kind) ||
    OPAQUE_MIME.has(kind) ||
    kind === 'application/octet-stream';
  if (!ok) {
    throw attachmentError(
      'unsupported',
      `attachments of type ${kind} are not supported — text, images and PDF are`,
    );
  }
  if (DANGEROUS_EXT.test(name)) {
    throw attachmentError('unsupported', `files named ${name} cannot be uploaded`);
  }
  return kind;
}

export function createAttachmentManager(
  options: AttachmentManagerOptions,
): AttachmentManager {
  const { blobs, attachments, audit } = options;
  const maxBytes = options.maxBytes ?? MAX_ATTACHMENT_BYTES;
  const now = options.now ?? Date.now;

  function upload(
    conversationId: string,
    input: { name: string; mime: string; data: Buffer },
  ): AttachmentMeta {
    const name = cleanName(input.name);
    const mime = assertAllowed(input.mime, name);
    if (!Buffer.isBuffer(input.data)) {
      throw attachmentError('invalid_input', 'attachment bytes are required');
    }
    const data = input.data;
    if (data.length === 0) {
      throw attachmentError('invalid_input', 'attachment is empty');
    }
    if (data.length > maxBytes) {
      // The HTTP parser refuses a body over the same cap first, so this fires
      // for in-process callers (tests, tools) and for any future transport
      // that forgets the limit — the invariant, not the wire path.
      throw attachmentError('too_large', attachmentTooLargeMessage(maxBytes, { name, size: data.length }));
    }
    const sha256 = createHash('sha256').update(data).digest('hex');
    if (blobs.find(sha256) === undefined) {
      const blob: ChatBlobRow = { sha256, mime, size: data.length, data, createdAt: now() };
      blobs.insert(blob);
    }
    const extractable =
      mime.startsWith('text/') || TEXTISH.has(mime) || mime === 'application/json';
    let extractText: string | null = null;
    if (extractable && mime !== 'text/html' && mime !== 'text/css') {
      // HTML/CSS are previewable but not read into the model context by
      // default (F12 previews them; content is usually markup noise).
      const text = data.toString('utf8');
      extractText = text.length > MAX_EXTRACT_CHARS ? text.slice(0, MAX_EXTRACT_CHARS) : text;
    }
    const at = now();
    const id = randomUUID();
    const row: AttachmentRow = {
      id,
      conversationId,
      messageId: null,
      kind: 'upload',
      name,
      mime,
      size: data.length,
      sha256,
      refRootId: null,
      refPath: null,
      extractText,
      createdAt: at,
    };
    attachments.insert(row);
    audit.log('web', 'attachment.upload', id, {
      conversationId,
      nameLength: name.length,
      mime,
      size: data.length,
    });
    return toMeta(row);
  }

  function list(conversationId: string): AttachmentMeta[] {
    return attachments.listByConversation(conversationId).map(toMeta);
  }

  function listByMessage(messageId: string): AttachmentMeta[] {
    return attachments.listByMessage(messageId).map(toMeta);
  }

  function bindToMessage(
    conversationId: string,
    messageId: string,
    stagedIds: string[],
  ): AttachmentMeta[] {
    const bound: AttachmentMeta[] = [];
    for (const stagedId of stagedIds.slice(0, MAX_ATTACHMENTS_PER_TURN)) {
      const row = attachments.findById(stagedId);
      if (!row || row.conversationId !== conversationId) {
        throw attachmentError('not_found', `attachment ${stagedId} was not staged in this conversation`);
      }
      if (row.messageId !== null) continue; // already bound — idempotent
      attachments.bind(stagedId, messageId);
      const updated = attachments.findById(stagedId);
      if (updated) bound.push(toMeta(updated));
    }
    audit.log('web', 'attachment.bind', conversationId, {
      messageId,
      count: bound.length,
    });
    return bound;
  }

  function remove(conversationId: string, id: string): void {
    const row = attachments.findById(id);
    if (!row || row.conversationId !== conversationId) {
      throw attachmentError('not_found', 'attachment not found');
    }
    const sha = attachments.remove(id)?.sha256 ?? null;
    if (sha !== null && blobs.referencing(sha) === 0) blobs.remove(sha);
    audit.log('web', 'attachment.delete', id, { conversationId });
  }

  function content(conversationId: string, id: string): AttachmentContent | null {
    const row = attachments.findById(id);
    if (!row || row.conversationId !== conversationId || row.sha256 === null) return null;
    const blob = blobs.find(row.sha256);
    if (!blob) return null;
    return { name: row.name, mime: row.mime, size: blob.size, data: blob.data };
  }

  function contextForMessage(messageId: string): string {
    const rows = attachments.listByMessage(messageId);
    const parts: string[] = [];
    for (const row of rows) {
      if (row.extractText !== null) {
        parts.push(`[Attachment ${row.name}]\n${row.extractText}`);
      } else if (IMAGE_MIME.has(row.mime)) {
        // M24: say OUT LOUD when the photo cannot ride to the model. The
        // inline budget is smaller than the upload cap, so an image used to
        // read identically either way — the turn looked like it had attached a
        // photo, the model was handed only this line, and it answered that no
        // image arrived. With the clause the persona can tell the user.
        parts.push(
          row.size > MAX_INLINE_IMAGE_BYTES
            ? `[Image attachment: ${row.name} (${row.mime}, ${row.size} bytes) — NOT sent: it is over the ${MAX_INLINE_IMAGE_BYTES} byte image limit for one message. Ask for a smaller or compressed copy.]`
            : `[Image attachment: ${row.name} (${row.mime}, ${row.size} bytes)]`,
        );
      } else {
        parts.push(`[Attachment: ${row.name} (${row.mime}, ${row.size} bytes)]`);
      }
    }
    return parts.length === 0 ? '' : parts.join('\n\n');
  }

  function metaForMessage(messageId: string): AttachmentMeta[] {
    return attachments.listByMessage(messageId).map(toMeta);
  }

  return { upload, list, listByMessage, bindToMessage, remove, content, contextForMessage, metaForMessage };
}
