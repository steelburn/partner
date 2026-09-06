/**
 * M14 schedule manager (PLAN-M14.md S4) — sequencing, guards, queued →
 * decide → auto-resume, tick cadence and content discipline. Real stores
 * (in-memory), real persona manager + audit; conversations/notes/loop are
 * deterministic fakes.
 */
import { describe, expect, it } from 'vitest';
import type { Persona, PersonaSchedule } from '@partner/shared';
import type {
  LoopEvent,
  PlaybookChatTarget,
  ToolLoopResult,
} from '../../src/playbooks/loop.js';
import {
  createAuditStore,
  createPersonaStore,
  createScheduleRunStore,
  openDatabase,
} from '../../src/stores/db.js';
import { auditLog } from '../../src/services/redaction.js';
import { createPersonaManager } from '../../src/personas/manager.js';
import type { PersonaManager } from '../../src/personas/manager.js';
import { createScheduleManager } from '../../src/schedules/manager.js';
import type {
  ConversationSurface,
  NoteCreateSurface,
  ScheduleManager,
  ScheduleToolLoop,
} from '../../src/schedules/manager.js';
import { ScheduleError } from '../../src/schedules/errors.js';

interface TranscriptEntry {
  conversationId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  personaId?: string | null;
}

function fakeConversations(seedThreads: string[] = []): ConversationSurface & {
  creates: string[];
  messages: TranscriptEntry[];
} {
  const threads = new Map<string, boolean>(seedThreads.map((id) => [id, true]));
  let counter = 0;
  return {
    creates: [],
    messages: [],
    get(id: string): unknown {
      if (!threads.has(id)) throw new Error('not_found');
      return { summary: { id } };
    },
    create(input: { personaId?: string; title?: string; folderId?: string }): { id: string } {
      counter += 1;
      const id = `conv-${counter}`;
      threads.set(id, true);
      this.creates.push(input.folderId ?? '(inbox)');
      return { id };
    },
    append(
      conversationId: string,
      role: 'user' | 'assistant' | 'system',
      input: { content: string; personaId?: string | null },
    ): { id: string } {
      this.messages.push({
        conversationId,
        role,
        content: input.content,
        personaId: input.personaId ?? null,
      });
      return { id: `msg-${this.messages.length}` };
    },
  };
}

function fakeNotes(): NoteCreateSurface & { created: Array<{ title: string }> } {
  return {
    created: [],
    create(input: { title: string; content: string }): { id: string } {
      this.created.push({ title: input.title });
      return { id: `note-${this.created.length}` };
    },
  };
}

type LoopScript = Array<ToolLoopResult>;

interface LoopCall {
  kind: 'run' | 'resume';
  runId: string;
  /** System+user messages of a run call (grammar assertions). */
  messages?: Array<{ role: string; content: string }>;
}

function fakeLoop(script: LoopScript): ScheduleToolLoop & { calls: LoopCall[] } {
  let index = 0;
  const take = (): ToolLoopResult => {
    const result = script[Math.min(index, script.length - 1)] as ToolLoopResult;
    index += 1;
    return result;
  };
  return {
    calls: [],
    async *run(req: {
      runId: string;
      messages: Array<{ role: string; content: string }>;
    }): AsyncGenerator<LoopEvent, ToolLoopResult, unknown> {
      this.calls.push({ kind: 'run', runId: req.runId, messages: req.messages });
      return take();
    },
    async *resume(runId: string): AsyncGenerator<LoopEvent, ToolLoopResult, unknown> {
      this.calls.push({ kind: 'resume', runId });
      return take();
    },
  };
}

const DONE: ToolLoopResult = {
  runId: 'x',
  status: 'done',
  text: 'Brief complete: reviewed 3 notes.',
  model: 'demo',
  rounds: 2,
  toolCalls: 1,
};
const QUEUED: ToolLoopResult = {
  runId: 'x',
  status: 'queued',
  text: '',
  model: null,
  rounds: 1,
  toolCalls: 0,
  pendingId: 'pending-1',
};

function brief(id: string, overrides: Partial<PersonaSchedule> = {}): PersonaSchedule {
  return {
    id,
    label: 'Morning brief',
    when: { kind: 'interval', everyMinutes: 5 },
    prompt: 'Review yesterday and plan today.',
    enabled: true,
    ...overrides,
  };
}

interface Harness {
  manager: ScheduleManager;
  personas: PersonaManager;
  conversations: ReturnType<typeof fakeConversations>;
  notes: ReturnType<typeof fakeNotes>;
  loop: ReturnType<typeof fakeLoop>;
  audit: ReturnType<typeof auditLog>;
  resolver: (persona: Persona) => PlaybookChatTarget | null;
}

function makeHarness(opts: {
  script?: LoopScript;
  resolver?: (persona: Persona) => PlaybookChatTarget | null;
  canRunTools?: boolean;
  now?: () => number;
} = {}): Harness {
  const db = openDatabase(':memory:');
  const audit = auditLog({ store: createAuditStore(db) });
  const personas = createPersonaManager({
    store: createPersonaStore(db),
    audit,
    now: opts.now,
  });
  personas.seedIfEmpty();
  const conversations = fakeConversations();
  const notes = fakeNotes();
  const loop = fakeLoop(opts.script ?? [DONE]);
  const resolver = opts.resolver ?? (() => ({ client: {}, model: 'demo' } as PlaybookChatTarget));
  const manager = createScheduleManager({
    personas,
    conversations,
    notes,
    runs: createScheduleRunStore(db),
    loop,
    resolver,
    audit,
    defaultTz: 'UTC',
    now: opts.now,
    // Absent = false = text-only prompts (mirrors the manager default).
    canRunTools: () => opts.canRunTools === true,
  });
  return { manager, personas, conversations, notes, loop, audit, resolver };
}

function expectScheduleError(fn: () => Promise<unknown>, code: string): Promise<void> {
  return fn().then(
    () => {
      throw new Error(`expected ScheduleError ${code}`);
    },
    (err: unknown) => {
      expect(err).toBeInstanceOf(ScheduleError);
      expect((err as ScheduleError).code).toBe(code);
    },
  );
}

describe('runNow', () => {
  it('runs a done brief headlessly: row done + transcript + audit', async () => {
    const h = makeHarness();
    const persona = h.personas.create({
      name: 'Briefly',
      independence: { level: 'autonomous', schedules: [brief('s1')] },
    });
    const row = await h.manager.runNow(persona.id, 's1');
    expect(row.status).toBe('done');
    expect(row.personaId).toBe(persona.id);
    expect(row.scheduleId).toBe('s1');
    expect(row.model).toBe('demo');
    expect(row.error).toBeNull();
    expect(row.finishedAt).not.toBeNull();

    // One thread was auto-created; the brief + the answer both landed there.
    expect(h.conversations.creates).toHaveLength(1);
    const users = h.conversations.messages.filter((m) => m.role === 'user');
    const assistants = h.conversations.messages.filter((m) => m.role === 'assistant');
    expect(users).toHaveLength(1);
    expect(users[0]?.content).toContain('[Scheduled: Morning brief]');
    expect(assistants).toHaveLength(1);
    expect(assistants[0]?.content).toBe(DONE.text);
    expect(assistants[0]?.personaId).toBe(persona.id);

    const auditRows = h.audit.list(50);
    const runRow = auditRows.find((r) => r.action === 'schedule.run');
    expect(runRow).toBeDefined();
    const details = JSON.parse(runRow?.details ?? '{}');
    expect(details.status).toBe('done');
    expect(JSON.stringify(auditRows)).not.toContain('Review yesterday');
    expect(JSON.stringify(auditRows)).not.toContain(DONE.text);
  });

  it('auto-creates the schedule thread once and reuses it on later runs', async () => {
    const h = makeHarness();
    const persona = h.personas.create({
      name: 'Briefly',
      independence: { level: 'autonomous', schedules: [brief('s1')] },
    });
    const first = await h.manager.runNow(persona.id, 's1');
    const second = await h.manager.runNow(persona.id, 's1');
    expect(first.conversationId).toBe(second.conversationId);
    expect(first.conversationId).not.toBeNull();
    expect(h.conversations.creates).toHaveLength(1);
    expect(h.conversations.messages).toHaveLength(4); // 2 user + 2 assistant
  });

  it('targets an explicit existing conversation when one is set', async () => {
    const conversations = fakeConversations(['conv-custom']);
    const db = openDatabase(':memory:');
    const audit = auditLog({ store: createAuditStore(db) });
    const personas = createPersonaManager({ store: createPersonaStore(db), audit });
    const notes = fakeNotes();
    const manager = createScheduleManager({
      personas,
      conversations,
      notes,
      runs: createScheduleRunStore(db),
      loop: fakeLoop([DONE]),
      resolver: () => ({ client: {}, model: 'demo' } as PlaybookChatTarget),
      audit,
    });
    const persona = personas.create({
      name: 'Targeted',
      independence: {
        level: 'autonomous',
        schedules: [brief('s1', { conversationId: 'conv-custom' })],
      },
    });
    const row = await manager.runNow(persona.id, 's1');
    expect(row.conversationId).toBe('conv-custom');
    expect(conversations.creates).toHaveLength(0);
    expect(conversations.messages.every((m) => m.conversationId === 'conv-custom')).toBe(true);
  });

  it('auto-creates a fresh thread when the stored conversation was deleted', async () => {
    const h = makeHarness();
    const persona = h.personas.create({
      name: 'Briefly',
      independence: {
        level: 'autonomous',
        schedules: [brief('s1', { conversationId: 'conv-gone' })],
      },
    });
    const row = await h.manager.runNow(persona.id, 's1');
    // dangling explicit target falls back to auto-create
    expect(row.conversationId).not.toBe('conv-gone');
    expect(h.conversations.creates).toHaveLength(1);
  });

  it('guards: paused, wrong level, unknown persona/schedule, no provider', async () => {
    const h = makeHarness({ resolver: () => null });
    const persona = h.personas.create({
      name: 'Guarded',
      independence: { level: 'suggest', schedules: [brief('s1')] },
    });
    // level below auto
    await expectScheduleError(() => h.manager.runNow(persona.id, 's1'), 'level_refused');
    // paused (auto level but paused)
    h.personas.update(persona.id, { independence: { level: 'autonomous' } });
    h.personas.pause(persona.id);
    await expectScheduleError(() => h.manager.runNow(persona.id, 's1'), 'persona_paused');
    h.personas.resume(persona.id);
    // no provider
    await expectScheduleError(() => h.manager.runNow(persona.id, 's1'), 'no_provider');
    // unknown ids
    await expectScheduleError(() => h.manager.runNow('nope', 's1'), 'not_found');
    await expectScheduleError(() => h.manager.runNow(persona.id, 'nope'), 'not_found');
  });

  it('writes the brief as a user turn and then queues on a queued tool', async () => {
    const h = makeHarness({ script: [QUEUED] });
    const persona = h.personas.create({
      name: 'Queued',
      independence: { level: 'autonomous', schedules: [brief('s1')] },
    });
    const row = await h.manager.runNow(persona.id, 's1');
    expect(row.status).toBe('queued');
    expect(row.pendingId).toBe('pending-1');
    expect(h.manager.getRun(row.id)?.live).toBe(true);
    // only the user brief persisted — no assistant answer yet
    expect(h.conversations.messages.filter((m) => m.role === 'assistant')).toHaveLength(0);
    expect(h.conversations.messages.filter((m) => m.role === 'user')).toHaveLength(1);
  });
});

describe('approval decide → auto-resume', () => {
  it('resumes a queued run headlessly after the approval was decided', async () => {
    const h = makeHarness({ script: [QUEUED, DONE] });
    const persona = h.personas.create({
      name: 'Resumer',
      independence: { level: 'autonomous', schedules: [brief('s1')] },
    });
    const row = await h.manager.runNow(persona.id, 's1');
    expect(row.status).toBe('queued');

    // Unknown pending rows are not ours.
    expect(h.manager.tryResumeAfterDecision('pending-unknown')).toBe(false);

    // The decide hook fires after broker.decide ran.
    expect(h.manager.tryResumeAfterDecision('pending-1')).toBe(true);
    expect(h.loop.calls.map((c) => c.kind)).toEqual(['run', 'resume']);

    // Resume is in-process and awaited by the test via a microtask drain.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const after = h.manager.getRun(row.id);
    expect(after?.status).toBe('done');
    expect(after?.pendingId).toBeNull();
    expect(after?.rounds).toBe(DONE.rounds);
    const assistants = h.conversations.messages.filter((m) => m.role === 'assistant');
    expect(assistants).toHaveLength(1);
    expect(assistants[0]?.content).toBe(DONE.text);
    const resumeAudit = h.audit.list(50).find((r) => r.action === 'schedule.resume');
    expect(resumeAudit).toBeDefined();
  });

  it('resume completion saves the note when the schedule has saveNote', async () => {
    const h = makeHarness({ script: [QUEUED, DONE] });
    const persona = h.personas.create({
      name: 'Note resumer',
      independence: {
        level: 'autonomous',
        schedules: [brief('s1', { saveNote: true })],
      },
    });
    const row = await h.manager.runNow(persona.id, 's1');
    expect(row.status).toBe('queued');
    expect(h.manager.tryResumeAfterDecision('pending-1')).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const after = h.manager.getRun(row.id);
    expect(after?.status).toBe('done');
    // saveNote is honored on the RESUME-completed path (schedule carried).
    expect(h.notes.created).toEqual([{ title: 'Morning brief' }]);
    const resumeAudit = h.audit.list(50).find((r) => r.action === 'schedule.resume');
    const details = JSON.parse(resumeAudit?.details ?? '{}');
    expect(details.scheduleId).toBe('s1');
  });

  it('refuses resume terminally when the persona is paused (kill switch)', async () => {
    const h = makeHarness({ script: [QUEUED] });
    const persona = h.personas.create({
      name: 'Paused mid-run',
      independence: { level: 'autonomous', schedules: [brief('s1')] },
    });
    await h.manager.runNow(persona.id, 's1');
    h.personas.pause(persona.id);
    expect(h.manager.tryResumeAfterDecision('pending-1')).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const after = h.manager.getRun(h.loop.calls[0]?.runId as string);
    expect(after?.status).toBe('error');
    expect(after?.error).toBe('persona_paused');
  });
});

describe('tick cadence', () => {
  const at = Date.UTC(2026, 0, 1, 0, 0, 0); // fixed base
  const clock = (() => {
    let t = at;
    return {
      value: (): number => t,
      advance(ms: number): void {
        t += ms;
      },
    };
  })();

  it('fires each interval window once — no storms, no missed window catch-up beyond one', async () => {
    const h = makeHarness({ now: clock.value });
    const persona = h.personas.create({
      name: 'Ticker',
      independence: { level: 'auto', schedules: [brief('s1')] },
    });
    const created = persona.createdAt; // base + seed offset... clock starts at base
    expect(created).toBe(at);

    // anchor = persona createdAt → first fire at +5 min
    clock.advance(4 * 60_000);
    expect(await h.manager.tick()).toEqual([]); // 4 min < 5 min
    clock.advance(60_000); // exactly 5 min
    const first = await h.manager.tick();
    expect(first).toHaveLength(1);
    clock.advance(1_000); // 1s later — same window must NOT refire
    expect(await h.manager.tick()).toEqual([]);
    clock.advance(5 * 60_000); // past the next rolling window (+5 min)
    const second = await h.manager.tick();
    expect(second).toHaveLength(1);
    const rows = h.manager.listRuns({ personaId: persona.id });
    expect(rows).toHaveLength(2);
    expect(rows[0]!.startedAt - rows[1]!.startedAt).toBeGreaterThanOrEqual(5 * 60_000);
  });

  it('skips disabled schedules, paused personas and non-auto levels quietly', async () => {
    const h = makeHarness({ now: clock.value });
    const paused = h.personas.create({
      name: 'Paused one',
      independence: { level: 'autonomous', schedules: [brief('p1')] },
    });
    h.personas.pause(paused.id);
    const assist = h.personas.create({
      name: 'Assist one',
      independence: { level: 'assist', schedules: [brief('a1')] },
    });
    const disabled = h.personas.create({
      name: 'Disabled one',
      independence: { level: 'autonomous', schedules: [brief('d1', { enabled: false })] },
    });
    void assist;
    void disabled;
    clock.advance(10 * 60_000);
    expect(await h.manager.tick()).toEqual([]);
    expect(h.manager.listRuns({ personaId: paused.id })).toHaveLength(0);
    expect(h.audit.list(50).filter((r) => r.action === 'schedule.skip')).toHaveLength(0);
  });

  it('fires two due schedules of one persona serially in one tick', async () => {
    const h = makeHarness({ now: clock.value });
    const persona = h.personas.create({
      name: 'Double',
      independence: {
        level: 'autonomous',
        schedules: [brief('s1'), brief('s2', { label: 'Second' })],
      },
    });
    void persona;
    clock.advance(5 * 60_000);
    const fired = await h.manager.tick();
    expect(fired).toHaveLength(2);
    expect(h.conversations.creates).toHaveLength(2);
  });

  it('saveNote persists the final answer under the label', async () => {
    const h = makeHarness({ script: [DONE] });
    const persona = h.personas.create({
      name: 'Note saver',
      independence: {
        level: 'autonomous',
        schedules: [brief('s1', { saveNote: true })],
      },
    });
    await h.manager.runNow(persona.id, 's1');
    expect(h.notes.created).toEqual([{ title: 'Morning brief' }]);
  });
});

describe('M14 tool-grammar gating (live-walk fix)', () => {
  const systemOf = (h: Harness): string | undefined => {
    const run = h.loop.calls.find((call) => call.kind === 'run');
    return run?.messages?.[0]?.content;
  };

  it('defaults to a text-only system prompt — no tool grammar advertised', async () => {
    const h = makeHarness();
    const persona = h.personas.create({
      name: 'Text brief',
      independence: { level: 'autonomous', schedules: [brief('s1')] },
    });
    await h.manager.runNow(persona.id, 's1');
    const system = systemOf(h);
    expect(system).toBeDefined();
    expect(system).not.toContain('partner:tool');
    expect(system).toContain('Do not attempt to use tools in this run');
    expect(system).toContain('Scheduled task "Morning brief"');
  });

  it('advertises the tool grammar when canRunTools() is true', async () => {
    const h = makeHarness({ canRunTools: true });
    const persona = h.personas.create({
      name: 'Tool brief',
      independence: { level: 'autonomous', schedules: [brief('s1')] },
    });
    await h.manager.runNow(persona.id, 's1');
    const system = systemOf(h);
    expect(system).toBeDefined();
    expect(system).toContain('partner:tool');
    expect(system).toContain('[[partner:tool files.read');
  });

  it('keeps the directive grammar byte-identical to the pre-gating block', async () => {
    const h = makeHarness({ canRunTools: true });
    const persona = h.personas.create({
      name: 'Tool brief',
      independence: { level: 'autonomous', schedules: [brief('s1')] },
    });
    await h.manager.runNow(persona.id, 's1');
    const system = systemOf(h) as string;
    // Every original instruction line survives verbatim inside the prompt.
    expect(system).toContain(
      'emit ONE directive per reply, on its own line, in the exact form:',
    );
    expect(system).toContain('When a tool needs human approval the run pauses automatically and resumes');
    expect(system).toContain('Produce file edits as proposals (files.edit) — never apply writes yourself.');
    expect(system).toContain('Finish with a concise summary of what you did.');
  });
});
