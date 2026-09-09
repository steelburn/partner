/**
 * M14 AssetsLane — the conversation's saved assets as a proper right-hand
 * pane beside the transcript (mirrors the Notes lane). Lists the assets of
 * the OPEN conversation; selecting one shows a read view of its full body
 * (rendered markdown, same safe renderer the transcript uses) with Copy /
 * Export .md / promote-to-note / Delete. Saved asset bodies are owner
 * content: rendered only, never logged or echoed outside this pane.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { conversationUi } from './lib/conversation-ui.js';
import type { Asset, AssetKind } from '@partner/shared';
import { parseCsv, sniffCsv } from '@partner/shared';
import { ApiRequestError } from './lib/api.js';
import { deleteAsset, discussAsset, listAssets, promoteAsset } from './lib/assets.js';
import { buildAssetDiscussQuote } from './lib/asset-quote.js';
import { exportAssetFile } from './lib/assets-export.js';
import { readStoredToken } from './lib/token.js';
import { timeAgo } from './lib/persona-helpers.js';
import { PartnerMarkdown } from './Markdown.js';
import { IconChevronLeft, IconMaximize, IconMinimize } from './icons.js';

export interface AssetsLaneProps {
  /** The open conversation whose assets this pane shows (null = none yet). */
  conversationId: string | null;
  /** True while the Chat view is visible — returning reloads assets saved
   *  elsewhere so the pane stays truthful. */
  active: boolean;
  /** Bumped when an asset is saved outside the pane (Save-to-assets flow). */
  version: number;
  /** M14.1 focus mode: the pane grows to take over the whole chat workspace
   *  (rail + transcript + notes lane yield) so wide documents get a real
   *  reading measure. Owned by the shell (it toggles the workspace class). */
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  /** Collapse the pane (the transcript regains the width). */
  onClose: () => void;
  onUnpair: () => void;
  /** M16 F4: open a conversation and quote the asset draft into its
   *  composer (called for both continue-in-place and fork). */
  onDiscuss: (conversationId: string, quote: string) => void;
}

/** True when an ApiRequestError means the core session is gone. */
function isSessionLost(cause: unknown): boolean {
  return cause instanceof ApiRequestError && (cause.status === 401 || cause.status === 403);
}

function kindLabel(kind: AssetKind): string {
  return kind.replace('-', ' ');
}

/** Quick single-flight guard + shared busy text for list/action buttons. */
const COPIED_MS = 1200;

export function AssetsLane({
  conversationId,
  active,
  version,
  expanded,
  onExpandedChange,
  onClose,
  onUnpair,
  onDiscuss,
}: AssetsLaneProps) {
  const [assets, setAssets] = useState<Asset[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // M16 F4 discuss chooser (expanded while choosing, so the user picks one).
  const [discussOpen, setDiscussOpen] = useState(false);
  const [discussBusy, setDiscussBusy] = useState(false);
  // M16 F6 CSV: per-asset view toggle (table vs raw markdown body).
  const [csvView, setCsvView] = useState<'table' | 'raw'>('table');


  // M14 per-conversation memory: which asset row is open is keyed by the
  // conversation so switching chats and coming back restores the read view.
  const openIdRef = useRef<string | null>(openId);
  const lastConvRef = useRef<string | null>(conversationId);
  /** Conversation whose list still needs its remembered asset restored. */
  const hydrateRef = useRef<string | null>(conversationId);

  useEffect(() => {
    openIdRef.current = openId;
  }, [openId]);

  /** Remember the open asset for the conversation the user just left. */
  useEffect(() => {
    if (lastConvRef.current === conversationId) return;
    conversationUi.setAssetOpen(lastConvRef.current, openIdRef.current);
    lastConvRef.current = conversationId;
    // Restore after the next successful list load for this conversation.
    hydrateRef.current = conversationId;
  }, [conversationId]);

  const load = useCallback(async (): Promise<void> => {
    if (conversationId === null) {
      setAssets(null);
      setOpenId(null);
      setError(null);
      return;
    }
    const token = readStoredToken();
    if (!token) {
      onUnpair();
      return;
    }
    try {
      const list = await listAssets(token, conversationId);
      setAssets(list);
      setError(null);
      // M14: after the list for a just-opened conversation arrives, restore
      // its remembered open asset when it still exists (else close the view).
      if (hydrateRef.current === conversationId) {
        hydrateRef.current = null;
        const remembered = conversationUi.getAssetOpen(conversationId);
        setOpenId(
          remembered !== null && list.some((asset) => asset.id === remembered)
            ? remembered
            : null,
        );
      }
    } catch (cause) {
      if (isSessionLost(cause)) {
        onUnpair();
        return;
      }
      setError(cause instanceof Error ? cause.message : 'Could not load the assets.');
    }
  }, [conversationId, onUnpair]);

  // Reload when the conversation/visibility/outside-save changes. A
  // different conversation resets the open read view.
  useEffect(() => {
    setOpenId(null);
    setNotice(null);
    void load();
  }, [load, active, version]);

  // Focus mode is a reading surface: Escape collapses it back to the
  // side-by-side pane (mirrors the Notes lane capture composer).
  useEffect(() => {
    if (!expanded) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onExpandedChange(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [expanded, onExpandedChange]);

  const open = assets?.find((asset) => asset.id === openId) ?? null;

  const select = (id: string): void => {
    setOpenId(id);
    setCsvView('table');
    conversationUi.setAssetOpen(conversationId, id);
    setNotice(null);
    setError(null);
  };

  const copyBody = async (asset: Asset): Promise<void> => {
    try {
      await navigator.clipboard.writeText(asset.body);
      setCopiedId(asset.id);
      setNotice(null);
      window.setTimeout(
        () => setCopiedId((current) => (current === asset.id ? null : current)),
        COPIED_MS,
      );
    } catch {
      setError('Clipboard unavailable — Export .md or copy from the note instead.');
    }
  };

  const exportFile = (asset: Asset): void => {
    exportAssetFile(asset);
    setNotice(`Exported “${asset.title}” as a .md file.`);
  };

  const promote = async (asset: Asset): Promise<void> => {
    if (conversationId === null || busyId !== null) return;
    setBusyId(asset.id);
    setError(null);
    try {
      await promoteAsset(readStoredToken() ?? '', conversationId, asset.id);
      setNotice('Promoted to a note — find it under Notes.');
    } catch (cause) {
      if (isSessionLost(cause)) {
        onUnpair();
        return;
      }
      setError(cause instanceof Error ? cause.message : 'Could not promote to a note.');
    } finally {
      setBusyId(null);
    }
  };

  /** M16 F4: continue the SAME discussion (this conversation's thread). */
  const discussContinue = (asset: Asset): void => {
    setDiscussOpen(false);
    setDiscussBusy(false);
    if (conversationId === null) return;
    onDiscuss(conversationId, buildAssetDiscussQuote(asset));
    setNotice('Quoted into this discussion — type your angle and send.');
  };

  /** M16 F4: fork a NEW discussion that branches off this conversation. */
  const discussFork = async (asset: Asset): Promise<void> => {
    if (conversationId === null || discussBusy) return;
    setDiscussBusy(true);
    setError(null);
    try {
      const result = await discussAsset(
        readStoredToken() ?? '',
        conversationId,
        asset.id,
        'fork',
      );
      setDiscussOpen(false);
      setNotice('Forked — a new discussion opened with the asset quoted.');
      onDiscuss(result.conversationId, buildAssetDiscussQuote(asset));
    } catch (cause) {
      if (isSessionLost(cause)) {
        onUnpair();
        return;
      }
      setError(cause instanceof Error ? cause.message : 'Could not fork the discussion.');
    } finally {
      setDiscussBusy(false);
    }
  };

  const csvTable =
    open !== null && sniffCsv(open.body) && csvView === 'table'
      ? { rows: parseCsv(open.body) }
      : null;

  const remove = async (asset: Asset): Promise<void> => {
    if (conversationId === null || busyId !== null) return;
    setBusyId(asset.id);
    setError(null);
    try {
      await deleteAsset(readStoredToken() ?? '', conversationId, asset.id);
      await load();
      const stillOpen = openIdRef.current === asset.id ? null : openIdRef.current;
      setOpenId(stillOpen);
      conversationUi.setAssetOpen(conversationId, stillOpen);
      setNotice(`Deleted “${asset.title}”.`);
    } catch (cause) {
      if (isSessionLost(cause)) {
        onUnpair();
        return;
      }
      setError(cause instanceof Error ? cause.message : 'Could not delete the asset.');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <aside className="assets-lane" aria-label="Saved assets">
      <div className="assets-lane-head">
        <button
          type="button"
          className="assets-lane-close"
          onClick={onClose}
          aria-label="Hide assets panel"
          title="Hide assets panel"
        >
          <IconChevronLeft />
        </button>
        <h2 className="assets-lane-title">
          Assets{assets !== null ? ` (${assets.length})` : ''}
        </h2>
        <button
          type="button"
          className="assets-lane-expand"
          onClick={() => onExpandedChange(!expanded)}
          aria-pressed={expanded}
          aria-label={expanded ? 'Back to side-by-side view' : 'Read at full width'}
          title={expanded ? 'Back to side-by-side view' : 'Read at full width'}
          disabled={conversationId === null}
        >
          {expanded ? <IconMinimize /> : <IconMaximize />}
        </button>
      </div>
      {error !== null ? (
        <p className="assets-lane-note assets-lane-error" role="alert">
          {error}
        </p>
      ) : null}
      {notice !== null ? (
        <p className="assets-lane-status" role="status" aria-live="polite">
          {notice}
        </p>
      ) : null}
      {conversationId === null ? (
        <p className="assets-lane-note">
          Open a conversation to see its saved assets.
        </p>
      ) : assets === null ? (
        <p className="assets-lane-note" aria-busy="true">
          Loading assets…
        </p>
      ) : open !== null ? (
        <div className="assets-lane-detail">
          <button
            type="button"
            className="btn-link assets-lane-back"
            onClick={() => {
              setOpenId(null);
              conversationUi.setAssetOpen(conversationId, null);
              setNotice(null);
            }}
            disabled={busyId !== null}
          >
            ← All assets
          </button>
          <div className="assets-lane-detail-head">
            <div className="assets-lane-detail-top">
              <h3 className="assets-lane-detail-title">{open.title}</h3>
              <button
                type="button"
                className="btn-link assets-lane-del"
                onClick={() => void remove(open)}
                disabled={busyId !== null}
                aria-label={`Delete asset ${open.title}`}
                title="Delete this asset"
              >
                Delete
              </button>
            </div>
            <p className="assets-lane-detail-meta">
              {kindLabel(open.kind)}
              {open.messageId !== null ? ' · from a message' : ''} ·{' '}
              {timeAgo(open.createdAt)} · {open.body.length.toLocaleString()} chars
            </p>
          </div>
          <div className="assets-lane-actions">
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => void copyBody(open)}
              disabled={busyId !== null}
            >
              {copiedId === open.id ? 'Copied ✓' : 'Copy'}
            </button>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              disabled={busyId !== null}
              onClick={() => {
                setDiscussOpen((openNow) => !openNow);
                setNotice(null);
              }}
              aria-expanded={discussOpen}
              title="Discuss this asset in its discussion, or fork a new one"
            >
              Discuss…
            </button>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => exportFile(open)}
              disabled={busyId !== null}
              title="Download as a .md file"
            >
              Export
            </button>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => void promote(open)}
              disabled={busyId !== null}
              title="Open a note with this asset's body"
            >
              {busyId === open.id ? '…' : 'To note'}
            </button>
          </div>
          {discussOpen ? (
            <div className="assets-discuss" aria-label="Discuss this asset">
              <p className="assets-discuss-copy">
                A discussion of this asset becomes a thread of the same discussion — or fork a
                new discussion that branches off it. Either way the asset is quoted into the
                composer; nothing is sent until you write.
              </p>
              <div className="form-actions">
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  disabled={discussBusy}
                  onClick={() => discussContinue(open)}
                >
                  Continue in this discussion
                </button>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  disabled={discussBusy}
                  onClick={() => void discussFork(open)}
                  aria-busy={discussBusy}
                  title="New conversation that branches off this one (shows under it in the rail)"
                >
                  {discussBusy ? 'Forking…' : 'Fork into a new discussion'}
                </button>
              </div>
            </div>
          ) : null}
          {csvTable ? (
            <div className="assets-lane-body">
              <div className="assets-csv-head">
                <span className="chip chip-accent">CSV · {csvTable.rows.length - 1} rows</span>
                <button
                  type="button"
                  className="btn-link btn-sm"
                  onClick={() => setCsvView(csvView === 'table' ? 'raw' : 'table')}
                  aria-pressed={csvView === 'table'}
                >
                  {csvView === 'table' ? 'View raw text' : 'View as table'}
                </button>
              </div>
              {csvView === 'table' ? (
                <div className="csv-scroll">
                  <table className="csv-table">
                    <thead>
                      <tr>
                        {csvTable.rows[0]?.map((header, index) => (
                          <th key={index} scope="col">
                            {header}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {csvTable.rows.slice(1, 501).map((cells, rowIndex) => (
                        <tr key={rowIndex}>
                          {cells.map((cell, colIndex) => (
                            <td key={colIndex} className={/^-?\d+([.,]\d+)?$/.test(cell.trim()) ? 'csv-num' : undefined}>
                              {cell}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {csvTable.rows.length > 501 ? (
                    <p className="csv-cap">Showing the first 500 rows.</p>
                  ) : null}
                </div>
              ) : (
                <PartnerMarkdown text={open.body} />
              )}
            </div>
          ) : (
            <div className="assets-lane-body">
              <PartnerMarkdown text={open.body} />
            </div>
          )}
        </div>
      ) : assets.length === 0 ? (
        <p className="assets-lane-note">
          Nothing saved yet — use Save to Assets on a response to keep it here.
        </p>
      ) : (
        <ul className="assets-lane-list" role="list">
          {assets.map((asset) => (
            <li key={asset.id} className="assets-lane-row">
              <button
                type="button"
                className="assets-lane-open"
                onClick={() => select(asset.id)}
                disabled={busyId !== null}
                aria-label={`View asset ${asset.title}`}
              >
                <span className="assets-lane-row-title">{asset.title}</span>
                <span className="assets-lane-row-meta">
                  {kindLabel(asset.kind)}
                  {asset.messageId !== null ? ' · from a message' : ''} ·{' '}
                  {timeAgo(asset.createdAt)}
                </span>
                {asset.body.length > 0 && sniffCsv(asset.body) ? (
                  <span className="chip chip-accent">CSV</span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}
