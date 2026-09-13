/**
 * Pairing-link presentation (M20-B S7) — the two states of the incoming-link
 * branch, split out of PairGate so they can be render-tested without a DOM.
 *
 * `PairGate` owns the intent (read the fragment, redeem the secret, store the
 * token); these components own what the user sees, which is the part a review
 * can actually falsify: the refusal copy per reason, the fingerprint the user
 * pins, and the rule that a link issued for ANOTHER core offers no pair button.
 * Token-styled only; no state, no fetches.
 */
import type { PairLinkRefusal, PairPayload } from './lib/pair-link.js';

/**
 * Why a `#pair=…` link could not be used, in the user's words rather than the
 * validator's. Every reason gets its own sentence — one "invalid link" for all
 * of them would make a damaged link indistinguishable from a link for another
 * core, and the user's next step differs.
 */
export const REFUSAL_COPY: Record<PairLinkRefusal, string> = {
  not_a_link: 'This link does not contain a pairing payload.',
  not_json:
    'This link is damaged — its pairing payload could not be read. Ask Partner for a new one.',
  not_an_object:
    'This link is damaged — its pairing payload could not be read. Ask Partner for a new one.',
  invalid_core_url: 'This link does not name a valid Partner address. Ask Partner for a new one.',
  insecure_core_url:
    'This link points at an unencrypted (http) address. Partner pairs over https only — ask Partner for a new one.',
  invalid_cert_fingerprint:
    'This link is missing a valid certificate fingerprint. Ask Partner for a new one.',
  invalid_secret: 'This link is missing a valid pairing secret. Ask Partner for a new one.',
};

export interface PairLinkProblemProps {
  reason: PairLinkRefusal;
  onBack: () => void;
}

/** A link that cannot be used at all: say why, offer the ordinary gate back. */
export function PairLinkProblem({ reason, onBack }: PairLinkProblemProps) {
  return (
    <section className="gate" aria-label="Pair this device">
      <div className="gate-panel">
        <h1 className="gate-title">This pairing link cannot be used</h1>
        <p className="gate-copy">{REFUSAL_COPY[reason]}</p>
        <div className="gate-actions-row">
          <button type="button" className="btn btn-secondary" onClick={onBack}>
            Back to pairing
          </button>
        </div>
      </div>
    </section>
  );
}

export interface PairLinkConfirmProps {
  payload: PairPayload;
  /** True when the payload's core is the origin serving this page. */
  originOk: boolean;
  /** The origin serving this page (shown when it does not match). */
  servingOrigin: string;
  deviceName: string;
  busy: boolean;
  error: string | null;
  onNameChange: (value: string) => void;
  onPair: () => void;
  onCancel: () => void;
}

/** The confirm step for a usable link: one press, one session. */
export function PairLinkConfirm({
  payload,
  originOk,
  servingOrigin,
  deviceName,
  busy,
  error,
  onNameChange,
  onPair,
  onCancel,
}: PairLinkConfirmProps) {
  return (
    <section className="gate" aria-label="Pair this device">
      <div className="gate-panel">
        <h1 className="gate-title">Pair this device</h1>
        <p className="gate-copy">
          This link pairs this phone or tablet with Partner as a phone session. The link works
          once; the device can read and chat, but cannot change files on the machine running
          Partner.
        </p>

        <dl className="gate-meta">
          <div className="gate-meta-row">
            <dt className="gate-meta-label">Partner at</dt>
            <dd className="gate-meta-value">{payload.coreUrl}</dd>
          </div>
          <div className="gate-meta-row">
            <dt className="gate-meta-label">Certificate fingerprint</dt>
            <dd className="gate-meta-value gate-fingerprint">{payload.certFingerprint}</dd>
          </div>
        </dl>

        {originOk ? (
          <>
            <label className="label" htmlFor="device-name">
              Name this device (optional)
            </label>
            <input
              id="device-name"
              className="field"
              type="text"
              maxLength={64}
              placeholder="Phone"
              value={deviceName}
              disabled={busy}
              onChange={(event) => onNameChange(event.target.value)}
            />
            <div className="gate-actions-row">
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy}
                aria-busy={busy}
                onClick={onPair}
              >
                {busy ? 'Pairing…' : 'Pair this device'}
              </button>
              <button type="button" className="btn btn-secondary" disabled={busy} onClick={onCancel}>
                Cancel
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="gate-copy">
              This link was issued for {payload.coreUrl}, but this page is served by
              {servingOrigin === '' ? ' another address' : ` ${servingOrigin}`}. Open the link from
              that address so the certificate fingerprint can be checked.
            </p>
            <div className="gate-actions-row">
              <button type="button" className="btn btn-secondary" onClick={onCancel}>
                Back to pairing
              </button>
            </div>
          </>
        )}

        <div className="gate-feedback" aria-live="polite">
          {error ? (
            <p className="form-error" role="alert">
              {error}
            </p>
          ) : null}
        </div>
      </div>
    </section>
  );
}
