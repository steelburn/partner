/**
 * DOM-free logic for the M3 Persona/Conversation screens.
 *
 * Kept out of the components so every label/decision rule is unit-testable
 * in the node vitest env (no jsdom). Rendering is presentational only.
 * Secrets discipline: persona system prompts and message content never pass
 * through helpers that format, log or echo them — these functions only map
 * names/levels/dates, never prompt or message bodies.
 */

import type {
  ConversationSummary,
  IndependenceLevel,
  Persona,
  TaskClass,
} from '@partner/shared';
import type { ToolRisk } from '@partner/shared/src/tools.js';

// ---------------------------------------------------------------------------
// Independence levels (PLAN §5.1)
// ---------------------------------------------------------------------------

/** Display order for the independence levels (least → most autonomous). */
export const LEVEL_ORDER: readonly IndependenceLevel[] = [
  'assist',
  'suggest',
  'auto',
  'autonomous',
];

export const LEVEL_LABELS: Record<IndependenceLevel, string> = {
  assist: 'Assist',
  suggest: 'Suggest',
  auto: 'Auto',
  autonomous: 'Autonomous',
};

/** Short chip/label text for an independence level. */
export function levelLabel(level: IndependenceLevel): string {
  return LEVEL_LABELS[level];
}

const LEVEL_EXPLAINERS: Record<IndependenceLevel, string> = {
  assist: 'Answers and proposes only — never runs a tool without you asking.',
  suggest: 'Runs low-risk tools under grants; proposes medium and high risk and waits for you.',
  auto: 'Runs within its allowed scopes up to medium risk; high-risk actions still ask you.',
  autonomous:
    'Self-directed inside its configured envelope — always logged, always within budget, instant pause.',
};

/** One-line human explanation of what a level may do (PLAN §5.1). */
export function levelExplain(level: IndependenceLevel): string {
  return LEVEL_EXPLAINERS[level];
}

// ---------------------------------------------------------------------------
// Risk tiers (PLAN §4.3 / §5.1)
// ---------------------------------------------------------------------------

const RISK_LABELS: Record<ToolRisk, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
};

/** Short label for a tool-risk tier. */
export function riskLabel(risk: ToolRisk): string {
  return RISK_LABELS[risk];
}

// ---------------------------------------------------------------------------
// Task classes
// ---------------------------------------------------------------------------

export interface TaskClassOption {
  value: TaskClass;
  /** Human label shown next to the model-override input. */
  label: string;
  /** One-line purpose, for the aria-label/title on the input. */
  hint: string;
}

/** Ordered, labelled task classes for the persona model-routing form. */
export const TASK_CLASS_OPTIONS: readonly TaskClassOption[] = [
  { value: 'chat', label: 'Chat', hint: 'Everyday conversation' },
  { value: 'deep', label: 'Deep', hint: 'Careful reasoning and analysis' },
  { value: 'coding', label: 'Coding', hint: 'Code generation and editing' },
  { value: 'vision', label: 'Vision', hint: 'Image understanding' },
  { value: 'cheap', label: 'Cheap', hint: 'Fast, low-cost turns' },
];

// ---------------------------------------------------------------------------
// Persona display
// ---------------------------------------------------------------------------

/**
 * Up-to-two-letter avatar initials from a persona name ("Maya Chen" -> "MC",
 * "Maya" -> "M"). Falls back to a neutral glyph for empty/garbled names.
 */
export function personaInitials(name: string): string {
  const words = name
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0);
  if (words.length === 0) return '?';
  const letters = words
    .slice(0, 2)
    .map((word) => {
      const letter = Array.from(word)[0];
      return letter === undefined ? '' : letter.toUpperCase();
    })
    .join('');
  return letters.length > 0 ? letters : '?';
}

/** "Maya" and "maya-chen" both read as their initial; used by a11y labels. */
export function personaAriaLabel(persona: Persona): string {
  return `${persona.name}${persona.isDefault ? ' (default)' : ''}${persona.paused ? ' (paused)' : ''}`;
}

// ---------------------------------------------------------------------------
// Conversation display helpers
// ---------------------------------------------------------------------------

/** First line of a message, trimmed; a title candidate for new chats. */
export function defaultTitleFromMessage(content: string): string {
  const firstLine = content.split(/\r?\n/, 1)[0]?.trim() ?? '';
  if (firstLine.length <= 60) return firstLine;
  return `${firstLine.slice(0, 60)}…`;
}

/** A list-row title that always has text (falls back for untitled chats). */
export function conversationTitle(summary: ConversationSummary): string {
  if (summary.title !== null && summary.title.trim().length > 0) return summary.title;
  return 'New chat';
}

/**
 * Sort conversation summaries most-recent first by updatedAt; equal
 * timestamps fall back to createdAt (also descending) for determinism.
 */
export function sortConversations(list: readonly ConversationSummary[]): ConversationSummary[] {
  return [...list].sort(
    (a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt || a.id.localeCompare(b.id),
  );
}

/**
 * Compact relative time for list rows ("now", "5m ago", "3h ago", "2d ago",
 * then a short date). `now` is injectable for deterministic tests.
 */
export function timeAgo(ms: number, now: number = Date.now()): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  const seconds = Math.max(0, Math.floor((now - ms) / 1000));
  if (seconds < 60) return 'now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  const date = new Date(ms);
  return `${date.getMonth() + 1}/${date.getDate()}/${String(date.getFullYear()).slice(2)}`;
}
