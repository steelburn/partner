/**
 * Conversation manager (M3, PLAN-M3.md §"Core API additions").
 *
 * Persisted multi-turn chat: a conversation is bound to an OPTIONAL persona
 * (personaId is denormalized on the row AND on every message, so deleting a
 * persona never orphans or blocks conversations). The manager owns persona
 * binding validation, message ordering (ASC), updated_at bumps on append,
 * the per-conversation message COUNT, and the remove cascade (messages are
 * deleted with their conversation).
 *
 * Persistence failures are the ROUTE's problem to swallow (a broken append
 * must never break a streaming chat response); here they throw typed errors.
 *
 * Audit: rows are written inside this manager so content can never leak into
 * audit — details carry ids, roles, lengths and the model, never content.
 * Actor is 'web' (the only v1 client; the pairing/session layer stamps the
 * session id on its own chat.stream row).
 */
import { randomUUID } from 'node:crypto';
import type {
  ConversationMessage,
  ConversationSummary,
  CreateConversationInput,
} from '@partner/shared';
import type { AuditService } from '../services/redaction.js';
import type {
  ConversationRow,
  ConversationStore,
  MessageRow,
  MessageStore,
  PersonaStore,
} from '../stores/types.js';
import { ConversationError, conversationError } from './errors.js';

const MESSAGE_ROLES: ReadonlySet<string> = new Set(['system', 'user', 'assistant']);

export type AppendRole = 'system' | 'user' | 'assistant';

export interface ConversationAppendInput {
  content: string;
  /** Denormalized persona id at append time (null = no persona). */
  personaId?: string | null;
  model?: string | null;
  latencyMs?: number | null;
}

export interface ConversationManagerOptions {
  /**
   * Persona row store used to validate a personaId given at create time.
   * Optional so harnesses that never touch personas still compile; when
   * absent, persona binding is not validated.
   */
  personaStore?: PersonaStore;
  stores: { conversations: ConversationStore; messages: MessageStore };
  audit: AuditService;
  /** Injectable clock (epoch ms). */
  now?: () => number;
}

export interface ConversationDetail {
  summary: ConversationSummary;
  /** Messages ascending (transcript order). */
  messages: ConversationMessage[];
}

export interface ConversationManager {
  /** Create a conversation; personaId (when given) must exist. */
  create(input: CreateConversationInput): ConversationSummary;
  /** Append one turn; bumps the conversation's updated_at. Returns the row. */
  append(
    conversationId: string,
    role: AppendRole,
    input: ConversationAppendInput,
  ): ConversationMessage;
  /** All conversations, most recently active first, each with messageCount. */
  list(): ConversationSummary[];
  /** {summary, messages} — unknown conversation throws not_found. */
  get(id: string): ConversationDetail;
  /** Re-point a conversation at a persona (bumps updated_at). Unknown -> not_found. */
  bindPersona(conversationId: string, personaId: string): void;
  /**
   * M11 F11: rename and/or move a conversation between folders. folderId is
   * stored as-is (null = Inbox); existence is the caller's job (routes
   * validate against the folder manager). Unknown -> not_found.
   */
  update(
    id: string,
    patch: { title?: string; folderId?: string | null },
  ): ConversationSummary;
  /** Delete a conversation AND its messages. Unknown -> not_found. */
  remove(id: string): void;
}

function toSummary(row: ConversationRow, messageCount: number): ConversationSummary {
  return {
    id: row.id,
    personaId: row.personaId,
    title: row.title,
    folderId: row.folderId,
    // M16 F4 lineage (null when absent — older rows read cleanly).
    parentId: row.parentId ?? null,
    sourceAssetId: row.sourceAssetId ?? null,
    messageCount,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toMessage(row: MessageRow): ConversationMessage {
  return {
    id: row.id,
    conversationId: row.conversationId,
    role: row.role as ConversationMessage['role'],
    personaId: row.personaId,
    content: row.content,
    model: row.model,
    latencyMs: row.latencyMs,
    createdAt: row.createdAt,
  };
}

export function createConversationManager(
  options: ConversationManagerOptions,
): ConversationManager {
  const { stores, audit } = options;
  const personaStore = options.personaStore;
  const now = options.now ?? Date.now;

  function countsMap(): Map<string, number> {
    const map = new Map<string, number>();
    for (const { conversationId, count } of stores.messages.countsByConversation()) {
      map.set(conversationId, count);
    }
    return map;
  }

  function create(input: CreateConversationInput): ConversationSummary {
    const body = (input ?? {}) as CreateConversationInput;
    let personaId: string | null = null;
    if (body.personaId !== undefined && body.personaId !== null) {
      if (typeof body.personaId !== 'string' || body.personaId.trim() === '') {
        throw conversationError('invalid_input', 'personaId must be a non-empty string');
      }
      // Creating a conversation under a PAUSED persona is fine (creating is
      // allowed); a persona that does not exist is not.
      if (personaStore && !personaStore.findById(body.personaId)) {
        throw conversationError('not_found', 'persona not found');
      }
      personaId = body.personaId;
    }
    const title =
      body.title !== undefined && body.title !== null && body.title !== ''
        ? String(body.title).slice(0, 120)
        : null;
    const folderId =
      body.folderId !== undefined && body.folderId !== null && body.folderId !== ''
        ? body.folderId
        : null;
    // M16 F4 lineage: parent discussion + source asset (fork provenance).
    const parentId =
      body.parentId !== undefined && body.parentId !== null && body.parentId !== ''
        ? body.parentId
        : null;
    const sourceAssetId =
      body.sourceAssetId !== undefined && body.sourceAssetId !== null && body.sourceAssetId !== ''
        ? body.sourceAssetId
        : null;
    const at = now();
    const id = randomUUID();
    const row: ConversationRow = {
      id,
      personaId,
      title,
      folderId,
      parentId,
      sourceAssetId,
      createdAt: at,
      updatedAt: at,
    };
    stores.conversations.insert(row);
    audit.log('web', 'conversation.create', id, {
      personaId,
      titleLength: title === null ? 0 : title.length,
    });
    return toSummary(row, 0);
  }

  function append(
    conversationId: string,
    role: AppendRole,
    input: ConversationAppendInput,
  ): ConversationMessage {
    const row = stores.conversations.findById(conversationId);
    if (!row) throw conversationError('not_found', 'conversation not found');
    if (!MESSAGE_ROLES.has(role)) {
      throw conversationError(
        'invalid_input',
        `role must be one of system|user|assistant (got ${String(role)})`,
      );
    }
    const body = (input ?? {}) as ConversationAppendInput;
    if (typeof body.content !== 'string') {
      throw conversationError('invalid_input', 'content must be a string');
    }
    // personaId inherits the CONVERSATION's persona when the caller does not
    // say; an explicit null stores a persona-less message inside a bound
    // conversation (e.g. the bound persona was deleted).
    const personaId = body.personaId === undefined ? row.personaId : body.personaId;
    const model = body.model === undefined || body.model === null ? null : body.model;
    const latencyMs =
      body.latencyMs === undefined || body.latencyMs === null ? null : body.latencyMs;
    const at = now();
    const id = randomUUID();
    const message: MessageRow = {
      id,
      conversationId,
      role,
      personaId,
      contentType: 'text',
      content: body.content,
      model,
      latencyMs,
      createdAt: at,
    };
    stores.messages.insert(message);
    stores.conversations.update(conversationId, { updatedAt: at });
    audit.log('web', 'message.append', id, {
      conversationId,
      role,
      personaId,
      contentLength: body.content.length,
      model,
    });
    return toMessage(message);
  }

  function list(): ConversationSummary[] {
    const counts = countsMap();
    return stores.conversations.list().map((row) => {
      return toSummary(row, counts.get(row.id) ?? 0);
    });
  }

  function get(id: string): ConversationDetail {
    const row = stores.conversations.findById(id);
    if (!row) throw conversationError('not_found', 'conversation not found');
    const messages = stores.messages.listByConversation(id).map(toMessage);
    return { summary: toSummary(row, messages.length), messages };
  }

  function remove(id: string): void {
    if (!stores.conversations.findById(id)) {
      throw conversationError('not_found', 'conversation not found');
    }
    stores.messages.removeByConversation(id);
    stores.conversations.remove(id);
    audit.log('web', 'conversation.delete', id, {});
  }

  function bindPersona(conversationId: string, personaId: string): void {
    const row = stores.conversations.findById(conversationId);
    if (!row) throw conversationError('not_found', 'conversation not found');
    if (typeof personaId !== 'string' || personaId.trim() === '') {
      throw conversationError('invalid_input', 'personaId must be a non-empty string');
    }
    if (personaStore && !personaStore.findById(personaId)) {
      throw conversationError('not_found', 'persona not found');
    }
    if (row.personaId === personaId) return;
    stores.conversations.update(conversationId, { personaId, updatedAt: now() });
  }

  /** M11 F11 rename/move. folderId existence is the route's responsibility. */
  function update(
    id: string,
    patch: { title?: string; folderId?: string | null },
  ): ConversationSummary {
    const row = stores.conversations.findById(id);
    if (!row) throw conversationError('not_found', 'conversation not found');
    const body = (patch ?? {}) as { title?: string; folderId?: string | null };
    const storePatch: { title?: string | null; folderId?: string | null } = {};
    if (body.title !== undefined) {
      storePatch.title =
        body.title !== null && body.title !== '' ? String(body.title).slice(0, 120) : null;
    }
    if (body.folderId !== undefined) {
      storePatch.folderId =
        body.folderId === null || body.folderId === '' ? null : body.folderId;
    }
    if (Object.keys(storePatch).length === 0) {
      return toSummary(row, stores.messages.countByConversation(id));
    }
    stores.conversations.update(id, { ...storePatch, updatedAt: now() });
    audit.log('web', 'conversation.update', id, {
      titleChanged: storePatch.title !== undefined,
      folderId: storePatch.folderId === undefined ? undefined : (storePatch.folderId ?? null),
    });
    const updated = stores.conversations.findById(id) as ConversationRow;
    return toSummary(updated, stores.messages.countByConversation(id));
  }

  return { create, append, list, get, bindPersona, update, remove };
}
