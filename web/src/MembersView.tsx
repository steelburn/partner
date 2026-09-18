/**
 * M29 Members view — the account lane, in the app.
 *
 * Before this view, "who may have an account here?" was answered with
 * `docker compose exec` and a CLI, which means the owner needed shell access to
 * invite their own family. Here an authenticated OWNER mints a single-use
 * invitation, sees what is outstanding, publishes the deployment's AI access for
 * members who have none of their own, and can sign out.
 *
 * A member (non-owner) sees the same view minus the owner surfaces: their own
 * account, the shared access they are riding, and the sign-out control. Nothing
 * here reveals another account's credential; the invite CODE is shown exactly
 * once, in the frame that minted it, and is never persisted.
 */
import { useCallback, useEffect, useState } from 'react';
import type { KeyAccess, UserRole } from '@partner/shared';
import {
  clearSharedAccess,
  fetchAccount,
  fetchSharedAccess,
  listInvites,
  listUsers,
  mintInvite,
  publishSharedAccess,
  revokeInvite,
} from './lib/account.js';
import type { AccountInfo, InviteRecord, SharedAccessStatus, UserRecord } from './lib/account.js';
import { isSessionLost } from './lib/personas.js';
import { readStoredToken } from './lib/token.js';

export interface MembersViewProps {
  /** True while this view is the visible one (drives load on activation). */
  active: boolean;
  /** Drop the session and return to the gate (auth failure / sign out). */
  onUnpair: () => void;
  /** Sign out: the shell revokes the session and clears local state. */
  onSignOut: () => void;
}

function roleCopy(role: UserRole): string {
  return role === 'owner' ? 'Owner' : 'Member';
}

function keyAccessCopy(access: KeyAccess): string {
  return access === 'shared' ? 'Uses this Partner’s AI access' : 'Configures their own providers';
}

function when(at: number): string {
  return new Date(at).toLocaleString();
}

export default function MembersView({ active, onUnpair, onSignOut }: MembersViewProps) {
  /** `undefined` = not loaded yet; `null` = a paired desktop core (no account lane). */
  const [account, setAccount] = useState<AccountInfo | null | undefined>(undefined);
  const [users, setUsers] = useState<UserRecord[]>([]);
  const [invites, setInvites] = useState<InviteRecord[]>([]);
  const [sharedAccess, setSharedAccess] = useState<SharedAccessStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [inviteRole, setInviteRole] = useState<UserRole>('member');
  const [inviteKeyAccess, setInviteKeyAccess] = useState<KeyAccess>('shared');
  const [mintedUrl, setMintedUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    const token = readStoredToken();
    if (!token) {
      onUnpair();
      return;
    }
    setBusy(true);
    try {
      const me = await fetchAccount(token);
      setAccount(me);
      if (me?.role === 'owner') {
        const [list, pending, shared] = await Promise.all([
          listUsers(token),
          listInvites(token),
          fetchSharedAccess(token),
        ]);
        setUsers(list);
        setInvites(pending);
        setSharedAccess(shared);
      } else {
        setUsers([]);
        setInvites([]);
        setSharedAccess(await fetchSharedAccess(token).catch(() => null));
      }
      setError(null);
    } catch (cause) {
      if (isSessionLost(cause)) {
        onUnpair();
        return;
      }
      setError(cause instanceof Error ? cause.message : 'Could not load your account.');
    } finally {
      setBusy(false);
    }
  }, [onUnpair]);

  useEffect(() => {
    if (active) void load();
  }, [active, load]);

  const isOwner = account?.role === 'owner';
  const generate = async (): Promise<void> => {
    const token = readStoredToken();
    if (!token) {
      onUnpair();
      return;
    }
    setBusy(true);
    setCopied(false);
    try {
      const minted = await mintInvite(token, {
        role: inviteRole,
        // An owner always configures their own credentials; the select reflects
        // that, and the server applies the same rule.
        keyAccess: inviteRole === 'owner' ? 'own' : inviteKeyAccess,
      });
      setMintedUrl(minted.url);
      setInvites(await listInvites(token));
      setError(null);
    } catch (cause) {
      if (isSessionLost(cause)) {
        onUnpair();
        return;
      }
      setError(cause instanceof Error ? cause.message : 'Could not create the invitation.');
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (id: string): Promise<void> => {
    const token = readStoredToken();
    if (!token) return;
    try {
      await revokeInvite(token, id);
      setInvites(await listInvites(token));
    } catch (cause) {
      if (isSessionLost(cause)) onUnpair();
      else setError(cause instanceof Error ? cause.message : 'Could not revoke it.');
    }
  };

  const publish = async (): Promise<void> => {
    const token = readStoredToken();
    if (!token) return;
    setBusy(true);
    try {
      await publishSharedAccess(token);
      setSharedAccess(await fetchSharedAccess(token));
      setError(null);
    } catch (cause) {
      if (isSessionLost(cause)) onUnpair();
      else setError(cause instanceof Error ? cause.message : 'Could not publish shared access.');
    } finally {
      setBusy(false);
    }
  };

  const withdraw = async (): Promise<void> => {
    const token = readStoredToken();
    if (!token) return;
    setBusy(true);
    try {
      await clearSharedAccess(token);
      setSharedAccess(await fetchSharedAccess(token));
      setError(null);
    } catch (cause) {
      if (isSessionLost(cause)) onUnpair();
      else setError(cause instanceof Error ? cause.message : 'Could not withdraw shared access.');
    } finally {
      setBusy(false);
    }
  };

  const copy = async (): Promise<void> => {
    if (mintedUrl === null) return;
    try {
      await navigator.clipboard.writeText(mintedUrl);
      setCopied(true);
    } catch {
      setError('Could not copy — select the link and copy it manually.');
    }
  };

  if (account === undefined) {
    return (
      <section className="members" aria-label="Members">
        <div className="members-panel">
          <p className="providers-loading">{error ?? 'Loading your account…'}</p>
        </div>
      </section>
    );
  }

  if (account === null) {
    // The desktop shape: a paired device, not a signed-in account. Sign out is
    // still the useful action (it unpairs), and there is no member list to show.
    return (
      <section className="members" aria-label="Members">
        <div className="members-panel">
          <div className="page-head">
            <div className="page-head-titles">
              <div className="kicker">Partner</div>
              <h1 className="page-title">Account</h1>
            </div>
          </div>
          <p className="page-copy">
            This Partner is paired to this device rather than signed in with a user account, so
            there are no members to manage.
          </p>
          <section className="card" aria-label="This device">
            <h2 className="card-title">This device</h2>
            <p className="card-copy">Signing out revokes this device’s session.</p>
            <div className="gate-actions-row">
              <button type="button" className="btn btn-secondary" onClick={onSignOut}>
                Sign out
              </button>
            </div>
          </section>
        </div>
      </section>
    );
  }

  return (
    <section className="members" aria-label="Members">
      <div className="members-panel">
        <div className="page-head">
          <div className="page-head-titles">
            <div className="kicker">Partner</div>
            <h1 className="page-title">Members</h1>
          </div>
        </div>
        <p className="page-copy">
          Who has an account on this Partner, and what each account may use. Accounts keep
          separate spaces: no one sees another person’s notes, chats or files.
        </p>

        {error !== null ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}

        <section className="card" aria-label="Your account">
          <h2 className="card-title">{account.label}</h2>
          <p className="card-copy">
            {roleCopy(account.role)} · {keyAccessCopy(account.keyAccess)}
          </p>
          <div className="gate-actions-row">
            <button type="button" className="btn btn-secondary" onClick={onSignOut}>
              Sign out
            </button>
          </div>
          <p className="form-hint">
            Signing out ends this device’s session and closes your space until you sign in again.
          </p>
        </section>

        {isOwner ? (
          <>
            <section className="card" aria-label="Invite someone">
              <h2 className="card-title">Invite someone</h2>
              <p className="card-copy">
                The link creates ONE account. They choose their own name and passphrase, so you
                never see their password.
              </p>
              <div className="members-form-row">
                <label className="label" htmlFor="invite-role">
                  Role
                </label>
                <select
                  id="invite-role"
                  className="field"
                  value={inviteRole}
                  disabled={busy}
                  onChange={(event) => {
                    const next = event.target.value === 'owner' ? 'owner' : 'member';
                    setInviteRole(next);
                    if (next === 'owner') setInviteKeyAccess('own');
                    else setInviteKeyAccess('shared');
                  }}
                >
                  <option value="member">Member — own space, uses shared access</option>
                  <option value="owner">Owner — can invite and publish access</option>
                </select>
                <label className="label" htmlFor="invite-keys">
                  AI access
                </label>
                <select
                  id="invite-keys"
                  className="field"
                  value={inviteRole === 'owner' ? 'own' : inviteKeyAccess}
                  disabled={busy || inviteRole === 'owner'}
                  onChange={(event) =>
                    setInviteKeyAccess(event.target.value === 'own' ? 'own' : 'shared')
                  }
                >
                  <option value="shared">Use this Partner’s access (no key needed)</option>
                  <option value="own">Set up their own providers</option>
                </select>
              </div>
              <div className="gate-actions-row">
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={busy}
                  aria-busy={busy}
                  onClick={() => void generate()}
                >
                  {busy ? 'Creating…' : 'Create invitation link'}
                </button>
              </div>
              {mintedUrl !== null ? (
                <>
                  <div className="pair-link-box">
                    <p className="pair-link-label">Send this to them (single use)</p>
                    <p className="pair-link-value">{mintedUrl}</p>
                  </div>
                  <div className="gate-actions-row">
                    <button type="button" className="btn btn-secondary" onClick={() => void copy()}>
                      {copied ? 'Copied' : 'Copy link'}
                    </button>
                  </div>
                </>
              ) : null}
            </section>

            <section className="card" aria-label="Pending invitations">
              <h2 className="card-title">Invitations</h2>
              {invites.length === 0 ? (
                <p className="card-copy">No invitations yet.</p>
              ) : (
                <ul className="members-list">
                  {invites.map((invite) => (
                    <li className="members-row" key={invite.id}>
                      <span className="members-row-title">
                        {roleCopy(invite.role)} · {invite.keyAccess === 'shared' ? 'shared AI' : 'own AI'}
                      </span>
                      <span className="members-row-meta">
                        {invite.state === 'pending'
                          ? `Expires ${when(invite.expiresAt)}`
                          : invite.state === 'used'
                            ? `Used${invite.usedBy ? ` by ${invite.usedBy}` : ''}`
                            : 'Expired'}
                      </span>
                      {invite.state === 'pending' ? (
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          onClick={() => void revoke(invite.id)}
                        >
                          Revoke
                        </button>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="card" aria-label="Shared AI access">
              <h2 className="card-title">Shared AI access</h2>
              <p className="card-copy">
                {sharedAccess?.configured === true
                  ? `${sharedAccess.providerCount} provider${sharedAccess.providerCount === 1 ? '' : 's'}${
                      sharedAccess.searchConfigured ? ' and web search' : ''
                    } published for members who have none of their own.`
                  : 'Nothing is published yet. Members who were invited with shared access can chat only after you publish.'}
              </p>
              <div className="gate-actions-row">
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={busy}
                  onClick={() => void publish()}
                >
                  Publish my AI access
                </button>
                {sharedAccess?.configured === true ? (
                  <button
                    type="button"
                    className="btn btn-danger"
                    disabled={busy}
                    onClick={() => void withdraw()}
                  >
                    Withdraw
                  </button>
                ) : null}
              </div>
              <p className="form-hint">
                Only the endpoints and model lists are shared; your keys stay in this machine’s
                keychain and are never sent to another account.
              </p>
            </section>

            <section className="card" aria-label="Accounts">
              <h2 className="card-title">Accounts</h2>
              <ul className="members-list">
                {users.map((user) => (
                  <li className="members-row" key={user.id}>
                    <span className="members-row-title">
                      {user.label}
                      {user.disabledAt !== null ? ' (disabled)' : ''}
                    </span>
                    <span className="members-row-meta">
                      {roleCopy(user.role)} ·{' '}
                      {user.keyAccess === 'shared' ? 'shared AI access' : 'own providers'}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          </>
        ) : (
          <section className="card" aria-label="Shared AI access">
            <h2 className="card-title">AI access</h2>
            <p className="card-copy">
              {sharedAccess?.configured === true
                ? 'You are using the AI access shared by this Partner’s owner. Add your own provider in Providers at any time and yours will be used instead.'
                : 'No shared AI access is published. Ask the owner to publish theirs, or add your own provider in Providers.'}
            </p>
          </section>
        )}
      </div>
    </section>
  );
}
