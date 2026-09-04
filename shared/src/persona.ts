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
}

export interface PersonaMemoryFlags {
  userProfile: 'read' | 'none';
  episodes: 'read+write' | 'none';
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
  isDefault?: boolean;
}

export interface ConversationSummary {
  id: string;
  personaId: string | null;
  title: string | null;
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
}
