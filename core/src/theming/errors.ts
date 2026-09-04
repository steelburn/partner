/**
 * Typed errors for the M6 theming surface (PLAN-M6.md).
 *
 * Codes map 1:1 onto loopback HTTP responses:
 *   invalid_input -> 400   (lint/contrast gate failed — carries the full
 *                           ThemeReport so the UI can render per-token
 *                           errors; also blank-name/structural bodies)
 *   not_found     -> 404   (unknown theme / persona)
 *   conflict      -> 409   (preset immutable; delete while active)
 *
 * Messages are always safe to surface — theme token VALUES never cross an
 * error message (the report names the offending token path and the measured
 * contrast numbers, never raw color intent beyond the lint path).
 */
import type { ThemeReport } from '@partner/shared';

export type ThemeErrorCode = 'invalid_input' | 'not_found' | 'conflict';

export class ThemeError extends Error {
  readonly code: ThemeErrorCode;
  /** The full lint + contrast report when the gate refused a save/update. */
  readonly report?: ThemeReport;

  constructor(code: ThemeErrorCode, message: string, report?: ThemeReport) {
    super(message);
    this.name = 'ThemeError';
    this.code = code;
    if (report !== undefined) this.report = report;
  }
}

export function themeError(
  code: ThemeErrorCode,
  message: string,
  report?: ThemeReport,
): ThemeError {
  return new ThemeError(code, message, report);
}

/** Loopback HTTP status for a ThemeError code. */
export function themeErrorStatus(code: ThemeErrorCode): number {
  switch (code) {
    case 'not_found':
      return 404;
    case 'conflict':
      return 409;
    default:
      return 400;
  }
}
