/**
 * M29 Shared view — what other accounts have handed you, and what you handed them.
 *
 * A share is a COPY (see `core/src/sharing/manager.ts`): the grantee reads it here
 * without ever opening the owner's encrypted database, and can keep it with
 * "Save to my notes". The owner side lists what was shared, can push a current
 * edit into the copy, and can revoke it.
 *
 * The composer deliberately takes a TYPED account name rather than a picker: the
 * account list is the owner's to see, and a member only needs to know who they
 * are giving something to.
 */
import { useCallback, useEffect, useState } from 'react';
import type { Asset, ShareKind } from '@partner/shared';
import { PartnerMarkdown } from './Markdown.js';
import { listAssets } from './lib/assets.js';
import { listConversations } from './lib/conversations.js';
import {
  createShare,
  importShare,
  listReceivedShares,
  listSentShares,
  readReceivedShare,
  refreshShare,
  revokeShare,
} from './lib/account.js';
import type { ShareDetail, ShareRecord } from './lib/account.js';
import { listNotes } from './lib/notes.js';
import type { NoteSummary } from '@partner/shared';
import type { ConversationSummary } from '@partner/shared';
import { isSessionLost } from './lib/personas.js';
import { readStoredToken } from './lib/token.js';

export interface SharedViewProps {
  active: boolean;
  onUnpair: () => void;
}

function when(at: number): string {
  return new Date(at).toLocaleString();
}

export default function SharedView({ active, onUnpair }: SharedViewProps) {
  const [received, setReceived] = useState<ShareRecord[]>([]);
  const [sent, setSent] = useState<ShareRecord[]>([]);
  const [detail, setDetail] = useState<ShareDetail | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Composer state.
  const [kind, setKind] = useState<ShareKind>('note');
  const [notes, setNotes] = useState<NoteSummary[]>([]);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [conversationId, setConversationId] = useState('');
  const [assets, setAssets] = useState<Asset[]>([]);
  const [resourceId, setResourceId] = useState('');
  const [grantee, setGrantee] = useState('');
  const [shared, setShared] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    const token = readStoredToken();
    if (!token) {
      onUnpair();
      return;
    }
    setBusy(true);
    try {
      const [inbox, outbox, myNotes, myChats] = await Promise.all([
        listReceivedShares(token),
        listSentShares(token),
        listNotes(token),
        listConversations(token),
      ]);
      setReceived(inbox);
      setSent(outbox);
      setNotes(myNotes);
      setConversations(myChats);
      setError(null);
    } catch (cause) {
      if (isSessionLost(cause)) {
        onUnpair();
        return;
      }
      setError(cause instanceof Error ? cause.message : 'Could not load shared items.');
    } finally {
      setBusy(false);
    }
  }, [onUnpair]);

  useEffect(() => {
    if (active) void load();
  }, [active, load]);

  // Load the assets of the chosen conversation (assets are conversation-scoped).
  useEffect(() => {
    const token = readStoredToken();
    if (token === null || conversationId === '') {
      setAssets([]);
      return;
    }
    let alive = true;
    void listAssets(token, conversationId)
      .then((list) => {
        if (alive) setAssets(list);
      })
      .catch(() => {
        if (alive) setAssets([]);
      });
    return () => {
      alive = false;
    };
  }, [conversationId]);

  const open = async (id: string): Promise<void> => {
    const token = readStoredToken();
    if (!token) return;
    try {
      setDetail(await readReceivedShare(token, id));
      setNote(null);
    } catch (cause) {
      if (isSessionLost(cause)) onUnpair();
      else setError(cause instanceof Error ? cause.message : 'Could not open it.');
    }
  };

  const save = async (id: string): Promise<void> => {
    const token = readStoredToken();
    if (!token) return;
    try {
      await importShare(token, id);
      setNote('Saved to your notes.');
    } catch (cause) {
      if (isSessionLost(cause)) onUnpair();
      else setError(cause instanceof Error ? cause.message : 'Could not save it.');
    }
  };

  const push = async (id: string): Promise<void> => {
    const token = readStoredToken();
    if (!token) return;
    try {
      await refreshShare(token, id);
      setSent(await listSentShares(token));
      setError(null);
    } catch (cause) {
      if (isSessionLost(cause)) onUnpair();
      else setError(cause instanceof Error ? cause.message : 'Could not update the shared copy.');
    }
  };

  const withdraw = async (id: string): Promise<void> => {
    const token = readStoredToken();
    if (!token) return;
    try {
      await revokeShare(token, id);
      setReceived(await listReceivedShares(token));
      setSent(await listSentShares(token));
    } catch (cause) {
      if (isSessionLost(cause)) onUnpair();
      else setError(cause instanceof Error ? cause.message : 'Could not revoke it.');
    }
  };

  const share = async (): Promise<void> => {
    const token = readStoredToken();
    if (!token) return;
    if (resourceId === '' || grantee.trim() === '') {
      setError('Choose something to share and type the account name to share it with.');
      return;
    }
    setBusy(true);
    try {
      await createShare(token, {
        kind,
        resourceId,
        ...(kind === 'asset' && conversationId !== '' ? { conversationId } : {}),
        grantee: grantee.trim(),
      });
      setSent(await listSentShares(token));
      setShared(
        kind === 'note'
          ? 'Shared. They can read it in their Shared view.'
          : 'Asset shared. They can read it in their Shared view.',
      );
      setError(null);
    } catch (cause) {
      if (isSessionLost(cause)) {
        onUnpair();
        return;
      }
      setError(cause instanceof Error ? cause.message : 'Could not share it.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="shared" aria-label="Shared">
      <div className="shared-panel">
        <div className="page-head">
          <div className="page-head-titles">
            <div className="kicker">Partner</div>
            <h1 className="page-title">Shared</h1>
          </div>
        </div>
        <p className="page-copy">
          Notes and saved assets handed between accounts. A share is a copy: your own space
          stays private, and what you send stays readable to the other person.
        </p>

        {error !== null ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}

        <section className="card" aria-label="Share something">
          <h2 className="card-title">Share something of yours</h2>
          <div className="members-form-row">
            <label className="label" htmlFor="share-kind">
              What
            </label>
            <select
              id="share-kind"
              className="field"
              value={kind}
              disabled={busy}
              onChange={(event) => {
                const next: ShareKind = event.target.value === 'asset' ? 'asset' : 'note';
                setKind(next);
                setResourceId('');
                setShared(null);
              }}
            >
              <option value="note">A note</option>
              <option value="asset">A saved asset</option>
            </select>

            {kind === 'asset' ? (
              <>
                <label className="label" htmlFor="share-conversation">
                  From conversation
                </label>
                <select
                  id="share-conversation"
                  className="field"
                  value={conversationId}
                  disabled={busy}
                  onChange={(event) => {
                    setConversationId(event.target.value);
                    setResourceId('');
                  }}
                >
                  <option value="">Choose a conversation…</option>
                  {conversations.map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.title}
                    </option>
                  ))}
                </select>
              </>
            ) : null}

            <label className="label" htmlFor="share-resource">
              {kind === 'note' ? 'Note' : 'Asset'}
            </label>
            <select
              id="share-resource"
              className="field"
              value={resourceId}
              disabled={busy}
              onChange={(event) => setResourceId(event.target.value)}
            >
              <option value="">Choose…</option>
              {(kind === 'note' ? notes : assets).map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.title}
                </option>
              ))}
            </select>

            <label className="label" htmlFor="share-grantee">
              Share with
            </label>
            <input
              id="share-grantee"
              className="field"
              type="text"
              spellCheck={false}
              placeholder="Their account name"
              value={grantee}
              disabled={busy}
              onChange={(event) => setGrantee(event.target.value)}
            />
          </div>
          <div className="gate-actions-row">
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy || resourceId === '' || grantee.trim() === ''}
              onClick={() => void share()}
            >
              Share
            </button>
          </div>
          {shared !== null ? <p className="form-hint">{shared}</p> : null}
        </section>

        <section className="card" aria-label="Shared with me">
          <h2 className="card-title">Shared with me</h2>
          {received.length === 0 ? (
            <p className="card-copy">Nothing has been shared with you yet.</p>
          ) : (
            <ul className="members-list">
              {received.map((entry) => (
                <li className="members-row" key={entry.id}>
                  <span className="members-row-title">
                    {entry.title}
                    <span className="chip">{entry.kind}</span>
                  </span>
                  <span className="members-row-meta">
                    from {entry.ownerLabel ?? entry.ownerId} · {when(entry.updatedAt)}
                  </span>
                  <div className="row-actions">
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      onClick={() => void open(entry.id)}
                    >
                      Open
                    </button>
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      onClick={() => void save(entry.id)}
                    >
                      Save to my notes
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
          {note !== null ? <p className="form-hint">{note}</p> : null}
          {detail !== null ? (
            <div className="shared-reader">
              <div className="shared-reader-head">
                <span className="members-row-title">{detail.title}</span>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => setDetail(null)}
                >
                  Close
                </button>
              </div>
              <PartnerMarkdown text={detail.body} />
            </div>
          ) : null}
        </section>

        <section className="card" aria-label="Shared by me">
          <h2 className="card-title">Shared by me</h2>
          {sent.length === 0 ? (
            <p className="card-copy">You have not shared anything yet.</p>
          ) : (
            <ul className="members-list">
              {sent.map((entry) => (
                <li className="members-row" key={entry.id}>
                  <span className="members-row-title">
                    {entry.title}
                    <span className="chip">{entry.kind}</span>
                  </span>
                  <span className="members-row-meta">
                    with {entry.granteeLabel ?? entry.granteeId} · {when(entry.createdAt)}
                  </span>
                  <div className="row-actions">
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      onClick={() => void push(entry.id)}
                    >
                      Update copy
                    </button>
                    <button
                      type="button"
                      className="btn btn-danger btn-sm"
                      onClick={() => void withdraw(entry.id)}
                    >
                      Revoke
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </section>
  );
}
