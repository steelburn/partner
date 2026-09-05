/**
 * M9 playbook manager (PLAN-M9.md) — the run orchestration surface the HTTP
 * routes consume.
 *
 * A playbook run:
 *   1. resolves the persona (explicit -> conversation-bound -> default),
 *   2. composes the generic prompt (persona prompt + playbook instruction +
 *      input summary; loads note content when inputs carry a noteId),
 *   3. preflights the provider through the injected resolver (tool loops
 *      REQUIRE a provider — a null target raises no_provider -> 501 before
 *      any SSE bytes),
 *   4. streams the persona tool loop (loop.ts) as SSE events, then finishes
 *      best-effort: playbook_runs row, optional conversation transcript
 *      (conversationId given), optional save-as-note (inputs.saveNote), and
 *      playbook.run / playbook.resume audit rows (ids/status/counts only).
 *
 * Everything content-bearing stays in conversation/system messages —
 * playbook text and tool results are owner data in the UI only; rows and
 * audit carry ids, names, statuses and counts.
 */
import { randomUUID } from 'node:crypto';
import type {
  ChatMessage,
  ConversationSummary,
  NoteInput,
  Persona,
  PlaybookSummary,
} from '@partner/shared';
import type { ToolBroker } from '../broker/broker.js';
import type { PersonaManager } from '../personas/manager.js';
import type { ConversationManager } from '../conversations/manager.js';
import type { NoteManager } from '../notes/index.js';
import type { AuditService } from '../services/redaction.js';
import type { PlaybookRunStore } from '../stores/types.js';
import { playbookError } from './errors.js';
import type { LoopEvent, LoopProviderResolver, ToolLoop, ToolLoopResult } from './loop.js';
import { playbookById, isToolPlaybook, listPlaybooks as playbookRegistryList } from './registry.js';

export const RUN_INPUT_STRING_CAP = 2000;
/** Note content loaded into the run prompt is capped at this budget. */
export const RUN_NOTE_CONTENT_CAP = 6000;
/** Text deliverable cap when saving a run result as a note. */
export const RUN_NOTE_TEXT_CAP = 60_000;

export type PbEvent =
  | { type: 'run_start'; runId: string; playbookId: string; personaId: string | null }
  | LoopEvent
  | {
      type: 'run_end';
      runId: string;
      status: ToolLoopResult['status'];
      text: string;
      rounds: number;
      toolCalls: number;
      messageId?: string;
      conversationId?: string | null;
      noteId?: string | null;
      error?: string;
    };

export interface PbRunOutcome extends ToolLoopResult {
  playbookId: string;
  conversationId?: string | null;
  messageId?: string;
  noteId?: string | null;
}

export interface PreparedPlaybookRun {
  playbook: PlaybookSummary;
  persona: Persona;
  /** Full SSE event stream; the terminal run_end carries the outcome. */
  events: AsyncGenerator<PbEvent, PbRunOutcome, unknown>;
}

export interface PlaybookManagerOptions {
  broker: ToolBroker;
  personas: PersonaManager;
  conversations: ConversationManager;
  notes: NoteManager;
  runs: PlaybookRunStore;
  resolver: LoopProviderResolver;
  /** The persona tool loop engine (single execution path for every run). */
  loop: ToolLoop;
  audit: AuditService;
  /** Injectable clock (epoch ms). */
  now?: () => number;
}

export interface PlaybookManager {
  /** Registry metadata (GET /v1/playbooks). */
  listPlaybooks(): PlaybookSummary[];
  /**
   * Validate + prepare a run (persona, conversation, provider preflight, run
   * row) WITHOUT streaming. Throws typed errors the route maps to
   * 400/404/409/423/501.
   */
  prepare(input: {
    playbookId: string;
    personaId?: string;
    conversationId?: string;
    inputs: Record<string, unknown>;
  }): Promise<PreparedPlaybookRun>;
  /** Prepare a resume after a queued tool was decided. Unknown run ->
   *  not_found; queue row still open -> conflict (not_decided). */
  prepareResume(runId: string, pendingId: string): PreparedPlaybookRun;
}

interface PreparedState {
  playbook: PlaybookSummary;
  persona: Persona;
  runId: string;
  conversationId: string | null;
  inputs: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Prompt building (generic — catalog-independent)
// ---------------------------------------------------------------------------

function personaVoicePrompt(persona: Persona): string {
  const prompt = persona.character.systemPrompt.trim();
  const prefix = `You are "${persona.name}" (independence level: ${persona.independence.level}).`;
  return prompt === '' ? prefix : `${prefix} ${prompt}`;
}

function toolLoopPrompt(persona: Persona, playbook: PlaybookSummary): string {
  return [
    personaVoicePrompt(persona),
    '',
    `You are executing the "${playbook.name}" playbook: ${playbook.description}`,
    'You may act on the granted project by emitting ONE directive per reply, on its own line, in the exact form:',
    '[[partner:tool <toolId> <json-args>]]',
    'Example: [[partner:tool files.read {"projectId":"<root-id>","path":"src/index.ts"}]]',
    'Tool results are fed back to you; chain further directives across replies. Produce edits as proposals',
    '(files.edit) and NEVER apply them yourself — the user reviews and applies every write.',
  ].join('\n');
}

function textPlaybookPrompt(persona: Persona, playbook: PlaybookSummary): string {
  return [
    personaVoicePrompt(persona),
    '',
    `You are executing the "${playbook.name}" playbook: ${playbook.description}`,
    'Produce the deliverable directly in your reply (markdown). Be concrete and complete;',
    'do not invent facts or sources. Saving the result as a note is handled by the caller.',
  ].join('\n');
}

function summarizeInputValue(value: unknown, cap: number): string {
  if (typeof value === 'string') {
    return value.length > cap ? `${value.slice(0, cap)}… (${value.length} chars total)` : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => summarizeInputValue(entry, cap)).join(', ');
  }
  if (typeof value === 'object') {
    try {
      const text = JSON.stringify(value);
      return text.length > cap ? `${text.slice(0, cap)}…` : text;
    } catch {
      return '[unserializable input]';
    }
  }
  return String(value);
}

function taskText(inputs: Record<string, unknown>): string | undefined {
  for (const key of ['task', 'prompt', 'topic', 'question', 'brief']) {
    const value = inputs[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return undefined;
}

export function buildUserMessage(
  playbook: PlaybookSummary,
  inputs: Record<string, unknown>,
  noteText: string | null,
): string {
  const lines: string[] = [`Playbook: ${playbook.name}`];
  const task = taskText(inputs);
  if (task !== undefined) {
    lines.push('');
    lines.push(`Task: ${task}`);
  }
  const extra: string[] = [];
  for (const [key, value] of Object.entries(inputs)) {
    if (
      key === 'task' ||
      key === 'prompt' ||
      key === 'topic' ||
      key === 'question' ||
      key === 'brief' ||
      key === 'saveNote'
    ) {
      continue;
    }
    if (key === 'noteId') continue; // loaded content appended below
    extra.push(`${key}: ${summarizeInputValue(value, RUN_INPUT_STRING_CAP)}`);
  }
  if (extra.length > 0) {
    lines.push('');
    lines.push('Inputs:');
    lines.push(...extra);
  }
  if (noteText !== null) {
    lines.push('');
    lines.push('Referenced note content:');
    lines.push(noteText);
  }
  lines.push('');
  lines.push('Go.');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

export function createPlaybookManager(options: PlaybookManagerOptions): PlaybookManager {
  const { broker, personas, conversations, notes, runs, resolver, loop, audit } = options;
  const now = options.now ?? Date.now;

  function resolvePersona(
    requestedPersonaId: string | undefined,
    conversationId: string | null,
  ): { persona: Persona; personaId: string; conversationId: string | null } {
    let persona: Persona | null = null;
    let resolvedConversationId = conversationId;
    if (requestedPersonaId !== undefined) {
      persona = personas.get(requestedPersonaId);
      if (persona === null) throw playbookError('not_found', 'persona not found');
    } else if (conversationId !== null) {
      let summary: ConversationSummary;
      try {
        summary = conversations.get(conversationId).summary;
      } catch {
        throw playbookError('not_found', 'conversation not found');
      }
      resolvedConversationId = summary.id;
      if (summary.personaId !== null) {
        persona = personas.get(summary.personaId);
      }
    }
    if (persona === null) {
      persona = personas.list().find((p) => p.isDefault) ?? null;
    }
    if (persona === null) {
      throw playbookError(
        'invalid_input',
        'no persona selected and no default persona exists — pick a persona',
      );
    }
    return { persona, personaId: persona.id, conversationId: resolvedConversationId };
  }

  function loadNoteText(noteId: unknown): string | null {
    if (typeof noteId !== 'string' || noteId === '') return null;
    const note = notes.get(noteId);
    if (note === null) throw playbookError('not_found', 'note not found');
    const content = note.content ?? '';
    return content.length > RUN_NOTE_CONTENT_CAP
      ? `${content.slice(0, RUN_NOTE_CONTENT_CAP)}… (${content.length} chars total)`
      : content;
  }

  function buildMessages(
    playbook: PlaybookSummary,
    persona: Persona,
    inputs: Record<string, unknown>,
  ): ChatMessage[] {
    const system = isToolPlaybook(playbook.area)
      ? toolLoopPrompt(persona, playbook)
      : textPlaybookPrompt(persona, playbook);
    const noteText = loadNoteText(inputs.noteId);
    return [
      { role: 'system', content: system },
      { role: 'user', content: buildUserMessage(playbook, inputs, noteText) },
    ];
  }

  /** Terminal finishing for both run + resume outcomes (best effort). */
  function finishRun(
    state: PreparedState,
    outcome: PbRunOutcome,
    action: 'playbook.run' | 'playbook.resume',
  ): PbRunOutcome {
    const at = now();
    const safe = (what: string, fn: () => void): void => {
      try {
        fn();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[partner-core] playbook ${what} failed:`, message);
      }
    };

    if (
      outcome.status === 'done' ||
      outcome.status === 'loop_exhausted' ||
      outcome.status === 'error'
    ) {
      safe('run row update', () => {
        runs.update(state.runId, {
          status: outcome.status,
          toolCalls: outcome.toolCalls,
          finishedAt: at,
          error: outcome.status === 'error' ? (outcome.error ?? 'error') : null,
        });
      });
    } else if (outcome.status === 'queued') {
      // Still awaiting human approval: the row stays 'running' but records
      // the tool calls made so far.
      safe('run row update', () => {
        runs.update(state.runId, { toolCalls: outcome.toolCalls });
      });
    } else if (outcome.status === 'no_provider') {
      safe('run row update', () => {
        runs.update(state.runId, {
          status: 'error',
          toolCalls: outcome.toolCalls,
          finishedAt: at,
          error: 'no_provider',
        });
      });
    }

    // Transcript assistant turn (a queued run never reached a final answer;
    // the user-side transcript entry was persisted at prepare time).
    if (outcome.status === 'done' && state.conversationId !== null) {
      safe('conversation persist', () => {
        const stored = conversations.append(state.conversationId as string, 'assistant', {
          content: outcome.text,
          personaId: state.persona.id,
          model: outcome.model,
          latencyMs: null,
        });
        outcome.conversationId = state.conversationId;
        outcome.messageId = stored.id;
      });
    }

    // Save-as-note: title from the playbook name.
    if (outcome.status === 'done' && state.inputs.saveNote === true && outcome.text !== '') {
      safe('note save', () => {
        const note = notes.create({
          title: state.playbook.name,
          content: outcome.text.slice(0, RUN_NOTE_TEXT_CAP),
        } satisfies NoteInput);
        outcome.noteId = note.id;
      });
    }

    audit.log('web', action, state.playbook.id, {
      runId: state.runId,
      personaId: state.persona.id,
      conversationId: state.conversationId,
      status: outcome.status,
      toolCalls: outcome.toolCalls,
      rounds: outcome.rounds,
      ...(outcome.status === 'queued' && outcome.pendingId !== undefined
        ? { pendingId: outcome.pendingId }
        : {}),
      ...(outcome.noteId !== undefined ? { noteId: outcome.noteId } : {}),
    });
    return outcome;
  }

  /** Pipe a loop generator into PbEvents, capturing its return value. */
  async function* pipeLoop(
    source: AsyncGenerator<LoopEvent, ToolLoopResult, unknown>,
    state: PreparedState,
    action: 'playbook.run' | 'playbook.resume',
  ): AsyncGenerator<PbEvent, PbRunOutcome, unknown> {
    const iterator = source[Symbol.asyncIterator]();
    for (;;) {
      const step = await iterator.next();
      if (step.done) {
        const outcome = { ...(step.value as ToolLoopResult), playbookId: state.playbook.id };
        return finishRun(state, outcome, action);
      }
      yield step.value as LoopEvent;
    }
  }

  async function persistUserTurn(state: PreparedState, messages: ChatMessage[]): Promise<void> {
    if (state.conversationId === null) return;
    try {
      const user = messages.find((m) => m.role === 'user');
      if (user !== undefined) {
        conversations.append(state.conversationId, 'user', {
          content: user.content.slice(0, 2000),
          personaId: state.persona.id,
          model: null,
          latencyMs: null,
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[partner-core] playbook user-turn persist failed:', message);
    }
  }

  async function prepare(input: {
    playbookId: string;
    personaId?: string;
    conversationId?: string;
    inputs: Record<string, unknown>;
  }): Promise<PreparedPlaybookRun> {
    const playbook = playbookById(input.playbookId);
    if (playbook === null) throw playbookError('not_found', 'playbook not found');
    const rawInputs = input.inputs;
    if (rawInputs === null || typeof rawInputs !== 'object' || Array.isArray(rawInputs)) {
      throw playbookError('invalid_input', 'inputs must be an object');
    }
    const inputs = rawInputs as Record<string, unknown>;

    const conversationId =
      typeof input.conversationId === 'string' && input.conversationId !== ''
        ? input.conversationId
        : null;
    const resolved = resolvePersona(input.personaId, conversationId);
    const persona = resolved.persona;
    if (persona.paused) {
      throw playbookError(
        'persona_paused',
        'persona is paused — resume it before running a playbook',
      );
    }

    const messages = buildMessages(playbook, persona, inputs);

    // Provider preflight — tool loops REQUIRE a real provider (no demo/no
    // provider fallback at this boundary): fail 501 BEFORE any SSE bytes.
    const target = await resolver(persona);
    if (target === null || target === undefined) {
      throw playbookError('no_provider', 'no provider available for the persona');
    }
    // Fresh non-null bindings so the nested stream generator keeps the types
    // (TS control-flow narrowing does not cross into closures).
    const chatTarget = target;
    const personaRef = persona;
    const playbookRef = playbook;

    const runId = randomUUID();
    const at = now();
    runs.insert({
      id: runId,
      playbookId: playbook.id,
      personaId: persona.id,
      conversationId: resolved.conversationId,
      status: 'running',
      toolCalls: 0,
      startedAt: at,
      finishedAt: null,
      error: null,
    });

    const state: PreparedState = {
      playbook,
      persona,
      runId,
      conversationId: resolved.conversationId,
      inputs,
    };
    void persistUserTurn(state, messages);

    async function* events(): AsyncGenerator<PbEvent, PbRunOutcome, unknown> {
      yield {
        type: 'run_start',
        runId,
        playbookId: playbookRef.id,
        personaId: personaRef.id,
      };
      const outcome = yield* pipeLoop(
        loop.run({
          runId,
          persona: personaRef,
          messages,
          allowedTools: playbookRef.allowedTools,
          playbookId: playbookRef.id,
          target: chatTarget,
        }),
        state,
        'playbook.run',
      );
      yield { type: 'run_end', ...outcome };
      return outcome;
    }

    return { playbook, persona, events: events() };
  }

  return {
    listPlaybooks: (): PlaybookSummary[] => [...playbookRegistryList()],
    prepare,
    prepareResume(runId: string, pendingId: string): PreparedPlaybookRun {
      const row = runs.findById(runId);
      if (row === undefined) throw playbookError('not_found', 'playbook run not found');
      const pending = broker.pending.get(pendingId);
      if (pending === undefined) {
        throw playbookError('not_found', 'pending approval not found');
      }
      if (pending.decidedAt === null) {
        throw playbookError('conflict', 'approval has not been decided yet');
      }
      const playbook = playbookById(row.playbookId);
      if (playbook === null) throw playbookError('not_found', 'playbook not found');
      const persona = row.personaId !== null ? personas.get(row.personaId) : null;
      if (persona === null) throw playbookError('not_found', 'run persona not found');
      const playbookRef = playbook;
      const personaRef = persona;

      const state: PreparedState = {
        playbook,
        persona,
        runId,
        conversationId: row.conversationId,
        inputs: {},
      };

      async function* events(): AsyncGenerator<PbEvent, PbRunOutcome, unknown> {
        const outcome = yield* pipeLoop(
          loop.resume(runId, pendingId),
          state,
          'playbook.resume',
        );
        yield { type: 'run_end', ...outcome };
        return outcome;
      }

      return { playbook, persona, events: events() };
    },
  };
}

