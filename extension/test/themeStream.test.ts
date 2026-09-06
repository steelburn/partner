/**
 * M11 extension theme stream tests (pure protocol helpers).
 */
import { describe, expect, it } from 'vitest';
import { themeRequest, isThemeReply } from '../src/lib/messages.js';
import type { PartnerRuntimeReply } from '../src/lib/messages.js';

describe('extension theme stream helpers', () => {
  it('themeRequest asks the core for the active theme', () => {
    expect(themeRequest()).toEqual({ kind: 'nm', command: 'theme.active' });
  });

  it('isThemeReply accepts a successful active-theme reply', () => {
    const reply: PartnerRuntimeReply = {
      kind: 'nm.reply',
      command: 'theme.active',
      ok: true,
      payload: { themeId: 'preset-midnight', source: 'preset', light: { bg: '#fff' }, dark: { bg: '#000' } },
    };
    expect(isThemeReply(reply)).toBe(true);
    if (isThemeReply(reply)) {
      expect(reply.payload.themeId).toBe('preset-midnight');
    }
  });

  it('isThemeReply rejects failures and malformed payloads', () => {
    const failed: PartnerRuntimeReply = { kind: 'nm.reply', command: 'theme.active', ok: false, error: 'not_paired' };
    expect(isThemeReply(failed)).toBe(false);
    const missing: PartnerRuntimeReply = {
      kind: 'nm.reply',
      command: 'theme.active',
      ok: true,
      payload: { themeId: 'x' },
    };
    expect(isThemeReply(missing)).toBe(false);
  });
});
