/**
 * Attachment copy helpers (shared by the core's 413/too_large refusals and the
 * SPA's pre-upload check, so a file is described with the same words either
 * way).
 */
import { describe, expect, it } from 'vitest';
import { attachmentTooLargeMessage, describeBytes } from '../src/attachments.js';

describe('describeBytes', () => {
  it('names whole units without a decimal', () => {
    expect(describeBytes(8 * 1024 * 1024)).toBe('8 MB');
    expect(describeBytes(64 * 1024 * 1024)).toBe('64 MB');
    expect(describeBytes(1024)).toBe('1 KB');
  });

  it('keeps one digit when the value is fractional', () => {
    // A 1.5 MB cap must not read "1 MB" (files between 1 and 1.5 MB are
    // refused) or "2 MB" (files under 2 MB that are refused anyway).
    expect(describeBytes(1536 * 1024)).toBe('1.5 MB');
    expect(describeBytes(1024 + 512)).toBe('1.5 KB');
  });

  it('rounds a cap down and a size up, so a refusal never contradicts itself', () => {
    const cap = 8 * 1024 * 1024;
    // One byte over the cap: to the nearest tenth both read "8.0 MB".
    expect(describeBytes(cap, 'down')).toBe('8 MB');
    expect(describeBytes(cap + 1, 'up')).toBe('8.1 MB');
    expect(describeBytes(cap + 1, 'up')).not.toBe(describeBytes(cap, 'down'));
    // A non-integral cap is never overstated.
    expect(describeBytes(8 * 1024 * 1024 + 40_000)).toBe('8 MB');
  });

  it('falls back to bytes below 1 KB (a tightened cap is never "0 MB")', () => {
    expect(describeBytes(64)).toBe('64 bytes');
    expect(describeBytes(0)).toBe('0 bytes');
  });
});

describe('attachmentTooLargeMessage', () => {
  it('names the file, its size and the cap when the file is known', () => {
    expect(attachmentTooLargeMessage(8 * 1024 * 1024, { name: 'IMG_4821.HEIC', size: 13_000_000 })).toBe(
      'IMG_4821.HEIC is 12.4 MB — the limit is 8 MB per file.',
    );
  });

  it('rounds up the size it refuses, so the sentence stays coherent', () => {
    expect(
      attachmentTooLargeMessage(8 * 1024 * 1024, { name: 'huge.jpg', size: 8 * 1024 * 1024 + 1 }),
    ).toBe('huge.jpg is 8.1 MB — the limit is 8 MB per file.');
  });

  it('states the cap alone when the request died before the name was known', () => {
    expect(attachmentTooLargeMessage(1024)).toBe(
      'That file is too large — the limit is 1 KB per file.',
    );
  });
});
