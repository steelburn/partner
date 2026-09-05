/**
 * Independence-level gate tests (PLAN-M9.md "Level enforcement" table):
 *
 *   | level      | low risk        | medium risk   | high risk     |
 *   |------------|-----------------|---------------|---------------|
 *   | assist     | refused         | refused       | refused       |
 *   | suggest    | under grant     | queue         | queue         |
 *   | auto       | under grant     | under grant   | queue         |
 *   | autonomous | under grant     | under grant   | under grant   |
 *
 * "under grant" = executed when granted, queued when the grant is missing.
 * A missing grant NEVER refuses (except at assist). declaredTools acts as
 * the playbook envelope (outside -> refused); autoScopes counts as persona
 * consent but never hardens the matrix.
 */
import { describe, expect, it } from 'vitest';
import type { IndependenceLevel } from '@partner/shared';
import type { ToolManifest } from '@partner/shared/tools.js';
import { authorizeTool } from '../../src/playbooks/gate.js';
import type { AuthorizeContext } from '../../src/playbooks/gate.js';

function manifest(risk: ToolManifest['risk']): ToolManifest {
  return {
    id: 'files.read',
    description: 'test',
    risk,
    confirm: 'once',
    network: false,
    scope: { kind: 'project' },
  };
}

function ctx(over: Partial<AuthorizeContext>): AuthorizeContext {
  return { toolId: 'files.read', hasGrant: false, ...over };
}

describe('authorizeTool — level x risk x grant matrix', () => {
  const risks: Array<ToolManifest['risk']> = ['low', 'medium', 'high'];

  it('assist refuses every risk — even granted and playbook-declared', () => {
    for (const risk of risks) {
      const decision = authorizeTool('assist', manifest(risk), ctx({ hasGrant: true }));
      expect(decision).toEqual({ decision: 'refused', reason: 'assist_level_no_tools' });
      const denied = authorizeTool('assist', manifest(risk), ctx({ hasGrant: false }));
      expect(denied).toEqual({ decision: 'refused', reason: 'assist_level_no_tools' });
    }
  });

  it('suggest queues medium/high without a grant; runs low under grant', () => {
    const low = authorizeTool('suggest', manifest('low'), ctx({ hasGrant: true }));
    expect(low).toEqual({ decision: 'executed', reason: 'level_allows' });
    const lowNoGrant = authorizeTool('suggest', manifest('low'), ctx({ hasGrant: false }));
    expect(lowNoGrant).toEqual({ decision: 'queued', reason: 'needs_grant' });
    const medium = authorizeTool('suggest', manifest('medium'), ctx({ hasGrant: true }));
    expect(medium).toEqual({ decision: 'queued', reason: 'level_requires_approval' });
    const high = authorizeTool('suggest', manifest('high'), ctx({ hasGrant: true }));
    expect(high).toEqual({ decision: 'queued', reason: 'level_requires_approval' });
  });

  it('auto runs low/medium under grant and queues high even when granted', () => {
    const low = authorizeTool('auto', manifest('low'), ctx({ hasGrant: true }));
    expect(low).toEqual({ decision: 'executed', reason: 'level_allows' });
    const medium = authorizeTool('auto', manifest('medium'), ctx({ hasGrant: true }));
    expect(medium).toEqual({ decision: 'executed', reason: 'level_allows' });
    const mediumNoGrant = authorizeTool('auto', manifest('medium'), ctx({ hasGrant: false }));
    expect(mediumNoGrant).toEqual({ decision: 'queued', reason: 'needs_grant' });
    const high = authorizeTool('auto', manifest('high'), ctx({ hasGrant: true }));
    expect(high).toEqual({ decision: 'queued', reason: 'high_requires_approval' });
  });

  it('autonomous runs any risk under grant; queues when the grant is missing', () => {
    for (const risk of risks) {
      const granted = authorizeTool('autonomous', manifest(risk), ctx({ hasGrant: true }));
      expect(granted).toEqual({ decision: 'executed', reason: 'level_allows' });
      const missing = authorizeTool('autonomous', manifest(risk), ctx({ hasGrant: false }));
      expect(missing).toEqual({ decision: 'queued', reason: 'needs_grant' });
    }
  });

  it('missing grant always queues — never refuses — except assist', () => {
    for (const level of ['suggest', 'auto', 'autonomous'] as IndependenceLevel[]) {
      for (const risk of risks) {
        const decision = authorizeTool(level, manifest(risk), ctx({ hasGrant: false }));
        expect(decision.decision, `${level}/${risk}`).toBe('queued');
      }
    }
  });

  it('refuses a tool outside the playbook declaredTools envelope', () => {
    const decision = authorizeTool('autonomous', manifest('low'), ctx({
      hasGrant: true,
      declaredTools: ['files.list', 'files.search'],
    }));
    expect(decision).toEqual({ decision: 'refused', reason: 'tool_not_in_playbook' });
  });

  it('autoScopes count as persona consent for the execution decision', () => {
    const low = authorizeTool('auto', manifest('low'), ctx({
      hasGrant: false,
      autoScopes: ['files.read', 'files.search'],
    }));
    expect(low).toEqual({ decision: 'executed', reason: 'level_allows' });
    // But high stays queued at auto even with an autoScope.
    const high = authorizeTool('auto', manifest('high'), ctx({
      hasGrant: false,
      autoScopes: ['files.read'],
    }));
    expect(high).toEqual({ decision: 'queued', reason: 'high_requires_approval' });
  });

  it('an autoScope admits a tool outside declaredTools', () => {
    const decision = authorizeTool('auto', manifest('low'), ctx({
      hasGrant: true,
      declaredTools: [],
      autoScopes: ['files.read'],
    }));
    expect(decision).toEqual({ decision: 'executed', reason: 'level_allows' });
  });
});
