import { useCallback, useEffect, useState } from 'react';
import type { ConversationSummary, Folder, Persona, ThemeMode } from '@partner/shared';
import type { ActiveTheme, ThemeProfile } from '@partner/shared';
import type { PendingToolCall } from '@partner/shared/src/tools.js';
import type { StreamDoneMeta } from './lib/api.js';
import type { ThemeTokenPair } from './lib/theme-helpers.js';
import ChatStrip from './ChatStrip.js';
import { NotesMini } from './NotesMini.js';
import AuditView from './AuditView.js';
import ConversationRail from './ConversationRail.js';
import FilesView from './FilesView.js';
import MemoryView from './MemoryView.js';
import NotesView from './NotesView.js';
import PairGate from './PairGate.js';
import PersonaManagerView from './PersonaManagerView.js';
import PersonaPicker from './PersonaPicker.js';
import PlaybooksView from './PlaybooksView.js';
import ProvidersView from './ProvidersView.js';
import SkillsView from './SkillsView.js';
import ThemeStudio from './ThemeStudio.js';
import { revokeSession } from './lib/api.js';
import { createConversation, deleteConversation, listConversations } from './lib/conversations.js';
import {
  createFolder,
  deleteFolder,
  listFolders,
  updateConversation,
  updateFolder,
} from './lib/folders.js';
import { isSessionLost, listPersonas } from './lib/personas.js';
import { bindConversationTheme, getActiveTheme, listThemes } from './lib/themes.js';
import { listPending } from './lib/tools.js';
import { clearStoredToken, readStoredToken } from './lib/token.js';
import {
  applyMode,
  applyThemeTokens,
  cacheThemePair,
  clearCachedThemePair,
  getInitialMode,
  persistMode,
} from './theme/apply.js';

/** How often the shell refreshes the pending-approval count for the badge. */
const QUEUE_POLL_MS = 4000;

type ViewName =
  | 'chat'
  | 'personas'
  | 'providers'
  | 'files'
  | 'memory'
  | 'themes'
  | 'notes'
  | 'skills'
  | 'playbooks'
  | 'audit';

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
  const [folders, setFolders] = useState<Folder[] | null>(null);
  const [foldersError, setFoldersError] = useState<string | null>(null);
  /** M11 F6: increments open Notes quick capture (header / Ctrl+K). */
  const [noteCaptureNonce, setNoteCaptureNonce] = useState(0);
  const [activePersonaId, setActivePersonaId] = useState<string | null>(null);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [creatingChat, setCreatingChat] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);
  // M6 theming: the theme list (studio + persona binds), the resolved active
  // theme for the current persona, and an optional studio draft preview.
  const [themes, setThemes] = useState<ThemeProfile[] | null>(null);
  const [themesError, setThemesError] = useState<string | null>(null);
  const [activeTheme, setActiveTheme] = useState<ActiveTheme | null>(null);
  const [previewTokens, setPreviewTokens] = useState<ThemeTokenPair | null>(null);

  // The FIRST paint always uses the canonical tokens (main.tsx applyMode);
  // this effect re-applies whenever the mode flips, the resolved active
  // theme arrives, or a studio draft preview is pushed. The preview (if
  // any) wins, then the active theme, then the canonical defaults.
  useEffect(() => {
    if (previewTokens !== null) {
      applyThemeTokens(previewTokens.light, previewTokens.dark, mode);
      return;
    }
    if (activeTheme !== null) {
      applyThemeTokens(activeTheme.light, activeTheme.dark, mode);
      cacheThemePair(activeTheme.light, activeTheme.dark, mode);
      return;
    }
    applyMode(mode);
    clearCachedThemePair();
  }, [mode, activeTheme, previewTokens]);

  // A studio draft preview is only meaningful while the Theme view is open;
  // leaving restores whatever the active theme resolves to.
  useEffect(() => {
    if (view !== 'themes') setPreviewTokens(null);
  }, [view]);

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

  // M11 F11: flat folder list (tree assembly lives in the rail).
  const refreshFolders = useCallback(async (): Promise<void> => {
    const token = readStoredToken();
    if (!token) return;
    try {
      setFolders(await listFolders(token));
      setFoldersError(null);
    } catch (cause) {
      if (!isSessionLost(cause)) {
        setFoldersError(cause instanceof Error ? cause.message : 'Could not load folders.');
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

  // M6: theme list + resolved active theme. The active theme is persona-
  // scoped (persona.colorTheme -> global active -> preset), so it refetches
  // whenever the active persona changes.
  const refreshThemes = useCallback(async (): Promise<void> => {
    const token = readStoredToken();
    if (!token) return;
    try {
      setThemes(await listThemes(token));
      setThemesError(null);
    } catch (cause) {
      if (!isSessionLost(cause)) {
        setThemesError(
          cause instanceof Error ? cause.message : 'Could not load themes.',
        );
      }
    }
  }, []);

  const refreshActiveTheme = useCallback(async (): Promise<void> => {
    const token = readStoredToken();
    if (!token) return;
    try {
      // D6: the ACTIVE CONVERSATION participates in resolution (override -
      // persona - global - preset), so refetch whenever either changes.
      setActiveTheme(await getActiveTheme(token, activePersonaId, activeConversationId));
    } catch (cause) {
      if (!isSessionLost(cause)) {
        // The canonical default keeps rendering; the list/studio surface
        // errors through their own load paths.
        setActiveTheme(null);
      }
    }
  }, [activePersonaId, activeConversationId]);

  /** Themes mutated inside the studio (create/update/delete/activate/import). */
  const handleThemesChanged = useCallback((): void => {
    void refreshThemes();
    void refreshActiveTheme();
  }, [refreshThemes, refreshActiveTheme]);

  /** A persona's theme binding changed (Personas view) — re-resolve what applies. */
  const handlePersonaThemeBound = useCallback((): void => {
    void refreshActiveTheme();
  }, [refreshActiveTheme]);

  /** D6: bind a theme to the active conversation (null clears to Auto). */
  const handleBindConversationTheme = async (
    conversationId: string | null,
    themeId: string | null,
  ): Promise<void> => {
    if (conversationId === null) return;
    const token = readStoredToken();
    if (!token) {
      handleSessionLost();
      return;
    }
    try {
      await bindConversationTheme(token, conversationId, themeId);
      await refreshActiveTheme();
    } catch (cause) {
      if (isSessionLost(cause)) {
        handleSessionLost();
        return;
      }
      setConversationsError(cause instanceof Error ? cause.message : 'Could not bind the theme.');
    }
  };

  useEffect(() => {
    if (!paired) {
      setPending([]);
      setPersonas(null);
      setPersonasError(null);
      setConversations(null);
      setConversationsError(null);
      setFolders(null);
      setFoldersError(null);
      setActivePersonaId(null);
      setActiveConversationId(null);
      setStreaming(false);
      setCreatingChat(false);
      setChatError(null);
      setThemes(null);
      setThemesError(null);
      setActiveTheme(null);
      setPreviewTokens(null);
      return;
    }
    void refreshPersonas();
    void refreshConversations();
    void refreshFolders();
    void refreshThemes();
    refreshQueue();
    const timer = window.setInterval(refreshQueue, QUEUE_POLL_MS);
    const onFocus = (): void => {
      refreshQueue();
      // Core may have started after the page; backfill lists that never
      // loaded so the persona picker/rail appear without a manual refresh.
      if (personas === null && personasError === null) void refreshPersonas();
      if (conversations === null && conversationsError === null) void refreshConversations();
      if (folders === null && foldersError === null) void refreshFolders();
    };
    window.addEventListener('focus', onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paired, refreshPersonas, refreshConversations, refreshFolders, refreshQueue]);

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

  // Resolve the applied theme for the current persona + conversation
  // (conversation binding -> persona binding -> global active -> preset).
  useEffect(() => {
    if (!paired) return;
    void refreshActiveTheme();
  }, [paired, activePersonaId, activeConversationId, refreshActiveTheme]);

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

  // -----------------------------------------------------------------------
  // M11 F11 folder ops (Projects/Folders). Every mutation refreshes both
  // the conversations list (folderId on summaries) and the folder list
  // (chatCounts) so the rail stays truthful.
  // -----------------------------------------------------------------------

  const railOpError = (fallback: string, cause: unknown): void => {
    if (isSessionLost(cause)) {
      handleSessionLost();
      return;
    }
    setConversationsError(cause instanceof Error ? cause.message : fallback);
  };

  const handleMoveConversation = async (
    id: string,
    folderId: string | null,
  ): Promise<void> => {
    const token = readStoredToken();
    if (!token) {
      handleSessionLost();
      return;
    }
    try {
      await updateConversation(token, id, { folderId });
      await Promise.all([refreshConversations(), refreshFolders()]);
    } catch (cause) {
      railOpError('Could not move the conversation.', cause);
    }
  };

  const handleCreateFolder = async (name: string, parentId: string | null): Promise<void> => {
    const token = readStoredToken();
    if (!token) {
      handleSessionLost();
      return;
    }
    try {
      await createFolder(token, { name, ...(parentId !== null ? { parentId } : {}) });
      await refreshFolders();
    } catch (cause) {
      railOpError('Could not create the folder.', cause);
    }
  };

  const handleRenameFolder = async (id: string, name: string): Promise<void> => {
    const token = readStoredToken();
    if (!token) {
      handleSessionLost();
      return;
    }
    try {
      await updateFolder(token, id, { name });
      await refreshFolders();
    } catch (cause) {
      railOpError('Could not rename the folder.', cause);
    }
  };

  const handleDeleteFolder = async (id: string): Promise<void> => {
    const token = readStoredToken();
    if (!token) {
      handleSessionLost();
      return;
    }
    try {
      await deleteFolder(token, id);
      await Promise.all([refreshConversations(), refreshFolders()]);
    } catch (cause) {
      railOpError('Could not delete the folder.', cause);
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

  /** M11 F6: Notes are one click/hotkey away — open the composer anywhere. */
  const requestCapture = useCallback((): void => {
    setView('notes');
    setNoteCaptureNonce((n) => n + 1);
  }, []);

  useEffect(() => {
    if (!paired) return;
    const onKey = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        const target = event.target as HTMLElement | null;
        const tag = target?.tagName?.toLowerCase();
        if (tag === 'input' || tag === 'textarea') return; // never hijack typing
        event.preventDefault();
        requestCapture();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [paired, requestCapture]);

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
                    onClick={() => setView('notes')}
                    aria-pressed={view === 'notes'}
                  >
                    Notes
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={requestCapture}
                    title="Quick note (Ctrl+K)"
                  >
                    ＋ Note
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
                  <button
                    type="button"
                    className="btn btn-secondary view-tab"
                    onClick={() => setView('memory')}
                    aria-pressed={view === 'memory'}
                  >
                    Memory
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary view-tab"
                    onClick={() => setView('themes')}
                    aria-pressed={view === 'themes'}
                  >
                    Themes
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary view-tab"
                    onClick={() => setView('skills')}
                    aria-pressed={view === 'skills'}
                  >
                    Skills
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary view-tab"
                    onClick={() => setView('playbooks')}
                    aria-pressed={view === 'playbooks'}
                  >
                    Playbooks
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary view-tab"
                    onClick={() => setView('audit')}
                    aria-pressed={view === 'audit'}
                  >
                    Audit
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
                  folders={folders}
                  loadError={conversationsError ?? foldersError}
                  disabled={railLocked}
                  creating={creatingChat}
                  activeConversationId={activeConversationId}
                  onNewChat={() => void handleNewChat()}
                  onOpen={handleOpenConversation}
                  onDelete={handleDeleteConversation}
                  onRetry={() => {
                    void refreshConversations();
                    void refreshFolders();
                  }}
                  onCreateFolder={(name, parentId) => void handleCreateFolder(name, parentId)}
                  onRenameFolder={(id, name) => void handleRenameFolder(id, name)}
                  onDeleteFolder={(id) => void handleDeleteFolder(id)}
                  onMoveConversation={(id, folderId) => void handleMoveConversation(id, folderId)}
                />
                <ChatStrip
                  onUnpair={handleSessionLost}
                  conversationId={activeConversationId}
                  personaId={activePersonaId}
                  personaName={activePersona?.name ?? null}
                  personaPaused={Boolean(activePersona?.paused)}
                  onStreamingChange={setStreaming}
                  onDone={handleDone}
                  themes={themes}
                  activeThemeId={activeTheme?.themeId ?? null}
                  onBindTheme={(themeId) => void handleBindConversationTheme(activeConversationId, themeId)}
                />
                <NotesMini
                  active={paired}
                  onCapture={requestCapture}
                  onOpen={() => setView('notes')}
                  onUnpair={handleSessionLost}
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
                themes={themes}
                loadError={personasError}
                themesError={themesError}
                onUnpair={handleSessionLost}
                onRefresh={() => void refreshPersonas()}
                onRefreshThemes={() => void refreshThemes()}
                onPersonaThemeBound={handlePersonaThemeBound}
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
            <div className={view === 'memory' ? 'app-view app-view-active' : 'app-view'}>
              <MemoryView
                personas={personas}
                onUnpair={handleSessionLost}
                active={view === 'memory'}
              />
            </div>
            <div className={view === 'themes' ? 'app-view app-view-active' : 'app-view'}>
              <ThemeStudio
                themes={themes}
                loadError={themesError}
                activeThemeId={activeTheme?.themeId ?? null}
                preview={previewTokens}
                onPreviewChange={setPreviewTokens}
                onUnpair={handleSessionLost}
                onRefresh={() => void refreshThemes()}
                onThemesChanged={handleThemesChanged}
                active={view === 'themes'}
              />
            </div>
            <div className={view === 'notes' ? 'app-view app-view-active' : 'app-view'}>
              <NotesView
                personas={personas}
                onUnpair={handleSessionLost}
                active={view === 'notes'}
                captureSignal={noteCaptureNonce}
              />
            </div>
            <div className={view === 'skills' ? 'app-view app-view-active' : 'app-view'}>
              <SkillsView
                personas={personas}
                onUnpair={handleSessionLost}
                active={view === 'skills'}
              />
            </div>
            <div className={view === 'playbooks' ? 'app-view app-view-active' : 'app-view'}>
              <PlaybooksView
                personas={personas}
                conversations={conversations}
                onUnpair={handleSessionLost}
                active={view === 'playbooks'}
              />
            </div>
            <div className={view === 'audit' ? 'app-view app-view-active' : 'app-view'}>
              <AuditView
                onUnpair={handleSessionLost}
                active={view === 'audit'}
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
