import { useEffect, useMemo, useRef, useState } from 'react';
import type { BrainstormSessionSummary, Note, NoteSummary } from '@partner/shared';
import NoteEditor from './NoteEditor.js';
import { isSessionLost } from './lib/personas.js';
import { readStoredToken } from './lib/token.js';
import { timeAgo } from './lib/persona-helpers.js';
import { clampText } from './lib/memory-helpers.js';
import { downloadTextFile } from './lib/download.js';
import {
  NOTES_BUNDLE_FILE,
  noteListSort,
  notesBundleToFile,
} from './lib/note-helpers.js';
import {
  brainstormNotes,
  captureNote,
  exportNotes,
  fetchBrainstormSessions,
  getDailyNote,
  getNote,
  listNotes,
  searchNotes,
  summarizeDaily,
  type NoteSearchResult,
} from './lib/notes.js';
import NotesGraph from './NotesGraph.js';

export interface NotesSegmentProps {
  /** True while this segment is the visible one (loads on first activation). */
  active: boolean;
  /** Forget the session and return to the pairing gate (auth failure). */
  onUnpair: () => void;
  /** M11 F6: increments request opening the quick-capture composer. */
  captureSignal?: number;
  /** M16 wiki-links: open this note once the segment is visible. */
  focusNote?: { id: string; nonce: number } | null;
  /** M16 F2: open a conversation (a brainstorm kicks off its own chat). */
  onOpenConversation?: (conversationId: string) => void;
}

/** Notes list vs relationship graph pane (M16 F1). */
type NotesPane = 'list' | 'graph';

/** Editor target: brand-new note (create) or an existing note. */
type EditingState = { kind: 'new' } | { kind: 'edit'; note: Note } | null;

/**
 * M5 Notes segment (PLAN-M5.md): note list (title, tag chips, freshness),
 * full-text search over notes, quick capture, the daily note (open today +
 * summarize the day), export to JSON, and the note editor (markdown,
 * [[wiki]] completion, tags, two-step delete, backlinks). Note content is
 * the OWNER's data: it renders in the list/editor/search results only —
 * errors and feedback in this view carry titles, counts and statuses, never
 * note bodies.
 */
export default function NotesSegment({ active, onUnpair, captureSignal, focusNote, onOpenConversation }: NotesSegmentProps) {
  const [notes, setNotes] = useState<NoteSummary[] | null>(null);
  const [notesError, setNotesError] = useState<string | null>(null);
  const [sessionLost, setSessionLost] = useState(false);
  const [reloadTick, setReloadTick] = useState(0);
  const [editing, setEditing] = useState<EditingState>(null);
  const [captureOpen, setCaptureOpen] = useState(false);
  const [captureText, setCaptureText] = useState('');
  const [captureBusy, setCaptureBusy] = useState(false);
  const [captureError, setCaptureError] = useState<string | null>(null);

  // M11 F6: a global "Quick capture" action (header / Ctrl+K) opens the
  // composer whenever the increment changes.
  useEffect(() => {
    if (captureSignal !== undefined && captureSignal > 0) {
      setCaptureOpen(true);
    }
  }, [captureSignal]);
  const [dailyBusy, setDailyBusy] = useState(false);
  const [summarizeBusy, setSummarizeBusy] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searchHits, setSearchHits] = useState<NoteSearchResult[] | null>(null);
  // M16 F1/F2: list <-> graph pane, selection (checkbox mode / graph nodes)
  // and the brainstorm kick-off that opens the persona-bound conversation.
  const [pane, setPane] = useState<NotesPane>('list');
  const [multiSelect, setMultiSelect] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [brainstormBusy, setBrainstormBusy] = useState(false);
  const [brainstormSessions, setBrainstormSessions] = useState<BrainstormSessionSummary[]>([]);

  const load = async (quiet = false): Promise<void> => {
    const token = readStoredToken();
    if (!token) {
      setSessionLost(true);
      return;
    }
    if (!quiet) setNotesError(null);
    try {
      setNotes(noteListSort(await listNotes(token)));
    } catch (cause) {
      if (isSessionLost(cause)) {
        setSessionLost(true);
        return;
      }
      if (!quiet) {
        setNotesError(cause instanceof Error ? cause.message : 'Could not load notes.');
      }
    }
  };

  // Load when the segment becomes visible (and after each mutation tick).
  useEffect(() => {
    if (!active || sessionLost) return;
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, sessionLost, reloadTick]);

  const handleSessionLost = (): void => setSessionLost(true);
  const quietRefresh = (): void => setReloadTick((tick) => tick + 1);

  /** M16 follow-up: refresh the linked-brainstorm list for the selection label. */
  const loadBrainstormSessions = async (): Promise<void> => {
    const token = readStoredToken();
    if (!token) return;
    try {
      setBrainstormSessions(await fetchBrainstormSessions(token));
    } catch (cause) {
      if (isSessionLost(cause)) setSessionLost(true);
      // Non-fatal: the button falls back to the plain Brainstorm label.
    }
  };

  // Entering multi-select (the only place the label matters) refreshes the
  // linked sessions so an existing path shows "Open brainstorm" up front.
  useEffect(() => {
    if (!active || sessionLost || !multiSelect) return;
    void loadBrainstormSessions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, sessionLost, multiSelect]);

  // -------------------------------------------------------------------------
  // Note opening / saving
  // -------------------------------------------------------------------------

  const openNoteById = async (id: string): Promise<void> => {
    if (editing !== null && editing.kind === 'edit' && editing.note.id === id) return;
    const token = readStoredToken();
    if (!token) {
      handleSessionLost();
      return;
    }
    try {
      const note = await getNote(token, id);
      setEditing({ kind: 'edit', note });
      setFeedback(null);
    } catch (cause) {
      if (isSessionLost(cause)) {
        handleSessionLost();
        return;
      }
      setNotesError(cause instanceof Error ? cause.message : 'Could not open the note.');
    }
  };

  // M16 wiki-links: a chat `[[Title]]` chip asked for a note. Run once per
  // nonce, and only while this segment is visible (the Notes view may be on
  // the Plans tab — NotesView flips tabs, so `active` follows shortly).
  const handledFocusRef = useRef(0);
  useEffect(() => {
    if (!active || focusNote === undefined || focusNote === null) return;
    if (handledFocusRef.current === focusNote.nonce) return;
    handledFocusRef.current = focusNote.nonce;
    void openNoteById(focusNote.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, focusNote]);

  const openDaily = async (): Promise<void> => {
    if (dailyBusy) return;
    const token = readStoredToken();
    if (!token) {
      handleSessionLost();
      return;
    }
    setDailyBusy(true);
    setFeedback(null);
    try {
      const note = await getDailyNote(token);
      setEditing({ kind: 'edit', note });
      void load(true);
    } catch (cause) {
      if (isSessionLost(cause)) {
        handleSessionLost();
        return;
      }
      setNotesError(cause instanceof Error ? cause.message : 'Could not open today’s note.');
    } finally {
      setDailyBusy(false);
    }
  };

  const summarizeDay = async (): Promise<void> => {
    if (summarizeBusy) return;
    const token = readStoredToken();
    if (!token) {
      handleSessionLost();
      return;
    }
    setSummarizeBusy(true);
    setFeedback(null);
    try {
      await summarizeDaily(token);
      // Show the fresh daily body in the editor when it is the open note.
      if (editing !== null && editing.kind === 'edit' && editing.note.isDaily) {
        const refreshed = await getDailyNote(token);
        setEditing({ kind: 'edit', note: refreshed });
      }
      setFeedback('Day summary updated — the daily note now covers today.');
      void load(true);
    } catch (cause) {
      if (isSessionLost(cause)) {
        handleSessionLost();
        return;
      }
      setFeedback(null);
      setNotesError(cause instanceof Error ? cause.message : 'Could not summarize the day.');
    } finally {
      setSummarizeBusy(false);
    }
  };

  const capture = async (): Promise<void> => {
    if (captureBusy) return;
    const text = captureText.trim();
    if (text.length === 0) {
      setCaptureError('Type something to capture first.');
      return;
    }
    const token = readStoredToken();
    if (!token) {
      handleSessionLost();
      return;
    }
    setCaptureBusy(true);
    setCaptureError(null);
    try {
      const note = await captureNote(token, text);
      setCaptureText('');
      setCaptureOpen(false);
      setEditing({ kind: 'edit', note });
      setFeedback('Captured to your notes.');
      void load(true);
    } catch (cause) {
      if (isSessionLost(cause)) {
        handleSessionLost();
        return;
      }
      setCaptureError(cause instanceof Error ? cause.message : 'Could not capture that.');
    } finally {
      setCaptureBusy(false);
    }
  };

  const runSearch = async (): Promise<void> => {
    if (searching) return;
    const q = query.trim();
    if (q.length === 0) {
      setSearchHits(null);
      setSearchError(null);
      return;
    }
    const token = readStoredToken();
    if (!token) {
      handleSessionLost();
      return;
    }
    setSearching(true);
    setSearchError(null);
    try {
      setSearchHits(await searchNotes(token, q));
    } catch (cause) {
      if (isSessionLost(cause)) {
        handleSessionLost();
        return;
      }
      setSearchHits(null);
      setSearchError(cause instanceof Error ? cause.message : 'Could not search notes.');
    } finally {
      setSearching(false);
    }
  };

  const exportBundle = async (): Promise<void> => {
    if (exporting) return;
    const token = readStoredToken();
    if (!token) {
      handleSessionLost();
      return;
    }
    setExporting(true);
    setFeedback(null);
    try {
      const bundle = await exportNotes(token);
      downloadTextFile(NOTES_BUNDLE_FILE, notesBundleToFile(bundle));
      const count = bundle.notes.length;
      setFeedback(
        `Exported ${count} ${count === 1 ? 'note' : 'notes'} to ${NOTES_BUNDLE_FILE}.`,
      );
    } catch (cause) {
      if (isSessionLost(cause)) {
        handleSessionLost();
        return;
      }
      setFeedback(null);
      setNotesError(cause instanceof Error ? cause.message : 'Could not export notes.');
    } finally {
      setExporting(false);
    }
  };

  const sorted = notes ?? [];
  const knownTitles = sorted.map((row) => row.title);
  const busyTools = dailyBusy || summarizeBusy || exporting || captureBusy;
  const notesActivePane = active && pane === 'graph';

  // M16 follow-up: does this exact selection already have an ACTIVE brainstorm?
  // Same deterministic set key the core uses (order/duplicates ignored).
  const matchingActive = useMemo(() => {
    if (selected.size === 0) return null;
    const key = [...selected].sort().join('\u0000');
    return (
      brainstormSessions.find(
        (session) => !session.concluded && [...session.noteIds].sort().join('\u0000') === key,
      ) ?? null
    );
  }, [brainstormSessions, selected]);

  /** M16 F2: bundle the selected notes/captures into a brainstorm chat. */
  const brainstorm = async (noteIds: string[]): Promise<void> => {
    const ids = [...new Set(noteIds)].filter((id) => sorted.some((row) => row.id === id));
    if (ids.length === 0 || brainstormBusy) return;
    const token = readStoredToken();
    if (!token) {
      handleSessionLost();
      return;
    }
    setBrainstormBusy(true);
    setFeedback(null);
    setNotesError(null);
    try {
      const result = await brainstormNotes(token, ids);
      setFeedback(
        result.reused
          ? 'Reopened the existing brainstorm for this selection — the Brainstorming persona is in that chat.'
          : result.used > 0
            ? `Brainstorm opened with ${result.used} note${result.used === 1 ? '' : 's'}${
                result.truncated > 0 ? ` (${result.truncated} truncated)` : ''
              } — the Brainstorming persona is answering in that chat.`
            : 'Brainstorm opened.',
      );
      setSelected(new Set());
      setMultiSelect(false);
      // Refresh so a graph badge / linked-session row reflects the new link.
      quietRefresh();
      void loadBrainstormSessions();
      onOpenConversation?.(result.conversationId);
    } catch (cause) {
      if (isSessionLost(cause)) {
        handleSessionLost();
        return;
      }
      setNotesError(cause instanceof Error ? cause.message : 'Could not start a brainstorm.');
    } finally {
      setBrainstormBusy(false);
    }
  };

  return (
    <div className="n-segment">
      {sessionLost ? (
        <div className="memory-alert" role="alert">
          <p className="memory-alert-text">
            Your session with the Partner core has expired. Pair again to keep notes.
          </p>
          <button type="button" className="btn btn-secondary" onClick={onUnpair}>
            Pair again
          </button>
        </div>
      ) : null}

      {!sessionLost && notes === null && notesError === null ? (
        <p className="notes-loading" aria-busy="true">
          Loading notes…
        </p>
      ) : null}

      {!sessionLost && notesError !== null ? (
        <div className="memory-alert" role="alert">
          <p className="memory-alert-text">{notesError}</p>
          <button type="button" className="btn btn-secondary" onClick={() => void load()}>
            Try again
          </button>
        </div>
      ) : null}

      {!sessionLost && notes !== null ? (
        <>
          {/* Toolbar: capture / daily / summarize / export */}
          <section className="card" aria-label="Note actions">
            <div className="n-toolbar">
              <button
                type="button"
                className="btn btn-primary"
                disabled={busyTools}
                onClick={() => {
                  setCaptureOpen((open) => !open);
                  setCaptureError(null);
                }}
                aria-expanded={captureOpen}
              >
                {captureOpen ? 'Close capture' : 'Quick capture'}
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                disabled={busyTools}
                onClick={() => {
                  setEditing({ kind: 'new' });
                  setFeedback(null);
                }}
              >
                New note
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                disabled={busyTools}
                onClick={() => void openDaily()}
                aria-busy={dailyBusy}
              >
                {dailyBusy ? 'Opening…' : 'Daily note'}
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                disabled={busyTools}
                onClick={() => void summarizeDay()}
                aria-busy={summarizeBusy}
              >
                {summarizeBusy ? 'Summarizing…' : 'Summarize day'}
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                disabled={busyTools}
                onClick={() => void exportBundle()}
                aria-busy={exporting}
              >
                {exporting ? 'Exporting…' : 'Export notes'}
              </button>
              <span className="n-toolbar-sep" aria-hidden="true" />
              <button
                type="button"
                className={pane === 'list' ? 'btn btn-secondary btn-sm is-active' : 'btn btn-secondary btn-sm'}
                disabled={busyTools}
                onClick={() => setPane('list')}
                aria-pressed={pane === 'list'}
              >
                List
              </button>
              <button
                type="button"
                className={pane === 'graph' ? 'btn btn-secondary btn-sm is-active' : 'btn btn-secondary btn-sm'}
                disabled={busyTools}
                onClick={() => setPane('graph')}
                aria-pressed={pane === 'graph'}
                title="View notes and how they link (M16)"
              >
                Graph
              </button>
              {pane === 'list' && !multiSelect ? (
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  disabled={busyTools || sorted.length === 0}
                  onClick={() => setMultiSelect(true)}
                >
                  Select
                </button>
              ) : null}
              {pane === 'list' && multiSelect ? (
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  disabled={brainstormBusy || selected.size === 0}
                  onClick={() => {
                    if (matchingActive !== null) onOpenConversation?.(matchingActive.conversationId);
                    else void brainstorm([...selected]);
                  }}
                  aria-busy={brainstormBusy}
                  title={
                    matchingActive !== null
                      ? 'Open the existing brainstorm for this selection'
                      : 'Bundle the selected notes into a Brainstorming chat'
                  }
                >
                  {brainstormBusy
                    ? 'Starting…'
                    : matchingActive !== null
                      ? `Open brainstorm (${selected.size})`
                      : `Brainstorm (${selected.size})`}
                </button>
              ) : null}
            </div>
            <div className="form-feedback" aria-live="polite">
              {feedback ? <p className="success-note">{feedback}</p> : null}
            </div>
          </section>

          {/* Quick capture (collapsible) */}
          {captureOpen ? (
            <section className="card" aria-label="Quick capture">
              <div className="sub-panel-title">Quick capture</div>
              <p className="sub-panel-copy">
                One line or several — the first line becomes the title, the rest the body.
              </p>
              <div className="form-stack">
                <textarea
                  className="field"
                  rows={3}
                  value={captureText}
                  disabled={captureBusy}
                  onChange={(event) => {
                    setCaptureText(event.target.value);
                    setCaptureError(null);
                  }}
                  placeholder="Capture an idea before it goes…"
                  aria-label="Quick capture text"
                />
                <div className="form-actions">
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={captureBusy}
                    onClick={() => void capture()}
                    aria-busy={captureBusy}
                  >
                    {captureBusy ? 'Capturing…' : 'Save capture'}
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    disabled={captureBusy}
                    onClick={() => {
                      setCaptureOpen(false);
                      setCaptureError(null);
                    }}
                  >
                    Cancel
                  </button>
                </div>
                {captureError ? (
                  <p className="row-error" role="alert">
                    {captureError}
                  </p>
                ) : null}
              </div>
            </section>
          ) : null}

          {pane === 'graph' ? (
            <NotesGraph
              active={notesActivePane}
              reloadTick={reloadTick}
              onOpenNote={(id) => void openNoteById(id)}
              onBrainstorm={(ids) => void brainstorm(ids)}
              onOpenConversation={onOpenConversation}
              onUnpair={onUnpair}
              onNoteMutated={quietRefresh}
            />
          ) : (
          <>
          <section className="card" aria-label="Notes">
            <div className="section-head">
              <h2 className="card-title">Notes</h2>
              {notes.length > 0 ? (
                <span className="chip" aria-label={`${notes.length} notes`}>
                  {notes.length}
                </span>
              ) : null}
            </div>
            <p className="card-copy">
              Your markdown notes, newest first. Search, capture and the daily note live above;
              open a note to edit it.
            </p>
            {multiSelect ? (
              <div className="n-select-hint">
                Click notes to add them to the brainstorm selection.
                <button type="button" className="btn-link" onClick={() => setSelected(new Set())}>
                  Clear ({selected.size})
                </button>
                <button
                  type="button"
                  className="btn-link"
                  onClick={() => {
                    setMultiSelect(false);
                    setSelected(new Set());
                  }}
                >
                  Close
                </button>
              </div>
            ) : null}
            {notes.length === 0 ? (
              <div className="empty-state empty-inline">
                <p className="empty-state-title">No notes yet</p>
                <p className="empty-state-copy">
                  Quick-capture an idea, create a note, or open today&apos;s daily note to start
                  keeping notes with the partner.
                </p>
              </div>
            ) : (
              <ul className="n-list">
                {sorted.map((row) => {
                  const isSel = multiSelect && selected.has(row.id);
                  return (
                  <li key={row.id}>
                    <button
                      type="button"
                      className={isSel ? 'n-row is-selected' : 'n-row'}
                      onClick={() => {
                        if (multiSelect) {
                          setSelected((prev) => {
                            const next = new Set(prev);
                            if (next.has(row.id)) next.delete(row.id);
                            else next.add(row.id);
                            return next;
                          });
                        } else {
                          void openNoteById(row.id);
                        }
                      }}
                      aria-label={
                        multiSelect
                          ? `${isSel ? 'Remove' : 'Add'} ${row.title} ${isSel ? 'from' : 'to'} the brainstorm selection`
                          : `Open note ${row.title}`
                      }
                      aria-pressed={multiSelect ? isSel : undefined}
                    >
                      {multiSelect ? (
                        <span className={isSel ? 'n-check is-checked' : 'n-check'} aria-hidden="true" />
                      ) : null}
                      <span className="n-row-title">{row.title}</span>
                      {row.isDaily ? (
                        <span className="chip chip-accent">Daily</span>
                      ) : null}
                      {row.tags.length > 0 ? (
                        <span className="n-tags">
                          {row.tags.map((tag) => (
                            <span key={tag} className="chip">
                              {tag}
                            </span>
                          ))}
                        </span>
                      ) : null}
                      <span className="n-row-meta">{timeAgo(row.updatedAt)}</span>
                    </button>
                  </li>
                  );
                })}
              </ul>
            )}
          </section>

          {/* Search */}
          <section className="card" aria-label="Search notes">
            <div className="section-head">
              <h2 className="card-title">Search</h2>
            </div>
            <p className="card-copy">
              Full-text search across your notes — stored locally, ranked.
            </p>
            <form
              className="mem-search-form"
              onSubmit={(event) => {
                event.preventDefault();
                void runSearch();
              }}
            >
              <input
                className="field mem-search-input"
                type="search"
                value={query}
                placeholder="Search notes…"
                aria-label="Search notes"
                disabled={searching}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setSearchError(null);
                }}
              />
              <button
                type="submit"
                className="btn btn-secondary"
                disabled={searching}
                aria-busy={searching}
              >
                {searching ? 'Searching…' : 'Search'}
              </button>
            </form>
            {searchError ? (
              <p className="row-error" role="alert">
                {searchError}
              </p>
            ) : null}
            {searchHits !== null ? (
              searchHits.length === 0 ? (
                <p className="mem-search-empty">
                  No matches — no note contains that text.
                </p>
              ) : (
                <>
                  <ul className="n-list">
                    {searchHits.map((hit) => (
                      <li key={hit.id}>
                        <button
                          type="button"
                          className="n-row"
                          onClick={() => void openNoteById(hit.id)}
                          aria-label={`Open search result ${hit.title}`}
                        >
                          <span className="n-row-title">{hit.title}</span>
                          {hit.snippet !== null && hit.snippet.length > 0 ? (
                            <span className="n-row-snippet">{clampText(hit.snippet, 200)}</span>
                          ) : null}
                          <span className="n-row-meta">
                            {hit.tags.length > 0 ? hit.tags.join(', ') : null}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                  <p className="mem-cap-note">
                    {searchHits.length === 50
                      ? 'Showing the first 50 matches.'
                      : `${searchHits.length} ${searchHits.length === 1 ? 'match' : 'matches'}.`}
                  </p>
                </>
              )
            ) : null}
          </section>
          </>
          )}
          {/* Editor (create or edit) */}
          {editing !== null ? (
            <NoteEditor
              key={editing.kind === 'new' ? 'new' : editing.note.id}
              note={editing.kind === 'new' ? null : editing.note}
              knownTitles={knownTitles}
              onSaved={(note) => {
                setEditing({ kind: 'edit', note });
                quietRefresh();
              }}
              onDeleted={() => {
                setEditing(null);
                quietRefresh();
              }}
              onClosed={() => setEditing(null)}
              onOpenOther={(id) => void openNoteById(id)}
              onSessionLost={handleSessionLost}
            />
          ) : null}
        </>
      ) : null}
    </div>
  );
}
