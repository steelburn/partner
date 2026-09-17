/**
 * M28-era Studio split — the per-draft actions row (fork/edit/export/import/
 * discard).
 *
 * Kept apart from the editor because these act on the DRAFT as a document, while
 * the editor edits its contents.
 */
import { useRef, useState, type ChangeEvent } from 'react';
import type { SkillDraft } from '@partner/shared';
import { downloadTextFile } from '../lib/download.js';
import { discardDraft, exportDraftBundle, importDraftBundle } from '../lib/skills.js';
import { readStoredToken } from '../lib/token.js';

import { isSessionLost, messageOf } from './shared.js';

// ---------------------------------------------------------------------------
// Discard / export / import
// ---------------------------------------------------------------------------

export interface DraftActionsProps {
  draft: SkillDraft;
  disabled: boolean;
  onDiscarded: (id: string) => void;
  onImported: (draft: SkillDraft) => void;
  onSessionLost: () => void;
}

/**
 * The three bundle-level acts: export (a download the owner keeps), import (a
 * bundle lands as a NEW inert draft) and discard (the draft row leaves this
 * core). Discard keeps the existing two-step arming pattern because it destroys
 * content the owner may not have exported yet — and it deliberately says what it
 * does NOT do (uninstall the skill).
 */
export function DraftActions({
  draft,
  disabled,
  onDiscarded,
  onImported,
  onSessionLost,
}: DraftActionsProps) {
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState<'discard' | 'export' | 'import' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const exportBundle = async (): Promise<void> => {
    if (busy !== null || disabled) return;
    const token = readStoredToken();
    if (!token) {
      onSessionLost();
      return;
    }
    setBusy('export');
    setError(null);
    setNote(null);
    try {
      const bundle = await exportDraftBundle(token, draft.id);
      const filename = `${draft.id}-skill-bundle.json`;
      await downloadTextFile(filename, JSON.stringify(bundle, null, 2), 'application/json');
      setNote(
        `Saved ${filename} — an unsigned bundle. Importing it lands as a draft; it installs nothing.`,
      );
    } catch (cause) {
      if (isSessionLost(cause)) {
        onSessionLost();
        return;
      }
      setError(messageOf(cause, 'Could not export the draft.'));
    } finally {
      setBusy(null);
    }
  };

  const importFile = async (file: File | undefined): Promise<void> => {
    if (file === undefined || busy !== null || disabled) return;
    const token = readStoredToken();
    if (!token) {
      onSessionLost();
      return;
    }
    setBusy('import');
    setError(null);
    setNote(null);
    try {
      const text = await file.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text) as unknown;
      } catch {
        setError('That file is not JSON — a bundle is the JSON this Studio exported.');
        return;
      }
      const imported = await importDraftBundle(token, parsed);
      onImported(imported);
      setNote(
        `Imported “${imported.name}” as a draft. Imported skills are drafts — nothing runs until you test and install them.`,
      );
    } catch (cause) {
      if (isSessionLost(cause)) {
        onSessionLost();
        return;
      }
      setError(messageOf(cause, 'Could not import that bundle.'));
    } finally {
      setBusy(null);
    }
  };

  const discard = async (): Promise<void> => {
    if (busy !== null || disabled) return;
    const token = readStoredToken();
    if (!token) {
      onSessionLost();
      return;
    }
    setBusy('discard');
    setError(null);
    try {
      await discardDraft(token, draft.id);
      onDiscarded(draft.id);
    } catch (cause) {
      if (isSessionLost(cause)) {
        onSessionLost();
        return;
      }
      setError(messageOf(cause, 'Could not discard the draft.'));
      setArmed(false);
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="card" aria-label="Bundle">
      <h2 className="card-title">Bundle</h2>
      <p className="card-copy">
        Move this draft as a file. Export writes an unsigned bundle; the import below always lands
        as a new draft in this core.
      </p>

      <div className="studio-actions">
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => void exportBundle()}
          disabled={disabled || busy !== null}
          aria-busy={busy === 'export'}
        >
          {busy === 'export' ? 'Exporting…' : 'Export bundle'}
        </button>
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => fileRef.current?.click()}
          disabled={disabled || busy !== null}
          aria-busy={busy === 'import'}
        >
          {busy === 'import' ? 'Importing…' : 'Import bundle'}
        </button>
        {/* A visually hidden file input, the Memory-import pattern: it is
          * triggered only by the Import button, so it stays out of the tab order
          * (tabIndex -1 + aria-hidden) rather than becoming an invisible stop. */}
        <input
          ref={fileRef}
          className="sr-only"
          type="file"
          accept=".json,application/json"
          tabIndex={-1}
          aria-hidden="true"
          onChange={(event: ChangeEvent<HTMLInputElement>) => {
            void importFile(event.target.files?.[0]).then(() => {
              event.target.value = '';
            });
          }}
        />
        {armed ? (
          <>
            <button
              type="button"
              className="btn btn-secondary btn-danger"
              onClick={() => void discard()}
              disabled={disabled || busy !== null}
              aria-busy={busy === 'discard'}
            >
              {busy === 'discard' ? 'Discarding…' : 'Discard now'}
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => setArmed(false)}
              disabled={disabled || busy !== null}
            >
              Cancel
            </button>
          </>
        ) : (
          <button
            type="button"
            className="btn btn-secondary btn-danger"
            onClick={() => {
              setNote(null);
              setArmed(true);
            }}
            disabled={disabled || busy !== null}
          >
            Discard draft
          </button>
        )}
      </div>

      {armed ? (
        <p className="skill-uninstall-warn" role="alert">
          Discarding deletes this draft and its code from this core. An installed skill stays
          installed — uninstall it from Installed if that is what you meant. Press Discard now to
          confirm.
        </p>
      ) : null}

      <p className="form-hint">
        Imported skills are drafts — nothing runs until you test and install them.
      </p>

      {note !== null ? (
        <p className="form-success" role="status">
          {note}
        </p>
      ) : null}
      {error !== null ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
