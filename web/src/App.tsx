import { useEffect, useState } from 'react';
import type { ThemeMode } from '@partner/shared';
import ChatStrip from './ChatStrip.js';
import PairGate from './PairGate.js';
import ProvidersView from './ProvidersView.js';
import { revokeSession } from './lib/api.js';
import { clearStoredToken, readStoredToken } from './lib/token.js';
import { applyMode, getInitialMode, persistMode } from './theme/apply.js';

type ViewName = 'chat' | 'providers';

/**
 * App shell: header row (brand + view switch + light/dark toggle) and a main
 * area that shows PairGate until a session token exists, then the Chat and
 * Providers views. Both views stay mounted once paired so an in-flight chat
 * stream or form state survives switching; only the active one is visible.
 */
export default function App() {
  const [mode, setMode] = useState<ThemeMode>(() => getInitialMode());
  const [paired, setPaired] = useState<boolean>(() => readStoredToken() !== null);
  const [view, setView] = useState<ViewName>('chat');

  useEffect(() => {
    applyMode(mode);
  }, [mode]);

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
          </>
        ) : (
          <PairGate onPaired={handlePaired} />
        )}
      </main>
    </div>
  );
}
