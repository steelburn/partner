/**
 * M11 F1 chat-attachment wire contracts (PLAN-M11.md).
 *
 * Meta only — payload bytes never cross the API except through the
 * conversation-scoped /content route (also used by F12 preview).
 *
 * Upload bytes ride the request body itself (content type = the file's mime,
 * `x-attachment-name` = the percent-encoded name); they are NOT base64 in a
 * JSON envelope. That distinction is load-bearing: the JSON envelope inflated
 * the bytes by a third and inherited the JSON body cap, so a 1 MiB default
 * capped real uploads at ~768 KiB however `MAX_UPLOAD_BYTES` was set.
 */
export interface AttachmentMeta {
  id: string;
  conversationId: string;
  /** Null while staged (uploaded; the next turn has not been sent). */
  messageId: string | null;
  name: string;
  mime: string;
  size: number;
  /** True when text was extracted (model context) or the type is an image. */
  extractable: boolean;
  createdAt: number;
}

/**
 * Human byte size for a cap or a file: "8 MB", "1.5 MB", "512 KB",
 * "64 bytes".
 *
 * `rounding` exists so a size and a cap cannot contradict each other inside one
 * sentence. A refusal says "<file> is <size> — the limit is <cap> per file",
 * and the file that triggered it is always LARGER than the cap; rendering both
 * to the nearest tenth made an 8 MiB + 1 byte refusal read "8.0 MB … limit
 * 8.0 MB", which looks like a bug rather than a limit. So a refused file
 * rounds UP (never understate what was refused) and a cap rounds DOWN (never
 * promise room the core will refuse) — the displayed file always exceeds the
 * displayed cap, and exact values stay clean (8 MiB → "8 MB" either way).
 */
export function describeBytes(bytes: number, rounding: 'up' | 'down' = 'down'): string {
  const tenth = (value: number, unit: string): string => {
    const scaled = rounding === 'up' ? Math.ceil(value * 10) : Math.floor(value * 10);
    const rounded = scaled / 10;
    return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)} ${unit}`;
  };
  const mb = bytes / (1024 * 1024);
  if (mb >= 1) return tenth(mb, 'MB');
  const kb = bytes / 1024;
  if (kb >= 1) return tenth(kb, 'KB');
  return `${bytes} bytes`;
}

/**
 * The one sentence both halves use when a file is over the cap: the SPA shows
 * it before spending the upload, and the core returns the same words in its
 * 413. `file` is omitted only when the request failed before the name was
 * known (a body over the parser limit still knows `content-length`, but the
 * name header is optional).
 */
export function attachmentTooLargeMessage(
  cap: number,
  file?: { name: string; size: number } | null,
): string {
  const limit = `the limit is ${describeBytes(cap)} per file`;
  if (file) return `${file.name} is ${describeBytes(file.size, 'up')} — ${limit}.`;
  return `That file is too large — ${limit}.`;
}
