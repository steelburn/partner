/**
 * Theme token application.
 *
 * theme.ts (in @partner/shared) is the SINGLE source of truth for token
 * values. This module translates the active mode's token set into CSS custom
 * properties on <html>, so components consume only var(--…). There is no
 * tokens.css file — this module is the bridge.
 */

import { TOKENS, cssVars, type ThemeMode } from '@partner/shared';
import { readLocal, writeLocal } from '../lib/storage.js';

export const MODE_STORAGE_KEY = 'partner.mode';

export function isThemeMode(value: unknown): value is ThemeMode {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(TOKENS, value);
}

/** The stored mode, or 'light' when unset/invalid. */
export function getInitialMode(): ThemeMode {
  const stored = readLocal(MODE_STORAGE_KEY);
  return isThemeMode(stored) ? stored : 'light';
}

/** Persist the chosen mode for the next visit. */
export function persistMode(mode: ThemeMode): void {
  writeLocal(MODE_STORAGE_KEY, mode);
}

/**
 * Apply (or re-apply after a toggle) the token variables for `mode` onto
 * document.documentElement. Safe to call repeatedly — it sets the full set.
 */
export function applyMode(mode: ThemeMode): void {
  const root = document.documentElement;
  const variables = cssVars(mode);
  for (const [name, value] of Object.entries(variables)) {
    root.style.setProperty(name, value);
  }
  // Match native surfaces (scrollbars, form controls) to the active mode.
  root.style.colorScheme = mode;
}
