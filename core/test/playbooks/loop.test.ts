/**
 * M9 persona tool loop engine tests (PLAN-M9.md).
 *
 * A scripted FAKE provider double drives the loop (never the demo provider —
 * tool loops require a real resolved target). The real broker over a temp
 * root executes the file tools (M2 helpers style: root + grant). Covered:
 *   - directive-then-final: broker executed, result excerpt fed back (capped
 *     at TOOL_RESULT_EXCERPT_CHARS), 2 model rounds, events sequence has
 *     loop_step + persona_tool + delta + done, audit rows carry personaId/
 *     toolId/decision and NO content;
 *   - always-directives -> loop_exhausted after 4 rounds;
 *   - assist persona directive -> refused, loop continues;
 *   - a queued directive stops the run with a pendingId (row tagged
 *     requestedBy persona); after broker decide(approve) resume re-enters
 *     the loop and completes;
 *   - denied approval -> resume continues without the tool;
 *   - resolver returning nothing -> no_provider;
 *   - resume typed errors (unknown run / undecided queue row).
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  ChatEvent,
  ChatMessage,
  ChatRequest,
  HealthReport,
  Persona,
  ProviderClient,
} from '@partner/shared';
import type { ToolBroker } from '../../src/broker/broker.js';
import { createToolBroker } from '../../src/broker/broker.js';
import { createGrantManager } from '../../src/broker/grants.js';
import { createPendingManager } from '../../src/broker/pending.js';
import { createProjectRootManager } from '../../src/broker/roots.js';
import { createFileTools } from '../../src/files/tools.js';
import { createProposalManager } from '../../src/files/proposals.js';
import { auditLog } from '../../src/services/redaction.js';
import type { AuditService } from '../../src/services/redaction.js';
import { openDatabase } from '../../src/stores/db.js';
import {
  createAuditStore,
  createFileProposalStore,
  createGrantStore,
  createPendingToolStore,
  createProjectRootStore,
} from '../../src/stores/db.js';
import type { FileProposalStore } from '../../src/stores/types.js';
import { createToolLoop, TOOL_RESULT_EXCERPT_CHARS } from '../../src/playbooks/loop.js';
import type { LoopEvent, LoopProviderResolver, ToolLoop } from '../../src/playbooks/loop.js';
import { makeTempRoot, removeTempRoot } from '../helpers.js';

interface Rig {
  broker: ToolBroker;
  audit: AuditService;
  proposalStore: FileProposalStore;
  close(): void;
}

function makeRig(): Rig {
  const db = openDatabase(':memory:');
  const audit = auditLog({ store: createAuditStore(db) });
  const roots = createProjectRootManager({ store: createProjectRootStore(db) });
  const grants = createGrantManager({ store: createGrantStore(db) });
  const pending = createPendingManager({
    store: createPendingToolStore(db),
    onCreateGrant: (row) => grants.add(row.toolId, row.projectId ?? '', {}).id,
  });
  const proposalStore = createFileProposalStore(db);
  const broker = createToolBroker({
    roots,
    grants,
    pending,
    proposals: createProposalManager({ store: proposalStore }),
    tools: createFileTools({ proposals: proposalStore }),
    audit,
  });
  return { broker, audit, proposalStore, close: () => db.close() };
}

function makeLoop(rig: Rig, resolver: LoopProviderResolver): ToolLoop {
  return createToolLoop({ broker: rig.broker, resolver, audit: rig.audit });
}

/** Scripted provider: reply[i] per call; records every messages array seen. */
function scriptedProvider(replies: string[]): {
  client: ProviderClient;
  seen: () => ChatMessage[][];
} {
  const seen: ChatMessage[][] = [];
  let calls = 0;
  const client: ProviderClient = {
    async *chatStream(req: ChatRequest): AsyncGenerator<ChatEvent> {
      seen.push(req.messages);
      const idx = Math.min(calls, replies.length - 1);
      calls += 1;
      const text = replies[idx] ?? '';
      yield { type: 'delta', text };
      yield { type: 'usage', promptTokens: 1, completionTokens: text.length, totalTokens: 1 + text.length };
      yield { type: 'done', model: 'fake-model', latencyMs: 1 };
    },
    async health(): Promise<HealthReport> {
      return { ok: true, latencyMs: 0 };
    },
  };
  return { client, seen: () => seen };
}

const BIG_CONTENT = 'the quick brown fox jumps over the lazy dog. '.repeat(70); // ~3500 chars

function persona(level: Persona['independence']['level']): Persona {
  return {
    id: 'p-test',
    name: 'Test persona',
    character: {
      voice: 'v',
      language: 'en',
      systemPrompt: 'You are a helpful test persona.',
      temperature: 0.5,
    },
    model: { taskClasses: {} },
    independence: { level, requireHumanFor: ['high'], autoScopes: [] },
    memory: { userProfile: 'none', episodes: 'none' },
    isDefault: false,
    paused: false,
    createdAt: 1,
    updatedAt: 1,
  };
}

function readDirective(projectId: string, path = 'hello.txt'): string {
  return `[[partner:tool files.read ${JSON.stringify({ projectId, path })}]]`;
}

function editDirective(projectId: string): string {
  return `[[partner:tool files.edit ${JSON.stringify({
    projectId,
    path: 'notes.md',
    proposedContent: 'rewritten note body',
  })}]]`;
}

async function collect(
  gen: AsyncGenerator<LoopEvent, unknown, unknown>,
): Promise<{ events: LoopEvent[]; result: Record<string, unknown> }> {
  const events: LoopEvent[] = [];
  const iterator = gen[Symbol.asyncIterator]();
  for (;;) {
    const step = await iterator.next();
    if (step.done) return { events, result: step.value as Record<string, unknown> };
    events.push(step.value as LoopEvent);
  }
}

const tempDirs: string[] = [];
function tempRoot(): string {
  const dir = makeTempRoot();
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) removeTempRoot(tempDirs.pop() as string);
});

describe('persona tool loop', () => {
  it('runs a directive then the final answer: broker executed, capped excerpt fed back, 2 rounds', async () => {
    const rig = makeRig();
    try {
      const dir = tempRoot();
      writeFileSync(join(dir, 'hello.txt'), BIG_CONTENT, 'utf8');
      const root = rig.broker.roots.add({ label: 'root', path: dir, readOnly: false });
      rig.broker.grants.add('files.read', root.id);

      const fake = scriptedProvider([
        `Let me read it.\n${readDirective(root.id)}`,
        'All done — here is the final answer.',
      ]);
      const loop = makeLoop(rig, () => ({ client: fake.client, model: 'fake-model' }));
      const { events, result } = await collect(
        loop.run({
          runId: 'run-1',
          persona: persona('autonomous'),
          messages: [
            { role: 'system', content: 'sys' },
            { role: 'user', content: 'read hello.txt' },
          ],
          allowedTools: ['files.list', 'files.read', 'files.search'],
          playbookId: 'vibe-code',
        }),
      );

      expect(result.status).toBe('done');
      expect(result.rounds).toBe(2);
      expect(result.toolCalls).toBe(1);
      expect(result.text).toBe('All done — here is the final answer.');

      // Event sequence: loop_step(1) + delta + ... + persona_tool + loop_step(2) + done.
      const types = events.map((e) => e.type);
      expect(types).toContain('loop_step');
      expect(types).toContain('persona_tool');
      expect(types).toContain('delta');
      expect(types).toContain('done');
      const stepRounds = events
        .filter((e) => e.type === 'loop_step')
        .map((e) => (e as { round: number }).round);
      expect(stepRounds).toEqual([1, 2]);
      expect(
        events.find((e) => e.type === 'persona_tool' && e.decision === 'executed'),
      ).toMatchObject({ toolId: 'files.read', decision: 'executed' });

      // The second provider call saw a system message with the tool result;
      // the content line is capped (never the full file).
      const secondCall = fake.seen()[1] ?? [];
      const system = secondCall.find(
        (m) => m.role === 'system' && m.content.includes('tool files.read result'),
      );
      expect(system).toBeDefined();
      const excerpt = (system as ChatMessage).content;
      expect(excerpt).toContain('quick brown fox');
      const contentLine = excerpt.split('\n').find((l) => l.startsWith('content:')) ?? '';
      expect(contentLine.length).toBeLessThanOrEqual(TOOL_RESULT_EXCERPT_CHARS + 200);
      expect(contentLine).toContain(`${BIG_CONTENT.length} chars`);

      // Audit rows: action playbook.tool with personaId/toolId/decision, NO content.
      const toolRows = rig.audit.list(100).filter((row) => row.action === 'playbook.tool');
      expect(toolRows.length).toBeGreaterThanOrEqual(1);
      const details = toolRows.map((row) => row.details).join('');
      expect(details).toContain('"personaId":"p-test"');
      // toolId is the audit TARGET (ids/names/decisions only).
      expect(toolRows.some((row) => row.target === 'files.read')).toBe(true);
      expect(details).toContain('"decision":"executed"');
      expect(details).not.toContain('quick brown fox');
    } finally {
      rig.close();
    }
  });

  it('loop_exhausted after 4 rounds when every reply carries a directive', async () => {
    const rig = makeRig();
    try {
      const dir = tempRoot();
      writeFileSync(join(dir, 'hello.txt'), 'short', 'utf8');
      const root = rig.broker.roots.add({ label: 'root', path: dir, readOnly: false });
      rig.broker.grants.add('files.read', root.id);
      const directive = readDirective(root.id);
      const fake = scriptedProvider([directive, directive, directive, directive, directive]);
      const loop = makeLoop(rig, () => ({ client: fake.client, model: 'fake-model' }));
      const { result } = await collect(
        loop.run({
          runId: 'run-2',
          persona: persona('autonomous'),
          messages: [{ role: 'user', content: 'go' }],
          playbookId: 'vibe-code',
        }),
      );
      expect(result.status).toBe('loop_exhausted');
      expect(result.rounds).toBe(4);
      expect(result.toolCalls).toBe(4);
      expect(loop.has('run-2')).toBe(false);
    } finally {
      rig.close();
    }
  });

  it('assist persona: directive refused and the loop continues to the final answer', async () => {
    const rig = makeRig();
    try {
      const dir = tempRoot();
      writeFileSync(join(dir, 'hello.txt'), 'short', 'utf8');
      const root = rig.broker.roots.add({ label: 'root', path: dir, readOnly: false });
      rig.broker.grants.add('files.read', root.id); // grant exists — assist still refuses
      const fake = scriptedProvider([
        `I cannot do that myself.\n${readDirective(root.id)}`,
        'Here is my plain answer instead.',
      ]);
      const loop = makeLoop(rig, () => ({ client: fake.client, model: 'fake-model' }));
      const { events, result } = await collect(
        loop.run({
          runId: 'run-3',
          persona: persona('assist'),
          messages: [{ role: 'user', content: 'go' }],
          playbookId: 'docgen',
        }),
      );
      expect(result.status).toBe('done');
      expect(result.rounds).toBe(2);
      expect(result.toolCalls).toBe(0);
      expect(events).toContainEqual(
        expect.objectContaining({ type: 'persona_tool', decision: 'refused' }),
      );
      const refused = rig.audit.list(100).filter((row) => row.action === 'playbook.tool');
      expect(refused[0]?.details).toContain('"decision":"refused"');
    } finally {
      rig.close();
    }
  });

  it('queued tool stops the run with a pendingId; resume completes after broker decide', async () => {
    const rig = makeRig();
    try {
      const dir = tempRoot();
      writeFileSync(join(dir, 'notes.md'), 'original note body', 'utf8');
      const root = rig.broker.roots.add({ label: 'root', path: dir, readOnly: false });
      // NO grant: an auto persona queues a medium tool (files.edit).
      const fake = scriptedProvider([
        `Let me propose the edit.\n${editDirective(root.id)}`,
        'Edit approved — finishing now.',
      ]);
      const loop = makeLoop(rig, () => ({ client: fake.client, model: 'fake-model' }));
      const first = await collect(
        loop.run({
          runId: 'run-4',
          persona: persona('auto'),
          messages: [{ role: 'user', content: 'rewrite notes.md' }],
          playbookId: 'vibe-code',
        }),
      );
      const queued = first.result;
      expect(queued.status).toBe('queued');
      expect(typeof queued.pendingId).toBe('string');
      const pendingId = queued.pendingId as string;
      expect(loop.has('run-4')).toBe(true);

      // Queue row exists, tagged requestedBy 'persona'.
      const pending = rig.broker.pending.get(pendingId);
      expect(pending).toBeDefined();
      expect(pending?.requestedBy).toBe('persona');
      expect(pending?.toolId).toBe('files.edit');
      expect(pending?.decidedAt).toBeNull();

      // M2 approval: broker.decide executes the tool ONCE with stored params.
      const decided = rig.broker.decide(pendingId, { decision: 'approve' }, 'web');
      expect(decided.executed).toBe(true);
      expect(rig.proposalStore.findById((decided.result as { proposalId?: string })?.proposalId ?? '')).toBeDefined();

      // Resume re-enters the loop and completes on round 2.
      const resumed = await collect(loop.resume('run-4', pendingId));
      const done = resumed.result;
      expect(done.status).toBe('done');
      expect(done.toolCalls).toBe(1); // the approval-executed edit
      expect(loop.has('run-4')).toBe(false);
      const lastMessages = fake.seen()[fake.seen().length - 1] ?? [];
      expect(
        lastMessages.some(
          (m) => m.role === 'system' && m.content.includes('approved by the user'),
        ),
      ).toBe(true);
      // Audit reflects the approval execution as an executed playbook.tool.
      const approvals = rig.audit
        .list(100)
        .filter((row) => row.action === 'playbook.tool' && row.details.includes('approved_via_queue'));
      expect(approvals.length).toBeGreaterThanOrEqual(1);
    } finally {
      rig.close();
    }
  });

  it('denied approval resumes and the loop continues without the tool', async () => {
    const rig = makeRig();
    try {
      const dir = tempRoot();
      writeFileSync(join(dir, 'notes.md'), 'body', 'utf8');
      const root = rig.broker.roots.add({ label: 'root', path: dir, readOnly: false });
      const fake = scriptedProvider([editDirective(root.id), 'Fine — continuing without edits.']);
      const loop = makeLoop(rig, () => ({ client: fake.client, model: 'fake-model' }));
      const first = await collect(
        loop.run({
          runId: 'run-5',
          persona: persona('auto'),
          messages: [{ role: 'user', content: 'rewrite' }],
          playbookId: 'vibe-code',
        }),
      );
      const queued = first.result;
      rig.broker.decide(queued.pendingId as string, { decision: 'deny' }, 'web');
      const resumed = await collect(loop.resume('run-5', queued.pendingId as string));
      expect((resumed.result as { status: string }).status).toBe('done');
      expect((resumed.result as { toolCalls: number }).toolCalls).toBe(0);
    } finally {
      rig.close();
    }
  });

  it('no_provider when the resolver returns nothing', async () => {
    const rig = makeRig();
    try {
      const loop = makeLoop(rig, () => null);
      const { events, result } = await collect(
        loop.run({
          runId: 'run-6',
          persona: persona('auto'),
          messages: [{ role: 'user', content: 'go' }],
        }),
      );
      expect(events).toEqual([]);
      expect(result).toMatchObject({ status: 'no_provider' });
    } finally {
      rig.close();
    }
  });

  it('resume for an unknown run or an undecided queue row is a typed error', async () => {
    const rig = makeRig();
    try {
      const dir = tempRoot();
      writeFileSync(join(dir, 'notes.md'), 'body', 'utf8');
      const root = rig.broker.roots.add({ label: 'root', path: dir, readOnly: false });
      const fake = scriptedProvider([editDirective(root.id), 'done']);
      const loop = makeLoop(rig, () => ({ client: fake.client, model: 'fake-model' }));
      const first = await collect(
        loop.run({
          runId: 'run-7',
          persona: persona('auto'),
          messages: [{ role: 'user', content: 'rewrite' }],
        }),
      );
      const pendingId = first.result.pendingId as string;

      const missing = await collect(loop.resume('run-nope', pendingId));
      expect(missing.result).toMatchObject({ status: 'error', error: 'not_found' });

      const open = await collect(loop.resume('run-7', pendingId)); // not decided yet
      expect(open.result).toMatchObject({ status: 'not_decided', error: 'not_decided' });
    } finally {
      rig.close();
    }
  });
});
