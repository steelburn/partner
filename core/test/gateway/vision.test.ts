import { describe, expect, it } from 'vitest';
import { isImageCapableModel, isInlineableImageMime } from '../../src/gateway/vision.js';

describe('M11 multimodal vision helpers', () => {
  it('recognizes image-capable model ids', () => {
    expect(isImageCapableModel('gpt-4o')).toBe(true);
    expect(isImageCapableModel('gpt-4.1-mini')).toBe(true);
    expect(isImageCapableModel('gemini-2.0-flash')).toBe(true);
    expect(isImageCapableModel('claude-sonnet-4')).toBe(true);
    expect(isImageCapableModel('llama-3.1-8b')).toBe(false);
    expect(isImageCapableModel('')).toBe(false);
    expect(isImageCapableModel(null)).toBe(false);
  });

  it('inlines the supported image mimes only', () => {
    expect(isInlineableImageMime('image/png')).toBe(true);
    expect(isInlineableImageMime('image/webp')).toBe(true);
    expect(isInlineableImageMime('image/svg+xml')).toBe(false);
  });
});
