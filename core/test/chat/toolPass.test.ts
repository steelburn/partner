/**
 * M11 F2 slice-1 tests — chat-directive tool pass (PLAN-M11.md).
 *
 * Same gate semantics as the M9 loop, but per-directive and with outcome
 * notes persisted by the caller: executed -> result note; queued ->
 * approval row (requestedBy persona) + note; refused -> note. Fakes keep
 * this pure (no broker/temp-roots needed).
 */
import { describe, expect, it } from 'vitest';
import type { Persona, PersonaToolDirective } from '@partner/shared';
import type { ToolManifest } from '@partner/shared/tools.js';
import { runChatToolPass, type ChatToolBrokerLike, type ChatToolPassDeps } from '../../src/chat/toolPass.js';
import { auditLog } from '../../src/services/redaction.js';
import { createAuditStore } from '../../src/stores/db.js';
import { openDatabase } from '../../src/stores/db.js';

const READ: ToolManifest = {
  id: 'files.read',
  description: 'read',
  risk: 'low',
  confirm: 'once',
  network: false,
  scope: { kind: 'project' },
};

function persona(level: Persona['independence']['level']): Persona {
  return {
    id: 'p-1',
    name: 'P',
    character: { voice: 'v', language: 'en', systemPrompt: '', temperature: 0.7 },
    model: { taskClasses: {} },
    independence: { level, requireHumanFor: ['high'], autoScopes: [] },
    memory: { userProfile: 'none', episodes: 'none' },
    isDefault: false,
    paused: false,
    createdAt: 1,
    updatedAt: 1,
  };
}

function brokerLike(over: Partial<ChatToolBrokerLike>): ChatToolBrokerLike {
  return {
    manifests: [READ],
    grants: { hasGrant: () => false },
    exec: () => ({ outcome: 'executed', result: { content: 'file body' } }),
    ...over,
  };
}

function makeDeps(
  p: Persona,
  broker: ChatToolBrokerLike,
  notes: string[],
): ChatToolPassDeps {
  const db = openDatabase(':memory:');
  const audit = auditLog({ store: createAuditStore(db) });
  void db;
  return {
    persona: p,
    broker,
    audit,
    appendSystemNote: (content) => notes.push(content),
  };
}

const directive = (toolId = 'files.read', args: Record<string, unknown> = { projectId: 'proj-1', path: 'a.md' }): string =>
  `Let me check that.\n[[partner:tool ${toolId} ${JSON.stringify(args)}]]`;

describe('M11 F2 chat tool pass', () => {
  it('executes a granted directive and appends the result note', () => {
    const notes: string[] = [];
    const broker = brokerLike({
      grants: { hasGrant: () => true },
      exec: () => ({ outcome: 'executed', result: { content: 'hello world' } }),
    });
    const result = runChatToolPass(directive(), makeDeps(persona('auto'), broker, notes));
    expect(result.decisions).toEqual([{ toolId: 'files.read', decision: 'executed' }]);
    expect(notes.join('\n')).toContain('[tool files.read result]');
    expect(notes.join('\n')).toContain('hello world');
  });

  it('assist level refuses with a note (propose only)', () => {
    const notes: string[] = [];
    const result = runChatToolPass(directive(), makeDeps(persona('assist'), brokerLike({}), notes));
    expect(result.decisions[0]).toMatchObject({ decision: 'refused', reason: 'assist_level_no_tools' });
    expect(notes[0]).toContain('refused');
  });

  it('queues an approval for a persona whose request is not auto-granted', () => {
    const notes: string[] = [];
    const queued: string[] = [];
    const broker = brokerLike({
      pending: {
        enqueue: (input) => {
          expect(input.requestedBy).toBe('persona');
          queued.push(input.toolId);
          return 'pending-1';
        },
      },
    });
    const result = runChatToolPass(directive(), makeDeps(persona('suggest'), broker, notes));
    expect(result.decisions[0]).toMatchObject({ decision: 'queued', pendingId: 'pending-1' });
    expect(notes[0]).toContain('awaiting your approval');
  });

  it('unknown tools and missing projectId refuse with clear notes', () => {
    const notes: string[] = [];
    const missing = runChatToolPass(
      directive('files.deploy', {}),
      makeDeps(persona('auto'), brokerLike({}), notes),
    );
    expect(missing.decisions[0]).toMatchObject({ decision: 'refused', reason: 'unknown_tool' });
    notes.length = 0;
    const noProject = runChatToolPass(
      directive('files.read', {}),
      makeDeps(persona('suggest'), brokerLike({}), notes),
    );
    expect(noProject.decisions[0]).toMatchObject({ decision: 'refused', reason: 'missing_project' });
  });

  it('a persona tool ban refuses even when granted (M11 F3)', () => {
    const notes: string[] = [];
    const p = { ...persona('autonomous'), policy: { tools: { banned: ['files.read'] } } };
    const broker = brokerLike({ grants: { hasGrant: () => true } });
    const result = runChatToolPass(directive(), makeDeps(p, broker, notes));
    expect(result.decisions[0]).toMatchObject({ decision: 'refused', reason: 'tool_banned_by_persona' });
  });

  it('audits every decision id-only', () => {
    const db = openDatabase(':memory:');
    try {
      const audit = auditLog({ store: createAuditStore(db) });
      const notes: string[] = [];
      const deps: ChatToolPassDeps = {
        persona: persona('auto'),
        broker: brokerLike({ grants: { hasGrant: () => true } }),
        audit,
        appendSystemNote: (content) => notes.push(content),
      };
      runChatToolPass(directive(), deps);
      const rows = audit.query({ limit: 10, action: 'chat.tool' });
      expect(rows.length).toBe(1);
      expect(rows[0]?.target).toBe('files.read');
      expect(rows[0]?.details).not.toContain('hello world');
    } finally {
      db.close();
    }
  });
});

// Keep the shared directive type referenced (parse input shape).
export type { PersonaToolDirective };
