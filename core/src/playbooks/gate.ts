/**
 * Persona independence-level gate (PLAN-M9.md "Level enforcement" table +
 * PLAN.md §5.1).
 *
 * Pure function: decides whether a persona MAY direct-execute a tool of a
 * given risk, must go through the human approval queue, or is refused
 * outright — as a function of the persona's independence level, the tool
 * manifest risk, and the context ({@link AuthorizeContext}):
 *
 *   - declaredTools — the playbook's allowed tool ids (a directive for a
 *     tool outside the playbook is refused; the playbook is the persona's
 *     capability envelope).
 *   - autoScopes — persona independence.autoScopes (a matching entry counts
 *     as persona-envelope consent; the caller still needs an underlying user
 *     grant before broker.exec runs — deny-by-default never weakens).
 *   - hasGrant — whether an ACTIVE user grant covers (tool, project) right
 *     now (the broker is the single execution authority; the gate only
 *     decides the persona side).
 *
 * Matrix (level x risk -> decision; assist refuses always):
 *
 *   | level      | low risk        | medium risk   | high risk     |
 *   |------------|-----------------|---------------|---------------|
 *   | assist     | refused         | refused       | refused       |
 *   | suggest    | under grant     | queue         | queue         |
 *   | auto       | under grant     | under grant   | queue         |
 *   | autonomous | under grant     | under grant   | under grant   |
 *
 * "under grant" = executed when granted, queued when the grant is missing.
 * A missing grant NEVER refuses (except at assist) — it queues for the
 * human, keeping deny-by-default while never hard-blocking a request.
 *
 * Pure: no clock, no store, no side effects — unit-testable in isolation.
 */
import type { IndependenceLevel } from '@partner/shared';
import type { ToolManifest } from '@partner/shared/tools.js';

export type ToolGateDecision =
  | { decision: 'executed'; reason: 'level_allows' }
  | { decision: 'queued'; reason: ToolGateQueueReason }
  | { decision: 'refused'; reason: ToolGateRefuseReason };

export type ToolGateQueueReason =
  | 'needs_grant'
  | 'level_requires_approval'
  | 'high_requires_approval';

export type ToolGateRefuseReason =
  | 'assist_level_no_tools'
  | 'tool_not_in_playbook'
  | 'tool_banned_by_persona';

export interface AuthorizeContext {
  /** The directive's tool id (matched against declaredTools/autoScopes). */
  toolId: string;
  /** The playbook's allowed tool ids; omit to skip the envelope check. */
  declaredTools?: readonly string[];
  /** Persona independence.autoScopes — treated as persona-envelope consent. */
  autoScopes?: readonly string[];
  /** Active user grant present for (tool, project)? */
  hasGrant: boolean;
  /** M11 F3 persona policy: tools this persona may never direct-execute. */
  bannedTools?: readonly string[];
}

function isRisk(risk: string, wanted: 'low' | 'medium' | 'high'): boolean {
  return risk === wanted;
}

export function authorizeTool(
  level: IndependenceLevel,
  manifest: Pick<ToolManifest, 'risk' | 'id'>,
  ctx: AuthorizeContext,
): ToolGateDecision {
  const toolId = typeof ctx.toolId === 'string' ? ctx.toolId : '';

  // M11 F3: a persona policy ban beats every level and the envelope — the
  // persona may never direct-execute this tool, even with a grant.
  if ((ctx.bannedTools ?? []).includes(toolId)) {
    return { decision: 'refused', reason: 'tool_banned_by_persona' };
  }

  // Assist never executes a tool — even declared, even granted. It answers
  // and proposes only (PLAN.md §5.1).
  if (level === 'assist') {
    return { decision: 'refused', reason: 'assist_level_no_tools' };
  }

  // Playbook envelope: the directive must be within the playbook's allowed
  // tools or the persona's auto scopes (PLAN-M9 "suggest+ -> tool must be
  // within the persona's playbook/auto scopes").
  const declared = ctx.declaredTools;
  if (declared !== undefined && declared.length > 0) {
    const withinPlaybook = declared.includes(toolId);
    const withinAuto = (ctx.autoScopes ?? []).includes(toolId);
    if (!withinPlaybook && !withinAuto) {
      return { decision: 'refused', reason: 'tool_not_in_playbook' };
    }
  }

  const granted = ctx.hasGrant === true || (ctx.autoScopes ?? []).includes(toolId);
  const risk = manifest.risk;

  if (level === 'autonomous') {
    // Any risk runs inside the configured envelope; without a user grant it
    // queues (autonomy never exceeds user grants — PLAN.md §5.1).
    return granted
      ? { decision: 'executed', reason: 'level_allows' }
      : { decision: 'queued', reason: 'needs_grant' };
  }

  if (level === 'auto') {
    // Executes within autoScopes up to MEDIUM risk under grants; HIGH risk
    // always asks (requireHumanFor default) regardless of the grant.
    if (isRisk(risk, 'high')) {
      return { decision: 'queued', reason: 'high_requires_approval' };
    }
    return granted
      ? { decision: 'executed', reason: 'level_allows' }
      : { decision: 'queued', reason: 'needs_grant' };
  }

  // level === 'suggest': executes LOW risk under grants; MEDIUM/HIGH are
  // proposed to the queue even when a user grant exists (PLAN.md §5.1:
  // "proposes medium/high and waits for confirmation").
  if (!isRisk(risk, 'low')) {
    return { decision: 'queued', reason: 'level_requires_approval' };
  }
  return granted
    ? { decision: 'executed', reason: 'level_allows' }
    : { decision: 'queued', reason: 'needs_grant' };
}
