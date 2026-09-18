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
  IconChevronLeft,
  IconChevronRight,
  IconClose,
  IconFiles,
  IconMembers,
  IconMemory,
  IconMore,
  IconNotes,
  IconPanelLeft,
  IconPanelRight,
  IconPersonas,
  IconPlaybooks,
  IconProviders,
  IconSave,
  IconShared,
  IconSignOut,
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
  readyDraftsNeedingAttention,
  type AttentionCounts,
} from './lib/attention.js';
import { listProfile } from './lib/memory.js';
import { listDrafts } from './lib/skills.js';
import { listScheduleRuns } from './lib/schedules.js';
import { revokeSession } from './lib/api.js';
import { signOut as requestSignOut } from './lib/account.js';
import AuditView from './AuditView.js';
import ConversationRail from './ConversationRail.js';
import FilesView from './FilesView.js';
import MembersView from './MembersView.js';
import MemoryView from './MemoryView.js';
import NotesView from './NotesView.js';
import PairGate from './PairGate.js';
import PersonaManagerView from './PersonaManagerView.js';
import PersonaPicker from './PersonaPicker.js';
import PlaybooksView from './PlaybooksView.js';
import ProvidersView from './ProvidersView.js';
import SharedView from './SharedView.js';
import SkillsView from './SkillsView.js';
import ThemeStudio from './ThemeStudio.js';
import {
  MOBILE_MORE,
  MOBILE_TABS,
  NAV_GROUPS,
  NAV_LABELS,
  SIDE_RAIL_MAX_WIDTH,
  type ViewName,
} from './lib/nav.js';
import {
  LANE_OVERLAY_MAX_WIDTH,
  PANEL_EXIT_MS,
  PHONE_MAX_WIDTH,
  dismissTarget,
  floatsOverTranscript,
  type OverlayPanel,
} from './lib/panels.js';
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
    case 'shared':
      return <IconShared />;
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
    case 'members':
      return <IconMembers />;
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
  minimized,
  onSelect,
}: {
  item: NavItem;
  current: ViewName;
  /** Icon-only rail: the label is no longer on screen, so it becomes the
   *  button's tooltip (the `aria-label` below is the name for every tier). */
  minimized: boolean;
  onSelect: (view: ViewName) => void;
}) {
  return (
    <button
      type="button"
      className="btn btn-secondary side-tab"
      onClick={() => onSelect(item.view)}
      aria-pressed={current === item.view}
      aria-label={attentionLabel(item.label, item.badge)}
      title={minimized ? item.label : undefined}
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
  minimized,
  onSelect,
}: {
  current: ViewName;
  attention: AttentionCounts;
  minimized: boolean;
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
                minimized={minimized}
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
  // M26 D (PLAN-M26.md L1): the Skills view's Build segment can be opened on
  // ONE draft — the deep link a chat approval card's "Review in Studio" uses,
  // in the same shape as `noteFocus`. The nonce makes a repeat request for the
  // same draft re-fire; SkillsView reports back so this state can be cleared
  // (a stale intent would keep overriding the rail's own selection).
  const [studioFocus, setStudioFocus] = useState<{ draftId: string; nonce: number } | null>(null);
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

  const handleSignOut = useCallback((): void => {
    // M29: the core's sign-out route revokes the session AND closes the user's
    // partition (on a login core). Best-effort — an offline core must not leave
    // the user stuck signed in, so local state clears regardless.
    const token = readStoredToken();
    if (token) void requestSignOut(token).catch(() => undefined);
    clearStoredToken();
    setPaired(false);
  }, []);

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
  /**
   * M26 D13: authored drafts that validate ok and are not installed — the
   * Skills badge. Only a COUNT lives here, like every other attention source;
   * the draft content stays in the Studio that owns it.
   */
  const [readyDrafts, setReadyDrafts] = useState<number>(0);

  const refreshAttention = useCallback((): void => {
    const token = readStoredToken();
    if (!token) {
      setMemorySuggestions(0);
      setFailedRuns(0);
      setReadyDrafts(0);
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
    // The SAME rule the Build segment badges with (`readyDraftsNeedingAttention`),
    // including the no-double-count rule for a draft whose install is already an
    // open approval (that one is counted under Files).
    void listDrafts(token)
      .then((drafts) => setReadyDrafts(readyDraftsNeedingAttention(drafts)))
      .catch(() => undefined);
  }, []);

  const attention = attentionCounts({
    pendingApprovals: pending.length,
    memorySuggestions,
    failedScheduleRuns: failedRuns,
    readyDrafts,
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

  /**
   * M26 D (PLAN-M26.md L1): open the Skills view's Build segment on ONE draft —
   * the shape of the existing Notes deep link, and the ONE mechanism two
   * producers share: a chat approval card's "Review in Studio", and the
   * Installed list's Edit/Fork (which is how a skill's permissions are ever
   * changed, since the core refuses an edit of an already-installed draft).
   */
  const openSkillDraftInStudio = useCallback((draftId: string): void => {
    setStudioFocus({ draftId, nonce: Date.now() });
    setView('skills');
  }, []);

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
/** M20.A follow-up 10 — the sidebar's icon-rail state, per session like the
 *  rail/lane widths (a shell preference, not user data: nothing to sync). */
const SIDE_MIN_KEY = 'partner.sideMinimized';

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

/** A tier boundary as a media query, so the width itself lives in
 *  `lib/panels.ts` (which `panels.test.ts` checks against app.css). */
const maxWidthQuery = (px: number): string => `(max-width: ${px}px)`;

/** `prefers-reduced-motion`, live: app.css disables the pane exit animation
 *  under this query, so JS must not wait for a slide-out that never runs. */
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState<boolean>(
    () =>
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  );
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = (): void => setReduced(mq.matches);
    onChange();
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return reduced;
}

/** Workspace class that runs a floating pane's exit animation (app.css). Keyed
 *  by pane so the class list in the DOM stays readable. */
const PANEL_EXIT_CLASS: Record<OverlayPanel, string> = {
  rail: 'rail-exiting',
  notes: 'notes-lane-exiting',
  assets: 'assets-pane-exiting',
};

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
  /**
   * M20.A follow-up — panes that float over the transcript.
   *
   * On a touch tier the conversation rail joins the two right-hand lanes as an
   * overlay, so a tap on the transcript puts the pane away. The exit is a real
   * slide-out to the pane's own edge (app.css), so leaving a pane looks like
   * arriving in one instead of a pop.
   *
   * The panes are mutually exclusive while they float: at ≤640 two of them
   * overlap (measured @390×844 the rail is 320px of 390 and a lane floats at
   * 272px), so opening one dismisses the others and `dismissTarget` always has a
   * single pane to put away. The tiers are `matchMedia` state defaults, never
   * layout (app.css owns geometry); `lib/panels.ts` owns the decision, and
   * `panels.test.ts` re-reads both files so the numbers cannot drift apart.
   */
  const reduceMotion = usePrefersReducedMotion();
  const [exiting, setExiting] = useState<OverlayPanel | null>(null);
  const exitTimer = useRef<number | null>(null);
  const [phoneTier, setPhoneTier] = useState<boolean>(
    () =>
      typeof window !== 'undefined' &&
      window.matchMedia(maxWidthQuery(PHONE_MAX_WIDTH)).matches,
  );
  const [laneOverlayTier, setLaneOverlayTier] = useState<boolean>(
    () =>
      typeof window !== 'undefined' &&
      window.matchMedia(maxWidthQuery(LANE_OVERLAY_MAX_WIDTH)).matches,
  );
  /** Both tier booleans follow the same two queries app.css uses, so a
   *  rotation or a resize lands on the same numbers as the paint. */
  useEffect(() => {
    const phone = window.matchMedia(maxWidthQuery(PHONE_MAX_WIDTH));
    const lanes = window.matchMedia(maxWidthQuery(LANE_OVERLAY_MAX_WIDTH));
    const sidebar = window.matchMedia(maxWidthQuery(SIDE_RAIL_MAX_WIDTH));
    const sync = (): void => {
      setPhoneTier(phone.matches);
      setLaneOverlayTier(lanes.matches);
      setSideRailTier(sidebar.matches);
    };
    sync();
    phone.addEventListener('change', sync);
    lanes.addEventListener('change', sync);
    sidebar.addEventListener('change', sync);
    return () => {
      phone.removeEventListener('change', sync);
      lanes.removeEventListener('change', sync);
      sidebar.removeEventListener('change', sync);
    };
  }, []);
  useEffect(
    () => () => {
      if (exitTimer.current !== null) window.clearTimeout(exitTimer.current);
    },
    [],
  );

  const closeRail = useCallback((): void => {
    setRailOpen(false);
    writeSession(RAIL_OPEN_KEY, '0');
  }, []);
  const closeNotesLane = useCallback((): void => {
    setNotesLaneOverride('0');
    writeSession(NOTES_LANE_KEY, '0');
  }, []);
  const closeAssetsLane = useCallback((): void => setAssetsLaneOpen(false), [setAssetsLaneOpen]);

  /**
   * Put a pane away. A floating pane slides out first and its state closes
   * `PANEL_EXIT_MS` later, so the exit finishes before the element leaves the
   * tree; a pane that owns a column (desktop/tablet) and a reduced-motion
   * preference close at once, because nothing is going to move.
   */
  const dismissPane = useCallback(
    (panel: OverlayPanel): void => {
      const closeOf = (target: OverlayPanel): void => {
        if (target === 'rail') closeRail();
        else if (target === 'notes') closeNotesLane();
        else closeAssetsLane();
      };
      if (
        reduceMotion ||
        !floatsOverTranscript(panel, { rail: phoneTier, lanes: laneOverlayTier })
      ) {
        closeOf(panel);
        return;
      }
      // A second dismissal inside the exit window supersedes the first: the
      // pane already leaving is closed at once rather than left open forever
      // (its timer is about to be replaced).
      if (exitTimer.current !== null) {
        window.clearTimeout(exitTimer.current);
        exitTimer.current = null;
        if (exiting !== null && exiting !== panel) closeOf(exiting);
      }
      setExiting(panel);
      exitTimer.current = window.setTimeout(() => {
        exitTimer.current = null;
        setExiting(null);
        closeOf(panel);
      }, PANEL_EXIT_MS);
    },
    [closeAssetsLane, closeNotesLane, closeRail, exiting, laneOverlayTier, phoneTier, reduceMotion],
  );

  /** Entering the phone tier turns the rail into an overlay too; close every
   *  pane so a rotation to portrait cannot leave a sheet over the transcript.
   *  Runs on mount too, which matches the phone default (rail closed). */
  useEffect(() => {
    if (!phoneTier) return;
    closeRail();
    closeNotesLane();
    setAssetsLaneOpen(false);
  }, [phoneTier, closeRail, closeNotesLane, setAssetsLaneOpen]);

  // Focus mode applies to one conversation's reading: switching chats
  // returns the workspace to side-by-side (the read asset is remembered per
  // conversation inside the lane and restored on its own).
  useEffect(() => {
    setAssetsExpanded(false);
  }, [activeConversationId]);

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
    // closed there; the desktop default stays open. The width comes from
    // lib/panels.ts, so this default and the CSS tier are the same number.
    return !(
      typeof window !== 'undefined' && window.matchMedia(maxWidthQuery(PHONE_MAX_WIDTH)).matches
    );
  });

  /* M20.A follow-up 10: the sidebar minimize toggle. Above the tablet boundary
   * the sidebar carries labels; at or below it there is no room for them, so the
   * DEFAULT is the icon rail (M12) — and the toggle overrides that default in
   * both directions, which is what makes it useful at every tier (an iPad in
   * landscape reports >1150 CSS px and gets the labelled sidebar).
   * `SIDE_RAIL_MAX_WIDTH` is mirrored by `--side-w` in app.css, and
   * `sidebar-collapse.test.ts` re-reads the stylesheet so they cannot drift. */
  const [sideMin, setSideMin] = useState<boolean>(() => {
    const stored = readSession(SIDE_MIN_KEY);
    if (stored !== null) return stored === '1';
    return (
      typeof window !== 'undefined' &&
      window.matchMedia(maxWidthQuery(SIDE_RAIL_MAX_WIDTH)).matches
    );
  });
  const [sideRailTier, setSideRailTier] = useState<boolean>(
    () =>
      typeof window !== 'undefined' &&
      window.matchMedia(maxWidthQuery(SIDE_RAIL_MAX_WIDTH)).matches,
  );

  /** Crossing INTO the tablet tier collapses the sidebar, because that is the
   *  width at which M12's rule applies (no menu may clip a smaller viewport).
   *  The user may expand it again at that width — a breakpoint is a default,
   *  the toggle is a choice — so this fires on the crossing only. */
  useEffect(() => {
    if (!sideRailTier) return;
    setSideMin(true);
    writeSession(SIDE_MIN_KEY, '1');
  }, [sideRailTier]);

  const toggleSideMin = useCallback((): void => {
    setSideMin((minimized) => {
      writeSession(SIDE_MIN_KEY, minimized ? '0' : '1');
      return !minimized;
    });
  }, []);
  const [railW, setRailW] = useState<number | null>(() => readIntSession(RAIL_W_KEY));
  const [notesW, setNotesW] = useState<number | null>(() => readIntSession(NOTES_W_KEY));
  const toggleRail = useCallback((): void => {
    if (railOpen) {
      dismissPane('rail');
      return;
    }
    // Two floating panes overlap on a phone, so opening one puts the others
    // away. Below the phone tier the rail is a column and keeps its width —
    // only the two right-hand lanes swap there.
    if (laneOverlayTier) {
      if (notesLaneOpen) closeNotesLane();
      if (assetsLaneOpen) setAssetsLaneOpen(false);
    }
    setRailOpen(true);
    writeSession(RAIL_OPEN_KEY, '1');
  }, [
    railOpen,
    laneOverlayTier,
    notesLaneOpen,
    assetsLaneOpen,
    closeNotesLane,
    setAssetsLaneOpen,
    dismissPane,
  ]);
  const commitRailW = useCallback((value: number): void => writeSession(RAIL_W_KEY, String(value)), []);
  const commitNotesW = useCallback((value: number): void => writeSession(NOTES_W_KEY, String(value)), []);
  const [assetsW, setAssetsW] = useState<number | null>(() => readIntSession(ASSETS_W_KEY));

  /** The two right-hand lane toggles. Each dismisses through `dismissPane`, so
   *  a floating pane slides out rather than vanishing, and each puts a floating
   *  sibling away before it opens (they would otherwise overlap). */
  const toggleNotesLane = useCallback((): void => {
    if (notesLaneOpen) {
      dismissPane('notes');
      return;
    }
    if (!panelsFit && assetsLaneOpen) setAssetsLaneOpen(false);
    if (phoneTier && railOpen) closeRail();
    setNotesLaneOverride('1');
    writeSession(NOTES_LANE_KEY, '1');
  }, [
    notesLaneOpen,
    panelsFit,
    assetsLaneOpen,
    setAssetsLaneOpen,
    phoneTier,
    railOpen,
    closeRail,
    dismissPane,
  ]);

  const toggleAssetsLane = useCallback((): void => {
    if (assetsLaneOpen) {
      dismissPane('assets');
      return;
    }
    if (!panelsFit && notesLaneOpen) closeNotesLane();
    if (phoneTier && railOpen) closeRail();
    setAssetsLaneOpen(true);
  }, [
    assetsLaneOpen,
    panelsFit,
    notesLaneOpen,
    closeNotesLane,
    phoneTier,
    railOpen,
    closeRail,
    setAssetsLaneOpen,
    dismissPane,
  ]);
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

  /** The floating pane a tap on the transcript puts away. `null` on a tier
   *  where the panes are columns (a tap there must never close one) and `null`
   *  while a pane is sliding out, so the transcript is live again the moment
   *  the dismissing tap lands. */
  const scrimPane =
    exiting === null
      ? dismissTarget(
          { rail: railOpen, notes: notesLaneOpen, assets: assetsLaneOpen },
          { rail: phoneTier, lanes: laneOverlayTier },
        )
      : null;

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
    <div className={sideMin ? 'app side-minimized' : 'app'}>
      <aside className="app-side" aria-label="App">
        <div className="side-head">
          <span className="app-brand side-brand">Partner</span>
          {/* Lives inside the sidebar, so the phone tier (where the sidebar is
           *  hidden) cannot show a dead control. */}
          <button
            type="button"
            className="btn btn-secondary btn-sm side-collapse"
            onClick={toggleSideMin}
            aria-pressed={sideMin}
            aria-label={sideMin ? 'Expand menu' : 'Minimize menu'}
            title={sideMin ? 'Expand menu' : 'Minimize menu'}
          >
            {sideMin ? <IconChevronRight /> : <IconChevronLeft />}
          </button>
        </div>
        {paired ? (
          <SideNav current={view} attention={attention} minimized={sideMin} onSelect={setView} />
        ) : null}
        {paired ? (
          <div className="side-foot">
            <button
              type="button"
              className="btn btn-secondary side-tab"
              onClick={handleSignOut}
              aria-label="Sign out"
              title={sideMin ? 'Sign out' : undefined}
            >
              <IconSignOut />
              <span className="side-label">Sign out</span>
            </button>
          </div>
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
                exiting === null ? '' : PANEL_EXIT_CLASS[exiting],
              ]
                .filter(Boolean)
                .join(' ')}
              style={workspaceStyle}
            >
              {scrimPane !== null ? (
                /* Decorative tap target, exactly like the More sheet's scrim:
                 * the keyboard path is the top bar's toggles (and each pane's
                 * own close control), which is why this carries no role and
                 * stays out of the tab order. Scoped to the workspace, so those
                 * toggles stay live and undimmed while it is up. */
                <div
                  className="panel-scrim"
                  aria-hidden="true"
                  onClick={() => dismissPane(scrimPane)}
                />
              ) : null}
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
                      onClose={() => dismissPane('assets')}
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
                studioFocus={studioFocus}
                onStudioFocusConsumed={() => setStudioFocus(null)}
                onAttentionChanged={refreshAttention}
                onOpenConversation={handleOpenConversation}
                onOpenStudioDraft={openSkillDraftInStudio}
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
            <div className={view === 'shared' ? 'app-view app-view-active' : 'app-view'}>
              <SharedView onUnpair={handleSessionLost} active={view === 'shared'} />
            </div>
            <div className={view === 'members' ? 'app-view app-view-active' : 'app-view'}>
              <MembersView
                onUnpair={handleSessionLost}
                onSignOut={handleSignOut}
                active={view === 'members'}
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

