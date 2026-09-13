import { useEffect, useState, type FormEvent } from 'react';
import {
  ApiRequestError,
  fetchCoreHealth,
  fetchDemoPairCode,
  requestPair,
  requestPairSecret,
  signIn,
} from './lib/api.js';
import {
  deviceLabelFrom,
  isSameCoreOrigin,
  readPairHash,
  stripPairHash,
} from './lib/pair-link.js';
import type { PairLinkResult } from './lib/pair-link.js';
import { PairLinkConfirm, PairLinkProblem } from './PairLinkNotice.js';
import { LoginGate } from './LoginGate.js';
import { rememberAuthMode } from './lib/auth-mode.js';
import { storeToken } from './lib/token.js';
import SessionChat from './SessionChat.js';

export interface PairGateProps {
  /** Called once a session token has been stored. */
  onPaired: () => void;
}

type GateMode = 'pair' | 'session';

interface Hint {
  text: string;
}

/** Only digits, at most 6 (pairing codes are 6 digits by contract). */
function sanitizeCode(raw: string): string {
  return raw.replace(/\D/g, '').slice(0, 6);
}

/**
 * M20-B S7: why a `#pair=…` link could not be used, in the user's words rather
 * than the validator's — see `PairLinkNotice.tsx` (the rendering is there so it
 * can be render-tested without a DOM).
 */

/** The pairing link in the URL fragment, or null when there is none. */
function readLinkFromLocation(): PairLinkResult | null {
  if (typeof window === 'undefined') return null;
  const parsed = readPairHash(window.location.hash);
  // `not_a_link` is the ordinary "no link here" answer; every other refusal
  // means someone handed this device a link that cannot be used, which the
  // user must be told rather than shown an ordinary pairing form.
  return parsed.ok || parsed.reason !== 'not_a_link' ? parsed : null;
}

/**
 * Pre-pairing gate. App renders this until a session token is stored; the
 * core displays the 6-digit code (tray notification / pairing page).
 *
 * M20-B S7 adds the second entrance: a phone or tablet that opened a
 * `#pair=…` link confirms ONCE and receives a `mobile` session. The link
 * carries a one-time secret (never a code, never a token), so this path has no
 * code field — and it is refused when the link names a different core than the
 * one serving this page.
 */
export default function PairGate({ onPaired }: PairGateProps) {
  const [mode, setMode] = useState<GateMode>('pair');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [demoBusy, setDemoBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState<Hint | null>(null);
  /** M15: null while probing / when the core is unreachable — the demo
   *  affordance only appears once /v1/health confirms demo mode. */
  const [liveMode, setLiveMode] = useState<boolean | null>(null);
  /** M22: the core's auth mode + whether it has an account yet. */
  const [authMode, setAuthMode] = useState<'pairing' | 'login'>('pairing');
  const [noAccountYet, setNoAccountYet] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loginBusy, setLoginBusy] = useState(false);

  /** M20-B S7: an incoming pairing link, if the page was opened with one. */
  const [link, setLink] = useState<PairLinkResult | null>(readLinkFromLocation);
  const [linkBusy, setLinkBusy] = useState(false);
  const [deviceName, setDeviceName] = useState(() =>
    typeof navigator === 'undefined' ? '' : (deviceLabelFrom(navigator.userAgent) ?? ''),
  );
  const [servingOrigin] = useState(() =>
    typeof window === 'undefined' ? '' : window.location.origin,
  );
  const [servingHost] = useState(() =>
    typeof window === 'undefined' ? '' : window.location.host,
  );

  useEffect(() => {
    let alive = true;
    void fetchCoreHealth().then((health) => {
      if (!alive) return;
      setLiveMode(health === null ? null : !health.demo);
      if (health !== null) {
        setAuthMode(health.authMode);
        // Remember it: the "session expired" copy lives in views far from this
        // probe, and it has to name the action the user will be offered.
        rememberAuthMode(health.authMode);
        setNoAccountYet(health.hasUsers === false);
      }
    });
    return () => {
      alive = false;
    };
  }, []);

  // A pairing link is a URL FRAGMENT, and changing only the fragment does not
  // remount the app — so pasting a link into an ALREADY-OPEN tab (or having a QR
  // app navigate in-place) left the ordinary gate on screen with the link sitting
  // ignored in the address bar. Verified in the container deployment: the confirm
  // card appeared only after a manual reload. Re-reading on `hashchange` closes
  // that. It only ever ADDS a link (`not_a_link` leaves the gate alone), and
  // `cancelLink` uses history.replaceState, which fires no event.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onHashChange = (): void => {
      const parsed = readLinkFromLocation();
      if (parsed !== null) setLink(parsed);
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const canConnect = code.length === 6 && !busy && !demoBusy;

  /** M22: sign in (the hosted shape's only way in). */
  const handleSignIn = async (): Promise<void> => {
    setLoginBusy(true);
    setError(null);
    setHint(null);
    try {
      const result = await signIn(username.trim(), password);
      if (!storeToken(result.token)) {
        setError('Could not save the session in this browser. Try again with storage enabled.');
        return;
      }
      setPassword('');
      onPaired();
    } catch (cause) {
      if (cause instanceof ApiRequestError) {
        if (cause.status === 401) {
          setError('That username and password do not match an account on this Partner.');
        } else if (cause.status === 429) {
          setError('Too many attempts. Wait a few minutes and try again.');
        } else if (cause.status === 409) {
          // "No account exists yet" — the server's copy names the command.
          setError(cause.message);
          setNoAccountYet(true);
        } else {
          setError(cause.message);
        }
      } else {
        setError('Could not reach the Partner core. Is it running?');
      }
    } finally {
      setLoginBusy(false);
    }
  };

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
        } else if (cause.status === 403) {
          setError('This browser is not on the machine running Partner, so the code cannot be used here. Use the pairing link instead.');
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
          text: 'This core is not in demo mode — grab the code from the Partner tray icon instead.',
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

  /** Leave the pairing-link flow: drop the fragment so the secret is gone. */
  const cancelLink = (): void => {
    if (typeof window !== 'undefined') {
      window.history.replaceState(null, '', stripPairHash(window.location.href));
    }
    setLink(null);
    setError(null);
  };

  const pairDevice = async (): Promise<void> => {
    if (link === null || !link.ok) return;
    setLinkBusy(true);
    setError(null);
    try {
      const result = await requestPairSecret(link.payload.secret, {
        deviceLabel: deviceName.trim() === '' ? null : deviceName.trim(),
      });
      if (!storeToken(result.token)) {
        setError('Could not save the session in this browser. Try again with storage enabled.');
        return;
      }
      cancelLink();
      onPaired();
    } catch (cause) {
      if (cause instanceof ApiRequestError) {
        if (cause.status === 401) {
          setError('This pairing link has already been used or has expired. Ask Partner for a new one.');
        } else if (cause.status === 429) {
          setError('Too many attempts. Wait a few minutes and try again.');
        } else if (cause.status === 403) {
          setError('Partner refused this pairing request. Open the link from the address it names.');
        } else {
          setError(cause.message);
        }
      } else {
        setError('Could not reach the Partner core. Is it running?');
      }
    } finally {
      setLinkBusy(false);
    }
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (canConnect) void connect();
  };

  if (mode === 'session') {
    return <SessionChat onBack={() => setMode('pair')} />;
  }

  // --- M22: the hosted shape signs in (no pairing ceremony exists there) ---
  if (link === null && authMode === 'login') {
    return (
      <LoginGate
        username={username}
        password={password}
        busy={loginBusy}
        error={error}
        noAccountYet={noAccountYet}
        host={servingHost}
        onUsername={setUsername}
        onPassword={setPassword}
        onSubmit={() => void handleSignIn()}
        onSessionOnly={() => setMode('session')}
      />
    );
  }

  // --- M20-B S7: an incoming pairing link ---------------------------------
  if (link !== null) {
    if (!link.ok) {
      return <PairLinkProblem reason={link.reason} onBack={cancelLink} />;
    }
    return (
      <PairLinkConfirm
        payload={link.payload}
        originOk={servingOrigin !== '' && isSameCoreOrigin(link.payload.coreUrl, servingOrigin)}
        servingOrigin={servingOrigin}
        deviceName={deviceName}
        busy={linkBusy}
        error={error}
        onNameChange={setDeviceName}
        onPair={() => void pairDevice()}
        onCancel={cancelLink}
      />
    );
  }

  // --- The 6-digit code / session-only gate (unchanged) -------------------
  return (
    <section className="gate" aria-label="Pair this browser">
      <div className="gate-panel">
        <h1 className="gate-title">Pair your browser</h1>
        <p className="gate-copy">
          {liveMode === true
            ? 'Partner is running in live mode on this machine. Click the Partner icon in the system tray (near the clock), choose Show pairing code, then type the 6-digit code below. Codes expire after a couple of minutes and can be used once.'
            : 'Enter the 6-digit code shown by the Partner app on this machine. The code expires after a couple of minutes and can be used once.'}
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
          {liveMode === false ? (
            <button
              type="button"
              className="btn btn-secondary"
              disabled={demoBusy || busy}
              onClick={() => void fetchDemoCode()}
            >
              {demoBusy ? 'Getting code…' : 'Get demo pairing code'}
            </button>
          ) : null}
        </div>

        <p className="gate-alt">
          No Partner core on this machine?{' '}
          <button
            type="button"
            className="btn-link"
            disabled={busy || demoBusy}
            onClick={() => setMode('session')}
          >
            Use session-only chat
          </button>{' '}
          — talk to your own endpoint with the key kept in this tab only.
        </p>

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
