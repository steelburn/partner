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
import { runChatToolPass, runNativeToolCalls, type ChatToolBrokerLike, type ChatToolPassDeps } from '../../src/chat/toolPass.js';
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

describe('M11 F2 chat tool pass', async () => {
  it('executes a granted directive and appends the result note', async () => {
    const notes: string[] = [];
    const broker = brokerLike({
      grants: { hasGrant: () => true },
      exec: () => ({ outcome: 'executed', result: { content: 'hello world' } }),
    });
    const result = await runChatToolPass(directive(), makeDeps(persona('auto'), broker, notes));
    expect(result.decisions).toEqual([{ toolId: 'files.read', decision: 'executed' }]);
    expect(notes.join('\n')).toContain('[tool files.read result]');
    expect(notes.join('\n')).toContain('hello world');
  });

  it('suggest queues an EXTERNAL approval row (web search) instead of refusing', async () => {
    const notes: string[] = [];
    const enqueued: Array<Record<string, unknown>> = [];
    const broker = brokerLike({
      grants: { hasGrant: () => false },
      pending: {
        enqueue: (input) => {
          enqueued.push(input as unknown as Record<string, unknown>);
          return 'pending-ext-1';
        },
      },
    });
    const external = [
      {
        manifests: [
          { id: 'search' as never, description: 's', risk: 'medium' as const, confirm: 'once' as const, network: true, scope: { kind: 'project' } as const },
        ],
        allow: () => true,
        exec: async () => ({ outcome: 'executed' as const, result: { result_1: 'hit' } }),
      },
    ];
    const result = await runChatToolPass('[[partner:tool search {"query":"x"}]]', {
      persona: persona('suggest'),
      broker,
      external,
      audit: auditLog({ store: createAuditStore(openDatabase(':memory:')) }),
      appendSystemNote: (content) => notes.push(content),
      conversationId: 'conv-9',
    });
    expect(result.decisions[0]).toMatchObject({ toolId: 'search', decision: 'queued', pendingId: 'pending-ext-1' });
    expect(enqueued[0]).toMatchObject({
      toolId: 'search',
      projectId: '',
      risk: 'medium',
      requestedBy: 'persona',
      conversationId: 'conv-9',
      personaId: 'p-1',
      params: { query: 'x' },
    });
    expect(notes[0]).toContain('awaiting your approval');
    expect(notes[0]).toContain('Files queue');
  });

  it('assist refuses an external tool without queueing (no ask at assist)', async () => {
    const notes: string[] = [];
    const enqueued: string[] = [];
    const broker = brokerLike({
      grants: { hasGrant: () => false },
      pending: {
        enqueue: (input) => {
          enqueued.push(input.toolId);
          return 'never';
        },
      },
    });
    const external = [
      {
        manifests: [
          { id: 'search' as never, description: 's', risk: 'medium' as const, confirm: 'once' as const, network: true, scope: { kind: 'project' } as const },
        ],
        allow: () => true,
        exec: async () => ({ outcome: 'executed' as const, result: {} }),
      },
    ];
    const result = await runChatToolPass('[[partner:tool search {"query":"x"}]]', {
      persona: persona('assist'),
      broker,
      external,
      audit: auditLog({ store: createAuditStore(openDatabase(':memory:')) }),
      appendSystemNote: (content) => notes.push(content),
      conversationId: 'conv-9',
    });
    expect(result.decisions[0]).toMatchObject({ toolId: 'search', decision: 'refused', reason: 'assist_level_no_tools' });
    expect(enqueued).toEqual([]);
    expect(notes[0]).toContain('refused');
  });

  it('a disabled external backend never queues — the directive refuses default-deny', async () => {
    const notes: string[] = [];
    const enqueued: string[] = [];
    const broker = brokerLike({
      grants: { hasGrant: () => false },
      pending: {
        enqueue: (input) => {
          enqueued.push(input.toolId);
          return 'never';
        },
      },
    });
    const external = [
      {
        manifests: [
          { id: 'search' as never, description: 's', risk: 'medium' as const, confirm: 'once' as const, network: true, scope: { kind: 'project' } as const },
        ],
        allow: () => false,
        exec: async () => ({ outcome: 'denied' as const, reason: 'disabled' }),
      },
    ];
    const result = await runChatToolPass('[[partner:tool search {"query":"x"}]]', {
      persona: persona('suggest'),
      broker,
      external,
      audit: auditLog({ store: createAuditStore(openDatabase(':memory:')) }),
      appendSystemNote: (content) => notes.push(content),
    });
    expect(result.decisions[0]).toMatchObject({ toolId: 'search', decision: 'refused', reason: 'external_disabled' });
    expect(enqueued).toEqual([]);
    expect(notes[0]).toContain('disabled');
  });

  it('assist level refuses with a note (propose only)', async () => {
    const notes: string[] = [];
    const result = await runChatToolPass(directive(), makeDeps(persona('assist'), brokerLike({}), notes));
    expect(result.decisions[0]).toMatchObject({ decision: 'refused', reason: 'assist_level_no_tools' });
    expect(notes[0]).toContain('refused');
  });

  it('queues an approval for a persona whose request is not auto-granted', async () => {
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
    const result = await runChatToolPass(directive(), makeDeps(persona('suggest'), broker, notes));
    expect(result.decisions[0]).toMatchObject({ decision: 'queued', pendingId: 'pending-1' });
    expect(notes[0]).toContain('awaiting your approval');
  });

  it('unknown tools and missing projectId refuse with clear notes', async () => {
    const notes: string[] = [];
    const missing = await runChatToolPass(
      directive('files.deploy', {}),
      makeDeps(persona('auto'), brokerLike({}), notes),
    );
    expect(missing.decisions[0]).toMatchObject({ decision: 'refused', reason: 'unknown_tool' });
    notes.length = 0;
    const noProject = await runChatToolPass(
      directive('files.read', {}),
      makeDeps(persona('suggest'), brokerLike({}), notes),
    );
    expect(noProject.decisions[0]).toMatchObject({ decision: 'refused', reason: 'missing_project' });
  });

  it('a persona tool ban refuses even when granted (M11 F3)', async () => {
    const notes: string[] = [];
    const p = { ...persona('autonomous'), policy: { tools: { banned: ['files.read'] } } };
    const broker = brokerLike({ grants: { hasGrant: () => true } });
    const result = await runChatToolPass(directive(), makeDeps(p, broker, notes));
    expect(result.decisions[0]).toMatchObject({ decision: 'refused', reason: 'tool_banned_by_persona' });
  });

  it('audits every decision id-only', async () => {
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
      await runChatToolPass(directive(), deps);
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

describe('M11 F2 native tool calls (runNativeToolCalls)', async () => {
  it('parses JSON arguments and executes under a grant', async () => {
    const notes: string[] = [];
    const broker = brokerLike({
      grants: { hasGrant: () => true },
      exec: () => ({ outcome: 'executed' as const, result: { content: 'native read ok' } }),
    });
    const result = await runNativeToolCalls(
      [{ id: 'call_1', name: 'files.read', arguments: '{"projectId":"proj-1","path":"a.txt"}' }],
      makeDeps(persona('auto'), broker, notes),
    );
    expect(result.decisions).toEqual([{ toolId: 'files.read', decision: 'executed' }]);
    expect(notes.join('\n')).toContain('native read ok');
  });

  it('skips empty names and treats unparsable arguments as a refusal-relevant call', async () => {
    const notes: string[] = [];
    const result = await runNativeToolCalls(
      [
        { id: 'x', name: '', arguments: '{}' },
        { id: 'y', name: 'files.read', arguments: 'not-json' },
      ],
      makeDeps(persona('assist'), brokerLike({}), notes),
    );
    // '' skipped entirely; assist refuses the second.
    expect(result.decisions).toHaveLength(1);
    expect(result.decisions[0]).toMatchObject({ toolId: 'files.read', decision: 'refused' });
  });
});


describe('M11 F2 external array dispatch guard', () => {
  it('routes broker tools to the broker and external tools to their owner', async () => {
    const notes: string[] = [];
    const brokerCalls: string[] = [];
    const searchCalls: string[] = [];
    const mcpCalls: string[] = [];
    const broker = brokerLike({
      grants: { hasGrant: () => true },
      exec: (toolId) => {
        brokerCalls.push(toolId);
        return { outcome: 'executed' as const, result: { content: 'broker read' } };
      },
    });
    const external = [
      {
        manifests: [
          { id: 'search' as never, description: 's', risk: 'medium' as const, confirm: 'once' as const, network: true, scope: { kind: 'project' } as const },
        ],
        allow: (id: string) => id === 'search',
        exec: async (id: string) => {
          searchCalls.push(id);
          return { outcome: 'executed' as const, result: { query: 'q' } };
        },
      },
      {
        manifests: [],
        allow: (id: string) => id.startsWith('mcp:') && id.startsWith('mcp:on/'),
        match: (id: string) =>
          id.startsWith('mcp:on/')
            ? ({ id: id as never, description: 'm', risk: 'medium' as const, confirm: 'once' as const, network: true, scope: { kind: 'project' } as const } as const)
            : undefined,
        exec: async (id: string) => {
          mcpCalls.push(id);
          return { outcome: 'executed' as const, result: { output_1: 'mcp text' } };
        },
      },
    ];
    const deps: ChatToolPassDeps = {
      persona: persona('auto'),
      broker,
      external,
      audit: auditLog({ store: createAuditStore(openDatabase(':memory:')) }),
      appendSystemNote: (content) => notes.push(content),
    };
    await runChatToolPass(
      [
        '[[partner:tool files.read {"projectId":"p","path":"a"}]]',
        '[[partner:tool search {"query":"x"}]]',
        '[[partner:tool mcp:on/doIt {}]]',
      ].join('\n'),
      deps,
    );
    expect(brokerCalls).toEqual(['files.read']);
    expect(searchCalls).toEqual(['search']);
    expect(mcpCalls).toEqual(['mcp:on/doIt']);
    expect(notes.join('\n')).toContain('broker read');
    expect(notes.join('\n')).toContain('mcp text');
  });
});

describe('M20-B S4: the persona tool loop inherits the SESSION client class', () => {
  // The verified gap this closes: `/v1/chat` is allowed to mobile, and the loop
  // reached the broker with no class, so `broker.exec` defaulted to DESKTOP and a
  // phone turn executed a granted write. Checked here at the seam because the
  // loop is where a phone actually reached a write; `broker.exec` keeps its own
  // check as the second gate.
  const WRITE: ToolManifest = { ...READ, id: 'files.edit', description: 'write' };

  it('refuses a mobile turn BEFORE it can execute or queue a write tool', async () => {
    const notes: string[] = [];
    let execCalls = 0;
    let enqueued = 0;
    const broker = brokerLike({
      manifests: [READ, WRITE],
      grants: { hasGrant: () => true }, // a grant must NOT be enough
      exec: () => {
        execCalls += 1;
        return { outcome: 'executed', result: { content: 'wrote' } };
      },
      pending: {
        enqueue: () => {
          enqueued += 1;
          return 'p-1';
        },
      },
    });
    const deps: ChatToolPassDeps = { ...makeDeps(persona('auto'), broker, notes), clientClass: 'mobile' };

    const result = await runChatToolPass(directive('files.edit'), deps);

    expect(result.decisions).toEqual([
      { toolId: 'files.edit', decision: 'refused', reason: 'capability_denied' },
    ]);
    // Neither side effect happened: not executed, and not even queued (a class
    // that may not ask must not be able to park the work for someone else).
    expect(execCalls).toBe(0);
    expect(enqueued).toBe(0);
    expect(notes.join(' ')).toContain('not available to this device');
  });

  it('still lets a desktop turn execute it, and does not deny read tools to mobile', async () => {
    const notes: string[] = [];
    let execCalls = 0;
    const broker = brokerLike({
      manifests: [READ, WRITE],
      grants: { hasGrant: () => true },
      exec: () => {
        execCalls += 1;
        return { outcome: 'executed', result: { content: 'wrote' } };
      },
    });

    const desktop = await runChatToolPass(directive('files.edit'), {
      ...makeDeps(persona('auto'), broker, notes),
      clientClass: 'desktop',
    });
    expect(desktop.decisions).toEqual([{ toolId: 'files.edit', decision: 'executed' }]);
    expect(execCalls).toBe(1);

    // Positive control: the envelope is not "deny everything for mobile" — a
    // read tool still runs, which is what keeps the guard from being a brick.
    const mobileRead = await runChatToolPass(directive('files.read'), {
      ...makeDeps(persona('auto'), broker, notes),
      clientClass: 'mobile',
    });
    expect(mobileRead.decisions).toEqual([{ toolId: 'files.read', decision: 'executed' }]);
    expect(execCalls).toBe(2);
  });
});
