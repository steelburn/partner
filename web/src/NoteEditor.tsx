import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { Note } from '@partner/shared';
import type { NoteBacklink } from './lib/notes.js';
import { isSessionLost } from './lib/personas.js';
import { getBacklinks, updateNote, createNote, deleteNote } from './lib/notes.js';
import { parseTags } from './lib/note-helpers.js';
import { readStoredToken } from './lib/token.js';
import { timeAgo } from './lib/persona-helpers.js';

/**
 * Live [[wiki]] completion: the trailing token under the caret. Returns the
 * offset of the opening '[[' and the typed fragment, or null when the tail
 * of the content is not a fresh wiki-link fragment (already closed with ']'
 * or crossing a newline).
 */
function wikiSuggestion(content: string): { start: number; query: string } | null {
  const open = content.lastIndexOf('[[');
  if (open === -1) return null;
  if (open > 0 && content[open - 1] === '[') return null; // part of a longer bracket run
  const tail = content.slice(open + 2);
  if (tail.includes(']') || tail.includes('\n')) return null;
  return { start: open, query: tail.trim() };
}

/** Smallest caret-friendly uid for client-side keys/ids. */
export function uid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export interface NoteEditorProps {
  /** The note being edited; null = a brand-new note (create mode). */
  note: Note | null;
  /** Titles of existing notes, newest first — the [[ suggestion source. */
  knownTitles: readonly string[];
  /** Called after a successful create/update with the persisted note. */
  onSaved: (note: Note) => void;
  /** Called after a successful delete. */
  onDeleted: () => void;
  /** Close the editor (create cancelled / browsing away). */
  onClosed: () => void;
  /** Open another note (backlink rows). */
  onOpenOther: (id: string) => void;
  /** The core session is gone — forget the token (handled by the shell). */
  onSessionLost: () => void;
}

/**
 * M5 note editor (PLAN-M5.md): title + markdown textarea with live [[wiki]]
 * suggestion, tags input with chip preview, explicit Save (create or
 * update), two-step delete, and a backlinks panel beneath. The note body is
 * the OWNER's content: it lives in the fields and the editor only — nothing
 * here puts it in errors, notes or logs. Errors carry counts and statuses.
 */
export default function NoteEditor({
  note,
  knownTitles,
  onSaved,
  onDeleted,
  onClosed,
  onOpenOther,
  onSessionLost,
}: NoteEditorProps) {
  const [title, setTitle] = useState(note?.title ?? '');
  const [content, setContent] = useState(note?.content ?? '');
  const [tagsText, setTagsText] = useState((note?.tags ?? []).join(', '));
  const [busy, setBusy] = useState<'save' | 'delete' | null>(null);
  const [deleteArmed, setDeleteArmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [backlinks, setBacklinks] = useState<NoteBacklink[] | null>(null);
  const [backlinksError, setBacklinksError] = useState<string | null>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);

  const creating = note === null;
  const tagPreview = useMemo(() => parseTags(tagsText), [tagsText]);

  // Backlinks for the note under the editor (fetch once per open note).
  useEffect(() => {
    if (creating) {
      setBacklinks(null);
      setBacklinksError(null);
      return;
    }
    let alive = true;
    setBacklinks(null);
    setBacklinksError(null);
    const token = readStoredToken();
    if (!token) {
      onSessionLost();
      return;
    }
    void getBacklinks(token, note.id)
      .then((links) => {
        if (alive) setBacklinks(links);
      })
      .catch((cause) => {
        if (!alive) return;
        if (isSessionLost(cause)) {
          onSessionLost();
          return;
        }
        setBacklinksError(
          cause instanceof Error ? cause.message : 'Could not load backlinks.',
        );
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [creating, note?.id, onSessionLost]);

  // The [[ suggestion dropdown (titles of existing notes, newest first).
  const suggestion = useMemo(() => {
    if (dismissed) return null;
    const match = wikiSuggestion(content);
    if (match === null) return null;
    // Only suggest when the [[…]] fragment runs to the END of the document
    // (nothing but whitespace after it) — completing mid-line would silently
    // drop whatever the user typed after the bracket (M5 review finding 5).
    const afterFragment = content.slice(match.start + 2 + match.query.length);
    if (afterFragment.trim() !== '') return null;
    const lowerQuery = match.query.toLocaleLowerCase();
    const seen = new Set<string>();
    const matches: string[] = [];
    for (const title of knownTitles) {
      if (title.length === 0) continue;
      if (!title.toLocaleLowerCase().includes(lowerQuery)) continue;
      const key = title.toLocaleLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      matches.push(title);
      if (matches.length >= 6) break;
    }
    if (matches.length === 0) return null;
    return { start: match.start, matches };
  }, [content, dismissed, knownTitles]);

  const complete = (suggestionTitle: string): void => {
    if (suggestion === null) return;
    const next = `${content.slice(0, suggestion.start)}[[${suggestionTitle}]]`;
    setContent(next);
    setDismissed(true);
    requestAnimationFrame(() => {
      const textarea = textRef.current;
      if (textarea) {
        textarea.focus();
        const caret = next.length;
        textarea.setSelectionRange(caret, caret);
      }
    });
  };

  const onContentKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (suggestion === null) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      setDismissed(true);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      const first = suggestion.matches[0];
      if (first) complete(first);
    }
  };

  const save = async (): Promise<void> => {
    if (busy !== null) return;
    const trimmedTitle = title.trim();
    if (trimmedTitle.length === 0) {
      setError('Give the note a title first.');
      return;
    }
    const token = readStoredToken();
    if (!token) {
      onSessionLost();
      return;
    }
    setBusy('save');
    setError(null);
    try {
      const tags = tagPreview;
      const saved = creating
        ? await createNote(token, {
            title: trimmedTitle,
            content,
            ...(tags.length > 0 ? { tags } : {}),
          })
        : await updateNote(token, note.id, {
            title: trimmedTitle,
            content,
            ...(tags.length > 0 ? { tags } : {}),
          });
      onSaved(saved);
    } catch (cause) {
      if (isSessionLost(cause)) {
        onSessionLost();
        return;
      }
      setError(cause instanceof Error ? cause.message : 'Could not save the note.');
    } finally {
      setBusy(null);
    }
  };

  const remove = async (): Promise<void> => {
    if (busy !== null || creating) return;
    if (!deleteArmed) {
      setDeleteArmed(true);
      setError(null);
      return;
    }
    const token = readStoredToken();
    if (!token) {
      onSessionLost();
      return;
    }
    setBusy('delete');
    setError(null);
    try {
      await deleteNote(token, note.id);
      onDeleted();
    } catch (cause) {
      setDeleteArmed(false);
      if (isSessionLost(cause)) {
        onSessionLost();
        return;
      }
      setError(cause instanceof Error ? cause.message : 'Could not delete the note.');
    } finally {
      setBusy(null);
    }
  };

  const openBacklink = (id: string): void => {
    if (busy !== null) return;
    // Optimistic switch: the parent owns the fetch + error surface for the
    // newly opened note; the editor remounts against it.
    onOpenOther(id);
  };

  const dailyLabel = creating || !note.isDaily ? null : 'Daily';

  return (
    <section className="card n-editor" aria-label={creating ? 'New note' : 'Edit note'}>
      <div className="section-head">
        <h2 className="card-title">{creating ? 'New note' : 'Note'}</h2>
        {dailyLabel ? (
          <span className="chip chip-accent" aria-label="Daily note">
            {dailyLabel}
          </span>
        ) : null}
        <span className="mem-actions">
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={busy !== null}
            onClick={onClosed}
          >
            {creating ? 'Discard' : 'Close'}
          </button>
          {creating ? null : (
            <button
              type="button"
              className="btn btn-secondary btn-sm btn-danger"
              disabled={busy !== null}
              onClick={() => void remove()}
              aria-busy={busy === 'delete'}
              aria-label={
                deleteArmed ? 'Confirm deleting this note' : 'Delete this note'
              }
            >
              {busy === 'delete'
                ? 'Deleting…'
                : deleteArmed
                  ? 'Confirm delete'
                  : 'Delete'}
            </button>
          )}
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={busy !== null}
            onClick={() => void save()}
            aria-busy={busy === 'save'}
          >
            {busy === 'save' ? 'Saving…' : creating ? 'Create note' : 'Save note'}
          </button>
        </span>
      </div>

      <div className="form-stack">
        <div className="form-field">
          <label className="label" htmlFor="note-title">
            Title
          </label>
          <input
            id="note-title"
            className="field"
            type="text"
            value={title}
            disabled={busy !== null}
            onChange={(event) => {
              setTitle(event.target.value);
              setError(null);
            }}
            placeholder="Note title"
            aria-required="true"
            spellCheck={false}
          />
        </div>
        <div className="form-field">
          <label className="label" htmlFor="note-content">
            Content <span className="label-optional">(markdown)</span>
          </label>
          <div className="n-editor-body">
            <textarea
              ref={textRef}
              id="note-content"
              className="field n-editor-textarea"
              rows={12}
              value={content}
              disabled={busy !== null}
              onChange={(event) => {
                setContent(event.target.value);
                setDismissed(false);
                setError(null);
              }}
              onKeyDown={onContentKeyDown}
              placeholder="Write in markdown. Type [[ to link to another note."
            />
            {suggestion !== null ? (
              <div className="wiki-suggest" role="listbox" aria-label="Matching notes">
                <p className="wiki-suggest-title">Link to a note</p>
                {suggestion.matches.map((match) => (
                  <button
                    key={match}
                    type="button"
                    role="option"
                    className="wiki-suggest-item"
                    aria-selected="false"
                    onMouseDown={(event) => {
                      event.preventDefault(); // insert before the textarea blurs
                      complete(match);
                    }}
                  >
                    <span className="wiki-suggest-brackets">[[</span>
                    {match}
                    <span className="wiki-suggest-brackets">]]</span>
                  </button>
                ))}
              </div>
            ) : null}
          </div>
          <p className="form-hint">
            Notes that name another note with [[Title]] link to it — type [[ to see matching
            titles. Press Enter to complete, Escape to dismiss.
          </p>
        </div>
        <div className="form-field">
          <label className="label" htmlFor="note-tags">
            Tags <span className="label-optional">(comma separated)</span>
          </label>
          <input
            id="note-tags"
            className="field"
            type="text"
            value={tagsText}
            disabled={busy !== null}
            onChange={(event) => {
              setTagsText(event.target.value);
              setError(null);
            }}
            placeholder="work, ideas, trip"
            spellCheck={false}
          />
          {tagPreview.length > 0 ? (
            <span className="n-tags" aria-label={`${tagPreview.length} tag${tagPreview.length === 1 ? '' : 's'}`}>
              {tagPreview.map((tag) => (
                <span key={tag} className="chip">
                  {tag}
                </span>
              ))}
            </span>
          ) : null}
        </div>
        <div className="form-feedback" aria-live="polite">
          {error ? (
            <p className="row-error" role="alert">
              {error}
            </p>
          ) : null}
        </div>
      </div>

      {creating || note.updatedAt <= 0 ? null : (
        <p className="n-editor-meta">
          Last changed {timeAgo(note.updatedAt)}
        </p>
      )}

      {creating ? null : (
        <div className="sub-panel n-backlinks">
          <div className="sub-panel-title">Backlinks</div>
          <p className="sub-panel-copy">
            Notes that link to this one — each is one click away.
          </p>
          {backlinks === null ? (
            <p className="n-muted-line" aria-busy="true">
              Loading backlinks…
            </p>
          ) : backlinksError ? (
            <p className="row-error" role="alert">
              {backlinksError}
            </p>
          ) : backlinks.length === 0 ? (
            <p className="n-muted-line">No notes link to this note yet.</p>
          ) : (
            <ul className="n-backlink-list">
              {backlinks.map((link) => (
                <li key={link.id}>
                  <button
                    type="button"
                    className="n-backlink"
                    onClick={() => openBacklink(link.id)}
                  >
                    {link.title.length > 0 ? link.title : 'Untitled note'}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
