/**
 * R7 follow-up — attach iPhone photos as JPEG.
 *
 * HEIC/HEIF is what an iPhone camera writes, but almost nothing downstream can
 * read it: the core's allowlist refuses it, the transcript preview cannot
 * render it outside WebKit, and most model providers cannot decode
 * `image/heic` at all. iOS Safari usually transcodes on a file input, which is
 * why the common case appeared to work — but a `.heic` from Files/iCloud, a
 * drag-and-drop on macOS, or any other browser arrives unconverted.
 *
 * So the CONVERSION happens here, on the device that has the codec: the photo
 * is decoded through the platform image pipeline (WebKit reads HEIC), drawn to
 * a canvas and re-encoded as JPEG. Only the JPEG is ever uploaded.
 *
 * Two consequences worth stating plainly:
 *  - the re-encode drops the original metadata, including GPS EXIF. Nothing is
 *    uploaded that the canvas did not re-draw.
 *  - the geometry is decided here (`fitWithin`), so a 48 MP photo is resized to
 *    a sane edge BEFORE the upload cap is consulted, and the cap is then
 *    enforced on the bytes actually produced.
 */
import { attachmentTooLargeMessage } from '@partner/shared';

/** A decoded source: `createImageBitmap` output, or an `<img>` fallback. */
export type DecodedImage = ImageBitmap | HTMLImageElement;

export interface PreparedUpload {
  data: Blob;
  name: string;
  mime: string;
  size: number;
  /** True when the bytes were re-encoded (HEIC/HEIF → JPEG). */
  converted: boolean;
}

/** Injectable seam so the pipeline is testable without a canvas. */
export interface ConvertDeps {
  decode?: (file: Blob) => Promise<DecodedImage>;
  encode?: (source: DecodedImage, attempt: EncodeAttempt) => Promise<Blob>;
}

export interface EncodeAttempt {
  /** Longest edge of the result, in pixels. Never upscales. */
  maxEdge: number;
  /** JPEG quality, 0–1. */
  quality: number;
}

/**
 * The quality/size ladder, tried in order until the result fits the cap. The
 * first two attempts keep the full 4096px edge (iPhone 12 MP is 4032px, so it
 * is NOT resized) and give up quality first; only the third trades resolution,
 * because a blurry photo is worse than a slightly-compressed one. `MAX_EDGE`
 * also stays inside the iOS canvas-area limit.
 */
const ATTEMPTS: ReadonlyArray<EncodeAttempt> = [
  { maxEdge: 4096, quality: 0.9 },
  { maxEdge: 4096, quality: 0.75 },
  { maxEdge: 2560, quality: 0.75 },
];

const HEIC_TYPES: ReadonlySet<string> = new Set([
  'image/heic',
  'image/heif',
  'image/heic-sequence',
  'image/heif-sequence',
]);

/**
 * Is this the raw iPhone format? Checked by mime AND extension: a `.heic` from
 * some sources arrives as `application/octet-stream` or with an empty type, and
 * a mime-less file would otherwise be uploaded as an opaque binary.
 */
export function isHeicLike(file: { name: string; type: string }): boolean {
  const mime = file.type.trim().toLowerCase();
  if (HEIC_TYPES.has(mime)) return true;
  const name = file.name.trim().toLowerCase();
  return name.endsWith('.heic') || name.endsWith('.heif');
}

/** `IMG_0001.HEIC` → `IMG_0001.jpg` (and never `IMG_0001.HEIC.jpg`). */
export function jpegName(name: string): string {
  const trimmed = name.trim() === '' ? 'photo' : name.trim();
  const withoutExtension = trimmed.replace(/\.(heic|heif)$/i, '');
  return `${withoutExtension === '' ? 'photo' : withoutExtension}.jpg`;
}

/**
 * Fit `width`×`height` inside `maxEdge` on its longest side, preserving the
 * aspect ratio and never upscaling (a 400px photo stays 400px — re-encoding it
 * larger would only add bytes). Exported and unit-tested because this is the
 * arithmetic that decides what the user's photo becomes.
 */
export function fitWithin(
  width: number,
  height: number,
  maxEdge: number,
): { width: number; height: number } {
  const longest = Math.max(width, height);
  const scale = longest > maxEdge ? maxEdge / longest : 1;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

function sizeOf(source: DecodedImage): { width: number; height: number } {
  if (typeof ImageBitmap !== 'undefined' && source instanceof ImageBitmap) {
    return { width: source.width, height: source.height };
  }
  const img = source as HTMLImageElement;
  return {
    width: img.naturalWidth || img.width,
    height: img.naturalHeight || img.height,
  };
}

/**
 * Decode through the platform pipeline. `createImageBitmap` is preferred (it
 * can be told to honour EXIF orientation and keeps the bitmap off the DOM);
 * `imageOrientation: 'from-image'` is the default in current browsers, and the
 * `<img>` fallback honours EXIF through `image-orientation: from-image`, which
 * is why a portrait photo does not arrive rotated.
 */
async function decodeWithPlatform(file: Blob): Promise<DecodedImage> {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
      // Not decodable as a bitmap (older WebKit, or a format the platform
      // genuinely does not read) — try the `<img>` path before giving up.
    }
  }
  const url = URL.createObjectURL(file);
  const image = new Image();
  try {
    image.src = url;
    if (typeof image.decode === 'function') await image.decode();
    else
      await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () => reject(new Error('image decode failed'));
      });
    return image;
  } finally {
    // The bitmap is decoded into memory by now, so the URL is no longer needed.
    URL.revokeObjectURL(url);
  }
}

/** Draw the decoded photo at the requested edge and re-encode it as JPEG. */
async function encodeWithPlatform(source: DecodedImage, attempt: EncodeAttempt): Promise<Blob> {
  const { width, height } = sizeOf(source);
  const target = fitWithin(width, height, attempt.maxEdge);
  const canvas = document.createElement('canvas');
  canvas.width = target.width;
  canvas.height = target.height;
  const context = canvas.getContext('2d');
  if (context === null) throw new Error('no 2d context');
  // JPEG has no alpha channel: whatever is not painted turns black, so the
  // surface starts white (HEIC photos are opaque, but a transparent source
  // would otherwise arrive with black corners).
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, target.width, target.height);
  context.drawImage(source, 0, 0, target.width, target.height);
  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, 'image/jpeg', attempt.quality);
  });
  if (blob === null) throw new Error('jpeg encode failed');
  return blob;
}

function unreadableMessage(name: string): string {
  return `${name} could not be converted to JPEG — this browser cannot read HEIC. Save it as a JPEG first, or attach it from Safari.`;
}

/**
 * Convert a HEIC/HEIF photo to JPEG, trying the ladder until the bytes fit
 * `cap`. Throws with user-ready copy when the platform cannot decode the file
 * or when even the smallest attempt is over the cap.
 */
export async function convertToJpeg(
  file: { name: string; size: number } & Blob,
  cap: number | null,
  deps: ConvertDeps = {},
): Promise<PreparedUpload> {
  const decode = deps.decode ?? decodeWithPlatform;
  const encode = deps.encode ?? encodeWithPlatform;
  let source: DecodedImage;
  try {
    source = await decode(file);
  } catch {
    throw new Error(unreadableMessage(file.name));
  }
  try {
    // With no stated cap there is nothing to fit: one good attempt.
    const attempts = cap === null ? ATTEMPTS.slice(0, 1) : ATTEMPTS;
    let smallest: Blob | null = null;
    for (const attempt of attempts) {
      const blob = await encode(source, attempt);
      if (cap === null || blob.size <= cap) {
        return {
          data: blob,
          name: jpegName(file.name),
          mime: 'image/jpeg',
          size: blob.size,
          converted: true,
        };
      }
      if (smallest === null || blob.size < smallest.size) smallest = blob;
    }
    const name = jpegName(file.name);
    throw new Error(attachmentTooLargeMessage(cap as number, { name, size: smallest?.size ?? 0 }));
  } finally {
    if (typeof ImageBitmap !== 'undefined' && source instanceof ImageBitmap) source.close();
  }
}

/**
 * What the composer should upload for one chosen file.
 *
 * NON-HEIC files pass through untouched (a JPEG has already been through the
 * camera's encoder; re-encoding it would only lose quality), and the cap is
 * checked against the real byte count. HEIC files are converted first — and
 * deliberately NOT size-checked first: a 9 MB HEIC is a perfectly good photo
 * that becomes a 2 MB JPEG, so refusing it on size would refuse exactly the
 * file this whole path exists for.
 */
export async function prepareAttachmentForUpload(
  file: File,
  cap: number | null,
  deps: ConvertDeps = {},
): Promise<PreparedUpload> {
  if (isHeicLike(file)) return convertToJpeg(file, cap, deps);
  if (cap !== null && file.size > cap) {
    throw new Error(attachmentTooLargeMessage(cap, { name: file.name, size: file.size }));
  }
  return {
    data: file,
    name: file.name,
    mime: file.type === '' ? 'application/octet-stream' : file.type,
    size: file.size,
    converted: false,
  };
}
