/**
 * M11 F1 chat-attachment API client (PLAN-M11.md).
 *
 * Uploads POST the file's own bytes as the request body (content type = the
 * mime, `x-attachment-name` = the percent-encoded name, as JSON was the wrong
 * envelope: base64 inflated the payload by a third and put every upload under
 * the JSON body cap instead of the upload cap). Staged per conversation, and
 * bound server-side when /v1/chat names them. Payload bytes are fetched with
 * the Bearer token and turned into object URLs by consumers (thumbnails,
 * F12 preview); they are never inlined into URLs.
 */
import { ApiRequestError, expectJson, expectNoContent, type FetchLike } from './api.js';
import type { AttachmentMeta } from '@partner/shared';

export type { FetchLike };

export interface AttachmentUploadInput {
  name: string;
  mime: string;
  /** The payload as the request body — a File is a Blob, so it streams. */
  data: Blob;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseMeta(value: unknown, status = 200): AttachmentMeta {
  if (isRecord(value) && typeof value.id === 'string') return value as unknown as AttachmentMeta;
  throw new ApiRequestError(status, 'The attachment response had an unexpected shape.');
}

function parseMetaList(value: unknown, status = 200): AttachmentMeta[] {
  if (Array.isArray(value)) return value as AttachmentMeta[];
  if (isRecord(value) && Array.isArray(value.attachments)) {
    return value.attachments as unknown as AttachmentMeta[];
  }
  throw new ApiRequestError(status, 'The attachments response had an unexpected shape.');
}

const attachmentsPath = (conversationId: string): string =>
  `/v1/conversations/${encodeURIComponent(conversationId)}/attachments`;

/**
 * POST a staged upload. The caller passes the file itself (a `File` is a
 * `Blob`, so fetch streams it).
 *
 * The filename rides a header rather than the query string (or the body, which
 * is now the payload itself): a filename is user data, and user data in a URL
 * lands in history, referrers and access logs.
 */
export async function uploadAttachment(
  token: string,
  conversationId: string,
  input: AttachmentUploadInput,
  options: { fetchImpl?: FetchLike } = {},
): Promise<AttachmentMeta> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(attachmentsPath(conversationId), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': input.mime,
      'x-attachment-name': encodeURIComponent(input.name),
      accept: 'application/json',
    },
    body: input.data,
  });
  return parseMeta(await expectJson<unknown>(response), response.status);
}

/** All attachments for a conversation (staged + bound). */
export async function listAttachments(
  token: string,
  conversationId: string,
  options: { fetchImpl?: FetchLike } = {},
): Promise<AttachmentMeta[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(attachmentsPath(conversationId), {
    method: 'GET',
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
  });
  return parseMetaList(await expectJson<unknown>(response), response.status);
}

/** Remove a staged (or bound) attachment — blob garbage-collected by core. */
export async function deleteAttachment(
  token: string,
  conversationId: string,
  attachmentId: string,
  options: { fetchImpl?: FetchLike } = {},
): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(
    `${attachmentsPath(conversationId)}/${encodeURIComponent(attachmentId)}`,
    { method: 'DELETE', headers: { authorization: `Bearer ${token}` } },
  );
  return expectNoContent(response, 'Deleting the attachment');
}

/** Fetch attachment bytes with the session token (blob-safe). */
export async function fetchAttachmentContent(
  token: string,
  conversationId: string,
  attachmentId: string,
  options: { fetchImpl?: FetchLike } = {},
): Promise<{ mime: string; bytes: Uint8Array }> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(
    `${attachmentsPath(conversationId)}/${encodeURIComponent(attachmentId)}/content`,
    { method: 'GET', headers: { authorization: `Bearer ${token}` } },
  );
  if (!response.ok) {
    const message = await readErrorSafe(response);
    throw new ApiRequestError(response.status, message);
  }
  const mime = response.headers.get('content-type') ?? 'application/octet-stream';
  const bytes = new Uint8Array(await response.arrayBuffer());
  return { mime, bytes };
}

async function readErrorSafe(response: Response): Promise<string> {
  try {
    const text = await response.text();
    const parsed: unknown = JSON.parse(text);
    if (isRecord(parsed) && typeof parsed.message === 'string') return parsed.message;
    return text.slice(0, 200);
  } catch {
    return `Request failed (${response.status}).`;
  }
}

/**
 * R7: the attachment cap, read from the core's public /v1/health. The SPA uses
 * it to refuse an over-size file BEFORE spending the upload — a refusal that
 * arrives mid-upload can surface as a network error on a phone, not as the
 * server's message. `null` means "not stated" (an older core, or the request
 * failed): the upload proceeds and the server's own 413 answers.
 */
export async function fetchUploadLimit(
  options: { fetchImpl?: FetchLike } = {},
): Promise<number | null> {
  return (await fetchUploadCaps(options)).maxUploadBytes;
}

/**
 * M24: BOTH byte budgets the composer has to respect, from one /v1/health read.
 *
 * They are different numbers, and conflating them is a silent-data-loss bug:
 * `maxUploadBytes` is what the core will STORE, `maxInlineImageBytes` is what
 * can RIDE to the model. Fitting a phone photo to the upload cap produced a
 * 4 MB JPEG that stored fine, rendered a lovely thumbnail, and was then dropped
 * from the turn — so the persona answered "I didn't receive an image" while the
 * user could see the photo attached. The composer now encodes images to the
 * SMALLER budget, so what you attach is what the model sees.
 */
export interface UploadCaps {
  /** Largest file the core stores (null = not stated). */
  maxUploadBytes: number | null;
  /** Largest image the core inlines into a turn (null = not stated). */
  maxInlineImageBytes: number | null;
}

function positiveNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

export async function fetchUploadCaps(
  options: { fetchImpl?: FetchLike } = {},
): Promise<UploadCaps> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl('/v1/health', { headers: { accept: 'application/json' } });
  const body = await expectJson<unknown>(response);
  const record = isRecord(body) ? body : {};
  return {
    maxUploadBytes: positiveNumber(record.maxUploadBytes),
    maxInlineImageBytes: positiveNumber(record.maxInlineImageBytes),
  };
}
