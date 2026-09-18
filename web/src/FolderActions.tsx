/**
 * M35 — the folder row's controls: add subfolder, rename, delete.
 *
 * Extracted from `ConversationRail` (where they shipped in M11/M34) because the
 * Explorer-style Folders page renders a folder row in two places — the
 * navigation pane and the contents list — and the M32 failure mode was exactly
 * a control that existed twice and then drifted. The cluster owns the two-step
 * delete (arm, then confirm, disarmed by a timer) so no caller has to keep a
 * confirm timer or a "which row is armed" flag of its own.
 *
 * The buttons are the SAME `.folder-actions` / `.folder-action` classes the rail
 * has always used: visibility (hover / focus-within / `(hover: none)`) and the
 * touch floor are stylesheet concerns, not a second copy of this markup.
 */
import { useEffect, useState } from 'react';

/** How long a two-step delete stays armed before disarming itself (M11). */
export const FOLDER_DELETE_ARM_MS = 4000;

export interface FolderActionsProps {
  /** The folder's name, for the labels a screen reader reads. */
  name: string;
  /** Locked while a turn streams or a sibling row is mid-delete. */
  disabled?: boolean;
  /** A delete for THIS folder is in flight. */
  busy?: boolean;
  onAddSubfolder: () => void;
  onRename: () => void;
  /** Called only on the CONFIRMED press (the second one). */
  onDelete: () => void;
}

export default function FolderActions({
  name,
  disabled = false,
  busy = false,
  onAddSubfolder,
  onRename,
  onDelete,
}: FolderActionsProps) {
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    if (!confirming) return undefined;
    const timer = window.setTimeout(() => setConfirming(false), FOLDER_DELETE_ARM_MS);
    return () => window.clearTimeout(timer);
  }, [confirming]);

  return (
    <span className="folder-actions">
      <button
        type="button"
        className="folder-action"
        aria-label={`Add subfolder under ${name}`}
        title="Add subfolder"
        disabled={disabled || busy}
        onClick={onAddSubfolder}
      >
        +
      </button>
      <button
        type="button"
        className="folder-action"
        aria-label={`Rename folder ${name}`}
        title="Rename"
        disabled={disabled || busy}
        onClick={onRename}
      >
        ✎
      </button>
      <button
        type="button"
        className={
          confirming
            ? 'folder-action folder-action-danger folder-action-confirm'
            : 'folder-action folder-action-danger'
        }
        aria-label={
          confirming ? `Confirm deleting folder ${name}` : `Delete folder ${name}`
        }
        title={confirming ? 'Confirm delete' : 'Delete'}
        disabled={disabled || busy}
        onClick={() => {
          if (confirming) {
            setConfirming(false);
            onDelete();
            return;
          }
          setConfirming(true);
        }}
      >
        {busy ? '…' : confirming ? 'OK' : '×'}
      </button>
    </span>
  );
}
