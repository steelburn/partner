/**
 * Episode manager (M4, PLAN-M4.md §"episode manager").
 *
 * One summary per conversation (conversation_id UNIQUE — resummarizing
 * UPDATES the existing episode in place). Summaries are produced on demand
 * (POST route / "chat closes" later): in demo mode — or when no provider can
 * be resolved for the conversation's persona — a deterministic placeholder is
 * written; otherwise a single fixed 'summarize' prompt over the last ~30
 * messages goes to the persona's resolved chat provider and the first delta
 * becomes the summary.
 *
 * Security notes: the summarize prompt text is FIXED and never user-derived
 * (user content only ever sits in the message payload). The transcript
 * content and the produced summary are user data — they appear in responses
 * to the OWNER (episode rows, GET /v1/memory/search snippets) but NEVER in
 * audit rows/logs/errors (ids, counts and lengths only).
 */
import { randomUUID } from 'node:crypto';
import type {
  ChatEvent,
  ConversationMessage,
  EpisodeSummary,
  ProviderClient,
} from '@partner/shared';
import type { AuditService } from '../services/redaction.js';
import type { ConversationManager } from '../conversations/manager.js';
import type { EpisodeRow, EpisodeStore, MemoryFtsStore } from '../stores/types.js';
import { ConversationError } from '../conversations/errors.js';
import { memoryError } from './errors.js';

/** How many of the newest transcript messages feed the summary. */
export const EPISODE_SUMMARIZE_WINDOW = 30;
/** Title fallback cap (mirrors the chat route's conversation title). */
export const EPISODE_TITLE_CAP = 60;
/** First-user-message preview inside the demo placeholder. */
export const DEMO_PREVIEW_CAP = 40;

/**
 * Fixed summarizer instruction — NEVER user-derived (PLAN-M4: "the prompt
 * text is fixed and never user-derived"). User content only appears as
 * transcript message payloads AFTER this instruction.
 */
export const SUMMARIZE_SYSTEM_PROMPT =
  'You are summarizing a conversation between the user and their AI partner. ' +
  'Write a concise factual summary (up to 4 sentences) of what was discussed, ' +
  'what was decided, and any open follow-ups. Third person, no greeting, no preamble.';

/**
 * The chat client a persona's summary should ride, plus the concrete model id
 * (resolver-level routing through the persona happens at wiring time).
 */
export interface SummarizeTarget {
  client: ProviderClient;
  model: string;
}

export interface EpisodeManagerOptions {
  stores: { episodes: EpisodeStore; fts: MemoryFtsStore };
  /** Transcript source: fetch + list messages per conversation. */
  conversations: ConversationManager;
  /**
   * Resolves the chat client (and model) for a conversation's persona, or
   * null when nothing usable is configured (no persona, no enabled provider,
   * key missing). NOT called in demo mode (placeholder summary).
   */
  providerResolver: (personaId: string | null) => SummarizeTarget | null | Promise<SummarizeTarget | null>;
  /** Demo mode writes the deterministic placeholder summary. */
  demo: boolean;
  audit: AuditService;
  /** Injectable clock (epoch ms). */
  now?: () => number;
}

export interface EpisodeManager {
  /** All episodes in creation order. */
  list(): EpisodeSummary[];
  get(id: string): EpisodeSummary | null;
  /**
   * Summarize a conversation NOW. Unknown conversation -> not_found. An
   * existing episode for the conversation is updated in place (no
   * duplicates). Returns the stored episode plus whether it was created.
   */
  summarize(conversationId: string): Promise<{ episode: EpisodeSummary; created: boolean }>;
  /** Delete one episode (un-indexes it). Unknown id -> not_found. */
  remove(id: string): void;
}

function toEpisode(row: EpisodeRow): EpisodeSummary {
  return {
    id: row.id,
    conversationId: row.conversationId,
    personaId: row.personaId,
    title: row.title,
    summary: row.summary,
    model: row.model,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Demo/placeholder summary text (PLAN-M4 verbatim shape). */
export function demoEpisodeSummary(messages: ConversationMessage[]): string {
  const firstUser = messages.find((m) => m.role === 'user');
  const preview = firstUser ? firstUser.content.slice(0, DEMO_PREVIEW_CAP) : '';
  return `Demo summary of ${messages.length} messages: ${preview}`;
}

/** Episode searchable text = title + summary (PLAN-M4 "searchable text"). */
export function episodeSearchText(episode: { title: string; summary: string }): string {
  return episode.title !== '' ? `${episode.title} ${episode.summary}` : episode.summary;
}

/** First delta event text (the whole provider reply is usually one delta). */
function firstDeltaText(events: AsyncIterable<ChatEvent>): Promise<string | null> {
  return (async () => {
    for await (const event of events) {
      if (event.type === 'delta') return event.text;
      if (event.type === 'error') {
        throw memoryError('upstream', 'summary provider stream failed');
      }
    }
    return null;
  })();
}

export function createEpisodeManager(options: EpisodeManagerOptions): EpisodeManager {
  const { stores, conversations, audit } = options;
  const providerResolver = options.providerResolver;
  const demo = options.demo;
  const now = options.now ?? Date.now;

  async function summarize(conversationId: string): Promise<{ episode: EpisodeSummary; created: boolean }> {
    if (typeof conversationId !== 'string' || conversationId.trim() === '') {
      throw memoryError('invalid_input', 'conversationId must be a non-empty string');
    }
    let detail;
    try {
      detail = conversations.get(conversationId);
    } catch (err) {
      if (err instanceof ConversationError && err.code === 'not_found') {
        throw memoryError('not_found', 'conversation not found');
      }
      throw err;
    }
    const { summary: conversation, messages } = detail;
    const personaId = conversation.personaId;

    // Title: the first user message (truncated), else the conversation title.
    const firstUser = messages.find((m) => m.role === 'user');
    const title =
      firstUser !== undefined
        ? firstUser.content.slice(0, EPISODE_TITLE_CAP)
        : conversation.title !== null && conversation.title !== ''
          ? conversation.title.slice(0, EPISODE_TITLE_CAP)
          : 'Conversation';

    let summaryText: string;
    let model: string | null = null;
    if (demo || messages.length === 0) {
      // Deterministic placeholder: demo mode ALWAYS (PLAN-M4) and any
      // conversation with nothing to summarize.
      summaryText =
        messages.length === 0 ? 'No messages to summarize yet.' : demoEpisodeSummary(messages);
    } else {
      const target = await providerResolver(personaId);
      if (target === null) {
        summaryText = demoEpisodeSummary(messages);
      } else {
        model = target.model;
        // Windowed transcript (content only), newest ~30 messages ASC, behind
        // the fixed instruction — user content never shapes the prompt.
        const window = messages.slice(-EPISODE_SUMMARIZE_WINDOW).map((m) => ({
          role: m.role as 'system' | 'user' | 'assistant',
          content: m.content,
        }));
        const requestMessages = [
          { role: 'system' as const, content: SUMMARIZE_SYSTEM_PROMPT },
          ...window,
        ];
        const got = await firstDeltaText(
          target.client.chatStream({ model: target.model, messages: requestMessages }),
        );
        if (got === null || got.trim() === '') {
          throw memoryError('upstream', 'summary provider returned no text');
        }
        summaryText = got.trim();
      }
    }

    const at = now();
    const existing = stores.episodes.findByConversationId(conversationId);
    if (existing) {
      stores.episodes.update(existing.id, {
        personaId,
        title,
        summary: summaryText,
        model,
        updatedAt: at,
      });
      const updated = stores.episodes.findById(existing.id);
      if (!updated) throw memoryError('not_found', 'episode not found');
      stores.fts.upsertEpisode(updated.id, episodeSearchText(updated));
      audit.log('web', 'episode.summarize', updated.id, {
        conversationId,
        personaId,
        messageCount: messages.length,
        summaryLength: updated.summary.length,
        model,
        created: false,
      });
      return { episode: toEpisode(updated), created: false };
    }

    const id = randomUUID();
    const row: EpisodeRow = {
      id,
      conversationId,
      personaId,
      title,
      summary: summaryText,
      model,
      createdAt: at,
      updatedAt: at,
    };
    stores.episodes.insert(row);
    stores.fts.upsertEpisode(id, episodeSearchText(row));
    audit.log('web', 'episode.summarize', id, {
      conversationId,
      personaId,
      messageCount: messages.length,
      summaryLength: row.summary.length,
      model,
      created: true,
    });
    return { episode: toEpisode(row), created: true };
  }

  function list(): EpisodeSummary[] {
    return stores.episodes.list().map(toEpisode);
  }

  function get(id: string): EpisodeSummary | null {
    const row = stores.episodes.findById(id);
    return row ? toEpisode(row) : null;
  }

  function remove(id: string): void {
    const row = stores.episodes.findById(id);
    if (!row) throw memoryError('not_found', 'episode not found');
    stores.episodes.remove(id);
    stores.fts.deleteRef('episode', id);
    audit.log('web', 'episode.delete', id, {
      conversationId: row.conversationId,
      summaryLength: row.summary.length,
    });
  }

  return { list, get, summarize, remove };
}
