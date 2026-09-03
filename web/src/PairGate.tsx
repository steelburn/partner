import { useState, type FormEvent } from 'react';
import { ApiRequestError, fetchDemoPairCode, requestPair } from './lib/api.js';
import { storeToken } from './lib/token.js';

export interface PairGateProps {
  /** Called once a session token has been stored. */
  onPaired: () => void;
}

interface Hint {
  text: string;
}

/** Only digits, at most 6 (pairing codes are 6 digits by contract). */
function sanitizeCode(raw: string): string {
  return raw.replace(/\D/g, '').slice(0, 6);
}

/**
 * Pre-pairing gate. App renders this until a session token is stored; the
 * core displays the 6-digit code (tray notification / pairing page).
 */
export default function PairGate({ onPaired }: PairGateProps) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [demoBusy, setDemoBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState<Hint | null>(null);

  const canConnect = code.length === 6 && !busy && !demoBusy;

  const connect = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    setHint(null);
    try {
      const result = await requestPair(code);
      const stored = storeToken(result.token);
      if (!stored) {
        setError('Could not save the session in this browser. Try again with storage enabled.');
        return;
      }
      onPaired();
    } catch (cause) {
      if (cause instanceof ApiRequestError) {
        if (cause.status === 401) {
          setError('That code is invalid or has expired. Ask Partner for a fresh code.');
        } else if (cause.status === 423 || cause.status === 429) {
          setError('Too many attempts. Wait a few minutes and try again.');
        } else {
          setError(cause.message);
        }
      } else {
        setError('Could not reach the Partner core. Is it running?');
      }
    } finally {
      setBusy(false);
    }
  };

  const fetchDemoCode = async (): Promise<void> => {
    if (demoBusy || busy) return;
    setDemoBusy(true);
    setError(null);
    setHint(null);
    try {
      const result = await fetchDemoPairCode();
      if (result.ok) {
        setCode(result.code);
        setHint({ text: 'Demo code filled in — press Connect to start a demo session.' });
      } else if (result.notDemo) {
        setHint({
          text: 'Core not in demo mode. Start the core with DEMO_MODE=1 to fetch a demo code.',
        });
      } else {
        setError(result.message);
      }
    } catch {
      setError('Could not reach the Partner core. Is it running?');
    } finally {
      setDemoBusy(false);
    }
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (canConnect) void connect();
  };

  return (
    <section className="gate" aria-label="Pair this browser">
      <div className="gate-panel">
        <h1 className="gate-title">Pair your browser</h1>
        <p className="gate-copy">
          Enter the 6-digit code shown by the Partner app on this machine. The code expires after a
          couple of minutes and can be used once.
        </p>

        <form className="gate-form" onSubmit={handleSubmit} aria-busy={busy}>
          <label className="label" htmlFor="pair-code">
            Pairing code
          </label>
          <input
            id="pair-code"
            className="field code-field"
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            placeholder="000000"
            value={code}
            disabled={busy}
            onChange={(event) => {
              setCode(sanitizeCode(event.target.value));
            }}
            aria-describedby={error ? 'pair-error' : hint ? 'pair-hint' : undefined}
          />
          <button
            type="submit"
            className="btn btn-primary btn-block"
            disabled={!canConnect}
            aria-busy={busy}
          >
            {busy ? 'Connecting…' : 'Connect'}
          </button>
        </form>

        <div className="gate-actions">
          <button
            type="button"
            className="btn btn-secondary"
            disabled={demoBusy || busy}
            onClick={() => void fetchDemoCode()}
          >
            {demoBusy ? 'Getting code…' : 'Get demo pairing code'}
          </button>
        </div>

        <div className="gate-feedback" aria-live="polite">
          {error ? (
            <p id="pair-error" className="form-error" role="alert">
              {error}
            </p>
          ) : null}
          {!error && hint ? <p id="pair-hint" className="form-hint">{hint.text}</p> : null}
        </div>
      </div>
    </section>
  );
}
