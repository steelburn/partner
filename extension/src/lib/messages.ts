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
