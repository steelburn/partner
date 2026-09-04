/**
 * M6 theme presets (PLAN-M6.md §"Seed") — two immutable preset definitions
 * built from the CURRENT shared tokens (shared/src/theme.ts TOKENS, the
 * single source of truth). The manager seeds them as `preset` rows ONLY when
 * the themes table is empty; rows are then immutable (updates/deletes are
 * refused with 409). Presets are deliberately plain data — the gate lives in
 * gates.ts and the seed/CRUD rules in manager.ts.
 *
 * 'preset-default' = the shipped DESIGN tokens (light + dark as-is).
 * 'preset-midnight' = a tasteful dark-forward variant: light stays the
 * shipped light mode; dark cools/darkens a few surfaces so it reads calmer
 * on OLED-ish panels. Both presets pass the contrast gate (asserted in
 * core/test/theming/gates.test.ts + presets.test.ts).
 */
import type { ThemeTokens } from '@partner/shared';
import { TOKENS } from '@partner/shared';

export interface ThemePreset {
  id: string;
  name: string;
  /** 'preset' — never mutable through the manager. */
  source: 'preset';
  light: ThemeTokens;
  dark: ThemeTokens;
}

/** Shipped tokens — the Default preset, verbatim. */
const DEFAULT_LIGHT: ThemeTokens = { ...TOKENS.light };
const DEFAULT_DARK: ThemeTokens = { ...TOKENS.dark };

/** Midnight dark mode: deeper neutrals + a cooler surface set, same palette. */
const MIDNIGHT_LIGHT: ThemeTokens = { ...DEFAULT_LIGHT };
const MIDNIGHT_DARK: ThemeTokens = {
  ...DEFAULT_DARK,
  bg: '#0b0d0f',
  surface: '#14171a',
  surface2: '#20252a',
  border: '#2b3036',
};

export const PRESET_DEFAULT: ThemePreset = {
  id: 'preset-default',
  name: 'Default',
  source: 'preset',
  light: DEFAULT_LIGHT,
  dark: DEFAULT_DARK,
};

export const PRESET_MIDNIGHT: ThemePreset = {
  id: 'preset-midnight',
  name: 'Midnight',
  source: 'preset',
  light: MIDNIGHT_LIGHT,
  dark: MIDNIGHT_DARK,
};

/** Seed order + list() presentation order (presets first, in this order). */
export const THEME_PRESETS: readonly ThemePreset[] = [PRESET_DEFAULT, PRESET_MIDNIGHT];

/** Ids of every shipped preset (stable lookup for active resolution). */
export const PRESET_IDS: ReadonlySet<string> = new Set(THEME_PRESETS.map((p) => p.id));

/** Profile-shaped view of a preset (drop-in for the wire ThemeProfile). */
export function presetProfile(preset: ThemePreset): {
  id: string;
  name: string;
  source: 'preset';
  light: ThemeTokens;
  dark: ThemeTokens;
} {
  return {
    id: preset.id,
    name: preset.name,
    source: 'preset',
    light: { ...preset.light },
    dark: { ...preset.dark },
  };
}
