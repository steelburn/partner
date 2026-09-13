import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from 'react';
import type {
  BrainstormSessionSummary,
  ConversationSummary,
  Folder,
  Persona,
  ThemeMode,
} from '@partner/shared';
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
  IconClose,
  IconFiles,
  IconMemory,
  IconMore,
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
import {
  aggregateAttention,
  attentionCounts,
  attentionLabel,
  failedRunsNeedingAttention,
  formatBadge,
  isAttentionView,
  type AttentionCounts,
} from './lib/attention.js';
import { listProfile } from './lib/memory.js';
import { listScheduleRuns } from './lib/schedules.js';
import { revokeSession } from './lib/api.js';
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
import {
  MOBILE_MORE,
  MOBILE_TABS,
  NAV_GROUPS,
  NAV_LABELS,
  type ViewName,
} from './lib/nav.js';
import { createConversation, deleteConversation, listConversations } from './lib/conversations.js';
import { conversationOpenAction } from './lib/conversation-open.js';
import {
  createFolder,
  deleteFolder,
  listFolders,
  updateConversation,
  updateFolder,
} from './lib/folders.js';
import { isSessionLost, listPersonas } from './lib/personas.js';
import { fetchBrainstormSession } from './lib/notes.js';
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
/** M20.A: approvals are time-critical (a turn is blocked on the decision), so
the queue keeps its fast poll. Memory suggestions and failed runs only change
when work completes, and each poll is a round trip — slower is correct. */
const QUEUE_POLL_MS = 4000;
const ATTENTION_POLL_MS = 15000;

/**
 * Views, labels and tier membership live in `lib/nav.ts` so the desktop
 * sidebar and the phone tabs/More sheet can never drift apart —
 * `nav.test.ts` asserts that the phone surface reaches every view exactly
 * once. */
interface NavItem {
  view: ViewName;
  label: string;
  icon: JSX.Element;
  /** Badge text shown next to the label (e.g. pending approvals). */
  badge?: string;
}

/** The one place the nav model meets the icon set. */
function iconFor(view: ViewName): JSX.Element {
  switch (view) {
    case 'chat':
      return <IconChat />;
    case 'notes':
      return <IconNotes />;
    case 'personas':
      return <IconPersonas />;
    case 'providers':
      return <IconProviders />;
    case 'themes':
      return <IconThemes />;
    case 'files':
      return <IconFiles />;
    case 'skills':
      return <IconSkills />;
    case 'playbooks':
      return <IconPlaybooks />;
    case 'memory':
      return <IconMemory />;
    case 'audit':
      return <IconAudit />;
  }
}

/** Badge for a nav destination, from the shared attention model
 *  (`lib/attention.ts`) so every surface defines "waiting on you" once. */
function badgeFor(view: ViewName, attention: AttentionCounts): string | undefined {
  return isAttentionView(view) ? formatBadge(attention[view]) : undefined;
}

function NavButton({
  item,
  current,
  onSelect,
}: {
  item: NavItem;
  current: ViewName;
  onSelect: (view: ViewName) => void;
}) {
  return (
    <button
      type="button"
      className="btn btn-secondary side-tab"
      onClick={() => onSelect(item.view)}
      aria-pressed={current === item.view}
      aria-label={attentionLabel(item.label, item.badge)}
    >
      {item.icon}
      <span className="side-label">{item.label}</span>
      {item.badge !== undefined && item.badge !== '' ? (
        <span className="tab-badge" aria-hidden="true">
          {item.badge}
        </span>
      ) : null}
    </button>
  );
}

function SideNav({
  current,
  attention,
  onSelect,
}: {
  current: ViewName;
  attention: AttentionCounts;
  onSelect: (view: ViewName) => void;
}) {
  return (
    <nav className="side-nav" aria-label="Partner views">
      {NAV_GROUPS.map((group) => (
        <div className="side-group" role="group" aria-label={group.name} key={group.name}>
          <span className="side-group-title">{group.name}</span>
          {group.views.map((view) => {
            const label = NAV_LABELS[view];
            return (
              <NavButton
                key={view}
                item={{ view, label, icon: iconFor(view), badge: badgeFor(view, attention) }}
                current={current}
                onSelect={onSelect}
              />
            );
          })}
        </div>
      ))}
    </nav>
  );
}

/**
 * M20.A phone navigation — a bottom tab bar (primary destinations, inside
 * thumb reach) plus a "More" sheet for everything else.
 *
 * This is the whole reason a phone layout works: the conversation/notes/assets
 * rails become overlays, so the tab bar and the compact top bar are the only
 * permanent chrome. That is what hands the transcript and composer the full
 * viewport width instead of the 58px they got when the rails were columns.
 *
 * Rendered at every tier but hidden by CSS above the phone breakpoint, so
 * there is exactly one nav definition per form factor and no JS breakpoints
 * (JS media queries would also mismatch SSR/initial paint).
 */
function MobileNav({
  current,
  attention,
  onSelect,
}: {
  current: ViewName;
  attention: AttentionCounts;
  onSelect: (view: ViewName) => void;
}) {
  const [moreOpen, setMoreOpen] = useState(false);

  /**
   * The More tab carries the aggregate of everything the sheet hides.
   * A badge on an item inside a closed sheet is invisible, so without this the
   * one notification that says "open the sheet" is the one the user cannot
   * see — which is exactly how a memory suggestion went unnoticed.
   *
   * Visible tabs are deliberately excluded: their own badge is already on the
   * tab bar, and showing the same count twice reads as two separate problems.
   */
  const moreBadge = formatBadge(aggregateAttention(attention, MOBILE_MORE));

  /** Escape closes the sheet; the explicit Close button is the pointer path
   *  and the scrim is decorative (aria-hidden), so this is the keyboard path. */
  useEffect(() => {
    if (!moreOpen) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setMoreOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [moreOpen]);

  const select = (view: ViewName): void => {
    setMoreOpen(false);
    onSelect(view);
  };

  return (
    <>
      {moreOpen ? (
        <div className="more-scrim" aria-hidden="true" onClick={() => setMoreOpen(false)} />
      ) : null}
      <nav className="mobile-nav" aria-label="Partner views">
        {moreOpen ? (
          <div className="more-sheet" role="group" aria-label="More views">
            <div className="more-sheet-head">
              <span className="more-sheet-title">More</span>
              <button
                type="button"
                className="btn btn-secondary btn-sm more-sheet-close"
                onClick={() => setMoreOpen(false)}
                aria-label="Close more views"
              >
                <IconClose />
              </button>
            </div>
            <div className="more-sheet-grid">
              {MOBILE_MORE.map((view) => {
                const label = NAV_LABELS[view];
                const badge = badgeFor(view, attention);
                return (
                  <button
                    key={view}
                    type="button"
                    className="btn btn-secondary more-item"
                    onClick={() => select(view)}
                    aria-pressed={current === view}
                    aria-label={attentionLabel(label, badge)}
                  >
                    {iconFor(view)}
                    <span className="more-item-label">{label}</span>
                    {badge === undefined ? null : (
                      <span className="tab-badge" aria-hidden="true">
                        {badge}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        ) : null}
        <div className="mobile-tabs">
          {MOBILE_TABS.map((view) => {
            const label = NAV_LABELS[view];
            const badge = badgeFor(view, attention);
            return (
              <button
                key={view}
                type="button"
                className="btn mobile-tab"
                onClick={() => select(view)}
                aria-pressed={current === view}
                aria-label={attentionLabel(label, badge)}
              >
                <span className="mobile-tab-face">
                  {iconFor(view)}
                  {badge === undefined ? null : (
                    <span className="tab-badge" aria-hidden="true">
                      {badge}
                    </span>
                  )}
                </span>
                <span className="mobile-tab-label">{label}</span>
              </button>
            );
          })}
          <button
            type="button"
            className="btn mobile-tab"
            onClick={() => setMoreOpen((open) => !open)}
            aria-pressed={moreOpen}
            aria-expanded={moreOpen}
            aria-label={
              moreBadge === undefined
                ? 'More views'
                : `More views — ${moreBadge} waiting`
            }
          >
            <span className="mobile-tab-face">
              <IconMore />
              {moreBadge === undefined ? null : (
                <span className="tab-badge" aria-hidden="true">
                  {moreBadge}
                </span>
              )}
            </span>
            <span className="mobile-tab-label">More</span>
          </button>
        </div>
      </nav>
    </>
  );
}

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
  // M16 F4: an asset Discuss quote waiting for its target conversation's
  // composer (the ChatStrip consumes it when the conversation matches).
  const [externalDraft, setExternalDraft] = useState<{
    conversationId: string | null;
    text: string;
    nonce: number;
  } | null>(null);
  // M16 follow-up: the active conversation's linked brainstorm session (null
  // when the chat is not a brainstorm) — drives the header Conclude/Reopen.
  const [brainstormSession, setBrainstormSession] = useState<BrainstormSessionSummary | null>(null);
  // M16 wiki-links: a `[[Note Title]]` chip in chat asks the Notes view to
  // open a note. Nonce forces a repeat click on the same id to re-focus.
  const [noteFocus, setNoteFocus] = useState<{ id: string; nonce: number } | null>(null);
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

  /**
   * M20.A attention counts: memory suggestions and recent failed runs — the
   * two "waiting on you" sources that had no badge. Approvals already arrive
   * through `pending` above.
   *
   * Only COUNTS live in shell state. The memory entries themselves are never
   * copied here, so an unconfirmed personal fact does not sit in browser memory
   * (or a devtools snapshot) merely to render a number — the Memory view owns
   * that data and fetches it when opened.
   *
   * A failed poll keeps the last known count rather than clearing the badge:
   * a transient error must not silently hide something that needs the user.
   */
  const [memorySuggestions, setMemorySuggestions] = useState<number>(0);
  const [failedRuns, setFailedRuns] = useState<number>(0);

  const refreshAttention = useCallback((): void => {
    const token = readStoredToken();
    if (!token) {
      setMemorySuggestions(0);
      setFailedRuns(0);
      return;
    }
    void listProfile(token)
      .then((entries) =>
        setMemorySuggestions(entries.filter((entry) => entry.status === 'suggested').length),
      )
      .catch(() => undefined);
    void listScheduleRuns(token, { limit: 50 })
      .then((runs) => setFailedRuns(failedRunsNeedingAttention(runs, Date.now())))
      .catch(() => undefined);
  }, []);

  const attention = attentionCounts({
    pendingApprovals: pending.length,
    memorySuggestions,
    failedScheduleRuns: failedRuns,
  });

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

  /** M16 follow-up: resolve the active conversation's linked brainstorm. */
  const refreshBrainstormSession = useCallback(async (): Promise<void> => {
    if (activeConversationId === null) {
      setBrainstormSession(null);
      return;
    }
    const token = readStoredToken();
    if (!token) return;
    try {
      setBrainstormSession(await fetchBrainstormSession(token, activeConversationId));
    } catch (cause) {
      if (isSessionLost(cause)) {
        handleSessionLost();
        return;
      }
      // Non-fatal: the chat simply shows no brainstorm action.
      setBrainstormSession(null);
    }
  }, [activeConversationId, handleSessionLost]);

  useEffect(() => {
    void refreshBrainstormSession();
  }, [refreshBrainstormSession]);

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
    refreshAttention();
    const timer = window.setInterval(refreshQueue, QUEUE_POLL_MS);
    // Attention changes only when work completes, and every poll is a round
    // trip, so it rides a slower clock than a blocked turn's approval.
    const attentionTimer = window.setInterval(refreshAttention, ATTENTION_POLL_MS);
    const onFocus = (): void => {
      refreshQueue();
      refreshAttention();
      // Core may have started after the page; backfill lists that never
      // loaded so the persona picker/rail appear without a manual refresh.
      if (personas === null && personasError === null) void refreshPersonas();
      if (conversations === null && conversationsError === null) void refreshConversations();
      if (folders === null && foldersError === null) void refreshFolders();
    };
    window.addEventListener('focus', onFocus);
    return () => {
      window.clearInterval(timer);
      window.clearInterval(attentionTimer);
      window.removeEventListener('focus', onFocus);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paired, refreshPersonas, refreshConversations, refreshFolders, refreshQueue, refreshAttention]);

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
    const action = conversationOpenAction(id, activeConversationId, streaming);
    if (action === 'ignore') return;
    if (action === 'adopt') {
      // Continuity: opening a persona-bound conversation adopts that persona.
      const target = conversations?.find((c) => c.id === id);
      if (target?.personaId && personas?.some((p) => p.id === target.personaId)) {
        setActivePersonaId(target.personaId);
      }
      setActiveConversationId(id);
    }
    setChatError(null);
    setView('chat');
  };

  /** M16 F4: open a conversation with a composer draft (asset Discuss). */
  const openWithDraft = (conversationId: string, text: string): void => {
    setExternalDraft({ conversationId, text, nonce: Date.now() });
    handleOpenConversation(conversationId);
  };

  /** M16 wiki-links: follow a chat `[[Note Title]]` chip into the note. */
  const openNoteFromChat = (id: string): void => {
    setNoteFocus({ id, nonce: Date.now() });
    setView('notes');
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
    // M19 automatic remember runs OUT OF BAND, after the client's response has
    // ended, so a suggestion can land just after this handler fires. Check now
    // and once more shortly after rather than waiting for the 15s attention
    // poll — otherwise a suggestion appears to be missing for a quarter minute.
    refreshAttention();
    window.setTimeout(refreshAttention, 3000);
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
    if (!open) setAssetsExpanded(false);
  }, []);
  const toggleAssetsLane = useCallback((): void => {
    const next = !assetsLaneOpen;
    if (next && !panelsFit && notesLaneOpen) {
      setNotesLaneOverride('0');
      writeSession(NOTES_LANE_KEY, '0');
    }
    setAssetsLaneOpen(next);
  }, [assetsLaneOpen, notesLaneOpen, panelsFit, setAssetsLaneOpen]);

  // Focus mode applies to one conversation's reading: switching chats
  // returns the workspace to side-by-side (the read asset is remembered per
  // conversation inside the lane and restored on its own).
  useEffect(() => {
    setAssetsExpanded(false);
  }, [activeConversationId]);

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
  const [railOpen, setRailOpen] = useState<boolean>(() => {
    const stored = readSession(RAIL_OPEN_KEY);
    if (stored !== null) return stored === '1';
    // M20.A: on a phone the rail is an overlay over the transcript, so an open
    // rail on first paint would hide the very content the user opened. Default
    // closed there; the desktop default stays open. Mirrors the ≤640 CSS tier.
    return !(typeof window !== 'undefined' && window.matchMedia('(max-width: 640px)').matches);
  });
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

  /**
   * M20.A phone tier (mirrors the ≤640 CSS breakpoint). Layout stays in CSS;
   * this only drives *state* defaults, because on a phone the rails are
   * overlays and an overlay left open covers the view — a behaviour CSS cannot
   * correct on its own.
   */
  const [phoneTier, setPhoneTier] = useState<boolean>(
    () => typeof window !== 'undefined' && window.matchMedia('(max-width: 640px)').matches,
  );
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 640px)');
    const onChange = (): void => setPhoneTier(mq.matches);
    onChange();
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  /** Entering the phone tier turns the rails into overlays; close them so a
   *  rotation to portrait cannot leave a sheet covering the transcript.
   *  Runs on mount too, which matches the closed default above. */
  useEffect(() => {
    if (!phoneTier) return;
    setRailOpen(false);
    setNotesLaneOverride('0');
    setAssetsLaneOpen(false);
  }, [phoneTier, setAssetsLaneOpen]);
  const commitAssetsW = useCallback(
    (value: number): void => writeSession(ASSETS_W_KEY, String(value)),
    [],
  );
  /** M14.1: focus mode — the pane grows to take over the whole chat
   *  workspace so wide documents get a real reading measure. Transient (not
   *  session-pinned): collapses on pane close or conversation switch. */
  const [assetsExpanded, setAssetsExpanded] = useState<boolean>(false);
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
      <aside className="app-side" aria-label="App">
        <span className="app-brand side-brand">Partner</span>
        {paired ? (
          <SideNav current={view} attention={attention} onSelect={setView} />
        ) : null}
      </aside>
      <div className="app-col">
        {paired ? (
          <header className="app-topbar">
            <div className="app-topbar-right">
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
            {/*
             * Chrome lives in ONE place: the shell's top bar ("a slim top bar
             * (persona picker + lane/theme controls)" — M14). Both of these
             * used to sit in a row above the composer as well, so the asset
             * lane and the conversation theme each had two homes; measured
             * @390×844 they were 579px apart on screen at once. The assets
             * toggle stays gated on there being a conversation, because the
             * pane is conversation-scoped (`listAssets(token, conversationId)`) —
             * ungated it took the chat input from 682px to 366px on desktop to
             * render a one-line placeholder.
             */}
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={toggleAssetsLane}
              disabled={activeConversationId === null}
              aria-pressed={assetsLaneOpen}
              aria-label={assetsLaneOpen ? 'Hide assets panel' : 'Show assets panel'}
              title={assetsLaneOpen ? 'Hide assets panel' : 'Show assets panel'}
            >
              <IconSave />
            </button>
            {activeConversationId !== null && themes !== null && themes.length > 0 ? (
              <select
                className="field topbar-theme-select"
                value={activeTheme?.themeId ?? ''}
                onChange={(event) =>
                  void handleBindConversationTheme(
                    activeConversationId,
                    event.target.value === '' ? null : event.target.value,
                  )
                }
                aria-label="Theme for this conversation"
                title="Theme for this conversation"
              >
                <option value="">Auto theme</option>
                {themes.map((theme) => (
                  <option key={theme.id} value={theme.id}>
                    {theme.name}
                  </option>
                ))}
              </select>
            ) : null}
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
          </header>
        ) : null}
      <main className="app-main">
        {paired ? (
          <>
            <div className={view === 'chat' ? 'app-view app-view-active' : 'app-view'}>
            <div
              className={[
                notesLaneOpen ? 'chat-workspace notes-lane-open' : 'chat-workspace notes-lane-collapsed',
                railOpen ? '' : 'rail-hidden',
                assetsLaneOpen ? 'assets-pane-open' : '',
                assetsExpanded ? 'assets-expanded' : '',
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
                  pending={pending}
                  onRefreshPending={refreshQueue}
                  viewActive={view === 'chat'}
                  onAssetsChanged={handleAssetsChanged}
                  externalDraft={externalDraft}
                  onDraftConsumed={() => setExternalDraft(null)}
                  brainstormSession={brainstormSession}
                  onBrainstormSessionChange={setBrainstormSession}
                  onOpenNote={openNoteFromChat}
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
                      expanded={assetsExpanded}
                      onExpandedChange={setAssetsExpanded}
                      onClose={() => {
                        setAssetsLaneOpen(false);
                        setAssetsExpanded(false);
                      }}
                      onUnpair={handleSessionLost}
                      onDiscuss={openWithDraft}
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
                onOpenConversation={handleOpenConversation}
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
                onAttentionChanged={refreshAttention}
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
                focusNote={noteFocus}
                onOpenConversation={handleOpenConversation}
                folders={folders}
                onCreateFolder={(name, parentId) => void handleCreateFolder(name, parentId)}
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
      {paired ? (
        <MobileNav
          current={view}
          attention={attention}
          onSelect={(next) => {
            // M20.A: the phone nav is the only visible one at that tier, and
            // every phone rail is an overlay — switching destination must not
            // leave one hanging over the newly selected view.
            setRailOpen(false);
            setNotesLaneOverride('0');
            setAssetsLaneOpen(false);
            setView(next);
          }}
        />
      ) : null}
    </div>
  );
}

