/**
 * M6 theming module index (PLAN-M6.md).
 *
 * Re-exports the theme manager, typed errors, the pure gates and the preset
 * definitions.
 */
export { ThemeError, themeError, themeErrorStatus } from './errors.js';
export type { ThemeErrorCode } from './errors.js';

export { createThemeManager, ACTIVE_THEME_KEY } from './manager.js';
export type { ThemeManager, ThemeManagerOptions } from './manager.js';

export {
  apcaLc,
  wcagRatio,
  parseHex,
  relativeLuminance,
  lintTokens,
  contrastReport,
  validateTheme,
  THEME_TOKEN_KEYS,
  MIN_APCA_LC,
  MIN_WCAG_RATIO,
} from './gates.js';
export type { Rgb } from './gates.js';

export {
  PRESET_DEFAULT,
  PRESET_MIDNIGHT,
  THEME_PRESETS,
  PRESET_IDS,
  presetProfile,
} from './presets.js';
export type { ThemePreset } from './presets.js';
