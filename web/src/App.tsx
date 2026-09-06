import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from 'react';
import type { ConversationSummary, Folder, Persona, ThemeMode } from '@partner/shared';
import type { ActiveTheme, ThemeProfile } from '@partner/shared';
import type { PendingToolCall } from '@partner/shared/src/tools.js';
import type { StreamDoneMeta } from './lib/api.js';
import type { ThemeTokenPair } from './lib/theme-helpers.js';
import ChatStrip from './ChatStrip.js';
import { AssetsLane } from './AssetsLane.js';
import { NotesMini } from './NotesMini.js';
import {
  IconAudit,
  IconChat,
  IconFiles,
  IconMemory,
  IconNotes,
  IconPanelLeft,
  IconPanelRight,
  IconPersonas,
  IconPlaybooks,
  IconProviders,
  IconSave,
  IconSkills,
  IconThemes,
} from './icons.js';
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
  /** M12.5: quick-capture happens in context (NotesMini lane ＋Capture or the
   * Notes page Quick capture) — no global nonce plumbing. */
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

  /** M12 (D2): notes-lane visibility. Default = open at wide widths; the
   * user's collapse choice is pinned per session (sessionStorage). */
  const NOTES_LANE_KEY = 'partner.notesLane';
const RAIL_OPEN_KEY = 'partner.railOpen';
const RAIL_W_KEY = 'partner.railWidth';
const NOTES_W_KEY = 'partner.notesWidth';
const ASSETS_LANE_KEY = 'partner.assetsLane';
const ASSETS_W_KEY = 'partner.assetsWidth';

const readSession = (key: string): string | null => {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
};
const writeSession = (key: string, value: string): void => {
  try {
    sessionStorage.setItem(key, value);
  } catch {
    /* private mode */
  }
};
const readIntSession = (key: string): number | null => {
  const raw = readSession(key);
  if (raw === null) return null;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? value : null;
};
const clampWidth = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, Math.round(value)));

interface ColumnDividerProps {
  label: string;
  /** Signed drag direction: +1 = dragging right widens the column. */
  direction: 1 | -1;
  current: number | null;
  fallback: number;
  min: number;
  max: number;
  onSet: (width: number) => void;
  onCommit: (width: number) => void;
}

/** M12.5: a vertical drag divider between two workspace columns. Pointer +
 * keyboard (arrows resize by a 16px step), token-styled, focusable. */
function ColumnDivider({
  label,
  direction,
  current,
  fallback,
  min,
  max,
  onSet,
  onCommit,
}: ColumnDividerProps) {
  const drag = useRef<{ pointerId: number; startX: number; base: number } | null>(null);
  const baseWidth = current ?? fallback;

  const widthFor = (clientX: number, startX: number, base: number): number =>
    clampWidth(base + direction * (clientX - startX), min, max);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { pointerId: event.pointerId, startX: event.clientX, base: baseWidth };
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const d = drag.current;
    if (d === null || event.pointerId !== d.pointerId) return;
    onSet(widthFor(event.clientX, d.startX, d.base));
  };
  const endDrag = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const d = drag.current;
    if (d === null || event.pointerId !== d.pointerId) return;
    onCommit(widthFor(event.clientX, d.startX, d.base));
    drag.current = null;
  };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      const step = event.key === 'ArrowRight' ? 16 : -16;
      const next = clampWidth(baseWidth + direction * step, min, max);
      onSet(next);
      onCommit(next);
    }
  };

  return (
    <div
      className="col-divider"
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      tabIndex={0}
      title={label}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={onKeyDown}
    />
  );
}

  const [notesLaneOverride, setNotesLaneOverride] = useState<string | null>(() => {
    try {
      return sessionStorage.getItem(NOTES_LANE_KEY);
    } catch {
      return null;
    }
  });
  const [notesLaneWide, setNotesLaneWide] = useState<boolean>(() =>
    typeof window !== 'undefined' && window.matchMedia('(min-width: 1280px)').matches,
  );

  useEffect(() => {
    const mq = window.matchMedia('(min-width: 1280px)');
    const onChange = (): void => setNotesLaneWide(mq.matches);
    onChange();
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  const notesLaneOpen = notesLaneOverride !== null ? notesLaneOverride === '1' : notesLaneWide;

  /** M14 assets pane. Open = explicit user choice, remembered per session
   *  (default CLOSED so the existing geometry gates stay untouched until the
   *  user asks for the pane). The two right-hand panes (Assets + Notes) are
   *  mutually exclusive below 1440px — stacking them at laptop widths would
   *  crush the transcript (composer falls to ~136px @1024); at >= 1440px
   *  both fit and may be open at once. */
  const [panelsFit, setPanelsFit] = useState<boolean>(
    () => typeof window !== 'undefined' && window.matchMedia('(min-width: 1440px)').matches,
  );
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 1440px)');
    const onChange = (): void => setPanelsFit(mq.matches);
    onChange();
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  const [assetsLaneOverride, setAssetsLaneOverride] = useState<string | null>(() =>
    readSession(ASSETS_LANE_KEY),
  );
  const assetsLaneOpen = assetsLaneOverride === '1';

  const setAssetsLaneOpen = useCallback((open: boolean): void => {
    setAssetsLaneOverride(open ? '1' : '0');
    writeSession(ASSETS_LANE_KEY, open ? '1' : '0');
  }, []);
  const toggleAssetsLane = useCallback((): void => {
    const next = !assetsLaneOpen;
    if (next && !panelsFit && notesLaneOpen) {
      setNotesLaneOverride('0');
      writeSession(NOTES_LANE_KEY, '0');
    }
    setAssetsLaneOpen(next);
  }, [assetsLaneOpen, notesLaneOpen, panelsFit, setAssetsLaneOpen]);

  const toggleNotesLane = useCallback((): void => {
    const next = !notesLaneOpen;
    if (next && !panelsFit && assetsLaneOpen) {
      setAssetsLaneOpen(false);
    }
    setNotesLaneOverride(next ? '1' : '0');
    writeSession(NOTES_LANE_KEY, next ? '1' : '0');
  }, [notesLaneOpen, panelsFit, assetsLaneOpen, setAssetsLaneOpen]);

  // Shrinking the window below the stack threshold with both panes open:
  // keep the pane the user just opened (Assets), release the Notes width.
  useEffect(() => {
    if (!panelsFit && assetsLaneOpen && notesLaneOpen) {
      setNotesLaneOverride('0');
      writeSession(NOTES_LANE_KEY, '0');
    }
  }, [panelsFit, assetsLaneOpen, notesLaneOpen]);

  /* M12.5: conversations rail visibility + resizable column widths. The
   * widths are per-session; defaults come from CSS (breakpoint-tuned), so a
   * null width means "follow the responsive default". */
  const [railOpen, setRailOpen] = useState<boolean>(() => readSession(RAIL_OPEN_KEY) === null ? true : readSession(RAIL_OPEN_KEY) === '1');
  const [railW, setRailW] = useState<number | null>(() => readIntSession(RAIL_W_KEY));
  const [notesW, setNotesW] = useState<number | null>(() => readIntSession(NOTES_W_KEY));
  const toggleRail = useCallback((): void => {
    setRailOpen((open) => {
      writeSession(RAIL_OPEN_KEY, open ? '0' : '1');
      return !open;
    });
  }, []);
  const commitRailW = useCallback((value: number): void => writeSession(RAIL_W_KEY, String(value)), []);
  const commitNotesW = useCallback((value: number): void => writeSession(NOTES_W_KEY, String(value)), []);
  const [assetsW, setAssetsW] = useState<number | null>(() => readIntSession(ASSETS_W_KEY));
  const commitAssetsW = useCallback(
    (value: number): void => writeSession(ASSETS_W_KEY, String(value)),
    [],
  );
  const workspaceStyle = {
    ...(railOpen && railW !== null ? { '--rail-w': `${railW}px` } : {}),
    ...(notesLaneOpen && notesW !== null ? { '--notes-w': `${notesW}px` } : {}),
    ...(assetsLaneOpen && assetsW !== null ? { '--assets-w': `${assetsW}px` } : {}),
  } as CSSProperties;
  const railDefaultW = typeof window !== 'undefined' && window.innerWidth <= 1024 ? 260 : 288;
  const notesDefaultW = 232;
  const assetsDefaultW = 300;

  /** M14: assets saved via the chat-bar flow while the pane is open — bump
   *  the lane's reload version so the new row appears without reopening. */
  const [assetsVersion, setAssetsVersion] = useState(0);
  const handleAssetsChanged = useCallback((): void => {
    setAssetsVersion((value) => value + 1);
  }, []);


  /** M12.5: the global “Quick note” capture action and its Ctrl+K shortcut
   * were removed — capture happens in context (the lane ＋Capture beside
   * the transcript, or the Notes page Quick capture). */

  return (
    <div className="app">
      <header className="app-header">
        <div className="app-header-inner">
          <div className="app-header-left">
            <span className="app-brand">Partner</span>
            {paired ? (
              <div className="view-scroll">
                <div className="view-switch" role="group" aria-label="Partner views">
                  <div className="view-group" role="group" aria-label="Workspace">
                    <button
                      type="button"
                      className="btn btn-secondary view-tab"
                      onClick={() => setView('chat')}
                      aria-pressed={view === 'chat'}
                    >
                      <IconChat />
                      Chat
                    </button>
                    <button
                      type="button"
                      className="btn btn-secondary view-tab"
                      onClick={() => setView('notes')}
                      aria-pressed={view === 'notes'}
                    >
                      <IconNotes />
                      Notes
                    </button>
                  </div>
                  <div className="view-group" role="group" aria-label="Studio">
                    <button
                      type="button"
                      className="btn btn-secondary view-tab"
                      onClick={() => setView('personas')}
                      aria-pressed={view === 'personas'}
                    >
                      <IconPersonas />
                      Personas
                    </button>
                    <button
                      type="button"
                      className="btn btn-secondary view-tab"
                      onClick={() => setView('providers')}
                      aria-pressed={view === 'providers'}
                    >
                      <IconProviders />
                      Providers
                    </button>
                    <button
                      type="button"
                      className="btn btn-secondary view-tab"
                      onClick={() => setView('themes')}
                      aria-pressed={view === 'themes'}
                    >
                      <IconThemes />
                      Themes
                    </button>
                  </div>
                  <div className="view-group" role="group" aria-label="Tools">
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
                      <IconFiles />
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
                      onClick={() => setView('skills')}
                      aria-pressed={view === 'skills'}
                    >
                      <IconSkills />
                      Skills
                    </button>
                    <button
                      type="button"
                      className="btn btn-secondary view-tab"
                      onClick={() => setView('playbooks')}
                      aria-pressed={view === 'playbooks'}
                    >
                      <IconPlaybooks />
                      Playbooks
                    </button>
                  </div>
                  <div className="view-group" role="group" aria-label="System">
                    <button
                      type="button"
                      className="btn btn-secondary view-tab"
                      onClick={() => setView('memory')}
                      aria-pressed={view === 'memory'}
                    >
                      <IconMemory />
                      Memory
                    </button>
                    <button
                      type="button"
                      className="btn btn-secondary view-tab"
                      onClick={() => setView('audit')}
                      aria-pressed={view === 'audit'}
                    >
                      <IconAudit />
                      Audit
                    </button>
                  </div>
                </div>
              </div>
            ) : null}
          </div>
          <div className="app-header-right">
            {paired && personasLoaded && personas.length > 0 ? (
              <PersonaPicker
                personas={personas}
                activePersonaId={activePersonaId}
                disabled={streaming}
                onSelect={setActivePersonaId}
              />
            ) : null}
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={toggleRail}
              aria-pressed={railOpen}
              aria-label={railOpen ? 'Hide conversations' : 'Show conversations'}
              title={railOpen ? 'Hide conversations' : 'Show conversations'}
            >
              <IconPanelLeft />
            </button>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={toggleNotesLane}
              aria-pressed={notesLaneOpen}
              aria-label={notesLaneOpen ? 'Hide notes panel' : 'Show notes panel'}
              title={notesLaneOpen ? 'Hide notes panel' : 'Show notes panel'}
            >
              <IconPanelRight />
            </button>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={toggleAssetsLane}
              aria-pressed={assetsLaneOpen}
              aria-label={assetsLaneOpen ? 'Hide assets panel' : 'Show assets panel'}
              title={assetsLaneOpen ? 'Hide assets panel' : 'Show assets panel'}
            >
              <IconSave />
            </button>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={handleToggleMode}
              aria-pressed={mode === 'dark'}
              aria-label={`Switch to ${nextModeLabel.toLowerCase()} theme`}
            >
              {nextModeLabel}
            </button>
          </div>
        </div>
      </header>
      <main className="app-main">
        {paired ? (
          <>
            <div className={view === 'chat' ? 'app-view app-view-active' : 'app-view'}>
            <div
              className={[
                notesLaneOpen ? 'chat-workspace notes-lane-open' : 'chat-workspace notes-lane-collapsed',
                railOpen ? '' : 'rail-hidden',
                assetsLaneOpen ? 'assets-pane-open' : '',
              ]
                .filter(Boolean)
                .join(' ')}
              style={workspaceStyle}
            >
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
                {railOpen ? (
                  <ColumnDivider
                    label="Resize conversations"
                    direction={1}
                    current={railW}
                    fallback={railDefaultW}
                    min={170}
                    max={520}
                    onSet={setRailW}
                    onCommit={commitRailW}
                  />
                ) : null}
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
                  pending={pending}
                  onRefreshPending={refreshQueue}
                  viewActive={view === 'chat'}
                  assetsOpen={assetsLaneOpen}
                  onToggleAssets={toggleAssetsLane}
                  onAssetsChanged={handleAssetsChanged}
                />
                {assetsLaneOpen ? (
                  <>
                    <ColumnDivider
                      label="Resize assets pane"
                      direction={-1}
                      current={assetsW}
                      fallback={assetsDefaultW}
                      min={220}
                      max={460}
                      onSet={setAssetsW}
                      onCommit={commitAssetsW}
                    />
                    <AssetsLane
                      conversationId={activeConversationId}
                      active={view === 'chat'}
                      version={assetsVersion}
                      onClose={() => setAssetsLaneOpen(false)}
                      onUnpair={handleSessionLost}
                    />
                  </>
                ) : null}
                {notesLaneOpen ? (
                  <ColumnDivider
                    label="Resize notes lane"
                    direction={-1}
                    current={notesW}
                    fallback={notesDefaultW}
                    min={170}
                    max={460}
                    onSet={setNotesW}
                    onCommit={commitNotesW}
                  />
                ) : null}
                <NotesMini
                  active={paired}
                  open={notesLaneOpen}
                  collapsed={!notesLaneOpen}
                  onToggleCollapsed={toggleNotesLane}
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
