/**
 * M14 schedule manager (PLAN-M14.md S4/S5) — orchestration surface.
 *
 * A schedule run is an AUTONOMOUS persona tool-loop run (the same bounded
 * engine playbooks use — core/src/playbooks/loop.ts), driven headlessly: no
 * SSE consumer, no user at the keyboard. Everything lands in a conversation
 * (results + approvals live in the workspace), one `scheduled_runs` row per
 * attempt is written, and every run/resume/skip is audited (ids + counts
 * only — schedule prompts and transcript content never cross audit).
 *
 * Firing rules (PLAN-M14 "Rules"):
 *   - persona exists, NOT paused, independence auto|autonomous, schedule
 *     enabled, provider resolvable;
 *   - at most one run per schedule per tick; the anchor for nextFire is the
 *     latest run row (startedAt/finishedAt) or the persona createdAt, so a
 *     machine that was off when a window passed fires ONE catch-up run and
 *     then returns to its cadence — no storms;
 *   - a queued tool pauses the run (status 'queued' + pendingId); deciding
 *     that approval later auto-resumes in-process (tryResumeAfterDecision);
 *   - a paused persona refuses new runs AND resume (kill switch).
 *
 * Tool-grammar gating: the run's system prompt advertises the
 * [[partner:tool …]] directive grammar ONLY when the wiring's canRunTools()
 * closure reports a usable tool envelope (grants live in the broker, which
 * this manager never sees). Without an envelope a scheduled brief runs
 * text-only in one round — the live-walk fix that stopped models queueing
 * phantom files.* approvals under made-up projectIds.
 */
import { randomUUID } from 'node:crypto';
import type { Persona, PersonaSchedule } from '@partner/shared';
import type { AuditService } from '../services/redaction.js';
import type {
  ScheduleRunPatch,
  ScheduleRunRow,
  ScheduleRunStore,
} from '../stores/types.js';
import { nextFire } from './engine.js';
import { scheduleError } from './errors.js';
import type {
  LoopEvent,
  PlaybookChatTarget,
  ToolLoopResult,
} from '../playbooks/loop.js';

export type ScheduleRunReason = 'tick' | 'manual';
type FinishAction = 'schedule.run' | 'schedule.resume';

/** Minimal structural seams (real managers satisfy these; tests fake them). */
export interface PersonaLookup {
  list(): Persona[];
  get(id: string): Persona | null;
}

export interface ConversationSurface {
  /** Throw typed not_found when the conversation is gone. */
  get(id: string): unknown;
  create(input: {
    personaId?: string;
    title?: string;
    folderId?: string;
  }): { id: string };
  append(
    conversationId: string,
    role: 'user' | 'assistant' | 'system',
    input: {
      content: string;
      personaId?: string | null;
      model?: string | null;
      latencyMs?: number | null;
    },
  ): { id: string };
}

export interface NoteCreateSurface {
  create(input: { title: string; content: string }): { id: string };
}

/** The tool-loop surface the manager drives (subset of ToolLoop). */
export interface ScheduleToolLoop {
  run(req: {
    runId: string;
    persona: Persona;
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
    taskClass?: string;
    maxRounds?: number;
    target?: PlaybookChatTarget | null;
  }): AsyncGenerator<LoopEvent, ToolLoopResult, unknown>;
  resume(runId: string, pendingId: string): AsyncGenerator<LoopEvent, ToolLoopResult, unknown>;
}

export const SCHEDULE_USER_TURN_CAP = 2000;
export const SCHEDULE_NOTE_TEXT_CAP = 60_000;

export interface ScheduleManagerOptions {
  personas: PersonaLookup;
  conversations: ConversationSurface;
  notes: NoteCreateSurface;
  runs: ScheduleRunStore;
  loop: ScheduleToolLoop;
  resolver: (persona: Persona) => PlaybookChatTarget | null | Promise<PlaybookChatTarget | null>;
  /** Folder lookup for persona home-folder placement (optional). */
  folders?: { get(id: string): unknown };
  audit: AuditService;
  /** Core timezone for schedules without an explicit tz. */
  defaultTz?: string;
  /**
   * True while a usable tool envelope exists (active broker grants or persona
   * autoScopes). Decided by the wiring closure — grants live in the broker,
   * which this manager never sees. When false (default) the run prompt is
   * text-only and never advertises the tool directive grammar.
   */
  canRunTools?: () => boolean;
  /** Injectable clock (epoch ms). */
  now?: () => number;
}

export interface ScheduleRunView extends ScheduleRunRow {
  /** Whether the run is still live (running/queued). */
  live: boolean;
}

export interface ScheduleManager {
  /** Run history, newest first (persona/schedule/status/limit filters). */
  listRuns(filter?: {
    personaId?: string;
    scheduleId?: string;
    status?: string;
    limit?: number;
  }): ScheduleRunView[];
  getRun(runId: string): ScheduleRunView | null;
  /**
   * Fire one schedule now (manual "run now"). Resolves when the headless run
   * completes (done / queued waiting on an approval / error).
   */
  runNow(personaId: string, scheduleId: string): Promise<ScheduleRunRow>;
  /**
   * Start one schedule run in the BACKGROUND and resolve as soon as the run
   * row exists (status running). The run finishes itself (rows/audit/notes
   * all land headlessly); failures are recorded on the row, never thrown.
   */
  fire(personaId: string, scheduleId: string): Promise<ScheduleRunRow>;
  /** The scheduler heartbeat: fire every due schedule serially (deterministic
   *  for tests). Returns the fired run ids. */
  tick(nowAt?: number): Promise<string[]>;
  /**
   * Decide-hook: after a persona-requested approval row was decided, resume
   * the queued scheduled run it belongs to (if any) in the background.
   * Returns true when the pending row belonged to a queued schedule run.
   */
  tryResumeAfterDecision(pendingId: string): boolean;
}

function toView(row: ScheduleRunRow): ScheduleRunView {
  return { ...row, live: row.status === 'running' || row.status === 'queued' };
}

export function createScheduleManager(options: ScheduleManagerOptions): ScheduleManager {
  const { personas, conversations, notes, runs, loop, resolver, audit } = options;
  const now = options.now ?? Date.now;
  const defaultTz = options.defaultTz ?? 'UTC';
  // Tool envelope: absent wiring = text-only scheduled runs (safe default).
  const canRunTools = options.canRunTools ?? (() => false);

  function requirePersona(personaId: string): Persona {
    const persona = personas.get(personaId);
    if (persona === null) throw scheduleError('not_found', 'persona not found');
    return persona;
  }

  function requireSchedule(persona: Persona, scheduleId: string): PersonaSchedule {
    const schedule = (persona.independence.schedules ?? []).find((s) => s.id === scheduleId);
    if (!schedule) throw scheduleError('not_found', 'schedule not found');
    return schedule;
  }

  /** Engine anchor for a schedule: latest run activity, else persona birth. */
  function anchorFor(persona: Persona, scheduleId: string): number {
    const latest = runs.list({ personaId: persona.id, scheduleId, limit: 1 })[0];
    if (!latest) return persona.createdAt;
    return latest.finishedAt ?? latest.startedAt;
  }

  function conversationExists(id: string | undefined): boolean {
    if (id === undefined) return false;
    try {
      conversations.get(id);
      return true;
    } catch {
      return false;
    }
  }

  /** One run's own thread: explicit target, else the latest run's thread if
   *  alive, else auto-create (persona-bound, home-folder aware). */
  function ensureThread(persona: Persona, schedule: PersonaSchedule, scheduleId: string): string | null {
    if (conversationExists(schedule.conversationId)) return schedule.conversationId as string;
    const latest = runs.list({ personaId: persona.id, scheduleId, limit: 1 })[0];
    if (conversationExists(latest?.conversationId ?? undefined)) {
      return latest?.conversationId as string;
    }
    const home = persona.homeFolderId;
    const homeFolder =
      home !== undefined && options.folders?.get(home) !== undefined ? home : undefined;
    const created = conversations.create({
      personaId: persona.id,
      title: schedule.label.slice(0, 60),
      ...(homeFolder !== undefined ? { folderId: homeFolder } : {}),
    });
    return created.id;
  }

  function personaVoicePrompt(persona: Persona): string {
    const prompt = persona.character.systemPrompt.trim();
    const prefix = `You are "${persona.name}" (independence level: ${persona.independence.level}).`;
    return prompt === '' ? prefix : `${prefix} ${prompt}`;
  }

  /** The directive grammar advertised when a usable tool envelope exists. */
  const TOOL_RUN_INSTRUCTIONS = [
    'You are working a SCHEDULED autonomous task. The task may need tools:',
    'emit ONE directive per reply, on its own line, in the exact form:',
    '[[partner:tool <toolId> <json-args>]]',
    'Example: [[partner:tool files.read {"projectId":"<root-id>","path":"notes.md"}]]',
    'Tool results are fed back to you; chain further directives across replies.',
    'When a tool needs human approval the run pauses automatically and resumes',
    'after the decision — do not ask about approvals in your reply text.',
    'Produce file edits as proposals (files.edit) — never apply writes yourself.',
    'Finish with a concise summary of what you did.',
  ];

  /** Text-only guidance when no tool envelope exists (live-walk fix). */
  const TEXT_ONLY_RUN_INSTRUCTIONS = [
    'You are working a SCHEDULED autonomous task. Produce a complete, concrete',
    'answer directly in your reply. Do not attempt to use tools in this run.',
  ];

  /** Deterministic scheduled-run instruction block (mirrors playbooks). */
  function runPrompt(persona: Persona, schedule: PersonaSchedule): string {
    return [
      personaVoicePrompt(persona),
      '',
      ...(canRunTools() ? TOOL_RUN_INSTRUCTIONS : TEXT_ONLY_RUN_INSTRUCTIONS),
      '',
      `Scheduled task "${schedule.label}":`,
      schedule.prompt,
    ].join('\n');
  }

  /** Best-effort persistence: a failure is logged redacted, never fatal. */
  function safe(what: string, fn: () => void): void {
    try {
      fn();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line no-console
      console.error(`[partner-core] schedule ${what} failed:`, message);
    }
  }

  /** Terminal bookkeeping for run + resume outcomes (mirrors playbooks). */
  function finishRun(
    rowId: string,
    persona: Persona,
    schedule: PersonaSchedule | null,
    conversationId: string | null,
    outcome: ToolLoopResult,
    action: FinishAction,
    reason: ScheduleRunReason,
  ): ScheduleRunRow {
    const at = now();
    let noteId: string | undefined;
    if (outcome.status === 'queued') {
      runs.update(rowId, {
        status: 'queued',
        pendingId: outcome.pendingId ?? null,
        toolCalls: outcome.toolCalls,
        rounds: outcome.rounds,
        model: outcome.model,
      });
    } else if (outcome.status === 'no_provider') {
      runs.update(rowId, {
        status: 'error',
        pendingId: null,
        toolCalls: outcome.toolCalls,
        rounds: outcome.rounds,
        finishedAt: at,
        error: 'no_provider',
      });
    } else if (outcome.status === 'done') {
      runs.update(rowId, {
        status: 'done',
        pendingId: null,
        toolCalls: outcome.toolCalls,
        rounds: outcome.rounds,
        model: outcome.model,
        finishedAt: at,
        error: null,
      });
      // Transcript: a done run's final answer lands in the conversation (a
      // queued run never reached a final answer — the brief turn was
      // persisted before the loop started).
      if (conversationId !== null) {
        safe('conversation persist', () => {
          conversations.append(conversationId as string, 'assistant', {
            content: outcome.text,
            personaId: persona.id,
            model: outcome.model,
            latencyMs: null,
          });
        });
      }
      // Save-as-note (schedule.saveNote).
      if (schedule?.saveNote === true && outcome.text !== '') {
        safe('note save', () => {
          const note = notes.create({
            title: schedule.label,
            content: outcome.text.slice(0, SCHEDULE_NOTE_TEXT_CAP),
          });
          noteId = note.id;
        });
      }
    } else {
      // error / loop_exhausted.
      const coded =
        outcome.status === 'loop_exhausted' ? 'loop_exhausted' : (outcome.error ?? 'error');
      runs.update(rowId, {
        status: outcome.status,
        pendingId: null,
        toolCalls: outcome.toolCalls,
        rounds: outcome.rounds,
        model: outcome.model,
        finishedAt: at,
        error: coded,
      });
    }

    audit.log('system', action, rowId, {
      personaId: persona.id,
      scheduleId: schedule?.id ?? null,
      reason,
      conversationId,
      status: outcome.status,
      toolCalls: outcome.toolCalls,
      rounds: outcome.rounds,
      ...(outcome.status === 'queued' && outcome.pendingId !== undefined
        ? { pendingId: outcome.pendingId }
        : {}),
      ...(noteId !== undefined ? { noteId } : {}),
    });
    return runs.findById(rowId) as ScheduleRunRow;
  }

  /** Consume a loop generator headlessly; returns its terminal outcome. */
  async function driveLoop(
    runId: string,
    persona: Persona,
    schedule: PersonaSchedule | null,
    conversationId: string | null,
    reason: ScheduleRunReason,
    action: FinishAction,
    generator: AsyncGenerator<unknown, ToolLoopResult, unknown>,
  ): Promise<ScheduleRunRow> {
    try {
      let outcome: ToolLoopResult | null = null;
      for (;;) {
        const step = await generator.next();
        if (step.done) {
          outcome = step.value ?? null;
          break;
        }
        // Headless: loop events are owner/audit-visible via rows — nothing
        // streams anywhere.
      }
      if (outcome === null) throw new Error('loop ended without an outcome');
      return finishRun(runId, persona, schedule, conversationId, outcome, action, reason);
    } catch (err) {
      if (err instanceof Error && 'code' in err && (err as { code?: unknown }).code !== undefined) {
        // Typed errors bubble to the caller (runNow route mapping); the row
        // stays 'running' -> the caller is responsible (preflight failures
        // happen before insert).
        throw err;
      }
      const message = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line no-console
      console.error(`[partner-core] schedule ${action} failed:`, message);
      const row = runs.findById(runId);
      if (row !== undefined) {
        runs.update(runId, { status: 'error', finishedAt: now(), error: 'driver_failed' });
      }
      return runs.findById(runId) as ScheduleRunRow;
    }
  }



  /** Guards + thread + preflight + row insert + loop start (shared by the
   *  awaited runNow and the background fire). */
  async function beginRun(
    persona: Persona,
    schedule: PersonaSchedule,
    reason: ScheduleRunReason,
  ): Promise<{ runId: string; conversationId: string | null; generator: AsyncGenerator<unknown, ToolLoopResult, unknown> }> {
    if (persona.paused) {
      throw scheduleError('persona_paused', 'persona is paused — resume it before scheduled work');
    }
    const level = persona.independence.level;
    if (level !== 'auto' && level !== 'autonomous') {
      throw scheduleError(
        'level_refused',
        'scheduled runs need an auto or autonomous independence level',
      );
    }

    const runId = randomUUID();
    const at = now();
    const conversationId = ensureThread(persona, schedule, schedule.id);

    // The brief appears as a user turn in the thread (like playbook runs).
    if (conversationId !== null) {
      safe('user-turn persist', () => {
        const userText = `[Scheduled: ${schedule.label}]\n${schedule.prompt}`;
        conversations.append(conversationId as string, 'user', {
          content: userText.slice(0, SCHEDULE_USER_TURN_CAP),
          personaId: persona.id,
          model: null,
          latencyMs: null,
        });
      });
    }

    // Provider preflight — tool loops REQUIRE a real provider. Fail BEFORE
    // any row is written; the caller (tick/route) audits the skip.
    const target = await resolver(persona);
    if (target === null || target === undefined) {
      throw scheduleError('no_provider', 'no provider available for the persona');
    }

    runs.insert({
      id: runId,
      personaId: persona.id,
      scheduleId: schedule.id,
      label: schedule.label,
      status: 'running',
      conversationId,
      pendingId: null,
      toolCalls: 0,
      rounds: 0,
      model: target.model,
      startedAt: at,
      finishedAt: null,
      error: null,
    });

    const messages = [
      { role: 'system' as const, content: runPrompt(persona, schedule) },
      { role: 'user' as const, content: schedule.prompt },
    ];
    const generator = loop.run({
      runId,
      persona,
      messages,
      taskClass: 'chat',
      maxRounds: schedule.maxRounds,
      target: target as PlaybookChatTarget,
    });
    return { runId, conversationId, generator };
  }

  async function runOne(
    persona: Persona,
    schedule: PersonaSchedule,
    reason: ScheduleRunReason,
  ): Promise<ScheduleRunRow> {
    const started = await beginRun(persona, schedule, reason);
    return driveLoop(
      started.runId,
      persona,
      schedule,
      started.conversationId,
      reason,
      'schedule.run',
      started.generator,
    );
  }

  async function startRun(
    personaId: string,
    scheduleId: string,
    reason: ScheduleRunReason,
  ): Promise<ScheduleRunRow> {
    const persona = requirePersona(personaId);
    const schedule = requireSchedule(persona, scheduleId);
    return runOne(persona, schedule, reason);
  }

  return {
    listRuns(filter): ScheduleRunView[] {
      return runs.list(filter).map(toView);
    },
    getRun(runId: string): ScheduleRunView | null {
      const row = runs.findById(runId);
      return row ? toView(row) : null;
    },
    async runNow(personaId: string, scheduleId: string): Promise<ScheduleRunRow> {
      return startRun(personaId, scheduleId, 'manual');
    },
    async fire(personaId: string, scheduleId: string): Promise<ScheduleRunRow> {
      const persona = requirePersona(personaId);
      const schedule = requireSchedule(persona, scheduleId);
      const started = await beginRun(persona, schedule, 'manual');
      const row = runs.findById(started.runId);
      // Background drive — the run finishes itself; failures land on the row.
      void driveLoop(
        started.runId,
        persona,
        schedule,
        started.conversationId,
        'manual',
        'schedule.run',
        started.generator,
      );
      return row as ScheduleRunRow;
    },
    async tick(tickAt?: number): Promise<string[]> {
      const at = tickAt ?? now();
      const fired: string[] = [];
      for (const persona of personas.list()) {
        if (persona.paused) continue;
        const level = persona.independence.level;
        if (level !== 'auto' && level !== 'autonomous') continue;
        for (const schedule of persona.independence.schedules ?? []) {
          if (schedule.enabled === false) continue;
          const tz = schedule.tz ?? defaultTz;
          const next = nextFire(schedule.when, tz, anchorFor(persona, schedule.id));
          if (at < next) continue;
          try {
            const row = await runOne(persona, schedule, 'tick');
            fired.push(row.id);
          } catch (err) {
            // Due-but-skipped runs are audit-visible only — never fatal to
            // the tick (other schedules still fire).
            const code =
              err instanceof Error && 'code' in err
                ? ((err as { code?: unknown }).code as string)
                : 'error';
            audit.log('system', 'schedule.skip', persona.id, {
              scheduleId: schedule.id,
              reason: code,
            });
          }
        }
      }
      return fired;
    },
    tryResumeAfterDecision(pendingId: string): boolean {
      const row = runs.findWaitingByPending(pendingId);
      if (row === undefined) return false;
      const persona = personas.get(row.personaId);
      if (persona === null) {
        safe('resume row error', () => {
          runs.update(row.id, { status: 'error', finishedAt: now(), error: 'persona_gone' });
        });
        return true;
      }
      // Paused persona / level below auto = kill switch: the persona refuses
      // to be woken by its own approvals. The broker row is decided ONCE, so
      // this refusal is terminal — the run row is marked error to stay
      // honest (the audit trail shows the pending decision too).
      if (
        persona.paused ||
        (persona.independence.level !== 'auto' && persona.independence.level !== 'autonomous')
      ) {
        safe('resume row error', () => {
          runs.update(row.id, {
            status: 'error',
            finishedAt: now(),
            error: persona.paused ? 'persona_paused' : 'level_refused',
          });
        });
        return true;
      }
      // The schedule definition (the run row only snapshots label) — carried
      // so a resume that completes can still save-note and audit scheduleId.
      const schedule =
        (persona.independence.schedules ?? []).find((s) => s.id === row.scheduleId) ?? null;
      const generator = loop.resume(row.id, pendingId);
      void driveLoop(
        row.id,
        persona,
        schedule,
        row.conversationId,
        'tick',
        'schedule.resume',
        generator,
      );
      return true;
    },
  };
}
