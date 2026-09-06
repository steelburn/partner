/**
 * M11 F10 assets UI (PLAN-M11.md).
 *
 * SaveAssetsDialog: pick/retitle/rekind candidates extracted from an
 * assistant message, then save. (The conversation-asset LIST moved to the
 * M14 AssetsLane — a resizable pane beside the transcript.)
 */
import { useState } from 'react';
import type { AssetInput, AssetKind } from '@partner/shared';
import { ASSET_KINDS } from '@partner/shared';
import { createAssets } from './lib/assets.js';
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

