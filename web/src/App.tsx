import { useCallback, useEffect, useState } from 'react';
import type { ConversationSummary, Persona, ThemeMode } from '@partner/shared';
import type { PendingToolCall } from '@partner/shared/src/tools.js';
import type { StreamDoneMeta } from './lib/api.js';
import ChatStrip from './ChatStrip.js';
import ConversationRail from './ConversationRail.js';
import FilesView from './FilesView.js';
import PairGate from './PairGate.js';
import PersonaManagerView from './PersonaManagerView.js';
import PersonaPicker from './PersonaPicker.js';
import ProvidersView from './ProvidersView.js';
import { revokeSession } from './lib/api.js';
import { createConversation, deleteConversation, listConversations } from './lib/conversations.js';
import { isSessionLost, listPersonas } from './lib/personas.js';
import { listPending } from './lib/tools.js';
import { clearStoredToken, readStoredToken } from './lib/token.js';
import { applyMode, getInitialMode, persistMode } from './theme/apply.js';

/** How often the shell refreshes the pending-approval count for the badge. */
const QUEUE_POLL_MS = 4000;

type ViewName = 'chat' | 'personas' | 'providers' | 'files';

/**
 * App shell (M3): header row carries the brand, the view switch, the active
 * persona picker (chips + paused state) and the light/dark toggle; the chat
 * view hosts the conversation rail next to the ChatStrip. All views stay
 * mounted once paired so an in-flight chat stream or form state survives
 * switching — only the active one is visible. Personas + conversations load
 * on pair; the rail/conversation list refreshes after each persisted turn.
 */
export default function App() {
  const [mode, setMode] = useState<ThemeMode>(() => getInitialMode());
  const [paired, setPaired] = useState<boolean>(() => readStoredToken() !== null);
  const [view, setView] = useState<ViewName>('chat');
  // Live approval-queue rows: polled while paired so the Files tab shows a
  // badge count and the Files view always has fresh rows to act on.
  const [pending, setPending] = useState<PendingToolCall[]>([]);

  // M3 identity + conversation state (single source of truth for the shell).
  const [personas, setPersonas] = useState<Persona[] | null>(null);
  const [personasError, setPersonasError] = useState<string | null>(null);
  const [conversations, setConversations] = useState<ConversationSummary[] | null>(null);
  const [conversationsError, setConversationsError] = useState<string | null>(null);
  const [activePersonaId, setActivePersonaId] = useState<string | null>(null);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [creatingChat, setCreatingChat] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);

  useEffect(() => {
    applyMode(mode);
  }, [mode]);

  const handlePaired = (): void => setPaired(true);

  const handleUnpair = (): void => {
    // Best-effort server-side revocation so a leaked token cannot outlive
    // "Unpair"/"Pair again"; local state clears regardless of network fate.
    const token = readStoredToken();
    if (token) void revokeSession(token).catch(() => undefined);
    clearStoredToken();
    setPaired(false);
  };

  const handleSessionLost = useCallback((): void => {
    handleUnpair();
  }, []);

  // -------------------------------------------------------------------------
  // Data loading (personas + conversations)
  // -------------------------------------------------------------------------

  const refreshPersonas = useCallback(async (): Promise<void> => {
    const token = readStoredToken();
    if (!token) return;
    try {
      setPersonas(await listPersonas(token));
      setPersonasError(null);
    } catch (cause) {
      if (!isSessionLost(cause)) {
        setPersonasError(
          cause instanceof Error ? cause.message : 'Could not load personas.',
        );
      }
    }
  }, []);

  const refreshConversations = useCallback(async (): Promise<void> => {
    const token = readStoredToken();
    if (!token) return;
    try {
      setConversations(await listConversations(token));
      setConversationsError(null);
    } catch (cause) {
      if (!isSessionLost(cause)) {
        setConversationsError(
          cause instanceof Error ? cause.message : 'Could not load conversations.',
        );
      }
    }
  }, []);

  const refreshQueue = useCallback((): void => {
    const token = readStoredToken();
    if (!token) {
      setPending([]);
      return;
    }
    // A stale/expired session is handled by the views' own 401 handling.
    void listPending(token)
      .then(setPending)
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!paired) {
      setPending([]);
      setPersonas(null);
      setPersonasError(null);
      setConversations(null);
      setConversationsError(null);
      setActivePersonaId(null);
      setActiveConversationId(null);
      setStreaming(false);
      setCreatingChat(false);
      setChatError(null);
      return;
    }
    void refreshPersonas();
    void refreshConversations();
    refreshQueue();
    const timer = window.setInterval(refreshQueue, QUEUE_POLL_MS);
    const onFocus = (): void => {
      refreshQueue();
      // Core may have started after the page; backfill lists that never
      // loaded so the persona picker/rail appear without a manual refresh.
      if (personas === null && personasError === null) void refreshPersonas();
      if (conversations === null && conversationsError === null) void refreshConversations();
    };
    window.addEventListener('focus', onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paired, refreshPersonas, refreshConversations, refreshQueue]);

  // Keep the active persona valid as the list changes (default > first).
  useEffect(() => {
    if (!personas || personas.length === 0) {
      setActivePersonaId(null);
      return;
    }
    setActivePersonaId((prev) => {
      if (prev !== null && personas.some((p) => p.id === prev)) return prev;
      const fallback = personas.find((p) => p.isDefault) ?? personas[0];
      return fallback ? fallback.id : null;
    });
  }, [personas]);

  const activePersona = personas?.find((p) => p.id === activePersonaId) ?? null;

  // -------------------------------------------------------------------------
  // Conversation actions (rail + auto-created chats)
  // -------------------------------------------------------------------------

  const handleNewChat = async (): Promise<void> => {
    if (streaming || creatingChat) return;
    const token = readStoredToken();
    if (!token) {
      handleSessionLost();
      return;
    }
    setCreatingChat(true);
    setChatError(null);
    try {
      const created = await createConversation(token, {
        ...(activePersonaId ? { personaId: activePersonaId } : {}),
      });
      setActiveConversationId(created.id);
      setView('chat');
      await refreshConversations();
    } catch (cause) {
      if (isSessionLost(cause)) {
        handleSessionLost();
        return;
      }
      setChatError(
        cause instanceof Error ? cause.message : 'Could not start a new conversation.',
      );
    } finally {
      setCreatingChat(false);
    }
  };

  const handleOpenConversation = (id: string): void => {
    if (streaming || id === activeConversationId) return;
    // Continuity: opening a persona-bound conversation adopts that persona.
    const target = conversations?.find((c) => c.id === id);
    if (target?.personaId && personas?.some((p) => p.id === target.personaId)) {
      setActivePersonaId(target.personaId);
    }
    setChatError(null);
    setActiveConversationId(id);
    setView('chat');
  };

  const handleDeleteConversation = async (id: string): Promise<void> => {
    const token = readStoredToken();
    if (!token) {
      handleSessionLost();
      return;
    }
    try {
      await deleteConversation(token, id);
      if (id === activeConversationId) setActiveConversationId(null);
      await refreshConversations();
    } catch (cause) {
      if (isSessionLost(cause)) {
        handleSessionLost();
        return;
      }
      setChatError(
        cause instanceof Error ? cause.message : 'Could not delete the conversation.',
      );
    }
  };

  /** After a persisted turn: adopt an auto-created conversation + refresh. */
  const handleDone = (meta: StreamDoneMeta): void => {
    if (activeConversationId === null) setActiveConversationId(meta.conversationId);
    void refreshConversations();
  };

  const handleToggleMode = (): void => {
    const next: ThemeMode = mode === 'light' ? 'dark' : 'light';
    setMode(next);
    persistMode(next);
  };

  const nextModeLabel = mode === 'light' ? 'Dark' : 'Light';
  const personasLoaded = personas !== null;
  const railLocked = streaming || creatingChat;

  return (
    <div className="app">
      <header className="app-header">
        <div className="app-header-inner">
          <div className="app-header-left">
            <span className="app-brand">Partner</span>
            {paired ? (
              <>
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
                    onClick={() => setView('personas')}
                    aria-pressed={view === 'personas'}
                  >
                    Personas
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
                {personasLoaded && personas.length > 0 ? (
                  <PersonaPicker
                    personas={personas}
                    activePersonaId={activePersonaId}
                    disabled={streaming}
                    onSelect={setActivePersonaId}
                  />
                ) : null}
              </>
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
              <div className="chat-workspace">
                <ConversationRail
                  conversations={conversations}
                  loadError={conversationsError}
                  disabled={railLocked}
                  creating={creatingChat}
                  activeConversationId={activeConversationId}
                  onNewChat={() => void handleNewChat()}
                  onOpen={handleOpenConversation}
                  onDelete={handleDeleteConversation}
                  onRetry={() => void refreshConversations()}
                />
                <ChatStrip
                  onUnpair={handleSessionLost}
                  conversationId={activeConversationId}
                  personaId={activePersonaId}
                  personaName={activePersona?.name ?? null}
                  personaPaused={Boolean(activePersona?.paused)}
                  onStreamingChange={setStreaming}
                  onDone={handleDone}
                />
              </div>
              {chatError ? (
                <p className="chat-shell-error" role="alert">
                  {chatError}
                </p>
              ) : null}
            </div>
            <div className={view === 'personas' ? 'app-view app-view-active' : 'app-view'}>
              <PersonaManagerView
                personas={personas}
                loadError={personasError}
                onUnpair={handleSessionLost}
                onRefresh={() => void refreshPersonas()}
                active={view === 'personas'}
              />
            </div>
            <div className={view === 'providers' ? 'app-view app-view-active' : 'app-view'}>
              <ProvidersView onUnpair={handleSessionLost} active={view === 'providers'} />
            </div>
            <div className={view === 'files' ? 'app-view app-view-active' : 'app-view'}>
              <FilesView
                onUnpair={handleSessionLost}
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
