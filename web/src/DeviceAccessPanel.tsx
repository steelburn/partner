/**
 * Phone & tablet access (M20-B S7) — the desktop half of networked pairing.
 *
 * The core can only issue a pairing secret to a caller ON the machine
 * (`POST /v1/pair/payload` is loopback-only), so this panel is how a user
 * obtains the link a phone opens. It is deliberately ACTION-DRIVEN: nothing is
 * fetched on mount, because mounting would otherwise mint a live one-time
 * secret every time the Providers view is rendered.
 *
 * The link carries a one-time secret in the URL FRAGMENT (never a query
 * string), so it is not sent to the core or any proxy on the way; it is
 * cleared from the phone's address bar as soon as it is used.
 */
import { useState } from 'react';
import { ApiRequestError, fetchPairPayload } from './lib/api.js';
import { pairLinkFor } from './lib/pair-link.js';
import { readStoredToken } from './lib/token.js';

export interface DeviceAccessPanelProps {
  onUnpair: () => void;
}

interface LinkState {
  link: string;
  coreUrl: string;
  certFingerprint: string;
}

/** Plain-language copy for each refusal the payload route can return. */
function refusalCopy(cause: ApiRequestError): string {
  if (cause.status === 403) {
    // Reached over a tunnel/LAN, so the request is not loopback: name the
    // command that DOES work instead of leaving the user with a dead button.
    return (
      'Partner only creates pairing links for a request that arrives over the ' +
      'machine\u2019s own loopback address, so this browser cannot mint one. On the machine ' +
      'running Partner, run: docker compose exec partner node tools/pair-link.mjs — it ' +
      'prints a link you can open here.'
    );
  }
  if (cause.status === 409) {
    return cause.message.toLowerCase().includes('tls')
      ? 'Partner needs TLS before it can pair a phone: set TLS_CERT_FILE and TLS_KEY_FILE on the machine running Partner, then restart it.'
      : 'Remote access is off, so a link would not work yet. Turn on remote access (REMOTE_ACCESS with TLS and ALLOWED_HOSTS) on the machine running Partner, then create the link.';
  }
  return cause.message;
}

export function DeviceAccessPanel({ onUnpair }: DeviceAccessPanelProps) {
  const [state, setState] = useState<LinkState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const createLink = async (): Promise<void> => {
    const token = readStoredToken();
    if (!token) {
      onUnpair();
      return;
    }
    setBusy(true);
    setError(null);
    setCopied(false);
    try {
      const info = await fetchPairPayload(token);
      setState({
        link: pairLinkFor(info.payload, info.coreUrl),
        coreUrl: info.coreUrl,
        certFingerprint: info.certFingerprint,
      });
    } catch (cause) {
      if (cause instanceof ApiRequestError) {
        if (cause.status === 401) {
          onUnpair();
          return;
        }
        setError(refusalCopy(cause));
      } else {
        setError('Could not reach the Partner core. Is it running?');
      }
    } finally {
      setBusy(false);
    }
  };

  const copy = async (): Promise<void> => {
    if (state === null) return;
    try {
      await navigator.clipboard.writeText(state.link);
      setCopied(true);
    } catch {
      setError('Could not copy to the clipboard — select the link and copy it manually.');
    }
  };

  return (
    <section className="card" aria-label="Phone and tablet access">
      <h2 className="card-title">Phone &amp; tablet access</h2>
      <p className="card-copy">
        Pair a phone or tablet so it can chat with Partner over your network. Phones get a
        read-and-chat session: they cannot change files or install skills on this machine.
      </p>

      {state === null ? (
        <>
          <div className="gate-actions-row">
            <button
              type="button"
              className="btn btn-secondary"
              disabled={busy}
              aria-busy={busy}
              onClick={() => void createLink()}
            >
              {busy ? 'Creating…' : 'Create pairing link'}
            </button>
          </div>
          <p className="form-hint">
            The link contains a one-time secret and expires after a couple of minutes. Send it to
            the device, or turn it into a QR code with any QR app.
          </p>
        </>
      ) : (
        <>
          <div className="pair-link-box">
            <p className="pair-link-label">Open this on the phone</p>
            <p className="pair-link-value" id="pair-link-value">
              {state.link}
            </p>
          </div>
          <div className="gate-actions-row">
            <button type="button" className="btn btn-primary" onClick={() => void copy()}>
              {copied ? 'Copied' : 'Copy link'}
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={busy}
              onClick={() => void createLink()}
            >
              {busy ? 'Creating…' : 'Create a new link'}
            </button>
          </div>
          <p className="form-hint">
            Opens {state.coreUrl}. The phone checks the certificate fingerprint{' '}
            <span className="pair-link-fingerprint">{state.certFingerprint}</span> against the one
            Partner shows here. The link works once and stops working after two minutes — create a
            new one if the phone was not ready.
          </p>
        </>
      )}

      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
