import { useEffect, useState } from 'react';
import type { Folder, Persona } from '@partner/shared';
import NotesSegment from './NotesSegment.js';
import PlansSegment from './PlansSegment.js';

export type NotesTab = 'notes' | 'plans';

export interface NotesViewProps {
  /** Personas available as plan-task owners (null while the shell loads). */
  personas: Persona[] | null;
  /** Forget the session and return to the pairing gate (auth failure). */
  onUnpair: () => void;
  /** True while this view is the visible one. */
  active?: boolean;
  /** M11 F6: increments open the quick-capture composer (global action). */
  captureSignal?: number;
  /** M16 wiki-links: open a note requested from chat (nonce = repeat clicks). */
  focusNote?: { id: string; nonce: number } | null;
  /** M16 F2: open a conversation (brainstorm kick-off lands in a chat). */
  onOpenConversation?: (conversationId: string) => void;
  /** M17: the shared Projects/Folders tree (notes scoped to a project). */
  folders?: Folder[] | null;
  /** M17: create a project for the Notes scope selector. */
  onCreateFolder?: (name: string, parentId: string | null) => Promise<void> | void;
}

/**
 * M5 Notes view (PLAN-M5.md): two icon-less text segments — Notes (list,
 * search, quick capture, daily + summarize, export, editor with backlinks)
 * and Plans (list with progress, live planner with owners and status notes,
 * export). Both segments stay mounted so an in-progress note draft or
 * planner session survives switching between them; only the visible segment
 * loads data.
 */
export default function NotesView({ personas, onUnpair, active, captureSignal, focusNote, onOpenConversation, folders, onCreateFolder }: NotesViewProps) {
  const [tab, setTab] = useState<NotesTab>('notes');
  const notesActive = active === true && tab === 'notes';
  const plansActive = active === true && tab === 'plans';

  // A chat wiki-link must land in the editor even if the user last left the
  // view on the Plans tab.
  useEffect(() => {
    if (focusNote !== undefined && focusNote !== null) setTab('notes');
  }, [focusNote]);

  return (
    <section className="notes" aria-label="Notes and plans">
      <div className="notes-panel">
        <div className="page-head">
          <div className="page-head-titles">
            <div className="kicker">Stores</div>
            <h1 className="page-title">Notes &amp; plans</h1>
          </div>
        </div>
        <p className="page-copy">
          The stores you keep WITH the partner: markdown notes that link to each other, and
          structured plans with milestones, tasks and owners. Everything lives in the core on
          this machine.
        </p>

        <div className="seg-tabs" role="group" aria-label="Notes and plans segments">
          <button
            type="button"
            className="btn btn-secondary seg-tab"
            onClick={() => setTab('notes')}
            aria-pressed={tab === 'notes'}
          >
            Notes
          </button>
          <button
            type="button"
            className="btn btn-secondary seg-tab"
            onClick={() => setTab('plans')}
            aria-pressed={tab === 'plans'}
          >
            Plans
          </button>
        </div>

        <div className={tab === 'notes' ? 'notes-seg notes-seg-active' : 'notes-seg'}>
          <NotesSegment
            active={notesActive}
            onUnpair={onUnpair}
            captureSignal={captureSignal}
            focusNote={focusNote}
            onOpenConversation={onOpenConversation}
            folders={folders}
            onCreateFolder={onCreateFolder}
          />
        </div>
        <div className={tab === 'plans' ? 'notes-seg notes-seg-active' : 'notes-seg'}>
          <PlansSegment active={plansActive} personas={personas} onUnpair={onUnpair} />
        </div>
      </div>
    </section>
  );
}
