/**
 * M11 F6 NotesMini — the notes lane beside the chat transcript (Candidate A
 * three-zone workspace). Recents + daily + quick capture, token-driven, one
 * click away from the conversation you are having.
 */
import { useEffect, useRef, useState } from 'react';
import type { NoteSummary } from '@partner/shared';
import { captureNote, listNotes } from './lib/notes.js';
import { readStoredToken } from './lib/token.js';
import { timeAgo } from './lib/persona-helpers.js';
import { IconChevronLeft, IconChevronRight } from './icons.js';

export interface NotesMiniProps {
  active: boolean;
  /** M12: a global quick-capture request (header ＋Note / Ctrl+K) while on
   * the Chat view opens the in-lane composer — capture stays side-by-side
   * with the transcript instead of navigating to the Notes page. */
  captureSignal?: number;
  /** M12 (P1.2/D2): lane collapse control. When collapsed the lane renders
   * as a slim strip with a single expand toggle. */
  open?: boolean;
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
  onOpen: () => void;
  onUnpair: () => void;
}

export function NotesMini({
  active,
  captureSignal = 0,
  open = true,
  collapsed = false,
  onToggleCollapsed,
  onOpen,
  onUnpair,
}: NotesMiniProps) {
  const [notes, setNotes] = useState<NoteSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [capturing, setCapturing] = useState(false);
  const [captureText, setCaptureText] = useState('');
  const [captureBusy, setCaptureBusy] = useState(false);
  const [captureError, setCaptureError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const textRef = useRef<HTMLTextAreaElement | null>(null);

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
    if (!active || !open) return;
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, open]);

  // M12: open the in-lane composer on a global capture request (Chat view).
  useEffect(() => {
    if (captureSignal > 0) {
      setCapturing(true);
      setCaptureError(null);
      setFeedback(null);
    }
  }, [captureSignal]);

  // Focus the composer when it opens AND when a repeat capture request lands
  // while the lane was collapsed (reviewer finding 3): a bumped signal with
  // capturing already true still needs the focus to move into the textarea.
  useEffect(() => {
    if (open && capturing) {
      textRef.current?.focus();
    }
  }, [open, capturing, captureSignal]);

  useEffect(() => {
    if (!capturing) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setCapturing(false);
        setCaptureError(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [capturing]);

  const capture = async (): Promise<void> => {
    if (captureBusy) return;
    const text = captureText.trim();
    if (text.length === 0) {
      setCaptureError('Type something to capture first.');
      return;
    }
    const token = readStoredToken();
    if (!token) {
      onUnpair();
      return;
    }
    setCaptureBusy(true);
    setCaptureError(null);
    try {
      const note = await captureNote(token, text);
      setCaptureText('');
      setCapturing(false);
      setFeedback(`Captured “${note.title}”.`);
      void load();
    } catch (cause) {
      setCaptureError(cause instanceof Error ? cause.message : 'Could not capture that.');
    } finally {
      setCaptureBusy(false);
    }
  };

  return (
    <aside className="notes-mini" aria-label="Notes">
      <div className="notes-mini-head">
        {onToggleCollapsed !== undefined ? (
          <button
            type="button"
            className="notes-mini-toggle"
            onClick={onToggleCollapsed}
            aria-label={collapsed ? 'Show notes lane' : 'Hide notes lane'}
            title={collapsed ? 'Show notes lane' : 'Hide notes lane'}
          >
            {collapsed ? <IconChevronRight /> : <IconChevronLeft />}
          </button>
        ) : null}
        {collapsed ? null : (
          <>
            <h2 className="notes-mini-title">Notes</h2>
            <div className="notes-mini-actions">
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => {
                  setCapturing((isOpen) => !isOpen);
                  setCaptureError(null);
                  setFeedback(null);
                }}
                disabled={captureBusy}
                aria-expanded={capturing}
              >
                {capturing ? 'Close capture' : '＋ Capture'}
              </button>
            </div>
          </>
        )}
      </div>
      {collapsed ? null : (
        <>
          <p className="notes-mini-intro">Notes live beside your chats — capture an idea or open the full Notes view.</p>
          {capturing ? (
            <div className="form-stack notes-mini-capture" aria-label="Quick capture">
              <textarea
                className="field"
                rows={3}
                ref={textRef}
                value={captureText}
                disabled={captureBusy}
                onChange={(event) => {
                  setCaptureText(event.target.value);
                  setCaptureError(null);
                }}
                placeholder="Capture an idea beside your chat…"
                aria-label="Quick capture text"
              />
              <div className="form-actions">
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  disabled={captureBusy}
                  onClick={() => void capture()}
                  aria-busy={captureBusy}
                >
                  {captureBusy ? 'Capturing…' : 'Save capture'}
                </button>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  disabled={captureBusy}
                  onClick={() => {
                    setCapturing(false);
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
          ) : null}
          {feedback ? (
            <p className="form-feedback" role="status" aria-live="polite">
              <span className="success-note">{feedback}</span>
            </p>
          ) : null}
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
        </>
      )}
    </aside>
  );
}
