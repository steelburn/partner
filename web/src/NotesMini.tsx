/**
 * M11 F6 NotesMini — the notes lane beside the chat transcript (Candidate A
 * three-zone workspace). Recents + daily + quick capture, token-driven, one
 * click away from the conversation you are having.
 */
import { useEffect, useState } from 'react';
import type { NoteSummary } from '@partner/shared';
import { listNotes } from './lib/notes.js';
import { readStoredToken } from './lib/token.js';
import { timeAgo } from './lib/persona-helpers.js';

export interface NotesMiniProps {
  active: boolean;
  onCapture: () => void;
  onOpen: () => void;
  onUnpair: () => void;
}

export function NotesMini({ active, onCapture, onOpen, onUnpair }: NotesMiniProps) {
  const [notes, setNotes] = useState<NoteSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async (): Promise<void> => {
    const token = readStoredToken();
    if (!token) {
      onUnpair();
      return;
    }
    try {
      const list = await listNotes(token);
      setNotes(
        [...list]
          .sort((a, b) => b.updatedAt - a.updatedAt)
          .slice(0, 7),
      );
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load notes.');
    }
  };

  useEffect(() => {
    if (!active) return;
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  return (
    <aside className="notes-mini" aria-label="Notes">
      <div className="notes-mini-head">
        <h2 className="notes-mini-title">Notes</h2>
        <div className="notes-mini-actions">
          <button type="button" className="btn btn-secondary btn-sm" onClick={onCapture}>
            ＋ Capture
          </button>
        </div>
      </div>
      <p className="notes-mini-intro">Notes live beside your chats — capture an idea or open the full Notes view.</p>
      {error !== null ? (
        <p className="notes-mini-note" role="alert">
          {error}
        </p>
      ) : notes === null ? (
        <p className="notes-mini-note" aria-busy="true">
          Loading notes…
        </p>
      ) : notes.length === 0 ? (
        <p className="notes-mini-note">No notes yet — capture one above or ask the partner to save a response.</p>
      ) : (
        <ul className="notes-mini-list" role="list">
          {notes.map((note) => (
            <li key={note.id} className="notes-mini-row">
              <button type="button" className="notes-mini-open" onClick={onOpen} title="Open in Notes">
                <span className="notes-mini-row-title">{note.title}</span>
                <span className="notes-mini-row-meta">{timeAgo(note.updatedAt)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <button type="button" className="btn btn-secondary btn-sm btn-block" onClick={onOpen}>
        Open Notes
      </button>
    </aside>
  );
}
