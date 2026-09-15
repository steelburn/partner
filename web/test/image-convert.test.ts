/**
 * R7 follow-up — iPhone HEIC photos are converted to JPEG before upload.
 *
 * The canvas work itself needs a browser (and a HEIC decoder, which only WebKit
 * has), so the pipeline takes its decode/encode as injectable seams: everything
 * that DECIDES something — is this HEIC, what does the photo become, does it
 * fit the cap, what does the user read if it cannot be converted — is tested
 * here. The real decode/encode are exercised in the browser walk
 * (`docs/VERIFY-M22.md`).
 */
import { describe, expect, it } from 'vitest';
import {
  fitWithin,
  isHeicLike,
  jpegName,
  prepareAttachmentForUpload,
  type DecodedImage,
  type EncodeAttempt,
} from '../src/lib/image-convert.js';

/** A stand-in for a decoded photo: only its pixel size is ever read. */
function fakeSource(width: number, height: number): DecodedImage {
  return { naturalWidth: width, naturalHeight: height, width, height } as unknown as DecodedImage;
}

/** A file whose `type` is what the OS reported (which is the thing under test). */
function file(name: string, type: string, size = 1024): File {
  // `size` is a read-only getter on Blob, so the instance carries its own (a
  // 9 MB literal would only be allocated to be counted).
  const blob = new Blob([new Uint8Array(8)], { type });
  Object.defineProperty(blob, 'name', { value: name, configurable: true });
  Object.defineProperty(blob, 'size', { value: size, configurable: true });
  return blob as unknown as File;
}

describe('isHeicLike', () => {
  it('recognises every HEIC/HEIF mime', () => {
    for (const type of [
      'image/heic',
      'image/heif',
      'image/heic-sequence',
      'image/heif-sequence',
      'IMAGE/HEIC',
    ]) {
      expect(isHeicLike({ name: 'x', type })).toBe(true);
    }
  });

  it('recognises the extension when the mime is missing or generic', () => {
    // Files/iCloud and drag-and-drop paths hand over exactly these.
    for (const [name, type] of [
      ['IMG_0001.HEIC', ''],
      ['IMG_0001.heic', 'application/octet-stream'],
      ['IMG_0002.HEIF', ''],
    ] as const) {
      expect(isHeicLike({ name, type })).toBe(true);
    }
  });

  it('leaves everything else alone', () => {
    for (const [name, type] of [
      ['photo.jpg', 'image/jpeg'],
      ['shot.heic.jpg', 'image/jpeg'],
      ['notes.txt', 'text/plain'],
      ['icon.png', ''],
    ] as const) {
      expect(isHeicLike({ name, type })).toBe(false);
    }
  });
});

describe('jpegName', () => {
  it('replaces the HEIC extension instead of appending to it', () => {
    expect(jpegName('IMG_0001.HEIC')).toBe('IMG_0001.jpg');
    expect(jpegName('IMG_0001.heif')).toBe('IMG_0001.jpg');
  });

  it('appends .jpg to a name with no extension, and survives an empty name', () => {
    expect(jpegName('IMG_0001')).toBe('IMG_0001.jpg');
    expect(jpegName('')).toBe('photo.jpg');
    // Nothing left but a dot is not a name — it still uploads as "photo.jpg".
    expect(jpegName('.heic')).toBe('photo.jpg');
  });
});

describe('fitWithin', () => {
  const EDGE = 4096;

  it('leaves a 12 MP iPhone photo untouched (4032px is already inside the edge)', () => {
    expect(fitWithin(4032, 3024, EDGE)).toEqual({ width: 4032, height: 3024 });
  });

  it('shrinks a 48 MP photo to the edge, preserving the aspect ratio', () => {
    expect(fitWithin(8064, 6048, EDGE)).toEqual({ width: 4096, height: 3072 });
  });

  it('never upscales a small photo', () => {
    expect(fitWithin(640, 480, EDGE)).toEqual({ width: 640, height: 480 });
  });

  it('handles portrait orientation (the long side is the height)', () => {
    expect(fitWithin(3024, 4032, EDGE)).toEqual({ width: 3024, height: 4032 });
    expect(fitWithin(6048, 8064, EDGE)).toEqual({ width: 3072, height: 4096 });
  });

  it('keeps odd aspect ratios at least 1px', () => {
    const { width, height } = fitWithin(9000, 100, 4096);
    expect(width).toBe(4096);
    expect(height).toBeGreaterThanOrEqual(1);
  });
});

describe('prepareAttachmentForUpload', () => {
  it('uploads a JPEG untouched — re-encoding would only lose quality', async () => {
    const jpeg = file('photo.jpg', 'image/jpeg', 2_000_000);
    const prepared = await prepareAttachmentForUpload(jpeg, 8 * 1024 * 1024);
    expect(prepared.converted).toBe(false);
    expect(prepared.data).toBe(jpeg);
    expect(prepared.name).toBe('photo.jpg');
    expect(prepared.mime).toBe('image/jpeg');
  });

  // -------------------------------------------------------------------
  // M24 — the INLINE budget, not the upload cap, decides what an image
  // becomes. Storing a 6 MB photo a turn cannot send produced a thumbnail, a
  // confident "photo attached" note, and a persona reporting that no image had
  // arrived.
  // -------------------------------------------------------------------

  it('re-encodes a JPEG over the inline budget instead of uploading bytes the model never sees', async () => {
    const big = file('photo.jpg', 'image/jpeg', 6 * 1024 * 1024);
    const attempts: EncodeAttempt[] = [];
    const prepared = await prepareAttachmentForUpload(
      big,
      8 * 1024 * 1024,
      {
        decode: async () => fakeSource(4032, 3024),
        encode: async (_source, attempt) => {
          attempts.push(attempt);
          // Full size at top quality overshoots 3 MB; the next rung fits.
          const first = attempt.maxEdge === 4096 && attempt.quality === 0.9;
          return new Blob([new Uint8Array(first ? 4_000_000 : 2_000_000)]);
        },
      },
      3 * 1024 * 1024,
    );
    expect(prepared.converted).toBe(true);
    expect(prepared.mime).toBe('image/jpeg');
    expect(prepared.size).toBeLessThanOrEqual(3 * 1024 * 1024);
    expect(attempts.length).toBe(2);
  });

  it('leaves an image inside the inline budget exactly as it came', async () => {
    const ok = file('small.png', 'image/png', 1024);
    const prepared = await prepareAttachmentForUpload(ok, 8 * 1024 * 1024, {}, 3 * 1024 * 1024);
    expect(prepared.converted).toBe(false);
    expect(prepared.data).toBe(ok);
    expect(prepared.mime).toBe('image/png');
  });

  it('tightens to the core\u2019s smaller stated inline budget, not the upload cap', async () => {
    // A hosted core that stores 8 MB but inlines 1 MB: 2 MB must be re-encoded.
    const prepared = await prepareAttachmentForUpload(
      file('photo.jpg', 'image/jpeg', 2 * 1024 * 1024),
      8 * 1024 * 1024,
      {
        decode: async () => fakeSource(3000, 2000),
        encode: async () => new Blob([new Uint8Array(900_000)]),
      },
      1024 * 1024,
    );
    expect(prepared.converted).toBe(true);
    expect(prepared.size).toBe(900_000);
  });

  it('refuses an over-UPLOAD-cap file outright, without decoding it', async () => {
    // The two budgets stay distinct: over the store cap is a refusal — never a
    // silent resize of a file the user meant to attach as-is.
    await expect(
      prepareAttachmentForUpload(file('huge.jpg', 'image/jpeg', 9 * 1024 * 1024), 8 * 1024 * 1024, {
        decode: async () => {
          throw new Error('must not decode a refused file');
        },
      }),
    ).rejects.toThrow('huge.jpg is 9 MB — the limit is 8 MB per file.');
  });

  it('treats an untyped .JPG by extension, so a photo from Files still fits', async () => {
    const prepared = await prepareAttachmentForUpload(
      file('IMG_0002.JPG', '', 5 * 1024 * 1024),
      8 * 1024 * 1024,
      {
        decode: async () => fakeSource(4000, 3000),
        encode: async () => new Blob([new Uint8Array(1200)]),
      },
      3 * 1024 * 1024,
    );
    expect(prepared.converted).toBe(true);
    expect(prepared.size).toBe(1200);
  });

  it('leaves a non-image alone however big it is (under the upload cap)', async () => {
    const pdf = file('long.pdf', 'application/pdf', 5 * 1024 * 1024);
    const prepared = await prepareAttachmentForUpload(pdf, 8 * 1024 * 1024, {}, 3 * 1024 * 1024);
    expect(prepared.converted).toBe(false);
    expect(prepared.data).toBe(pdf);
  });

  it('names the mime for a file the OS could not type', async () => {
    const prepared = await prepareAttachmentForUpload(file('note.bin', ''), null);
    expect(prepared.mime).toBe('application/octet-stream');
  });

  it('refuses an over-cap non-HEIC file with the shared sentence', async () => {
    await expect(
      prepareAttachmentForUpload(file('big.jpg', 'image/jpeg', 9 * 1024 * 1024), 8 * 1024 * 1024),
    ).rejects.toThrow('big.jpg is 9 MB — the limit is 8 MB per file.');
  });

  it('converts HEIC to JPEG and renames it', async () => {
    const prepared = await prepareAttachmentForUpload(file('IMG_0001.HEIC', 'image/heic'), 1024, {
      decode: async () => fakeSource(4032, 3024),
      encode: async () => new Blob([new Uint8Array(500)]),
    });
    expect(prepared.converted).toBe(true);
    expect(prepared.name).toBe('IMG_0001.jpg');
    expect(prepared.mime).toBe('image/jpeg');
    expect(prepared.size).toBe(500);
  });

  it('converts a HEIC that is ALREADY over the cap instead of refusing it', async () => {
    // The whole point of the path: a 9 MB HEIC is a good photo that becomes a
    // small JPEG, not an over-size file.
    const prepared = await prepareAttachmentForUpload(
      file('IMG_0009.HEIC', 'image/heic', 9 * 1024 * 1024),
      8 * 1024 * 1024,
      {
        decode: async () => fakeSource(8064, 6048),
        encode: async () => new Blob([new Uint8Array(2_000_000)]),
      },
    );
    expect(prepared.converted).toBe(true);
    expect(prepared.size).toBe(2_000_000);
  });

  it('steps down the ladder until the JPEG fits the budget', async () => {
    const attempts: EncodeAttempt[] = [];
    const prepared = await prepareAttachmentForUpload(file('a.heic', 'image/heic'), 1024, {
      decode: async () => fakeSource(8000, 6000),
      encode: async (_source, attempt) => {
        attempts.push(attempt);
        // Only the last rung — reduced edge AND reduced quality — fits.
        const fits = attempt.maxEdge === 1536;
        return new Blob([new Uint8Array(fits ? 900 : 5000)]);
      },
    });
    // Quality is traded before resolution: the full 4096px edge is kept twice —
    // and the ladder now KEEPS GOING past it. A 12 MP photo at 4096/q0.9 can
    // overshoot the 3 MB inline budget, and stopping there stored a photo the
    // turn then refused to send.
    expect(attempts.map((a) => a.maxEdge)).toEqual([4096, 4096, 3072, 2048, 2048, 1536]);
    expect(attempts.map((a) => a.quality)).toEqual([0.9, 0.8, 0.8, 0.8, 0.7, 0.7]);
    expect(prepared.size).toBe(900);
  });

  it('reports the smallest attempt when even the ladder cannot fit the budget', async () => {
    await expect(
      prepareAttachmentForUpload(file('huge.heic', 'image/heic'), 1024, {
        decode: async () => fakeSource(8000, 6000),
        encode: async (_source, attempt) =>
          new Blob([new Uint8Array(attempt.maxEdge === 1536 ? 1500 : 9000)]),
      }),
    ).rejects.toThrow('huge.jpg is 1.5 KB — the limit is 1 KB per file.');
  });

  it('makes one good attempt when the caller states no budget at all', async () => {
    const attempts: EncodeAttempt[] = [];
    const prepared = await prepareAttachmentForUpload(
      file('a.heic', 'image/heic'),
      null,
      {
        decode: async () => fakeSource(4032, 3024),
        encode: async (_source, attempt) => {
          attempts.push(attempt);
          return new Blob([new Uint8Array(10_000_000)]);
        },
      },
      // Explicitly budget-free: the inline budget is a floor the composer
      // normally honours, so "no budget at all" has to be asked for.
      null,
    );
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toEqual({ maxEdge: 4096, quality: 0.9 });
    expect(prepared.size).toBe(10_000_000);
  });

  it('says so when this browser cannot decode HEIC, instead of uploading it', async () => {
    await expect(
      prepareAttachmentForUpload(file('IMG_0001.HEIC', 'image/heic'), 8 * 1024 * 1024, {
        decode: async () => {
          throw new Error('no HEIC decoder');
        },
      }),
    ).rejects.toThrow(
      'IMG_0001.HEIC could not be converted to JPEG — this browser cannot read HEIC. Save it as a JPEG first, or attach it from Safari.',
    );
  });

  it('closes the decoded bitmap so a 48 MP photo does not pin memory', async () => {
    let closed = false;
    const bitmap = {
      width: 4032,
      height: 3024,
      close: () => {
        closed = true;
      },
    };
    const previous = globalThis.ImageBitmap;
    // `convertToJpeg` only closes real ImageBitmaps, so the seam is faked the
    // same way: a class-like value that satisfies the instanceof check path.
    class FakeBitmap {
      static [Symbol.hasInstance](): boolean {
        return true;
      }
    }
    (globalThis as { ImageBitmap?: unknown }).ImageBitmap = FakeBitmap;
    try {
      await prepareAttachmentForUpload(file('a.heic', 'image/heic'), null, {
        decode: async () => bitmap as unknown as DecodedImage,
        encode: async () => new Blob([new Uint8Array(10)]),
      });
    } finally {
      if (previous === undefined) delete (globalThis as { ImageBitmap?: unknown }).ImageBitmap;
      else (globalThis as { ImageBitmap?: unknown }).ImageBitmap = previous;
    }
    expect(closed).toBe(true);
  });
});
