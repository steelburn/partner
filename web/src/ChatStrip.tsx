import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { sessionLostAction,sessionLostSentence } from './lib/auth-mode.js';
import type {
  AttachmentMeta,
  BrainstormSessionSummary,
  ChatEvent,
  ConversationMessage,
  ProviderSummary,
} from '@partner/shared';
import { describeBytes, declaredVisionModels, isImageCapableModel, MAX_INLINE_IMAGES_PER_TURN } from '@partner/shared';
import type { PendingToolCall } from '@partner/shared/src/tools.js';
import { ApiRequestError, listProviders, streamChat, type StreamDoneMeta } from './lib/api.js';
import { purposeLabel } from './lib/providers.js';
import { getConversation, suggestConversationTitle } from './lib/conversations.js';
import { RISK_LABELS, RISK_TONE_CLASS, pendingLabel, summarizeTool } from './lib/roots.js';
import { SkillInstallCard } from './SkillInstallCard.js';
import { decidePending } from './lib/tools.js';
import {
  deleteAttachment,
  fetchAttachmentContent,
  fetchUploadCaps,
  listAttachments,
  uploadAttachment,
} from './lib/attachments.js';
import { prepareAttachmentForUpload, type PreparedUpload } from './lib/image-convert.js';
import { readStoredToken } from './lib/token.js';
import { concludeBrainstorm, getNote, listNotes, reopenBrainstorm } from './lib/notes.js';
import { extractWikiLinks } from './lib/note-helpers.js';
import { noteSnippet } from './lib/wiki-links.js';
import { PartnerMarkdown } from './Markdown.js';
import type { WikiNoteTarget } from './WikiLinkChip.js';
import { ChoiceMemoryContext } from './ChoiceMemory.js';
import { conversationUi } from './lib/conversation-ui.js';
import {
  TITLE_MAX_CHARS,
  canSuggestTitle,
  normalizeTitleInput,
  suggestTitleHint,
  suggestionSourceNote,
  titleForDisplay,
} from './lib/session-title.js';
import { isGroupLive } from './lib/answer-group.js';
import { IconAttach, IconSave, IconSend } from './icons.js';
import { CodePreview } from './CodePreview.js';
import { SaveAssetsDialog } from './AssetsPanel.js';
import { extractCandidates, type AssetCandidate } from './lib/assets-extract.js';
import { partnerFileLink, searchFileRefs, type FileRefHit } from './lib/fileRefs.js';

export interface ChatStripProps {
  /** Forget the session and return to the pairing gate (auth failure). */
  onUnpair: () => void;
  /** Active persisted conversation (null = fresh chat, auto-created on send). */
  conversationId: string | null;
  /** Active persona for routing (null = no persona / demo fallback). */
  personaId: string | null;
  /** Active persona display name for the meta line. */
  personaName: string | null;
  /** Paused active persona -> banner + disabled input (core refuses 423). */
  personaPaused: boolean;
  /** Reported on turn start/end so the shell can disable switching controls. */
  onStreamingChange?: (streaming: boolean) => void;
  /** Server-confirmed ids after a turn (App refreshes + adopts the conversation). */
  onDone?: (meta: StreamDoneMeta) => void;
  /**
   * D6: the per-conversation theme select moved to the shell's top bar
   * (2026-09-13) — chrome lives in one place, and the row above the composer
   * held a second copy of both it and the Assets toggle. */
  pending: PendingToolCall[];
  /** Ask the shell to re-fetch the pending list right now (post-decide). */
  onRefreshPending: () => void;
  /** True while the Chat view is the visible one — returning to it reloads
   *  history so decisions made elsewhere (Files queue) show their notes. */
  viewActive?: boolean;
  /** M14: an asset was saved here — the shell refreshes the pane's list. */
  onAssetsChanged?: () => void;
  /**
   * M16 F4: an external surface (asset Discuss) wants this text quoted into
   * the composer. Consumed when its conversationId matches the open one;
   * bumped via nonce for repeated drafts into the same conversation.
   */
  externalDraft?: { conversationId: string | null; text: string; nonce: number } | null;
  /** The external draft was appended (clear it in the shell). */
  onDraftConsumed?: () => void;
  /**
   * M16 follow-up: when the open conversation IS a linked brainstorm, its
   * session state (active/concluded) drives a header Conclude/Reopen action.
   */
  brainstormSession?: BrainstormSessionSummary | null;
  /** The session was concluded/reopened — the shell stores the fresh state. */
  onBrainstormSessionChange?: (session: BrainstormSessionSummary) => void;
  /** Open a `[[Note Title]]` citation in the shell's Notes view. */
  onOpenNote?: (id: string) => void;
  /**
   * M34: the open session's stored title (null/absent = never named). Displayed
   * at the top of the chat and renamed in place.
   */
  sessionTitle?: string | null;
  /**
   * M34: store a new title for the open session. The shell owns the write +
   * refresh; a rejection surfaces under the header, so this is the ONE path
   * that stores a title — accepting an AI suggestion comes through here too.
   * The header never sends an empty title (Save is disabled on a blank field),
   * so a session cannot be left named "" by accident.
   */
  onRenameSession?: (title: string) => Promise<void> | void;
}

interface ChatRow {
  /** Stable render key: server message id when known, else a local counter. */
  key: string;
  role: 'system' | 'user' | 'assistant';
  text: string;
}

interface UsageSummary {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

interface TurnError {
  message: string;
  canRepair: boolean;
}

const EMPTY_STATE = 'Say hello to your partner.';
const EMPTY_CONVERSATION_STATE = 'A new conversation — say hello.';

/** Cap on automatic tool-continuation rounds per user turn (a safety bound so
 *  a model that keeps calling tools cannot loop forever / bill unbounded). */
const MAX_TOOL_CONTINUATIONS = 3;

function isSessionLost(cause: unknown): boolean {
  return cause instanceof ApiRequestError && (cause.status === 401 || cause.status === 403);
}

/** Map a persisted message onto a render row (order kept as delivered). */
function rowFromMessage(message: ConversationMessage): ChatRow {
  return { key: message.id, role: message.role, text: message.content };
}

/**
 * M3 ChatStrip: streams into the active conversation (or auto-creates one),
 * loads history when a conversation is selected, and shows the active
 * persona's name + paused state. When the selected persona is paused the
 * composer is disabled and the banner explains why — the core also refuses
 * paused personas with a 423. Message bodies are rendered only; never
 * logged or echoed outside the transcript.
 */
export default function ChatStrip({
  onUnpair,
  conversationId,
  personaId,
  personaName,
  personaPaused,
  onStreamingChange,
  onDone,
  pending,
  onRefreshPending,
  viewActive = false,
  onAssetsChanged,
  externalDraft,
  onDraftConsumed,
  brainstormSession = null,
  onBrainstormSessionChange,
  onOpenNote,
  sessionTitle = null,
  onRenameSession,
}: ChatStripProps) {
  const [rows, setRows] = useState<ChatRow[]>([]);
  const [draft, setDraft] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  const [modelLatency, setModelLatency] = useState<{ model: string; latencyMs: number } | null>(
    null,
  );
  const [turnError, setTurnError] = useState<TurnError | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  /** M12.6 in-chat approvals: decided rows hide instantly (the shell's poll
   *  still carries them for a moment) and stay hidden until the poll drops
   *  them for real. */
  const [decidedIds, setDecidedIds] = useState<ReadonlySet<string>>(new Set());
  const [decidingId, setDecidingId] = useState<string | null>(null);
  const [queueErrors, setQueueErrors] = useState<Readonly<Record<string, string>>>({});
  const [brainstormBusy, setBrainstormBusy] = useState(false);
  const [brainstormError, setBrainstormError] = useState<string | null>(null);
  /** M34: the session header — in-place rename plus a title PROPOSAL the owner
   *  reviews (accepting is the only thing that stores it). */
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const [savingTitle, setSavingTitle] = useState(false);
  const [titleError, setTitleError] = useState<string | null>(null);
  const [suggestion, setSuggestion] = useState<{
    title: string;
    source: 'model' | 'transcript';
  } | null>(null);
  const [suggesting, setSuggesting] = useState(false);
  const [suggestError, setSuggestError] = useState<string | null>(null);
  const nextId = useRef(0);
  /** Conversation whose usage/latency meta line is currently shown — the
   *  line is cleared when the open conversation changes (never leaks across
   *  chats; same-chat reloads keep it). */
  const metaForRef = useRef<string | null>(null);
  /** M16 wiki-links: notes by lowercased title, plus a small plain-text
   *  snippet so a `[[Title]]` chip can hint at the cited content. Reloaded
   *  when the view becomes active so a just-created note resolves. */
  const [noteTargets, setNoteTargets] = useState<ReadonlyMap<string, WikiNoteTarget>>(
    () => new Map(),
  );
  const snippetLoadedRef = useRef<Set<string>>(new Set());

  // M16 F4: an asset Discuss draft lands in the composer of its target
  // conversation (append keeps any text the user already typed).
  useEffect(() => {
    if (externalDraft === null || externalDraft === undefined) return;
    if (externalDraft.conversationId !== conversationId) return;
    const text = externalDraft.text;
    if (text.length === 0) return;
    setDraft((prev) => {
      if (prev.includes(text)) return prev;
      return prev.length === 0 ? text : `${prev}\n\n${text}`;
    });
    onDraftConsumed?.();
  }, [externalDraft, conversationId, onDraftConsumed]);
  const abortRef = useRef<AbortController | null>(null);
  /** M11 F2 tool continuation: the last turn's tool pass executed (or
   *  refused) a tool, so one more round should answer against the outcome. */
  const wantsToolContinueRef = useRef(false);
  /** Conversation id for the queued continuation (set once the turn ends). */
  const pendingToolContinueRef = useRef<string | null>(null);
  /** Automatic continuation rounds already spent on the current user turn. */
  const toolContinueDepthRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  /** M11 F1 staged uploads awaiting the next turn + per-message chips. */
  const [staged, setStaged] = useState<AttachmentMeta[]>([]);
  const [msgAttachments, setMsgAttachments] = useState<Record<string, AttachmentMeta[]>>({});
  const [attachError, setAttachError] = useState<string | null>(null);
  const [attaching, setAttaching] = useState(false);
  /**
   * R7: the core's attachment cap, so an over-size file is refused here rather
   * than after a phone has pushed megabytes at it (`null` = not stated yet, or
   * the core did not say — the server's own 413 is the backstop either way).
   */
  const [maxUploadBytes, setMaxUploadBytes] = useState<number | null>(null);
  /**
   * M24: the core's INLINE image budget (smaller than the upload cap). Images
   * over it are re-encoded before upload, because a photo the turn cannot send
   * is a photo the persona will tell you never arrived.
   */
  const [maxInlineImageBytes, setMaxInlineImageBytes] = useState<number | null>(null);
  /**
   * M13 per-turn model picker: explicit (providerId, model) for the NEXT
   * message; null = Auto (persona routing). When an image is staged and the
   * picker is still on Auto, a vision-capable suggestion is auto-applied
   * (the user can change it before sending — their pick is explicit).
   */
  const [turnModel, setTurnModel] = useState<{ providerId: string; model: string } | null>(null);
  /** M13: enabled providers with known models, for the picker options. */
  const [availableProviders, setAvailableProviders] = useState<ProviderSummary[]>([]);
  /** Auto-apply the vision suggestion once per staging batch. */
  const suggestApplied = useRef(false);
  /** M13: an inline image is staged for the next message. */
  const stagedHasImage = staged.some((meta) => meta.mime.startsWith('image/'));
  /**
   * M24: can this pick actually receive the photo? Answers with the serving
   * profile's DECLARATIONS in hand (models ticked image-capable, or any model
   * pinned to a `vision` purpose), not the model name alone — behind a gateway
   * the id is an alias the core cannot judge. Falls back to the name heuristic
   * when the provider is not in the picker list.
   */
  const pickSeesImages = (model: string, providerId?: string): boolean => {
    const provider =
      (providerId !== undefined
        ? availableProviders.find((p) => p.id === providerId)
        : undefined) ??
      availableProviders.find((p) => p.defaultModels.includes(model));
    return isImageCapableModel(model, declaredVisionModels(provider));
  };
  /**
   * M24: an attached photo bigger than the core's inline budget cannot ride the
   * turn. The composer re-encodes on the way in, so this only fires when the
   * core states a smaller budget than the encode used — say so instead of
   * letting the persona be the one to report a missing image.
   */
  const oversizedStagedImage =
    maxInlineImageBytes === null
      ? null
      : staged.find(
          (meta) => meta.mime.startsWith('image/') && meta.size > maxInlineImageBytes,
        ) ?? null;
  /**
   * M24: a turn carries at most `MAX_INLINE_IMAGES_PER_TURN` photos to the
   * model. Staging more is not an error, but the extras must not be mistaken
   * for sent ones — that silence is the whole bug this milestone closes.
   */
  const stagedImageCount = staged.filter((meta) => meta.mime.startsWith('image/')).length;
  const unbilledImageCount = Math.max(0, stagedImageCount - MAX_INLINE_IMAGES_PER_TURN);
  /** M13: one-line explanation of what the next message will use. */
  const stagedInlineImageNote = stagedHasImage
    ? oversizedStagedImage !== null
      ? `${oversizedStagedImage.name} is larger than the core can send to a model — remove it or attach a smaller copy.`
      : unbilledImageCount > 0
        ? `Only ${MAX_INLINE_IMAGES_PER_TURN} photos can ride one message — ${unbilledImageCount} of the ${stagedImageCount} attached will not be sent.`
        : turnModel === null
          ? 'Auto — a vision-capable model reads attached photos when the persona model cannot.'
          : `Photo attached — this turn uses ${turnModel.model}${
              pickSeesImages(turnModel.model, turnModel.providerId)
                ? ' (vision).'
                : ', which cannot receive photos — pick a vision model (or declare one in Providers) so the persona is actually shown it.'
            }`
    : turnModel === null
      ? null
      : `Sending with ${turnModel.model} for this turn.`;
  /** M11 F12 code preview state (attachment source fetched on demand). */
  const [preview, setPreview] = useState<{ title: string; source: string } | null>(null);
  /** M11 F10 assets: save-from-message state (the Assets pane itself is a
   *  workspace lane owned by the shell — the chat-bar button drives it). */
  const [saveTarget, setSaveTarget] = useState<{ id: string; text: string } | null>(null);
  const [saveCandidates, setSaveCandidates] = useState<AssetCandidate[]>([]);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [assetsFlash, setAssetsFlash] = useState<string | null>(null);
  /** M11 F1 composer @-mention state (file refs inside granted roots). */
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const [mention, setMention] = useState<{
    start: number;
    query: string;
    items: FileRefHit[];
    index: number;
    loading: boolean;
  } | null>(null);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [unseen, setUnseen] = useState(0);
  const seenLenRef = useRef(0);

  // R7/M24: read BOTH byte budgets once. The upload cap lets the composer
  // refuse an over-size file before uploading it; the inline cap is what an
  // image is encoded down to, so the attached photo is small enough to ride to
  // the model. A failure is not surfaced: nothing is broken, the pre-check is
  // simply unavailable and the server still answers.
  useEffect(() => {
    let cancelled = false;
    fetchUploadCaps()
      .then((caps) => {
        if (cancelled) return;
        setMaxUploadBytes(caps.maxUploadBytes);
        setMaxInlineImageBytes(caps.maxInlineImageBytes);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  // M11 F8: follow the latest text. While the user is at the bottom (or has
  // never scrolled up), every change pins the transcript to the newest line;
  // scrolling up releases the pin and counts messages that arrive while away.
  useEffect(() => {
    const el = transcriptRef.current;
    if (!el) return;
    seenLenRef.current = rows.length;
    if (!atBottom) {
      return;
    }
    const frame = requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
    return () => cancelAnimationFrame(frame);
  }, [rows, atBottom, reloadToken]);

  useEffect(() => {
    if (atBottom) {
      setUnseen(0);
      return;
    }
    if (rows.length > seenLenRef.current) {
      setUnseen((u) => u + (rows.length - seenLenRef.current));
    }
  }, [rows, atBottom]);

  const handleTranscriptScroll = (): void => {
    const el = transcriptRef.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    setAtBottom(near);
  };
  const jumpToLatest = (): void => {
    const el = transcriptRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    setAtBottom(true);
    setUnseen(0);
  };

  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  const loadHistory = useCallback(async (): Promise<void> => {
    if (conversationId === null) {
      setRows([]);
      setHistoryError(null);
      setUsage(null);
      setModelLatency(null);
      setTurnError(null);
      return;
    }
    const token = readStoredToken();
    if (!token) {
      setHistoryError('Not paired with the Partner core.');
      return;
    }
    setHistoryLoading(true);
    setHistoryError(null);
    // The last turn's usage/latency meta belongs to whichever conversation
    // produced it — a freshly opened chat (e.g. a forked discussion) must
    // not inherit the previous conversation's "N tokens · model · ms" line
    // under its composer (views stay mounted, so state would otherwise
    // leak across chats). Same-conversation reloads keep the meta.
    if (metaForRef.current !== conversationId) {
      metaForRef.current = conversationId;
      setUsage(null);
      setModelLatency(null);
      setTurnError(null);
    }
    try {
      const detail = await getConversation(token, conversationId);
      // A fresh conversation may have no messages yet; history replaces the
      // transcript wholesale (turn state is only valid for the same id).
      setRows(detail.messages.map(rowFromMessage));
    } catch (cause) {
      if (isSessionLost(cause)) {
        onUnpair();
        return;
      }
      setHistoryError(
        cause instanceof Error ? cause.message : 'Could not load this conversation.',
      );
    } finally {
      setHistoryLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId]);

  useEffect(() => {
    if (conversationId === null) {
      setRows([]);
      setHistoryError(null);
      setHistoryLoading(false);
      return;
    }
    void loadHistory();
  }, [conversationId, loadHistory, reloadToken]);

  // M16 wiki-links: index note titles so `[[Title]]` citations render as
  // chips. Reloaded whenever the Chat view becomes active (a note created
  // elsewhere then resolves) and after a history reload. Failure is silent —
  // citations simply render as dangling chips.
  useEffect(() => {
    if (!viewActive) return;
    const token = readStoredToken();
    if (!token) return;
    let cancelled = false;
    void listNotes(token)
      .then((rows) => {
        if (cancelled) return;
        setNoteTargets((prev) => {
          const next = new Map<string, WikiNoteTarget>();
          for (const row of rows) {
            const key = row.title.toLocaleLowerCase();
            const existing = prev.get(key);
            next.set(key, { id: row.id, title: row.title, snippet: existing?.snippet ?? null });
          }
          return next;
        });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [viewActive, reloadToken]);

  // Fetch a body preview for cited notes that are visible in the transcript
  // (bounded per pass) so a chip's hint can show real content, not just the
  // title. Already-loaded notes are skipped.
  useEffect(() => {
    const token = readStoredToken();
    if (!token) return;
    const wanted: WikiNoteTarget[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
      if (row.role === 'user') continue;
      for (const title of extractWikiLinks(row.text)) {
        const target = noteTargets.get(title.toLocaleLowerCase());
        if (target === undefined || target.snippet != null) continue;
        if (snippetLoadedRef.current.has(target.id) || seen.has(target.id)) continue;
        seen.add(target.id);
        wanted.push(target);
        if (wanted.length >= 12) break;
      }
      if (wanted.length >= 12) break;
    }
    if (wanted.length === 0) return;
    let cancelled = false;
    void Promise.all(
      wanted.map(async (target) => {
        try {
          const note = await getNote(token, target.id);
          return { id: target.id, snippet: noteSnippet(note.content, 240) };
        } catch {
          return null;
        }
      }),
    ).then((results) => {
      if (cancelled) return;
      const snippets = new Map<string, string>();
      for (const result of results) {
        if (result !== null) snippets.set(result.id, result.snippet);
      }
      if (snippets.size === 0) return;
      for (const target of wanted) snippetLoadedRef.current.add(target.id);
      setNoteTargets((prev) => {
        const next = new Map(prev);
        for (const [key, target] of next) {
          const snippet = snippets.get(target.id);
          if (snippet !== undefined) next.set(key, { ...target, snippet });
        }
        return next;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [rows, noteTargets]);

  const resolveNote = useCallback(
    (title: string): WikiNoteTarget | null =>
      noteTargets.get(title.trim().toLocaleLowerCase()) ?? null,
    [noteTargets],
  );

  // M12.5: forget local “decided” markers as soon as the shell's poll no
  // longer carries those rows — the row really closed, the marker can go.
  useEffect(() => {
    const live = new Set(pending.map((item) => item.id));
    setDecidedIds((prev) => {
      const stale = [...prev].filter((id) => !live.has(id));
      return stale.length > 0 ? new Set(stale.filter((id) => live.has(id))) : prev;
    });
  }, [pending]);

  // M12.5: re-entering the Chat view reloads history. Approvals decided from
  // the Files queue post their outcome notes server-side while this view is
  // hidden — without the reload the transcript would stay stale forever.
  const wasViewActiveRef = useRef(viewActive);
  const reloadOnIdleRef = useRef(false);
  useEffect(() => {
    const wasActive = wasViewActiveRef.current;
    wasViewActiveRef.current = viewActive;
    if (!viewActive) {
      // Left the chat: any note posted while away must appear on return.
      reloadOnIdleRef.current = true;
      return;
    }
    if (!wasActive) reloadOnIdleRef.current = true;
    if (reloadOnIdleRef.current && !streaming && conversationId !== null) {
      reloadOnIdleRef.current = false;
      setReloadToken((n) => n + 1);
    }
  }, [viewActive, streaming, conversationId]);

  // -----------------------------------------------------------------------
  // M11 F1 attachments (staged uploads + per-message chips)
  // -----------------------------------------------------------------------

  useEffect(() => {
    if (conversationId === null) {
      setStaged([]);
      setMsgAttachments({});
      setAttachError(null);
      return;
    }
    const token = readStoredToken();
    if (!token) return;
    let cancelled = false;
    listAttachments(token, conversationId)
      .then((all) => {
        if (cancelled) return;
        const stagedList: AttachmentMeta[] = [];
        const byMessage: Record<string, AttachmentMeta[]> = {};
        for (const meta of all) {
          if (meta.messageId === null) stagedList.push(meta);
          else (byMessage[meta.messageId] ??= []).push(meta);
        }
        setStaged(stagedList);
        setMsgAttachments(byMessage);
        setAttachError(null);
      })
      .catch((cause) => {
        if (cancelled || isSessionLost(cause)) return;
        setAttachError(cause instanceof Error ? cause.message : 'Could not load attachments.');
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId, reloadToken]);

  const handleFiles = async (files: FileList | null): Promise<void> => {
    if (!files || files.length === 0 || conversationId === null) return;
    const token = readStoredToken();
    if (!token) {
      onUnpair();
      return;
    }
    setAttaching(true);
    setAttachError(null);
    // R7: refusals are collected and shown together (per-file, first failure
    // does not abandon the rest of the selection) instead of one setState per
    // file, where the last message would silently win.
    const problems: string[] = [];
    let sessionLost = false;
    try {
      for (const file of Array.from(files)) {
        let prepared: PreparedUpload;
        try {
          // iPhone photos arrive as HEIC here and leave as JPEG; an image too
          // heavy to ride to the model is re-encoded to the inline budget as
          // well (see lib/image-convert.ts). The cap is enforced on what is
          // actually uploaded, so a huge HEIC is converted rather than refused.
          prepared = await prepareAttachmentForUpload(
            file,
            maxUploadBytes,
            {},
            maxInlineImageBytes,
          );
        } catch (cause) {
          problems.push(
            cause instanceof Error ? cause.message : 'Could not read that file.',
          );
          continue;
        }
        const meta = await uploadAttachment(token, conversationId, {
          name: prepared.name,
          mime: prepared.mime,
          data: prepared.data,
        });
        setStaged((prev) => [...prev, meta]);
      }
    } catch (cause) {
      if (isSessionLost(cause)) sessionLost = true;
      else
        problems.push(
          cause instanceof Error ? cause.message : 'Could not attach the file — try a text, image, PDF, HTML or CSS file.',
        );
    } finally {
      setAttaching(false);
      if (fileInputRef.current !== null) fileInputRef.current.value = '';
    }
    // The session gate is answered only once the loop is unwound — a message
    // about attachments on a view that is being left would be noise.
    if (sessionLost) {
      onUnpair();
      return;
    }
    if (problems.length > 0) setAttachError(problems.join(' '));
  };

  const handleRemoveStaged = async (id: string): Promise<void> => {
    if (conversationId === null) return;
    const token = readStoredToken();
    if (!token) {
      onUnpair();
      return;
    }
    try {
      await deleteAttachment(token, conversationId, id);
      setStaged((prev) => prev.filter((meta) => meta.id !== id));
    } catch (cause) {
      if (isSessionLost(cause)) {
        onUnpair();
        return;
      }
      setAttachError(cause instanceof Error ? cause.message : 'Could not remove the attachment.');
    }
  };

  /** F10: copy an assistant response as markdown. */
  const copyText = async (key: string, text: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(key);
      window.setTimeout(() => setCopiedKey((current) => (current === key ? null : current)), 1200);
    } catch {
      setAssetsFlash('Clipboard unavailable — select the text and copy it manually.');
    }
  };

  /** F10: open the save dialog with this response's candidates. */
  const openSave = (id: string, text: string): void => {
    setSaveTarget({ id, text });
    setSaveCandidates(extractCandidates(text));
    setAssetsFlash(null);
  };

  /** F12: preview an HTML/CSS attachment inside the sandboxed viewer. */
  const openPreview = async (meta: AttachmentMeta): Promise<void> => {
    if (conversationId === null) return;
    const token = readStoredToken();
    if (!token) {
      onUnpair();
      return;
    }
    try {
      const { bytes } = await fetchAttachmentContent(token, conversationId, meta.id);
      const source = new TextDecoder().decode(bytes);
      setPreview({ title: meta.name, source });
    } catch (cause) {
      if (isSessionLost(cause)) {
        onUnpair();
        return;
      }
      setAttachError(cause instanceof Error ? cause.message : 'Could not load the file for preview.');
    }
  };

  const canSend =
    !streaming && draft.trim().length > 0 && !personaPaused && historyLoading === false;

  /**
   * End the in-flight turn: drop a still-empty assistant placeholder and
   * quietly re-key the finished assistant row with the server message id so
   * keys stay stable across a history reload of the same conversation.
   */
  const finishTurn = (meta: StreamDoneMeta | null): void => {
    setStreaming(false);
    onStreamingChange?.(false);
    setRows((prev) => {
      const last = prev[prev.length - 1];
      if (!last || last.role !== 'assistant') return prev;
      if (last.text === '') return prev.slice(0, -1);
      if (meta && meta.messageId.length > 0) {
        const next = prev.slice(0, -1);
        next.push({ ...last, key: meta.messageId });
        return next;
      }
      return prev;
    });
  };

  // ---------------------------------------------------------------------
  // M12.6 in-chat approvals (active conversation → decide → continue)
  // ---------------------------------------------------------------------

  /** Shared SSE dispatcher for user turns AND approval-continuation turns. */
  const handleStreamEvent = (event: ChatEvent): void => {
    switch (event.type) {
      case 'delta':
        setRows((prev) => {
          const last = prev[prev.length - 1];
          if (!last || last.role !== 'assistant') return prev;
          const index = prev.length - 1;
          return prev.map((row, i) =>
            i === index ? { ...row, text: row.text + event.text } : row,
          );
        });
        break;
      case 'usage':
        setUsage({
          promptTokens: event.promptTokens,
          completionTokens: event.completionTokens,
          totalTokens: event.totalTokens,
        });
        break;
      case 'done':
        setModelLatency({ model: event.model, latencyMs: event.latencyMs });
        break;
      case 'error':
        setTurnError({ message: event.message, canRepair: false });
        break;
      case 'budget_reached':
        setTurnError({ message: event.message, canRepair: false });
        break;
      case 'tool_calls':
        // Turn machinery — never forwarded to the client stream.
        break;
      case 'tool_note':
        // Tool-pass outcome note streamed after `done`: render it immediately
        // (it is also persisted, so a later history reload is idempotent).
        setRows((prev) => [
          ...prev,
          { key: `note-${++nextId.current}`, role: 'system', text: event.content },
        ]);
        break;
      case 'tool_continue':
        // The core executed/refused a tool — answer against it next round.
        wantsToolContinueRef.current = true;
        break;
    }
  };

  /** Pending approvals asked from THIS conversation. */
  const chatPending =
    conversationId !== null
      ? pending.filter(
          (item) => item.conversationId === conversationId && !decidedIds.has(item.id),
        )
      : [];

  const approvalBusy = decidingId !== null || streaming;

  /** Stage a continuation when the core's tool pass asked for one. Called
   *  from the turn's `finally` (after `finishTurn` cleared streaming) so the
   *  effect below can start the round from a settled state. */
  const queueToolContinue = (meta: StreamDoneMeta | null): void => {
    if (!wantsToolContinueRef.current) return;
    wantsToolContinueRef.current = false;
    const target =
      meta !== null && meta.conversationId !== '' ? meta.conversationId : conversationId;
    if (target === null || target === '') return;
    pendingToolContinueRef.current = target;
  };

  /** After a decision (or a tool outcome): continue the turn so the
   *  assistant answers against the note the core just posted. */
  const runContinue = async (
    targetConversationId: string | null = conversationId,
  ): Promise<void> => {
    if (targetConversationId === null || streaming || personaPaused) return;
    const token = readStoredToken();
    if (!token) {
      setTurnError({ message: 'Not paired with the Partner core.', canRepair: true });
      return;
    }
    const placeholder: ChatRow = { key: `local-${++nextId.current}`, role: 'assistant', text: '' };
    setRows((prev) => [...prev, placeholder]);
    const dropPlaceholder = (): void => {
      setRows((prev) => prev.filter((r) => r.key !== placeholder.key));
    };
    metaForRef.current = targetConversationId;
    setUsage(null);
    setModelLatency(null);
    setTurnError(null);
    setHistoryError(null);
    setStreaming(true);
    onStreamingChange?.(true);

    const controller = new AbortController();
    abortRef.current = controller;
    let doneMeta: StreamDoneMeta | null = null;
    try {
      const result = await streamChat({
        token,
        content: '',
        continueTurn: true,
        conversationId: targetConversationId,
        personaId: personaId ?? undefined,
        signal: controller.signal,
        onEvent: handleStreamEvent,
        onDoneMeta: (meta) => {
          doneMeta = meta;
        },
      });
      if (!result.ok) {
        dropPlaceholder();
        setTurnError({
          message: result.unauthorized
            ? sessionLostSentence('continue')
            : result.message,
          canRepair: result.unauthorized,
        });
      }
    } catch (cause) {
      if (cause instanceof Error && cause.name === 'AbortError') return;
      dropPlaceholder();
      setTurnError({
        message: 'Lost connection to the Partner core. Check that it is running and try again.',
        canRepair: false,
      });
    } finally {
      finishTurn(doneMeta);
      if (doneMeta) onDone?.(doneMeta);
      // A continuation turn may itself have run a tool — allow it to chain
      // (bounded by MAX_TOOL_CONTINUATIONS per user turn).
      queueToolContinue(doneMeta);
    }
  };

  // M11 F2: the core's tool pass ends with `tool_continue` when a tool ran (or
  // was refused) — the persona should answer against the outcome now. Run the
  // continuation once streaming has settled, capped per user turn so a
  // tool-happy model cannot loop forever. Approval-queued tools never land
  // here (the user decides those first).
  useEffect(() => {
    if (streaming) return;
    const target = pendingToolContinueRef.current;
    if (target === null) return;
    pendingToolContinueRef.current = null;
    if (toolContinueDepthRef.current >= MAX_TOOL_CONTINUATIONS) return;
    toolContinueDepthRef.current += 1;
    void runContinue(target);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streaming]);

  /** Approve/deny one in-chat row: decide it once, then continue the turn. */
  const decideChatApproval = async (
    row: PendingToolCall,
    decision: 'approve' | 'deny',
    options: { acknowledgePermissions?: boolean } = {},
  ): Promise<void> => {
    if (approvalBusy) return;
    const token = readStoredToken();
    if (!token) {
      onUnpair();
      return;
    }
    setDecidingId(row.id);
    setQueueErrors((prev) => ({ ...prev, [row.id]: '' }));
    try {
      const outcome = await decidePending(token, row.id, { decision, ...options });
      if (decision === 'approve' && !outcome.executed && outcome.error !== undefined) {
        setQueueErrors((prev) => ({
          ...prev,
          [row.id]: `${summarizeTool(row.toolId).label} could not run: ${outcome.error}`,
        }));
      }
      setDecidedIds((prev) => new Set([...prev, row.id]));
      onRefreshPending();
      // The core closed the row and posted the outcome note; now run the
      // persona's next round so the chat visibly continues with the result.
      await runContinue();
    } catch (cause) {
      if (isSessionLost(cause)) {
        onUnpair();
        return;
      }
      // Already decided elsewhere (double click / Files view) is a closed
      // row — treat it as decided and let the poll reconcile.
      setDecidedIds((prev) => new Set([...prev, row.id]));
      onRefreshPending();
      setQueueErrors((prev) => ({
        ...prev,
        [row.id]: cause instanceof Error ? cause.message : 'Could not reach the Partner core.',
      }));
    } finally {
      setDecidingId(null);
    }
  };

  const runTurn = async (content: string, attachmentIds: string[] = []): Promise<void> => {
    if (content.trim().length === 0 || streaming || personaPaused) return;

    const token = readStoredToken();
    if (!token) {
      setTurnError({ message: 'Not paired with the Partner core.', canRepair: true });
      return;
    }

    const userRow: ChatRow = { key: `local-${++nextId.current}`, role: 'user', text: content };
    const placeholder: ChatRow = { key: `local-${++nextId.current}`, role: 'assistant', text: '' };
    setRows((prev) => [...prev, userRow, placeholder]);
    // A new user turn resets the tool-continuation budget.
    toolContinueDepthRef.current = 0;
    pendingToolContinueRef.current = null;
    wantsToolContinueRef.current = false;
    // A failed turn is never persisted server-side: drop the optimistic rows
    // so a later history reload cannot silently remove a visible ghost.
    const dropLocals = (): void => {
      setRows((prev) => prev.filter((r) => r.key !== userRow.key && r.key !== placeholder.key));
    };
    setDraft('');
    setUsage(null);
    setModelLatency(null);
    setTurnError(null);
    setHistoryError(null);
    metaForRef.current = conversationId;
    setStreaming(true);
    onStreamingChange?.(true);

    const controller = new AbortController();
    abortRef.current = controller;
    let doneMeta: StreamDoneMeta | null = null;

    try {
      const result = await streamChat({
        token,
        content,
        conversationId: conversationId ?? undefined,
        personaId: personaId ?? undefined,
        ...(attachmentIds.length > 0 ? { attachmentIds } : {}),
        ...(turnModel !== null ? { model: turnModel.model, providerId: turnModel.providerId } : {}),
        signal: controller.signal,
        onEvent: handleStreamEvent,
        onDoneMeta: (meta) => {
          doneMeta = meta;
        },
      });
      if (!result.ok) {
        dropLocals();
        setTurnError({
          message: result.unauthorized
            ? sessionLostSentence('continue')
            : result.message,
          canRepair: result.unauthorized,
        });
      }
    } catch (cause) {
      if (cause instanceof Error && cause.name === 'AbortError') return;
      dropLocals();
      setTurnError({
        message: 'Lost connection to the Partner core. Check that it is running and try again.',
        canRepair: false,
      });
    } finally {
      finishTurn(doneMeta);
      if (doneMeta) onDone?.(doneMeta);
      // The tool pass streams `tool_continue` AFTER `done`; stage the
      // continuation so the persona answers against the search result now
      // instead of leaving the promise hanging until the user nudges it.
      queueToolContinue(doneMeta);
    }
  };

  /**
   * M13 model picker: reset to Auto whenever the persona changes so the next
   * persona's routing applies by default (provider list refresh is separate).
   * An EXPLICIT pick remembered for this conversation wins over that default
   * (M13: an explicit pick is never overridden).
   */
  useEffect(() => {
    setTurnModel(conversationUi.getModelPick(conversationId));
    suggestApplied.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [personaId]);

  /**
   * M14: restoring per-conversation selections — when the active conversation
   * changes the picker must show that conversation's remembered explicit pick
   * (or Auto), not whatever the previous conversation left in state (views
   * stay mounted, so state would otherwise leak across chats).
   */
  useEffect(() => {
    setTurnModel(conversationUi.getModelPick(conversationId));
    suggestApplied.current = false;
  }, [conversationId]);

  /**
   * M13 model picker: load enabled providers with known models (grouped by
   * purpose in the picker). Fetches on mount and every time the Chat view
   * becomes visible again — providers added in the Providers view must show
   * up here without remounting (views stay mounted, so a persona-only fetch
   * would otherwise go stale forever).
   */
  useEffect(() => {
    if (!viewActive) return;
    const token = readStoredToken();
    if (!token) return;
    let cancelled = false;
    listProviders(token)
      .then((providers) => {
        if (!cancelled) {
          setAvailableProviders(providers.filter((p) => p.enabled && p.defaultModels.length > 0));
        }
      })
      .catch(() => {
        if (!cancelled) setAvailableProviders([]);
      });
    return () => {
      cancelled = true;
    };
  }, [personaId, viewActive]);

  /** First image-capable model across the picker providers (vision first). */
  const suggestVision = (): { providerId: string; model: string } | null => {
    const ordered = [...availableProviders].sort(
      (a, b) => (b.purpose === 'vision' ? 1 : 0) - (a.purpose === 'vision' ? 1 : 0),
    );
    for (const p of ordered) {
      const declared = declaredVisionModels(p);
      const model = p.defaultModels.find((m) => isImageCapableModel(m, declared));
      if (model !== undefined) return { providerId: p.id, model };
    }
    return null;
  };

  /**
   * M13 vision auto-suggest: a staged image with the picker still on Auto
   * pre-selects a vision-capable model (confirmed by the user when they hit
   * Send — the server never overrides an explicit pick).
   */
  useEffect(() => {
    if (stagedHasImage) {
      if (turnModel === null && suggestApplied.current === false) {
        const suggested = suggestVision();
        if (suggested !== null) {
          setTurnModel(suggested);
          suggestApplied.current = true;
        }
      }
    } else {
      suggestApplied.current = false;
    }
  }, [stagedHasImage, turnModel, availableProviders]);

  /** Composer submit: send the typed draft with any staged attachments. */
  const send = async (): Promise<void> => {
    const content = draft.trim();
    if (content.length === 0 || streaming || personaPaused) return;
    const ids = staged.map((meta) => meta.id);
    setDraft('');
    await runTurn(content, ids);
    if (ids.length > 0) {
      setStaged([]);
      setReloadToken((n) => n + 1);
    }
    // Keep the model remembered for this conversation (an explicit pick is a
    // per-conversation default); Auto conversations stay on Auto. The pick is
    // written to memory when the user changes the select below.
    setTurnModel(conversationUi.getModelPick(conversationId));
    suggestApplied.current = false;
  };

  /** F9: an option card answered — send the answer as a normal user turn. */
  const handleAnswer = (message: string): void => {
    if (streaming || personaPaused) return;
    void runTurn(message);
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    void send();
  };

  // M11 F1 @-mention helpers: keep the popup open while the token text
  // stays contiguous, close it otherwise.
  const updateMention = (value: string, caret: number): void => {
    if (mention !== null) {
      const segment = value.slice(mention.start, caret);
      const contiguous = !/[\s()\[\]{}`]/.test(segment);
      if (segment.startsWith('@') && contiguous) {
        setMention((current) =>
          current === null ? current : { ...current, query: segment.slice(1) },
        );
        return;
      }
      setMention(null);
      return;
    }
    if (caret > 0 && value[caret - 1] === '@') {
      const previous = caret >= 2 ? value[caret - 2] : '\n';
      const allowed =
        previous === ' ' || previous === '\n' || previous === '\t' || previous === '(' || previous === '[';
      if (allowed) {
        setMention({ start: caret - 1, query: '', items: [], index: 0, loading: false });
      }
    }
  };

  // Debounced file search while the mention popup is open (query-keyed so
  // result state updates never re-trigger the search).
  const mentionQuery = mention?.query ?? null;
  useEffect(() => {
    if (mentionQuery === null) return;
    const token = readStoredToken();
    if (!token) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void searchFileRefs(token, mentionQuery)
        .then((items) => {
          if (!cancelled) {
            setMention((current) =>
              current === null ? null : { ...current, items, index: 0, loading: false },
            );
          }
        })
        .catch(() => {
          if (!cancelled) {
            setMention((current) =>
              current === null ? null : { ...current, items: [], loading: false },
            );
          }
        });
    }, 220);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [mentionQuery]);

  const insertMention = (hit: FileRefHit): void => {
    if (mention === null) return;
    const link = partnerFileLink(hit);
    setDraft(`${draft.slice(0, mention.start)}${link} `);
    setMention(null);
    window.setTimeout(() => composerRef.current?.focus(), 0);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (mention !== null && mention.items.length > 0) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setMention((current) =>
          current === null
            ? current
            : { ...current, index: (current.index + 1) % current.items.length },
        );
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setMention((current) =>
          current === null
            ? current
            : { ...current, index: (current.index - 1 + current.items.length) % current.items.length },
        );
        return;
      }
      if (event.key === 'Enter') {
        const pick = mention.items[mention.index];
        if (pick) {
          event.preventDefault();
          insertMention(pick);
          return;
        }
      }
    }
    if (mention !== null && event.key === 'Escape') {
      event.preventDefault();
      setMention(null);
      return;
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void send();
    }
  };

  /** M16 follow-up: conclude/reopen the linked brainstorm from the header. */
  // Never leak a previous conversation's brainstorm error into the next chat.
  useEffect(() => {
    setBrainstormError(null);
  }, [conversationId]);

  /**
   * M34: a title proposal belongs to the conversation that produced it, so
   * switching chats drops it (with the header's own transient state) rather
   * than offering the previous chat's name for this one.
   */
  useEffect(() => {
    setSuggestion(null);
    setSuggestError(null);
    setTitleError(null);
    setEditingTitle(false);
  }, [conversationId]);

  const beginTitleEdit = (): void => {
    if (conversationId === null) return;
    setTitleDraft(sessionTitle ?? '');
    setTitleError(null);
    setEditingTitle(true);
  };

  const saveTitle = async (): Promise<void> => {
    if (conversationId === null || savingTitle) return;
    const next = normalizeTitleInput(titleDraft);
    if (next === '') return;
    setSavingTitle(true);
    setTitleError(null);
    try {
      await onRenameSession?.(next);
      setEditingTitle(false);
    } catch (cause) {
      if (isSessionLost(cause)) {
        onUnpair();
        return;
      }
      setTitleError(cause instanceof Error ? cause.message : 'Could not rename this session.');
    } finally {
      setSavingTitle(false);
    }
  };

  /**
   * Ask the core to name this session from the transcript. Nothing is stored —
   * the reply is held for review, and the owner's accept is what writes.
   */
  const requestTitleSuggestion = async (): Promise<void> => {
    if (conversationId === null || suggesting) return;
    const token = readStoredToken();
    if (!token) {
      onUnpair();
      return;
    }
    setSuggesting(true);
    setSuggestError(null);
    try {
      const reply = await suggestConversationTitle(token, conversationId);
      if (!reply.ok) {
        setSuggestion(null);
        setSuggestError(reply.message);
        return;
      }
      setSuggestion({ title: reply.title, source: reply.source });
    } catch (cause) {
      if (isSessionLost(cause)) {
        onUnpair();
        return;
      }
      setSuggestion(null);
      setSuggestError(
        cause instanceof Error ? cause.message : 'Could not suggest a title right now.',
      );
    } finally {
      setSuggesting(false);
    }
  };

  const acceptTitleSuggestion = async (): Promise<void> => {
    if (suggestion === null || savingTitle) return;
    setSavingTitle(true);
    setTitleError(null);
    try {
      await onRenameSession?.(suggestion.title);
      setSuggestion(null);
    } catch (cause) {
      if (isSessionLost(cause)) {
        onUnpair();
        return;
      }
      setTitleError(cause instanceof Error ? cause.message : 'Could not rename this session.');
    } finally {
      setSavingTitle(false);
    }
  };

  const flipBrainstorm = async (): Promise<void> => {
    if (brainstormSession === null || brainstormBusy) return;
    const token = readStoredToken();
    if (!token) {
      onUnpair();
      return;
    }
    setBrainstormBusy(true);
    setBrainstormError(null);
    try {
      const next = brainstormSession.concluded
        ? await reopenBrainstorm(token, brainstormSession.conversationId)
        : await concludeBrainstorm(token, brainstormSession.conversationId);
      onBrainstormSessionChange?.(next);
    } catch (cause) {
      if (isSessionLost(cause)) {
        onUnpair();
        return;
      }
      setBrainstormError(
        cause instanceof Error ? cause.message : 'Could not update the brainstorm.',
      );
    } finally {
      setBrainstormBusy(false);
    }
  };

  const metaParts: string[] = [];
  if (personaName) metaParts.push(personaName);
  if (usage) metaParts.push(`${usage.totalTokens} tokens`);
  if (modelLatency) metaParts.push(`${modelLatency.model} · ${modelLatency.latencyMs} ms`);
  const metaText = metaParts.join(' · ');
  const showPending = streaming && rows[rows.length - 1]?.role === 'assistant';
  const emptyState = conversationId === null ? EMPTY_STATE : EMPTY_CONVERSATION_STATE;
  /** The linked-brainstorm header only belongs to the conversation it came from. */
  const showBrainstorm =
    brainstormSession !== null && brainstormSession.conversationId === conversationId;
  /** M34: the session header. */
  const sessionHeading = titleForDisplay(sessionTitle);
  const suggestReason = suggestTitleHint(rows);
  const canSuggest = canSuggestTitle(rows);
  const headerNote = titleError ?? suggestError;

  return (
    <section className="chat" aria-label="Chat with Partner">
      {/* M34: the session title, at the top of the session and editable in
        * place. `sessionTitle` is the shell's copy of the stored title, so this
        * stays a controlled read of one value rather than a second store. */}
      <div className="chat-session">
        {editingTitle ? (
          <form
            className="chat-session-form"
            onSubmit={(event) => {
              event.preventDefault();
              void saveTitle();
            }}
          >
            <input
              className="field chat-session-input"
              value={titleDraft}
              autoFocus
              maxLength={TITLE_MAX_CHARS}
              placeholder="Name this session"
              aria-label="Session title"
              disabled={savingTitle}
              onChange={(event) => setTitleDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.preventDefault();
                  setEditingTitle(false);
                }
              }}
            />
            <button
              type="submit"
              className="btn btn-primary btn-sm"
              disabled={savingTitle || titleDraft.trim() === ''}
              aria-busy={savingTitle}
            >
              Save
            </button>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              disabled={savingTitle}
              onClick={() => setEditingTitle(false)}
            >
              Cancel
            </button>
          </form>
        ) : (
          <div className="chat-session-head">
            <h2 className="chat-session-title" title={sessionHeading}>
              {sessionHeading}
            </h2>
            <div className="chat-session-actions">
              <button
                type="button"
                className="btn-link chat-session-action"
                onClick={beginTitleEdit}
                disabled={conversationId === null}
                title={conversationId === null ? 'Send a message first' : undefined}
              >
                Rename
              </button>
              <button
                type="button"
                className="btn-link chat-session-action"
                onClick={() => void requestTitleSuggestion()}
                disabled={conversationId === null || suggesting || !canSuggest}
                aria-busy={suggesting}
                title={suggestReason}
              >
                {suggesting ? 'Reading the chat…' : 'Suggest title'}
              </button>
            </div>
          </div>
        )}
      </div>

      {suggestion !== null ? (
        <div className="chat-session-proposal" role="status">
          <span className="chat-session-proposal-text">
            Suggested: <strong>{suggestion.title}</strong>
          </span>
          <span className="chat-session-proposal-actions">
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() => void acceptTitleSuggestion()}
              disabled={savingTitle}
              aria-busy={savingTitle}
            >
              Use title
            </button>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => setSuggestion(null)}
              disabled={savingTitle}
            >
              Dismiss
            </button>
          </span>
          {suggestionSourceNote(suggestion.source) === null ? null : (
            <span className="chat-session-proposal-note">
              {suggestionSourceNote(suggestion.source)}
            </span>
          )}
        </div>
      ) : null}

      {headerNote === null ? null : (
        <div className="chat-session-note" role="alert">
          <span className="chat-session-note-text">{headerNote}</span>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => {
              setTitleError(null);
              setSuggestError(null);
            }}
          >
            Dismiss
          </button>
        </div>
      )}

      <div
        className="chat-transcript"
        aria-live="polite"
        ref={transcriptRef}
        onScroll={handleTranscriptScroll}
      >
        {historyLoading ? (
          <p className="chat-empty" aria-busy="true">
            Loading conversation…
          </p>
        ) : rows.length === 0 && !historyLoading ? (
          <p className="chat-empty">{emptyState}</p>
        ) : (
          // `rowIndex`/`rows.length` is the transcript position that decides
          // whether a grouped-answer control is still live (see `isGroupLive`).
          // Only this call site has it, which is why the prop is optional and
          // defaults to interactive everywhere else.
          rows.map((row, rowIndex) =>
            row.role === 'user' ? (
              <div key={row.key} className="msg msg-user">
                <div className="msg-plain">{row.text}</div>
                {msgAttachments[row.key] !== undefined && msgAttachments[row.key].length > 0 ? (
                  <div className="attach-row" role="list" aria-label="Attached files">
                    {msgAttachments[row.key].map((meta) => (
                      <FileChip
                        key={meta.id}
                        meta={meta}
                        conversationId={conversationId}
                        onPreview={(m) => void openPreview(m)}
                      />
                    ))}
                  </div>
                ) : null}
              </div>
            ) : row.role === 'system' ? (
              <div key={row.key} className="msg msg-system">
                <PartnerMarkdown
                  text={row.text}
                  allowInlineCodePreview={false}
                  resolveNote={resolveNote}
                  onOpenNote={onOpenNote}
                />
              </div>
            ) : (
              <div key={row.key} className="msg msg-assistant">
                {row.text === '' && showPending ? (
                  '…'
                ) : (
                  <ChoiceMemoryContext.Provider value={{ conversationId }}>
                    <PartnerMarkdown
                      text={row.text}
                      busy={streaming}
                      onAnswer={handleAnswer}
                      groupLive={isGroupLive(rowIndex, rows.length)}
                      onPreviewCode={({ title, source }) => setPreview({ title, source })}
                      resolveNote={resolveNote}
                      onOpenNote={onOpenNote}
                      allowInlineCodePreview={false}
                    />
                  </ChoiceMemoryContext.Provider>
                )}
                {row.text !== '' ? (
                  <div className="msg-actions">
                    <button
                      type="button"
                      className="btn-link msg-action"
                      onClick={() => void copyText(row.key, row.text)}
                      disabled={streaming}
                    >
                      {copiedKey === row.key ? 'Copied ✓' : 'Copy'}
                    </button>
                    <button
                      type="button"
                      className="btn-link msg-action"
                      onClick={() => openSave(row.key, row.text)}
                      disabled={streaming || conversationId === null}
                    >
                      <IconSave />
                      Save to Assets
                    </button>
                  </div>
                ) : null}
              </div>
            ),
          )
        )}
      </div>

      {!atBottom && (streaming || unseen > 0) ? (
        <button
          type="button"
          className="btn btn-secondary btn-sm chat-jump"
          onClick={jumpToLatest}
          aria-label={unseen > 0 ? `Jump to latest — ${unseen} new message${unseen === 1 ? '' : 's'}` : 'Jump to latest'}
        >
          ↓ Latest{unseen > 0 ? ` (${unseen})` : ''}
        </button>
      ) : null}

      <div className="chat-status" aria-live="polite">
        {historyError && !streaming ? (
          <div className="chat-error" role="alert">
            <span className="chat-error-text">{historyError}</span>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => setReloadToken((n) => n + 1)}
            >
              Try again
            </button>
          </div>
        ) : turnError ? (
          <div className="chat-error" role="alert">
            <span className="chat-error-text">{turnError.message}</span>
            {turnError.canRepair ? (
              <button type="button" className="btn btn-secondary btn-sm" onClick={onUnpair}>
                {sessionLostAction()}
              </button>
            ) : null}
          </div>
        ) : metaText.length > 0 ? (
          <span className="chat-meta">{metaText}</span>
        ) : streaming ? (
          <span className="chat-meta">Working…</span>
        ) : null}
      </div>

      {showBrainstorm || brainstormError !== null || assetsFlash !== null ? (
        <div className="chat-assets-bar">
          {showBrainstorm ? (
            <span
              className={
                brainstormSession.concluded
                  ? 'chat-brainstorm is-concluded'
                  : 'chat-brainstorm'
              }
            >
              <span className="chat-brainstorm-state">
                Brainstorm {brainstormSession.concluded ? 'concluded' : 'active'}
              </span>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                disabled={brainstormBusy}
                aria-busy={brainstormBusy}
                onClick={() => void flipBrainstorm()}
              >
                {brainstormBusy
                  ? 'Saving…'
                  : brainstormSession.concluded
                    ? 'Reopen'
                    : 'Conclude'}
              </button>
            </span>
          ) : null}
          {brainstormError !== null ? (
            <span className="chat-brainstorm-error" role="alert">
              {brainstormError}
            </span>
          ) : null}
          {assetsFlash !== null ? (
            <span className="chat-assets-flash" role="status">
              {assetsFlash}
            </span>
          ) : null}
        </div>
      ) : null}

      {staged.length > 0 ? (
        <div className="attach-staged" role="list" aria-label="Files ready to send">
          {staged.map((meta) => (
            <FileChip
              key={meta.id}
              meta={meta}
              conversationId={conversationId}
              removable
              onRemove={(m) => void handleRemoveStaged(m.id)}
              onPreview={(m) => void openPreview(m)}
            />
          ))}
          <span className="attach-hint">sent with your next message</span>
        </div>
      ) : null}
      {attachError ? (
        <p className="chat-attach-error" role="alert">
          {attachError}
        </p>
      ) : null}

      {personaPaused && personaId ? (
        <div className="waiting-box paused-banner" role="alert">
          <span className="waiting-text">
            This persona is paused — resume it in Personas to continue.
          </span>
        </div>
      ) : null}

      {mention !== null ? (
        <div className="mention-pop" role="listbox" aria-label="Reference a file">
          {mention.loading ? (
            <p className="mention-note">Searching…</p>
          ) : mention.items.length === 0 ? (
            <p className="mention-note">
              No granted files match — grant a project root in Files, or attach a file instead.
            </p>
          ) : (
            mention.items.map((hit, index) => (
              <button
                key={`${hit.rootId}/${hit.path}`}
                type="button"
                role="option"
                aria-selected={index === mention.index}
                className={index === mention.index ? 'mention-item mention-item-active' : 'mention-item'}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => insertMention(hit)}
              >
                <span className="mention-path">{hit.path}</span>
                <span className="mention-root">{hit.rootLabel}</span>
              </button>
            ))
          )}
        </div>
      ) : null}

      {chatPending.length > 0 ? (
        <section
          className="card approval-in-chat"
          aria-label={
            chatPending.length === 1
              ? 'Approval needed for this chat'
              : `${chatPending.length} approvals needed for this chat`
          }
        >
          <div className="approval-in-chat-head">
            <h3 className="section-title approval-in-chat-title">Approval needed</h3>
            <span className="chip count-chip" aria-label={`${chatPending.length} pending`}>
              {chatPending.length}
            </span>
          </div>
          <ul className="queue-list approval-in-chat-list">
            {chatPending.map((row) => (
              <li key={row.id} className="queue-item">
                {row.kind === 'skill_install' ? (
                  /* M26 D2b: an install ask is not a tool call — it has a draft
                   * behind it, and an UPDATE shows the before→after table the
                   * owner has to acknowledge. */
                  <SkillInstallCard
                    row={row}
                    busy={approvalBusy}
                    deciding={decidingId === row.id}
                    error={queueErrors[row.id] ?? null}
                    onDecide={(decision, options) =>
                      void decideChatApproval(row, decision, options)
                    }
                  />
                ) : (
                  <InChatApprovalRow
                    row={row}
                    busy={approvalBusy}
                    deciding={decidingId === row.id}
                    error={queueErrors[row.id] ?? null}
                    onDecide={(decision) => void decideChatApproval(row, decision)}
                  />
                )}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {availableProviders.length > 0 && !personaPaused ? (
        <div className="chat-model-bar">
          <label className="chat-model-label">
            <span className="label chat-model-caption">Model for this message</span>
            <select
              id="chat-turn-model"
              className="field chat-model-select"
              value={turnModel === null ? 'auto' : `${turnModel.providerId}::${turnModel.model}`}
              onChange={(event) => {
                const value = event.target.value;
                if (value === 'auto') {
                  conversationUi.setModelPick(conversationId, null);
                  setTurnModel(null);
                  return;
                }
                const sep = value.indexOf('::');
                if (sep > 0) {
                  const pick = {
                    providerId: value.slice(0, sep),
                    model: value.slice(sep + 2),
                  };
                  conversationUi.setModelPick(conversationId, pick);
                  setTurnModel(pick);
                }
              }}
              disabled={streaming}
              aria-label="Model for this message — Auto uses the persona routing"
            >
              <option value="auto">Auto — persona routing</option>
              {availableProviders.map((provider) => (
                <optgroup key={provider.id} label={`${provider.name} · ${purposeLabel(provider.purpose)}`}>
                  {provider.defaultModels.map((model) => (
                    <option key={`${provider.id}:${model}`} value={`${provider.id}::${model}`}>
                      {model}
                      {isImageCapableModel(model, declaredVisionModels(provider))
                        ? ' · vision'
                        : ''}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </label>
          {stagedInlineImageNote !== null ? (
            <span className="chat-model-note" role="status">
              {stagedInlineImageNote}
            </span>
          ) : null}
        </div>
      ) : null}

      <form className="chat-form" onSubmit={handleSubmit}>
        <label
          className={`btn btn-secondary attach-button${
            conversationId === null || streaming || personaPaused ? ' attach-button-disabled' : ''
          }`}
          aria-disabled={!conversationId || streaming || personaPaused}
          aria-label="Attach a file to this chat"
          title={
            conversationId === null
              ? 'Start a chat before attaching files'
              : 'Attach a file (text, image, PDF, HTML/CSS)'
          }
        >
          <IconAttach />
          {/* M20.A: the visible label is dropped on a phone so the message
           *  field gets the width back (measured before: the text button took
           *  109px of a 326px row, leaving the field 49px). The control keeps
           *  its accessible name — the label's aria-label above and the file
           *  input's own aria-label below. */}
          <span className="btn-text">{attaching ? 'Adding…' : '＋ Attach'}</span>
          <input
            ref={fileInputRef}
            className="attach-input"
            type="file"
            multiple
            accept=".txt,.md,.csv,.json,.html,.css,image/png,image/jpeg,image/webp,image/gif,application/pdf,text/*,image/*,.heic,.heif"
            disabled={
              conversationId === null || streaming || personaPaused || attaching
            }
            aria-label="Attach files to this chat"
            onChange={(event) => void handleFiles(event.target.files)}
          />
        </label>
        <textarea
          id="partner-message"
          ref={composerRef}
          className="field chat-input"
          rows={2}
          value={draft}
          onChange={(event) => {
            const value = event.target.value;
            setDraft(value);
            updateMention(value, event.target.selectionStart ?? value.length);
          }}
          onKeyUp={() => {
            const el = composerRef.current;
            if (el !== null) updateMention(el.value, el.selectionStart ?? el.value.length);
          }}
          onKeyDown={handleKeyDown}
          placeholder={personaPaused ? 'Persona paused' : 'Message Partner…'}
          aria-label="Message to Partner"
          disabled={personaPaused}
        />
        <button
          type="submit"
          className="btn btn-primary chat-send"
          disabled={!canSend}
          aria-busy={streaming}
          aria-label={streaming ? 'Working — response in progress' : 'Send message'}
        >
          <IconSend />
          {/* M20.A: label hidden on a phone; progress is still visible in the
           *  transcript status line, so dropping the word loses no state. */}
          <span className="btn-text">{streaming ? 'Working…' : 'Send'}</span>
        </button>
      </form>
      {preview !== null ? (
        <CodePreview title={preview.title} source={preview.source} onClose={() => setPreview(null)} />
      ) : null}
      {saveTarget !== null && conversationId !== null ? (
        <SaveAssetsDialog
          token={readStoredToken() ?? ''}
          conversationId={conversationId}
          messageId={saveTarget.id}
          candidates={saveCandidates}
          onClose={() => setSaveTarget(null)}
          onSaved={() => {
            setAssetsFlash('Saved to Assets ✓');
            onAssetsChanged?.();
          }}
          onSessionLost={onUnpair}
        />
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------
// M12.6 in-chat approval row (active conversation's queue): one compact
// approve/deny row rendered on the chat screen itself — the persona asked
// from THIS conversation, so the decision happens where the ask happened.
// Approving runs the tool once (core) and then continues the turn; denying
// closes the row and continues so the persona answers without the tool.
// ---------------------------------------------------------------------------

function InChatApprovalRow({
  row,
  busy,
  deciding,
  error,
  onDecide,
}: {
  row: PendingToolCall;
  busy: boolean;
  deciding: boolean;
  error: string | null;
  onDecide: (decision: 'approve' | 'deny') => void;
}) {
  const { label, risk } = summarizeTool(row.toolId);
  const requester =
    row.personaName !== undefined && row.personaName !== null && row.personaName !== ''
      ? row.personaName
      : 'Persona';
  const paramsText = pendingLabel(row.toolId, row.params);
  return (
    <div className="queue-item-inner">
      <div className="queue-item-head">
        <div className="queue-item-title">
          <span className="queue-tool">{label}</span>
          <span className={`risk-text ${RISK_TONE_CLASS[risk]}`}>
            {RISK_LABELS[risk]} risk
          </span>
        </div>
        <div className="row-actions">
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={busy}
            onClick={() => onDecide('approve')}
            aria-busy={deciding}
            aria-label={`Approve ${label} — runs it once and the chat continues with the result`}
          >
            {deciding ? 'Working…' : 'Approve'}
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-sm btn-danger"
            disabled={busy}
            onClick={() => onDecide('deny')}
            aria-label={`Deny ${label} — the persona continues without it`}
          >
            Deny
          </button>
        </div>
      </div>
      <p className="queue-params">{paramsText}</p>
      <p className="queue-meta">{requester} · this chat</p>
      {error ? (
        <p className="row-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Attachment chips (M11 F1 + F12): name/size, an inline image thumbnail, a
// Preview action for HTML/CSS, and an optional remove control for staged
// uploads. Content bytes are fetched with the session token — never URLs.
// ---------------------------------------------------------------------------

function isImage(mime: string): boolean {
  return mime.startsWith('image/');
}

function isPreviewable(mime: string): boolean {
  return mime === 'text/html' || mime === 'text/css';
}

function AttachmentThumb({
  meta,
  conversationId,
}: {
  meta: AttachmentMeta;
  conversationId: string | null;
}) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (conversationId === null || meta.size > 3 * 1024 * 1024) return;
    const token = readStoredToken();
    if (!token) return;
    let objectUrl: string | null = null;
    let cancelled = false;
    void fetchAttachmentContent(token, conversationId, meta.id)
      .then(({ bytes }) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(new Blob([bytes as BlobPart], { type: meta.mime }));
        setUrl(objectUrl);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      if (objectUrl !== null) URL.revokeObjectURL(objectUrl);
    };
  }, [meta.id, meta.size, meta.mime, conversationId]);
  return url !== null ? (
    <img className="attach-thumb" src={url} alt={meta.name} />
  ) : null;
}

interface FileChipProps {
  meta: AttachmentMeta;
  conversationId: string | null;
  removable?: boolean;
  onRemove?: (meta: AttachmentMeta) => void;
  onPreview?: (meta: AttachmentMeta) => void;
}

function FileChip({ meta, conversationId, removable, onRemove, onPreview }: FileChipProps) {
  const previewable = isPreviewable(meta.mime);
  return (
    <span className="attach-chip" role="listitem">
      {isImage(meta.mime) ? (
        <AttachmentThumb meta={meta} conversationId={conversationId} />
      ) : null}
      <span className="attach-chip-name" title={meta.name}>
        {meta.name}
      </span>
      {/* One byte formatter across the product (shared/src/attachments.ts): a
        * chip's size and a cap's limit must not disagree about the same file,
        * and a chip never understates the bytes it stands for. */}
      <span className="attach-chip-meta">{describeBytes(meta.size, 'up')}</span>
      {previewable && onPreview ? (
        <button
          type="button"
          className="btn-link attach-chip-preview"
          onClick={() => onPreview(meta)}
        >
          Preview
        </button>
      ) : null}
      {removable && onRemove ? (
        <button
          type="button"
          className="btn-link attach-chip-remove"
          aria-label={`Remove ${meta.name}`}
          onClick={() => onRemove(meta)}
        >
          ×
        </button>
      ) : null}
    </span>
  );
}
