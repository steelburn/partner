/**
 * M32: chat sessions under Personas.
 *
 * The sidebar used to nest the whole conversation/folder rail under the Chat
 * destination (M30). That put the session list inside the Chat menu as a
 * bounded, internally scrolling box — a second scroll region inside the menu,
 * which read as cramped and hard to scan. The request was to see chats under
 * the persona they belong to, so this renders one disclosure per persona with
 * its own sessions, nested under the Personas destination.
 *
 * Design:
 *  - Persona rows are disclosures (chevron), collapsed by default; a session
 *    row opens the chat. Sessions are sorted most-recent first, exactly like
 *    the rail's list, via the shared helpers so the two cannot disagree.
 *  - A conversation whose persona is gone (deleted persona) or absent falls
 *    into an explicit "Unassigned" group rather than silently disappearing —
 *    the same reason the rail has an Inbox bucket.
 *  - The tree is bounded and scrolls internally, like the old chat tree: the
 *    twelve-item menu already fills a laptop-height sidebar, so an unbounded
 *    tree would either crush the menu or be crushed by it.
 */
import { useMemo, useState } from 'react';
import type { ConversationSummary, Persona } from '@partner/shared';
import { IconChevronDown } from './icons.js';
import { conversationTitle, sortConversations, timeAgo } from './lib/persona-helpers.js';

export interface PersonaChatTreeProps {
  /** Every persona (null while the shell loads them). */
  personas: Persona[] | null;
  /** Every conversation (null while the shell loads them). */
  conversations: ConversationSummary[] | null;
  /** Highlight the session the shell has open, if any. */
  activeConversationId: string | null;
  /** True while a turn streams: opening another chat mid-turn is refused. */
  disabled: boolean;
  /** Open a session in the Chat view. */
  onOpenConversation: (id: string) => void;
}

/** Group conversations by persona id, keeping personas with no chats. */
export function groupConversations(
  personas: readonly Persona[],
  conversations: readonly ConversationSummary[],
): { byPersona: Map<string, ConversationSummary[]>; unassigned: ConversationSummary[] } {
  const byPersona = new Map<string, ConversationSummary[]>();
  for (const persona of personas) byPersona.set(persona.id, []);
  const unassigned: ConversationSummary[] = [];
  for (const conversation of conversations) {
    const bucket = conversation.personaId === null ? undefined : byPersona.get(conversation.personaId);
    if (bucket === undefined) unassigned.push(conversation);
    else bucket.push(conversation);
  }
  for (const [id, list] of byPersona) byPersona.set(id, sortConversations(list));
  return { byPersona, unassigned: sortConversations(unassigned) };
}

export default function PersonaChatTree({
  personas,
  conversations,
  activeConversationId,
  disabled,
  onOpenConversation,
}: PersonaChatTreeProps) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());

  const list = useMemo(() => personas ?? [], [personas]);
  const { byPersona, unassigned } = useMemo(
    () => groupConversations(list, conversations ?? []),
    [list, conversations],
  );

  const toggle = (personaId: string): void => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(personaId)) next.delete(personaId);
      else next.add(personaId);
      return next;
    });
  };

  if (personas === null || conversations === null) {
    return (
      <p className="side-persona-loading" aria-busy="true">
        Loading chats…
      </p>
    );
  }

  const sessionList = (sessions: readonly ConversationSummary[], key: string): JSX.Element => (
    <ul className="side-persona-chats" id={key}>
      {sessions.map((conversation) => (
        <li key={conversation.id}>
          <button
            type="button"
            className={
              conversation.id === activeConversationId
                ? 'side-session is-active'
                : 'side-session'
            }
            onClick={() => onOpenConversation(conversation.id)}
            disabled={disabled}
            aria-current={conversation.id === activeConversationId ? 'true' : undefined}
            title={conversationTitle(conversation)}
          >
            <span className="side-session-title">{conversationTitle(conversation)}</span>
            <span className="side-session-meta">{timeAgo(conversation.updatedAt)}</span>
          </button>
        </li>
      ))}
      {sessions.length === 0 ? (
        <li className="side-persona-empty">No chats yet</li>
      ) : null}
    </ul>
  );

  return (
    <div className="side-persona-tree" id="side-persona-tree">
      {list.map((persona) => {
        const sessions = byPersona.get(persona.id) ?? [];
        const open = expanded.has(persona.id);
        const panelId = `side-persona-${persona.id}`;
        return (
          <div className="side-persona" key={persona.id}>
            <button
              type="button"
              className="side-persona-row"
              onClick={() => toggle(persona.id)}
              aria-expanded={open}
              aria-controls={open ? panelId : undefined}
              aria-label={`${open ? 'Collapse' : 'Expand'} chats with ${persona.name}`}
              title={`${open ? 'Collapse' : 'Expand'} chats with ${persona.name}`}
            >
              <span className="side-persona-caret" aria-hidden="true">
                <IconChevronDown />
              </span>
              <span className="side-persona-name">{persona.name}</span>
              <span className="side-persona-count">{sessions.length}</span>
            </button>
            {open ? sessionList(sessions, panelId) : null}
          </div>
        );
      })}
      {unassigned.length > 0 ? (
        <div className="side-persona">
          <button
            type="button"
            className="side-persona-row"
            onClick={() => toggle('__unassigned__')}
            aria-expanded={expanded.has('__unassigned__')}
            aria-controls={expanded.has('__unassigned__') ? 'side-persona-unassigned' : undefined}
            aria-label={`${expanded.has('__unassigned__') ? 'Collapse' : 'Expand'} unassigned chats`}
          >
            <span className="side-persona-caret" aria-hidden="true">
              <IconChevronDown />
            </span>
            <span className="side-persona-name">Unassigned</span>
            <span className="side-persona-count">{unassigned.length}</span>
          </button>
          {expanded.has('__unassigned__')
            ? sessionList(unassigned, 'side-persona-unassigned')
            : null}
        </div>
      ) : null}
    </div>
  );
}
