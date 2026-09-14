/**
 * Login gate (M22) — the remote-hosted core's way in.
 *
 * Presentational on purpose: `PairGate` owns the intent (which gate to show, the
 * request, the token), this owns what the user sees, so the states a review can
 * falsify (a missing password field, an enabled submit while busy, the
 * "no account yet" case) are render-testable without a DOM. Token-styled only.
 */
export interface LoginGateProps {
  username: string;
  password: string;
  busy: boolean;
  /** Refusal text from the core, already mapped to the user's words. */
  error: string | null;
  /** True when the core reported that no account exists yet. */
  noAccountYet: boolean;
  /**
   * M22 sign-up: true when this core can create an account from here (an invite
   * minted on its machine). Off by default, so a deployment that never opted in
   * shows exactly the form it always had.
   */
  signupAvailable?: boolean;
  /** Host the page is served from — shown so the user knows WHERE they are. */
  host: string;
  onUsername: (value: string) => void;
  onPassword: (value: string) => void;
  onSubmit: () => void;
  onSessionOnly: () => void;
  /** Offered only when `signupAvailable`; opens the invite form. */
  onSignUp?: () => void;
}

export function LoginGate({
  username,
  password,
  busy,
  error,
  noAccountYet,
  signupAvailable = false,
  host,
  onUsername,
  onPassword,
  onSubmit,
  onSessionOnly,
  onSignUp,
}: LoginGateProps) {
  const canSubmit = username.trim() !== '' && password !== '' && !busy && !noAccountYet;
  // With sign-up available, "no account yet" is an invitation rather than a
  // dead end: the first account on a hosted core is created the same way as any
  // other (an invite minted on the machine). The form is NOT rendered in that
  // case — a sign-in attempt there could only ever answer 409.
  const showSignUp = signupAvailable && onSignUp !== undefined;

  return (
    <section className="gate" aria-label="Sign in">
      <div className="gate-panel">
        <h1 className="gate-title">Sign in</h1>
        <p className="gate-copy">
          {noAccountYet
            ? 'This Partner has no account yet. Create one on the machine running it, then sign in here.'
            : `Sign in to your Partner at ${host}. Your conversation history, notes and memory are stored on that machine, not in this browser.`}
        </p>

        {noAccountYet ? (
          <>
            <p className="session-notice">
              On the machine running Partner:{' '}
              <code>docker compose exec partner node tools/user.mjs add &lt;your-name&gt;</code>
              {showSignUp
                ? ` — or, with sign-up enabled, mint an invite instead (tools/signup-link.mjs) and open the link it prints.`
                : null}
            </p>
            {showSignUp ? (
              <button
                type="button"
                className="btn btn-primary btn-block"
                disabled={busy}
                onClick={onSignUp}
              >
                I have an invite
              </button>
            ) : null}
          </>
        ) : (
          <form
            className="gate-form"
            onSubmit={(event) => {
              event.preventDefault();
              if (canSubmit) onSubmit();
            }}
            aria-busy={busy}
          >
            <label className="label" htmlFor="login-username">
              Username
            </label>
            <input
              id="login-username"
              className="field"
              type="text"
              autoComplete="username"
              spellCheck={false}
              value={username}
              disabled={busy}
              onChange={(event) => onUsername(event.target.value)}
            />
            <label className="label" htmlFor="login-password">
              Password
            </label>
            <input
              id="login-password"
              className="field"
              type="password"
              autoComplete="current-password"
              value={password}
              disabled={busy}
              onChange={(event) => onPassword(event.target.value)}
              aria-describedby={error ? 'login-error' : undefined}
            />
            <button
              type="submit"
              className="btn btn-primary btn-block"
              disabled={!canSubmit}
              aria-busy={busy}
            >
              {busy ? 'Signing in…' : 'Sign in'}
            </button>
          </form>
        )}

        <div className="gate-feedback" aria-live="polite">
          {error ? (
            <p id="login-error" className="form-error" role="alert">
              {error}
            </p>
          ) : null}
        </div>

        <p className="gate-alt">
          {showSignUp && !noAccountYet ? (
            <>
              Have an invite?{' '}
              <button type="button" className="btn-link" disabled={busy} onClick={onSignUp}>
                Create an account
              </button>
              .{' '}
            </>
          ) : null}
          Signing in needs this server to be reachable — it is not the same as the{' '}
          <button type="button" className="btn-link" disabled={busy} onClick={onSessionOnly}>
            session-only chat
          </button>{' '}
          that keeps a key in this tab only.
        </p>
      </div>
    </section>
  );
}
