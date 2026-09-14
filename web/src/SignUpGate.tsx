/**
 * Sign-up gate (M22) — creating an account on a hosted core with an invite.
 *
 * Presentational on purpose, like `LoginGate`: `PairGate` owns the intent (the
 * invite from the link, the request, the sign-in that follows), so the states a
 * review can falsify — a missing confirm field, a disabled submit while busy, the
 * rule sentences shown BEFORE submit, the "no invite in this link" case — are
 * render-testable without a DOM.
 *
 * The rules themselves are NOT written here: `@partner/shared/accounts` holds the
 * username and passphrase rules and their wording, which the core applies to the
 * same request. A form that promised something the server refuses is the failure
 * this arrangement exists to prevent.
 */
import { MIN_PASSPHRASE_LENGTH, passphraseProblem, usernameProblem } from '@partner/shared';

export interface SignUpGateProps {
  username: string;
  password: string;
  confirm: string;
  /** The single-use invite code: prefilled from the link, editable for a paste. */
  code: string;
  busy: boolean;
  /** The core's refusal, already mapped to the user's words. */
  error: string | null;
  /** Host the page is served from, so the person knows WHERE the account lands. */
  host: string;
  /** True when the code arrived in the invite link (vs typed/pasted by hand). */
  invited: boolean;
  onUsername: (value: string) => void;
  onPassword: (value: string) => void;
  onConfirm: (value: string) => void;
  onCode: (value: string) => void;
  onSubmit: () => void;
  onSignIn: () => void;
}

export function SignUpGate({
  username,
  password,
  confirm,
  code,
  busy,
  error,
  host,
  invited,
  onUsername,
  onPassword,
  onConfirm,
  onCode,
  onSubmit,
  onSignIn,
}: SignUpGateProps) {
  const nameProblem = usernameProblem(username);
  const passProblem = passphraseProblem(password);
  // Confirm is compared only once the passphrase itself is acceptable, so a
  // half-typed confirmation is not called a mismatch.
  const mismatch = passProblem === null && password !== confirm;
  const canSubmit =
    code !== '' &&
    username.trim() !== '' &&
    nameProblem === null &&
    passProblem === null &&
    !mismatch &&
    !busy;

  return (
    <section className="gate" aria-label="Create an account">
      <div className="gate-panel">
        <h1 className="gate-title">Create your account</h1>
        <p className="gate-copy">
          {invited
            ? `Your invite for ${host} is ready. Pick a name and a passphrase — both are yours, and the person running this server never sees the passphrase.`
            : `Create an account on ${host}. Pick a name and a passphrase — both are yours, and the person running this server never sees the passphrase.`}
        </p>

        <form
          className="gate-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (canSubmit) onSubmit();
          }}
          aria-busy={busy}
        >
          <label className="label" htmlFor="signup-code">
            Invite code
          </label>
          <input
            id="signup-code"
            className="field"
            type="text"
            inputMode="text"
            autoComplete="off"
            spellCheck={false}
            value={code}
            disabled={busy}
            onChange={(event) => onCode(event.target.value.trim())}
            aria-describedby="signup-code-hint"
          />
          <p id="signup-code-hint" className="form-hint">
            {invited
              ? 'Filled in from the link you opened. Invites are single use.'
              : 'Paste the code from the invite link you were sent, or open that link directly.'}
          </p>

          <label className="label" htmlFor="signup-username">
            Your name
          </label>
          <input
            id="signup-username"
            className="field"
            type="text"
            autoComplete="username"
            spellCheck={false}
            value={username}
            disabled={busy}
            onChange={(event) => onUsername(event.target.value)}
            aria-describedby="signup-username-hint"
          />
          <p id="signup-username-hint" className="form-hint">
            {nameProblem ?? 'This is what you sign in with, and the name of your own space.'}
          </p>

          <label className="label" htmlFor="signup-password">
            Passphrase
          </label>
          <input
            id="signup-password"
            className="field"
            type="password"
            autoComplete="new-password"
            value={password}
            disabled={busy}
            onChange={(event) => onPassword(event.target.value)}
            aria-describedby="signup-password-hint"
          />
          <p id="signup-password-hint" className="form-hint">
            {passProblem ?? `At least ${MIN_PASSPHRASE_LENGTH} characters.`}
          </p>

          <label className="label" htmlFor="signup-confirm">
            Repeat the passphrase
          </label>
          <input
            id="signup-confirm"
            className="field"
            type="password"
            autoComplete="new-password"
            value={confirm}
            disabled={busy}
            onChange={(event) => onConfirm(event.target.value)}
            aria-describedby="signup-confirm-hint"
          />
          <p id="signup-confirm-hint" className="form-hint">
            {mismatch ? 'These two do not match yet.' : 'Type it once more so a typo cannot lock you out.'}
          </p>

          <button
            type="submit"
            className="btn btn-primary btn-block"
            disabled={!canSubmit}
            aria-busy={busy}
          >
            {busy ? 'Creating your account…' : 'Create account'}
          </button>
        </form>

        <div className="gate-feedback" aria-live="polite">
          {error ? (
            <p className="form-error" role="alert">
              {error}
            </p>
          ) : null}
        </div>

        <p className="gate-alt">
          Already have an account here?{' '}
          <button type="button" className="btn-link" disabled={busy} onClick={onSignIn}>
            Sign in
          </button>
          .
        </p>
      </div>
    </section>
  );
}
