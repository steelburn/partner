/**
 * M27 S1 — the app-scoped notes tool executors (`notes.list` / `notes.search` /
 * `notes.read`), PLAN-M27.md.
 *
 * WHY THIS MODULE EXISTS: every broker tool before S1 required a **project
 * root** (`broker.exec` resolved `roots.getById(projectId)`), and the user's
 * notes are not a filesystem root — so a "notes" skill was not expressible at
 * all. These executors take no root: the core-owned note store IS the scope,
 * and the broker supplies `APP_SCOPE_ID` for the grant check and the pending
 * row (never `roots.getById`).
 *
 * THREE RULES, all inherited from the file tools:
 *   1. **Shape-validate before anything else** — a malformed call is
 *      `bad_params`, never a queued approval.
 *   2. **Bounded results** — list and search are capped; a read past the char
 *      cap is `too_large` (mirroring `files.read`) rather than a silent
 *      truncation the skill would mistake for the whole note.
 *   3. **Content is an explicit read.** `list`/`search` return summaries with
 *      NO body; only `read` returns `content`. That keeps the audit summary
 *      (counts and lengths) honest by construction.
 *
 * Errors are translated from `NoteError` to typed `ToolError`s: the broker only
 * understands `ToolError`, so an untranslated `not_found` would escape as an
 * unhandled throw instead of a denied result.
 */
import type { NoteSummary } from '@partner/shared/notes.js';
import type {
  NotesListParams,
  NotesReadParams,
  NotesSearchParams,
} from '@partner/shared/tools.js';
import type { NoteManager } from '../notes/manager.js';
import { NOTES_SEARCH_CAP } from '../notes/manager.js';
import { NoteError } from '../notes/errors.js';
import { toolError } from '../broker/errors.js';

/**
 * An app-scoped executor. Deliberately NOT `ToolExecutor`: there is no
 * `ProjectRoot` to hand it, and giving it a fake one would invite a future
 * tool to read `root.path` and reach the filesystem from behind an app grant.
 */
export interface AppToolExecutor<P, R> {
  /** Shape-validate raw params -> typed params (throws bad_params). */
  validate(raw: unknown): P;
  /** Execute against the core-owned store (throws typed ToolErrors). */
  run(params: P): R;
}

/**
 * `notes.list` cap. Above the search cap on purpose: listing is the cheap
 * "what do I have" call a skill makes first, and 50 summaries is too few to be
 * useful while still being bounded.
 */
export const NOTES_LIST_CAP = 200;

/**
 * `notes.read` char cap. A note is markdown and may embed a large pasted blob,
 * so the read is bounded like `files.read` — past the cap it is `too_large`,
 * never a truncated body the skill would treat as complete.
 */
export const NOTES_TOOL_READ_CHARS = 100_000;

/** One summary as a skill sees it — ids, labels and a timestamp, no body. */
export interface NotesToolSummary {
  id: string;
  title: string;
  tags: string[];
  isDaily: boolean;
  updatedAt: number;
}

export type NotesListResult = {
  notes: NotesToolSummary[];
  /** Total notes in the store — `notes.length` may be smaller (capped). */
  total: number;
};

export type NotesSearchResult = {
  matches: NotesToolSummary[];
  /** Total hits before the cap — `matches.length` may be smaller. */
  total: number;
};

export type NotesReadResult = {
  id: string;
  title: string;
  tags: string[];
  isDaily: boolean;
  updatedAt: number;
  content: string;
};

export interface NotesTools {
  'notes.list': AppToolExecutor<NotesListParams, NotesListResult>;
  'notes.search': AppToolExecutor<NotesSearchParams, NotesSearchResult>;
  'notes.read': AppToolExecutor<NotesReadParams, NotesReadResult>;
}

function asRecord(raw: unknown): Record<string, unknown> {
  if (raw === null || raw === undefined) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw toolError('bad_params', 'params must be an object');
  }
  return raw as Record<string, unknown>;
}

/** Optional positive-integer `limit`; anything else is bad_params. */
function optionalLimit(record: Record<string, unknown>): number | undefined {
  const value = record.limit;
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw toolError('bad_params', 'limit must be a positive integer when present');
  }
  return value;
}

function clampLimit(requested: number | undefined, cap: number): number {
  return requested === undefined ? cap : Math.min(requested, cap);
}

function summaryOf(note: NoteSummary): NotesToolSummary {
  return {
    id: note.id,
    title: note.title,
    tags: note.tags,
    isDaily: note.isDaily,
    updatedAt: note.updatedAt,
  };
}

/** Translate the notes vocabulary into the tool vocabulary (fails closed). */
function translate<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof NoteError) {
      const code = err.code === 'not_found' ? 'not_found' : 'bad_params';
      throw toolError(code, err.message);
    }
    throw err;
  }
}

export interface NotesToolDeps {
  /** The same manager the /v1/notes surface uses — no second data path. */
  notes: NoteManager;
}

export function createNotesTools(deps: NotesToolDeps): NotesTools {
  const { notes } = deps;

  return {
    'notes.list': {
      validate(raw: unknown): NotesListParams {
        const record = asRecord(raw);
        const limit = optionalLimit(record);
        return limit === undefined ? {} : { limit };
      },
      run(params: NotesListParams): NotesListResult {
        return translate(() => {
          const all = notes.list();
          const capped = all.slice(0, clampLimit(params.limit, NOTES_LIST_CAP));
          return { notes: capped.map(summaryOf), total: all.length };
        });
      },
    },

    'notes.search': {
      validate(raw: unknown): NotesSearchParams {
        const record = asRecord(raw);
        const query = record.query;
        if (typeof query !== 'string' || query.trim() === '') {
          throw toolError('bad_params', 'query is required and must be a non-empty string');
        }
        const limit = optionalLimit(record);
        return limit === undefined ? { query } : { query, limit };
      },
      run(params: NotesSearchParams): NotesSearchResult {
        return translate(() => {
          const hits = notes.search(params.query);
          const capped = hits.slice(0, clampLimit(params.limit, NOTES_SEARCH_CAP));
          return { matches: capped.map(summaryOf), total: hits.length };
        });
      },
    },

    'notes.read': {
      validate(raw: unknown): NotesReadParams {
        const record = asRecord(raw);
        const id = record.id;
        if (typeof id !== 'string' || id.trim() === '') {
          throw toolError('bad_params', 'id is required and must be a non-empty string');
        }
        return { id };
      },
      run(params: NotesReadParams): NotesReadResult {
        return translate(() => {
          const note = notes.get(params.id);
          if (note === null) throw toolError('not_found', 'no such note');
          if (note.content.length > NOTES_TOOL_READ_CHARS) {
            throw toolError(
              'too_large',
              `note is larger than ${NOTES_TOOL_READ_CHARS} characters`,
            );
          }
          return {
            id: note.id,
            title: note.title,
            tags: note.tags,
            isDaily: note.isDaily,
            updatedAt: note.updatedAt,
            content: note.content,
          };
        });
      },
    },
  };
}
