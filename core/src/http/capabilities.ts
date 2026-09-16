/**
 * Client-class capability envelopes (PLAN-M20-B S4) — PURE, no imports.
 *
 * The broker's per-tool gate answers "does this session hold a grant?".
 * This answers the question ABOVE it: "may a client of this class ask for
 * this capability at all?" — so an already-granted mobile or extension
 * session cannot walk straight through a grant into file writes, deploys or
 * skill installs. Wiring must refuse `capability_denied` BEFORE the grant
 * check (S4), and it must pass the value from this module rather than
 * re-listing capabilities at the route.
 *
 * Locked decisions (PLAN-M20-B §6):
 *  - mobile: denied `file.write`, `roots`, `deploy`, `skill.install`.
 *    (`skill.author` is denied by the same mechanism — mobile is an allowlist,
 *    so a new capability is denied for it until this table says otherwise.)
 *  - extension: the LEAST trusted client — it executes inside pages the user
 *    does not control, so its envelope is an allowlist of read + browser +
 *    chat, and every other capability is denied by construction.
 *  - desktop: unrestricted within its grants.
 *
 * Fail-closed rules: an unknown class, an unknown capability or a non-string
 * argument is DENIED (never "default to allow"), and case matters, so a
 * `'DESKTOP'` arriving from a mis-mapped column is refused. The catalogued
 * values are the ones the wiring lane must use; a new capability added to the
 * vocabulary is denied for mobile/extension until this table says otherwise.
 */

/** Client kinds that can hold an enrolled session. */
export const CLIENT_CLASSES = ['desktop', 'mobile', 'extension'] as const;
export type ClientClass = (typeof CLIENT_CLASSES)[number];

/**
 * Capability vocabulary: one name per route group / per-tool decision that a
 * client class could plausibly be refused. `file.read` / `file.write` are the
 * per-tool capabilities of the broker surface (`files.list|read|search` vs
 * `files.edit|apply|delete`), not route names.
 */
export const CAPABILITIES = [
  'chat',
  'file.read',
  'file.write',
  'browser',
  'roots',
  'grants',
  'deploy',
  'skill.install',
  'skill.invoke',
  /**
   * M26: AUTHORING — creating, editing, validating and dry-running a skill
   * DRAFT. Narrower than `skill.install` on purpose: writing a draft is inert
   * (nothing runs, nothing installs), so it is gated separately from the act
   * that makes code executable.
   */
  'skill.author',
  'mcp.call',
  /**
   * M22 (was the recorded "vocabulary gap"): PROVIDER KEY WRITES —
   * `/v1/providers/:id/key` and `/v1/search/key`. A stored key is spendable
   * money and, for a hosted core, a credential that outlives the session, so a
   * narrow class may not write one. (`/v1/providers` create/delete stay on
   * `roots`-free data-plane footing: they name an endpoint, not a secret.)
   */
  'provider.configure',
  /**
   * M22: AUTONOMOUS FIRING — playbook run and schedule run-now, i.e. work the
   * user did not just ask for in this turn. Chat is request-shaped; this is not.
   */
  'persona.run',
] as const;
export type Capability = (typeof CAPABILITIES)[number];

/**
 * The envelope per class. Desktop is the full vocabulary; mobile is narrowed to
 * the same read-only set as the extension.
 *
 * WHY mobile is NOT "desktop minus four": `grants`, `skill.invoke` and
 * `mcp.call` are INDIRECT routes to the very capabilities mobile is denied.
 * Creating a grant is an authorization act for something mobile may not do;
 * a skill or an MCP server can carry file-write permissions of its own. Verified:
 * neither `core/src/skills/` nor `core/src/mcp/` consults the session's client
 * class today, so the class would NOT constrain what they do on mobile's behalf —
 * an over-permissive table here would be the only thing standing between a phone
 * session and file-write authority.
 *
 * So this FAILS CLOSED. Those three may be added back only together with a test
 * proving the session class propagates into skill and MCP execution (the S4
 * wiring must extend the broker's ExecContext and refuse before the grant check).
 * Widening later is a deliberate decision; narrowing after release is a security
 * fix that breaks working flows.
 *
 * M22 closed the two NAMES the vocabulary was missing (`provider.configure`,
 * `persona.run`) and put them in this envelope's deny side for mobile/extension
 * by construction — they are not in those lists, and the table is the only place
 * that decides.
 */
export const CLIENT_ENVELOPE: Readonly<Record<ClientClass, readonly Capability[]>> = {
  desktop: CAPABILITIES,
  mobile: ['chat', 'file.read', 'browser'],
  extension: ['chat', 'file.read', 'browser'],
};

export type CapabilityDenialReason =
  | 'capability_denied'
  | 'unknown_client_class'
  | 'unknown_capability';

/** A refusal that names both the reason and what was refused. */
export interface CapabilityDenial {
  ok: false;
  reason: CapabilityDenialReason;
  clientClass: unknown;
  capability: unknown;
}

export function isClientClass(value: unknown): value is ClientClass {
  return typeof value === 'string' && (CLIENT_CLASSES as readonly string[]).includes(value);
}

export function isCapability(value: unknown): value is Capability {
  return typeof value === 'string' && (CAPABILITIES as readonly string[]).includes(value);
}

/**
 * null ⇒ the class may ask for the capability; a denial otherwise.
 * Both arguments are widened on purpose: the values arrive from a session row
 * and a route, so the guard has to be able to REFUSE them, not assume them.
 */
export function capabilityDenial(
  clientClass: ClientClass | string,
  capability: Capability | string,
): CapabilityDenial | null {
  if (!isClientClass(clientClass)) {
    return { ok: false, reason: 'unknown_client_class', clientClass, capability };
  }
  if (!isCapability(capability)) {
    return { ok: false, reason: 'unknown_capability', clientClass, capability };
  }
  if (CLIENT_ENVELOPE[clientClass].includes(capability)) return null;
  return { ok: false, reason: 'capability_denied', clientClass, capability };
}
