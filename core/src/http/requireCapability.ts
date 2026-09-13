/**
 * Per-route capability guard (M20-B S4) — the express half of the client-class
 * envelope. `capabilities.ts` owns the table and stays pure; this module is the
 * only place express types meet it.
 *
 * The class is read from `res.locals.session` — the row the presented token
 * resolved to — and NEVER from a request field, header or query: a caller that
 * could name its own class would make the control decorative. That is also why
 * the guard must be mounted AFTER requireSession; mounted alone it sees no
 * session and refuses the request as an unknown class (fail closed) instead of
 * assuming desktop.
 *
 * The refusal row carries the class and the capability ONLY — the body, query
 * and path of the refused call never reach audit.
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { capabilityDenial } from './capabilities.js';
import type { Capability } from './capabilities.js';
import type { AuditService } from '../services/redaction.js';
import type { SessionInfo } from './session.js';

export interface CapabilityGuardDeps {
  /** Receives the `capability.denied` row (class + capability only). */
  audit: AuditService;
}

/** Middleware for one capability; see the module header for the mount order. */
export function requireCapability(
  capability: Capability,
  deps: CapabilityGuardDeps,
): RequestHandler {
  const { audit } = deps;
  return (_req: Request, res: Response, next: NextFunction): void => {
    const session = res.locals.session as SessionInfo | undefined;
    // No session on this route -> '' is refused as an unknown class; the
    // envelope never falls back to desktop.
    const denial = capabilityDenial(session === undefined ? '' : session.clientClass, capability);
    if (denial === null) {
      next();
      return;
    }
    audit.log('session', 'capability.denied', capability, {
      clientClass: denial.clientClass,
      capability: denial.capability,
    });
    // `error` names the refusal family, `reason` the precise cause — the same
    // split the 401s use (unauthorized + reason).
    res.status(403).json({
      error: 'capability_denied',
      reason: denial.reason,
      capability: denial.capability,
      clientClass: denial.clientClass,
    });
  };
}
