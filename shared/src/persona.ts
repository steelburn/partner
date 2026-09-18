import type { PersonaSchedule } from './schedules.js';

/**
 * M3 persona + conversation wire contracts (PLAN-M3.md).
 *
 * A persona is the user's declarative partner identity: character, model
 * routing, independence level (user-configurable autonomy), pause state.
 * Conversations are persisted multi-turn chats bound to an optional persona.
 */

export type IndependenceLevel = 'assist' | 'suggest' | 'auto' | 'autonomous';

export type MemoryAccess = 'read' | 'read+write' | 'none';

export type TaskClass = 'chat' | 'deep' | 'coding' | 'vision' | 'cheap';

/** taskClass -> model id. 'chat' is the default for plain messages. */
export type TaskClassMap = Partial<Record<TaskClass, string>>;

export interface PersonaCharacter {
  voice: string;
  language: string;
  systemPrompt: string;
  temperature: number;
}

export interface PersonaModelRouting {
  /** Optional pinned provider; absent = first enabled provider. */
  providerId?: string;
  /** Optional fallback model if the primary task-class model is unusable. */
  fallback?: string;
  /** taskClass -> model id. */
  taskClasses: TaskClassMap;
}

export interface PersonaIndependence {
  /** assist = propose only (no tool execution); autonomous = self-directed
   *  within the configured envelope (enforced by later milestones). */
  level: IndependenceLevel;
  /** Risk tiers that always ask a human (defaults to ['high']). */
  requireHumanFor?: Array<'high' | 'medium'>;
  /** Tool scopes auto-allowed at level auto+ (stored now, enforced later). */
  autoScopes?: string[];
  /** M14 scheduled & autonomous work (PLAN-M14.md): the persona's schedule
   *  definitions. Runs fire only at independence auto/autonomous. */
  schedules?: PersonaSchedule[];
}

export interface PersonaMemoryFlags {
  /** Global user-profile facts (shared across personas) this persona may read.
   *  NOTE: reserved — confirmed global facts currently tailor every persona
   *  (M4); this grant is stored and validated but not yet enforced. */
  userProfile: 'read' | 'none';
  episodes: 'read+write' | 'none';
  /**
   * M19 persona-private memory + automatic remember consent for THIS persona.
   * 'on' = this persona notices durable facts tied to it after a persisted
   * turn and recalls them only in its own chats. Persona-scoped findings are
   * filed with `personaScopes: [<id>]` as suggestions; nothing is applied
   * until the user confirms it in the Memory view. Facts that apply everywhere are
   * governed separately by the user-level global auto-remember setting
   * (`/v1/memory/settings`, default on), not this flag. 'off'/absent = this
   * persona reads/writes no persona-scoped auto-detected facts (privacy
   * default).
   */
  personaMemory?: 'on' | 'off';
}

/**
 * M11 F3 persona capability policy (PLAN-M11.md). Skills a persona has by
 * default / may never use; tools it may never direct-execute. Bans beat the
 * independence envelope; explicit user (web) actions are not persona actions.
 */
export interface PersonaPolicy {
  /** Default skills load into new conversations; banned skills refuse invoke. */
  skills?: { default?: string[]; banned?: string[] };
  /** Banned tools are refused at the gate; allowed = strict allowlist when set. */
  tools?: { allowed?: string[]; banned?: string[] };
}

export interface Persona {
  id: string;
  name: string;
  tagline?: string;
  avatar?: string;
  colorTheme?: string;
  character: PersonaCharacter;
  model: PersonaModelRouting;
  independence: PersonaIndependence;
  memory: PersonaMemoryFlags;
  /** M11 F3 capability policy (skills/tools defaults + bans). */
  policy?: PersonaPolicy;
  /** D10 home folder — new chats for this persona auto-land here. */
  homeFolderId?: string;
  isDefault: boolean;
  paused: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface PersonaInput {
  name: string;
  tagline?: string;
  avatar?: string;
  colorTheme?: string;
  character: PersonaCharacter;
  model: PersonaModelRouting;
  independence: PersonaIndependence;
  memory: PersonaMemoryFlags;
  /** M11 F3 capability policy (skills/tools defaults + bans). */
  policy?: PersonaPolicy;
  /** D10 home folder — new chats for this persona auto-land here. */
  homeFolderId?: string;
  isDefault?: boolean;
}

export interface ConversationSummary {
  id: string;
  personaId: string | null;
  title: string | null;
  /** M11 F11 folder (Projects/Folders) this chat lives in; null = Inbox. */
  folderId: string | null;
  /** M16 F4 discuss lineage: parent discussion this conversation branched from. */
  parentId?: string | null;
  /** M16 F4 discuss lineage: the asset that sparked this forked discussion. */
  sourceAssetId?: string | null;
  messageCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface ConversationMessage {
  id: string;
  conversationId: string;
  role: 'system' | 'user' | 'assistant';
  personaId: string | null;
  content: string;
  model: string | null;
  latencyMs: number | null;
  createdAt: number;
}

export interface CreateConversationInput {
  personaId?: string;
  title?: string;
  /** M11 F11: folder to create the chat in (null/absent = Inbox). */
  folderId?: string;
  /** M16 F4 discuss lineage: parent discussion (thread) this branches from. */
  parentId?: string;
  /** M16 F4 discuss lineage: originating asset id (fork provenance). */
  sourceAssetId?: string;
}
