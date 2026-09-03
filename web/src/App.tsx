import { useEffect, useState } from 'react';
import type { ThemeMode } from '@partner/shared';
import ChatStrip from './ChatStrip.js';
import PairGate from './PairGate.js';
import { clearStoredToken, readStoredToken } from './lib/token.js';
import { applyMode, getInitialMode, persistMode } from './theme/apply.js';

/**
 * App shell: header row (brand + light/dark toggle) and a main area that
 * shows PairGate until a session token exists, then the ChatStrip.
 */
export default function App() {
  const [mode, setMode] = useState<ThemeMode>(() => getInitialMode());
  const [paired, setPaired] = useState<boolean>(() => readStoredToken() !== null);

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
    clearStoredToken();
    setPaired(false);
  };

  const nextModeLabel = mode === 'light' ? 'Dark' : 'Light';

  return (
    <div className="app">
      <header className="app-header">
        <div className="app-header-inner">
          <span className="app-brand">Partner</span>
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
        {paired ? <ChatStrip onUnpair={handleUnpair} /> : <PairGate onPaired={handlePaired} />}
      </main>
    </div>
  );
}
