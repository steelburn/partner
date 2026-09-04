/**
 * M6 theming wire contracts (PLAN-M6.md).
 *
 * A theme record is BOTH light/dark modes of the existing design tokens
 * (ThemeTokens from theme.js) — the values components already consume via
 * cssVars(). Saves are gated server-side (lint + contrast); the report is
 * returned inline to the UI.
 */
import type { ThemeMode, ThemeTokens } from './theme.js';

export type ThemeSource = 'preset' | 'custom';

export interface ThemeProfile {
  id: string;
  name: string;
  source: ThemeSource;
  light: ThemeTokens;
  dark: ThemeTokens;
}

export interface ThemeSaveInput {
  name: string;
  light: ThemeTokens;
  dark: ThemeTokens;
}

export interface ThemeReportIssue {
  /** Dot path into the token record, e.g. 'dark.textMuted'. */
  token: string;
  mode: ThemeMode;
  message: string;
  /** APCA magnitude when a contrast check ran. */
  apca?: number;
  /** WCAG 2.x ratio when a contrast check ran. */
  wcag?: number;
}

export interface ThemeReport {
  ok: boolean;
  errors: ThemeReportIssue[];
  warnings: ThemeReportIssue[];
}

export interface ThemeActivation {
  id: string;
  source: ThemeSource;
}

/** Resolved active tokens for a request (persona -> global -> preset). */
export interface ActiveTheme {
  themeId: string;
  source: ThemeSource;
  light: ThemeTokens;
  dark: ThemeTokens;
}
