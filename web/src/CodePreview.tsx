/**
 * M11 F12 code preview viewer (PLAN-M11.md).
 *
 * Renders an untrusted HTML document inside a hardened iframe: srcdoc +
 * sandbox, scripts OFF by default with a per-preview opt-in toggle, never
 * allow-same-origin/forms/popups, CSP already injected by lib/preview. The
 * canvas is the user's document (outside the token system); the chrome is
 * token-styled.
 */
import { useState } from 'react';
import { buildPreviewDoc, blockedSummary } from './lib/preview.js';

export interface CodePreviewProps {
  title: string;
  /** Raw (untrusted) HTML/CSS document or fragment source. */
  source: string;
  onClose: () => void;
}

export function CodePreview({ title, source, onClose }: CodePreviewProps) {
  const [scripts, setScripts] = useState(false);
  const { doc, report } = buildPreviewDoc(source, { allowScripts: scripts });
  const sandbox = scripts ? 'allow-scripts' : '';

  return (
    <div className="preview-overlay" role="dialog" aria-modal="true" aria-label={`Preview ${title}`}>
      <div className="preview-panel">
        <div className="preview-head">
          <span className="preview-title">{title}</span>
          <div className="preview-actions">
            <button
              type="button"
              className={scripts ? 'btn btn-secondary btn-sm btn-warning-armed' : 'btn btn-secondary btn-sm'}
              onClick={() => setScripts((value) => !value)}
              aria-pressed={scripts}
              disabled={false}
            >
              {scripts ? 'Scripts on' : 'Scripts off'}
            </button>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={onClose}
              aria-label={`Close preview of ${title}`}
            >
              Close
            </button>
          </div>
        </div>
        <p className="preview-note">
          Preview is sandboxed — no network, no same-origin access.
          {scripts ? ' Scripts may run inside the sandbox.' : ''}{' '}
          {blockedSummary(report)}
        </p>
        <iframe
          className="preview-frame"
          title={`Sandboxed preview of ${title}`}
          sandbox={sandbox}
          srcDoc={doc}
        />
      </div>
    </div>
  );
}
