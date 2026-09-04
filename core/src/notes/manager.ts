/**
 * Note manager (M5, PLAN-M5.md §"note manager").
 *
 * Notes are the owner's local markdown: wiki-links ([[Title]]) are parsed on
 * every save and stored as resolved/dangling edge rows (note_links), tags are
 * an explicit array (JSON in the row), and every write keeps the shared
 * notes_fts mirror in step (note content searchable under note_ref). The
 * manager owns the daily-note rule (is_daily + title = UTC date, created on
 * first touch) and quick capture (first non-empty line -> title <= 120, the
 * rest -> body).
 *
 * summarizeDaily() mirrors M4's episode summarizer: demo mode — or when no
 * chat provider can be resolved — appends a deterministic placeholder to
 * today's daily note; otherwise a FIXED prompt plus the day's note titles and
 * bodies (truncated total 20k chars) goes to the provider and the first delta
 * becomes the summary paragraph. The previous '## Daily summary' section is
 * replaced when present (idempotent-ish).
 *
 * Privacy invariant (PLAN-M5, unchanged from M0-M4): note content appears in
 * responses to the OWNER only. Audit rows carry ids and lengths — never
 * titles-as-content, tags, or bodies.
 */
import { randomUUID } from 'node:crypto';
import type { Note, NoteInput, NoteLinkInfo, NotesExportBundle, NoteSummary, TagCount } from '@partner/shared';
import type { AuditService } from '../services/redaction.js';
import type { NoteLinkStore, NoteRow, NoteRowPatch, NotesFtsStore, NoteStore } from '../stores/types.js';
import { escapeFtsQuery } from '../memory/search.js';
import { noteError } from './errors.js';

/** Quick-capture title cap (PLAN-M5: first line <= 120). */
export const CAPTURE_TITLE_CAP = 120;
/** Notes search hit cap (mirrors M4 memory search). */
export const NOTES_SEARCH_CAP = 50;
/** Daily-summarize total content budget for the provider call. */
export const DAILY_SUMMARIZE_CHAR_BUDGET = 20000;
/** Marker for the replaceable summary section in the daily note body. */
export const DAILY_SUMMARY_HEADING = '## Daily summary';

/**
 * Fixed daily-summarizer instruction — NEVER user-derived (user content only
 * appears in the concatenated note payload AFTER this instruction).
 */
export const DAILY_SUMMARIZE_SYSTEM_PROMPT =
  'You are summarizing the notes the user recorded today. Write a concise ' +
  'factual summary (up to 5 sentences) of what happened today, what was ' +
  'decided, and any open follow-ups. Third person, no greeting, no preamble.';

/** A note's wiki-link titles are [[…]] brackets; inner text is trimmed. */
const WIKI_LINK_RE = /\[\[([^\]]*)\]\]/g;

/**
 * Parse every [[Title]] wiki-link in a note body. Returns the trimmed,
 * de-duplicated (case-insensitively) titles in first-appearance order.
 * Empty brackets are ignored. Exported so tests and the web layer share the
 * same parsing contract.
 */
export function parseWikiLinks(content: string): string[] {
  const seen = new Set<string>();
  const titles: string[] = [];
  for (const match of content.matchAll(WIKI_LINK_RE)) {
    const raw = match[1] ?? '';
    const title = raw.trim();
    if (title === '') continue;
    const key = title.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    titles.push(title);
  }
  return titles;
}

/** Same UTC calendar day? (epoch-ms timestamps). */
export function isSameUtcDay(a: number, b: number): boolean {
  return new Date(a).toISOString().slice(0, 10) === new Date(b).toISOString().slice(0, 10);
}

/** UTC date string for an epoch-ms timestamp (YYYY-MM-DD). */
export function utcDateString(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

export interface NoteManagerOptions {
  stores: { notes: NoteStore; links: NoteLinkStore; fts: NotesFtsStore };
  audit: AuditService;
  /** Demo mode writes the deterministic placeholder daily summary. */
  demo?: boolean;
  /**
   * Resolves the chat client (and model) for the daily summary, or null when
   * nothing usable is configured. NOT called in demo mode. A null target
   * falls back to the deterministic placeholder (mirrors M4 episodes).
   */
  providerResolver?: (() => Promise<DailySummarizeTarget | null>) | null;
  /** Injectable clock (epoch ms). */
  now?: () => number;
}

/** Partial note edit; every field validates like create. */
export type NotePatch = Partial<Pick<NoteInput, 'title' | 'content' | 'tags' | 'isDaily'>>;

/** The chat client a daily summary should ride (mirrors M4 SummarizeTarget). */
export interface DailySummarizeTarget {
  client: import('@partner/shared').ProviderClient;
  model: string;
}

export interface NoteManager {
  /** Newest updated first, tags parsed. */
  list(): NoteSummary[];
  get(id: string): Note | null;
  /** Create a note; wiki-links parsed + resolved at save time. */
  create(input: NoteInput): Note;
  /** Update + re-parse/replace wiki-links and re-index FTS. */
  update(id: string, patch: NotePatch): Note;
  /** Remove a note + its links + its FTS row. Unknown id -> not_found. */
  remove(id: string): void;
  /** The note's outgoing wiki-links (resolved/dangling) — unknown id -> not_found. */
  links(id: string): NoteLinkInfo[];
  /**
   * Notes that link TO this note (resolved id OR case-insensitive title
   * match), newest updated first, excluding the note itself.
   */
  backlinks(id: string): NoteSummary[];
  /** Full-text search over notes (ranked); empty query -> invalid_input. */
  search(q: string): Note[];
  /** Today's daily note — created on first touch (title = UTC date). */
  daily(): Note;
  /** Quick capture: first non-empty line -> title (<=120), rest -> body. */
  capture(text: unknown): Note;
  /** Summarize today's notes into the daily note body (replaces the last
   *  '## Daily summary' section when present). Returns the daily note. */
  summarizeDaily(): Promise<Note>;
  /** Owned-note export bundle (schema notes/v1) — the only content egress. */
  exportAll(): NotesExportBundle;
  /** tag -> note count across every note, count desc then tag asc. */
  listTags(): TagCount[];
}

function toSummary(row: NoteRow): NoteSummary {
  return {
    id: row.id,
    title: row.title,
    tags: parseTags(row.tags),
    isDaily: row.isDaily === 1,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toNote(row: NoteRow): Note {
  return { ...toSummary(row), content: row.content };
}

/** Row tags JSON -> string[] (''/null -> []). */
function parseTags(raw: string | null): string[] {
  if (raw === null || raw === '') return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === 'string') : [];
  } catch {
    return [];
  }
}

function serializeTags(tags: string[]): string {
  return JSON.stringify(tags);
}

/** Searchable note text = title + content (upserted under note_ref). */
export function noteSearchText(note: { title: string; content: string }): string {
  return note.content === '' ? note.title : `${note.title} ${note.content}`;
}

function requireTitle(raw: unknown): string {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw noteError('invalid_input', 'title must be a non-empty string');
  }
  return raw.trim();
}

function requireContent(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw noteError('invalid_input', 'content must be a string');
  }
  return raw;
}

function requireTags(raw: unknown): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw noteError('invalid_input', 'tags must be an array of strings');
  }
  const tags: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string') {
      throw noteError('invalid_input', 'tags must be an array of strings');
    }
    const tag = entry.trim();
    if (tag === '') continue;
    if (!tags.includes(tag)) tags.push(tag);
  }
  return tags;
}

function requireIsDaily(raw: unknown): boolean {
  if (raw === undefined) return false;
  if (typeof raw !== 'boolean') {
    throw noteError('invalid_input', 'isDaily must be a boolean');
  }
  return raw;
}

function parseBodyInput(input: unknown): {
  title: string;
  content: string;
  tags: string[];
  isDaily: boolean;
} {
  if (input === null || typeof input !== 'object') {
    throw noteError('invalid_input', 'body must be an object');
  }
  const maybe = input as { title?: unknown; content?: unknown; tags?: unknown; isDaily?: unknown };
  if (maybe.title === undefined) {
    throw noteError('invalid_input', 'title is required');
  }
  const title = requireTitle(maybe.title);
  const content = requireContent(maybe.content ?? '');
  const tags = requireTags(maybe.tags);
  const isDaily = requireIsDaily(maybe.isDaily);
  return { title, content, tags, isDaily };
}

function parsePatch(input: unknown): NotePatch {
  if (input === null || typeof input !== 'object') {
    throw noteError('invalid_input', 'body must be an object');
  }
  const maybe = input as { title?: unknown; content?: unknown; tags?: unknown; isDaily?: unknown };
  const patch: NotePatch = {};
  if (maybe.title !== undefined) patch.title = requireTitle(maybe.title);
  if (maybe.content !== undefined) patch.content = requireContent(maybe.content);
  if (maybe.tags !== undefined) patch.tags = requireTags(maybe.tags);
  if (maybe.isDaily !== undefined) patch.isDaily = requireIsDaily(maybe.isDaily);
  return patch;
}

/** Resolve parsed wiki-link titles against existing notes at save time. */
function resolveLinks(stores: { notes: NoteStore }, titles: string[]): Array<{ toNote: string | null; toTitle: string }> {
  return titles.map((toTitle) => ({
    toTitle,
    toNote: stores.notes.findIdByTitle(toTitle) ?? null,
  }));
}

/** Body without the trailing (last) '## Daily summary' section, trimmed. */
export function stripDailySummarySection(content: string): string {
  const lines = content.split('\n');
  let cut = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (/^##\s+Daily summary\s*$/.test(line.trim())) {
      cut = i;
    }
  }
  if (cut < 0) return content;
  return lines.slice(0, cut).join('\n').trimEnd();
}

/** Deterministic placeholder paragraph (PLAN-M5: 'Demo daily summary of N notes…'). */
export function demoDailySummary(noteCount: number): string {
  return `Demo daily summary of ${noteCount} note${noteCount === 1 ? '' : 's'}...`;
}

export function createNoteManager(options: NoteManagerOptions): NoteManager {
  const { stores, audit } = options;
  const demo = options.demo ?? false;
  const providerResolver = options.providerResolver ?? null;
  const now = options.now ?? Date.now;

  /** The manager's own persist path (insert + links + FTS mirror). */
  function persistNote(row: NoteRow): NoteRow {
    stores.notes.insert(row);
    stores.links.replaceForNote(row.id, resolveLinks(stores, parseWikiLinks(row.content)));
    stores.fts.upsertNote(row.id, noteSearchText(row));
    return row;
  }

  function create(input: NoteInput): Note {
    const { title, content, tags, isDaily } = parseBodyInput(input);
    const at = now();
    const row = persistNote({
      id: randomUUID(),
      title,
      content,
      tags: serializeTags(tags),
      isDaily: isDaily ? 1 : 0,
      createdAt: at,
      updatedAt: at,
    });
    const note = toNote(row);
    audit.log('web', 'note.create', row.id, {
      titleLength: note.title.length,
      contentLength: note.content.length,
      isDaily: note.isDaily,
    });
    return note;
  }

  function requireRow(id: string): NoteRow {
    const row = stores.notes.findById(id);
    if (!row) throw noteError('not_found', 'note not found');
    return row;
  }

  function update(id: string, input: NotePatch): Note {
    const row = requireRow(id);
    const patch = parsePatch(input);
    const title = patch.title !== undefined ? patch.title : row.title;
    const content = patch.content !== undefined ? patch.content : row.content;
    const tags = patch.tags !== undefined ? patch.tags : parseTags(row.tags);
    const isDaily = patch.isDaily !== undefined ? patch.isDaily : row.isDaily === 1;
    const at = now();
    const rowPatch: NoteRowPatch = { title, content, tags: serializeTags(tags), isDaily: isDaily ? 1 : 0, updatedAt: at };
    stores.notes.update(id, rowPatch);
    stores.links.replaceForNote(id, resolveLinks(stores, parseWikiLinks(content)));
    stores.fts.upsertNote(id, noteSearchText({ title, content }));
    const updated = requireRow(id);
    audit.log('web', 'note.update', id, {
      titleLength: updated.title.length,
      contentLength: updated.content.length,
    });
    return toNote(updated);
  }

  function remove(id: string): void {
    const row = requireRow(id);
    stores.notes.remove(id);
    stores.links.removeForNote(id);
    stores.fts.deleteRef('note', id);
    audit.log('web', 'note.delete', id, {
      titleLength: row.title.length,
      contentLength: row.content.length,
    });
  }

  function list(): NoteSummary[] {
    return stores.notes
      .list()
      .map(toSummary)
      .sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt);
  }

  function get(id: string): Note | null {
    const row = stores.notes.findById(id);
    return row ? toNote(row) : null;
  }

  function links(id: string): NoteLinkInfo[] {
    requireRow(id);
    return stores.links.listFrom(id).map((row) => ({ toNoteId: row.toNote, toTitle: row.toTitle }));
  }

  function backlinks(id: string): NoteSummary[] {
    const row = requireRow(id);
    const ids = stores.links.listLinkingTo(row.id, row.title).filter((from) => from !== row.id);
    const byId = new Map(stores.notes.list().map((r) => [r.id, toSummary(r)]));
    return ids
      .map((from) => byId.get(from))
      .filter((n): n is NoteSummary => n !== undefined)
      .sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt);
  }

  function search(q: string): Note[] {
    if (typeof q !== 'string' || q.trim() === '') {
      throw noteError('invalid_input', 'q must be a non-empty string');
    }
    const escaped = escapeFtsQuery(q);
    if (escaped === '') {
      throw noteError('invalid_input', 'q must be a non-empty string');
    }
    const hits = stores.fts.match(escaped, NOTES_SEARCH_CAP).filter((hit) => hit.kind === 'note');
    const out: Note[] = [];
    for (const hit of hits) {
      const row = stores.notes.findById(hit.refId);
      if (row) out.push(toNote(row));
    }
    return out;
  }

  /** Today's daily note row (is_daily + title = today OR created today). */
  function findTodayDaily(today: string): NoteRow | undefined {
    const candidates = stores.notes.list().filter((row) => row.isDaily === 1);
    return candidates.find(
      (row) => row.title === today || isSameUtcDay(row.createdAt, now()),
    );
  }

  /** Today's daily note — persisted on first touch (audit 'note.daily' once). */
  function ensureTodayDailyRow(): NoteRow {
    const at = now();
    const today = utcDateString(at);
    const existing = findTodayDaily(today);
    if (existing) return existing;
    const row = persistNote({
      id: randomUUID(),
      title: today,
      content: '',
      tags: '[]',
      isDaily: 1,
      createdAt: at,
      updatedAt: at,
    });
    audit.log('web', 'note.daily', row.id, {
      titleLength: row.title.length,
      contentLength: 0,
    });
    return row;
  }

  function daily(): Note {
    return toNote(ensureTodayDailyRow());
  }

  function capture(text: unknown): Note {
    if (typeof text !== 'string') {
      throw noteError('invalid_input', 'text must be a non-empty string');
    }
    const lines = text.split('\n');
    const firstNonEmpty = lines.findIndex((line) => line.trim() !== '');
    if (firstNonEmpty < 0) {
      throw noteError('invalid_input', 'text must be a non-empty string');
    }
    const title = (lines[firstNonEmpty] ?? '').trim().slice(0, CAPTURE_TITLE_CAP);
    const body = lines.slice(firstNonEmpty + 1).join('\n');
    const at = now();
    const row = persistNote({
      id: randomUUID(),
      title,
      content: body,
      tags: '[]',
      isDaily: 0,
      createdAt: at,
      updatedAt: at,
    });
    const note = toNote(row);
    audit.log('web', 'note.capture', row.id, {
      titleLength: note.title.length,
      contentLength: note.content.length,
    });
    return note;
  }

  /** The day's summarize sources: non-daily notes created today + today's
   *  daily note's own content (minus any previous summary section). */
  function daySources(todayDaily: NoteRow): Array<{ title: string; body: string }> {
    const today = utcDateString(now());
    const sources: Array<{ title: string; body: string }> = [];
    const dailyOwn = stripDailySummarySection(todayDaily.content);
    if (dailyOwn.trim() !== '') {
      sources.push({ title: todayDaily.title, body: dailyOwn });
    }
    for (const row of stores.notes.list()) {
      if (row.id === todayDaily.id) continue;
      if (row.isDaily === 1) continue;
      if (utcDateString(row.createdAt) !== today) continue;
      sources.push({ title: row.title, body: row.content });
    }
    return sources;
  }

  async function summarizeDaily(): Promise<Note> {
    const at = now();
    const todayDaily = ensureTodayDailyRow();
    const sources = daySources(todayDaily);
    const nonDailyCount = sources.filter((s) => s.title !== todayDaily.title).length;

    let summaryText: string;
    if (demo) {
      summaryText = demoDailySummary(nonDailyCount);
    } else {
      const target = await (providerResolver ?? (async () => null))();
      if (target === null || sources.length === 0) {
        summaryText = demoDailySummary(nonDailyCount);
      } else {
        // Concatenated note titles/bodies, total capped at the char budget.
        let joined = '';
        for (const source of sources) {
          const chunk =
            source.title === todayDaily.title
              ? source.body
              : `${source.title}\n${source.body}`;
          if (joined === '') joined = chunk;
          else if (joined.length + 1 + chunk.length <= DAILY_SUMMARIZE_CHAR_BUDGET) {
            joined += `\n\n${chunk}`;
          } else {
            break; // budget exhausted — later sources are skipped
          }
        }
        const got = await firstDeltaText(
          target.client.chatStream({
            model: target.model,
            messages: [
              { role: 'system', content: DAILY_SUMMARIZE_SYSTEM_PROMPT },
              { role: 'user', content: joined.slice(0, DAILY_SUMMARIZE_CHAR_BUDGET) },
            ],
          }),
        );
        if (got === null || got.trim() === '') {
          throw noteError('upstream', 'daily summary provider returned no text');
        }
        summaryText = got.trim();
      }
    }

    const dailyOwn = stripDailySummarySection(todayDaily.content);
    const base = dailyOwn === '' ? '' : `${dailyOwn}\n\n`;
    const content = `${base}${DAILY_SUMMARY_HEADING}\n\n${summaryText}`;
    stores.notes.update(todayDaily.id, { content, updatedAt: at });
    stores.fts.upsertNote(todayDaily.id, noteSearchText({ title: todayDaily.title, content }));
    const updated = requireRow(todayDaily.id);
    audit.log('web', 'note.summarize', updated.id, {
      titleLength: updated.title.length,
      contentLength: updated.content.length,
      noteCount: sources.length,
    });
    return toNote(updated);
  }

  function exportAll(): NotesExportBundle {
    const notes = stores.notes
      .list()
      .map(toNote)
      .sort((a, b) => a.createdAt - b.createdAt || a.updatedAt - b.updatedAt);
    return { schema: 'notes/v1', exportedAt: now(), notes };
  }

  function listTags(): TagCount[] {
    const counts = new Map<string, number>();
    for (const row of stores.notes.list()) {
      for (const tag of parseTags(row.tags)) {
        counts.set(tag, (counts.get(tag) ?? 0) + 1);
      }
    }
    return [...counts.entries()]
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count || (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0));
  }

  return { create, update, remove, list, get, links, backlinks, search, daily, capture, summarizeDaily, exportAll, listTags };
}

/** First delta event text (the whole provider reply is usually one delta). */
export async function firstDeltaText(events: AsyncIterable<import('@partner/shared').ChatEvent>): Promise<string | null> {
  for await (const event of events) {
    if (event.type === 'delta') return event.text;
    if (event.type === 'error') {
      throw noteError('upstream', 'daily summary provider stream failed');
    }
  }
  return null;
}
