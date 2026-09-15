/**
 * Chat image preparation — attach what the model will actually receive.
 *
 * Two jobs, one seam:
 *
 *  1. **HEIC/HEIF → JPEG.** That is what an iPhone camera writes, and almost
 *     nothing downstream reads it: the core's allowlist refuses it, the
 *     transcript cannot render it outside WebKit, and most providers cannot
 *     decode `image/heic` at all. iOS Safari usually transcodes on a file input
 *     — but a `.heic` from Files/iCloud, a macOS drag-and-drop, or any other
 *     browser arrives unconverted. The conversion happens HERE, on the device
 *     that has the codec.
 *  2. **Fitting the inline budget (M24).** The core stores files up to
 *     `maxUploadBytes` but only inlines an image up to `maxInlineImageBytes`.
 *     Encoding to the larger number produced photos that uploaded, thumbnailed,
 *     and were then silently dropped from the turn — the persona said "no image
 *     was sent" while the user could see it attached. Anything image-shaped and
 *     over the INLINE budget is re-encoded here until it fits, so the bytes that
 *     arrive are the bytes the model reads.
 *
 * Two consequences worth stating plainly:
 *  - the re-encode drops the original metadata, including GPS EXIF. Nothing is
 *    uploaded that the canvas did not re-draw.
 *  - the geometry is decided here (`fitWithin`), so a 48 MP photo is resized to
 *    a sane edge BEFORE either cap is consulted.
 */
import { attachmentTooLargeMessage, MAX_INLINE_IMAGE_BYTES } from '@partner/shared';

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
 * The quality/size ladder, tried in order until the result fits the budget. It
 * starts where the old three-rung ladder started (so a 12 MP iPhone photo keeps
 * its full 4032px edge and gives up quality first — a blurry photo is worse
 * than a slightly-compressed one) and now KEEPS GOING: the budget to hit is the
 * inline one (3 MB), which a 4096px q0.9 JPEG of a detailed scene can exceed,
 * and stopping early meant that photo was stored, thumbnailed, and never sent.
 * `MAX_EDGE` also stays inside the iOS canvas-area limit.
 */
const ATTEMPTS: ReadonlyArray<EncodeAttempt> = [
  { maxEdge: 4096, quality: 0.9 },
  { maxEdge: 4096, quality: 0.8 },
  { maxEdge: 3072, quality: 0.8 },
  { maxEdge: 2048, quality: 0.8 },
  { maxEdge: 2048, quality: 0.7 },
  { maxEdge: 1536, quality: 0.7 },
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

function unreadableMessage(name: string, heic: boolean): string {
  return heic
    ? `${name} could not be converted to JPEG — this browser cannot read HEIC. Save it as a JPEG first, or attach it from Safari.`
    : `${name} could not be resized to fit the image limit — this browser could not decode it. Try attaching a JPEG or PNG.`;
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
  return reEncodeToJpeg(file, cap, deps);
}

/**
 * Decode `file`, then re-encode it as JPEG trying each rung of the ladder until
 * the result fits `budget` (null = no budget: one good attempt).
 *
 * Exported as `convertToJpeg` for the HEIC path and used internally for any
 * over-budget image — the mechanics are identical, only the reason differs.
 */
async function reEncodeToJpeg(
  file: { name: string; size: number } & Blob,
  budget: number | null,
  deps: ConvertDeps = {},
): Promise<PreparedUpload> {
  const decode = deps.decode ?? decodeWithPlatform;
  const encode = deps.encode ?? encodeWithPlatform;
  let source: DecodedImage;
  try {
    source = await decode(file);
  } catch {
    throw new Error(unreadableMessage(file.name, isHeicLike(file)));
  }
  try {
    // With no stated budget there is nothing to fit: one good attempt.
    const attempts = budget === null ? ATTEMPTS.slice(0, 1) : ATTEMPTS;
    let smallest: Blob | null = null;
    for (const attempt of attempts) {
      const blob = await encode(source, attempt);
      if (budget === null || blob.size <= budget) {
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
    throw new Error(
      attachmentTooLargeMessage(budget as number, { name, size: smallest?.size ?? 0 }),
    );
  } finally {
    if (typeof ImageBitmap !== 'undefined' && source instanceof ImageBitmap) source.close();
  }
}

/** Is this the kind of file the model receives as an image part? */
export function isImageFile(file: { name: string; type: string }): boolean {
  const mime = file.type.trim().toLowerCase();
  if (mime.startsWith('image/')) return true;
  // Untyped downloads and some pickers hand over `""`/octet-stream; the
  // extension is the only signal left, and a mis-typed photo is common enough
  // to be worth catching (the core allowlists by declared mime, so a file that
  // is not really an image still cannot sneak through).
  return /\.(png|jpe?g|webp|gif|heic|heif)$/i.test(file.name.trim());
}

/**
 * What the composer should upload for one chosen file.
 *
 * Images that already fit the INLINE budget pass through untouched (a JPEG has
 * been through the camera's encoder; re-encoding it would only lose quality).
 * Everything image-shaped that does NOT fit is decoded and re-encoded until it
 * does — that is the only way the attached photo can ride to the model, and
 * silently uploading bytes the turn will drop is the bug this closes.
 *
 * HEIC is always converted (nothing downstream decodes it) and deliberately NOT
 * size-checked first: a 9 MB HEIC is a perfectly good photo that becomes a small
 * JPEG, so refusing it on size would refuse exactly the file this path exists
 * for.
 */
export async function prepareAttachmentForUpload(
  file: File,
  cap: number | null,
  deps: ConvertDeps = {},
  /**
   * M24: the core's inline image budget. Defaults to the shared constant so a
   * caller that never learned the server's value still produces sendable
   * photos; the composer passes `/v1/health`'s number when it has one.
   */
  inlineCap: number | null = MAX_INLINE_IMAGE_BYTES,
): Promise<PreparedUpload> {
  if (isHeicLike(file)) return reEncodeToJpeg(file, effectiveImageBudget(cap, inlineCap), deps);
  if (cap !== null && file.size > cap) {
    throw new Error(attachmentTooLargeMessage(cap, { name: file.name, size: file.size }));
  }
  const budget = effectiveImageBudget(cap, inlineCap);
  if (isImageFile(file) && budget !== null && file.size > budget) {
    // Not a refusal: the photo is real, it is just too heavy to ride. Shrink it
    // to the budget instead of storing a file the model will never be shown.
    return reEncodeToJpeg(file, budget, deps);
  }
  return {
    data: file,
    name: file.name,
    mime: file.type === '' ? 'application/octet-stream' : file.type,
    size: file.size,
    converted: false,
  };
}

/** The byte budget an image must fit: the tighter of store-cap and inline-cap. */
function effectiveImageBudget(cap: number | null, inlineCap: number | null): number | null {
  if (cap === null) return inlineCap;
  if (inlineCap === null) return cap;
  return Math.min(cap, inlineCap);
}
