/**
 * Theme token application.
 *
 * theme.ts (in @partner/shared) is the SINGLE source of truth for token
 * values. This module translates the active mode's token set into CSS custom
 * properties on <html>, so components consume only var(--…). There is no
 * tokens.css file — this module is the bridge.
 *
 * M6 adds applyThemeTokens(): the same bridge for an ARBITRARY light/dark
 * token pair (a saved active theme, or a Theme Studio draft preview). Shared
 * non-color tokens (space/type/elevation/motion) always come from cssVars()
 * unchanged — only the color vars follow the active theme.
 */

import { TOKENS, cssVars, type ThemeMode, type ThemeTokens } from '@partner/shared';
import { tokensToCssVars } from '../lib/theme-helpers.js';
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

/** Set the full var map onto <html> and match native surfaces to the mode. */
function setVariables(variables: Record<string, string>, mode: ThemeMode): void {
  const root = document.documentElement;
  for (const [name, value] of Object.entries(variables)) {
    root.style.setProperty(name, value);
  }
  // Match native surfaces (scrollbars, form controls) to the active mode.
  root.style.colorScheme = mode;
}

/**
 * Apply (or re-apply after a toggle) the token variables for `mode` onto
 * document.documentElement. Safe to call repeatedly — it sets the full set.
 * Uses the canonical DESIGN tokens.
 */
export function applyMode(mode: ThemeMode): void {
  setVariables(cssVars(mode), mode);
}

export const THEME_CACHE_KEY = 'partner.theme.pair';

/** The last successfully applied theme pair + mode (for a network-free
 *  first paint — M6 review finding 4). */
export interface CachedThemePair {
  mode: ThemeMode;
  light: ThemeTokens;
  dark: ThemeTokens;
}

export function cacheThemePair(
  light: ThemeTokens,
  dark: ThemeTokens,
  mode: ThemeMode,
): void {
  writeLocal(THEME_CACHE_KEY, JSON.stringify({ mode, light, dark } as CachedThemePair));
}

export function clearCachedThemePair(): void {
  writeLocal(THEME_CACHE_KEY, '');
}

export function readCachedThemePair(): CachedThemePair | null {
  const raw = readLocal(THEME_CACHE_KEY);
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  try {
    const parsed = JSON.parse(raw) as Partial<CachedThemePair>;
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      (parsed.mode === 'light' || parsed.mode === 'dark') &&
      parsed.light !== null &&
      typeof parsed.light === 'object' &&
      parsed.dark !== null &&
      typeof parsed.dark === 'object'
    ) {
      return parsed as CachedThemePair;
    }
  } catch {
    /* fall through */
  }
  return null;
}

/** First-paint token application: the last applied theme pair when cached,
 *  else the canonical mode tokens. Never touches the network. */
export function bootApply(): void {
  const cached = readCachedThemePair();
  if (cached) {
    applyThemeTokens(cached.light, cached.dark, cached.mode);
    return;
  }
  applyMode(getInitialMode());
}

/**
 * Apply the canonical tokens in `mode` with color overrides from an
 * arbitrary light/dark pair (active theme or studio draft). Missing color
 * keys fall back to the canonical TOKENS[mode] values (see theme-helpers).
 */
export function applyThemeTokens(
  light: Partial<ThemeTokens> | ThemeTokens | null | undefined,
  dark: Partial<ThemeTokens> | ThemeTokens | null | undefined,
  mode: ThemeMode,
): void {
  setVariables(tokensToCssVars(light, dark, mode), mode);
}
