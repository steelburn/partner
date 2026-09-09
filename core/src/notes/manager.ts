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
import type {
  Note,
  NoteGraph,
  NoteInput,
  NoteLinkInfo,
  NoteVersion,
  NoteVersionSummary,
  NoteVersionWriter,
  NotesExportBundle,
  NoteSummary,
  TagCount,
} from '@partner/shared';
import type { AuditService } from '../services/redaction.js';
import type {
  NoteGraphStore,
  NoteLinkRow,
  NoteLinkStore,
  NoteRow,
  NoteRowPatch,
  NotesFtsStore,
  NoteStore,
  NoteVersionRow,
  NoteVersionStore,
} from '../stores/types.js';
import { escapeFtsQuery } from '../memory/search.js';
import { noteError } from './errors.js';

/** Quick-capture title cap (PLAN-M5: first line <= 120). */
export const CAPTURE_TITLE_CAP = 120;
/** Notes search hit cap (mirrors M4 memory search). */
export const NOTES_SEARCH_CAP = 50;
/** M16 F3 (PLAN-M16.md): versions retained per note (oldest pruned). */
export const NOTE_VERSION_KEEP = 100;
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
  stores: {
    notes: NoteStore;
    links: NoteLinkStore;
    fts: NotesFtsStore;
    /** M16 F3 version snapshots (optional — harnesses without them skip). */
    versions?: NoteVersionStore;
    /** M16 F1 canvas positions (optional — graph without drag persistence). */
    graph?: NoteGraphStore;
  };
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
  create(input: NoteInput, writer?: NoteVersionWriter): Note;
  /** Update + re-parse/replace wiki-links and re-index FTS. */
  update(id: string, patch: NotePatch, writer?: NoteVersionWriter): Note;
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
  // -------------------------------------------------------------------------
  // M16 F1/F3 (PLAN-M16.md): relationship graph + version history.
  // -------------------------------------------------------------------------
  /** M16 F3: version summaries, newest first (ids/seq/timestamps only). */
  versions(noteId: string): NoteVersionSummary[];
  /** M16 F3: one full version snapshot (for diff/read/restore). */
  version(noteId: string, versionId: string): NoteVersion;
  /** M16 F3: undoable restore — snapshots current state, then applies the
   *  target version's title/content/tags to the live note. */
  restore(noteId: string, versionId: string): Note;
  /** M16 F1: nodes (all notes + persisted positions) and resolved edges with
   *  direction (referencing note -> referenced note; mutual refs collapse to
   *  one bidirectional edge). */
  graph(): NoteGraph;
  /** M16 F1: persist one dragged node position (no content timestamp bump). */
  setPosition(noteId: string, x: number, y: number): void;
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

/** M16 F3 writer-tag fallback: any stored writer string maps onto the wire
 *  union; unknown (hand-edited) values read as 'user' rather than crash. */
const VERSION_WRITERS: ReadonlySet<string> = new Set([
  'user',
  'capture',
  'promote',
  'playbook',
  'schedule',
  'summarize',
  'restore',
  'brainstorm',
]);

function toVersionWriter(raw: string): NoteVersionWriter {
  return VERSION_WRITERS.has(raw) ? (raw as NoteVersionWriter) : 'user';
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

/** Body with the trailing (last) '## Daily summary' section removed ONLY when
 *  that section is the document tail (nothing but whitespace below the
 *  heading). If the user has written content below a previous summary, the
 *  content is returned unchanged so summarizeDaily never silently deletes
 *  user text (M5 review finding 1). */
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
  const tail = lines.slice(cut + 1).join('\n');
  if (tail.trim() !== '') return content; // user content below -> keep everything
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

  /** M16 F3: snapshot the note's CURRENT state as a version row (writer
   *  tagged). No-op when versioning is not wired (harness mode). */
  function snapshotVersion(row: NoteRow, writer: NoteVersionWriter): void {
    const versions = stores.versions;
    if (!versions) return;
    versions.insert({
      id: randomUUID(),
      noteId: row.id,
      seq: versions.maxSeq(row.id) + 1,
      title: row.title,
      content: row.content,
      tags: row.tags,
      writer,
      createdAt: now(),
    });
    versions.prune(row.id, NOTE_VERSION_KEEP);
  }

  /** The manager's own persist path (insert + links + FTS mirror + first
   *  version snapshot). */
  function persistNote(row: NoteRow, writer: NoteVersionWriter = 'user'): NoteRow {
    stores.notes.insert(row);
    stores.links.replaceForNote(row.id, resolveLinks(stores, parseWikiLinks(row.content)));
    stores.fts.upsertNote(row.id, noteSearchText(row));
    snapshotVersion(row, writer);
    return row;
  }

  function create(input: NoteInput, writer: NoteVersionWriter = 'user'): Note {
    const { title, content, tags, isDaily } = parseBodyInput(input);
    const at = now();
    const row = persistNote(
      {
        id: randomUUID(),
        title,
        content,
        tags: serializeTags(tags),
        isDaily: isDaily ? 1 : 0,
        createdAt: at,
        updatedAt: at,
      },
      writer,
    );
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

  function update(id: string, input: NotePatch, writer: NoteVersionWriter = 'user'): Note {
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
    // M16 F3: version the APPLIED state (history = the note as it was after
    // each write; restore is undoable because restore snapshots first).
    snapshotVersion(requireRow(id), writer);
    const updated = requireRow(id);
    audit.log('web', 'note.update', id, {
      titleLength: updated.title.length,
      contentLength: updated.content.length,
    });
    return toNote(updated);
  }

  /** M16 F3: overwrite a note's content/title/tags + mirrors WITHOUT a fresh
   *  snapshot (used by restore after it snapshots current state). */
  function writeContent(
    id: string,
    title: string,
    content: string,
    tags: string[],
    at: number,
  ): Note {
    stores.notes.update(id, {
      title,
      content,
      tags: serializeTags(tags),
      updatedAt: at,
    });
    stores.links.replaceForNote(id, resolveLinks(stores, parseWikiLinks(content)));
    stores.fts.upsertNote(id, noteSearchText({ title, content }));
    return toNote(requireRow(id));
  }

  function remove(id: string): void {
    const row = requireRow(id);
    stores.notes.remove(id);
    stores.links.removeForNote(id);
    stores.fts.deleteRef('note', id);
    stores.versions?.removeForNote(id);
    stores.graph?.remove(id);
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
    const row = persistNote(
      {
        id: randomUUID(),
        title: today,
        content: '',
        tags: '[]',
        isDaily: 1,
        createdAt: at,
        updatedAt: at,
      },
      'user',
    );
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
    const row = persistNote(
      {
        id: randomUUID(),
        title,
        content: body,
        tags: '[]',
        isDaily: 0,
        createdAt: at,
        updatedAt: at,
      },
      'capture',
    );
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

    const currentContent = todayDaily.content;
    const stripped = stripDailySummarySection(currentContent);
    if (stripped === currentContent && /^##\s+Daily summary/m.test(currentContent)) {
      // The user wrote content below the previous auto-summary. Never delete
      // it silently: skip the rewrite (audited) and report the note unchanged.
      audit.log('web', 'note.summarize_skipped', todayDaily.id, {
        reason: 'content_below_summary',
      });
      return toNote(requireRow(todayDaily.id));
    }
    const base = stripped === '' ? '' : `${stripped}\n\n`;
    const content = `${base}${DAILY_SUMMARY_HEADING}\n\n${summaryText}`;
    stores.notes.update(todayDaily.id, { content, updatedAt: at });
    // M16 F3: version the APPLIED summarize state (writer 'summarize').
    snapshotVersion(requireRow(todayDaily.id), 'summarize');
    // Keep the wiki-link/FTS mirror in sync with the new body (M5 review).
    stores.links.replaceForNote(todayDaily.id, resolveLinks(stores, parseWikiLinks(content)));
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

  // -------------------------------------------------------------------------
  // M16 F1/F3 — relationship graph, versions, restore.
  // -------------------------------------------------------------------------

  function versions(noteId: string): NoteVersionSummary[] {
    requireRow(noteId);
    const store = stores.versions;
    if (!store) {
      throw noteError('not_found', 'version history is unavailable (not wired)');
    }
    const rows = store.listForNote(noteId);
    return rows.map((row, index) => {
      const older = rows[index + 1];
      return {
        id: row.id,
        noteId: row.noteId,
        seq: row.seq,
        createdAt: row.createdAt,
        writer: toVersionWriter(row.writer),
        titleChanged: older !== undefined && row.title !== older.title,
      };
    });
  }

  function version(noteId: string, versionId: string): NoteVersion {
    requireRow(noteId);
    const store = stores.versions;
    if (!store) {
      throw noteError('not_found', 'version history is unavailable (not wired)');
    }
    const row = store.find(noteId, versionId);
    if (!row) {
      throw noteError('not_found', 'note version not found');
    }
    const all = store.listForNote(noteId);
    const index = all.findIndex((candidate) => candidate.id === row.id);
    const older = index >= 0 ? all[index + 1] : undefined;
    return {
      id: row.id,
      noteId: row.noteId,
      seq: row.seq,
      createdAt: row.createdAt,
      writer: toVersionWriter(row.writer),
      titleChanged: older !== undefined && row.title !== older.title,
      title: row.title,
      content: row.content,
      tags: parseTags(row.tags),
    };
  }

  function restore(noteId: string, versionId: string): Note {
    const row = requireRow(noteId);
    const store = stores.versions;
    if (!store) {
      throw noteError('not_found', 'version history is unavailable (not wired)');
    }
    const target = store.find(noteId, versionId);
    if (!target) {
      throw noteError('not_found', 'note version not found');
    }
    const at = now();
    // Snapshot current state so the restore itself is undoable.
    snapshotVersion(row, 'restore');
    const updated = writeContent(noteId, target.title, target.content, parseTags(target.tags), at);
    audit.log('web', 'note.restore', noteId, {
      fromSeq: target.seq,
      titleLength: updated.title.length,
      contentLength: updated.content.length,
    });
    return updated;
  }

  function graph(): NoteGraph {
    const rows = stores.notes
      .list()
      .sort((a, b) => a.createdAt - b.createdAt || a.updatedAt - b.updatedAt);
    const positions = new Map(
      (stores.graph?.listAll() ?? []).map((p) => [p.noteId, { x: p.x, y: p.y }]),
    );
    const nodes = rows.map((row) => {
      const at = positions.get(row.id);
      return {
        id: row.id,
        title: row.title,
        tags: parseTags(row.tags),
        isDaily: row.isDaily === 1,
        x: at ? at.x : null,
        y: at ? at.y : null,
      };
    });
    const ids = new Set(rows.map((row) => row.id));
    // Adjacency for bidirectional detection: target -> set of linking sources.
    const adjacency = new Map<string, Set<string>>();
    const outgoing = new Map<string, NoteLinkRow[]>();
    for (const row of rows) {
      const links = stores.links.listFrom(row.id).filter((l) => l.toNote !== null);
      outgoing.set(row.id, links);
      for (const link of links) {
        if (link.toNote === null || link.toNote === row.id) continue;
        if (!ids.has(link.toNote)) continue;
        let sources = adjacency.get(link.toNote);
        if (!sources) {
          sources = new Set();
          adjacency.set(link.toNote, sources);
        }
        sources.add(row.id);
      }
    }
    const edges: NoteGraph['edges'] = [];
    const seen = new Set<string>();
    const key = (a: string, b: string): string => (a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`);
    for (const row of rows) {
      for (const link of outgoing.get(row.id) ?? []) {
        if (link.toNote === null || link.toNote === row.id) continue;
        if (!ids.has(link.toNote)) continue;
        const pair = key(row.id, link.toNote);
        if (seen.has(pair)) continue;
        seen.add(pair);
        const bidirectional = (adjacency.get(row.id) ?? new Set()).has(link.toNote);
        edges.push({ source: row.id, target: link.toNote, bidirectional });
      }
    }
    return { nodes, edges };
  }

  function setPosition(noteId: string, x: unknown, y: unknown): void {
    requireRow(noteId);
    if (typeof x !== 'number' || !Number.isFinite(x) || typeof y !== 'number' || !Number.isFinite(y)) {
      throw noteError('invalid_input', 'positions must be finite numbers');
    }
    if (!stores.graph) {
      throw noteError('not_found', 'graph positions are unavailable (not wired)');
    }
    stores.graph.set(noteId, x, y);
  }

  return {
    create,
    update,
    remove,
    list,
    get,
    links,
    backlinks,
    search,
    daily,
    capture,
    summarizeDaily,
    exportAll,
    listTags,
    versions,
    version,
    restore,
    graph,
    setPosition,
  };
}

/** First delta event text (the whole provider reply is usually one delta). */
export async function firstDeltaText(events: AsyncIterable<import('@partner/shared').ChatEvent>): Promise<string | null> {
  // Headless flows (daily summary, brainstorm, episodes, native analyze)
  // capture the assistant reply from the provider stream. Real streaming
  // providers emit ONE delta per token/chunk, so the reply is the JOIN of
  // every delta until the stream ends — never just the first chunk (which
  // would truncate the reply to a single token).
  let parts: string[] = [];
  for await (const event of events) {
    if (event.type === 'delta') {
      parts.push(event.text);
    } else if (event.type === 'error') {
      throw noteError('upstream', 'daily summary provider stream failed');
    }
  }
  const text = parts.join('');
  return text === '' ? null : text;
}
