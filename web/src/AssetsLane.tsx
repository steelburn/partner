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
import { ApiRequestError } from './lib/api.js';
import { deleteAsset, listAssets, promoteAsset } from './lib/assets.js';
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
}: AssetsLaneProps) {
  const [assets, setAssets] = useState<Asset[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

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
          <div className="assets-lane-body">
            <PartnerMarkdown text={open.body} />
          </div>
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
              </button>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}
