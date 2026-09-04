import { useCallback, useEffect, useState } from 'react';
import type { ThemeMode } from '@partner/shared';
import type { PendingToolCall } from '@partner/shared/src/tools.js';
import ChatStrip from './ChatStrip.js';
import FilesView from './FilesView.js';
import PairGate from './PairGate.js';
import ProvidersView from './ProvidersView.js';
import { revokeSession } from './lib/api.js';
import { listPending } from './lib/tools.js';
import { clearStoredToken, readStoredToken } from './lib/token.js';
import { applyMode, getInitialMode, persistMode } from './theme/apply.js';

/** How often the shell refreshes the pending-approval count for the badge. */
const QUEUE_POLL_MS = 4000;

type ViewName = 'chat' | 'providers' | 'files';

/**
 * App shell: header row (brand + view switch + light/dark toggle) and a main
 * area that shows PairGate until a session token exists, then the Chat,
 * Providers and Files views. All views stay mounted once paired so an
 * in-flight chat stream or form state survives switching; only the active one
 * is visible. While paired, the approval-queue poll keeps the Files tab badge
 * and the Files view's queue fresh (~4s + on window focus).
 */
export default function App() {
  const [mode, setMode] = useState<ThemeMode>(() => getInitialMode());
  const [paired, setPaired] = useState<boolean>(() => readStoredToken() !== null);
  const [view, setView] = useState<ViewName>('chat');
  // Live approval-queue rows: polled while paired so the Files tab shows a
  // badge count and the Files view always has fresh rows to act on.
  const [pending, setPending] = useState<PendingToolCall[]>([]);

  useEffect(() => {
    applyMode(mode);
  }, [mode]);

  const refreshQueue = useCallback((): void => {
    const token = readStoredToken();
    if (!token) {
      setPending([]);
      return;
    }
    // A stale/expired session is handled by the views' own 401 handling;
    // the badge just stays on its last known value until pairing returns.
    void listPending(token)
      .then(setPending)
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!paired) {
      setPending([]);
      return;
    }
    refreshQueue();
    const timer = window.setInterval(refreshQueue, QUEUE_POLL_MS);
    const onFocus = (): void => refreshQueue();
    window.addEventListener('focus', onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [paired, refreshQueue]);

  const handleToggleMode = (): void => {
    const next: ThemeMode = mode === 'light' ? 'dark' : 'light';
    setMode(next);
    persistMode(next);
  };

  const handlePaired = (): void => setPaired(true);

  const handleUnpair = (): void => {
    // Best-effort server-side revocation so a leaked token cannot outlive
    // "Unpair"/"Pair again"; local state clears regardless of network fate.
    const token = readStoredToken();
    if (token) void revokeSession(token).catch(() => undefined);
    clearStoredToken();
    setPaired(false);
  };

  const nextModeLabel = mode === 'light' ? 'Dark' : 'Light';

  return (
    <div className="app">
      <header className="app-header">
        <div className="app-header-inner">
          <div className="app-header-left">
            <span className="app-brand">Partner</span>
            {paired ? (
              <div className="view-switch" role="group" aria-label="Partner views">
                <button
                  type="button"
                  className="btn btn-secondary view-tab"
                  onClick={() => setView('chat')}
                  aria-pressed={view === 'chat'}
                >
                  Chat
                </button>
                <button
                  type="button"
                  className="btn btn-secondary view-tab"
                  onClick={() => setView('providers')}
                  aria-pressed={view === 'providers'}
                >
                  Providers
                </button>
                <button
                  type="button"
                  className="btn btn-secondary view-tab"
                  onClick={() => setView('files')}
                  aria-pressed={view === 'files'}
                  aria-label={
                    pending.length > 0
                      ? `Files — ${pending.length} pending approval${pending.length === 1 ? '' : 's'}`
                      : 'Files'
                  }
                >
                  Files
                  {pending.length > 0 ? (
                    <span className="tab-badge" aria-hidden="true">
                      {pending.length > 99 ? '99+' : pending.length}
                    </span>
                  ) : null}
                </button>
              </div>
            ) : null}
          </div>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={handleToggleMode}
            aria-pressed={mode === 'dark'}
            aria-label={`Switch to ${nextModeLabel.toLowerCase()} theme`}
          >
            {nextModeLabel}
          </button>
        </div>
      </header>
      <main className="app-main">
        {paired ? (
          <>
            <div className={view === 'chat' ? 'app-view app-view-active' : 'app-view'}>
              <ChatStrip onUnpair={handleUnpair} />
            </div>
            <div className={view === 'providers' ? 'app-view app-view-active' : 'app-view'}>
              <ProvidersView onUnpair={handleUnpair} active={view === 'providers'} />
            </div>
            <div className={view === 'files' ? 'app-view app-view-active' : 'app-view'}>
              <FilesView
                onUnpair={handleUnpair}
                active={view === 'files'}
                pending={pending}
                onRefreshPending={refreshQueue}
              />
            </div>
          </>
        ) : (
          <PairGate onPaired={handlePaired} />
        )}
      </main>
    </div>
  );
}
