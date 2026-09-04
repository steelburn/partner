/**
 * M7 browser-extension + native-messaging wire contracts (PLAN-M7.md).
 *
 * The extension talks to the core over Chrome native messaging (local
 * stdio JSON frames) and manages per-site scopes server-side. Page text is
 * the user's own data (owner-facing only); it must never reach audit/logs.
 */

export type SiteScope = 'off' | 'ask' | 'read' | 'read+act' | 'trusted';

export interface SiteScopeRecord {
  origin: string;
  scope: SiteScope;
  updatedAt: number;
}

export interface ScopeInput {
  scope: SiteScope;
}

export interface ResolvedPolicy {
  origin: string;
  scope: SiteScope;
  /** True when a built-in blocklist forbids any action regardless of scope. */
  blocked: boolean;
  reason: 'blocked_origin' | 'no_scope' | null;
}

// ---------------------------------------------------------------------------
// Native-messaging frames (core --native-messaging)
// ---------------------------------------------------------------------------

export interface NmEnvelope {
  type: 'request' | 'response';
  id: string;
  command?: string;
  ok?: boolean;
  payload?: unknown;
  error?: string;
}

export interface PageCapture {
  url: string;
  title: string;
  origin: string;
  /** user selection text when present. */
  selection?: string;
  /** innerText, truncated (extension caps at ~100k chars). */
  text?: string;
}

export interface AnalyzeRequest extends PageCapture {
  personaId?: string;
}
