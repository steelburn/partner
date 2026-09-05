/**
 * M11 F10 assets UI (PLAN-M11.md).
 *
 * SaveAssetsDialog: pick/retitle/rekind candidates extracted from an
 * assistant message, then save. AssetsDrawer: list the conversation's saved
 * assets with copy / promote-to-note / delete. Token-driven styling.
 */
import { useEffect, useState } from 'react';
import type { Asset, AssetInput, AssetKind } from '@partner/shared';
import { ASSET_KINDS } from '@partner/shared';
import { createAssets, deleteAsset, listAssets, promoteAsset } from './lib/assets.js';
import type { AssetCandidate } from './lib/assets-extract.js';

export interface SaveAssetsDialogProps {
  token: string;
  conversationId: string;
  messageId: string;
  candidates: AssetCandidate[];
  onClose: () => void;
  onSaved: () => void;
  onSessionLost: () => void;
}

function kindLabel(kind: AssetKind): string {
  return kind.replace('-', ' ');
}

/** True when an ApiRequestError means the core session is gone. */
function isAuthLost(cause: unknown): boolean {
  const status = (cause as { status?: number }).status;
  return status === 401 || status === 403;
}

export function SaveAssetsDialog({
  token,
  conversationId,
  messageId,
  candidates,
  onClose,
  onSaved,
  onSessionLost,
}: SaveAssetsDialogProps) {
  const [selected, setSelected] = useState<ReadonlySet<number>>(() => new Set([0]));
  const [kinds, setKinds] = useState<AssetKind[]>(() => candidates.map((c) => c.kind));
  const [titles, setTitles] = useState<string[]>(() => candidates.map((c) => c.title));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = (index: number): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  const confirm = async (): Promise<void> => {
    if (busy) return;
    const inputs: AssetInput[] = [];
    for (const index of selected) {
      const candidate = candidates[index];
      if (!candidate) continue;
      inputs.push({
        kind: kinds[index] ?? 'custom',
        title: (titles[index] ?? candidate.title).trim(),
        body: candidate.body,
        messageId,
      });
    }
    if (inputs.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      await createAssets(token, conversationId, inputs);
      onSaved();
      onClose();
    } catch (cause) {
      if (isAuthLost(cause)) {
        onSessionLost();
        return;
      }
      setError(cause instanceof Error ? cause.message : 'Could not save the assets.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="preview-overlay" role="dialog" aria-modal="true" aria-label="Save to assets">
      <div className="preview-panel assets-save-panel">
        <div className="preview-head">
          <span className="preview-title">Save to Assets</span>
          <button type="button" className="btn btn-secondary btn-sm" onClick={onClose} disabled={busy}>
            Cancel
          </button>
        </div>
        <p className="preview-note">
          Pick what to keep from this response. Assets live with the chat and can be promoted to
          notes later.
        </p>
        <ul className="asset-candidates" role="list">
          {candidates.map((candidate, index) => (
            <li key={`${candidate.title}-${index}`} className="asset-candidate">
              <label className="asset-candidate-check">
                <input
                  type="checkbox"
                  checked={selected.has(index)}
                  disabled={busy}
                  onChange={() => toggle(index)}
                />
              </label>
              <div className="asset-candidate-fields">
                <input
                  className="field"
                  aria-label={`Title for asset ${index + 1}`}
                  value={titles[index] ?? ''}
                  disabled={busy}
                  onChange={(event) => {
                    setTitles((prev) => {
                      const next = [...prev];
                      next[index] = event.target.value;
                      return next;
                    });
                  }}
                />
                <div className="asset-candidate-meta">
                  <select
                    className="field"
                    aria-label={`Kind for asset ${index + 1}`}
                    value={kinds[index] ?? 'custom'}
                    disabled={busy}
                    onChange={(event) => {
                      setKinds((prev) => {
                        const next = [...prev];
                        next[index] = event.target.value as AssetKind;
                        return next;
                      });
                    }}
                  >
                    {ASSET_KINDS.map((kind) => (
                      <option key={kind} value={kind}>
                        {kindLabel(kind)}
                      </option>
                    ))}
                  </select>
                  <span className="asset-candidate-size">
                    {candidate.body.length.toLocaleString()} chars
                  </span>
                </div>
              </div>
            </li>
          ))}
        </ul>
        {error ? (
          <p className="chat-attach-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="choice-actions">
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={() => void confirm()}
            disabled={busy || selected.size === 0}
            aria-busy={busy}
          >
            {busy ? 'Saving…' : `Save ${selected.size} asset${selected.size === 1 ? '' : 's'}`}
          </button>
        </div>
      </div>
    </div>
  );
}

export interface AssetsDrawerProps {
  token: string;
  conversationId: string;
  onClose: () => void;
  onSessionLost: () => void;
  /** Notify when promotion happened (Notes first-class). */
  onPromoted?: () => void;
}

export function AssetsDrawer({
  token,
  conversationId,
  onClose,
  onSessionLost,
  onPromoted,
}: AssetsDrawerProps) {
  const [assets, setAssets] = useState<Asset[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = async (): Promise<void> => {
    try {
      setAssets(await listAssets(token, conversationId));
      setError(null);
    } catch (cause) {
      if (isAuthLost(cause)) {
        onSessionLost();
        return;
      }
      setError(cause instanceof Error ? cause.message : 'Could not load assets.');
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId, token]);

  const copyBody = async (asset: Asset): Promise<void> => {
    try {
      await navigator.clipboard.writeText(asset.body);
      setCopiedId(asset.id);
      window.setTimeout(() => setCopiedId((current) => (current === asset.id ? null : current)), 1200);
    } catch {
      setError('Clipboard unavailable — copy the text from the note instead.');
    }
  };

  const promote = async (asset: Asset): Promise<void> => {
    if (busyId !== null) return;
    setBusyId(asset.id);
    setError(null);
    try {
      await promoteAsset(token, conversationId, asset.id);
      onPromoted?.();
    } catch (cause) {
      if (isAuthLost(cause)) {
        onSessionLost();
        return;
      }
      setError(cause instanceof Error ? cause.message : 'Could not promote to a note.');
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (asset: Asset): Promise<void> => {
    if (busyId !== null) return;
    setBusyId(asset.id);
    try {
      await deleteAsset(token, conversationId, asset.id);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not delete the asset.');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <section className="assets-drawer" aria-label="Saved assets">
      <div className="assets-drawer-head">
        <h2 className="assets-drawer-title">
          Assets{assets !== null ? ` (${assets.length})` : ''}
        </h2>
        <button type="button" className="btn btn-secondary btn-sm" onClick={onClose}>
          Close
        </button>
      </div>
      {error ? (
        <p className="chat-attach-error" role="alert">
          {error}
        </p>
      ) : null}
      {assets === null ? (
        <p className="rail-note">Loading assets…</p>
      ) : assets.length === 0 ? (
        <p className="rail-note">Nothing saved yet — use Save on a response to keep it here.</p>
      ) : (
        <ul className="asset-list" role="list">
          {assets.map((asset) => (
            <li key={asset.id} className="asset-row">
              <div className="asset-row-head">
                <span className="asset-row-kind">{asset.kind}</span>
                <span className="asset-row-title">{asset.title}</span>
                <button
                  type="button"
                  className="btn-link asset-row-copy"
                  onClick={() => void copyBody(asset)}
                  disabled={busyId !== null}
                >
                  {copiedId === asset.id ? 'Copied' : 'Copy'}
                </button>
                <button
                  type="button"
                  className="btn-link asset-row-promote"
                  onClick={() => void promote(asset)}
                  disabled={busyId !== null}
                >
                  {busyId === asset.id ? '…' : 'To note'}
                </button>
                <button
                  type="button"
                  className="btn-link asset-row-remove"
                  onClick={() => void remove(asset)}
                  disabled={busyId !== null}
                  aria-label={`Delete asset ${asset.title}`}
                >
                  ×
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
