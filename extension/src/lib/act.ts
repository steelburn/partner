/**
 * Minimal page-act primitives contract + pure guard — PURE.
 *
 * Full fill/click automation belongs to a later scopes milestone (PLAN-M7.md);
 * today we ship only (a) the guard that refuses actions while a page shows an
 * active password field unless the caller explicitly opts in, and (b) typed
 * descriptions of the primitives the content script executes. The classic
 * content script mirrors the guard inline (it cannot import modules) — keep
 * in sync; the tested logic lives here.
 */

export type ActKind = 'fill' | 'click' | 'scroll';

export interface ActTarget {
  /** CSS selector; mutually exclusive with `role`. */
  selector?: string;
  /** Element marked data-partner-role="…"; mutually exclusive with `selector`. */
  role?: string;
}

export interface ActRequest extends ActTarget {
  kind: ActKind;
  /** fill: value to set on the matched input/textarea. */
  value?: string;
  /** scroll: window scroll delta (px) when no target is given. */
  deltaY?: number;
  /** Opt out of the sensitive-page refusal. Never set by default flows. */
  allowSensitive?: boolean;
}

export interface ActEvalInfo {
  /** True when the page currently contains an enabled password field. */
  hasActivePasswordField: boolean;
  /** True when the caller explicitly passed allowSensitive. */
  allowSensitive?: boolean;
}

export const SENSITIVE_REFUSAL = 'sensitive_page';

/**
 * Refusal reason when an act is attempted on a page with a live password
 * field and the caller did not pass `allowSensitive`. Returns null when the
 * act may proceed. Applied to fill/click primitives (scroll is passive
 * navigation and is never refused).
 */
export function needsSensitiveRefusal(info: ActEvalInfo): string | null {
  if (info.hasActivePasswordField && info.allowSensitive !== true) return SENSITIVE_REFUSAL;
  return null;
}
