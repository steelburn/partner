/**
 * M16 F2 (PLAN-M16.md): brainstorm from notes & captures.
 *
 * A brainstorm is a conversation bound to the Brainstorming persona
 * (`p-brainstorm`, seeded on demand via personaManager.ensureSeed — starter
 * seeding only fires on an empty table, so M16 must create the persona for
 * existing users at use time). The selected notes/captures (both are notes
 * rows) are bundled — capped per note and in total — into the first USER
 * turn as the brief; the persona's first ASSISTANT turn is generated
 * headlessly through the same provider seam daily summaries use, so the
 * conversation opens already kicked off. Demo mode (or no usable provider)
 * writes a deterministic placeholder instead of failing, mirroring the
 * daily-summary resolver contract.
 *
 * Privacy invariant: the bundle is conversation content (owner data). The
 * audit row here carries ids and counts only — never note bodies.
 */
import type { BrainstormRequest, BrainstormResult } from '@partner/shared';
import type { ConversationManager } from '../conversations/manager.js';
import type { PersonaManager } from '../personas/manager.js';
import type { AuditService } from '../services/redaction.js';
import { firstDeltaText } from './manager.js';
import type { DailySummarizeTarget, NoteManager } from './manager.js';

export const BRAINSTORM_PERSONA_ID = 'p-brainstorm';
/** Cap on bundled note/capture ids per brainstorm. */
export const BRAINSTORM_MAX_NOTES = 20;
/** Per-note excerpt cap (content beyond is truncated + counted). */
export const BRAINSTORM_EXCERPT_CHARS = 6000;
/** Total bundled content budget (older sources are skipped + counted). */
export const BRAINSTORM_TOTAL_CHARS = 60000;

/** Fixed brainstorm instruction — NEVER user-derived (note content only
 *  appears in the bundled payload AFTER this instruction). */
export const BRAINSTORM_SYSTEM_PROMPT =
  'You are brainstorming with the user over the notes they bundled below. ' +
  'Generate divergent ideas first, then converge: cluster related ideas, ' +
  'call out what looks worth keeping, and finish with open questions. ' +
  'Cite notes by their [[Title]]. Be concrete; no generic advice.';

/** Deterministic demo/fallback reply (mirrors demoDailySummary). */
export function demoBrainstormReply(used: number, truncated: number): string {
  const trunc = truncated > 0 ? ` (${truncated} source${truncated === 1 ? '' : 's'} truncated)` : '';
  return (
    `Demo brainstorm over ${used} bundled note${used === 1 ? '' : 's'}${trunc}:\n\n` +
    '1. Direction A — who this is for and what outcome matters.\n' +
    '2. Direction B — the smallest version that proves the idea.\n' +
    '3. Direction C — what to avoid.\n\n' +
    'Reply here to go deeper on any direction.'
  );
}

export interface BrainstormBundleResult {
  /** Full user-turn text (instruction + bundled excerpts). */
  text: string;
  /** Note ids whose excerpts were included. */
  used: number;
  /** Note ids truncated by the per-note cap or skipped by the total cap. */
  truncated: number;
}

/** Pure bundle composer — exported for tests and the shared parsing contract. */
export function buildBrainstormBundle(
  notes: ReadonlyArray<{ title: string; content: string }>,
): BrainstormBundleResult {
  let used = 0;
  let truncated = 0;
  let budget = BRAINSTORM_TOTAL_CHARS;
  const chunks: string[] = [];
  for (const note of notes) {
    const raw = note.content;
    const header = `### ${note.title}`;
    // Reserve room for the header + separator.
    if (budget < header.length + 60) {
      if (raw.length > 0) truncated += 1;
      continue;
    }
    const cap = Math.min(raw.length, BRAINSTORM_EXCERPT_CHARS);
    const take = Math.min(cap, budget - header.length - 2);
    if (take <= 0) {
      if (raw.length > 0) truncated += 1;
      continue;
    }
    const excerpt = raw.length > take ? `${raw.slice(0, take)}…` : raw;
    if (raw.length > BRAINSTORM_EXCERPT_CHARS || raw.length > take) truncated += 1;
    chunks.push(`${header}\n\n${excerpt}`);
    budget -= header.length + 2 + take;
    used += 1;
  }
  const body = chunks.join('\n\n');
  const text =
    `Brainstorm over the notes below${used === 0 ? ' (none fit the bundle budget)' : ''}. ` +
    `Generate freely; cite notes by their [[Title]].\n\n${body}`.trim();
  return { text, used, truncated };
}

/** M16 F2 brainstorm errors: 400/404/501/423/502 (loopback statuses). */
export type BrainstormErrorCode =
  | 'invalid_input'
  | 'not_found'
  | 'no_provider'
  | 'paused'
  | 'upstream';

export class BrainstormError extends Error {
  readonly code: BrainstormErrorCode;

  constructor(code: BrainstormErrorCode, message: string) {
    super(message);
    this.name = 'BrainstormError';
    this.code = code;
  }
}

export function brainstormError(code: BrainstormErrorCode, message: string): BrainstormError {
  return new BrainstormError(code, message);
}

export function brainstormErrorStatus(code: BrainstormErrorCode): number {
  switch (code) {
    case 'not_found':
      return 404;
    case 'no_provider':
      return 501;
    case 'paused':
      return 423;
    case 'upstream':
      return 502;
    default:
      return 400;
  }
}

/** Structural folder handle (validates a persona's home folder still exists). */
interface FoldersLike {
  get(id: string): unknown;
}

export interface BrainstormManagerOptions {
  personas: PersonaManager;
  conversations: ConversationManager;
  notes: NoteManager;
  /** Resolves the provider client + model for the persona's first reply;
   *  null → deterministic placeholder (mirrors daily summaries). NOT called
   *  in demo mode. */
  providerResolver: () => Promise<DailySummarizeTarget | null>;
  /** Optional folder manager: a persona home folder that no longer exists is
   *  dropped silently (chat lands in Inbox). */
  folders?: FoldersLike;
  audit: AuditService;
  demo?: boolean;
  now?: () => number;
}

export interface BrainstormManager {
  /** Kick off a brainstorm over the selected notes/captures. Returns the new
   *  conversation bound to the Brainstorming persona with the bundle seeded
   *  as its first user turn and the persona's first reply appended. */
  start(request: BrainstormRequest): Promise<BrainstormResult>;
}

export function createBrainstormManager(options: BrainstormManagerOptions): BrainstormManager {
  const { personas, conversations, notes, audit } = options;
  const demo = options.demo ?? false;

  async function start(request: BrainstormRequest): Promise<BrainstormResult> {
    const body = (request ?? {}) as BrainstormRequest;
    const rawIds = Array.isArray(body.noteIds)
      ? body.noteIds.filter((entry): entry is string => typeof entry === 'string')
      : [];
    const noteIds = [...new Set(rawIds.map((id) => id.trim()).filter((id) => id !== ''))];
    if (noteIds.length === 0) {
      throw brainstormError('invalid_input', 'noteIds must be a non-empty array');
    }
    if (noteIds.length > BRAINSTORM_MAX_NOTES) {
      throw brainstormError(
        'invalid_input',
        `noteIds are capped at ${BRAINSTORM_MAX_NOTES} notes per brainstorm`,
      );
    }
    // M16 F2: create the persona on demand (idempotent; respects edits).
    const persona = personas.ensureSeed(BRAINSTORM_PERSONA_ID);
    if (!persona) {
      throw brainstormError('no_provider', 'Brainstorming persona could not be created');
    }
    if (persona.paused) {
      throw brainstormError('paused', 'the Brainstorming persona is paused');
    }

    const bundled: Array<{ title: string; content: string }> = [];
    for (const noteId of noteIds) {
      const note = notes.get(noteId);
      if (!note) throw brainstormError('not_found', `note ${noteId} not found`);
      bundled.push({ title: note.title, content: note.content });
    }
    const bundle = buildBrainstormBundle(bundled);

    // Resolve the provider FIRST so a failing upstream never leaves a
    // dangling conversation behind (demo/placeholder path skips this).
    let reply: string;
    let model: string | null = null;
    if (!demo) {
      const target = await options.providerResolver();
      if (target === null) {
        throw brainstormError(
          'no_provider',
          'no enabled provider can serve the brainstorm — add a provider first',
        );
      }
      model = target.model;
      const system =
        persona.character.systemPrompt === ''
          ? BRAINSTORM_SYSTEM_PROMPT
          : `${persona.character.systemPrompt}\n\n${BRAINSTORM_SYSTEM_PROMPT}`;
      const got = await firstDeltaText(
        target.client.chatStream({
          model: target.model,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: bundle.text },
          ],
        }),
      );
      if (got === null || got.trim() === '') {
        throw brainstormError('upstream', 'brainstorm provider returned no text');
      }
      reply = got.trim();
    } else {
      reply = demoBrainstormReply(bundle.used, bundle.truncated);
    }

    const titleSource = bundled[0]?.title;
    const title =
      body.title !== undefined && body.title !== null && String(body.title).trim() !== ''
        ? String(body.title).slice(0, 120)
        : titleSource !== undefined
          ? `Brainstorm — ${titleSource.slice(0, 90)}`
          : 'Brainstorm';

    let folderId: string | undefined;
    if (persona.homeFolderId !== undefined && options.folders?.get(persona.homeFolderId)) {
      folderId = persona.homeFolderId;
    }

    const conversation = conversations.create({
      personaId: persona.id,
      title,
      ...(folderId !== undefined ? { folderId } : {}),
    });
    conversations.append(conversation.id, 'user', {
      content: bundle.text,
      personaId: persona.id,
    });
    conversations.append(conversation.id, 'assistant', {
      content: reply,
      personaId: persona.id,
      ...(model !== null ? { model } : {}),
    });
    audit.log('web', 'brainstorm.start', conversation.id, {
      personaId: persona.id,
      used: bundle.used,
      truncated: bundle.truncated,
    });
    return {
      conversationId: conversation.id,
      personaId: persona.id,
      used: bundle.used,
      truncated: bundle.truncated,
    };
  }

  return { start };
}
