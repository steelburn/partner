/**
 * Extension-internal message contract (pure shapes; no chrome).
 *
 * Two hops:
 *  - runtime messages popup ⇄ background (`PartnerRuntimeMessage` /
 *    `PartnerRuntimeReply`) — popup asks the background to issue native-
 *    messaging commands or to report persisted pairing state;
 *  - tab messages popup → content (`PartnerTabMessage` / `PartnerTabReply`)
 *    — capture snapshots and the minimal act primitives. The classic content
 *    script recognises these kind strings inline (it cannot import) — keep
 *    the string values in sync.
 */
import type { ActRequest } from './act.js';
import type { PageSnapshot } from './snapshot.js';

/** popup → background */
export type PartnerRuntimeMessage =
  | { kind: 'nm'; command: string; payload?: unknown }
  | { kind: 'state' }
  | { kind: 'reconnect' };

/** background → popup */
export type PartnerRuntimeReply =
  | { kind: 'nm.reply'; command: string; ok: boolean; payload?: unknown; error?: string }
  | { kind: 'state.reply'; paired: boolean; native: boolean; lastDeny: string | null };

/** popup → content (active tab) */
export type PartnerTabMessage =
  | { kind: 'partner.capture' }
  | { kind: 'partner.act'; payload: ActRequest };

/** content → popup (capture reply carries a PageSnapshot payload). */
export interface TabReply {
  ok: boolean;
  payload?: unknown;
  error?: string;
}

export function isCaptureReply(reply: TabReply): reply is TabReply & { payload: PageSnapshot } {
  return reply.ok === true && typeof reply.payload === 'object' && reply.payload !== null;
}

export function nmRequest(command: string, payload?: unknown): PartnerRuntimeMessage {
  const m: PartnerRuntimeMessage = { kind: 'nm', command };
  if (payload !== undefined) m.payload = payload;
  return m;
}

export function stateRequest(): PartnerRuntimeMessage {
  return { kind: 'state' };
}

/** Minimal wire shape of the core's ActiveTheme for popup token application. */
export interface ThemeTokensWire {
  bg?: string;
  text?: string;
  textMuted?: string;
  surface?: string;
  accent?: string;
  danger?: string;
  border?: string;
}

export interface ActiveThemeWire {
  themeId: string;
  source: string;
  light: ThemeTokensWire;
  dark: ThemeTokensWire;
}

/** M11 extension theme stream: request the core's active theme. */
export function themeRequest(): PartnerRuntimeMessage {
  return nmRequest('theme.active');
}

/** Guard: a successful nm.reply whose payload is a resolved ActiveTheme. */
export function isThemeReply(
  reply: PartnerRuntimeReply | undefined,
): reply is PartnerRuntimeReply & { payload: ActiveThemeWire } {
  if (reply === undefined || reply.kind !== 'nm.reply' || reply.ok !== true) return false;
  const payload = reply.payload as ActiveThemeWire | undefined;
  if (payload === undefined || payload === null || typeof payload !== 'object') return false;
  return (
    typeof payload.themeId === 'string' &&
    typeof payload.light === 'object' &&
    payload.light !== null &&
    typeof payload.dark === 'object' &&
    payload.dark !== null
  );
}
