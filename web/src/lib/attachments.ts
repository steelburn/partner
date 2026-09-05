/**
 * M11 F1 chat-attachment API client (PLAN-M11.md).
 *
 * Uploads are base64 JSON (no multipart dep), staged per conversation, and
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
  dataBase64: string;
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

/** POST a staged upload. The caller reads the file to base64 first. */
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
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify(input),
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

/** Read a File to raw base64 (no data: prefix) for uploadAttachment. */
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the file.'));
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.readAsDataURL(file);
  });
}
